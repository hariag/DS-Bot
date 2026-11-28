import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { afterRound, loopTurn, waitForRound } from './relay-rows.js'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'
import { ROOM_WORK_GRACE_MS } from '../src/host/constants.js'

// Chief, the admin of group 'r1', speaks there from 'ga'; Writer from 'gb'; Tester from 'gc'.
const seed = (room = {}, extraRooms = {}) => ({
  version: 1,
  mainBotIds: ['a'],
  bots: {
    a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1 },
    b: { id: 'b', name: 'Writer', role: 'Write', sessionId: 'b', createdAt: 2 },
    c: { id: 'c', name: 'Tester', role: 'Test', sessionId: 'c', createdAt: 3 },
  },
  rooms: { r1: { id: 'r1', name: 'Ops', members: ['a', 'b', 'c'], mode: 'admin', admin: 'a', named: true, sessions: { a: 'ga', b: 'gb', c: 'gc' }, log: [], seq: 0, seen: {}, ...room }, ...extraRooms },
  agents: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
  prefs: {},
  revision: 0,
})

async function start(t, room, services, extraRooms) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-goal-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(seed(room, extraRooms)))
  const ctx = fakeContext({ services })
  const agents = new Map()
  const agentOf = (sessionId) => {
    if (!agents.has(sessionId)) {
      const calls = []
      const cancelled = []
      const held = []
      const nextStep = []
      const inbox = {
        nextStep,
        nextTurn: held,
        remove(id) {
          for (const list of [nextStep, held]) {
            const at = list.findIndex(message => message.id === id)
            if (at !== -1) { list.splice(at, 1); return true }
          }
          return false
        },
      }
      const keep = list => message => { calls.push(message); list.push(message) }
      agents.set(sessionId, { session: { id: sessionId }, calls, cancelled, inbox, followup: keep(held), steer: keep(nextStep), cancel(reason) { cancelled.push(reason) } })
    }
    return agents.get(sessionId)
  }
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async path => ({ id: 'w1', path }), archiveSession: async () => {} },
    sessionController: { create: async () => ({ sessionId: 's1' }), resolveAgent: async sessionId => ({ agent: agentOf(sessionId) }), selectModel: async () => {} },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => { route = options; return register(options) }
  const rt = createRuntime(ctx, { home })
  t.after(async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })
  let seq = 0
  const turns = new Map()
  const emit = (id, type, data) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) {
      if (listener.length >= 2) listener({ id }, { type, seq: ++seq, data })
    }
  }
  const tool = (name, args, sessionId, exec = {}) => (rt.teamTools.find(d => d.name === name) ?? ctx.registeredTools.get(name)).execute(args, { agent: { id: sessionId }, ...exec })
  const call = async (endpoint, payload) => (await route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))).json()
  const begin = (sessionId) => {
    const message = agentOf(sessionId).calls.at(-1)
    agentOf(sessionId).inbox.nextTurn.length = 0
    agentOf(sessionId).inbox.nextStep.length = 0
    const turn = (turns.get(sessionId) ?? 0) + 1
    turns.set(sessionId, turn)
    emit(sessionId, 'turn/start', { turn })
    emit(sessionId, 'user/message', { content: message.content, source: message.source })
    return message
  }
  const finish = (sessionId, reply) => {
    emit(sessionId, 'assistant/message', { message: { content: [{ type: 'text', text: reply }] } })
    emit(sessionId, 'turn/end', { turn: turns.get(sessionId), reason: { kind: 'completed' } })
  }
  const round = (callId, message, roomId = 'r1') => {
    emit(roomId, 'user/message', message)
    let result
    const stop = new AbortController()
    t.after(() => stop.abort())
    const done = tool('group_relay', {}, roomId, { callId, signal: stop.signal })
      .then(async (value) => (result = await afterRound(rt, roomId, value)))
    done.catch(() => {})
    const read = () => result
    read.done = done
    read.wait = ms => waitForRound(done, ms)
    return read
  }
  const say = text => ({ content: [{ type: 'text', text }], source: { kind: 'user' } })
  const takePost = () => {
    const post = agentOf('r1').calls.shift()
    return { content: post.content, source: post.source }
  }
  // The next goal relay post the room's Session was sent, if any.
  const takeGoal = () => {
    const at = agentOf('r1').calls.findIndex(call => call.source?.role === 'goal')
    if (at === -1) return undefined
    const [post] = agentOf('r1').calls.splice(at, 1)
    return { content: post.content, source: post.source }
  }
  await tool('list_bots', {}, 'a')
  return { home, ctx, rt, agentOf, emit, tool, call, begin, finish, round, say, takePost, takeGoal }
}

const settle = async (check) => {
  const until = Date.now() + 3000
  while (!check() && Date.now() < until) await loopTurn()
  assert.ok(check(), 'condition not reached')
}
const settleTimer = async (check) => {
  for (let i = 0; i < 300 && !check(); i += 1) await new Promise(resolve => setTimeout(resolve, 10))
  assert.ok(check(), 'condition not reached')
}
const bindGoal = (host, roomId = 'r1') => {
  const g = host.rt.roomOf(roomId).goal
  return { goal_id: g?.id ?? 'none', expected_revision: g?.revision ?? 0 }
}
const text = message => message.content.map(block => block.text ?? '').join('\n')
const saved = host => JSON.parse(readFileSync(join(host.home, 'state.json'), 'utf8'))
const goal = host => saved(host).rooms.r1.goal
const logLines = host => saved(host).rooms.r1.log

const STAGES = [
  { title: 'Draft', acceptance: 'draft reviewed', tasks: [{ bot: 'Writer', task: 'write the draft' }] },
  { title: 'Check', acceptance: 'checks pass', tasks: [{ bot: 'Tester', task: 'run the checks' }] },
]
const startGoal = (host, extra = {}) => host.tool('group_goal', {
  action: 'start', title: 'Ship it', objective: 'Ship the thing', acceptance: 'it is shipped', stages: STAGES, ...extra,
}, 'ga')

test('group task admission creates and persists a member Session and rejects nonmembers', async t => {
  const host = await start(t, { sessions:{ a:'ga', c:'gc' } })
  const sessionId = await host.rt.ensureGroupTaskSession('r1', 'b')
  assert.equal(sessionId, 's1')
  assert.equal(host.rt.state.rooms.r1.sessions.b, sessionId)
  assert.deepEqual(host.rt.groupOwners.get(sessionId), { botId:'b', roomId:'r1' })
  assert.equal(typeof host.rt.state.rooms.r1.seen, 'object')
  assert.equal(await host.rt.ensureGroupTaskSession('r1', 'missing'), undefined)
})

test('a scheduled review retries the same occurrence after a busy result', async t => {
  const host = await start(t)
  await startGoal(host)
  const room = host.rt.state.rooms.r1
  assert.equal(typeof host.rt.roomBusyForPatrol, 'function')
  assert.equal(host.rt.roomLaterCount('r1'), 0)
  room.goal.ownerReviewAt = 0
  await host.rt.save({ required:true })
  const agent = host.agentOf('r1')
  agent.inbox.nextTurn.push({ id:'busy', source:{ kind:'bot' } })
  const key = JSON.stringify(['managed', new Date().toISOString()])
  assert.equal(await host.rt.runScheduledRoomReview(room, key, agent), 'busy')
  const busy = room.scheduledReviewOccurrence
  assert.equal(busy.outcome, 'busy')
  assert.equal(busy.busyReason, 'root-queue')
  assert.ok(Number.isSafeInteger(busy.busyAt) && busy.busyAt >= busy.at)
  assert.deepEqual(saved(host).rooms.r1.scheduledReviewOccurrence, busy)
  agent.inbox.nextTurn.length = 0
  assert.equal(await host.rt.runScheduledRoomReview(room, key, agent), 'admitted')
  assert.equal(room.scheduledReviewOccurrence.outcome, 'admitted')
  assert.equal(room.scheduledReviewOccurrence.busyReason, undefined)
  assert.equal(room.scheduledReviewOccurrence.busyAt, undefined)
  assert.ok(room.goal.reviewAttempt)
  assert.equal(room.goal.idle, undefined, 'active goals can be reviewed without entering an idle state')
})

test('a completed periodic review leaves an unfinished goal active and schedules the next check', async t => {
  const host = await start(t)
  await startGoal(host)
  const room = host.rt.roomOf('r1')
  assert.equal(typeof host.rt.roomBusyForPatrol, 'function')
  room.goal.ownerReviewAt = 0
  await host.rt.save({ required:true })
  const key = JSON.stringify(['managed', new Date().toISOString()])
  assert.equal(await host.rt.runScheduledRoomReview(room, key, host.agentOf('r1')), 'admitted')
  const reviewId = room.goal.reviewAttempt.id
  await host.rt.goalDrive(room, { goalReviewId:reviewId, stoppedOnly:false, slots:[{ id:'a', status:'passed' }] })
  assert.equal(room.goal.status, 'active')
  assert.equal(room.goal.idle, undefined)
  assert.equal(room.goal.reviewAttempt, undefined)
  assert.ok(room.goal.ownerReviewAt > Date.now())
})

test('group_goal start validates the goal with the contract refusals', async (t) => {
  const host = await start(t)
  const run = args => host.tool('group_goal', args, 'ga')
  assert.equal(await run({ action: 'start', acceptance: 'ok', stages: STAGES }), 'objective is required for start.')
  assert.equal(await run({ action: 'start', objective: 'o', stages: STAGES }), 'acceptance is required for start.')
  assert.equal(await run({ action: 'start', objective: 'o', acceptance: 'a' }), 'stages is required for start.')
  assert.equal(await run({ action: 'start', objective: 'o', acceptance: 'a', stages: [{ acceptance: 'x', tasks: [{ bot: 'Writer', task: 't' }] }] }), 'stage 1 title is required for start.')
  assert.equal(await run({ action: 'start', objective: 'o', acceptance: 'a', stages: [{ title: 'S', acceptance: 'x', tasks: [{ bot: 'Nobody', task: 't' }] }] }), 'Nobody is not a member of "Ops". Members: Chief, Writer, Tester.')
  const many = { title: 'S', acceptance: 'x', tasks: Array.from({ length: 13 }, (_, i) => ({ bot: 'Writer', task: `t${i}` })) }
  assert.equal(await run({ action: 'start', objective: 'o', acceptance: 'a', stages: [many] }), 'At most 12 tasks in stage 1.')
  assert.equal(goal(host), undefined)
})

