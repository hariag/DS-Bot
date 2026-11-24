#!/usr/bin/env node
// End-to-end group-goal lifecycle through the real DSH group sessions and tools.
//
//   node test/e2e/group-goal.e2e.mjs --fresh
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { boardApi, loginToken, REPO, startBench, stopBench } from './bench.mjs'

const HOME = process.env.GROUP_GOAL_E2E_HOME || join(REPO, '.dsh-test-group-goal-e2e')
const WEB_PORT = Number(process.env.GROUP_GOAL_E2E_WEB_PORT || 3099)
const MOCK_PORT = Number(process.env.GROUP_GOAL_E2E_MOCK_PORT || 8799)
const FRESH = process.argv.includes('--fresh')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function fail(message, evidence) { throw Object.assign(new Error(message), { evidence }) }
function rooms(state) { return Object.values(state.rooms ?? {}) }
function activeGoal(state, roomId) {
  const goal = rooms(state).find(room => room.id === roomId)?.goal
  if (goal?.status === 'active' && goal.idle === true) fail('an unfinished goal entered idle', { goal })
  return goal
}
async function waitFor(label, read, timeout = 60_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = await read()
    if (value) return value
    await sleep(200)
  }
  throw new Error('timed out waiting for ' + label)
}

async function main() {
  if (FRESH) {
    const stopped = await stopBench({ home:HOME, webPort:WEB_PORT, mockPort:MOCK_PORT })
    if (!stopped.webPortFree || !stopped.mockPortFree) fail('E2E bench ports are still occupied', stopped)
    rmSync(HOME, { recursive:true, force:true })
  }
  process.env.MOCK_GROUP_GOAL_AUTORUN = '1'
  process.env.MOCK_LOG_TOOLS = '1'
  process.env.MOCK_DELAY_MS = process.env.MOCK_DELAY_MS ?? '400'
  const bench = await startBench({ home:HOME, webPort:WEB_PORT, mockPort:MOCK_PORT })
  let cookie
  let benchStopped = false
  const api = (endpoint, payload = {}) => boardApi(bench.base, cookie, endpoint, payload)
  try {
    cookie = (await loginToken(bench.loginUrl)).cookie
    await waitFor('DSH state API', () => api('state'))

    const bot = async (name, role, instructions) => {
      await api('create-bot', { name, role, instructions })
      const state = await api('state')
      const found = Object.values(state.bots).find(item => item.name === name)
      if (!found) fail('Bot was not created: ' + name)
      return found
    }
    const admin = await bot('Goal E2E Admin', 'Project Manager', 'Coordinate group tasks, check evidence, and complete the goal.')
    const writer = await bot('Goal E2E Writer', 'Backend Developer', 'Prepare the assigned draft and report verifiable evidence.')
    const tester = await bot('Goal E2E Tester', 'Test Engineer', 'Verify the assigned draft and report the check evidence.')
    await waitFor('Bot setup turns to finish', async () => {
      const state = await api('state')
      return Object.keys(state.activity ?? {}).length === 0 ? state : undefined
    })
    const room = await api('create-room', {
      name:'Group Goal Lifecycle E2E', members:[admin.id, writer.id, tester.id], admin:admin.id, greet:false,
    })
    await waitFor('created group', async () => rooms(await api('state')).find(item => item.id === room.id))

    const start = {
      action:'start',
      title:'Two-stage group-goal lifecycle',
      objective:'Prepare a draft, independently verify it, and complete the group goal.',
      acceptance:'Both stages pass with member evidence and the administrator records a completion summary.',
      stages:[
        { title:'Draft', acceptance:'The writer provides the draft and evidence.', tasks:[{ bot:writer.name, task:'Prepare the lifecycle draft and report its evidence.' }] },
        { title:'Independent check', acceptance:'The tester verifies the draft and reports evidence.', tasks:[{ bot:tester.name, task:'Independently verify the lifecycle draft and report the result.' }] },
      ],
    }
    await api('send', { sessionId:room.id, text:'调用 group_goal ' + JSON.stringify(start) })

    const trace = []
    const observe = state => {
      const goal = activeGoal(state, room.id)
      if (goal) trace.push({ status:goal.status, idle:goal.idle === true, revision:goal.revision,
        current:goal.current, tasks:goal.stages?.map(stage => stage.tasks?.map(task => task.status)) })
      return goal
    }
    const waitTask = async (stage, status) => waitFor(`stage ${stage + 1} task ${status}`, async () => {
      const state = await api('state')
      const goal = observe(state)
      const task = goal?.stages?.[stage]?.tasks?.[0]
      return task?.status === status ? { goal, task } : undefined
    })

    let { goal, task } = await waitTask(0, 'working')
    console.log(`stage 1 assigned: ${task.botId} status=${task.status}; goal=${goal.status}, idle=${goal.idle ?? false}`)
    ;({ goal, task } = await waitTask(0, 'reported'))
    if (task.statusSource !== 'automatic') fail('stage 1 member report was not recorded automatically', { task })
    console.log(`stage 1 reported: source=${task.statusSource}`)

    await waitFor('stage 1 pass and stage 2 assignment', async () => {
      const state = await api('state')
      const current = observe(state)
      if (current?.stages?.[0]?.status === 'passed' && current.current === 1) return current
      return undefined
    })
    ;({ goal, task } = await waitTask(1, 'working'))
    console.log(`stage 2 assigned: ${task.botId} status=${task.status}; goal=${goal.status}, idle=${goal.idle ?? false}`)
    ;({ goal, task } = await waitTask(1, 'reported'))
    if (task.statusSource !== 'automatic') fail('stage 2 member report was not recorded automatically', { task })
    console.log(`stage 2 reported: source=${task.statusSource}`)

    const completed = await waitFor('administrator completion', async () => {
      const state = await api('state')
      const current = observe(state)
      return current?.status === 'complete' ? current : undefined
    })
    if (completed.stages.length !== 2 || completed.stages.some(stage => stage.status !== 'passed'
      || stage.tasks.some(item => item.status !== 'done'))) {
      fail('the full group-goal evidence chain was not completed', { goal:completed })
    }
    if (!completed.summary || !completed.events.some(event => event.kind === 'complete')) fail('completion summary or event is missing', { goal:completed })

    const mockLog = readFileSync(join(HOME, 'mock.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    const fixtureErrors = mockLog.filter(entry => entry.out?.some(block => block.type === 'text' && /Group-goal fixture (?:could not|found)/.test(block.text)))
    if (fixtureErrors.length) fail('the group-goal mock reported a fixture error', { fixtureErrors })

    // The live board state deliberately omits the room transcript. Stop the
    // isolated host, then verify dispatch and owner replies in its saved audit log.
    const stopped = await stopBench({ home:HOME, webPort:WEB_PORT, mockPort:MOCK_PORT })
    benchStopped = stopped.webPortFree && stopped.mockPortFree
    if (!benchStopped) fail('E2E bench ports are still occupied after completion', stopped)
    const saved = JSON.parse(readFileSync(join(HOME, 'bot', 'state.json'), 'utf8'))
    const group = rooms(saved).find(item => item.id === room.id)
    if (!group || !group.log?.some(line => line.text?.includes('@' + writer.name))
      || !group.log?.some(line => line.text?.includes('@' + tester.name))
      || !group.log?.some(line => line.who === writer.name && /Assigned work completed/.test(line.text ?? ''))
      || !group.log?.some(line => line.who === tester.name && /Assigned work completed/.test(line.text ?? ''))) {
      fail('the saved group transcript is missing one or more owner dispatches', { log:group?.log })
    }

    console.log(`complete: status=${completed.status}, stages=${completed.stages.length}, tasks=${completed.stages.reduce((n, stage) => n + stage.tasks.length, 0)}, activeSamples=${trace.length}, idleSamples=${trace.filter(item => item.idle).length}`)
    console.log(`evidence: group=${room.id}; historyEvents=${completed.events.map(event => event.kind).join(',')}; mockRequests=${mockLog.length}; bench=${bench.base}`)
    console.log(`stopped: webPortFree=${stopped.webPortFree}, mockPortFree=${stopped.mockPortFree}; savedTranscriptLines=${group.log.length}`)
  } finally {
    if (!benchStopped) {
      const stopped = await stopBench({ home:HOME, webPort:WEB_PORT, mockPort:MOCK_PORT })
      if (!stopped.webPortFree || !stopped.mockPortFree) console.error('bench cleanup incomplete:', JSON.stringify(stopped))
      else console.log(`stopped: webPortFree=${stopped.webPortFree}, mockPortFree=${stopped.mockPortFree}`)
    }
  }
}

main().catch(error => {
  console.error(error.message)
  if (error.evidence !== undefined) console.error(JSON.stringify(error.evidence, null, 2))
  process.exitCode = 1
})
