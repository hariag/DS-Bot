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
    const groups = []
    for (const suffix of ['A', 'B']) {
      const admin = await bot(`Goal E2E ${suffix} Admin`, 'Project Manager', 'Coordinate group tasks, check evidence, and complete the goal.')
      const writer = await bot(`Goal E2E ${suffix} Writer`, 'Backend Developer', 'Prepare the assigned draft and report verifiable evidence.')
      const tester = await bot(`Goal E2E ${suffix} Tester`, 'Test Engineer', 'Verify the assigned draft and report the check evidence.')
      groups.push({ suffix, admin, writer, tester })
    }
    await waitFor('Bot setup turns to finish', async () => {
      const state = await api('state')
      return Object.keys(state.activity ?? {}).length === 0 ? state : undefined
    })
    for (const group of groups) {
      group.room = await api('create-room', {
        name:`Group Goal Lifecycle E2E ${group.suffix}`,
        members:[group.admin.id, group.writer.id, group.tester.id], admin:group.admin.id, greet:false,
      })
    }
    await waitFor('created groups', async () => {
      const current = rooms(await api('state'))
      return groups.every(group => current.some(item => item.id === group.room.id))
    })

    for (const group of groups) {
      const start = {
        action:'start',
        title:`Two-stage group-goal lifecycle ${group.suffix}`,
        objective:'Prepare a draft, independently verify it, and complete the group goal.',
        acceptance:'Both stages pass with member evidence and the administrator records a completion summary.',
        stages:[
          { title:'Draft', acceptance:'The writer provides the draft and evidence.', tasks:[{ bot:group.writer.name, task:'Prepare the lifecycle draft and report its evidence.' }] },
          { title:'Independent check', acceptance:'The tester verifies the draft and reports evidence.', tasks:[{ bot:group.tester.name, task:'Independently verify the lifecycle draft and report the result.' }] },
        ],
      }
      group.start = start
      await api('send', { sessionId:group.room.id, text:'调用 group_goal ' + JSON.stringify(start) })
    }

    const observe = state => {
      for (const group of groups) {
        const goal = activeGoal(state, group.room.id)
        if (!goal) continue
        group.trace ??= []
        group.trace.push({ status:goal.status, idle:goal.idle === true, revision:goal.revision,
          current:goal.current, tasks:goal.stages?.map(stage => stage.tasks?.map(task => task.status)) })
        group.observedReports ??= new Set()
        goal.stages?.forEach((stage, index) => {
          if (stage.tasks.some(task => task.status === 'reported' && task.statusSource === 'automatic')) group.observedReports.add(index)
        })
      }
    }
    const waitTask = async (group, stage, status) => waitFor(`group ${group.suffix} stage ${stage + 1} task ${status}`, async () => {
      const state = await api('state')
      observe(state)
      const goal = activeGoal(state, group.room.id)
      const task = goal?.stages?.[stage]?.tasks?.[0]
      return task?.status === status ? { goal, task } : undefined
    })

    const stage1Assigned = await Promise.all(groups.map(group => waitTask(group, 0, 'working')))
    for (const [index, result] of stage1Assigned.entries()) {
      const group = groups[index]
      console.log(`group ${group.suffix} stage 1 assigned: ${result.task.botId} status=${result.task.status}; goal=${result.goal.status}, idle=${result.goal.idle ?? false}`)
    }
    const stage1Reported = await Promise.all(groups.map(group => waitTask(group, 0, 'reported')))
    for (const [index, result] of stage1Reported.entries()) {
      if (result.task.statusSource !== 'automatic') fail(`group ${groups[index].suffix} stage 1 report was not recorded automatically`, { task:result.task })
      console.log(`group ${groups[index].suffix} stage 1 reported: source=${result.task.statusSource}`)
    }

    await waitFor('both groups pass stage 1 and assign stage 2', async () => {
      const state = await api('state')
      observe(state)
      return groups.every(group => activeGoal(state, group.room.id)?.stages?.[0]?.status === 'passed')
    })
    const completedState = await waitFor('both administrators complete their group goals', async () => {
      const state = await api('state')
      observe(state)
      return groups.every(group => activeGoal(state, group.room.id)?.status === 'complete') ? state : undefined
    })
    const completedGoals = groups.map(group => activeGoal(completedState, group.room.id))
    for (const [index, completed] of completedGoals.entries()) {
      const group = groups[index]
      if (completed.stages.length !== 2 || completed.stages.some(stage => stage.status !== 'passed'
        || stage.tasks.some(item => item.status !== 'done'))) {
        fail(`group ${group.suffix} full evidence chain was not completed`, { goal:completed })
      }
      if (!completed.summary || !completed.events.some(event => event.kind === 'complete')) fail(`group ${group.suffix} completion summary or event is missing`, { goal:completed })
      const sawWorking = stage => (group.trace ?? []).some(sample => sample.tasks?.[stage]?.[0] === 'working')
      const sawReported = stage => group.observedReports?.has(stage)
      if (![0, 1].every(stage => sawWorking(stage) && sawReported(stage))) {
        fail(`group ${group.suffix} missed an automatic task transition`, { trace:group.trace, reportedStages:[...(group.observedReports ?? [])] })
      }
    }

    const mockLog = readFileSync(join(HOME, 'mock.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    const fixtureErrors = mockLog.filter(entry => entry.out?.some(block => block.type === 'text' && /Group-goal fixture (?:could not|found)/.test(block.text)))
    if (fixtureErrors.length) fail('the group-goal mock reported a fixture error', { fixtureErrors })

    // The live board state deliberately omits the room transcript. Stop the
    // isolated host, then verify dispatch and owner replies in its saved audit log.
    const stopped = await stopBench({ home:HOME, webPort:WEB_PORT, mockPort:MOCK_PORT })
    benchStopped = stopped.webPortFree && stopped.mockPortFree
    if (!benchStopped) fail('E2E bench ports are still occupied after completion', stopped)
    const saved = JSON.parse(readFileSync(join(HOME, 'bot', 'state.json'), 'utf8'))
    const savedGroups = groups.map(group => rooms(saved).find(item => item.id === group.room.id))
    for (const [index, savedGroup] of savedGroups.entries()) {
      const group = groups[index]
      if (!savedGroup || !savedGroup.log?.some(line => line.text?.includes('@' + group.writer.name))
        || !savedGroup.log?.some(line => line.text?.includes('@' + group.tester.name))
        || !savedGroup.log?.some(line => line.who === group.writer.name && /Assigned work completed/.test(line.text ?? ''))
        || !savedGroup.log?.some(line => line.who === group.tester.name && /Assigned work completed/.test(line.text ?? ''))) {
        fail(`group ${group.suffix} saved transcript is missing one or more owner dispatches`, { log:savedGroup?.log })
      }
    }

    const activeSamples = groups.reduce((count, group) => count + (group.trace?.length ?? 0), 0)
    const idleSamples = groups.reduce((count, group) => count + (group.trace ?? []).filter(sample => sample.idle).length, 0)
    const taskCount = completedGoals.reduce((count, goal) => count + goal.stages.reduce((stageCount, stage) => stageCount + stage.tasks.length, 0), 0)
    console.log(`complete: groups=${groups.length}, stages=${completedGoals.reduce((count, goal) => count + goal.stages.length, 0)}, tasks=${taskCount}, activeSamples=${activeSamples}, idleSamples=${idleSamples}`)
    console.log(`evidence: groups=${groups.map((group, index) => `${group.room.id}:${completedGoals[index].events.map(event => event.kind).join(',')}`).join(';')}; mockRequests=${mockLog.length}; bench=${bench.base}`)
    console.log(`stopped: webPortFree=${stopped.webPortFree}, mockPortFree=${stopped.mockPortFree}; savedTranscriptLines=${savedGroups.map(group => group.log.length).join(',')}`)
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