test('a goal starts, passes its stages, and completes', async (t) => {
  const host = await start(t)
  assert.match(await startGoal(host), /Started\. Hand out the tasks of stage 1 now/)
  const started = goal(host)
  assert.deepEqual([started.status, started.current, started.stages.map(stage => stage.status)], ['active', 0, ['active', 'pending']])
  assert.deepEqual(started.stages[0].tasks.map(task => task.status), ['pending'])
  assert.ok(logLines(host).some(line => line.reason === 'goal' && line.event === 'start' && line.title === 'Ship it'))

  assert.equal(await host.tool('group_goal', { action: 'pass' }, 'ga'), 'evidence is required for pass.')
  assert.equal(await host.tool('group_goal', { action: 'complete', evidence: 'e', summary: 's' }, 'ga'), 'Stage 1 "Draft" has not passed yet. Pass every stage before complete.')
  assert.equal(await host.tool('group_goal', { action: 'pass', evidence: 'reviewed' }, 'ga'), 'Stage 1 has 1 task(s) not reported yet (write the draft); check each result before pass.')

  await host.tool('group_goal', { action: 'task', bot: 'Writer', status: 'reported', note: 'Draft attached for review' }, 'ga')
  assert.match(await host.tool('group_goal', { action: 'pass', evidence: 'reviewed' }, 'ga'), /Stage 1 passed\. Stage 2 "Check" is current/)
  const second = goal(host)
  assert.deepEqual([second.current, second.stages.map(stage => stage.status)], [1, ['passed', 'active']])
  assert.equal(second.stages[0].tasks[0].status, 'done')
  assert.equal(second.stages[0].evidence, 'reviewed')

  await host.tool('group_goal', { action: 'task', bot: 'Tester', status: 'reported', note: 'Checks passed' }, 'ga')
  assert.match(await host.tool('group_goal', { action: 'pass', evidence: 'green' }, 'ga'), /Every stage passed/)
  assert.equal(goal(host).current, 2)
  assert.equal(await host.tool('group_goal', { action: 'complete', summary: 's' }, 'ga'), 'evidence is required for complete.')
  assert.equal(await host.tool('group_goal', { action: 'complete', evidence: 'e' }, 'ga'), 'summary is required for complete.')
  assert.match(await host.tool('group_goal', { action: 'complete', evidence: 'all green', summary: 'shipped' }, 'ga'), /Complete\. Tell the user what was delivered\./)
  assert.equal(goal(host).status, 'complete')
})

test('rework sends the current stage back; revise keeps passed stages and a matching task', async (t) => {
  const host = await start(t)
  await startGoal(host)
  await host.tool('group_goal', { action: 'task', bot: 'Writer', status: 'working' }, 'ga')
  assert.equal(goal(host).stages[0].tasks[0].status, 'working')
  assert.equal(await host.tool('group_goal', { action: 'rework' }, 'ga'), 'reason is required for rework.')
  await host.tool('group_goal', { action: 'rework', reason: 'missing tests' }, 'ga')
  const back = goal(host)
  assert.equal(back.stages[0].tasks[0].status, 'pending')
  assert.deepEqual([back.stages[0].reworks, back.stages[0].feedback], [1, 'missing tests'])

  await host.tool('group_goal', { action: 'task', bot: 'Writer', status: 'reported', note: 'Revised draft ready' }, 'ga')
  await host.tool('group_goal', { action: 'pass', evidence: 'ok' }, 'ga')
  await host.tool('group_goal', { action: 'task', bot: 'Tester', status: 'working' }, 'ga')
  assert.equal(await host.tool('group_goal', { action: 'revise', stages: [STAGES[1]] }, 'ga'), 'reason is required for revise.')
  await host.tool('group_goal', {
    action: 'revise',
    reason: 'scope changed',
    stages: [
      { title: 'Check', acceptance: 'checks pass', tasks: [{ bot: 'Tester', task: 'run the checks' }] },
      { title: 'Wrap', acceptance: 'wrapped', tasks: [{ bot: 'Writer', task: 'wrap up' }] },
    ],
  }, 'ga')
  const revised = goal(host)
  assert.deepEqual(revised.stages.map(stage => [stage.id, stage.status]), [['s1', 'passed'], ['s2', 'active'], ['s3', 'pending']])
  assert.equal(revised.current, 1)
  // The same member's same task in the replaced current stage kept its status.
  assert.equal(revised.stages[1].tasks[0].status, 'working')
  assert.equal(revised.stages[1].tasks[0].botId, 'c')
})

test('pause, resume and stop refuse the wrong state and follow it', async (t) => {
  const host = await start(t)
  await startGoal(host)
  assert.equal(await host.tool('group_goal', { action: 'resume' }, 'ga'), 'The goal of "Ops" is active; resume needs it to be paused.')
  await host.tool('group_goal', { action: 'pause' }, 'ga')
  assert.equal(goal(host).status, 'paused')
  assert.equal(await host.tool('group_goal', { action: 'pass', evidence: 'e' }, 'ga'),
    'The goal of "Ops" is paused. The user resumes it; until then, talk with the user and write their corrections in with revise.')
  await host.tool('group_goal', { action: 'resume' }, 'ga')
  assert.equal(goal(host).status, 'active')
  assert.equal(await host.tool('group_goal', { action: 'stop' }, 'ga'), 'reason is required for stop.')
  await host.tool('group_goal', { action: 'stop', reason: 'no longer needed' }, 'ga')
  const stopped = goal(host)
  assert.deepEqual([stopped.status, stopped.reason], ['stopped', 'no longer needed'])
  assert.equal(await host.tool('group_goal', { action: 'pause' }, 'ga'), 'The goal of "Ops" is stopped; pause needs it to be active.')
})

test('only the admin or a Main Bot changes a goal; any member can show it', async (t) => {
  const host = await start(t, {}, undefined, {
    r2: { id: 'r2', name: 'Lab', members: ['a', 'c'], mode: 'admin', admin: null, named: true, sessions: {}, log: [], seq: 0, seen: {} },
  })
  assert.equal(await host.tool('group_goal', { action: 'start', objective: 'o', acceptance: 'a', stages: STAGES }, 'gb'),
    'Only Chief, the admin of "Ops", or a Main Bot changes its goal. Tell the admin in the group.')
  assert.match(await host.tool('group_goal', { action: 'show' }, 'gb'), /"Ops" has no goal/)
  assert.match(await host.tool('group_goal', { action: 'start', group: 'Ops', title: 'Ship it', objective: 'o', acceptance: 'a', stages: STAGES }, 'a'), /Started\./)
  assert.match(await host.tool('group_goal', { action: 'show' }, 'gb'), /The group works toward: Ship it/)
  assert.equal(await host.tool('group_goal', { action: 'start', group: 'Lab', objective: 'o', acceptance: 'a', stages: STAGES }, 'a'),
    '"Lab" has no admin, and a goal needs one to run it. Set an admin with update_group first.')
  assert.equal(await host.tool('group_goal', { action: 'stop', group: 'Lab', reason: 'r' }, 'c'),
    'Only a Main Bot changes the goal of "Lab".')
})

test('events keep the newest 50 and pastGoals retain the newest 5 plus audited history', async (t) => {
  const host = await start(t)
  await startGoal(host)
  for (let i = 0; i < 60; i++) {
    await host.tool('group_goal', { action: 'task', bot: 'Writer', status: i % 2 === 0 ? 'working' : 'pending' }, 'ga')
  }
  assert.equal(goal(host).events.length, 50)
  for (let i = 0; i < 7; i++) {
    const id = goal(host).id
    await host.tool('group_goal', { action: 'stop', reason: `r${i}` }, 'ga')
    assert.equal((await host.call('goal-control', { roomId: 'r1', goalId: id, action: 'clear' })).ok, true)
    await host.tool('group_goal', { action: 'show' }, 'ga')
    assert.match(await startGoal(host, { title: `g${i}` }), /Started\./)
  }
  const room = saved(host).rooms.r1
  assert.equal(room.pastGoals.length, 6)
  assert.equal(room.pastGoals[0].stages[0].tasks[0].goalBoardReplies.length, 60)
  assert.equal(room.pastGoals.at(-1).status, 'stopped')
})

test('a review invalidated while saving the round never becomes an ordinary nudge', async (t) => {
  const host = await start(t)
  await startGoal(host)
  const room = host.rt.roomOf('r1')
  const reviewId = 'review-invalidated-on-save'
  room.goal.reviewAttempt = { id:reviewId, at:Date.now(), state:'admitting', adminId:'a', rootSessionId:'r1', adminSessionId:'ga', inspectOnly:true }
  let checks = 0
  t.mock.method(host.rt, 'goalReviewAllowed', () => ++checks === 1)
  const result = host.round('stale-review', {
    source:{kind:'bot', form:'relay', role:'goal', goal:'nudge', goalId:room.goal.id, reviewId, reviewInspect:true},
    content:[{type:'text', text:'[Scheduled group board review]'}],
  })
  await settle(() => result() !== undefined)
  assert.ok(checks >= 2)
  assert.equal(host.agentOf('ga').calls.length, 0)
})

test('the admin and member prompts carry the goal block', async (t) => {
  const host = await start(t)
  await startGoal(host)
  const result = host.round('c1', host.say('@Chief go'))
  await settle(() => host.agentOf('ga').calls.length === 1)
  const admin = text(host.begin('ga'))
  assert.match(admin, /<group_goal status="active">/)
  assert.match(admin, /\[current\] 1\. Draft — done when: draft reviewed/)
  assert.match(admin, /- Writer: write the draft \[not started\]/)
  assert.match(admin, /\[next\] 2\. Check: Tester/)
  assert.match(admin, /You run this goal\./)
  host.finish('ga', '@Writer write the draft')
  await settle(() => host.agentOf('gb').calls.length === 1)
  const member = text(host.begin('gb'))
  assert.match(member, /<group_goal status="active" stage="1\/2">/)
  // The admin's @Writer call already moved the task to working before this prompt.
  assert.match(member, /Your task in it: write the draft \(working\)\./)
  host.finish('gb', 'draft written')
  await result.wait()

  const again = host.round('c2', host.say('@Tester hello'))
  await settle(() => host.agentOf('gc').calls.length === 1)
  assert.match(text(host.begin('gc')), /You have no task in this stage\./)
  host.finish('gc', '[PASS]')
  await again.wait()
})

test('v1.2 members receive a scoped Chinese goal ledger and administrators keep the inspection boundaries', async t => {
  const host = await start(t)
  await startGoal(host)
  const room = host.rt.state.rooms.r1
  const admin = host.rt.botOf('a'), member = host.rt.botOf('b')
  admin.instructions = member.instructions = '团队章程 v1.2'
  const memberBlock = host.rt.goalBlock(room, member)
  assert.match(memberBlock, /你的任务：write the draft/)
  assert.doesNotMatch(memberBlock, /Your task in it|Current goal binding|review_fingerprint=/)
  const block = host.rt.goalBlock(room, admin, { nudge: true })
  assert.match(block, /review_fingerprint=[a-f0-9]{64}/)
  assert.match(block, /未核实填未知、review_complete=false/)
  assert.equal(block.split('交接不明只查原回执').length, 2)
  assert.doesNotMatch(block, /You run this goal|Current goal binding|Apply each saved goal rule/)
  room.goal.reviewAttempt = { id:'r-test', adminId:admin.id, scheduledPrompt:'只核对本群签收记录。' }
  const inspection = host.rt.goalBlock(room, admin, { nudge: true, inspectOnly: true, reviewId:'r-test' })
  assert.match(inspection, /本回合禁止 delegate_work/)
  assert.match(inspection, /只核对本群签收记录/)
  assert.doesNotMatch(inspection, /必须派工|先用 board_task register 登记再通知开工/)
  const other = host.rt.goalBlock(room, admin, { nudge: true, reviewId:'other' })
  assert.doesNotMatch(other, /只核对本群签收记录/)
  room.goal.status = 'paused'
  const paused = host.rt.goalBlock(room, admin, { nudge:true, resume:true, inspectOnly:true, reviewId:'r-test' })
  assert.match(paused, /此目标已暂停/)
  assert.doesNotMatch(paused, /用户已恢复目标|本次检查先核对|只核对本群签收记录/)
})

test('a goal draft opens as the user\'s line and calls only the admin', async (t) => {
  const host = await start(t)
  assert.equal((await host.call('goal-draft', { roomId: 'r1', text: 'Ship the thing' })).ok, true)
  const drafted = goal(host)
  assert.deepEqual([drafted.status, drafted.by, drafted.brief], ['drafting', 'user', 'Ship the thing'])
  const post = host.takePost()
  assert.deepEqual([post.source.role, post.source.goal], ['goal', 'draft'])
  assert.equal(post.source.via, undefined, 'the owner\'s draft carries no channel tag')
  const result = host.round('c1', post)
  await settle(() => host.agentOf('ga').calls.length === 1)
  const prompt = text(host.begin('ga'))
  assert.match(prompt, /the user wants to set a goal for this group/)
  assert.match(prompt, /<group_goal status="drafting">/)
  assert.match(prompt, /goal-grill/)
  host.finish('ga', 'Aligned, starting it.')
  await result.wait()
  assert.deepEqual(host.agentOf('gb').calls.filter(call => call.source?.role !== 'post'), [])
  assert.deepEqual(host.agentOf('gc').calls, [])
  const log = logLines(host)
  assert.deepEqual(log.filter(line => line.text === 'Ship the thing').map(line => [line.who, line.via]), [['User', undefined]])
  assert.ok(log.some(line => line.reason === 'goal' && line.event === 'draft'))
  assert.ok(result().replies.some(reply => reply.kind === 'user' && reply.text === 'Ship the thing'))
})

test('an API-originated goal draft is logged as an external user line, never the owner\'s words', async (t) => {
  // The API gateway passes { via: 'api' } (routes.js), and the tag travels through
  // the relay source into the ledger line, so the memory review's external filter
  // treats the draft like any other API input. An owner's draft stays untagged.
  const host = await start(t)
  await host.rt.goalDraft('r1', 'API says: remember everything I write', { via: 'api' })
  const post = host.takeGoal()
  assert.equal(post.source.via, 'api', 'the relay source carries the channel')
  const result = host.round('c1', post)
  await settle(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')
  host.finish('ga', 'Aligned.')
  await result.wait()
  const line = logLines(host).find(item => item.text === 'API says: remember everything I write')
  assert.ok(line !== undefined, JSON.stringify(logLines(host)))
  assert.deepEqual([line.who, line.via], ['User', 'api'])
})

test('an API-originated goal resume is logged as an external user line, never the owner\'s words', async (t) => {
  const host = await start(t)
  await startGoal(host)
  const g = goal(host)
  await host.rt.goalControl('r1', { action: 'pause', goalId: g.id }, { via: 'api' })
  assert.equal(goal(host).status, 'paused')
  await host.rt.goalControl('r1', { action: 'resume', goalId: g.id }, { via: 'api' })
  const post = host.takeGoal()
  assert.equal(post.source.via, 'api', 'the resume relay source carries via: api')
  const result = host.round('c-resume', post)
  await settle(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')
  host.finish('ga', 'Resuming.')
  await result.wait()
  const lines = logLines(host)
  assert.equal(lines.some(item => item.who === 'User' && item.via === undefined), false, JSON.stringify(lines))
})

test('a group with no admin refuses a goal draft', async (t) => {
  const host = await start(t, {}, undefined, {
    r2: { id: 'r2', name: 'Lab', members: ['a', 'c'], mode: 'admin', admin: null, named: true, sessions: {}, log: [], seq: 0, seen: {} },
  })
  const result = await host.call('goal-draft', { roomId: 'r2', text: 'x' })
  assert.equal(result.error.message, 'This group has no admin. Set one in the group settings first.')
})

test('an idle round wakes the admin for a goal check; [PASS] keeps an unfinished goal active', async (t) => {
  const host = await start(t)
  await startGoal(host)
  // A user-message round ends with nothing running: the goal check queues once.
  const first = host.round('c1', host.say('@Chief go'))
  await settle(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')
  host.finish('ga', 'on it')
  await first.wait()
  const nudge = host.takeGoal()
  assert.ok(nudge !== undefined, 'one goal check was queued')
  assert.match(text(nudge), /^\[Goal check\]$/)
  // The check opens a round on the admin alone, with the goal-check line.
  const check = host.round('c2', nudge)
  await settle(() => host.agentOf('ga').calls.length === 2)
  const prompt = text(host.agentOf('ga').calls[1])
  assert.match(prompt, /goal check/)
  assert.match(prompt, /Goal check from DS Bot/)
  assert.match(prompt, /A lack of progress is not itself a user blocker/)
  assert.match(prompt, /Honor any agreed feedback deadline and follow up once through the original handoff when it passes/)
  assert.match(prompt, /Escalate to the person authorized to unblock or decide if receipt remains unconfirmed after that follow-up/)
  assert.match(prompt, /Use two scheduled checks without confirmation only when no deadline was agreed/)
  assert.match(prompt, /If a real user decision is the only way forward, report the exact question, recommendation, impact and next check time/)
  assert.match(prompt, /continue independent authorized work and do not repeat an unchanged decision request/)
  assert.match(prompt, /Ask the user only for decisions you cannot make/)
  host.begin('ga')
  host.finish('ga', '[PASS]')
  await check.wait()
  assert.equal(goal(host).status, 'active')
  assert.equal(goal(host).idle, undefined)
  assert.ok(goal(host).ownerReviewAt > Date.now(), 'a bounded periodic review is scheduled')
  assert.equal(host.agentOf('r1').calls.filter(call => call.source?.role === 'goal' && call.source.goal === 'nudge').length, 0)
})

test('two goal checks without progress back off to periodic review; a user message resets the burst', async (t) => {
  const host = await start(t)
  await startGoal(host)
  const first = host.round('c1', host.say('@Chief go'))
  await settle(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')
  host.finish('ga', 'on it')
  await first.wait()
  // The first check: the admin only runs its own tools — that is not progress, so
  // the next check still queues.
  const one = host.round('c2', host.takeGoal())
  await settle(() => host.agentOf('ga').calls.length === 2)
  host.begin('ga')
  host.emit('ga', 'tool/call', { callId: 'k1', name: 'list_bots', arguments: '{}' })
  host.finish('ga', 'waiting on the user')
  await one.wait()
  assert.equal(goal(host).nudges, 2)
  // The second check: same, so immediate checks back off without idling the goal.
  const two = host.round('c3', host.takeGoal())
  await settle(() => host.agentOf('ga').calls.length === 3)
  host.begin('ga')
  host.finish('ga', 'still waiting')
  await two.wait()
  assert.equal(goal(host).idle, undefined)
  assert.ok(goal(host).ownerReviewAt > Date.now())
  // A user message clears the backoff count and starts another bounded burst.
  const third = host.round('c4', host.say('@Chief new ask'))
  await settle(() => host.agentOf('ga').calls.length === 4)
  host.begin('ga')
  host.finish('ga', '[PASS]')
  await third.wait()
  assert.equal(goal(host).status, 'active')
  assert.equal(goal(host).idle, undefined)
  assert.equal(goal(host).nudges, 1, 'the user-message round does not count as an automatic goal check')
})

test('a paused goal and a room at work do not get a goal check', async (t) => {
  const host = await start(t)
  await startGoal(host)
  assert.equal((await host.call('goal-control', { roomId: 'r1', goalId: goal(host).id, action: 'pause' })).ok, true)
  assert.match(await host.tool('post_to_group', { group: 'Ops', message: 'checking in' }, 'b'), /Nobody answers it/)
  const paused = host.round('c1', host.takePost())
  await paused.wait()
  assert.equal(host.takeGoal(), undefined)
  // A member still at work in the room holds the check too.
  await host.call('goal-control', { roomId: 'r1', goalId: goal(host).id, action: 'resume' })
  const wake = host.round('c2', host.takeGoal())
  await settle(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')
  host.finish('ga', 'back on it')
  await wake.wait()
  host.agentOf('r1').calls.length = 0
  host.emit('gb', 'turn/start', { turn: 9 })
  assert.match(await host.tool('post_to_group', { group: 'Ops', message: 'more news' }, 'c'), /Nobody answers it/)
  const busy = host.round('c3', host.takePost())
  await busy.wait()
  assert.equal(host.takeGoal(), undefined)
})

test('the goal tracks tasks as the admin calls and members answer', async (t) => {
  const host = await start(t)
  await startGoal(host)
  const writerTask = () => goal(host).stages[0].tasks.find(task => task.botId === 'b')
  const result = host.round('c1', host.say('@Chief go'))
  await settle(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')
  host.finish('ga', '@Writer write the draft')
  await settle(() => host.agentOf('gb').calls.length === 1)
  await settle(() => writerTask().status === 'working')
  host.begin('gb')
  host.finish('gb', 'draft written, see out.md')
  await settle(() => writerTask().status === 'reported')
  await result.wait()
})

test('a failed model call and a user stop put the task back with a note', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const host = await start(t)
  await startGoal(host)
  const writerTask = () => goal(host).stages[0].tasks.find(task => task.botId === 'b')
  const result = host.round('c1', host.say('@Chief go'))
  await settle(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')
  host.finish('ga', '@Writer write the draft')
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  host.emit('gb', 'tool/call', { callId: 'k1', name: 'pwsh', arguments: '{}' })
  t.mock.timers.tick(ROOM_WORK_GRACE_MS * 2)
  await result.wait()
  // Its model call fails after the round moved on.
  host.emit('gb', 'turn/end', { turn: 1, reason: { kind: 'error', error: { code: 'RATE_LIMIT', status: 429, message: 'Too many requests' } } })
  await settle(() => writerTask().status === 'pending' && writerTask().note === 'Could not finish: its model call failed')
})

test('the user stopping a member puts its task back with a note', async (t) => {
  const host = await start(t)
  await startGoal(host)
  await host.tool('group_goal', { action: 'task', bot: 'Writer', status: 'working' }, 'ga')
  host.emit('gb', 'turn/start', { turn: 1 })
  assert.equal((await host.call('stop-member-work', { roomId: 'r1', botId: 'b' })).value, true)
  await settle(() => {
    const task = goal(host).stages[0].tasks[0]
    return task.status === 'pending' && task.note === 'Stopped by the user'
  })
})

test('goal-control pauses, resumes, stops and clears a goal', async (t) => {
  const host = await start(t)
  await startGoal(host)
  const stale = await host.call('goal-control', { roomId: 'r1', goalId: 'goal-nope', action: 'pause' })
  assert.deepEqual([stale.error.code, stale.error.message], ['bot/stale', 'The goal has changed. Look again.'])
  assert.equal((await host.call('goal-control', { roomId: 'r1', goalId: goal(host).id, action: 'pause' })).ok, true)
  assert.equal(goal(host).status, 'paused')
  assert.equal((await host.call('goal-control', { roomId: 'r1', goalId: goal(host).id, action: 'pause' })).error.message,
    'The goal of "Ops" is paused; pause needs it to be active.')
  assert.equal((await host.call('goal-control', { roomId: 'r1', goalId: goal(host).id, action: 'resume' })).ok, true)
  assert.equal(goal(host).status, 'active')
  const resumed = host.takeGoal()
  assert.deepEqual([resumed.source.goal, text(resumed)], ['resume', '[Goal resumed]'])
  const wake = host.round('c1', resumed)
  await settle(() => host.agentOf('ga').calls.length === 1)
  assert.match(text(host.agentOf('ga').calls[0]), /The user resumed the goal\. Take the next step now\./)
  host.begin('ga')
  host.finish('ga', 'back on it')
  await wake.wait()

  assert.equal((await host.call('goal-control', { roomId: 'r1', goalId: goal(host).id, action: 'stop' })).ok, true)
  assert.equal(goal(host).status, 'stopped')
  assert.equal((await host.call('goal-control', { roomId: 'r1', goalId: goal(host).id, action: 'clear' })).ok, true)
  const room = saved(host).rooms.r1
  assert.equal(room.goal, undefined)
  assert.equal(room.pastGoals.length, 1)
})

test('pause with stopWork and stop stop the room\'s work', async (t) => {
  const host = await start(t)
  await startGoal(host)
  host.emit('gb', 'turn/start', { turn: 1 })
  assert.equal((await host.call('goal-control', { roomId: 'r1', goalId: goal(host).id, action: 'pause', stopWork: true })).ok, true)
  assert.equal(host.agentOf('gb').cancelled.length, 1)
  await host.call('goal-control', { roomId: 'r1', goalId: goal(host).id, action: 'resume' })
  host.takeGoal()
  host.emit('gc', 'turn/start', { turn: 1 })
  assert.equal((await host.call('goal-control', { roomId: 'r1', goalId: goal(host).id, action: 'stop' })).ok, true)
  assert.equal(host.agentOf('gc').cancelled.length, 1)
})

test('the tool stop stops the other members\' work, not the caller\'s', async (t) => {
  const host = await start(t)
  await startGoal(host)
  host.emit('gb', 'turn/start', { turn: 1 })
  host.emit('gc', 'turn/start', { turn: 1 })
  await host.tool('group_goal', { action: 'stop', reason: 'done for now' }, 'ga')
  assert.equal(goal(host).status, 'stopped')
  assert.equal(host.agentOf('gb').cancelled.length, 1)
  assert.equal(host.agentOf('gc').cancelled.length, 1)
  assert.equal(host.agentOf('ga').cancelled.length, 0)
})

test('a stale goal check calls nobody; a stale draft is a plain user message', async (t) => {
  const host = await start(t)
  await startGoal(host)
  const first = host.round('c1', host.say('@Chief go'))
  await settle(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')
  host.finish('ga', 'on it')
  await first.wait()
  const nudge = host.takeGoal()
  assert.ok(nudge !== undefined)
  // The user pauses before the check runs: it opens a round that calls nobody.
  await host.call('goal-control', { roomId: 'r1', goalId: goal(host).id, action: 'pause' })
  const stale = host.round('c2', nudge)
  await stale.wait()
  assert.equal(host.agentOf('ga').calls.length, 1)
  // The round calls nobody; the pause the user made shows above it, where it happened.
  assert.deepEqual(stale().replies, [])
  // A draft whose goal was stopped keeps its user line and routes as a user post.
  const id = goal(host).id
  await host.call('goal-control', { roomId: 'r1', goalId: id, action: 'stop' })
  await host.call('goal-control', { roomId: 'r1', goalId: id, action: 'clear' })
  await host.call('goal-draft', { roomId: 'r1', text: 'Build the site' })
  const draft = host.takeGoal()
  assert.deepEqual(draft.source.goal, 'draft')
  await host.call('goal-control', { roomId: 'r1', goalId: goal(host).id, action: 'stop' })
  assert.equal(goal(host).status, 'stopped')
  const plain = host.round('c3', draft)
  await settle(() => host.agentOf('ga').calls.length === 2)
  const prompt = text(host.agentOf('ga').calls[1])
  assert.doesNotMatch(prompt, /the user wants to set a goal for this group/)
  host.begin('ga')
  host.finish('ga', 'the goal is stopped')
  await plain.wait()
  assert.ok(logLines(host).some(line => line.who === 'User' && line.text === 'Build the site'))
})

test('stop-room-work sets the goal waiting and no check follows the notice', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const host = await start(t)
  await startGoal(host)
  const first = host.round('c1', host.say('@Chief go'))
  await settle(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')
  host.finish('ga', '@Writer write the draft')
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  host.emit('gb', 'tool/call', { callId: 'k1', name: 'pwsh', arguments: '{}' })
  t.mock.timers.tick(ROOM_WORK_GRACE_MS * 2)
  await first.wait()
  assert.equal((await host.call('stop-room-work', { roomId: 'r1' })).value, true)
  await settle(() => goal(host).idle === true)
  await settle(() => host.agentOf('r1').calls.length > 0)
  // The stop notices open a quiet round that calls nobody and queues no check.
  const notices = []
  while (host.agentOf('r1').calls.length > 0) notices.push(host.takePost())
  for (const notice of notices) {
    const quiet = host.round(`s${notices.indexOf(notice)}`, notice)
    await quiet.wait()
  }
  assert.equal(host.agentOf('ga').calls.length, 1)
  assert.equal(host.takeGoal(), undefined)
})

for (const [endpoint, body] of [['stop-room-work', { roomId: 'r1' }], ['stop-member-work', { roomId: 'r1', botId: 'b' }]]) {
  test(`${endpoint} that fails still sets the goal waiting`, async (t) => {
    const host = await start(t)
    await startGoal(host)
    host.emit('gb', 'turn/start', { turn: 1 })
    host.agentOf('gb').cancel = () => { throw new Error('cancel failed') }
    assert.equal((await host.call(endpoint, body)).ok, false)
    const { rooms } = (await host.call('state', {})).value
    assert.equal(rooms.find(room => room.id === 'r1').goal.idle, true)
  })
}

test('a batch member that finishes first is reported while its peer still works', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const host = await start(t)
  await startGoal(host, {
    stages: [
      { title: 'Draft', acceptance: 'draft reviewed', tasks: [{ bot: 'Writer', task: 'write the draft' }, { bot: 'Tester', task: 'check the draft' }] },
      { title: 'Check', acceptance: 'checks pass', tasks: [{ bot: 'Tester', task: 'run the checks' }] },
    ],
  })
  const taskOf = botId => goal(host).stages[0].tasks.find(task => task.botId === botId)
  const first = host.round('c1', host.say('@Chief go'))
  await settle(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')
  host.finish('ga', '@Writer @Tester start the draft')
  await settle(() => host.agentOf('gb').calls.length === 1 && host.agentOf('gc').calls.length === 1)
  host.begin('gb')
  host.emit('gb', 'tool/call', { callId: 'k1', name: 'pwsh', arguments: '{}' })
  host.begin('gc')
  host.emit('gc', 'tool/call', { callId: 'k2', name: 'pwsh', arguments: '{}' })
  t.mock.timers.tick(ROOM_WORK_GRACE_MS * 2)
  await first.wait()
  await settle(() => taskOf('b').status === 'working' && taskOf('c').status === 'working')
  // Writer posts its result while Tester is still at work: reported at once.
  host.finish('gb', 'draft written, see out.md')
  await settle(() => taskOf('b').status === 'reported')
  assert.equal(taskOf('c').status, 'working')
})

test('member work after the immediate check backoff restarts goal progress', async (t) => {
  const host = await start(t)
  await startGoal(host)
  // Exhaust the immediate check burst without idling the unfinished goal.
  const first = host.round('c1', host.say('@Chief go'))
  await settle(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')
  host.finish('ga', '[PASS]')
  await first.wait()
  const one = host.round('c2', host.takeGoal())
  await settle(() => host.agentOf('ga').calls.length === 2)
  host.begin('ga')
  host.finish('ga', 'waiting')
  await one.wait()
  const two = host.round('c3', host.takeGoal())
  await settle(() => host.agentOf('ga').calls.length === 3)
  host.begin('ga')
  host.finish('ga', 'still waiting')
  await two.wait()
  assert.equal(goal(host).idle, undefined)
  assert.ok(goal(host).ownerReviewAt > Date.now())
  // The admin's own post calling a member is new progress and resets the burst.
  await host.tool('post_to_group', { group: 'Ops', message: '@Writer write the draft' }, 'a')
  const third = host.round('c4', host.takePost())
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  host.finish('gb', 'on it')
  await third.wait()
  assert.equal(goal(host).idle, undefined)
})

test('a refused revise changes nothing; the stage cap counts kept stages', async (t) => {
  const host = await start(t)
  await startGoal(host)
  const before = goal(host)
  const refused = await host.tool('group_goal', {
    action: 'revise',
    title: 'New title',
    reason: 'r',
    stages: [{ title: 'S', acceptance: 'x', tasks: [{ bot: 'Nobody', task: 't' }] }],
  }, 'ga')
  assert.equal(refused, 'Nobody is not a member of "Ops". Members: Chief, Writer, Tester.')
  assert.deepEqual(goal(host), before)
  // A goal near the cap keeps its passed stages: revising past 20 is refused whole.
  const many = count => Array.from({ length: count }, (_, i) => ({ title: `S${i + 1}`, acceptance: 'x', tasks: [{ bot: 'Writer', task: `t${i}` }] }))
  await host.tool('group_goal', { action: 'revise', reason: 'grow', stages: many(19) }, 'ga')
  for (let i = 0; i < 19; i++) {
    await host.tool('group_goal', { action: 'task', bot: 'Writer', status: 'reported', note: `Report ${i + 1}` }, 'ga')
    await host.tool('group_goal', { action: 'pass', evidence: `evidence ${i + 1}` }, 'ga')
  }
  assert.equal(goal(host).current, 19)
  const over = await host.tool('group_goal', { action: 'revise', reason: 'more', stages: many(3) }, 'ga')
  assert.equal(over, 'At most 20 stages.')
  assert.equal(goal(host).stages.length, 19)
})

test('a draft queued with another post still calls the admin on its note', async (t) => {
  const host = await start(t)
  await host.call('goal-draft', { roomId: 'r1', text: 'Build the site' })
  const draft = host.takeGoal()
  // The draft lands first; the user's own message, queued second, opens the round.
  host.emit('r1', 'user/message', { content: draft.content, source: draft.source })
  const result = host.round('c1', host.say('@Tester look at this'))
  await settle(() => host.agentOf('gc').calls.length === 1)
  await settle(() => host.agentOf('ga').calls.length === 1)
  assert.match(text(host.agentOf('ga').calls[0]), /the user wants to set a goal for this group/)
  host.begin('ga')
  host.finish('ga', 'Aligning it.')
  host.begin('gc')
  host.finish('gc', '[PASS]')
  await result.wait()
  assert.ok(logLines(host).some(line => line.who === 'User' && line.text === 'Build the site'))
})

test('a room on its second part relays on the current Session and blocks /goal there', async (t) => {
  // The group's own Session moved on: r1 is an earlier part, r1p2 the current one.
  const blocked = []
  const goals = {
    get: agent => agent.session?.id === 'r1p2' ? { id: 'g-dsh', revision: 3, phase: 'active' } : undefined,
    block(agent, ref, reason) { blocked.push({ sessionId: agent.session?.id ?? agent.id, ref, reason }) },
  }
  const host = await start(t, { sessionId: 'r1p2', parts: [{ sessionId: 'r1', endedAt: 1 }] }, { goals })
  await startGoal(host)
  assert.equal((await host.call('goal-control', { roomId: 'r1', goalId: goal(host).id, action: 'pause' })).ok, true)
  await host.call('goal-control', { roomId: 'r1', goalId: goal(host).id, action: 'resume' })
  // The resume relay goes to the current part, never to the earlier one.
  await settle(() => host.agentOf('r1p2').calls.some(call => call.source?.role === 'goal'))
  assert.equal(host.agentOf('r1').calls.length, 0)
  // A DSH /goal in the current part reads as the room's and is blocked.
  host.emit('r1p2', 'goal/change', { goal: { phase: 'active' } })
  await settle(() => blocked.length === 1)
  assert.equal(blocked[0].sessionId, 'r1p2')
  assert.equal(blocked[0].reason.message, 'Bot chats do not run /goal. To give a group a goal, use Set a goal in its + menu.')
})

test('a member still working at round end wakes the admin when its work settles', async (t) => {
  const host = await start(t)
  await startGoal(host)
  // Member c's group turn is still running when the round ends — no check is queued.
  host.emit('gc', 'turn/start', { turn: 1 })
  const first = host.round('c1', host.say('@Chief go'))
  await settle(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')
  host.finish('ga', 'on it')
  await first.wait()
  assert.equal(host.takeGoal(), undefined)
  // The round is fully gone before c's work ends; the settle check then queues one goal check.
  await settle(async () => (await host.call('room-progress', { roomId: 'r1' })).value?.length === 0)
  host.emit('gc', 'assistant/message', { message: { content: [{ type: 'text', text: 'done' }] } })
  host.emit('gc', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await settle(() => host.agentOf('r1').calls.some(call => call.source?.role === 'goal'))
  const nudge = host.takeGoal()
  assert.ok(nudge !== undefined)
  assert.match(text(nudge), /^\[Goal check\]$/)
  // A second settle with no new work queues nothing while a round is running.
  host.emit('gc', 'turn/start', { turn: 2 })
  host.emit('gc', 'turn/end', { turn: 2, reason: { kind: 'completed' } })
  await settle(async () => (await host.call('room-progress', { roomId: 'r1' })).value?.length === 0)
  const left = host.agentOf('r1').calls.filter(call => call.source?.role === 'goal')
  assert.ok(left.length <= 1, `settles queued ${left.length} extra checks`)
  assert.equal(host.takeGoal(), undefined)
})

test('repeated turn settlements without member progress respect the immediate check budget (#1330)', async (t) => {
  const host = await start(t)
  await startGoal(host)
  const nudges = () => host.agentOf('r1').calls.filter(call => call.source?.role === 'goal' && call.source.goal === 'nudge')
  const settled = []
  const orig = host.rt.goalSettled
  host.rt.goalSettled = (...args) => {
    const pending = orig(...args)
    settled.push(pending)
    return pending
  }

  for (let turn = 1; turn <= 6; turn += 1) {
    host.emit('ga', 'turn/start', { turn })
    host.emit('ga', 'assistant/message', { message: { content: [{ type: 'text', text: '[PASS]' }] } })
    host.emit('ga', 'turn/end', { turn, reason: { kind: 'completed' } })
    assert.equal(settled.length, 1)
    await Promise.all(settled.splice(0))
  }

  assert.equal(nudges().length, 2, 'PASS-only settlements must stop after 2 goal checks')
  assert.equal(goal(host).nudges, 2)
  assert.equal(goal(host).status, 'active')
  assert.equal(goal(host).idle, undefined)
  assert.ok(goal(host).ownerReviewAt > Date.now())
})

test('concurrent and admin-interleaved goalSettled calls back off at the immediate check limit (#1330)', async (t) => {
  const host = await start(t)
  await startGoal(host)
  const room = host.rt.roomOf('r1')
  const nudges = () => host.agentOf('r1').calls.filter(call => call.source?.role === 'goal' && call.source.goal === 'nudge')

  await Promise.all(Array.from({ length: 6 }, () => host.rt.goalSettled(room)))
  assert.equal(nudges().length, 2)
  assert.equal(goal(host).nudges, 2)
  assert.equal(goal(host).idle, undefined)
  assert.ok(goal(host).ownerReviewAt > Date.now())

  // User message resets the burst, then admin-only rounds + settlements stop at 2 more checks.
  host.rt.goalUserMessage('r1')
  for (let i = 0; i < 6; i += 1) {
    await host.rt.goalDrive(room, { stoppedOnly: false, slots: [{ id: 'a', status: 'posted', worked: true }] })
    await host.rt.goalSettled(room)
  }
  assert.equal(nudges().length, 4)
  assert.equal(goal(host).nudges, 2)
  assert.equal(goal(host).idle, undefined)
  assert.ok(goal(host).ownerReviewAt > Date.now())

  // Real non-admin member work in a round still resets the check budget once idle is cleared.
  host.rt.goalUserMessage('r1')
  room.goal.nudges = 2
  await host.rt.goalDrive(room, { stoppedOnly: false, slots: [{ id: 'b', status: 'posted', worked: true }] })
  assert.equal(nudges().length, 5)
  assert.equal(goal(host).nudges, 1)
  assert.notEqual(goal(host).idle, true)

  // A late task report clears idle and lets a subsequent settlement queue one check.
  room.goal.nudges = 2
  room.goal.idle = true
  room.goal.idleReason = 'nudge-limit'
  room.goal.idleRevision = room.goal.revision
  room.goal.stages[0].tasks[0].status = 'working'
  host.rt.goalTaskReported('r1', 'b')
  await host.rt.save({ required: true })
  await host.rt.goalSettled(room)
  assert.equal(nudges().length, 6, 'reported member progress wakes one further goal check')
  assert.equal(goal(host).stages[0].tasks[0].status, 'reported')
  assert.equal(goal(host).nudges, 1)
  assert.equal(goal(host).idle, undefined)

  // Admin [PASS] on a goal-check round schedules a periodic review; later settlements do not wake it.
  await host.rt.goalDrive(room, { goalNudge: true, stoppedOnly: false, slots: [{ id: 'a', status: 'passed' }] })
  for (let i = 0; i < 4; i += 1) await host.rt.goalSettled(room)
  assert.equal(nudges().length, 6)
  assert.equal(goal(host).idle, undefined)
  assert.ok(goal(host).ownerReviewAt > Date.now())
})

test('fallback polling waits thirty minutes and skips paused room schedules', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const host = await start(t)
  await startGoal(host)
  const room = host.rt.state.rooms.r1
  delete room.goal.reviewAt
  delete room.goal.ownerReviewAt
  const resolves = t.mock.method(host.rt, 'resolveAgent', async () => undefined)
  const tick = async () => {
    t.mock.timers.tick(5 * 60_000)
    await new Promise(resolve => setImmediate(resolve))
  }
  room.scheduledReviewOccurrence = { at: Date.now() - 29 * 60_000 }
  await tick()
  assert.equal(resolves.mock.callCount(), 0)
  room.scheduledReviewOccurrence.at = Date.now() - 31 * 60_000
  host.rt.state.roomSchedules = { r1: { paused: true } }
  await tick()
  assert.equal(resolves.mock.callCount(), 0)
  host.rt.state.roomSchedules.r1.paused = false
  await tick()
  assert.equal(resolves.mock.callCount(), 1)
})

test('fallback polling never forces a room review past an in-flight member', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const host = await start(t)
  await startGoal(host)
  const room = host.rt.roomOf('r1')
  const active = () => host.agentOf('r1').calls.filter(call => call.source?.goal === 'nudge').length
  const busy = t.mock.method(host.rt, 'roomBusyForPatrol')
  room.goal.ownerReviewAt = 0
  host.rt.live.set('gb', { turn: 1 })
  for (let i = 0; i < 3; i += 1) {
    // A prior sweep can only try again after its full waiting interval.
    if (room.scheduledReviewOccurrence) room.scheduledReviewOccurrence.at = Date.now() - 31 * 60_000
    const before = busy.mock.callCount()
    t.mock.timers.tick(5 * 60_000)
    await settleTimer(() => busy.mock.callCount() > before)
    await host.rt.save({ required: true })
    await new Promise(resolve => setImmediate(resolve))
  }
  assert.equal(active(), 0)
  assert.equal(room.goal.reviewAttempt, undefined)
  assert.equal(room.scheduledReviewOccurrence, undefined, 'busy sweeps do not delay the next quiet opportunity')

  host.rt.live.delete('gb')
  t.mock.timers.tick(5 * 60_000)
  await settleTimer(() => active() === 1)
  assert.equal(room.scheduledReviewOccurrence.outcome, 'admitted')
})

test('fallback polling resumes the original native check after the short busy retries expire', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const host = await start(t)
  await startGoal(host)
  const room = host.rt.roomOf('r1')
  const agent = host.agentOf('r1')
  const scheduledAt = Date.now() - 7 * 60_000
  const key = JSON.stringify(['managed', new Date(scheduledAt).toISOString()])
  room.goal.ownerReviewAt = 0
  host.rt.state.roomSchedules = { r1: { id: 'managed' } }
  t.mock.method(host.rt, 'readRoomSchedule', async (id, sessionId) => ({
    scheduleId: id, sessionId, roomId: room.id, adminId: room.admin, instructions: 'Review this group board.',
  }))
  host.rt.live.set('gb', { turn: 1 })
  assert.equal(await host.rt.runScheduledRoomReview(room, key, agent), 'busy')
  assert.equal(room.scheduledReviewOccurrence.busyReason, 'running')
  const tick = async () => {
    t.mock.timers.tick(5 * 60_000)
    await new Promise(resolve => setImmediate(resolve))
  }
  const admitted = () => agent.calls.filter(call => call.source?.goal === 'nudge')
  await tick()
  assert.equal(admitted().length, 0)
  assert.equal(room.scheduledReviewOccurrence.outcome, 'busy')
  host.rt.live.delete('gb')
  await tick()
  await settleTimer(() => admitted().length === 1)
  assert.equal(room.scheduledReviewOccurrence.key, key)
  assert.equal(room.scheduledReviewOccurrence.at, scheduledAt)
  assert.equal(room.scheduledReviewOccurrence.outcome, 'admitted')
  assert.equal(room.goal.reviewAttempt.scheduledPrompt, 'Review this group board.')
  await tick()
  assert.equal(admitted().length, 1)
})

test('fallback polling preserves uncertain native checks without sending a replacement', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const host = await start(t)
  await startGoal(host)
  const room = host.rt.roomOf('r1')
  const scheduledAt = Date.now() - 31 * 60_000
  const key = JSON.stringify(['managed', new Date(scheduledAt).toISOString()])
  room.goal.ownerReviewAt = 0
  host.rt.state.roomSchedules = { r1: { id: 'managed' } }
  room.scheduledReviewOccurrence = { key, at: scheduledAt, goalId: room.goal.id, outcome: 'uncertain' }
  await host.rt.save({ required: true })
  const lookup = t.mock.method(host.rt, 'readRoomSchedule', async (id, sessionId) => ({
    scheduleId: id, sessionId, roomId: room.id, adminId: room.admin, instructions: 'Review this group board.',
  }))
  t.mock.timers.tick(5 * 60_000)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(lookup.mock.callCount(), 0)
  assert.equal(room.scheduledReviewOccurrence.key, key)
  assert.equal(room.scheduledReviewOccurrence.outcome, 'uncertain')
  assert.equal(host.takeGoal(), undefined)
})

test('fallback polling stops a native retry if the schedule is paused while resolving its session', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const host = await start(t)
  await startGoal(host)
  const room = host.rt.roomOf('r1')
  const scheduledAt = Date.now() - 7 * 60_000
  const key = JSON.stringify(['managed', new Date(scheduledAt).toISOString()])
  room.goal.ownerReviewAt = 0
  host.rt.state.roomSchedules = { r1: { id: 'managed' } }
  room.scheduledReviewOccurrence = { key, at: scheduledAt, goalId: room.goal.id, outcome: 'pending' }
  await host.rt.save({ required: true })
  t.mock.method(host.rt, 'readRoomSchedule', async (id, sessionId) => ({
    scheduleId: id, sessionId, roomId: room.id, adminId: room.admin, instructions: 'Review this group board.',
  }))
  const resolve = t.mock.method(host.rt, 'resolveAgent', async () => {
    host.rt.state.roomSchedules.r1.paused = true
    return host.agentOf('r1')
  })
  t.mock.timers.tick(5 * 60_000)
  await settleTimer(() => resolve.mock.callCount() === 1)
  await new Promise(continueTest => setImmediate(continueTest))
  assert.equal(room.scheduledReviewOccurrence.key, key)
  assert.equal(room.scheduledReviewOccurrence.outcome, 'pending')
  assert.equal(room.goal.reviewAttempt, undefined)
  assert.equal(host.takeGoal(), undefined)
})

test('sweepScheduledReviews releases overdue admitting reviewAttempt even while other members work', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const staleAt = Date.now() - 60 * 60 * 1000
  const host = await start(t, {
    scheduledReviewOccurrence: { key: JSON.stringify(['sweep-r1', new Date(Date.now() - 2 * 60 * 1000).toISOString()]), at: Date.now() - 2 * 60 * 1000, outcome: 'busy' },
    goal: {
      id: 'g-stuck',
      revision: 1,
      status: 'active',
      title: 'Fix',
      objective: 'Verify',
      acceptance: 'Pass',
      constraints: [],
      stages: [{ id: 's1', title: 'S1', acceptance: 'A', tasks: [{ id: 't1', botId: 'b', task: 'Do work', status: 'working' }], reworks: 0, status: 'active' }],
      current: 0,
      nudges: 0,
      events: [],
      reviewAttempt: { id: 'stuck-rev-1', at: staleAt, state: 'admitting', adminId: 'a', rootSessionId: 'r1', adminSessionId: 'ga' },
    },
  })
  // Simulate another member currently working in the room (not running stuck-rev-1).
  host.rt.live.set('gb', { turn: 1 })
  t.mock.timers.tick(5 * 60 * 1000)
  await settleTimer(() => host.rt.roomOf('r1').goal.reviewAttempt === undefined)
  assert.equal(host.rt.roomOf('r1').goal.reviewAttempt, undefined)
})

test('sweepScheduledReviews also settles overdue adminCompleted reviewAttempt after admin session rotation', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const staleAt = Date.now() - 60 * 60 * 1000
  const host = await start(t, {
    scheduledReviewOccurrence: { key: JSON.stringify(['sweep-r1', new Date(Date.now() - 2 * 60 * 1000).toISOString()]), at: Date.now() - 2 * 60 * 1000, outcome: 'busy' },
    goal: {
      id: 'g-rotated',
      revision: 1,
      status: 'active',
      title: 'Fix',
      objective: 'Verify',
      acceptance: 'Pass',
      constraints: [],
      stages: [{ id: 's1', title: 'S1', acceptance: 'A', tasks: [{ id: 't1', botId: 'b', task: 'Do work', status: 'working' }], reworks: 0, status: 'active' }],
      current: 0,
      nudges: 0,
      events: [],
      reviewAttempt: { id: 'stuck-rotated-1', at: staleAt, state: 'admitting', adminId: 'a', rootSessionId: 'r1', adminSessionId: 'ga-old-part', adminCompleted: true },
    },
  })
  host.rt.live.set('gb', { turn: 1 })
  t.mock.timers.tick(5 * 60 * 1000)
  await settleTimer(() => host.rt.roomOf('r1').goal.reviewAttempt === undefined)
  assert.equal(host.rt.roomOf('r1').goal.reviewAttempt, undefined)
})

test('standalone group_goal completion and stop report back to the primary Main Bot without self-echo (#1894)', async (t) => {
  const lab = { id: 'r2', name: 'Lab', members: ['b', 'c'], mode: 'admin', admin: 'b', named: true, sessions: { b: 'lb', c: 'lc' }, log: [], seq: 0, seen: {} }
  const host = await start(t, {}, undefined, { r2: lab })
  const oneStage = [{ title: 'Ship', acceptance: 'tests pass', tasks: [{ bot: 'Tester', task: 'verify' }] }]
  assert.match(await host.tool('group_goal', { action: 'start', title: 'Release', objective: 'Ship v1', acceptance: 'green', stages: oneStage }, 'lb'), /Started\./)
  await host.tool('group_goal', { ...bindGoal(host, 'r2'), action: 'task', bot: 'Tester', status: 'reported', note: 'ok' }, 'lb')
  await host.tool('group_goal', { ...bindGoal(host, 'r2'), action: 'pass', evidence: 'ok' }, 'lb')
  await host.tool('group_goal', { ...bindGoal(host, 'r2'), action: 'complete', evidence: 'npm test 100%', summary: 'v1 shipped cleanly' }, 'lb')
  await settle(() => host.agentOf('a').calls.length === 1)
  const doneMsg = text(host.agentOf('a').calls[0])
  assert.match(doneMsg, /^\[Group chat "Lab" · goal complete\]/)
  assert.match(doneMsg, /v1 shipped cleanly/)
  assert.match(doneMsg, /npm test 100%/)

  // Panel stop also notifies the primary Main Bot.
  await host.call('goal-control', { roomId: 'r2', goalId: host.rt.roomOf('r2').goal.id, action: 'clear' })
  await host.tool('group_goal', { ...bindGoal(host, 'r2'), action: 'start', title: 'Hotfix', objective: 'Fix crash', acceptance: 'no crash', stages: oneStage }, 'lb')
  assert.equal((await host.call('goal-control', { roomId: 'r2', goalId: host.rt.roomOf('r2').goal.id, action: 'stop' })).ok, true)
  await settle(() => host.agentOf('a').calls.length === 2)
  const stopMsg = text(host.agentOf('a').calls[1])
  assert.match(stopMsg, /^\[Group chat "Lab" · goal stopped\]/)
  assert.match(stopMsg, /Stopped by the user/)

  // Main Bot stopping the goal directly from its own chat does not echo back to itself.
  await host.call('goal-control', { roomId: 'r2', goalId: host.rt.roomOf('r2').goal.id, action: 'clear' })
  await host.tool('group_goal', { ...bindGoal(host, 'r2'), action: 'start', group: 'Lab', title: 'Own', objective: 'Check', acceptance: 'done', stages: oneStage }, 'a')
  await host.tool('group_goal', { ...bindGoal(host, 'r2'), action: 'stop', group: 'Lab', reason: 'not needed' }, 'a')
  for (let i = 0; i < 15; i += 1) await new Promise(resolve => setImmediate(resolve))
  assert.equal(host.agentOf('a').calls.length, 2, 'Main Bot calling stop from its own chat must not self-echo')
})

test('post_to_group waits until an active group_goal completes and reports once without duplicating (#1894)', async (t) => {
  const lab = { id: 'r2', name: 'Lab', members: ['b', 'c'], mode: 'admin', admin: 'b', named: true, sessions: { b: 'lb', c: 'lc' }, log: [], seq: 0, seen: {} }
  const host = await start(t, {}, undefined, { r2: lab })
  const oneStage = [{ title: 'Build', acceptance: 'green', tasks: [{ bot: 'Tester', task: 'run tests' }] }]
  await host.tool('post_to_group', { group: 'Lab', intent: 'request', message: '帮我达成发布目标' }, 'a')
  const post = host.agentOf('r2').calls.shift()
  const round1 = host.round('g1', { content: post.content, source: post.source }, 'r2')
  await settle(() => host.agentOf('lb').calls.length === 1)
  host.begin('lb')
  await host.tool('group_goal', { action: 'start', title: 'Ship v2', objective: 'Deliver v2', acceptance: 'all green', stages: oneStage }, 'lb')
  host.finish('lb', '@Tester 跑一下全量验证')
  await settle(() => host.agentOf('lc').calls.length === 1)
  host.begin('lc')
  host.finish('lc', '验证全绿！')
  // Round 1 ends with goal still active (admin has not passed/completed yet); goalDrive queues a goal check.
  await round1.wait()
  for (let i = 0; i < 15; i += 1) await new Promise(resolve => setImmediate(resolve))
  assert.equal(host.agentOf('a').calls.length, 0, 'Chief must not receive premature report while goal is still active')

  // Admin receives goal check, passes and completes the goal.
  await settle(() => host.agentOf('r2').calls.length === 1)
  const checkPost = host.agentOf('r2').calls.shift()
  const round2 = host.round('g2', { content: checkPost.content, source: checkPost.source }, 'r2')
  await settle(() => host.agentOf('lb').calls.length === 2)
  host.begin('lb')
  await host.tool('group_goal', { ...bindGoal(host, 'r2'), action: 'task', bot: 'Tester', status: 'reported', note: 'all tests green' }, 'lb')
  await host.tool('group_goal', { ...bindGoal(host, 'r2'), action: 'pass', evidence: 'all tests green' }, 'lb')
  await host.tool('group_goal', { ...bindGoal(host, 'r2'), action: 'complete', evidence: 'all tests green', summary: 'v2 released' }, 'lb')
  host.finish('lb', '目标已完成，v2 已发布。')
  await round2.wait()
  await settle(() => host.agentOf('a').calls.length === 1)
  for (let i = 0; i < 15; i += 1) await new Promise(resolve => setImmediate(resolve))
  assert.equal(host.agentOf('a').calls.length, 1, 'Chief must receive exactly one combined report, not a duplicate')
  const msg = text(host.agentOf('a').calls[0])
  assert.match(msg, /Goal "Ship v2" completed\./)
  assert.match(msg, /Summary: v2 released/)
  assert.match(msg, /Writer: 目标已完成，v2 已发布。/)
})

test('a scoped mid-round post_to_group by the primary Main Bot does not suppress standalone group_goal outcome alert (#1894)', async (t) => {
  const lab = { id: 'r2', name: 'Lab', members: ['b', 'c'], mode: 'admin', admin: 'b', named: true, sessions: { b: 'lb', c: 'lc' }, log: [], seq: 0, seen: {} }
  const host = await start(t, {}, undefined, { r2: lab })
  const oneStage = [{ title: 'Ship', acceptance: 'green', tasks: [{ bot: 'Tester', task: 'verify' }] }]
  assert.match(await host.tool('group_goal', { action: 'start', title: 'Scoped Goal', objective: 'Deliver', acceptance: 'green', stages: oneStage }, 'lb'), /Started\./)

  // Start a running round in Lab so Main Bot's post_to_group becomes a scoped mid-round report (ids: ['c']).
  const round = host.round('g1', host.say('@Writer 看一下', 'r2'), 'r2')
  await settle(() => host.agentOf('lb').calls.length === 1)
  host.begin('lb')
  await host.tool('post_to_group', { group: 'Lab', message: '@Tester 顺便查下版本号' }, 'a')
  const scopedReport = Object.values(host.rt.state.roomReports).find(r => r.roomId === 'r2')
  assert.deepEqual(scopedReport?.ids, ['c'])
  assert.equal(host.rt.hasRoomReportFor('r2', 'a'), false, 'scoped report must not suppress standalone goal alert')

  // Admin completes the goal while the scoped report is still active -> Main Bot still gets the goal complete alert!
  await host.tool('group_goal', { ...bindGoal(host, 'r2'), action: 'task', bot: 'Tester', status: 'reported', note: 'ok' }, 'lb')
  await host.tool('group_goal', { ...bindGoal(host, 'r2'), action: 'pass', evidence: 'ok' }, 'lb')
  await host.tool('group_goal', { ...bindGoal(host, 'r2'), action: 'complete', evidence: 'tests green', summary: 'Scoped Goal shipped' }, 'lb')
  await settle(() => host.agentOf('a').calls.some(call => text(call).includes('goal complete')))
  const goalAlert = host.agentOf('a').calls.find(call => text(call).includes('goal complete'))
  assert.match(text(goalAlert), /\[Group chat "Lab" · goal complete\]/)
  assert.match(text(goalAlert), /Scoped Goal shipped/)

  // Finishing the round then delivers the scoped report cleanly as well.
  await settle(() => host.agentOf('lc').calls.length === 1)
  host.begin('lc')
  host.finish('lc', '版本号是 1.2.3。')
  host.finish('lb', '目标完成。')
  await round.wait()
  await settle(() => host.agentOf('a').calls.some(call => text(call).includes('版本号是 1.2.3')))
})

test('a queued post_to_group by the primary Main Bot does not suppress standalone group_goal outcome alert (#1894)', async (t) => {
  const lab = { id: 'r2', name: 'Lab', members: ['b', 'c'], mode: 'admin', admin: 'b', named: true, sessions: { b: 'lb', c: 'lc' }, log: [], seq: 0, seen: {} }
  const host = await start(t, {}, undefined, { r2: lab })
  const oneStage = [{ title: 'Ship', acceptance: 'green', tasks: [{ bot: 'Tester', task: 'verify' }] }]
  assert.match(await host.tool('group_goal', { action: 'start', title: 'Queued Goal', objective: 'Deliver', acceptance: 'green', stages: oneStage }, 'lb'), /Started\./)

  // Main Bot queues a post_to_group (still status: 'queued', not yet tracking).
  await host.tool('post_to_group', { group: 'Lab', message: '@Tester 顺便看一下' }, 'a')
  const queued = Object.values(host.rt.state.roomReports).find(r => r.roomId === 'r2')
  assert.equal(queued?.status, 'queued')
  assert.equal(host.rt.hasRoomReportFor('r2', 'a'), false, 'queued report must not suppress standalone goal alert')

  // Stopping the goal via panel still sends the standalone goal stopped alert to Main Bot.
  assert.equal((await host.call('goal-control', { roomId: 'r2', goalId: host.rt.roomOf('r2').goal.id, action: 'stop' })).ok, true)
  await settle(() => host.agentOf('a').calls.some(call => text(call).includes('goal stopped')))
  const stopAlert = host.agentOf('a').calls.find(call => text(call).includes('goal stopped'))
  assert.match(text(stopAlert), /\[Group chat "Lab" · goal stopped\]/)
})

test('post_to_group report still includes completed goal summary if user clears the goal into pastGoals before round end (#1894)', async (t) => {
  const lab = { id: 'r2', name: 'Lab', members: ['b', 'c'], mode: 'admin', admin: 'b', named: true, sessions: { b: 'lb', c: 'lc' }, log: [], seq: 0, seen: {} }
  const host = await start(t, {}, undefined, { r2: lab })
  const oneStage = [{ title: 'Ship', acceptance: 'green', tasks: [{ bot: 'Tester', task: 'verify' }] }]
  await host.tool('post_to_group', { group: 'Lab', intent: 'request', message: '完成发布目标并归档' }, 'a')
  const post = host.agentOf('r2').calls.shift()
  const round = host.round('g-clear', { content: post.content, source: post.source }, 'r2')
  await settle(() => host.agentOf('lb').calls.length === 1)
  host.begin('lb')
  await host.tool('group_goal', { action: 'start', title: 'Clear Race', objective: 'Deliver cleanly', acceptance: 'all green', stages: oneStage }, 'lb')
  await host.tool('group_goal', { ...bindGoal(host, 'r2'), action: 'task', bot: 'Tester', status: 'reported', note: 'ok' }, 'lb')
  await host.tool('group_goal', { ...bindGoal(host, 'r2'), action: 'pass', evidence: 'ok' }, 'lb')
  await host.tool('group_goal', { ...bindGoal(host, 'r2'), action: 'complete', evidence: 'npm test 100%', summary: 'archived before round end' }, 'lb')
  // User clears the completed goal banner while Writer's turn is still wrapping up.
  const goalId = host.rt.roomOf('r2').goal.id
  assert.equal((await host.call('goal-control', { roomId: 'r2', goalId, action: 'clear' })).ok, true)
  assert.equal(host.rt.roomOf('r2').goal, undefined)
  host.finish('lb', '[PASS]')
  await round.wait()
  await settle(() => host.agentOf('a').calls.length === 1)
  const msg = text(host.agentOf('a').calls[0])
  assert.match(msg, /Goal "Clear Race" completed\./)
  assert.match(msg, /Summary: archived before round end/)
  assert.match(msg, /Evidence: npm test 100%/)
  assert.doesNotMatch(msg, /Nobody replied/)

  // Negative check: an older goal in pastGoals (endedAt < report.at) must NOT be attached to a later post_to_group report.
  host.rt.roomOf('r2').pastGoals[0].endedAt = Date.now() - 10_000
  await host.tool('post_to_group', { group: 'Lab', message: '@Writer 简单问个问题' }, 'a')
  const post2 = host.agentOf('r2').calls.shift()
  const round2 = host.round('g-after-clear', { content: post2.content, source: post2.source }, 'r2')
  await settle(() => host.agentOf('lb').calls.length === 2)
  host.begin('lb')
  host.finish('lb', '好的，知道了。')
  await round2.wait()
  await settle(() => host.agentOf('a').calls.length === 2)
  const msg2 = text(host.agentOf('a').calls[1])
  assert.match(msg2, /Writer: 好的，知道了。/)
  assert.doesNotMatch(msg2, /Goal "Clear Race"/, 'past goal that ended before the new report must not be recycled')
})

test('removing a member annotates its open goal tasks, clearing or deleting the admin auto-pauses the active goal, and waiting roomReports settle', async (t) => {
  const lab = { id: 'r2', name: 'Lab', members: ['b', 'c'], mode: 'admin', admin: 'b', named: true, sessions: { b: 'lb', c: 'lc' }, log: [], seq: 0, seen: {} }
  const host = await start(t, {}, undefined, { r2: lab })
  host.rt.state.bots.d = { id: 'd', name: 'Reviewer', role: 'Review', sessionId: 'd', createdAt: 4 }
  host.rt.roomOf('r2').members.push('d')
  host.rt.roomOf('r2').sessions.d = 'ld'
  host.rt.groupOwners.set('ld', { botId: 'd', roomId: 'r2' })
  const stages = [{ title: 'Build', acceptance: 'green', tasks: [{ bot: 'Tester', task: 'run suite' }, { bot: 'Reviewer', task: 'review code' }] }]
  assert.match(await host.tool('group_goal', { action: 'start', title: 'Admin Guard', objective: 'Ship safely', acceptance: 'green', stages }, 'lb'), /Started\./)

  // Track a waiting post_to_group report on Lab so we verify it settles when admin disappears.
  host.rt.state.roomReports = {
    'rep-admin-gone': { id: 'rep-admin-gone', roomId: 'r2', botId: 'a', name: 'Chief', status: 'tracking', fromSeq: 1, passed: [], failed: [], at: Date.now() },
  }

  // 1) Removing Reviewer annotates its open task without pausing the goal.
  await host.rt.updateRoom('r2', { members: ['b', 'c'], admin: 'b' })
  const r2 = host.rt.roomOf('r2')
  assert.equal(r2.goal.status, 'active')
  const revTask = r2.goal.stages[0].tasks.find(item => item.botId === 'd')
  assert.match(revTask.note, /Member left the group/i)

  // 2) Clearing the admin auto-pauses the active goal with a notice and settles waiting roomReports.
  await host.rt.updateRoom('r2', { admin: null })
  assert.equal(r2.goal.status, 'paused')
  assert.ok(r2.log.some(line => line.reason === 'goal' && line.event === 'pause' && /no admin is assigned/i.test(line.text ?? '')))
  await settle(() => host.agentOf('a').calls.length === 1)
  assert.deepEqual(host.rt.state.roomReports ?? {}, {})

  // Both goal-control('resume') and group_goal(action: 'resume') refuse while room.admin === null.
  const panelRefused = await host.call('goal-control', { roomId: 'r2', goalId: r2.goal.id, action: 'resume' })
  assert.equal(panelRefused.ok, false)
  assert.match(panelRefused.error.message, /no admin/i)
  assert.equal(r2.goal.status, 'paused')
  const toolRefused = await host.tool('group_goal', { group: 'Lab', action: 'resume' }, 'a')
  assert.match(toolRefused, /has no admin/i)
  assert.equal(r2.goal.status, 'paused')

  // 3) Re-assign admin, resume goal, then delete the admin Bot -> auto-pauses with "admin was deleted".
  await host.rt.updateRoom('r2', { admin: 'b' })
  await host.tool('group_goal', { ...bindGoal(host, 'r2'), action: 'resume' }, 'lb')
  assert.equal(r2.goal.status, 'active')
  await host.rt.deleteBot('b')
  assert.equal(r2.goal.status, 'paused')
  assert.ok(r2.log.some(line => line.reason === 'goal' && line.event === 'pause' && /admin was deleted/i.test(line.text ?? '')))
})

test('startup settleRoomReports marks a dormant active goal idle instead of deadlocking waiting reports', async (t) => {
  const lab = { id: 'r2', name: 'Lab', members: ['b', 'c'], mode: 'admin', admin: 'b', named: true, sessions: { b: 'lb', c: 'lc' }, log: [], seq: 0, seen: {} }
  const host = await start(t, {}, undefined, { r2: lab })
  const stages = [{ title: 'Ship', acceptance: 'done', tasks: [{ bot: 'Tester', task: 'verify' }] }]
  assert.match(await host.tool('group_goal', { action: 'start', title: 'Dormant Goal', objective: 'Ship', acceptance: 'done', stages }, 'lb'), /Started\./)

  // Simulate post-restart state: goal is active & not idle, zero running rounds/members/batches/relays,
  // and a tracking roomReport waits for settlement.
  host.rt.state.roomReports = {
    'rep-dormant': { id: 'rep-dormant', roomId: 'r2', botId: 'a', name: 'Chief', status: 'tracking', fromSeq: 1, passed: [], failed: [], at: Date.now() },
  }
  await host.rt.settleRoomReports(undefined, { startup: true })
  assert.equal(host.rt.roomOf('r2').goal.idle, true, 'dormant active goal must be marked idle on startup')
  await settle(() => host.agentOf('a').calls.length === 1)
  assert.deepEqual(host.rt.state.roomReports ?? {}, {})
})

test('group_goal stop stops full room when called from outside target group, and stops other members/waiting slots/queues when called inside target group', async (t) => {
  // 1) Called by Main Bot from outside Ops -> stops the entire running round & queued relays.
  {
    const host = await start(t)
    await startGoal(host)
    const first = host.round('c-out', host.say('@Chief start'))
    await settle(() => host.agentOf('ga').calls.length === 1)
    host.begin('ga')
    host.emit('gb', 'turn/start', { turn: 1 })
    // Queue a pending post on r1 inbox to verify cancelRoomQueues withdraws it.
    host.agentOf('r1').inbox.nextTurn.push({
      id: 'queued-bot-post',
      source: { kind: 'bot', form: 'relay', role: 'post', exchangeId: 'ex-q1', roomId: 'r1' },
      content: [{ type: 'text', text: 'pending relay' }],
    })

    // Main Bot 'a' calls group_goal stop from its own chat ('a', NOT 'ga').
    const out = await host.tool('group_goal', { ...bindGoal(host, 'r1'), group: 'Ops', action: 'stop', reason: 'cancelled by main' }, 'a')
    assert.match(out, /Stopped\./)
    assert.equal(goal(host).status, 'stopped')
    assert.ok(host.agentOf('ga').cancelled.length >= 1, 'outside stop must cancel active in-group round speaker too')
    assert.ok(host.agentOf('gb').cancelled.length >= 1)
    assert.equal(host.agentOf('r1').inbox.nextTurn.some(m => m.id === 'queued-bot-post'), false, 'outside stop must withdraw pending bot relays')
    host.emit('ga', 'turn/end', { turn: 1, reason: { kind: 'aborted' } })
    await first.wait()
  }

  // 2) Called by Admin inside Ops -> cancels waiting slots, other members, and queued relays, while leaving Admin running.
  {
    const host = await start(t)
    await startGoal(host)
    // Open an ordered round where Chief speaks first and Writer/Tester sit in waiting slots.
    const first = host.round('c-in', host.say('everyone check in'))
    await settle(() => host.agentOf('ga').calls.length === 1)
    host.begin('ga')
    host.emit('gc', 'turn/start', { turn: 1 })
    host.agentOf('r1').inbox.nextTurn.push({
      id: 'queued-goal-nudge',
      source: { kind: 'bot', form: 'relay', role: 'goal', goal: 'nudge', exchangeId: 'ex-q2', roomId: 'r1' },
      content: [{ type: 'text', text: '[Goal check]' }],
    })

    const out = await host.tool('group_goal', { ...bindGoal(host, 'r1'), action: 'stop', reason: 'stopping from inside' }, 'ga')
    assert.match(out, /Stopped\./)
    assert.equal(host.agentOf('ga').cancelled.length, 0, 'in-group stop must keep caller turn running')
    assert.equal(host.agentOf('gc').cancelled.length, 1, 'in-group stop must cancel other running member')
    assert.equal(host.agentOf('r1').inbox.nextTurn.some(m => m.id === 'queued-goal-nudge'), false, 'in-group stop must withdraw pending goal relays')
    host.finish('ga', 'Stopped the goal.')
    await first.wait()
    // Waiting slots for Writer/Tester must have been cancelled rather than started after Chief finished.
    assert.equal(host.agentOf('gb').calls.length, 0, 'waiting slot for Writer must be cancelled')
    assert.equal(host.agentOf('gc').calls.length, 0, 'waiting slot for Tester must be cancelled')
  }
})

test('goalDrive marks goal idle and settles waiting roomReports when queueGoalRelay fails', async (t) => {
  const lab = { id: 'r2', name: 'Lab', members: ['b', 'c'], mode: 'admin', admin: 'b', named: true, sessions: { b: 'lb', c: 'lc' }, log: [], seq: 0, seen: {} }
  const host = await start(t, {}, undefined, { r2: lab })
  const stages = [{ title: 'Ship', acceptance: 'done', tasks: [{ bot: 'Tester', task: 'verify' }] }]
  assert.match(await host.tool('group_goal', { action: 'start', title: 'Relay Fail', objective: 'Ship', acceptance: 'done', stages }, 'lb'), /Started\./)

  host.rt.state.roomReports = {
    'rep-fail-relay': { id: 'rep-fail-relay', roomId: 'r2', botId: 'a', name: 'Chief', status: 'tracking', fromSeq: 1, passed: [], failed: [], at: Date.now() },
  }
  const origFlush = host.ctx.sessions.flush
  host.ctx.sessions.flush = async (session) => {
    if (session?.id === 'r2') throw new Error('session flush failed')
    return origFlush(session)
  }

  await host.rt.goalDrive(host.rt.roomOf('r2'), { stoppedOnly: false, slots: [{ id: 'b', worked: false }] })
  assert.equal(host.rt.roomOf('r2').goal.idle, true, 'failed goal check relay must mark goal idle instead of stranding reports')
  await settle(() => host.agentOf('a').calls.length === 1)
  assert.deepEqual(host.rt.state.roomReports ?? {}, {})
})

test('group_goal task supports task_id disambiguation and ledgerLines shows task ids only for duplicate-member tasks', async (t) => {
  const host = await start(t)
  const stages = [{
    title: 'Multi',
    acceptance: 'both done',
    tasks: [
      { bot: 'Writer', task: 'write part A' },
      { bot: 'Writer', task: 'write part B' },
      { bot: 'Tester', task: 'verify all' },
    ],
  }]
  const started = await host.tool('group_goal', { action: 'start', title: 'Disambiguate', objective: 'Two tasks for Writer', acceptance: 'both done', stages }, 'ga')
  const [t1, t2, t3] = goal(host).stages[0].tasks
  assert.match(started, new RegExp(`- Writer \\(${t1.id}\\): write part A`))
  assert.match(started, new RegExp(`- Writer \\(${t2.id}\\): write part B`))
  assert.match(started, /- Tester: verify all \[not started\]/, 'single-task member omits task id tag')

  // Updating task 2 by task_id leaves task 1 untouched.
  const updated = await host.tool('group_goal', { ...bindGoal(host, 'r1'), action: 'task', task_id: t2.id, status: 'done', note: 'part B complete' }, 'ga')
  assert.match(updated, new RegExp(`- Writer \\(${t2.id}\\): write part B \\[done\\] — .*part B complete`))
  assert.equal(goal(host).stages[0].tasks[0].status, 'pending')
  assert.equal(goal(host).stages[0].tasks[1].status, 'done')

  // Passing wrong bot with task_id is refused.
  const mismatch = await host.tool('group_goal', { ...bindGoal(host, 'r1'), action: 'task', task_id: t2.id, bot: 'Tester', status: 'working' }, 'ga')
  assert.match(mismatch, /does not belong to Tester/)
  assert.equal(t3.status, 'pending')
})

test('group_goal pass clears idleEdges and zeroWorkRelays so calling the same member in stage 2 does not false-pause', async (t) => {
  const host = await start(t)
  const stages = [
    { title: 'Stage 1', acceptance: 'draft done', tasks: [{ bot: 'Writer', task: 'draft' }] },
    { title: 'Stage 2', acceptance: 'final done', tasks: [{ bot: 'Writer', task: 'polish' }] },
  ]
  await startGoal(host, { stages })
  const r1 = host.rt.roomOf('r1')
  // Simulate stage 1 zero-work handoff edges (Chief -> Writer -> Chief).
  r1.idleEdges = ['a->b', 'b->a']
  r1.zeroWorkRelays = 3

  // Passing stage 1 is real goal progression and must clear idleEdges and zeroWorkRelays.
  await host.tool('group_goal', { ...bindGoal(host, 'r1'), action: 'task', bot: 'Writer', status: 'reported', note: 'stage 1 verified' }, 'ga')
  await host.tool('group_goal', { ...bindGoal(host, 'r1'), action: 'pass', evidence: 'stage 1 verified' }, 'ga')
  assert.equal(r1.idleEdges, undefined)
  assert.equal(r1.zeroWorkRelays, undefined)
})
