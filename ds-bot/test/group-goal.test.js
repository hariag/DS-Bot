import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, rmSync, truncateSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { afterRound } from './relay-rows.js'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'
import { ROOM_WORK_GRACE_MS } from '../src/host/constants.js'
import { GOAL_REVIEW_INTERVAL_MS } from '../src/host/goals.js'
import { inspectionMessageHash } from '../src/host/inspection-terminal.mjs'
import { mentionsIn } from '../src/host/groups.js'
import { privateTempDir } from './private-temp.mjs'

const passiveScheduleNotice = {
  source:{ kind:'schedule' },
  content:[{ type:'text', text:'[SCHEDULE CHANGE]\nThis notice is not a delivery of the task and needs no action.\nschedule_id_json: "schedule-retired"' }],
}

const cleanupByTest = new WeakMap()

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

async function start(t, room, services, extraRooms, existingHome) {
  const home = existingHome ?? privateTempDir(join(tmpdir(), 'ds-bot-goal-'))
  if (existingHome === undefined) writeFileSync(join(home, 'state.json'), JSON.stringify(seed(room, extraRooms)))
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
  let homes = cleanupByTest.get(t)
  if (!homes) { homes = new Map(); cleanupByTest.set(t, homes) }
  let disposers = homes.get(home)
  if (!disposers) {
    disposers = []; homes.set(home, disposers)
    t.after(async () => {
      for (const dispose of disposers.reverse()) await dispose()
      rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    })
  }
  disposers.push(() => ctx.dispose())
  let seq = 0
  const turns = new Map()
  const emit = (id, type, data) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) {
      if (listener.length >= 2) listener({ id }, { type, seq: ++seq, data })
    }
  }
  const rawTool = (name, args, sessionId, exec = {}) => (rt.teamTools.find(d => d.name === name) ?? ctx.registeredTools.get(name)).execute(args, { agent: { id: sessionId }, ...exec })
  // Normal goal callers copy the version displayed in their prompt or ledger.
  // Use rawTool to exercise stale versions, omitted fields and legacy callers.
  const tool = (name, args, sessionId, exec) => {
    if (name !== 'group_goal' || args.action === 'show') return rawTool(name, args, sessionId, exec)
    const target = args.room_id || args.group
    const room = target ? rt.findRooms(target)[0] : rt.roomOf(rt.groupOwners.get(sessionId)?.roomId)
    return rawTool(name, { goal_id: room?.goal?.id ?? 'none', expected_revision: room?.goal?.revision ?? 0, ...args }, sessionId, exec)
  }
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
  const round = (callId, message) => {
    emit('r1', 'user/message', message)
    let result
    const stop = new AbortController()
    t.after(() => stop.abort())
    void tool('group_relay', {}, 'r1', { callId, signal: stop.signal }).then(async (value) => { result = await afterRound(rt, 'r1', value) })
    const read = () => result
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
  // Model an actual native schedule occurrence in this single-room fixture.
  rt.testScheduleOccurrence = async (at, roomId = 'r1') => {
    const room = rt.roomOf(roomId)
    at ??= Math.max(Date.now(), (room.scheduledReviewOccurrence?.at ?? 0) + GOAL_REVIEW_INTERVAL_MS)
    const agent = await rt.resolveAgent(rt.sessionOfRoom(room))
    return rt.runScheduledRoomReview(room, JSON.stringify(['group-schedule', new Date(at).toISOString()]), agent)
  }
  await tool('list_bots', {}, 'a')
  return { home, ctx, rt, agentOf, emit, tool, rawTool, call, begin, finish, round, say, takePost, takeGoal }
}

const settle = async (check) => {
  const until = Date.now() + 3000
  while (!check() && Date.now() < until) await new Promise(resolve => setImmediate(resolve))
  assert.ok(check(), 'condition not reached')
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

async function parkForReview(host, stages = STAGES) {
  await startGoal(host, { stages })
  await host.rt.goalDrive(host.rt.roomOf('r1'), { goalNudge: true, slots: [{ id: 'a', status: 'passed' }] })
  return host.rt.roomOf('r1').goal
}

const reviewArgs = task => ({
  action: 'review-check', review_task: task.id,
  review_fingerprint: createHash('sha256').update(JSON.stringify(task)).digest('hex'),
  review_assignment: 'received: handoff A', review_progress: 'working from evidence A',
  review_dependencies: 'none found in evidence A', review_next: 'owner continues A',
  review_deadline: 'next check in 30 minutes', evidence: 'event A at version X', review_complete: true,
})

test('an owner check with unknown evidence cannot be marked complete', async (t) => {
  const host = await start(t)
  await startGoal(host)
  const g = host.rt.roomOf('r1').goal
  await host.rt.testScheduleOccurrence(g.ownerReviewAt)
  const post = host.takeGoal()
  host.agentOf('r1').inbox.nextTurn.length = 0
  const read = host.round('owner-unknown', post)
  await settle(() => host.agentOf('ga').calls.length > 0)
  host.begin('ga')
  const task = g.stages[0].tasks[0]
  assert.match(await host.tool('group_goal', { ...reviewArgs(task), review_progress: '未知，待核' }, 'ga'), /review_complete false/)
  assert.equal(g.ownerReview?.checks?.[task.id], undefined)
  host.finish('ga', '[PASS]')
  await settle(() => read() !== undefined)
})

test('a late bot post does not call a stopped group member', async (t) => {
  const host = await start(t)
  await startGoal(host)
  await host.rt.goalUserStopped('r1')
  await host.rt.lateRoomReply('ga', { role: 'room', roomId: 'r1' }, '@Writer continue')
  const post = host.takePost()
  const read = host.round('late-stopped', post)
  await settle(() => read() !== undefined)
  assert.equal(host.agentOf('gb').calls.length, 0)
})

test('an independent user request is held visibly if its relation to a stopped goal cannot be proven', async (t) => {
  const host = await start(t)
  await startGoal(host)
  await host.rt.goalUserStopped('r1')
  const notices = []
  host.rt.noteFailure = note => notices.push(note)
  const read = host.round('independent-unknown', host.say('New independent task: ask Writer to investigate'))
  await settle(() => host.agentOf('ga').calls.length > 0)
  host.begin('ga')
  host.finish('ga', '@Writer investigate the new task')
  await settle(() => read() !== undefined)
  assert.equal(host.agentOf('gb').calls.length, 0)
  assert.ok(notices.some(note => note.code === 'GROUP_WORK_HELD' && /No group work was sent/.test(note.text)))
})

test('a stopped group post cannot dispatch after target resolution is delayed', async (t) => {
  const host = await start(t)
  await startGoal(host)
  let release, entered
  const gate = new Promise(resolve => { release = resolve })
  const waiting = new Promise(resolve => { entered = resolve })
  const original = host.ctx.sessionController.resolveAgent
  host.ctx.sessionController.resolveAgent = async id => { if (id === 'gb') { entered(); await gate }; return original(id) }
  await host.rt.lateRoomReply('ga', { role: 'room', roomId: 'r1' }, '@Writer continue')
  const post = host.takePost()
  const read = host.round('late-stop-race', post)
  await waiting
  await host.rt.goalUserStopped('r1')
  release()
  await settle(() => read() !== undefined)
  assert.equal(host.agentOf('gb').calls.length, 0)
})

test('incomplete owner review continues and a status change invalidates its record', async (t) => {
  const host = await start(t)
  await startGoal(host, { stages: [{ title: 'Draft', acceptance: 'reviewed', tasks: [{ bot: 'Writer', task: 'write' }, { bot: 'Tester', task: 'test' }] }] })
  const g = host.rt.roomOf('r1').goal
  await host.rt.testScheduleOccurrence(g.ownerReviewAt)
  const post = host.takeGoal()
  host.agentOf('r1').inbox.nextTurn.length = 0
  const read = host.round('partial-owner-review', post)
  await settle(() => host.agentOf('ga').calls.length > 0)
  host.begin('ga')
  const [writer, tester] = g.stages[0].tasks
  assert.match(await host.tool('group_goal', reviewArgs(writer), 'ga'), /1 current task/)
  assert.equal(saved(host).rooms.r1.goal.ownerReview.checks[writer.id].owner, writer.botId)
  host.finish('ga', '[PASS]')
  await settle(() => read() !== undefined)
  assert.ok(g.ownerReview.checks[writer.id])
  assert.equal(g.ownerReview.checks[tester.id], undefined)
  assert.equal(g.reviewAt - g.updatedAt, GOAL_REVIEW_INTERVAL_MS)
  await host.tool('group_goal', { action: 'task', bot: 'Writer', status: 'working' }, 'ga')
  assert.equal(g.ownerReview.checks[writer.id].fingerprint === reviewArgs(writer).review_fingerprint, false)
})

test('stop while request receipt saves refuses group dispatch', async (t) => {
  const host = await start(t)
  await startGoal(host)
  const read = host.round('stop-race-owner', host.say('@Chief check status'))
  await settle(() => host.agentOf('ga').calls.length > 0)
  host.begin('ga')
  const original = host.rt.save
  let entered, release
  const ready = new Promise(resolve => { entered = resolve })
  const gate = new Promise(resolve => { release = resolve })
  let held = false
  host.rt.save = async (...args) => {
    if (args[0]?.required && !held) { held = true; entered(); await gate }
    return original(...args)
  }
  const send = host.tool('message_bot', { to: 'Writer', message: 'status?', request_id: 'stop-race' }, 'ga')
  await ready
  await host.rt.goalUserStopped('r1')
  release()
  assert.match(await send, /Not sent/)
  assert.equal(host.agentOf('gb').calls.length, 0)
  host.finish('ga', '[PASS]')
  await settle(() => read() !== undefined)
})

test('a stop racing with group dispatch leaves the original request uncertain', async (t) => {
  const host = await start(t)
  await startGoal(host)
  const read = host.round('stop-after-dispatch', host.say('@Chief check status'))
  await settle(() => host.agentOf('ga').calls.length > 0)
  host.begin('ga')
  const original = host.rt.roomStepText
  let entered, release
  const ready = new Promise(resolve => { entered = resolve })
  const gate = new Promise(resolve => { release = resolve })
  host.rt.roomStepText = async (...args) => {
    const result = await original(...args)
    entered()
    await gate
    return result
  }
  const request = { to: 'Writer', message: 'status?', request_id: 'stop-after-dispatch' }
  const send = host.tool('message_bot', request, 'ga')
  await ready
  await host.rt.goalUserStopped('r1')
  release()
  await assert.rejects(send, /Group state changed during dispatch/)
  await assert.rejects(host.tool('message_bot', request, 'ga'), /outcome.*not known/i)
  host.finish('ga', '[PASS]')
  await settle(() => read() !== undefined)
})

test('a replaced group cannot receive a request admitted for the old group', async (t) => {
  const host = await start(t)
  await startGoal(host)
  const read = host.round('replaced-room-request', host.say('@Chief check status'))
  await settle(() => host.agentOf('ga').calls.length > 0)
  host.begin('ga')
  const original = host.rt.save
  let entered, release
  const ready = new Promise(resolve => { entered = resolve })
  const gate = new Promise(resolve => { release = resolve })
  let held = false
  host.rt.save = async (...args) => {
    if (args[0]?.required && !held) { held = true; entered(); await gate }
    return original(...args)
  }
  const send = host.tool('message_bot', { to: 'Writer', message: 'status?', request_id: 'old-room-request' }, 'ga')
  await ready
  host.rt.state.rooms.r1 = { ...host.rt.state.rooms.r1 }
  release()
  assert.match(await send, /Not sent/)
  assert.equal(host.agentOf('gb').calls.length, 0)
  host.finish('ga', '[PASS]')
  await settle(() => read() !== undefined)
})

test('a removed member cannot receive a request admitted before removal', async (t) => {
  const host = await start(t)
  await startGoal(host)
  const read = host.round('removed-member-request', host.say('@Chief check status'))
  await settle(() => host.agentOf('ga').calls.length > 0)
  host.begin('ga')
  const original = host.rt.save
  let entered, release
  const ready = new Promise(resolve => { entered = resolve })
  const gate = new Promise(resolve => { release = resolve })
  let held = false
  host.rt.save = async (...args) => {
    if (args[0]?.required && !held) { held = true; entered(); await gate }
    return original(...args)
  }
  const send = host.tool('message_bot', { to: 'Writer', message: 'status?', request_id: 'removed-member-request' }, 'ga')
  await ready
  host.rt.roomOf('r1').members = host.rt.roomOf('r1').members.filter(id => id !== 'b')
  release()
  assert.match(await send, /Not sent/)
  assert.equal(host.agentOf('gb').calls.length, 0)
  host.finish('ga', '[PASS]')
  await settle(() => read() !== undefined)
})

test('a removed sender cannot dispatch a request admitted before removal', async (t) => {
  const host = await start(t)
  await startGoal(host)
  const read = host.round('removed-sender-request', host.say('@Chief check status'))
  await settle(() => host.agentOf('ga').calls.length > 0)
  host.begin('ga')
  const original = host.rt.save
  let entered, release
  const ready = new Promise(resolve => { entered = resolve })
  const gate = new Promise(resolve => { release = resolve })
  let held = false
  host.rt.save = async (...args) => {
    if (args[0]?.required && !held) { held = true; entered(); await gate }
    return original(...args)
  }
  const send = host.tool('message_bot', { to: 'Writer', message: 'status?', request_id: 'removed-sender-request' }, 'ga')
  await ready
  host.rt.roomOf('r1').members = host.rt.roomOf('r1').members.filter(id => id !== 'a')
  release()
  assert.match(await send, /Not sent/)
  assert.equal(host.agentOf('gb').calls.length, 0)
  host.finish('ga', '[PASS]')
  await settle(() => read() !== undefined)
})

test('a changed caller group cannot redirect a request after receipt persistence', async (t) => {
  const host = await start(t)
  await startGoal(host)
  const read = host.round('changed-caller-group', host.say('@Chief check status'))
  await settle(() => host.agentOf('ga').calls.length > 0)
  host.begin('ga')
  const original = host.rt.save
  let entered, release
  const ready = new Promise(resolve => { entered = resolve })
  const gate = new Promise(resolve => { release = resolve })
  let held = false
  host.rt.save = async (...args) => {
    if (args[0]?.required && !held) {
      held = true
      const result = await original(...args)
      entered()
      await gate
      return result
    }
    return original(...args)
  }
  const send = host.tool('message_bot', { to: 'Writer', message: 'status?', request_id: 'changed-caller-group' }, 'ga')
  await ready
  host.rt.groupOwners.set('ga', { botId: 'a', roomId: 'different-room' })
  release()
  assert.match(await send, /Not sent/)
  assert.equal(host.agentOf('gb').calls.length, 0)
  host.rt.groupOwners.set('ga', { botId: 'a', roomId: 'r1' })
  host.finish('ga', '[PASS]')
  await settle(() => read() !== undefined)
})

test('a group context lost during loading is not redirected to a private chat', async (t) => {
  const host = await start(t)
  await startGoal(host)
  const read = host.round('lost-caller-group', host.say('@Chief check status'))
  await settle(() => host.agentOf('ga').calls.length > 0)
  host.begin('ga')
  const original = host.rt.load
  let entered, release
  const ready = new Promise(resolve => { entered = resolve })
  const gate = new Promise(resolve => { release = resolve })
  host.rt.load = async () => { entered(); await gate; return original() }
  const send = host.tool('message_bot', { to: 'Writer', message: 'status?' }, 'ga')
  await ready
  host.rt.groupOwners.delete('ga')
  release()
  assert.match(await send, /Not sent/)
  assert.equal(host.agentOf('b').calls.length, 0)
  host.rt.groupOwners.set('ga', { botId: 'a', roomId: 'r1' })
  host.finish('ga', '[PASS]')
  await settle(() => read() !== undefined)
})

test('an unavailable group is not treated as a private chat', async (t) => {
  const host = await start(t)
  await startGoal(host)
  const read = host.round('missing-group-object', host.say('@Chief check status'))
  await settle(() => host.agentOf('ga').calls.length > 0)
  host.begin('ga')
  const original = host.rt.roomOf
  host.rt.roomOf = id => id === 'r1' ? undefined : original(id)
  const response = await host.tool('message_bot', { to: 'Writer', message: 'status?' }, 'ga')
  assert.match(response, /Not sent/)
  assert.equal(host.agentOf('b').calls.length, 0)
  host.rt.roomOf = original
  host.finish('ga', '[PASS]')
  await settle(() => read() !== undefined)
})

test('a review source remains fenced if its live metadata changes while looking up a request', async (t) => {
  const host = await start(t)
  await startGoal(host)
  const read = host.round('stale-review-source', host.say('@Chief check status'))
  await settle(() => host.agentOf('ga').calls.length > 0)
  host.begin('ga')
  const live = host.rt.live.get('ga')
  live.info = { ...live.info, reviewId: 'original-review' }
  let entered, release
  const ready = new Promise(resolve => { entered = resolve })
  const gate = new Promise(resolve => { release = resolve })
  host.rt.knownRequest = async () => { entered(); await gate; return undefined }
  host.rt.goalReviewAllowed = (_room, id) => id !== 'original-review'
  const send = host.tool('message_bot', { to: 'Writer', message: 'status?', request_id: 'stale-review-source' }, 'ga')
  await ready
  live.info = { ...live.info, reviewId: undefined }
  release()
  assert.match(await send, /Not sent/)
  assert.equal(host.agentOf('gb').calls.length, 0)
  host.finish('ga', '[PASS]')
  await settle(() => read() !== undefined)
})

test('owner check survives restart without falsely completing remaining tasks', async (t) => {
  const host = await start(t)
  await startGoal(host, { stages: [{ title: 'Draft', acceptance: 'reviewed', tasks: [{ bot: 'Writer', task: 'write' }, { bot: 'Tester', task: 'test' }] }] })
  const g = host.rt.roomOf('r1').goal
  await host.rt.testScheduleOccurrence(g.ownerReviewAt)
  const post = host.takeGoal()
  host.agentOf('r1').inbox.nextTurn.length = 0
  const read = host.round('restart-owner-review', post)
  await settle(() => host.agentOf('ga').calls.length > 0)
  host.begin('ga')
  const [writer, tester] = g.stages[0].tasks
  await host.tool('group_goal', reviewArgs(writer), 'ga')
  host.finish('ga', '[PASS]')
  await settle(() => read() !== undefined)
  await host.ctx.dispose()
  const restarted = await start(t, undefined, undefined, undefined, host.home)
  const restored = restarted.rt.roomOf('r1').goal
  assert.ok(restored.ownerReview.checks[writer.id])
  assert.equal(restored.ownerReview.checks[tester.id], undefined)
  await restarted.rt.testScheduleOccurrence(restored.reviewAt)
  assert.equal(restarted.agentOf('r1').calls.length, 1)
})

test('owner review completes only after two bounded turns cover all current tasks', async (t) => {
  const host = await start(t)
  await startGoal(host, { stages: [{ title: 'Draft', acceptance: 'reviewed', tasks: [{ bot: 'Writer', task: 'write' }, { bot: 'Tester', task: 'test' }] }] })
  const g = host.rt.roomOf('r1').goal
  await host.rt.testScheduleOccurrence(g.ownerReviewAt)
  const firstPost = host.takeGoal()
  host.agentOf('r1').inbox.nextTurn.length = 0
  const first = host.round('review-turn-one', firstPost)
  await settle(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')
  const [writer, tester] = g.stages[0].tasks
  await host.tool('group_goal', reviewArgs(writer), 'ga')
  host.finish('ga', '[PASS]')
  await settle(() => first() !== undefined)
  assert.equal(g.lastOwnerReview, undefined)
  await host.rt.testScheduleOccurrence(g.reviewAt)
  const secondPost = host.takeGoal()
  host.agentOf('r1').inbox.nextTurn.length = 0
  const second = host.round('review-turn-two', secondPost)
  await settle(() => host.agentOf('ga').calls.length === 2)
  host.begin('ga')
  assert.match(await host.tool('group_goal', reviewArgs(tester), 'ga'), /0 current task/)
  host.finish('ga', '[PASS]')
  await settle(() => second() !== undefined)
  assert.equal(g.ownerReview, undefined)
  assert.deepEqual(Object.keys(g.lastOwnerReview.checks).sort(), [writer.id, tester.id].sort())
  assert.ok(g.reviewAt - g.updatedAt >= 30 * 60_000)
})

test('owner check save failure does not claim completion in memory', async (t) => {
  const host = await start(t)
  const g = await parkForReview(host)
  await host.rt.testScheduleOccurrence(g.reviewAt)
  const post = host.takeGoal()
  host.agentOf('r1').inbox.nextTurn.length = 0
  host.round('failed-owner-save', post)
  await settle(() => host.agentOf('ga').calls.length > 0)
  host.begin('ga')
  const task = g.stages[0].tasks[0]
  const original = host.rt.save
  host.rt.save = async options => { if (options?.required) throw new Error('simulated save failure'); return original(options) }
  await assert.rejects(host.tool('group_goal', reviewArgs(task), 'ga'), /simulated save failure/)
  assert.equal(g.ownerReview.checks[task.id].unresolved, true)
  assert.equal(g.reviewAttempt.state, 'uncertain')
  assert.equal(g.reviewAttempt.saveOutcomeUnknown, true)
  assert.equal(saved(host).rooms.r1.goal.ownerReview.checks[task.id], undefined)
  host.rt.save = original
})

for (const change of ['stop', 'review identity']) {
  test(`an unmentioned bot post rechecks ${change} before admission`, async (t) => {
    const host = await start(t)
    await startGoal(host)
    const room = host.rt.roomOf('r1')
    const goal = room.goal
    if (change === 'review identity') goal.reviewAttempt = { id: 'review-a', state: 'admitting', adminId: 'a', rootSessionId: 'r1', adminSessionId: 'ga' }
    const read = host.round(`post-race-${change}`, host.say('User request'))
    await settle(() => host.agentOf('ga').calls.length === 1)
    host.begin('ga')
    let release, entered
    const gate = new Promise(resolve => { release = resolve })
    const waiting = new Promise(resolve => { entered = resolve })
    const original = host.ctx.sessionController.resolveAgent
    host.ctx.sessionController.resolveAgent = async id => { if (id === 'ga') { entered(); await gate }; return original(id) }
    await host.rt.postToRoom(room, host.rt.botOf('b'), 'work update', change === 'review identity' ? { originReviewId: 'review-a' } : {})
    host.finish('ga', '[PASS]')
    await waiting
    if (change === 'stop') await host.rt.goalUserStopped('r1')
    else goal.reviewAttempt.id = 'review-b'
    release()
    await settle(() => read() !== undefined)
    assert.equal(host.agentOf('ga').calls.length, 1)
  })
}

test('an automatically idle unfinished goal receives one periodic review without new activity', async (t) => {
  const host = await start(t)
  const g = await parkForReview(host)
  assert.equal(g.idleReason, 'admin-pass')
  assert.ok(Number.isFinite(g.reviewAt))
  const root = host.agentOf('r1')
  assert.equal(root.calls.length, 0)
  await host.rt.testScheduleOccurrence(g.reviewAt)
  assert.equal(root.calls.length, 1)
  assert.equal(root.calls[0].source.goal, 'nudge')
  assert.ok(root.calls[0].source.reviewId)
  await host.rt.testScheduleOccurrence(g.reviewAt + 3_600_000)
  assert.equal(root.calls.length, 1, 'an unresolved review must not be sent twice')
  assert.equal(g.stages[0].tasks[0].status, 'pending')
})

test('a completed review without a current admin slot retires without throwing', async (t) => {
  const host = await start(t)
  const g = await parkForReview(host)
  await host.rt.testScheduleOccurrence(g.reviewAt)
  const reviewId = g.reviewAttempt.id
  g.reviewAttempt.adminCompleted = true
  await host.rt.goalDrive(host.rt.roomOf('r1'), { goalReviewId: reviewId, slots: [] })
  assert.equal(g.reviewAttempt, undefined)
  assert.equal(g.idle, true)
})

test('user stop and stale auto evidence do not trigger review; legacy idle only permits inspection', async (t) => {
  const host = await start(t)
  const g = await parkForReview(host)
  const due = g.reviewAt + 1
  g.revision += 1 // an older host may have recorded a stop without updating the new idle provenance
  await host.rt.testScheduleOccurrence(due)
  assert.equal(host.agentOf('r1').calls.length, 0)
  host.rt.goalUserStopped('r1')
  await host.rt.testScheduleOccurrence(due + 3_600_000)
  assert.equal(host.agentOf('r1').calls.length, 0)
  assert.equal(g.idleReason, 'user-stop')
  delete g.idleReason
  delete g.idleRevision
  await host.rt.testScheduleOccurrence(due + 7_200_000)
  assert.equal(host.agentOf('r1').calls.length, 1)
  assert.equal(host.agentOf('r1').calls[0].source.reviewInspect, true)
  assert.equal(g.idle, true)
  assert.equal(g.idleReason, undefined)
})

test('a live group handoff skips its cycle; an old batch and delivery uncertainty only allow an idle inspection', async (t) => {
  const host = await start(t)
  const g = await parkForReview(host)
  delete g.idleReason
  delete g.idleRevision
  host.rt.roomBatchPending = () => true
  host.rt.roomWaiters.set('live-work', { roomId: 'r1' })
  const original = host.ctx.sessionController.resolveAgent
  host.ctx.sessionController.resolveAgent = async id => { if (id === 'gb') throw new Error('old delivery unknown'); return original(id) }
  await assert.rejects(host.rt.deliver({ toId: 'b', sessionId: 'gb', role: 'room', roomId: 'r1', text: 'old assignment' }))
  host.ctx.sessionController.resolveAgent = original
  const due = g.ownerReviewAt
  await host.rt.testScheduleOccurrence(due)
  assert.equal(host.takeGoal(), undefined)
  assert.equal(saved(host).rooms.r1.scheduledReviewOccurrence.outcome, 'busy')
  host.rt.roomWaiters.delete('live-work')
  await host.rt.testScheduleOccurrence(due + GOAL_REVIEW_INTERVAL_MS)
  const post = host.takeGoal()
  assert.equal(post.source.reviewInspect, true)
  host.agentOf('r1').inbox.nextTurn.length = 0
  const read = host.round('inspect-unknown-batch', post)
  await settle(() => host.agentOf('ga').calls.length > 0)
  assert.equal(host.agentOf('ga').calls.at(-1).source.reviewInspect, true)
  host.begin('ga')
  host.finish('ga', '[PASS]')
  await settle(() => read() !== undefined)
  assert.equal(g.idle, true)
  assert.equal(g.idleReason, undefined)
  assert.equal(g.reviewAttempt, undefined)
  assert.equal(host.agentOf('gb').calls.length, 0)
  assert.equal(host.rt.unreadOf('gb').length, 1)
})

test('ordinary user messages do not override a user stop or ambiguous legacy idle', async (t) => {
  const host = await start(t)
  const g = await parkForReview(host)
  host.rt.goalUserStopped('r1')
  host.rt.goalUserMessage('r1')
  assert.equal(g.idle, true)
  assert.equal(g.idleReason, 'user-stop')
  await host.rt.testScheduleOccurrence(g.reviewAt + 3_600_000)
  assert.equal(host.agentOf('r1').calls.length, 0)
  delete g.idleReason
  delete g.idleRevision
  host.rt.goalUserMessage('r1')
  assert.equal(g.idle, true)
  assert.equal(g.idleReason, undefined)
})

test('a member stop permits read-only review without restarting the stopped member', async (t) => {
  const host = await start(t)
  await startGoal(host)
  const g = host.rt.roomOf('r1').goal
  host.emit('gb', 'turn/start', { turn: 1 })
  await host.call('stop-member-work', { roomId: 'r1', botId: 'b' })
  assert.equal(g.idleReason, 'member-stop')
  assert.deepEqual(g.stoppedMembers, ['b'])
  host.rt.goalUserMessage('r1')
  assert.equal(g.idleReason, 'member-stop')
  const due = g.ownerReviewAt
  await host.rt.testScheduleOccurrence(due)
  assert.equal(host.takeGoal(), undefined)
  assert.equal(saved(host).rooms.r1.scheduledReviewOccurrence.outcome, 'busy')
  host.emit('gb', 'turn/end', { turn: 1, reason: { kind: 'cancelled', cause: { kind: 'user' } } })
  const notice = host.takePost()
  host.agentOf('r1').inbox.nextTurn.length = 0
  const result = host.round('member-stop-notice', notice)
  await settle(() => result() !== undefined)
  await host.rt.testScheduleOccurrence(due + GOAL_REVIEW_INTERVAL_MS)
  const post = host.takeGoal()
  assert.equal(post.source.reviewInspect, true)
  assert.equal(host.agentOf('gb').calls.length, 0)
})

test('a member stop that finds no running work does not park the goal', async (t) => {
  const host = await start(t)
  await startGoal(host)
  const g = host.rt.roomOf('r1').goal
  assert.equal((await host.call('stop-member-work', { roomId: 'r1', botId: 'b' })).value, false)
  assert.equal(g.idleReason, undefined)
  assert.equal(saved(host).rooms.r1.goal.idleReason, undefined)
})

test('a user stop is fenced before stop waits and is saved before the request returns', async (t) => {
  const host = await start(t)
  const g = await parkForReview(host)
  await host.rt.testScheduleOccurrence(g.reviewAt)
  const id = g.reviewAttempt.id
  const originalSave = host.rt.save
  let entered, release
  const saving = new Promise(resolve => { entered = resolve })
  const gate = new Promise(resolve => { release = resolve })
  let delayed = false
  host.rt.save = async (...args) => {
    if (!delayed && g.idleReason === 'user-stop' && args[0]?.required) { delayed = true; entered(); await gate }
    return originalSave(...args)
  }
  const stopping = host.call('stop-room-work', { roomId: 'r1' })
  await saving
  assert.equal(host.rt.goalReviewAllowed(host.rt.roomOf('r1'), id), false)
  release()
  await stopping
  assert.equal(saved(host).rooms.r1.goal.idleReason, 'user-stop')
})

test('ordinary group turns and message_bot do not restart stopped members', async (t) => {
  const host = await start(t)
  await startGoal(host)
  await host.rt.goalUserStopped('r1', 'b')
  await assert.rejects(host.tool('message_bot', { to: 'Writer', message: 'Resume that work' }, 'ga'), /stopped or its stop state is unknown/)
  const read = host.round('ordinary-after-stop', host.say('What is the status?'))
  await settle(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')
  host.finish('ga', '@Writer resume the work')
  await settle(() => read() !== undefined)
  assert.equal(host.agentOf('gb').calls.length, 0)
})

test('task progress does not postpone the review of every owner', async (t) => {
  const host = await start(t)
  await startGoal(host)
  const room = host.rt.roomOf('r1')
  const g = room.goal
  const due = g.ownerReviewAt
  await host.tool('group_goal', { action: 'task', bot: 'Writer', status: 'working' }, 'ga')
  g.updatedAt = due + 60_000 // unrelated progress is newer than the fixed review deadline
  assert.equal(g.ownerReviewAt, due)
  assert.equal(host.agentOf('r1').calls.length, 0)
  await host.rt.testScheduleOccurrence(due)
  assert.equal(host.agentOf('r1').calls.length, 1)
  const prompt = host.rt.goalBlock(room, host.rt.state.bots.a, { nudge: true })
  assert.match(prompt, /original cards, items, owners/)
  assert.match(prompt, /do not duplicate an outstanding or uncertain assignment/i)
  assert.match(prompt, /assigned independent reviewer/)
})

test('a busy group skips this review period durably and admits the next idle occurrence', async (t) => {
  const host = await start(t)
  await startGoal(host)
  const room = host.rt.roomOf('r1')
  const g = room.goal
  const due = g.ownerReviewAt
  const root = host.agentOf('r1')
  const existing = { id: 'already-queued', source: { kind: 'user' } }
  root.inbox.nextTurn.push(existing)
  host.rt.roomProgress.set('busy-round', { roomId: 'r1' })
  await host.rt.testScheduleOccurrence(due)
  assert.deepEqual(root.inbox.nextTurn, [existing])
  assert.equal(root.inbox.nextStep.length, 0)
  assert.equal(g.reviewAttempt, undefined)
  assert.equal(saved(host).rooms.r1.scheduledReviewOccurrence.outcome, 'busy')
  host.rt.roomProgress.delete('busy-round')
  root.inbox.nextTurn.length = 0
  assert.equal(await host.rt.testScheduleOccurrence(due), 'duplicate')
  assert.equal(root.calls.length, 0)
  await host.rt.testScheduleOccurrence(due + GOAL_REVIEW_INTERVAL_MS)
  assert.equal(root.calls.length, 1)
  assert.ok(root.calls[0].source.reviewId)
})

test('when work begins during root resolution, skip the occurrence before writing an intent', async (t) => {
  const host = await start(t)
  const g = await parkForReview(host)
  const due = g.reviewAt
  const queued = { id: 'user', source: { kind: 'user' } }
  const originalResolve = host.rt.resolveAgent
  host.rt.resolveAgent = async id => {
    const root = await originalResolve(id)
    if (id === 'r1') root.inbox.nextTurn.push(queued)
    return root
  }
  await host.rt.testScheduleOccurrence(due)
  assert.equal(g.reviewAttempt, undefined)
  assert.equal(saved(host).rooms.r1.scheduledReviewOccurrence.outcome, 'busy')
  assert.deepEqual(host.agentOf('r1').inbox.nextTurn, [queued])
})

test('a review merged behind another opener waits for the next normal period', async (t) => {
  const host = await start(t)
  const g = await parkForReview(host)
  const room = host.rt.roomOf('r1')
  await host.rt.testScheduleOccurrence(g.reviewAt)
  const first = host.takeGoal()
  host.agentOf('r1').inbox.nextTurn.length = 0
  const retiredAt = Date.now()
  await host.rt.goalReviewNotOpened(room, first.source.reviewId)
  const next = g.reviewAt
  assert.ok(next >= retiredAt + GOAL_REVIEW_INTERVAL_MS)
  assert.equal(host.agentOf('r1').calls.length, 0)
  await host.rt.testScheduleOccurrence(next)
  assert.equal(host.agentOf('r1').calls.length, 1)
})

test('a periodic review whose flush fails is never automatically sent again', async (t) => {
  const host = await start(t)
  const g = await parkForReview(host)
  host.ctx.sessions.flush = async () => { throw new Error('disk uncertain') }
  const root = host.agentOf('r1')
  await host.rt.testScheduleOccurrence(g.reviewAt)
  assert.equal(root.calls.length, 1)
  assert.ok(g.reviewAttempt)
  root.inbox.nextTurn.length = 0 // even an unavailable current inbox cannot establish the result
  await host.rt.testScheduleOccurrence(g.reviewAt + 7_200_000)
  assert.equal(root.calls.length, 1)
})

test('an admin model failure leaves a visible unresolved review without redispatch', async (t) => {
  const host = await start(t)
  const g = await parkForReview(host)
  await host.rt.testScheduleOccurrence(g.reviewAt)
  const post = host.takeGoal()
  host.agentOf('r1').inbox.nextTurn.length = 0
  const read = host.round('failed-admin-review', post)
  await settle(() => host.agentOf('ga').calls.length > 0)
  host.begin('ga')
  host.emit('ga', 'turn/end', { turn: 1, reason: { kind: 'error', error: { code: 'FAILED', message: 'model failed' } } })
  await settle(() => read() !== undefined)
  await settle(() => g.reviewAttempt?.state === 'uncertain')
  await host.rt.testScheduleOccurrence(g.reviewAt + 3_600_000)
  assert.equal(host.agentOf('r1').calls.length, 0)
  assert.match(await host.tool('group_goal', { action: 'show' }, 'ga'), /awaiting|uncertain/)
})

test('a review observed after an uncertain root flush can complete without resending', async (t) => {
  const host = await start(t)
  const g = await parkForReview(host)
  let first = true
  host.ctx.sessions.flush = async () => { if (first) { first = false; throw new Error('uncertain flush') } }
  await host.rt.testScheduleOccurrence(g.reviewAt)
  assert.equal(g.reviewAttempt.state, 'uncertain')
  const post = host.takeGoal()
  host.agentOf('r1').inbox.nextTurn.length = 0
  const read = host.round('uncertain-root', post)
  await settle(() => host.agentOf('ga').calls.length > 0)
  host.begin('ga')
  host.finish('ga', '[PASS]')
  await settle(() => read() !== undefined)
  assert.equal(g.reviewAttempt, undefined)
})

test('only explicit investigated recovery can release an uncertain review', async (t) => {
  const host = await start(t)
  const g = await parkForReview(host)
  host.ctx.sessions.flush = async () => { throw new Error('uncertain flush') }
  await host.rt.testScheduleOccurrence(g.reviewAt)
  const reviewId = g.reviewAttempt.id
  host.ctx.sessions.flush = async () => true
  const body = { roomId: 'r1', goalId: g.id, action: 'review-resolve', reviewId, evidence: 'Confirmed no task was dispatched', confirmed: true }
  assert.ok((await host.call('goal-control', { ...body, confirmed: false })).error)
  assert.ok((await host.call('goal-control', body)).error, 'the original root message remains queued')
  host.agentOf('r1').inbox.nextTurn.length = 0
  assert.equal((await host.call('goal-control', body)).ok, true)
  assert.equal(g.reviewAttempt, undefined)
  assert.equal(g.events.at(-1).kind, 'review-resolved')
  assert.equal(host.agentOf('r1').calls.length, 1)
  await host.rt.testScheduleOccurrence(g.reviewAt)
  assert.equal(host.agentOf('r1').calls.length, 2)
})

test('an overdue uncertain inspection still observes the local ledger without replaying work', async t => {
  const host = await start(t), goal = await parkForReview(host), room = host.rt.roomOf('r1')
  const at = Date.now() - GOAL_REVIEW_INTERVAL_MS
  goal.reviewAttempt = { id: 'unknown', at, state: 'uncertain', inspectOnly: true, adminId: 'a', rootSessionId: 'r1', adminSessionId: 'ga' }
  const before = structuredClone(goal), first = at + GOAL_REVIEW_INTERVAL_MS
  let clock = first
  t.mock.method(Date, 'now', () => clock)
  await host.rt.testScheduleOccurrence(first)
  const observed = host.rt.goalView(room).blockedReviewObservation
  assert.equal(observed.reviewId, 'unknown')
  assert.equal(observed.at, first)
  assert.equal(observed.revision, goal.revision)
  assert.deepEqual(observed.missing, goal.stages[goal.current].tasks.filter(t => t.status !== 'done').map(t => t.id))
  assert.equal(observed.open, observed.missing.length)
  assert.match(await host.tool('group_goal', { action: 'show' }, 'ga'), /Read-only host observation/)
  clock = first + 1
  await host.rt.testScheduleOccurrence(clock)
  assert.equal(host.rt.goalView(room).blockedReviewObservation.at, first)
  clock = first + GOAL_REVIEW_INTERVAL_MS
  await host.rt.testScheduleOccurrence(clock)
  assert.equal(host.rt.goalView(room).blockedReviewObservation.at, first + GOAL_REVIEW_INTERVAL_MS)
  assert.deepEqual(goal, before)
  assert.equal(host.agentOf('r1').calls.length, 0)
  assert.equal(host.agentOf('ga').calls.length, 0)
})

for (const scenario of ['clean failure', 'administrator tool', 'foreign inbox insertion', 'missing sequence', 'second admission', 'busy inbox']) {
  test(`original inspection turns permit bounded failure recovery: ${scenario}`, async t => {
    const host = await start(t), goal = await parkForReview(host)
    const id = 'native-failed-inspection'
    const attempt = goal.reviewAttempt = { id, at: Date.now(), state: 'uncertain', inspectOnly: true,
      adminId: 'a', adminSessionId: 'ga', rootSessionId: 'r1' }
    const pages = new Map()
    const emit = (sessionId, event) => {
      for (const listener of host.ctx.listeners.get('session/event') ?? []) {
        if (listener.length >= 2) listener({ id: sessionId }, event)
      }
    }
    for (const [sessionId, role] of [['r1', 'goal'], ['ga', 'room']]) {
      const root = role === 'goal'
      const source = { kind: 'bot', form: 'relay', role, reviewInspect: true, roomId: 'r1', reviewId: id, exchangeId: id,
        ...(root ? { goalId: goal.id } : {}) }
      const data = [
        ['turn/start', { turn: 13 }],
        ['agent/inbox/spliced', { removedCount: 1, inserted: !root && scenario === 'foreign inbox insertion' ? [{ id: 'unrelated' }] : [] }],
        ['user/message', { source, content: [] }],
        ['user/message', { source: { kind: 'time-context', form: 'snapshot' }, content: [] }],
        ...(root ? [['tool/call', { name: 'group_relay', callId: 'c', turn: 13 }], ['tool/result', { message: { role: 'tool', toolCallId: 'c', isError: false }, turn: 13 }]]
          : scenario === 'administrator tool' ? [['tool/call', { name: 'message_bot', callId: 'out', turn: 13 }]] : []),
        ['turn/end', { turn: 13, reason: { kind: root ? 'completed' : 'error' } }],
      ]
      const events = data.map(([type, data], i) => ({ type, data, seq: 40 + i }))
      for (const event of events) emit(sessionId, event)
      if (!root && scenario === 'second admission') emit(sessionId, { ...events[2], seq: 99 })
      pages.set(sessionId, !root && scenario === 'missing sequence' ? events.filter((_, i) => i !== 2) : events)
    }
    const reads = []
    host.ctx.sessionController.events = async req => {
      reads.push(req)
      return { cursor: req.throughSeq, records: pages.get(req.address.sessionId).map(event => ({ type: 'event', event })) }
    }
    // Native event playback also publishes the ordinary group failure note.
    // Model the relay having drained it before the quiet-period check.
    await new Promise(resolve => setImmediate(resolve))
    host.rt.roomInbox.delete('r1')
    host.agentOf('r1').inbox.nextTurn.length = 0
    const previousRootCalls = host.agentOf('r1').calls.length
    if (scenario === 'busy inbox') host.agentOf('ga').inbox.nextTurn.push({ id: 'other' })
    await host.rt.testScheduleOccurrence()
    if (scenario === 'busy inbox') {
      assert.equal(goal.reviewAttempt, attempt)
      host.agentOf('ga').inbox.nextTurn.length = 0
      await host.rt.testScheduleOccurrence()
    }
    if (scenario === 'clean failure' || scenario === 'busy inbox') {
      assert.equal(goal.reviewAttempt, undefined)
      const record = saved(host).rooms.r1.goal.reviewResolutions.at(-1)
      assert.equal(record.decision, 'failed-before-tools')
      assert.equal(record.by, 'host')
      assert.equal(record.root.sessionId, 'r1')
      assert.equal(record.admin.sessionId, 'ga')
      assert.equal(record.admin.turn, 13)
      assert.ok(goal.ownerReviewAt >= Date.now() + GOAL_REVIEW_INTERVAL_MS - 1000)
      assert.equal(goal.lastOwnerReview, undefined)
      assert.equal(host.agentOf('r1').calls.length, previousRootCalls)
      assert.deepEqual(reads.map(req => [req.address.sessionId,req.throughSeq,req.maxMessages]), [['r1', 46, 8], ['ga', 44, 8]])
    } else {
      assert.equal(goal.reviewAttempt, attempt)
      assert.equal(goal.reviewResolutions, undefined)
    }
  })
}

test('recording an archived inspection verifies both native turns and keeps dispatch fenced across restart', async t => {
  const host = await start(t), goal = await parkForReview(host), room = host.rt.roomOf('r1')
  const id = 'original-archived-review', old = 'archived-admin'
  room.segments = { a: [{ sessionId: old }] }
  goal.reviewAttempt = { id, at: Date.now() - GOAL_REVIEW_INTERVAL_MS, state: 'uncertain', inspectOnly: true,
    adminId: 'a', adminSessionId: old, rootSessionId: 'r1' }
  const body = { roomId: room.id, goalId: goal.id, action: 'review-record-failure', reviewId: id, confirmed: true,
    root: { sessionId: 'r1', seq: 41, end: 44, turn: 76 }, admin: { sessionId: old, seq: 41, end: 42, turn: 55 } }
  host.rt.roomBatchPending = () => true
  let adminTool = true
  host.ctx.sessionController.events = async req => {
    const root = req.address.sessionId === 'r1', turn = root ? 76 : 55
    const source = { kind: 'bot', form: 'relay', reviewInspect: true, role: root ? 'goal' : 'room',
      roomId: 'r1', reviewId: id, ...(root ? { goalId: goal.id } : {}) }
    const events = [
      ['turn/start', { turn }], ['user/message', { source }],
      ...(root ? [['tool/call', { name: 'group_relay', callId: 'c' }],
        ['tool/result', { message: { role: 'tool', toolCallId: 'c', isError: false } }]]
        : adminTool ? [['tool/call', { name: 'message_bot' }]] : []),
      ['turn/end', { turn, reason: { kind: root ? 'completed' : 'error' } }],
    ]
    return { cursor: req.throughSeq, records: events.map(([type, data], i) => ({ type: 'event', event: { seq: 40 + i, type, data } })) }
  }
  assert.ok((await host.call('goal-control', { ...body, admin: { ...body.admin, end: 43 } })).error)
  assert.ok((await host.call('goal-control', { ...body, admin: { ...body.admin, sessionId: 'other' } })).error)
  assert.ok((await host.call('goal-control', { ...body, confirmed: false })).error)
  assert.equal(goal.reviewAttempt.terminalFailure, undefined)
  adminTool = false
  assert.equal((await host.call('goal-control', body)).ok, true)
  const revision = goal.revision
  assert.deepEqual(saved(host).rooms.r1.goal.reviewAttempt.terminalFailure.admin, body.admin)
  assert.equal((await host.call('goal-control', body)).ok, true)
  assert.equal(goal.revision, revision)
  assert.ok((await host.call('goal-control', { ...body, admin: { ...body.admin, turn: 54 } })).error)
  await host.ctx.dispose()
  const reboot = await start(t, undefined, undefined, undefined, host.home)
  const rt = reboot.rt, restored = rt.roomOf('r1'), g = restored.goal
  rt.roomBatchPending = () => true
  rt.live.set('ga', { info: { role: 'room', roomId: 'r1', reviewInspect: true, reviewId: id } })
  assert.equal(rt.goalReviewAllowed(restored, id), false)
  assert.equal(await rt.goalReviewBind(restored, id, 'ga'), false)
  await rt.goalReviewFinished(restored, 'ga', id)
  await rt.goalReviewFailed(restored, 'ga', id)
  await rt.goalReviewNotOpened(restored, id)
  await rt.goalDrive(restored, { goalReviewId: id, slots: [{ id: 'a', status: 'passed' }] })
  await rt.testScheduleOccurrence(Date.now() + GOAL_REVIEW_INTERVAL_MS)
  assert.equal(g.reviewAttempt.id, id)
  assert.equal(g.reviewResolutions, undefined)
  assert.equal(reboot.agentOf('r1').calls.length, 0)
  assert.match(await reboot.tool('group_goal', { action: 'show' }, 'ga'), /failed before administrator tools/)
  // An unknown persisted outcome still fences inspection. A proven failed
  // admin cannot own a later pending batch addressed only to another member.
  rt.state.roomBatches = { later:{roomId:'r1', at:Date.now(), pending:['a']} }
  await rt.testScheduleOccurrence()
  assert.equal(g.reviewAttempt.id, id)
  rt.state.roomBatches.later.pending = ['b']
  reboot.agentOf(old).inbox.nextTurn.push({ id: 'older-work' })
  await rt.testScheduleOccurrence()
  assert.equal(g.reviewAttempt.id, id)
  reboot.agentOf(old).inbox.nextTurn.length = 0
  reboot.agentOf(old).inbox.nextStep.push(passiveScheduleNotice)
  reboot.agentOf('ga').inbox.nextStep.push(passiveScheduleNotice)
  reboot.agentOf('r1').inbox.nextStep.push(passiveScheduleNotice)
  await rt.testScheduleOccurrence()
  assert.equal(g.reviewAttempt, undefined)
  const resolution = saved(reboot).rooms.r1.goal.reviewResolutions.at(-1)
  assert.equal(resolution.decision, 'failed-before-tools')
  assert.deepEqual(resolution.admin, body.admin)
  assert.deepEqual(rt.state.roomBatches.later.pending, ['b'])
  assert.equal((await reboot.call('goal-control', body)).ok, true)
  assert.ok((await reboot.call('goal-control', { ...body, admin: { ...body.admin, turn: 54 } })).error)
  assert.equal(g.lastOwnerReview, undefined)
  assert.equal(reboot.agentOf('r1').calls.length, 0)
})

test('only a verified inspection from this admin’s retained part can be resolved after rollover', async t => {
  const host = await start(t), g = await parkForReview(host), room = host.rt.roomOf('r1')
  const original = { id: 'rolled', at: Date.now() - GOAL_REVIEW_INTERVAL_MS, state: 'uncertain', inspectOnly: true,
    adminId: 'a', rootSessionId: 'r1', adminSessionId: 'previous-admin' }
  g.reviewAttempt = structuredClone(original)
  const body = { roomId: 'r1', goalId: g.id, action: 'review-resolve', reviewId: original.id,
    confirmed: true, evidence: 'Original admin turn ended in error before any tool call.' }
  room.segments = { b: [{ sessionId: 'previous-admin' }] }
  assert.ok((await host.call('goal-control', body)).error)
  room.segments = { a: [{ sessionId: 'previous-admin' }] }
  assert.ok((await host.call('goal-control', { ...body, decision: 'allow-future' })).error)
  for (const sid of ['ga', 'previous-admin']) {
    host.agentOf(sid).inbox.nextStep.push({ id: 'busy' })
    assert.ok((await host.call('goal-control', body)).error)
    host.agentOf(sid).inbox.nextStep.length = 0
  }
  assert.equal((await host.call('goal-control', body)).ok, true)
  assert.deepEqual(g.reviewResolutions.at(-1).attempt, original)
  assert.equal(g.reviewAttempt, undefined)
  assert.equal(g.lastOwnerReview, undefined)
})

test('user can allow future inspections without claiming the previous result was checked', async (t) => {
  const host = await start(t)
  const g = await parkForReview(host)
  host.ctx.sessions.flush = async () => { throw new Error('uncertain flush') }
  await host.rt.testScheduleOccurrence(g.reviewAt)
  host.ctx.sessions.flush = async () => true
  const original = structuredClone(g.reviewAttempt)
  const body = {roomId:'r1',goalId:g.id,action:'review-resolve',reviewId:original.id,decision:'allow-future',confirmed:true}
  assert.ok((await host.call('goal-control',body)).error, 'queued original work still blocks the decision')
  host.agentOf('r1').inbox.nextTurn.length = 0
  assert.equal((await host.call('goal-control',body)).ok,true)
  assert.equal(g.reviewAttempt,undefined)
  assert.deepEqual(g.reviewResolutions.at(-1).attempt,original)
  assert.equal(g.reviewResolutions.at(-1).decision,'allow-future')
  assert.match(g.events.at(-1).text,/remains unknown/)
  assert.equal((await host.call('goal-control',body)).ok,true, 'same decision is idempotent')
  assert.equal(g.reviewResolutions.filter(item=>item.id===original.id).length,1)
})

test('an unconfirmed inspection decision does not restart periodic work or claim success', async (t) => {
  const host = await start(t), g = await parkForReview(host)
  host.ctx.sessions.flush = async () => { throw new Error('uncertain flush') }
  await host.rt.testScheduleOccurrence(g.reviewAt)
  host.ctx.sessions.flush = async () => true
  const body = {roomId:'r1',goalId:g.id,action:'review-resolve',reviewId:g.reviewAttempt.id,decision:'allow-future',confirmed:true}
  host.agentOf('r1').inbox.nextTurn.length = 0
  const save = host.rt.save
  host.rt.save = async () => { throw new Error('decision save failed') }
  try {
    assert.equal((await host.call('goal-control',body)).ok,false)
    assert.equal((await host.call('goal-control',body)).ok,false)
    await host.rt.testScheduleOccurrence(Date.now()+3_600_000)
    assert.equal(host.agentOf('r1').calls.length,1,'unconfirmed decision must not admit another inspection')
  } finally { host.rt.save = save }
})

test('review recovery cannot bypass pause or user stop but works after explicit resume', async (t) => {
  const host = await start(t)
  const g = await parkForReview(host)
  await host.rt.testScheduleOccurrence(g.reviewAt)
  const body = { roomId: 'r1', goalId: g.id, action: 'review-resolve', reviewId: g.reviewAttempt.id, evidence: 'Confirmed original work outcome', confirmed: true }
  host.agentOf('r1').inbox.nextTurn.length = 0
  assert.equal((await host.call('goal-control', { roomId: 'r1', goalId: g.id, action: 'pause' })).ok, true)
  assert.equal(g.reviewAttempt.state, 'cancelled-uncertain')
  assert.ok((await host.call('goal-control', body)).error)
  assert.equal((await host.call('goal-control', { roomId: 'r1', goalId: g.id, action: 'resume' })).ok, true)
  host.agentOf('r1').inbox.nextTurn.length = 0
  assert.equal((await host.call('goal-control', body)).ok, true)
  assert.equal(g.reviewAttempt, undefined)
  host.rt.goalUserStopped('r1')
  await host.rt.testScheduleOccurrence(Date.now() + 3_600_000)
  assert.equal(g.idleReason, 'user-stop')
})

test('user-stopped uncertain review requires explicit resume before resolution', async (t) => {
  const host = await start(t)
  const g = await parkForReview(host)
  await host.rt.testScheduleOccurrence(g.reviewAt)
  const body = { roomId: 'r1', goalId: g.id, action: 'review-resolve', reviewId: g.reviewAttempt.id, evidence: 'Confirmed original work outcome', confirmed: true }
  host.agentOf('r1').inbox.nextTurn.length = 0
  host.rt.goalUserStopped('r1')
  assert.ok((await host.call('goal-control', body)).error)
  host.rt.goalUserMessage('r1')
  assert.ok((await host.call('goal-control', body)).error)
  assert.equal((await host.call('goal-control', { roomId: 'r1', goalId: g.id, action: 'resume' })).ok, true)
  assert.equal(host.agentOf('r1').inbox.nextTurn.length, 0, 'an unresolved review must not enqueue work')
  assert.equal((await host.call('goal-control', body)).ok, true)
  assert.equal(g.reviewAttempt, undefined)
})

test('an unresolved periodic review remains held after a runtime restart', async (t) => {
  const host = await start(t)
  const g = await parkForReview(host)
  await host.rt.testScheduleOccurrence(g.reviewAt)
  const reviewId = g.reviewAttempt.id
  await host.ctx.dispose()
  const restarted = await start(t, undefined, undefined, undefined, host.home)
  const restored = restarted.rt.roomOf('r1').goal
  assert.equal(restored.reviewAttempt.id, reviewId)
  const failures = []
  restarted.rt.noteFailure = failure => failures.push(failure)
  t.mock.method(Date, 'now', () => restored.reviewAt + 3_600_000)
  await restarted.rt.testScheduleOccurrence(restored.reviewAt + 3_600_000)
  assert.equal(restarted.agentOf('r1').calls.length, 0)
  assert.equal(failures[0]?.code, 'GOAL_REVIEW_UNCERTAIN')
  assert.match(failures[0]?.text, new RegExp(reviewId))
})

test('a persisted admin completion can rearm after runtime restart', async (t) => {
  const host = await start(t)
  const g = await parkForReview(host)
  const firstDue = g.reviewAt
  await host.rt.testScheduleOccurrence(firstDue)
  g.reviewAttempt.adminCompleted = true // persisted completion before round finalization
  await host.rt.save({ required: true })
  await host.ctx.dispose()
  const restarted = await start(t, undefined, undefined, undefined, host.home)
  const restored = restarted.rt.roomOf('r1').goal
  await restarted.rt.testScheduleOccurrence(firstDue + 1000)
  assert.equal(restored.reviewAttempt, undefined)
  assert.equal(restarted.agentOf('r1').calls.length, 0)
  await restarted.rt.testScheduleOccurrence()
  assert.equal(restarted.agentOf('r1').calls.length, 1)
})

test('a completed inspection closes behind a historical batch without touching its work', async t => {
  const host = await start(t)
  const goal = await parkForReview(host)
  const room = host.rt.roomOf('r1')
  const batch = { roomId:room.id, pending:['b'] }
  host.rt.state.roomBatches = { old:batch }
  host.rt.roomBatchPending = id => id === room.id
  await host.rt.testScheduleOccurrence(goal.reviewAt)
  const attempt = goal.reviewAttempt
  assert.equal(attempt.inspectOnly, true)
  attempt.adminCompleted = true
  host.agentOf('r1').inbox.nextTurn.length = 0

  // A real waiter still prevents declaring the group idle.
  host.rt.roomWaiters.set('live', { roomId:room.id })
  assert.equal(await host.rt.testScheduleOccurrence(goal.reviewAt + 1000), 'busy')
  assert.equal(goal.reviewAttempt, attempt)
  host.rt.roomWaiters.delete('live')

  assert.equal(await host.rt.testScheduleOccurrence(goal.reviewAt + 2000), 'pending')
  assert.equal(goal.reviewAttempt, undefined)
  assert.deepEqual(batch.pending, ['b'])
  assert.equal(host.agentOf('gb').calls.length, 0)
})

test('a real prepared worker delivery blocks completed review recovery after restart', async (t) => {
  const host = await start(t)
  const g = await parkForReview(host)
  const firstDue = g.reviewAt
  await host.rt.testScheduleOccurrence(firstDue)
  g.reviewAttempt.adminCompleted = true
  await host.rt.save({ required: true })
  const original = host.ctx.sessionController.resolveAgent
  host.ctx.sessionController.resolveAgent = async id => { if (id === 'gb') throw new Error('worker delivery interrupted'); return original(id) }
  await assert.rejects(host.rt.deliver({ toId: 'b', sessionId: 'gb', role: 'room', roomId: 'r1', text: 'pending worker assignment' }))
  assert.equal(host.rt.unreadOf('gb').length, 1)
  await host.ctx.dispose()
  const restarted = await start(t, undefined, undefined, undefined, host.home)
  assert.equal(restarted.rt.unreadOf('gb').length, 1)
  const restored = restarted.rt.roomOf('r1').goal
  await restarted.rt.testScheduleOccurrence(firstDue + 1000)
  assert.ok(restored.reviewAttempt)
  await restarted.rt.testScheduleOccurrence(firstDue + 3_600_000)
  assert.equal(restarted.agentOf('r1').calls.length, 0)
})

test('an unrelated old private recovery note does not block an independent group review', async (t) => {
  const host = await start(t)
  const g = await parkForReview(host)
  const original = host.ctx.sessionController.resolveAgent
  host.ctx.sessionController.resolveAgent = async id => { if (id === 'gb') throw new Error('old private delivery interrupted'); return original(id) }
  await assert.rejects(host.rt.deliver({ toId: 'b', sessionId: 'gb', role: 'chat', text: 'old private request' }))
  host.ctx.sessionController.resolveAgent = original
  assert.equal(host.rt.unreadOf('gb').length, 1)
  await host.rt.testScheduleOccurrence(g.reviewAt)
  assert.equal(host.agentOf('r1').calls.length, 1)
})

test('legacy same-room recovery notes permit only inspection and cannot dispatch workers', async (t) => {
  const host = await start(t)
  const g = await parkForReview(host)
  const original = host.ctx.sessionController.resolveAgent
  host.ctx.sessionController.resolveAgent = async id => { if (id === 'gb') throw new Error('legacy note'); return original(id) }
  await assert.rejects(host.rt.deliver({ toId: 'b', sessionId: 'gb', role: 'room', roomId: 'r1', text: 'historical assignment' }))
  host.ctx.sessionController.resolveAgent = original
  await host.rt.testScheduleOccurrence(g.reviewAt)
  const post = host.takeGoal()
  assert.equal(post.source.reviewInspect, true)
  host.agentOf('r1').inbox.nextTurn.length = 0
  const read = host.round('inspect-legacy', post)
  await settle(() => host.agentOf('ga').calls.length > 0)
  assert.equal(host.agentOf('ga').calls.at(-1).source.reviewInspect, true)
  host.begin('ga')
  const decide = (name, args = {}) => host.ctx.guards.map(guard => guard({ name, arguments: args, agent: { id: 'ga' } }))
  assert.ok(decide('message_bot').some(result => typeof result === 'string'))
  assert.ok(decide('pwsh').some(result => typeof result === 'string'))
  assert.ok(decide('group_goal', { action: 'task' }).some(result => typeof result === 'string'))
  assert.ok(decide('group_goal', { action: 'show' }).every(result => result === undefined))
  host.finish('ga', '@Writer repeat the assignment')
  await settle(() => read() !== undefined)
  assert.equal(host.agentOf('gb').calls.length, 0)
  assert.equal(g.reviewAttempt, undefined)
  await host.rt.testScheduleOccurrence(g.reviewAt)
  assert.equal(host.agentOf('r1').calls.length, 1)
  assert.equal(host.agentOf('r1').calls[0].source.reviewInspect, true)
})

test('a scheduled review sends one read-only follow-up for a held assignment', async (t) => {
  const host = await start(t)
  const g = await parkForReview(host)
  const resolve = host.ctx.sessionController.resolveAgent
  host.ctx.sessionController.resolveAgent = async id => {
    if (id === 'gb') throw new Error('unresolved original delivery')
    return resolve(id)
  }
  await assert.rejects(host.rt.deliver({
    toId: 'b', sessionId: 'gb', role: 'room', roomId: 'r1',
    exchangeId: 'original-assignment', text: 'original work',
  }))
  host.ctx.sessionController.resolveAgent = resolve
  await host.rt.testScheduleOccurrence(g.reviewAt)
  const post = host.takeGoal()
  assert.equal(post.source.reviewInspect, true)
  host.agentOf('r1').inbox.nextTurn.length = 0
  const result = host.round('held-assignment-follow-up', post)
  await settle(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')

  const task = g.stages[0].tasks[0]
  const initialStatus = task.status
  const { review_task, review_fingerprint } = reviewArgs(task)
  const args = { action: 'review-follow-up', review_task, review_fingerprint }
  const decisions = (id, name, arguments_) => host.ctx.guards.map(guard => guard({ agent: { id }, name, arguments: arguments_ }))
  await host.tool('group_goal', { action: 'show' }, 'ga')
  assert.ok(decisions('ga', 'group_goal', args).every(value => value === undefined))
  const reply = await host.tool('group_goal', args, 'ga')
  assert.match(reply, /@Writer/)
  assert.equal(host.agentOf('gb').calls.length, 1)
  const [question] = host.agentOf('gb').calls
  assert.equal(question.source.reviewInspect, true)
  assert.equal(question.source.reviewReceipt, true)
  assert.notEqual(question.source.exchangeId, 'original-assignment')
  assert.match(text(question), /Do not start, repeat or resume work/)
  await host.tool('group_goal', args, 'ga')
  assert.equal(host.agentOf('gb').calls.length, 1)

  const step = async messages => {
    const payload = { agent: { ...host.agentOf('gb'), id: 'gb' }, messages, step: 1, turn: 1,
      signal: new AbortController().signal, modelSelection: {} }
    const listeners = host.ctx.listeners.get('agent/pre-step')
    const run = index => index === listeners.length
      ? { kind: 'enter', messages }
      : listeners[index](payload, () => run(index + 1))
    return (await run(0)).messages.filter(message => !['snapshot', 'catalog'].includes(message.source?.form))
  }
  const userInput = host.say('Separate work from the user')
  assert.deepEqual(await step([question, userInput]), [userInput])
  assert.deepEqual(await step([question]), [question])

  host.begin('gb')
  for (const name of ['bash', 'message_bot']) {
    assert.ok(decisions('gb', name, {}).some(value => typeof value === 'string'))
  }
  assert.ok(decisions('gb', 'group_goal', args).some(value => typeof value === 'string'))
  assert.ok(decisions('gb', 'group_goal', { action: 'show' }).every(value => value === undefined))
  host.finish('ga', '[PASS]')
  await settle(() => result() !== undefined)
  host.finish('gb', 'Received the original assignment. Waiting for the draft evidence.')
  assert.equal(task.status, initialStatus)
  assert.ok(host.rt.unreadOf('gb').some(item => item.exchangeId === 'original-assignment'))
  await settle(() => host.agentOf('r1').calls.length > 0)
  const replyPost = host.takePost()
  assert.match(text(replyPost), /Status reply for [\s\S]*Self-report only; not acceptance/)
  assert.deepEqual(replyPost.source.goalReceiptFollowup, { taskId:task.id, ownerName:'Writer' })
  host.round('receipt-replies-wake-admin', replyPost)
  await settle(() => host.agentOf('ga').calls.length === 2)
  const adminReply = host.begin('ga')
  assert.match(text(adminReply), /Status reply for [\s\S]*Self-report only; not acceptance/)
  assert.match(text(adminReply), /@Chief Review this self-report/)
  assert.match(text(adminReply), /Do not reply \[PASS\].*take one concrete next step now/s)
  host.finish('ga', `@Writer Task ${task.id}: attach the missing draft evidence and name the acceptance check it proves by the next review.`)
  await settle(() => host.agentOf('gb').calls.length === 2)
  const ownerFollowup = host.agentOf('gb').calls.at(-1)
  assert.match(text(ownerFollowup), new RegExp(`Task ${task.id}`))
  assert.ok(logLines(host).some(line => line.text?.startsWith(`@Writer Task ${task.id}: attach the missing draft evidence`)))
  assert.ok(mentionsIn(`@Writer Task ${task.id}: attach the missing draft evidence`, host.rt.roomOf('r1').members.map(id => host.rt.state.bots[id])).found.some(bot => bot.name === 'Writer'))
})

test('one scheduled inspection can follow multiple independent task owners', async t => {
  const host = await start(t)
  const g = await parkForReview(host, [{
    title:'Draft', acceptance:'the draft and its checks are ready',
    tasks:[{ bot:'Writer', task:'write the draft' }, { bot:'Tester', task:'check the draft' }],
  }])
  const resolve = host.ctx.sessionController.resolveAgent
  host.ctx.sessionController.resolveAgent = async id => {
    if (id === 'gb' || id === 'gc') throw new Error('unresolved original delivery')
    return resolve(id)
  }
  for (const [botId, sessionId] of [['b','gb'], ['c','gc']]) {
    await assert.rejects(host.rt.deliver({ toId:botId, sessionId, role:'room', roomId:'r1', text:'original work' }))
  }
  host.ctx.sessionController.resolveAgent = resolve
  await host.rt.testScheduleOccurrence(g.reviewAt)
  const post = host.takeGoal()
  assert.equal(post.source.reviewInspect, true)
  host.agentOf('r1').inbox.nextTurn.length = 0
  const result = host.round('multi-owner-follow-up', post)
  await settle(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')

  const [writer, tester] = g.stages[0].tasks
  const followUp = task => host.tool('group_goal', { ...reviewArgs(task), action:'review-follow-up' }, 'ga')
  assert.match(await followUp(writer), /@Writer/)
  assert.match(await followUp(tester), /@Tester/)
  assert.match(await followUp(writer), /response due/)
  assert.equal(host.agentOf('gb').calls.length, 1)
  assert.equal(host.agentOf('gc').calls.length, 1)

  const members = host.rt.roomOf('r1').members.map(id => host.rt.state.bots[id]).filter(Boolean)
  const questions = logLines(host).filter(line => line.text?.startsWith('@Writer Task ') || line.text?.startsWith('@Tester Task '))
  assert.equal(questions.length, 2)
  assert.deepEqual(questions.map(line => mentionsIn(line.text, members).found.map(bot => bot.name)), [['Writer'], ['Tester']])
  host.finish('ga', '[PASS]')
  await settle(() => result() !== undefined)
})

for (const [kind, reply] of [
  ['written tool call', '<function=read>\n<parameter=path>a.md</parameter></function>'],
  ['promised work', '收到，我现在开始排查构建日志。'],
]) {
  test(`inspection ${kind} is not automatically retried without restrictions`, async (t) => {
    const host = await start(t)
    const g = await parkForReview(host)
    const original = host.ctx.sessionController.resolveAgent
    host.ctx.sessionController.resolveAgent = async id => { if (id === 'gb') throw new Error('legacy note'); return original(id) }
    await assert.rejects(host.rt.deliver({ toId: 'b', sessionId: 'gb', role: 'room', roomId: 'r1', text: 'historical assignment' }))
    host.ctx.sessionController.resolveAgent = original
    await host.rt.testScheduleOccurrence(g.reviewAt)
    const post = host.takeGoal()
    host.agentOf('r1').inbox.nextTurn.length = 0
    const read = host.round(`inspect-${kind}`, post)
    await settle(() => host.agentOf('ga').calls.length === 1)
    host.begin('ga')
    host.finish('ga', reply)
    await settle(() => read() !== undefined)
    assert.equal(host.agentOf('ga').calls.length, 1)
    assert.equal(g.reviewAttempt?.state, 'uncertain')
  })
}

test('a blocked inspection is not mistaken for a completed review', async (t) => {
  const host = await start(t)
  const g = await parkForReview(host)
  const original = host.ctx.sessionController.resolveAgent
  host.ctx.sessionController.resolveAgent = async id => { if (id === 'gb') throw new Error('legacy note'); return original(id) }
  await assert.rejects(host.rt.deliver({ toId: 'b', sessionId: 'gb', role: 'room', roomId: 'r1', text: 'historical assignment' }))
  host.ctx.sessionController.resolveAgent = original
  await host.rt.testScheduleOccurrence(g.reviewAt)
  const post = host.takeGoal()
  host.agentOf('r1').inbox.nextTurn.length = 0
  const read = host.round('blocked-inspection', post)
  await settle(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')
  host.emit('ga', 'turn/end', { turn: 1, reason: { kind: 'blocked' } })
  await settle(() => read() !== undefined)
  assert.equal(g.reviewAttempt?.state, 'uncertain')
  await host.rt.testScheduleOccurrence(g.reviewAt + 3_600_000)
  assert.equal(host.agentOf('r1').calls.length, 0)
})

test('confirmed inspection recovery remains read-only while legacy notes remain unresolved', async (t) => {
  const host = await start(t)
  const g = await parkForReview(host)
  const original = host.ctx.sessionController.resolveAgent
  host.ctx.sessionController.resolveAgent = async id => { if (id === 'gb') throw new Error('legacy note'); return original(id) }
  await assert.rejects(host.rt.deliver({ toId: 'b', sessionId: 'gb', role: 'room', roomId: 'r1', text: 'historical assignment' }))
  host.ctx.sessionController.resolveAgent = original
  await host.rt.testScheduleOccurrence(g.reviewAt)
  const post = host.takeGoal()
  host.agentOf('r1').inbox.nextTurn.length = 0
  const read = host.round('blocked-then-resolved', post)
  await settle(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')
  host.emit('ga', 'turn/end', { turn: 1, reason: { kind: 'blocked' } })
  await settle(() => read() !== undefined)
  assert.equal(g.reviewAttempt?.state, 'uncertain')
  const body = { roomId: 'r1', goalId: g.id, action: 'review-resolve', reviewId: g.reviewAttempt.id, evidence: 'Checked that this inspection did not finish', confirmed: true }
  assert.equal((await host.call('goal-control', body)).ok, true)
  await host.rt.testScheduleOccurrence(g.reviewAt)
  assert.equal(host.agentOf('r1').calls.length, 1)
  assert.equal(host.agentOf('r1').calls[0].source.reviewInspect, true)
  assert.equal(host.agentOf('gb').calls.length, 0)
})

test('an overdue scheduled follow-up escalates once to the original board reviewer', async t => {
  const host = await start(t)
  const g = await parkForReview(host)
  const task = g.stages[0].tasks[0]
  const args = { ...reviewArgs(task), action:'review-follow-up' }
  g.reviewFollowUps = { stageId:g.stages[0].id, records:{ [task.id]:{
    fingerprint:args.review_fingerprint, contactId:'b', state:'sent', deadline:Date.now() - 1000,
  } } }
  host.rt.goalItemReviewer = () => 'c'
  await host.rt.testScheduleOccurrence(g.reviewAt)
  const post = host.takeGoal()
  host.agentOf('r1').inbox.nextTurn.length = 0
  const result = host.round('overdue-follow-up', post)
  await settle(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')
  assert.match(await host.tool('group_goal', args, 'ga'), /@Tester/)
  assert.equal(host.agentOf('gb').calls.length, 0)
  const calls = host.agentOf('gc').calls
  assert.equal(calls.length, 1)
  assert.equal(calls[0].source.reviewReceipt, true)
  assert.match(text(calls[0]), /missed its response deadline/)
  assert.match(await host.tool('group_goal', args, 'ga'), /response due/)
  assert.equal(calls.length, 1)
  host.finish('ga', '[PASS]')
  await settle(() => result() !== undefined)
})

test('an admin inspection preserves pending business inputs for a later ordinary turn', async t => {
  const host = await start(t)
  const g = await parkForReview(host)
  const admin = 'ga'
  const agent = { ...host.agentOf(admin), id:admin }
  const preStep = async (messages, turn, step) => {
    const input = { agent, messages, turn, step, signal:new AbortController().signal, modelSelection:{} }
    const chain = host.ctx.listeners.get('agent/pre-step')
    const run = i => i === chain.length ? { kind:'enter', messages } : chain[i](input, () => run(i + 1))
    return (await run(0)).messages
  }
  const previous = [{ id:'ga:9', seq:9, turn:1, ownerId:'a' }]
  host.rt.state.pendingInputs = { ...host.rt.state.pendingInputs, [admin]:previous }
  const original = host.ctx.sessionController.resolveAgent
  host.ctx.sessionController.resolveAgent = async id => { if (id === 'gb') throw new Error('legacy note'); return original(id) }
  await assert.rejects(host.rt.deliver({ toId:'b', sessionId:'gb', role:'room', roomId:'r1', text:'old assignment' }))
  host.ctx.sessionController.resolveAgent = original
  await host.rt.testScheduleOccurrence(g.reviewAt)
  const rootPost = host.takeGoal()
  host.agentOf('r1').inbox.nextTurn.length = 0
  const round = host.round('protected-inspection', rootPost)
  await settle(() => host.agentOf(admin).calls.length === 1)
  const inspection = host.agentOf(admin).calls[0]
  assert.equal(inspection.source.reviewInspect, true)
  host.agentOf(admin).inbox.nextTurn.length = 0
  host.emit(admin, 'turn/start', { turn:2 })
  const inspectionMessages = await preStep([inspection], 2, 1)
  assert.ok(inspectionMessages.some(m => m.source?.reviewId === rootPost.source.reviewId))
  assert.ok(!inspectionMessages.some(m => m.source?.recoveryIds))
  for (const message of inspectionMessages) host.emit(admin, 'user/message', message)
  assert.equal(host.rt.live.get(admin).info.reviewId, rootPost.source.reviewId)
  await host.tool('group_goal', { group:'Ops', action:'show' }, admin)
  assert.ok(Number.isFinite(g.reviewAttempt.inspectionLedgerAt))
  assert.ok(!(await preStep([], 2, 2)).some(m => m.source?.recoveryIds))
  host.emit(admin, 'turn/end', { turn:2, reason:{ kind:'completed' } })
  await settle(() => round() !== undefined)
  assert.equal(g.reviewAttempt, undefined)
  assert.deepEqual(host.rt.state.pendingInputs[admin], previous)

  host.emit(admin, 'turn/start', { turn:3 })
  const normal = await preStep([host.say('Continue the business task')], 3, 1)
  assert.deepEqual(normal.find(m => m.source?.recoveryIds)?.source.recoveryIds, ['ga:9'])
  for (const message of normal) host.emit(admin, 'user/message', message)
  host.emit(admin, 'turn/end', { turn:3, reason:{ kind:'completed' } })
  assert.equal(host.rt.state.pendingInputs[admin], undefined)
})

test('a user request arriving during inspection waits for its own normal round', async (t) => {
  const host = await start(t)
  const g = await parkForReview(host)
  const original = host.ctx.sessionController.resolveAgent
  host.ctx.sessionController.resolveAgent = async id => { if (id === 'gb') throw new Error('legacy note'); return original(id) }
  await assert.rejects(host.rt.deliver({ toId: 'b', sessionId: 'gb', role: 'room', roomId: 'r1', text: 'historical assignment' }))
  host.ctx.sessionController.resolveAgent = original
  await host.rt.testScheduleOccurrence(g.reviewAt)
  const post = host.takeGoal()
  host.agentOf('r1').inbox.nextTurn.length = 0
  const review = host.round('inspect-first', post)
  await settle(() => host.agentOf('ga').calls.length > 0)
  host.begin('ga')
  host.round('new-user-request', host.say('@Writer a separate new request'))
  await settle(() => host.rt.roomLaterCount('r1') === 1)
  assert.equal(host.agentOf('gb').calls.length, 0)
  host.finish('ga', '[PASS]')
  await settle(() => host.agentOf('gb').calls.length === 1)
  assert.equal(host.agentOf('gb').calls[0].source.reviewInspect, undefined)
  host.begin('gb')
  host.finish('gb', 'Finished the separate request')
  await settle(() => review() !== undefined)
})

test('an interrupted inspection remains restricted across persisted restart recovery', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const host = await start(t)
  const g = await parkForReview(host)
  const original = host.ctx.sessionController.resolveAgent
  host.ctx.sessionController.resolveAgent = async id => { if (id === 'gb') throw new Error('legacy note'); return original(id) }
  await assert.rejects(host.rt.deliver({ toId: 'b', sessionId: 'gb', role: 'room', roomId: 'r1', text: 'historical assignment' }))
  host.ctx.sessionController.resolveAgent = original
  await host.rt.testScheduleOccurrence(g.reviewAt)
  const post = host.takeGoal()
  host.agentOf('r1').inbox.nextTurn.length = 0
  host.round('inspection-interrupted', post)
  await settle(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')
  await settle(() => {
    try { return JSON.parse(readFileSync(join(host.home, 'inflight.json'), 'utf8')).turns.ga?.trigger?.reviewInspect === true } catch { return false }
  })
  await host.ctx.dispose()
  const restarted = await start(t, undefined, undefined, undefined, host.home)
  t.mock.timers.tick(4000)
  await settle(() => restarted.rt.roomOf('r1').goal.reviewAttempt?.state === 'uncertain')
  await settle(() => saved(restarted).rooms.r1.goal.reviewAttempt?.state === 'uncertain')
  assert.equal(restarted.agentOf('ga').calls.length, 0)
  assert.equal(restarted.agentOf('r1').calls.length, 0)
  assert.equal((saved(restarted).pendingInputs?.ga ?? []).length, 0)
  await restarted.ctx.dispose()
})

test('an interrupted write-capable periodic review is not generically resumed after restart', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const host = await start(t)
  const g = await parkForReview(host)
  await host.rt.testScheduleOccurrence(g.reviewAt)
  const post = host.takeGoal()
  host.agentOf('r1').inbox.nextTurn.length = 0
  host.round('review-interrupted', post)
  await settle(() => host.agentOf('ga').calls.length === 1)
  assert.equal(host.agentOf('ga').calls[0].source.reviewInspect, undefined)
  host.begin('ga')
  await settle(() => {
    try { return !!JSON.parse(readFileSync(join(host.home, 'inflight.json'), 'utf8')).turns.ga?.trigger?.reviewId } catch { return false }
  })
  await host.ctx.dispose()
  const restarted = await start(t, undefined, undefined, undefined, host.home)
  t.mock.timers.tick(4000)
  await settle(() => saved(restarted).rooms.r1.goal.reviewAttempt?.state === 'uncertain')
  assert.equal(restarted.agentOf('ga').calls.length, 0)
  const inflight = JSON.parse(readFileSync(join(restarted.home, 'inflight.json'), 'utf8'))
  assert.equal(inflight.turns.ga.trigger.reviewId, post.source.reviewId)
  await restarted.ctx.dispose()
})

test('a stopped member interrupted before cancellation stays held after restart', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const host = await start(t)
  await startGoal(host)
  host.round('stopped-interrupted', host.say('@Writer do the work'))
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  await settle(() => {
    try { return !!JSON.parse(readFileSync(join(host.home, 'inflight.json'), 'utf8')).turns.gb } catch { return false }
  })
  await host.rt.goalUserStopped('r1', 'b')
  await host.ctx.dispose()
  const restarted = await start(t, undefined, undefined, undefined, host.home)
  t.mock.timers.tick(4000)
  await settle(() => {
    try { return !!JSON.parse(readFileSync(join(restarted.home, 'inflight.json'), 'utf8')).turns.gb } catch { return false }
  })
  assert.equal(restarted.agentOf('gb').calls.length, 0)
  await restarted.ctx.dispose()
})

test('an interrupted ordinary turn is retained without replay through two restarts', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const host = await start(t)
  await startGoal(host)
  host.round('ordinary-interrupted', host.say('@Writer work'))
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  await settle(() => {
    try { return !!JSON.parse(readFileSync(join(host.home, 'inflight.json'), 'utf8')).turns.gb } catch { return false }
  })
  await host.ctx.dispose()
  const second = await start(t, undefined, undefined, undefined, host.home)
  const heldSecond = []
  second.rt.noteFailure = note => heldSecond.push(note)
  t.mock.timers.tick(4000)
  await settle(() => {
    try { return JSON.parse(readFileSync(join(second.home, 'inflight.json'), 'utf8')).turns.gb?.recoveryHold === 'interrupted outcome unknown' } catch { return false }
  })
  await settle(() => heldSecond.some(note => note.code === 'RESUME_UNCERTAIN_HOLD'))
  assert.equal(second.agentOf('gb').calls.length, 0)
  second.emit('gb', 'turn/start', { turn: 999 })
  second.emit('gb', 'turn/end', { turn: 999, reason: { kind: 'completed' } })
  await settle(() => {
    try {
      const note = JSON.parse(readFileSync(join(second.home, 'inflight.json'), 'utf8'))
      return !note.turns.gb && Object.values(note.heldTurns ?? {}).some(item => item.sessionId === 'gb')
    } catch { return false }
  })
  await second.ctx.dispose()
  const third = await start(t, undefined, undefined, undefined, host.home)
  t.mock.timers.tick(4000)
  await settle(() => {
    try { return Object.values(JSON.parse(readFileSync(join(third.home, 'inflight.json'), 'utf8')).heldTurns ?? {}).some(item => item.sessionId === 'gb') } catch { return false }
  })
  assert.equal(third.agentOf('gb').calls.length, 0)
})

test('startup reports new interruptions separately from previously retained turns', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const host = await start(t)
  await host.ctx.dispose()
  const reason = 'interrupted outcome unknown'
  const record = { botId:'a', roomId:'r1', turn:1, since:1 }
  const id = createHash('sha256').update(JSON.stringify(['ga', record])).digest('hex')
  const held = { sessionId:'ga', record, reason, decisions:[{ action:'ignored' }] }
  const file = join(host.home, 'inflight.json')
  writeFileSync(file, JSON.stringify({
    turns:{
      ga:{ ...record, recoveryHold:reason },
      gb:{ ...record, botId:'b' },
      gc:{ ...record, botId:'c', recoveryHold:reason },
    },
    queued:{},
    heldTurns:{ [id]:held },
  }))
  const restarted = await start(t, undefined, undefined, undefined, host.home)
  const notices = []
  let settled = false
  restarted.rt.noteFailure = note => notices.push(note)
  restarted.rt.settleRoomBatches = async () => { settled = true }
  t.mock.timers.tick(4000)
  await settle(() => settled)
  assert.deepEqual(notices.filter(note => note.code === 'RESUME_UNCERTAIN_HOLD').map(note => note.sessionId).sort(), ['gb','gc'])
  assert.equal(notices.filter(note => note.code === 'RESUME_HELD_RECORDS').length, 1)
  const saved = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(Object.keys(saved.heldTurns).length, 3)
  assert.deepEqual(saved.heldTurns[id], held)
  for (const session of ['ga','gb','gc']) {
    assert.equal(saved.turns[session].recoveryHold, reason)
    assert.equal(restarted.agentOf(session).calls.length, 0)
  }
})

test('resume of a paused goal does not dispatch with an unresolved review', async (t) => {
  const host = await start(t)
  const g = await parkForReview(host)
  await host.rt.testScheduleOccurrence(g.reviewAt)
  const before = host.agentOf('r1').calls.length
  assert.ok(g.reviewAttempt)
  assert.equal((await host.call('goal-control', { roomId: 'r1', goalId: g.id, action: 'pause' })).ok, true)
  assert.equal(g.reviewAttempt.state, 'cancelled-uncertain')
  assert.equal((await host.call('goal-control', { roomId: 'r1', goalId: g.id, action: 'resume' })).ok, true)
  assert.equal(host.agentOf('r1').calls.length, before)
})

test('a runtime interrupted turn survives a later turn in its session and is reported after restart', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const host = await start(t)
  await startGoal(host)
  host.round('runtime-hold', host.say('@Writer do the work'))
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  await settle(() => {
    try { return !!JSON.parse(readFileSync(join(host.home, 'inflight.json'), 'utf8')).turns.gb } catch { return false }
  })
  const record = JSON.parse(readFileSync(join(host.home, 'inflight.json'), 'utf8')).turns.gb
  await host.rt.holdInterruptedTurn('gb', record)
  host.emit('gb', 'turn/start', { turn: 999 })
  host.emit('gb', 'turn/end', { turn: 999, reason: { kind: 'completed' } })
  await settle(() => {
    try {
      const note = JSON.parse(readFileSync(join(host.home, 'inflight.json'), 'utf8'))
      return !note.turns.gb && Object.values(note.heldTurns ?? {}).some(item => item.sessionId === 'gb')
    } catch { return false }
  })
  await host.ctx.dispose()
  const restarted = await start(t, undefined, undefined, undefined, host.home)
  const notices = []
  restarted.rt.noteFailure = note => notices.push(note)
  t.mock.timers.tick(4000)
  await settle(() => notices.some(note => note.code === 'RESUME_HELD_RECORDS'))
  assert.equal(restarted.agentOf('gb').calls.length, 0)
  assert.ok(Object.values(JSON.parse(readFileSync(join(restarted.home, 'inflight.json'), 'utf8')).heldTurns).some(item => item.sessionId === 'gb'))
  const recovery = (await restarted.rt.boardCall('board-list', { scope: { kind: 'room', id: 'r1' } })).recovery
  assert.equal(recovery.available, true)
  const held = recovery.items.find(item => item.sessionId === 'gb')
  assert.ok(held)
  assert.equal(held.status, 'uncertain')
  assert.equal(held.turn, 1, 'the original durable turn number is preserved for review')
  assert.equal(held.evidence, 'inflight.json')
  assert.equal(restarted.agentOf('gb').calls.length, 0, 'reading the recovery view must not restart work')
  const readOnly = restarted.rt.readOnly
  restarted.rt.readOnly = () => 'another host is writing'
  assert.ok(Number.isSafeInteger(recovery.sampledAt), 'successful recovery projection has a sampling time')
  assert.deepEqual(await restarted.rt.recoveryHeldView({ kind:'room', id:'r1' }), { available:false, incomplete:true, items:[] },
    'a secondary host must not present stale recovery records as current')
  restarted.rt.readOnly = readOnly
  const requireHomeLock = restarted.rt.requireHomeLock
  restarted.rt.requireHomeLock = () => { throw Object.assign(new Error('lock unavailable'), { code:'ELOCKLOST' }) }
  assert.equal(restarted.rt.readOnly(), undefined, 'a failed lock is not necessarily reflected in readOnly')
  assert.deepEqual(await restarted.rt.recoveryHeldView({ kind:'room', id:'r1' }), { available:false, incomplete:true, items:[] },
    'a host whose lock failed must not claim its in-memory notes are current')
  restarted.rt.requireHomeLock = requireHomeLock
  writeFileSync(join(restarted.home, 'state.lock'), JSON.stringify({ pid: 1, token: 'test-lock-token-0001' }))
  assert.equal(restarted.rt.readOnly(), undefined, 'holder information may remain stale immediately after lock replacement')
  assert.deepEqual(await restarted.rt.recoveryHeldView({ kind:'room', id:'r1' }), { available:false, incomplete:true, items:[] },
    'a replaced lock token must make the recovery projection unavailable')
})

test('recovery projection rejects a changed disk snapshot without writing it', async t => {
  const host = await start(t)
  const scope = { kind:'personal', id:'user' }
  assert.equal((await host.rt.recoveryHeldView(scope)).available, true)
  const file = join(host.home, 'inflight.json')
  const changed = JSON.stringify({ turns:{}, queued:{}, heldTurns:{}, extra:'external update' })
  writeFileSync(file, changed)
  assert.doesNotThrow(() => host.rt.requireHomeLock())
  assert.deepEqual(await host.rt.recoveryHeldView(scope), { available:false, incomplete:true, items:[] })
  assert.equal(readFileSync(file, 'utf8'), changed, 'view must not write or repair recovery notes')
})

test('recovery projection rejects an oversized file without changing it', async t => {
  const host = await start(t)
  const file = join(host.home, 'inflight.json')
  writeFileSync(file, '{}')
  truncateSync(file, 64 * 1024 * 1024 + 1)
  assert.deepEqual(await host.rt.recoveryHeldView({ kind:'personal', id:'user' }), { available:false, incomplete:true, items:[] })
  assert.doesNotThrow(() => host.rt.requireHomeLock())
})

test('startup holds are unavailable until the copied records reach the file', async t => {
  t.mock.timers.enable({ apis:['setTimeout'] })
  const home = privateTempDir(join(tmpdir(), 'ds-bot-goal-'))
  const record = { botId:'b', roomId:'r1', since:1 }
  writeFileSync(join(home, 'state.json'), JSON.stringify(seed()))
  writeFileSync(join(home, 'inflight.json'), JSON.stringify({ turns:{ gb:record }, queued:{}, heldTurns:{} }))
  const host = await start(t, undefined, undefined, undefined, home)
  const scope = { kind:'room', id:'r1' }
  assert.deepEqual(await host.rt.recoveryHeldView(scope), { available:false, incomplete:true, items:[] })
  await host.rt.holdInterruptedTurn('gb', record)
  const view = await host.rt.recoveryHeldView(scope)
  assert.equal(view.available, true)
  assert.equal(view.items.length, 1)
  assert.equal(view.items[0].sessionId, 'gb')
})

test('concurrent recovery sampling and writes never claim an unpersisted snapshot', async t => {
  const host = await start(t)
  const scope = { kind:'personal', id:'user' }
  for (let i = 0; i < 10; i += 1) {
    const writing = host.rt.holdInterruptedTurn('ga', { botId:'a', roomId:'r1', since:i + 1 })
    const result = await host.rt.recoveryHeldView(scope)
    await writing
    if (result.available) {
      const disk = JSON.parse(readFileSync(join(host.home, 'inflight.json'), 'utf8'))
      for (const row of result.items) assert.ok(disk.heldTurns[row.recoveryId], 'available rows must exist on disk')
    } else assert.equal(result.incomplete, true)
  }
})

test('closing a host during recovery sampling cannot leave its view available', async t => {
  const host = await start(t)
  const pending = host.rt.recoveryHeldView({ kind:'personal', id:'user' })
  await host.ctx.dispose()
  const result = await pending
  assert.deepEqual(result, { available:false, incomplete:true, items:[] })
})

test('a stopped member queued group delivery is retained after restart', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const host = await start(t)
  await startGoal(host)
  await host.rt.deliver({ toId: 'b', sessionId: 'gb', role: 'room', roomId: 'r1', text: 'work before stop' })
  await host.rt.goalUserStopped('r1', 'b')
  await host.ctx.dispose()
  const restarted = await start(t, undefined, undefined, undefined, host.home)
  restarted.ctx.sessionController.inspect = async () => ({ events: [] })
  t.mock.timers.tick(4000)
  await settle(() => restarted.rt.unreadOf('gb').length > 0)
  assert.equal(restarted.agentOf('gb').calls.length, 0)
  await restarted.ctx.dispose()
})

test('a sent but unread inspection is held instead of resent after restart', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const host = await start(t)
  const g = await parkForReview(host)
  const original = host.ctx.sessionController.resolveAgent
  host.ctx.sessionController.resolveAgent = async id => { if (id === 'gb') throw new Error('legacy note'); return original(id) }
  await assert.rejects(host.rt.deliver({ toId: 'b', sessionId: 'gb', role: 'room', roomId: 'r1', text: 'historical assignment' }))
  host.ctx.sessionController.resolveAgent = original
  await host.rt.testScheduleOccurrence(g.reviewAt)
  const reviewId = g.reviewAttempt.id
  await host.rt.deliver({ toId: 'a', sessionId: 'ga', role: 'room', roomId: 'r1', note: 'goal check', reviewId, reviewInspect: true, text: 'inspect goal' })
  await settle(() => {
    try { return JSON.parse(readFileSync(join(host.home, 'inflight.json'), 'utf8')).queued.ga?.some(item => item.args.reviewId === reviewId && item.recoveryHold === undefined) } catch { return false }
  })
  await host.ctx.dispose()
  const restarted = await start(t, undefined, undefined, undefined, host.home)
  restarted.ctx.sessionController.inspect = async () => ({ events: [] })
  t.mock.timers.tick(4000)
  await settle(() => restarted.rt.roomOf('r1').goal.reviewAttempt?.state === 'uncertain')
  assert.equal(restarted.agentOf('ga').calls.length, 0)
  await settle(() => saved(restarted).rooms.r1.goal.reviewAttempt?.state === 'uncertain')
  await restarted.ctx.dispose()
})

test('a stopped sent-but-unread inspection is not recovered on restart', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const host = await start(t)
  const g = await parkForReview(host)
  const original = host.ctx.sessionController.resolveAgent
  host.ctx.sessionController.resolveAgent = async id => { if (id === 'gb') throw new Error('legacy note'); return original(id) }
  await assert.rejects(host.rt.deliver({ toId: 'b', sessionId: 'gb', role: 'room', roomId: 'r1', text: 'historical assignment' }))
  host.ctx.sessionController.resolveAgent = original
  await host.rt.testScheduleOccurrence(g.reviewAt)
  const reviewId = g.reviewAttempt.id
  await host.rt.deliver({ toId: 'a', sessionId: 'ga', role: 'room', roomId: 'r1', note: 'goal check', reviewId, reviewInspect: true, text: 'inspect goal' })
  await settle(() => {
    try { return JSON.parse(readFileSync(join(host.home, 'inflight.json'), 'utf8')).queued.ga?.some(item => item.args.reviewId === reviewId && item.recoveryHold === undefined) } catch { return false }
  })
  await host.ctx.dispose()
  const restarted = await start(t, undefined, undefined, undefined, host.home)
  restarted.ctx.sessionController.inspect = async () => ({ events: [] })
  const failures = []
  restarted.rt.noteFailure = failure => failures.push(failure)
  restarted.rt.goalUserStopped('r1')
  t.mock.timers.tick(4000)
  await settle(() => failures.some(failure => failure.code === 'GOAL_REVIEW_UNCERTAIN'))
  assert.equal(restarted.agentOf('ga').calls.length, 0)
  assert.equal(restarted.rt.roomOf('r1').goal.idleReason, 'user-stop')
  await restarted.ctx.dispose()
})

test('a late inspection reply mentioning a worker remains a quiet report', async (t) => {
  const host = await start(t)
  await host.rt.lateRoomReply('ga', { role: 'room', roomId: 'r1', reviewInspect: true }, '@Writer repeat the assignment')
  const post = host.takePost()
  assert.equal(post.source.quiet, true)
  const read = host.round('late-inspection', post)
  await settle(() => read() !== undefined)
  assert.equal(host.agentOf('gb').calls.length, 0)
})

test('an automatically idle goal still becomes due after a runtime restart', async (t) => {
  const host = await start(t)
  const due = (await parkForReview(host)).reviewAt
  await host.ctx.dispose()
  const restarted = await start(t, undefined, undefined, undefined, host.home)
  await restarted.rt.testScheduleOccurrence(due)
  assert.equal(restarted.agentOf('r1').calls.length, 1)
})

test('an old host stop invalidates auto-idle evidence across a runtime restart', async (t) => {
  const host = await start(t)
  const g = await parkForReview(host)
  g.revision += 1 // an old version records stop but leaves fields it does not understand
  await host.rt.save({ required: true })
  await host.ctx.dispose()
  const restarted = await start(t, undefined, undefined, undefined, host.home)
  await restarted.rt.testScheduleOccurrence(g.reviewAt + 3_600_000)
  assert.equal(restarted.agentOf('r1').calls.length, 0)
})

test('a user stop while a periodic review resolves its target prevents admission', async (t) => {
  const host = await start(t)
  const g = await parkForReview(host)
  const original = host.ctx.sessionController.resolveAgent
  let release
  const gate = new Promise(resolve => { release = resolve })
  let started
  const entered = new Promise(resolve => { started = resolve })
  host.ctx.sessionController.resolveAgent = async (id) => { if (id === 'r1') { started(); await gate } return original(id) }
  const review = host.rt.testScheduleOccurrence(g.reviewAt)
  await entered
  host.rt.goalUserStopped('r1')
  release()
  await review
  assert.equal(host.agentOf('r1').calls.length, 0)
  assert.equal(g.idleReason, 'user-stop')
})

test('a completed periodic review is delivered to the admin and schedules the next one', async (t) => {
  const host = await start(t)
  const g = await parkForReview(host)
  await host.rt.testScheduleOccurrence(g.reviewAt)
  const post = host.takeGoal()
  assert.ok(post.source.reviewId)
  host.agentOf('r1').inbox.nextTurn.length = 0 // the root has consumed the relay
  const read = host.round('periodic', post)
  await settle(() => host.agentOf('ga').calls.length > 0)
  host.begin('ga')
  host.finish('ga', '[PASS]')
  await settle(() => read() !== undefined)
  assert.equal(g.reviewAttempt, undefined)
  assert.equal(g.idleReason, 'admin-pass')
  assert.ok(g.reviewAt > Date.now())
  await host.rt.testScheduleOccurrence(g.reviewAt)
  assert.equal(host.agentOf('r1').calls.length, 1)
})

test('a long-running admin review holds its attempt until its actual turn completes', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const host = await start(t)
  const g = await parkForReview(host)
  await host.rt.testScheduleOccurrence(g.reviewAt)
  const post = host.takeGoal()
  host.agentOf('r1').inbox.nextTurn.length = 0
  const read = host.round('long-review', post)
  await settle(() => host.agentOf('ga').calls.length > 0)
  assert.equal(host.agentOf('ga').calls.at(-1).source.reviewId, post.source.reviewId)
  host.begin('ga')
  host.emit('ga', 'tool/call', { callId: 'k1', name: 'pwsh', arguments: '{}' })
  t.mock.timers.tick(ROOM_WORK_GRACE_MS * 2)
  await settle(() => read() !== undefined)
  assert.ok(g.reviewAttempt)
  await host.rt.testScheduleOccurrence(g.reviewAt + 3_600_000)
  assert.equal(host.agentOf('r1').calls.length, 0)
  host.finish('ga', '[PASS]')
  await settle(() => g.reviewAttempt === undefined)
  await host.rt.testScheduleOccurrence()
  assert.equal(host.agentOf('r1').calls.length, 1)
})

test('admin completion between the grace timer and round finalization is retained', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const host = await start(t)
  const g = await parkForReview(host)
  await host.rt.testScheduleOccurrence(g.reviewAt)
  const post = host.takeGoal()
  host.agentOf('r1').inbox.nextTurn.length = 0
  const read = host.round('review-grace-race', post)
  await settle(() => host.agentOf('ga').calls.length > 0)
  host.begin('ga')
  host.emit('ga', 'tool/call', { callId: 'k1', name: 'pwsh', arguments: '{}' })
  t.mock.timers.tick(ROOM_WORK_GRACE_MS * 2)
  assert.ok(host.rt.roomProgress.size > 0)
  host.finish('ga', '[PASS]') // synchronously before the round's await continuation
  await settle(() => read() !== undefined)
  assert.equal(g.reviewAttempt, undefined)
  await host.rt.testScheduleOccurrence(g.reviewAt)
  assert.equal(host.agentOf('r1').calls.length, 1)
})

test('an admin review waiting for approval resumes without duplicate review', async (t) => {
  const host = await start(t)
  const g = await parkForReview(host)
  await host.rt.testScheduleOccurrence(g.reviewAt)
  const post = host.takeGoal()
  host.agentOf('r1').inbox.nextTurn.length = 0
  const read = host.round('review-approval', post)
  await settle(() => host.agentOf('ga').calls.length > 0)
  host.begin('ga')
  host.emit('ga', 'tool/call', { callId: 'k1', name: 'pwsh', arguments: '{}' })
  const approval = host.ctx.listeners.get('approval/request')[0]({ agent: { session: { id: 'ga' } }, toolName: 'pwsh', reason: 'approval', callId: 'k1' }, () => 'from-dsh')
  await settle(() => read() !== undefined)
  assert.ok(g.reviewAttempt)
  await host.rt.testScheduleOccurrence(g.reviewAt + 3_600_000)
  assert.equal(host.agentOf('r1').calls.length, 0)
  const [pending] = host.rt.approvalsView()
  assert.equal((await host.call('approval-answer', { id: pending.id, choice: 'allow' })).ok, true)
  assert.equal(await approval, 'allowed-once')
  host.emit('ga', 'tool/result', { callId: 'k1' })
  host.finish('ga', '[PASS]')
  await settle(() => g.reviewAttempt === undefined)
  await host.rt.testScheduleOccurrence()
  assert.equal(host.agentOf('r1').calls.length, 1)
})

test('a periodic review can dispatch the work the admin calls out', async (t) => {
  const host = await start(t)
  const g = await parkForReview(host)
  await host.rt.testScheduleOccurrence(g.reviewAt)
  const post = host.takeGoal()
  host.agentOf('r1').inbox.nextTurn.length = 0
  const read = host.round('review-dispatch', post)
  await settle(() => host.agentOf('ga').calls.length > 0)
  host.begin('ga')
  host.finish('ga', '@Writer write the draft')
  await settle(() => host.agentOf('gb').calls.length > 0)
  host.begin('gb')
  host.finish('gb', 'draft written')
  await settle(() => read() !== undefined)
  assert.equal(host.agentOf('gb').calls.length, 1)
  assert.equal(g.reviewAttempt, undefined)
})

test('a periodic review creates the administrator first group session safely', async (t) => {
  const host = await start(t)
  const g = await parkForReview(host)
  delete host.rt.roomOf('r1').sessions.a
  await host.rt.testScheduleOccurrence(g.reviewAt)
  const post = host.takeGoal()
  host.agentOf('r1').inbox.nextTurn.length = 0
  const read = host.round('new-admin-session', post)
  await settle(() => host.agentOf('s1').calls.length > 0)
  assert.equal(g.reviewAttempt.adminSessionId, 's1')
  host.begin('s1')
  host.finish('s1', '[PASS]')
  await settle(() => read() !== undefined)
  assert.equal(g.reviewAttempt, undefined)
})

test('a user stop during the administrator first session creation prevents review delivery', async (t) => {
  const host = await start(t)
  const g = await parkForReview(host)
  delete host.rt.roomOf('r1').sessions.a
  await host.rt.testScheduleOccurrence(g.reviewAt)
  const post = host.takeGoal()
  host.agentOf('r1').inbox.nextTurn.length = 0
  const original = host.ctx.sessionController.create
  let entered, release
  const creating = new Promise(resolve => { entered = resolve })
  const gate = new Promise(resolve => { release = resolve })
  host.ctx.sessionController.create = async (...args) => { entered(); await gate; return original(...args) }
  const read = host.round('stop-new-admin-session', post)
  await creating
  host.rt.goalUserStopped('r1')
  release()
  await settle(() => read() !== undefined)
  assert.equal(host.agentOf('s1').calls.length, 0)
  assert.equal(g.idleReason, 'user-stop')
})

for (const phase of ['running', 'finalizing']) test(`a periodic check delivered to a ${phase} relay never opens a later round`, async (t) => {
  const host = await start(t)
  const g = await parkForReview(host)
  await host.rt.testScheduleOccurrence(g.reviewAt)
  const post = host.takeGoal()
  host.agentOf('r1').inbox.nextTurn.length = 0
  let release
  const finishing = new Promise(resolve => { release = resolve })
  const drive = host.rt.goalDrive
  host.rt.goalDrive = async (...args) => { await finishing; return drive(...args) }
  t.after(release)
  const business = host.round('business', host.say('@Chief review the new feature'))
  await settle(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')
  if (phase === 'finalizing') {
    host.finish('ga', '[PASS]')
    await settle(() => host.rt.roomActive('r1') && host.rt.roomProgress.size === 0)
  }
  const before = Date.now()
  host.emit('r1', 'user/message', post)
  await host.tool('group_relay', {}, 'r1', { callId: 'delayed-periodic' })
  assert.equal(host.rt.roomLaterCount('r1'), 0)
  assert.equal(g.reviewAttempt, undefined)
  assert.ok(g.ownerReviewAt >= before + GOAL_REVIEW_INTERVAL_MS)
  assert.equal(host.rt.roomActive('r1'), true)
  if (phase === 'running') host.finish('ga', '[PASS]')
  release()
  await settle(() => business() !== undefined)
  assert.equal(host.rt.ledger.records('group-r1').filter(row => row.event === 'round').length, 1)
  assert.equal(host.agentOf('ga').calls.length, 1)
  assert.equal(host.agentOf('ga').cancelled.length, 0)
})

test('a review mixed behind a user post is retired before the normal follow-up check', async (t) => {
  const host = await start(t)
  const g = await parkForReview(host)
  await host.rt.testScheduleOccurrence(g.reviewAt)
  const post = host.takeGoal()
  host.agentOf('r1').inbox.nextTurn.length = 0
  host.emit('r1', 'user/message', host.say('@Chief decide the new request'))
  const read = host.round('mixed-review', post)
  await settle(() => host.agentOf('ga').calls.length > 0)
  assert.match(text(host.agentOf('ga').calls[0]), /decide the new request/)
  assert.equal(host.agentOf('ga').calls[0].source.reviewId, undefined)
  host.begin('ga')
  host.finish('ga', '[PASS]')
  await settle(() => read() !== undefined)
  assert.equal(g.reviewAttempt, undefined)
  assert.equal(host.agentOf('r1').calls.length, 0)
})

test('a user post arriving during a skipped patrol save stays in the next relay inbox', async (t) => {
  const host = await start(t)
  const g = await parkForReview(host)
  await host.rt.testScheduleOccurrence(g.reviewAt)
  const post = host.takeGoal()
  host.agentOf('r1').inbox.nextTurn.length = 0
  let saving, release
  const entered = new Promise(resolve => { saving = resolve })
  const gate = new Promise(resolve => { release = resolve })
  const save = host.rt.save
  host.rt.save = async opts => {
    if (opts?.required && !g.reviewAttempt) { saving(); await gate }
    return save(opts)
  }
  t.after(release)
  host.emit('r1', 'user/message', post)
  host.emit('r1', 'user/message', host.say('@Chief handle the first request'))
  const first = host.tool('group_relay', {}, 'r1', { callId: 'first-work' })
  await entered
  await settle(() => host.agentOf('ga').calls.length === 1)
  host.emit('r1', 'user/message', host.say('@Writer handle the second request'))
  release()
  await first
  assert.deepEqual(host.rt.roomInbox.get('r1').map(item => item.text), ['@Writer handle the second request'])
  await host.tool('group_relay', {}, 'r1', { callId: 'second-work' })
  host.begin('ga')
  host.finish('ga', '[PASS]')
  await settle(() => host.agentOf('gb').calls.length === 1)
  assert.match(text(host.agentOf('gb').calls[0]), /handle the second request/)
  host.begin('gb')
  host.finish('gb', '[PASS]')
  await settle(() => !host.rt.roomActive('r1'))
  assert.equal(g.reviewAttempt, undefined)
})

for (const change of ['admin', 'member', 'root', 'stop', 'message']) {
  test(`a periodic review is not admitted if ${change} changes while its intent is saved`, async (t) => {
    const host = await start(t)
    const g = await parkForReview(host)
    const room = host.rt.roomOf('r1')
    const originalSave = host.rt.save
    let entered, release, delayed = false
    const saving = new Promise(resolve => { entered = resolve })
    const gate = new Promise(resolve => { release = resolve })
    host.rt.save = async (...args) => {
      if (g.reviewAttempt && !delayed) { delayed = true; entered(); await gate }
      return originalSave(...args)
    }
    const due = g.reviewAt
    const poll = host.rt.testScheduleOccurrence(due)
    await saving
    if (change === 'admin') room.admin = 'b'
    if (change === 'member') room.members = ['b', 'c']
    if (change === 'root') room.sessionId = 'r1p2'
    if (change === 'message') host.rt.roomInbox.set('r1', [{ text: 'new user request' }])
    if (change === 'stop') host.rt.goalUserStopped('r1')
    release()
    await poll
    assert.equal(host.agentOf('r1').calls.length, 0)
    assert.equal(g.reviewAttempt, undefined)
    if (change === 'stop') assert.equal(g.idleReason, 'user-stop')
    if (change === 'message') {
      assert.equal(saved(host).rooms.r1.scheduledReviewOccurrence.outcome, 'busy')
      assert.deepEqual(host.rt.roomInbox.get('r1'), [{ text: 'new user request' }])
    }
  })
}

test('a stop during admin resolution prevents a queued periodic review from reaching the admin', async (t) => {
  const host = await start(t)
  const g = await parkForReview(host)
  await host.rt.testScheduleOccurrence(g.reviewAt)
  const post = host.takeGoal()
  host.agentOf('r1').inbox.nextTurn.length = 0
  const original = host.ctx.sessionController.resolveAgent
  let entered, release
  const resolving = new Promise(resolve => { entered = resolve })
  const gate = new Promise(resolve => { release = resolve })
  host.ctx.sessionController.resolveAgent = async id => {
    if (id === 'ga') { entered(); await gate }
    return original(id)
  }
  host.round('review-stop-admin', post)
  await resolving
  host.rt.goalUserStopped('r1')
  release()
  await settle(() => host.rt.roomProgress.size === 0)
  assert.equal(host.agentOf('ga').calls.length, 0)
  assert.equal(g.idleReason, 'user-stop')
})

test('a periodic review never steers an administrator who became busy after scheduling', async (t) => {
  const host = await start(t)
  const g = await parkForReview(host)
  await host.rt.testScheduleOccurrence(g.reviewAt)
  const post = host.takeGoal()
  host.agentOf('r1').inbox.nextTurn.length = 0
  host.emit('ga', 'turn/start', { turn: 1 })
  host.emit('ga', 'user/message', host.say('A separate active request'))
  const read = host.round('review-busy-admin', post)
  await settle(() => read() !== undefined)
  assert.equal(host.agentOf('ga').calls.length, 0)
  assert.equal(g.reviewAttempt, undefined)
  assert.equal(g.idleReason, 'admin-pass')
})

test('a periodic review does not batch behind an already queued admin message', async (t) => {
  const host = await start(t)
  const g = await parkForReview(host)
  await host.rt.testScheduleOccurrence(g.reviewAt)
  const post = host.takeGoal()
  host.agentOf('r1').inbox.nextTurn.length = 0
  host.agentOf('ga').inbox.nextTurn.push({ id: 'ordinary-user-input', source: { kind: 'user' } })
  const read = host.round('review-queued-admin', post)
  await settle(() => read() !== undefined)
  assert.equal(host.agentOf('ga').calls.length, 0)
  assert.equal(host.agentOf('ga').inbox.nextTurn[0].id, 'ordinary-user-input')
  assert.equal(g.reviewAttempt, undefined)
})

test('an active goal stranded without an idle flag gets a periodic check', async (t) => {
  const host = await start(t)
  await startGoal(host)
  const g = host.rt.roomOf('r1').goal
  assert.equal(host.agentOf('r1').calls.length, 0)
  await host.rt.testScheduleOccurrence(g.updatedAt + 30 * 60 * 1000)
  assert.equal(host.agentOf('r1').calls.length, 1)
})

test('a stalled target resolution in one group does not block another group review', async (t) => {
  const room2 = { id: 'r2', name: 'Second', members: ['a', 'b', 'c'], mode: 'admin', admin: 'a', named: true, sessions: { a: 'ga2', b: 'gb2', c: 'gc2' }, log: [], seq: 0, seen: {} }
  const host = await start(t, {}, undefined, { r2: room2 })
  const g = await parkForReview(host)
  const other = host.rt.roomOf('r2')
  other.goal = structuredClone(g)
  other.goal.id = 'goal-second'
  const original = host.ctx.sessionController.resolveAgent
  let entered, release
  const resolving = new Promise(resolve => { entered = resolve })
  const gate = new Promise(resolve => { release = resolve })
  host.ctx.sessionController.resolveAgent = async id => {
    if (id === 'r1') { entered(); await gate }
    return original(id)
  }
  const poll = host.rt.testScheduleOccurrence(g.reviewAt)
  await resolving
  await host.rt.testScheduleOccurrence(g.reviewAt, 'r2')
  await settle(() => host.agentOf('r2').calls.length === 1)
  release()
  await poll
  assert.equal(host.agentOf('r1').calls.length, 1)
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
  assert.match(await startGoal(host), /Started\. Check ownership, dependencies, authorization and capacity; hand out only ready tasks needing assignment/)
  const started = goal(host)
  assert.deepEqual([started.status, started.current, started.stages.map(stage => stage.status)], ['active', 0, ['active', 'pending']])
  assert.deepEqual(started.stages[0].tasks.map(task => task.status), ['pending'])
  assert.ok(logLines(host).some(line => line.reason === 'goal' && line.event === 'start' && line.title === 'Ship it'))

  assert.equal(await host.tool('group_goal', { action: 'pass' }, 'ga'), 'evidence is required for pass.')
  assert.equal(await host.tool('group_goal', { action: 'complete', evidence: 'e', summary: 's' }, 'ga'), 'Stage 1 "Draft" has not passed yet. Pass every stage before complete.')

  assert.match(await host.tool('group_goal', { action: 'pass', evidence: 'reviewed' }, 'ga'), /Stage 1 passed\. Stage 2 "Check" is current/)
  const second = goal(host)
  assert.deepEqual([second.current, second.stages.map(stage => stage.status)], [1, ['passed', 'active']])
  assert.equal(second.stages[0].tasks[0].status, 'done')
  assert.equal(second.stages[0].evidence, 'reviewed')

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

test('an explicit group read resolves that group and binds its goal without crossing write boundaries', async t => {
  const lab = { id: 'r2', name: 'Lab', members: ['a', 'c'], admin: 'a', mode: 'admin', named: true, sessions: { a: 'la' }, log: [], seq: 0, seen: {} }
  const host = await start(t, {}, undefined, { r2: lab })
  await startGoal(host)
  assert.match(await host.tool('group_goal', { action: 'start', title: 'Lab milestone', objective: 'audit', acceptance: 'signed', stages: [{ title: 'Audit', acceptance: 'verified', tasks: [{ bot: 'Tester', task: 'verify' }] }] }, 'la'), /Started/)
  const ops = host.rt.roomOf('r1').goal, other = host.rt.roomOf('r2').goal
  const read = await host.tool('group_goal', { action: 'show', group: 'Lab' }, 'ga')
  assert.match(read, /Goal: Lab milestone/)
  assert.match(read, new RegExp(`room_id=r2 goal_id=${other.id} expected_revision=${other.revision}`))
  assert.doesNotMatch(read, /Ship the thing/)
  assert.match(await host.tool('group_goal', { action: 'show', room_id: 'r2' }, 'ga'), /Lab milestone/)
  assert.match(await host.rawTool('group_goal', { action: 'pause' }, 'ga'), /show the target group again/i)
  assert.match(await host.rawTool('group_goal', { action: 'pause', group: ' ' }, 'ga'), /empty/)
  assert.match(await host.tool('group_goal', { action: 'show', group: 'Ops', room_id: 'r2' }, 'ga'), /different groups/)
  assert.doesNotMatch(await host.tool('group_goal', { action: 'show', group: 'Lab' }, 'gb'), /Lab milestone/)
  host.rt.live.set('ga', { info: { reviewId: 'review-r1', roomId: 'r1' } })
  assert.match(await host.tool('group_goal', { action: 'show', room_id: 'r2' }, 'ga'), /only its assigned group/)
  host.rt.live.delete('ga')
  const write = { action: 'pause', room_id: 'r2', goal_id: other.id, expected_revision: other.revision }
  assert.match(await host.tool('group_goal', write, 'ga'), /from the target group/)
  assert.equal(ops.status, 'active')
  assert.equal(other.status, 'active')
  assert.match(await host.tool('group_goal', { ...write, room_id: 'r1' }, 'ga'), /show the target group again/i)
  assert.match(await host.tool('group_goal', write, 'la'), /Paused/)
})

test('a human edit or a replacement goal invalidates explicit and remembered goal revisions', async t => {
  const host = await start(t)
  await startGoal(host)
  const room = host.rt.roomOf('r1')
  const initial = { room_id: room.id, goal_id: room.goal.id, expected_revision: room.goal.revision }
  await host.tool('group_goal', { action: 'show' }, 'ga')
  assert.equal((await host.call('goal-control', { roomId: room.id, goalId: initial.goal_id, action: 'pause' })).ok, true)
  const revision = room.goal.revision
  for (const input of [{}, initial, { goal_id: initial.goal_id }]) {
    assert.match(await host.rawTool('group_goal', { action: 'resume', ...input }, 'ga'), /show the target group again/i)
    assert.equal(room.goal.status, 'paused')
    assert.equal(room.goal.revision, revision)
  }
  assert.match(await host.tool('group_goal', { action: 'show' }, 'ga'), new RegExp(`expected_revision=${revision}`))
  assert.match(await host.rawTool('group_goal', { action: 'resume' }, 'ga'), /Resumed/)
  await host.tool('group_goal', { action: 'stop', reason: 'new release' }, 'ga')
  await startGoal(host, { title: 'Next release' })
  assert.notEqual(room.goal.id, initial.goal_id)
  assert.equal(room.goal.revision, initial.expected_revision)
  assert.match(await host.tool('group_goal', { action: 'pause', ...initial }, 'ga'), /show the target group again/i)
  assert.equal(room.goal.status, 'active')
})

test('repeating current task status or evidence leaves the goal and its evidence timestamp intact', async t => {
  const host = await start(t)
  await startGoal(host)
  const write = input => host.tool('group_goal', { action: 'task', bot: 'Writer', ...input }, 'ga')
  const goal = host.rt.roomOf('r1').goal
  const before = structuredClone(goal)
  await write({ status: 'pending' })
  await write({ note: ' ' })
  assert.deepEqual(goal, before)
  await write({ status: 'working', note: 'evidence' })
  const after = structuredClone(goal)
  const ledger = await host.tool('group_goal', { action: 'show' }, 'ga')
  assert.equal(await write({ note: '  evidence  ', status: 'working' }), ledger)
  assert.deepEqual(goal, after)
  await write({ note: '' })
  const cleared = structuredClone(goal)
  assert.equal(cleared.revision, after.revision + 1)
  await write({ note: '' })
  assert.deepEqual(goal, cleared)
})

test('members see their own task note in show and prompt without another member note', async (t) => {
  const host = await start(t)
  await startGoal(host, { stages: [{ title: 'Draft', acceptance: 'reviewed', tasks: [{ bot: 'Writer', task: 'write' }, { bot: 'Tester', task: 'test' }] }] })
  await host.tool('group_goal', { action: 'task', bot: 'Writer', note: 'writer-only evidence' }, 'ga')
  await host.tool('group_goal', { action: 'task', bot: 'Tester', note: 'tester-only evidence' }, 'ga')
  const writerShow = await host.tool('group_goal', { action: 'show' }, 'gb')
  const testerShow = await host.tool('group_goal', { action: 'show' }, 'gc')
  const adminShow = await host.tool('group_goal', { action: 'show' }, 'ga')
  assert.match(writerShow, /writer-only evidence/)
  assert.doesNotMatch(writerShow, /tester-only evidence/)
  assert.match(testerShow, /tester-only evidence/)
  assert.doesNotMatch(testerShow, /writer-only evidence/)
  assert.match(adminShow, /writer-only evidence/)
  assert.match(adminShow, /tester-only evidence/)
  const prompt = host.rt.goalBlock(host.rt.state.rooms.r1, host.rt.state.bots.b)
  assert.match(prompt, /writer-only evidence/)
  assert.doesNotMatch(prompt, /tester-only evidence/)
  const testerPrompt = host.rt.goalBlock(host.rt.state.rooms.r1, host.rt.state.bots.c)
  assert.match(testerPrompt, /tester-only evidence/)
  assert.doesNotMatch(testerPrompt, /writer-only evidence/)
})

test('a goal ledger opens the original board item in its room and keeps its identity across stage changes', async t => {
  const host = await start(t)
  await startGoal(host)
  const show = sid => host.tool('group_goal', {action:'show'}, sid)
  const itemId = text => {
    const refs = [...text.matchAll(/board_task\.task_id=(legacy-[a-f0-9]{64})/g)]
    assert.equal(refs.length, 1)
    return refs[0][1]
  }
  const read = async (id, sid='gb') => JSON.parse(await host.tool('board_task', {action:'show', room_id:'r1', task_id:id}, sid)).task
  const original = itemId(await show('gb'))
  assert.equal(itemId(await show('ga')), original)
  assert.equal(itemId(host.rt.goalBlock(host.rt.roomOf('r1'), host.rt.botOf('b'))), original)
  assert.doesNotMatch(await show('gc'), /board_task\.task_id=/)
  const card = await read(original)
  assert.equal(card.owner, 'b')
  assert.equal(card.scope, 'room:r1')
  assert.equal(card.title, 'write the draft')
  await host.tool('board_task', {action:'reply', task_id:original, operation_id:'one-board-reply',
    expected_revision:card.revision, expected_board_revision:card.legacy.boardRevision, note:'Checking the draft'}, 'gb')
  assert.ok((await read(original)).replies.some(reply => reply.text === 'Checking the draft'))
  const scope = {kind:'room', id:'r1'}
  const parent = await host.rt.boardCall('board-command', {scope, operationId:'create-feature', taskId:'feature-draft',
    type:'create', value:{type:'feature',title:'Draft review',owner:'b',reviewer:'c',acceptance:'Reviewed',dependencies:[]}})
  const organized = await host.rt.boardCall('board-command', {scope, operationId:'link-original', taskId:parent.id,
    type:'link-goal-items', expectedRevision:parent.revision, value:{itemIds:[original]}})
  const minor = await host.rt.boardCall('board-release-create', {scope, operationId:'new-minor',
    release:{id:'build-12',name:'November',version:'1.2'}})
  await host.rt.boardCall('board-release-assign', {scope, operationId:'assign-minor', taskId:parent.id,
    releaseId:minor.id, expectedReleaseRevision:minor.revision, expectedTaskRevision:organized.revision})
  await host.tool('group_goal', {action:'pass', evidence:'Reviewed draft'}, 'ga')
  const current = itemId(await show('gc'))
  assert.notEqual(current, original)
  assert.equal((await read(current, 'gc')).owner, 'c')
  const previous = await read(original)
  assert.equal(previous.legacy.position, 'previous')
  assert.equal(previous.parentTaskId, parent.id)
  assert.equal(previous.releaseId, minor.id)
  assert.ok(previous.replies.some(reply => reply.text === 'Checking the draft'))
})

test('a Main Bot who is a member can explicitly show the full group ledger as backup', async (t) => {
  const host = await start(t, { admin: 'b' })
  await startGoal(host, { stages: [{ title: 'Draft', acceptance: 'reviewed', tasks: [{ bot: 'Writer', task: 'write' }, { bot: 'Tester', task: 'test' }] }] })
  await host.tool('group_goal', { action: 'task', bot: 'Writer', note: 'writer-only evidence' }, 'gb')
  await host.tool('group_goal', { action: 'task', bot: 'Tester', note: 'tester-only evidence' }, 'gb')
  const backup = await host.tool('group_goal', { action: 'show' }, 'ga')
  const admin = await host.tool('group_goal', { action: 'show' }, 'gb')
  const ordinary = await host.tool('group_goal', { action: 'show' }, 'gc')
  for (const result of [backup, admin]) {
    assert.match(result, /writer-only evidence/)
    assert.match(result, /tester-only evidence/)
  }
  assert.match(ordinary, /tester-only evidence/)
  assert.doesNotMatch(ordinary, /writer-only evidence/)
  const mainPrompt = host.rt.goalBlock(host.rt.state.rooms.r1, host.rt.state.bots.a)
  assert.doesNotMatch(mainPrompt, /writer-only evidence|tester-only evidence/)
  host.rt.state.rooms.r1.members = ['b', 'c']
  const noLongerMember = await host.tool('group_goal', { action: 'show', group: 'Ops' }, 'a')
  assert.doesNotMatch(noLongerMember, /writer-only evidence|tester-only evidence/)
  const staleGroupSession = await host.tool('group_goal', { action: 'show' }, 'ga')
  assert.doesNotMatch(staleGroupSession, /writer-only evidence|tester-only evidence/)
})

test('group goal tool shows status-change time even when the task has no note', async (t) => {
  const host = await start(t)
  await startGoal(host)
  await host.tool('group_goal', { action: 'task', bot: 'Writer', status: 'working' }, 'ga')
  const writer = await host.tool('group_goal', { action: 'show' }, 'gb')
  assert.match(writer, /status changed \d{4}-\d\d-\d\dT/)
})

test('events keep the newest 50 while goal replies remain in older pastGoals', async (t) => {
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
    await startGoal(host, { title: `g${i}` })
  }
  const room = saved(host).rooms.r1
  assert.equal(room.pastGoals.length, 6)
  assert.equal(room.pastGoals[0].stages[0].tasks[0].goalBoardReplies.length,60)
  assert.equal(room.pastGoals.at(-1).status, 'stopped')
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
  await settle(() => result() !== undefined)

  const again = host.round('c2', host.say('@Tester hello'))
  await settle(() => host.agentOf('gc').calls.length === 1)
  assert.match(text(host.begin('gc')), /You have no task in this stage\./)
  host.finish('gc', '[PASS]')
  await settle(() => again() !== undefined)
})

test('a goal draft opens as the user\'s line and calls only the admin', async (t) => {
  const host = await start(t)
  assert.equal((await host.call('goal-draft', { roomId: 'r1', text: 'Ship the thing' })).ok, true)
  const drafted = goal(host)
  assert.deepEqual([drafted.status, drafted.by, drafted.brief], ['drafting', 'user', 'Ship the thing'])
  const post = host.takePost()
  assert.deepEqual([post.source.role, post.source.goal], ['goal', 'draft'])
  const result = host.round('c1', post)
  await settle(() => host.agentOf('ga').calls.length === 1)
  const prompt = text(host.begin('ga'))
  assert.match(prompt, /the user wants to set a goal for this group/)
  assert.match(prompt, /<group_goal status="drafting">/)
  assert.match(prompt, /goal-grill/)
  host.finish('ga', 'Aligned, starting it.')
  await settle(() => result() !== undefined)
  assert.deepEqual(host.agentOf('gb').calls.filter(call => call.source?.role !== 'post'), [])
  assert.deepEqual(host.agentOf('gc').calls, [])
  const log = logLines(host)
  assert.deepEqual(log.filter(line => line.text === 'Ship the thing').map(line => line.who), ['User'])
  assert.ok(log.some(line => line.reason === 'goal' && line.event === 'draft'))
  assert.ok(result().replies.some(reply => reply.kind === 'user' && reply.text === 'Ship the thing'))
})

test('a group with no admin refuses a goal draft', async (t) => {
  const host = await start(t, {}, undefined, {
    r2: { id: 'r2', name: 'Lab', members: ['a', 'c'], mode: 'admin', admin: null, named: true, sessions: {}, log: [], seq: 0, seen: {} },
  })
  const result = await host.call('goal-draft', { roomId: 'r2', text: 'x' })
  assert.equal(result.error.message, 'This group has no admin. Set one in the group settings first.')
})

test('normal group rounds leave the admin alone until the next scheduled occurrence', async t => {
  const host = await start(t)
  await startGoal(host)
  const room = host.rt.roomOf('r1')
  const read = host.round('c1', host.say('@Chief go'))
  await settle(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga'); host.finish('ga', 'on it')
  await settle(() => read() !== undefined)
  assert.equal(host.takeGoal(), undefined)
  assert.equal(room.goal.nudges, 0)
  assert.equal(await host.rt.testScheduleOccurrence(), 'admitted')
  assert.ok(host.takeGoal()?.source.reviewId)
})

test('a paused goal and a room at work do not get a goal check', async (t) => {
  const host = await start(t)
  await startGoal(host)
  assert.equal((await host.call('goal-control', { roomId: 'r1', goalId: goal(host).id, action: 'pause' })).ok, true)
  assert.match(await host.tool('post_to_group', { group: 'Ops', message: 'checking in' }, 'b'), /Nobody answers it/)
  const paused = host.round('c1', host.takePost())
  await settle(() => paused() !== undefined)
  assert.equal(host.takeGoal(), undefined)
  // A member still at work in the room holds the check too.
  await host.call('goal-control', { roomId: 'r1', goalId: goal(host).id, action: 'resume' })
  const wake = host.round('c2', host.takeGoal())
  await settle(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')
  host.finish('ga', 'back on it')
  await settle(() => wake() !== undefined)
  host.agentOf('r1').calls.length = 0
  host.emit('gb', 'turn/start', { turn: 9 })
  assert.match(await host.tool('post_to_group', { group: 'Ops', message: 'more news' }, 'c'), /Nobody answers it/)
  const busy = host.round('c3', host.takePost())
  await settle(() => busy() !== undefined)
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
  await settle(() => result() !== undefined)
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
  await settle(() => result() !== undefined)
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
  await settle(() => wake() !== undefined)

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
  await settle(() => first() !== undefined)
  assert.equal(await host.rt.testScheduleOccurrence(), 'admitted')
  const nudge = host.takeGoal()
  assert.ok(nudge !== undefined)
  // The user pauses before the check runs: it opens a round that calls nobody.
  await host.call('goal-control', { roomId: 'r1', goalId: goal(host).id, action: 'pause' })
  const stale = host.round('c2', nudge)
  await settle(() => stale() !== undefined)
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
  await settle(() => plain() !== undefined)
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
  await settle(() => first() !== undefined)
  assert.equal((await host.call('stop-room-work', { roomId: 'r1' })).value, true)
  await settle(() => goal(host).idle === true)
  await settle(() => host.agentOf('r1').calls.length > 0)
  // The stop notices open a quiet round that calls nobody and queues no check.
  const notices = []
  while (host.agentOf('r1').calls.length > 0) notices.push(host.takePost())
  for (const notice of notices) {
    const quiet = host.round(`s${notices.indexOf(notice)}`, notice)
    await settle(() => quiet() !== undefined)
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
  await settle(() => first() !== undefined)
  await settle(() => taskOf('b').status === 'working' && taskOf('c').status === 'working')
  // Writer posts its result while Tester is still at work: reported at once.
  host.finish('gb', 'draft written, see out.md')
  await settle(() => taskOf('b').status === 'reported')
  assert.equal(taskOf('c').status, 'working')
})

test('a member call while the goal waits brings it back', async (t) => {
  const host = await start(t)
  await parkForReview(host)
  assert.equal(goal(host).idle, true)
  // The admin's own post calling a member clears the wait through the task hook.
  await host.tool('post_to_group', { group: 'Ops', message: '@Writer write the draft' }, 'a')
  const third = host.round('c4', host.takePost())
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  host.finish('gb', 'on it')
  await settle(() => third() !== undefined)
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
  for (let i = 0; i < 19; i++) await host.tool('group_goal', { action: 'pass', evidence: 'e' }, 'ga')
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
  await settle(() => result() !== undefined)
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

test('a member finishing after the round does not start another automatic check', async (t) => {
  const host = await start(t)
  await startGoal(host)
  // Member c's group turn is still running when the round ends — no check is queued.
  host.emit('gc', 'turn/start', { turn: 1 })
  const first = host.round('c1', host.say('@Chief go'))
  await settle(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')
  host.finish('ga', 'on it')
  await settle(() => first() !== undefined)
  assert.equal(host.takeGoal(), undefined)
  // The round is fully gone before c's work ends; the settle check then queues one goal check.
  await settle(async () => (await host.call('room-progress', { roomId: 'r1' })).value?.length === 0)
  host.emit('gc', 'assistant/message', { message: { content: [{ type: 'text', text: 'done' }] } })
  host.emit('gc', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(host.takeGoal(), undefined)
  // The member's late post is still queued and takes priority.
  assert.equal(await host.rt.testScheduleOccurrence(), 'busy')
  assert.equal(host.takeGoal(), undefined)
})

test('read-only review asks for show and does not count silent pass as successful inspection', async (t) => {
  const host = await start(t); const g = await parkForReview(host)
  const original = host.ctx.sessionController.resolveAgent
  host.ctx.sessionController.resolveAgent = async id => { if (id === 'gb') throw new Error('legacy note'); return original(id) }
  await assert.rejects(host.rt.deliver({ toId: 'b', sessionId: 'gb', role: 'room', roomId: 'r1', text: 'historical assignment' }))
  host.ctx.sessionController.resolveAgent = original
  await host.rt.testScheduleOccurrence(g.reviewAt); const post = host.takeGoal(); host.agentOf('r1').inbox.nextTurn.length = 0
  const read = host.round('inspect-without-show', post); await settle(() => host.agentOf('ga').calls.length > 0)
  const input = host.begin('ga')
  assert.match(text(input), /First call group_goal show/)
  assert.match(text(input), /plain-text @Name/)
  assert.match(text(input), /receipt\/status or exact missing-evidence question/)
  assert.match(text(input), /response deadline/)
  assert.match(text(input), /status-only group reply with plain-text @Name/)
  assert.match(text(input), /explicitly say not to repeat the work/)
  assert.match(text(input), /[Dd]o not leave the group with only “waiting”/)
  assert.match(text(input), /Only after successfully reading the current goal may you reply \[PASS\]/)
  assert.doesNotMatch(text(input), /Reply \[PASS\] to stay silent when you have nothing new/)
  assert.doesNotMatch(text(input), /Nothing new in this round since your last message/)
  assert.doesNotMatch(text(input), /For each current unfinished task you actually checked, call group_goal review-check/)
  host.finish('ga', '[PASS]'); await settle(() => read() !== undefined)
  assert.equal(g.lastInspection?.status, 'not-generated'); assert.equal(g.lastOwnerReview, undefined)
  assert.deepEqual(g.ownerReview?.checks, {}); assert.equal(host.agentOf('gb').calls.length, 0)
  assert.ok(g.ownerReviewAt > g.lastInspection.at)
})

test('success clears failed inspection evidence without creating an extra scheduled turn', async (t) => {
  let host = await start(t)
  let g = await parkForReview(host)
  delete g.idleReason
  delete g.idleRevision
  const run = async (success = false) => {
    const due = Math.max(g.ownerReviewAt, (host.rt.roomOf('r1').scheduledReviewOccurrence?.at ?? 0) + GOAL_REVIEW_INTERVAL_MS)
    await host.rt.testScheduleOccurrence(due)
    const post = host.takeGoal()
    assert.equal(post?.source.reviewInspect, true)
    host.agentOf('r1').inbox.nextTurn.length = 0
    const before = host.agentOf('ga').calls.length
    const read = host.round(`backoff-${due}`, post)
    await settle(() => host.agentOf('ga').calls.length > before)
    host.begin('ga')
    if (success) assert.match(await host.tool('group_goal', { action: 'show' }, 'ga'), /Goal:/)
    host.finish('ga', '[PASS]')
    await settle(() => read() !== undefined)
  }
  for (let i = 1; i <= 7; i++) {
    await run()
    assert.equal(g.lastInspection.status, 'not-generated')
    assert.equal(g.inspectionBackoff.count, i)
    assert.equal(g.ownerReviewAt - g.lastInspection.at, GOAL_REVIEW_INTERVAL_MS)
    assert.match(host.rt.goalLedger(host.rt.roomOf('r1'), host.rt.botOf('a')), new RegExp(`Inspection incomplete ${i} consecutive`))
    if (i === 3) {
      await host.ctx.dispose()
      host = await start(t, undefined, undefined, undefined, host.home)
      g = host.rt.roomOf('r1').goal
      assert.equal(g.inspectionBackoff.count, 3)
    }
  }
  await run(true)
  assert.equal(g.lastInspection.status, 'ledger-generated')
  assert.equal(g.inspectionBackoff, undefined)
  assert.equal(g.ownerReviewAt - g.lastInspection.at, GOAL_REVIEW_INTERVAL_MS)
  await run()
  await run()
  assert.equal(g.inspectionBackoff.count, 2)
  g.stages[0].tasks[0].task = 'a substantively changed task'
  await run()
  assert.equal(g.inspectionBackoff.count, 1)
  await run()
  assert.equal(g.inspectionBackoff.count, 2)
  host.rt.goalUserMessage('r1')
  assert.equal(g.inspectionBackoff, undefined)
  assert.equal(g.idle, true, 'a user message must not resume an ambiguous stop')
  assert.equal(g.idleReason, undefined)
  await run()
  assert.equal(g.inspectionBackoff.count, 1)
})

test('read-only review records only a successful show, never owner checks', async (t) => {
  const host = await start(t); const g = await parkForReview(host)
  const original = host.ctx.sessionController.resolveAgent
  host.ctx.sessionController.resolveAgent = async id => { if (id === 'gb') throw new Error('legacy note'); return original(id) }
  await assert.rejects(host.rt.deliver({ toId: 'b', sessionId: 'gb', role: 'room', roomId: 'r1', text: 'historical assignment' }))
  host.ctx.sessionController.resolveAgent = original
  await host.rt.testScheduleOccurrence(g.reviewAt); const post = host.takeGoal(); host.agentOf('r1').inbox.nextTurn.length = 0
  const read = host.round('inspect-with-show', post); await settle(() => host.agentOf('ga').calls.length > 0); host.begin('ga')
  assert.match(await host.tool('group_goal', { action: 'show' }, 'ga'), /Goal:/)
  assert.ok(Number.isFinite(g.reviewAttempt?.inspectionLedgerAt))
  host.finish('ga', '[PASS]'); await settle(() => read() !== undefined)
  assert.equal(g.lastInspection?.status, 'ledger-generated'); assert.equal(g.lastOwnerReview, undefined)
  assert.deepEqual(g.ownerReview?.checks, {}); assert.equal(host.agentOf('gb').calls.length, 0)
})

for (const afterWrite of [false, true]) {
  test(`read-only show save failure ${afterWrite ? 'after' : 'before'} replacement remains fenced`, async (t) => {
    const host = await start(t); const g = await parkForReview(host)
    const original = host.ctx.sessionController.resolveAgent
    host.ctx.sessionController.resolveAgent = async id => { if (id === 'gb') throw new Error('legacy note'); return original(id) }
    await assert.rejects(host.rt.deliver({ toId: 'b', sessionId: 'gb', role: 'room', roomId: 'r1', text: 'historical assignment' }))
    host.ctx.sessionController.resolveAgent = original
    await host.rt.testScheduleOccurrence(g.reviewAt); const post = host.takeGoal(); host.agentOf('r1').inbox.nextTurn.length = 0
    const read = host.round(`inspect-save-${afterWrite}`, post); await settle(() => host.agentOf('ga').calls.length > 0); host.begin('ga')
    const save = host.rt.save
    host.rt.save = async opts => {
      if (opts?.required) { if (afterWrite) await save(opts); throw new Error('unknown save outcome') }
      return save(opts)
    }
    const result = await host.tool('group_goal', { action: 'show' }, 'ga')
    host.rt.save = save
    assert.match(result, /could not be durably confirmed/)
    assert.equal(g.reviewAttempt?.state, 'uncertain'); assert.equal(g.reviewAttempt?.saveOutcomeUnknown, true)
    assert.equal(g.reviewAttempt?.inspectionLedgerAt, undefined)
    assert.equal(g.lastInspection, undefined); assert.equal(g.lastOwnerReview, undefined)
    if (afterWrite) assert.ok(Number.isFinite(saved(host).rooms.r1.goal.reviewAttempt.inspectionLedgerAt))
    host.finish('ga', '[PASS]'); await settle(() => read() !== undefined)
    await host.rt.testScheduleOccurrence(Date.now() + 3_600_000)
    assert.equal(g.reviewAttempt?.saveOutcomeUnknown, true)
    assert.equal(host.agentOf('r1').calls.length, 0); assert.equal(host.agentOf('gb').calls.length, 0)
  })
}

for (const when of ['during-save', 'after-show']) {
  test(`read-only ledger becomes stale if the current task changes ${when}`, async (t) => {
    const host = await start(t); const g = await parkForReview(host)
    const original = host.ctx.sessionController.resolveAgent
    host.ctx.sessionController.resolveAgent = async id => { if (id === 'gb') throw new Error('legacy note'); return original(id) }
    await assert.rejects(host.rt.deliver({ toId: 'b', sessionId: 'gb', role: 'room', roomId: 'r1', text: 'historical assignment' }))
    host.ctx.sessionController.resolveAgent = original
    await host.rt.testScheduleOccurrence(g.reviewAt); const post = host.takeGoal(); host.agentOf('r1').inbox.nextTurn.length = 0
    const read = host.round(`inspect-stale-${when}`, post); await settle(() => host.agentOf('ga').calls.length > 0); host.begin('ga')
    const save = host.rt.save
    if (when === 'during-save') host.rt.save = async opts => {
      if (opts?.required) { g.stages[g.current].tasks[0].task += ' changed'; g.revision += 1; if (g.idle === true) g.idleRevision = g.revision }
      return save(opts)
    }
    const output = await host.tool('group_goal', { action: 'show' }, 'ga')
    host.rt.save = save
    if (when === 'during-save') assert.match(output, /changed while saving/)
    else { assert.match(output, /Goal:/); g.stages[g.current].tasks[0].task += ' changed'; g.revision += 1; if (g.idle === true) g.idleRevision = g.revision }
    host.finish('ga', '[PASS]'); await settle(() => read() !== undefined)
    assert.equal(g.lastInspection?.status, 'stale-ledger')
    assert.equal(g.lastOwnerReview, undefined)
    assert.deepEqual(g.ownerReview?.checks, {}); assert.equal(host.agentOf('gb').calls.length, 0)
  })
}

test('lost idle provenance keeps inspection fenced and cannot claim a generated ledger', async (t) => {
  const host = await start(t); const g = await parkForReview(host)
  const original = host.ctx.sessionController.resolveAgent
  host.ctx.sessionController.resolveAgent = async id => { if (id === 'gb') throw new Error('legacy note'); return original(id) }
  await assert.rejects(host.rt.deliver({ toId: 'b', sessionId: 'gb', role: 'room', roomId: 'r1', text: 'historical assignment' }))
  host.ctx.sessionController.resolveAgent = original
  await host.rt.testScheduleOccurrence(g.reviewAt); const post = host.takeGoal(); host.agentOf('r1').inbox.nextTurn.length = 0
  const read = host.round('inspect-invalid-idle', post); await settle(() => host.agentOf('ga').calls.length > 0); host.begin('ga')
  assert.match(await host.tool('group_goal', { action: 'show' }, 'ga'), /Goal:/)
  g.revision += 1 // Invalidates idleRevision without asserting who changed it.
  host.finish('ga', '[PASS]'); await settle(() => read() !== undefined)
  assert.equal(g.lastInspection, undefined); assert.ok(g.reviewAttempt)
  assert.equal(g.lastOwnerReview, undefined); assert.equal(host.agentOf('gb').calls.length, 0)
  await host.rt.testScheduleOccurrence(Date.now() + 3_600_000)
  assert.equal(host.agentOf('r1').calls.length, 0)
})

test('unresolved delivery restricts its owner while another unique owner can be checked and evidence read', async (t) => {
  const host=await start(t)
  await startGoal(host,{stages:[{title:'Draft',acceptance:'draft reviewed',tasks:[{bot:'Writer',task:'write the draft'},{bot:'Tester',task:'check the draft'}]}]})
  const g=host.rt.roomOf('r1').goal
  await host.rt.goalDrive(host.rt.roomOf('r1'),{goalNudge:true,slots:[{id:'a',status:'passed'}]})
  const original=host.ctx.sessionController.resolveAgent
  host.ctx.sessionController.resolveAgent=async id=>{if(id==='gb')throw Error('unresolved writer delivery');return original(id)}
  await assert.rejects(host.rt.deliver({toId:'b',sessionId:'gb',role:'room',roomId:'r1',text:'old work'}))
  host.ctx.sessionController.resolveAgent=original
  const writer=g.stages[0].tasks.find(task=>task.botId==='b'),tester=g.stages[0].tasks.find(task=>task.botId==='c')
  tester.status='reported'
  await host.rt.testScheduleOccurrence(g.reviewAt)
  const post=host.takeGoal();assert.equal(post.source.reviewInspect,true)
  host.agentOf('r1').inbox.nextTurn.length=0
  const result=host.round('scoped-review',post)
  await settle(()=>host.agentOf('ga').calls.length>0);host.begin('ga')
  const decide=(name,args={})=>host.ctx.guards.map(guard=>guard({name,arguments:args,agent:{id:'ga'}}))
  assert.ok(decide('group_goal',reviewArgs(writer)).some(value=>typeof value==='string'))
  assert.ok(decide('group_goal',reviewArgs(tester)).every(value=>value===undefined))
  assert.ok(decide('read',{path:'evidence.txt'}).every(value=>value===undefined))
  assert.ok(decide('message_bot',{to:'Tester',message:'start'}).some(value=>typeof value==='string'))
  assert.ok(decide('pwsh',{}).some(value=>typeof value==='string'))
  assert.match(await host.tool('group_goal',reviewArgs(writer),'ga'),/unrelated, unblocked/)
  assert.match(await host.tool('group_goal',reviewArgs(tester),'ga'),/recorded|check/i)
  assert.ok(g.ownerReview?.checks?.[tester.id])
  assert.equal(g.ownerReview?.checks?.[writer.id],undefined)
  writer.status='reported'
  assert.ok(decide('group_goal',reviewArgs(writer)).some(value=>typeof value==='string'))
  assert.ok(decide('read',{path:'reported-evidence.txt'}).every(value=>value===undefined))
  const partial={...reviewArgs(writer),review_complete:false,review_assignment:'original delivery outcome unknown'}
  assert.ok(decide('group_goal',partial).every(value=>value===undefined))
  assert.match(await host.tool('group_goal',partial,'ga'),/Recorded/)
  assert.equal(g.ownerReview.checks[writer.id].unresolved,true)
  assert.ok(decide('bash',{}).some(value=>typeof value==='string'))
  // A new ambiguous note arriving after the first check must close the gate.
  const unread=host.rt.unreadRoomOf
  host.rt.unreadRoomOf=id=>unread(id).map(item=>item.toId==='b'?{...item,toId:undefined}:item)
  assert.ok(decide('group_goal',reviewArgs(tester)).some(value=>typeof value==='string'))
  assert.match(await host.tool('group_goal',reviewArgs(tester),'ga'),/unrelated, unblocked/)
  host.rt.unreadRoomOf=unread
  // Explicit pause wins even if the checked owner is otherwise independent.
  g.status='paused'
  assert.ok(decide('group_goal',reviewArgs(tester)).some(value=>typeof value==='string'))
  g.status='active'
  host.finish('ga','[PASS]')
  await settle(()=>result()!==undefined)
})

test('scoped inspection can assign independent pending work and request only reviewed missing evidence', async t=>{
  const host=await start(t)
  await startGoal(host,{stages:[{title:'Draft',acceptance:'draft reviewed',tasks:[
    {bot:'Writer',task:'write the draft'},{bot:'Tester',task:'run the draft checks'},
  ]}]})
  const g=host.rt.roomOf('r1').goal
  await host.rt.goalDrive(host.rt.roomOf('r1'),{goalNudge:true,slots:[{id:'a',status:'passed'}]})
  const original=host.ctx.sessionController.resolveAgent
  host.ctx.sessionController.resolveAgent=async id=>{if(id==='gb')throw Error('unresolved writer delivery');return original(id)}
  await assert.rejects(host.rt.deliver({toId:'b',sessionId:'gb',role:'room',roomId:'r1',text:'old work'}))
  host.ctx.sessionController.resolveAgent=original
  await host.rt.testScheduleOccurrence(g.reviewAt)
  const post=host.takeGoal();assert.equal(post.source.reviewInspect,true)
  host.agentOf('r1').inbox.nextTurn.length=0
  const result=host.round('scoped-independent-work',post)
  await settle(()=>host.agentOf('ga').calls.length>0);host.begin('ga')
  const reviewPrompt=JSON.stringify(host.agentOf('ga').calls.at(-1))
  assert.match(reviewPrompt,/advance independent, ready tasks/)
  assert.doesNotMatch(reviewPrompt,/do not assign, dispatch, modify tasks/)
  const decide=(name,args={})=>host.ctx.guards.map(guard=>guard({name,arguments:args,agent:{id:'ga'}}))
  const tester=g.stages[0].tasks.find(task=>task.botId==='c')
  const reviewId=g.reviewAttempt.id
  const pending={to:'Tester',when:'queue',request_id:`goal-review:${reviewId}:${tester.id}:assign`,
    message:`Task ${tester.id}: ${tester.task}. Start after your current work and report evidence.`}
  assert.ok(decide('message_bot',{...pending,to:'Writer'}).some(value=>typeof value==='string'))
  assert.ok(decide('message_bot',pending).every(value=>value===undefined))
  assert.ok(decide('message_bot',{...pending,request_id:`goal-review:${reviewId}:${tester.id}:evidence`}).some(value=>typeof value==='string'))
  assert.ok(decide('message_bot',{...pending,request_id:`goal-review:${reviewId}:${tester.id}`}).some(value=>typeof value==='string'))
  assert.ok(decide('message_bot',{...pending,message:`Task ${tester.id}: start`}).some(value=>typeof value==='string'))
  assert.ok(decide('message_bot',{...pending,reply_to:'user'}).some(value=>typeof value==='string'))

  tester.status='working'
  assert.ok(decide('message_bot',pending).some(value=>typeof value==='string'))
  tester.status='reported'
  const next='Attach a screenshot showing the saved setting.'
  assert.ok(decide('message_bot',{...pending,when:'now',message:`Task ${tester.id}: ${next}`}).some(value=>typeof value==='string'))
  assert.match(await host.tool('group_goal',{...reviewArgs(tester),review_progress:'The report has no screenshot.',
    review_next:next,evidence:'The report contains no screenshot.',review_complete:false},'ga'),/Recorded/)
  const followUp={...pending,when:'now',request_id:`goal-review:${reviewId}:${tester.id}:evidence`,message:`Task ${tester.id}: ${next}`}
  assert.ok(decide('message_bot',followUp).every(value=>value===undefined))
  assert.ok(decide('message_bot',{...followUp,request_id:pending.request_id}).some(value=>typeof value==='string'))
  assert.ok(decide('message_bot',{...followUp,message:`Task ${tester.id}: send an update`}).some(value=>typeof value==='string'))
  const current=host.rt.reviewQueueVersion
  host.rt.reviewQueueVersion=(roomId,ownerId)=>`${current(roomId,ownerId)}:changed`
  assert.ok(decide('message_bot',followUp).some(value=>typeof value==='string'))
  host.rt.reviewQueueVersion=current
  g.status='paused'
  assert.ok(decide('message_bot',followUp).some(value=>typeof value==='string'))
  g.status='active'
  host.finish('ga','[PASS]')
  await settle(()=>result()!==undefined)
})

test('a scoped check becomes unresolved if the queue changes while its save is pending', async t=>{
  const host=await start(t)
  await startGoal(host,{stages:[{title:'Draft',acceptance:'reviewed',tasks:[{bot:'Writer',task:'write'},{bot:'Tester',task:'test'}]}]})
  const g=host.rt.roomOf('r1').goal
  await host.rt.goalDrive(host.rt.roomOf('r1'),{goalNudge:true,slots:[{id:'a',status:'passed'}]})
  const original=host.ctx.sessionController.resolveAgent
  host.ctx.sessionController.resolveAgent=async id=>{if(id==='gb'||id==='gc')throw Error('held delivery');return original(id)}
  await assert.rejects(host.rt.deliver({toId:'b',sessionId:'gb',role:'room',roomId:'r1',text:'old work'}))
  await host.rt.testScheduleOccurrence(g.reviewAt)
  const post=host.takeGoal();host.agentOf('r1').inbox.nextTurn.length=0
  const result=host.round('queue-save-race',post)
  await settle(()=>host.agentOf('ga').calls.length>0);host.begin('ga')
  const task=g.stages[0].tasks.find(item=>item.botId==='c')
  let entered,release
  const ready=new Promise(resolve=>{entered=resolve}),gate=new Promise(resolve=>{release=resolve})
  const save=host.rt.save;let delayed=false
  host.rt.save=async opts=>{if(opts?.required&&!delayed){delayed=true;entered();await gate}return save(opts)}
  const check=host.tool('group_goal',reviewArgs(task),'ga')
  await ready
  await assert.rejects(host.rt.deliver({toId:'c',sessionId:'gc',role:'room',roomId:'r1',text:'new uncertain work'}))
  release()
  assert.match(await check,/unresolved/)
  host.rt.save=save
  const record=saved(host).rooms.r1.goal.ownerReview.checks[task.id]
  assert.ok(record.scopedQueueVersion)
  assert.notEqual(record.scopedQueueVersion,host.rt.reviewQueueVersion('r1','c'))
  const state=await host.call('state',{})
  assert.equal(state.value.rooms.find(room=>room.id==='r1').goal.ownerReview.checks[task.id].unresolved,true)
  const shown=await host.tool('group_goal',{action:'show'},'ga')
  assert.match(shown,new RegExp(`review still needs:.*${task.id}`))
  host.finish('ga','[PASS]');await settle(()=>result()!==undefined)
})

test('scoped queue version detects ABA and cannot survive host restart', async t=>{
  const host=await start(t,undefined,undefined,{r2:{id:'r2',name:'Other',members:['a','b'],admin:'a',sessions:{a:'ga2',b:'gb2'},log:[],seq:0,seen:{}}})
  await startGoal(host,{stages:[{title:'Draft',acceptance:'reviewed',tasks:[{bot:'Writer',task:'write'},{bot:'Tester',task:'test'}]}]})
  const g=host.rt.roomOf('r1').goal
  await host.rt.goalDrive(host.rt.roomOf('r1'),{goalNudge:true,slots:[{id:'a',status:'passed'}]})
  const original=host.ctx.sessionController.resolveAgent
  host.ctx.sessionController.resolveAgent=async id=>{if(id==='gb'||id==='gc'||id==='gb2')throw Error('held delivery');return original(id)}
  await assert.rejects(host.rt.deliver({toId:'b',sessionId:'gb',role:'room',roomId:'r1',text:'old work'}))
  await host.rt.testScheduleOccurrence(g.reviewAt)
  const post=host.takeGoal();host.agentOf('r1').inbox.nextTurn.length=0
  const result=host.round('queue-aba',post)
  await settle(()=>host.agentOf('ga').calls.length>0);host.begin('ga')
  const task=g.stages[0].tasks.find(item=>item.botId==='c')
  assert.match(await host.tool('group_goal',reviewArgs(task),'ga'),/Recorded/)
  const firstView=await host.call('state',{})
  assert.equal(firstView.value.rooms.find(room=>room.id==='r1').goal.ownerReview.checks[task.id].unresolved,
    g.ownerReview.checks[task.id].scopedQueueVersion !== host.rt.reviewQueueVersion('r1','c'))
  const version=saved(host).rooms.r1.goal.ownerReview.checks[task.id].scopedQueueVersion
  // Another owner's repeated queue activity must not invalidate this check.
  for(let i=0;i<5;i++){
    const exchangeId=`other-${i}`
    await assert.rejects(host.rt.deliver({toId:'b',sessionId:'gb',role:'room',roomId:'r1',exchangeId,text:'other work'}))
    host.rt.forgetDelivery(exchangeId,'gb')
    const otherRoomId=`other-room-${i}`
    await assert.rejects(host.rt.deliver({toId:'b',sessionId:'gb2',role:'room',roomId:'r2',exchangeId:otherRoomId,text:'other group'}))
    host.rt.forgetDelivery(otherRoomId,'gb2')
  }
  assert.equal(host.rt.reviewQueueVersion('r1','c'),version)
  const beforeTarget=await host.call('state',{})
  assert.equal(beforeTarget.value.rooms.find(room=>room.id==='r1').goal.ownerReview.checks[task.id].unresolved,false)
  const initial=host.rt.unreadOf('gc')
  await assert.rejects(host.rt.deliver({toId:'c',sessionId:'gc',role:'room',roomId:'r1',exchangeId:'aba-test',text:'new work'}))
  host.rt.forgetDelivery('aba-test','gc')
  assert.deepEqual(host.rt.unreadOf('gc'),initial)
  assert.notEqual(host.rt.reviewQueueVersion('r1','c'),version)
  assert.equal(host.rt.state.revision,beforeTarget.value.revision)
  const changed=await host.call('state',{since:beforeTarget.value.revision,live:beforeTarget.value.liveKey})
  assert.notEqual(changed.value.unchanged,true)
  assert.equal(changed.value.rooms.find(room=>room.id==='r1').goal.ownerReview.checks[task.id].unresolved,true)
  assert.match(await host.tool('group_goal',{action:'show'},'ga'),new RegExp(`review still needs:.*${task.id}`))
  host.finish('ga','[PASS]');await settle(()=>result()!==undefined)
  await host.ctx.dispose()
  const restarted=await start(t,undefined,undefined,undefined,host.home)
  assert.notEqual(restarted.rt.reviewQueueVersion('r1','c'),version)
  assert.match(await restarted.tool('group_goal',{action:'show'},'ga'),new RegExp(`review still needs:.*${task.id}`))
})

test('queue version becomes unavailable on lock loss and changes on reclaim', async t=>{
  const host=await start(t)
  const version=host.rt.reviewQueueVersion('r1','c')
  assert.ok(version)
  unlinkSync(join(host.home,'state.lock'))
  assert.equal(host.rt.reviewQueueVersion('r1','c'),undefined)
  await host.rt.refresh()
  assert.ok(host.rt.reviewQueueVersion('r1','c'))
  assert.notEqual(host.rt.reviewQueueVersion('r1','c'),version)
})

test('an unknown room recipient invalidates every owner even after removal', async t=>{
  const host=await start(t)
  const before=host.rt.reviewQueueVersion('r1','c')
  const original=host.ctx.sessionController.resolveAgent
  host.ctx.sessionController.resolveAgent=async id=>{if(id==='gb')throw Error('held delivery');return original(id)}
  await assert.rejects(host.rt.deliver({toId:'missing',sessionId:'gb',role:'room',roomId:'r1',exchangeId:'unknown-recipient',text:'unknown'}))
  assert.notEqual(host.rt.reviewQueueVersion('r1','c'),before)
  host.rt.forgetDelivery('unknown-recipient','gb')
  assert.notEqual(host.rt.reviewQueueVersion('r1','c'),before)
})

test('group reports and unknown roles are scoped, while a definite private request stays private', async t=>{
  const host=await start(t)
  const original=host.ctx.sessionController.resolveAgent
  host.ctx.sessionController.resolveAgent=async id=>{if(id==='gb'||id==='b')throw Error('held delivery');return original(id)}
  const before=host.rt.reviewQueueVersion('r1','b')
  await assert.rejects(host.rt.deliver({toId:'b',sessionId:'gb',role:'report',roomId:'r1',exchangeId:'group-report',text:'report'}))
  assert.notEqual(host.rt.reviewQueueVersion('r1','b'),before)
  assert.ok(host.rt.unreadRoomOf('r1').some(item=>item.exchangeId==='group-report'))
  await assert.rejects(host.rt.deliver({toId:'b',sessionId:'gb',role:'future-role',exchangeId:'unknown-role',text:'unknown'}))
  assert.ok(host.rt.unreadRoomOf('r1').some(item=>item.toId==='b'))
  const beforePrivate=host.rt.reviewQueueVersion('r1','b')
  await assert.rejects(host.rt.deliver({toId:'b',sessionId:'b',role:'request',exchangeId:'private-only',text:'private'}))
  assert.equal(host.rt.reviewQueueVersion('r1','b'),beforePrivate)
  assert.ok(!host.rt.unreadRoomOf('r1').some(item=>item.exchangeId==='private-only'))
})

test('an ordinary owner check becomes unresolved when that owner receives uncertain work', async t=>{
  const host=await start(t)
  await startGoal(host,{stages:[{title:'Draft',acceptance:'reviewed',tasks:[{bot:'Writer',task:'write'},{bot:'Tester',task:'test'}]}]})
  const g=host.rt.roomOf('r1').goal
  await host.rt.testScheduleOccurrence(g.ownerReviewAt)
  const post=host.takeGoal();host.agentOf('r1').inbox.nextTurn.length=0
  const result=host.round('ordinary-check-stale',post)
  await settle(()=>host.agentOf('ga').calls.length>0);host.begin('ga')
  const task=g.stages[0].tasks.find(item=>item.botId==='b')
  assert.match(await host.tool('group_goal',reviewArgs(task),'ga'),/Recorded/)
  assert.ok(g.ownerReview.checks[task.id].scopedQueueVersion)
  const original=host.ctx.sessionController.resolveAgent
  host.ctx.sessionController.resolveAgent=async id=>{if(id==='gb')throw Error('held delivery');return original(id)}
  await assert.rejects(host.rt.deliver({toId:'b',sessionId:'gb',role:'room',roomId:'r1',text:'uncertain'}))
  const state=await host.call('state',{})
  assert.equal(state.value.rooms.find(room=>room.id==='r1').goal.ownerReview.checks[task.id].unresolved,true)
  assert.match(await host.tool('group_goal',{action:'show'},'ga'),new RegExp(`review still needs:.*${task.id}`))
  host.finish('ga','[PASS]');await settle(()=>result()!==undefined)
})

test('old Sessions, missing room provenance, removed recipients and held turns remain visible through recovery', async t=>{
  const home=privateTempDir(join(tmpdir(),'ds-bot-old-room-'))
  writeFileSync(join(home,'state.json'),JSON.stringify(seed()))
  const original={turns:{},queued:{oldSession:[
    {at:1,args:{role:'room',roomId:'r1',toId:'b',exchangeId:'old-valid'},recoveryHold:'prepared'},
    {at:2,args:{role:'room',roomId:'r1',toId:'removed',exchangeId:'old-removed'},recoveryHold:'prepared'},
    {at:3,args:{role:'room',toId:'b',exchangeId:'old-unknown-room'},recoveryHold:'prepared'},
    {at:4,args:{role:'room',roomId:'r1',toId:'removed'},recoveryHold:'prepared'},
  ],gb:[{at:5},{at:6,args:{role:9}}],weird:{invalid:'preserve'}},heldTurns:{one:{sessionId:'gc',record:{botId:'c',roomId:'r1',trigger:{role:'room',roomId:'r1'}},reason:'unknown'}}}
  writeFileSync(join(home,'inflight.json'),JSON.stringify(original))
  const host=await start(t,undefined,undefined,undefined,home)
  const first=host.rt.unreadRoomOf('r1')
  assert.equal(first.length,8)
  assert.ok(first.some(item=>item.toId==='removed'))
  assert.ok(first.some(item=>item.toId==='c'))
  assert.equal(host.rt.unreadRoomOf('other').length,2)
  await new Promise(resolve=>setTimeout(resolve,3400))
  const persisted=JSON.parse(readFileSync(join(home,'inflight.json'),'utf8'))
  const retained=Object.values(persisted.queued).flat()
  assert.ok(retained.some(item=>item.args?.exchangeId==='old-removed'))
  assert.ok(retained.some(item=>item.args?.role==='room' && item.args?.toId==='removed' && !item.args?.exchangeId))
  assert.ok(retained.some(item=>item.at===5 && item.args===undefined))
  assert.ok(retained.some(item=>item.at===6 && item.args?.role===9))
  assert.deepEqual(persisted.queued.weird,{invalid:'preserve'})
  assert.ok(persisted.heldTurns.one)
  assert.ok(host.rt.unreadRoomOf('r1').some(item=>item.toId==='removed'))
  await host.ctx.dispose()
  const restarted=await start(t,undefined,undefined,undefined,home)
  assert.ok(restarted.rt.unreadRoomOf('r1').some(item=>item.toId==='removed'))
  assert.ok(restarted.rt.unreadRoomOf('other').length>=2)
})

test('scheduled messages do not resume an idle goal, while a real user message does', async t => {
  const host = await start(t)
  await startGoal(host)
  const current = host.rt.roomOf('r1').goal
  current.idle = true
  current.idleReason = 'nudge-limit'
  current.idleRevision = current.revision
  current.nudges = 2
  await host.rt.save({ required: true })
  const reminder = { content: [{ type: 'text', text: 'reminder_prompt_json: "@Writer inspect"' }], source: { kind: 'schedule' } }
  const scheduled = host.round('idle-reminder', reminder)
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  host.finish('gb', 'no change')
  await settle(() => scheduled() !== undefined)
  assert.equal(goal(host).idle, true)
  assert.equal(goal(host).nudges, 2)
  assert.equal(host.takeGoal(), undefined)
  const user = host.round('actual-user', host.say('@Writer continue'))
  await settle(() => host.agentOf('gb').calls.length === 2)
  host.begin('gb')
  host.finish('gb', 'working')
  await settle(() => user() !== undefined)
  assert.equal(goal(host).idle, undefined)
})

for (const scenario of ['operator', 'scheduler', 'native-bound', 'native-input-changed', 'native-relay-changed', 'native-repeated', 'passive-only', 'cold-tail', 'cold-synthetic', 'cold-extra', 'cold original', 'unpersisted terminal', 'wrong turn', 'second delivery in a later part', 'repeat admission', 'unfinished job', 'canceled admission', 'failed admin', 'unrelated input', 'original queue busy', 'changed cut', 'wrong admin', 'paused', 'stopped']) {
  test(`confirm a completed inspection after administrator rotation: ${scenario}`, async t => {
    const parts = new Map(), services = {}, host = await start(t, undefined, services)
    const goal = await parkForReview(host), room = host.rt.roomOf('r1')
    const attempt = goal.reviewAttempt = { id: 'old-inspection', at: Date.now() - 2 * GOAL_REVIEW_INTERVAL_MS, state: 'admitting',
      adminId: 'a', rootSessionId: 'r1', adminSessionId: 'old-a', inspectOnly: true }
    room.segments = { a: [{ sessionId: 'old-a' }, { sessionId: 'later-a' }] }
    const body = { action: 'review-confirm-terminal', confirmed: true, roomId: room.id, goalId: goal.id, reviewId: attempt.id }
    for (const [id, role] of [['r1', 'goal'], ['old-a', 'room']]) {
      const root = role === 'goal'
      const message = { id: 'm-' + id, role: 'user', content: [], source: { kind: 'bot', form: 'relay', reviewId: attempt.id,
        roomId: room.id, role, reviewInspect: true, ...(root ? { goalId: goal.id } : {}) } }
      let admitted = message
      if (root && scenario.startsWith('native-')) {
        admitted = { id:message.id, role:'user', source:{ kind:'schedule' }, content:[{ type:'text', text:'[SCHEDULE REMINDER] exact original fixture' }] }
        attempt.nativeOpening = { id:message.id, inputHash:inspectionMessageHash(admitted), relayHash:inspectionMessageHash(message) }
        if (scenario === 'native-input-changed') admitted.content[0].text += ' changed'
        if (scenario === 'native-relay-changed') message.content = [{type:'text',text:'extra'}]
      }
      const data = [
        ['agent/inbox/spliced', { start:0, target:'next-turn', inserted:[admitted] }],
        ['turn/start', { turn: 7 }],
        ['agent/inbox/spliced', { start:0, target:'next-turn', inserted:[], removedCount:1,
          ...(!root && scenario === 'canceled admission' ? { outcome:'canceled' } : {}) }],
        ...(!root ? [['user/message', { source: { kind: 'bot', form: 'snapshot', role: 'continue' } }]] : []),
        ['user/message', message],
        ['user/message', { source: { kind:'time-context', form:'snapshot' } }],
        ['tool/call', { callId: 'c', name: root ? 'group_relay' : 'bash' }],
        ...(!root ? [['job/registered', { jobId: 'j' }], ...(scenario === 'unfinished job' ? [] : [['job/settled', { jobId: 'j' }]])] : []),
        ['tool/result', { message: { role: 'tool', toolCallId: 'c', isError: false } }],
        ...(!root && scenario === 'unrelated input' ? [['user/message', { source: { kind: 'user' } }]] : []),
        ['turn/end', { turn: 7, reason: { kind: !root && scenario === 'failed admin' ? 'error' : 'completed' } }],
      ]
      const events = data.map(([type, data], seq) => ({ type, data, seq }))
      parts.set(id, events)
      body[root ? 'root' : 'admin'] = { sessionId: id, seq: events.find(e => e.data === message).seq, end: events.at(-1).seq, turn: 7 }
      if (root && scenario === 'native-repeated') events.push({ ...events[0], seq:events.length })
      if (root && scenario === 'passive-only') events.push({ seq:events.length, type:'agent/inbox/spliced', data:{
        target:'next-step', start:0, inserted:[{...passiveScheduleNotice, id:'retired-notice'}] } })
      if (!root && scenario === 'repeat admission') events.push({ ...events[0], seq: events.length })
    }
    parts.set('later-a', scenario === 'second delivery in a later part' ? parts.get('old-a') : [])
    parts.set('ga', [])
    const stages = structuredClone(goal.stages), counts = [...parts.keys()].map(id => host.agentOf(id).calls.length)
    const sessions = new Map([...parts].map(([id, events]) => [id, { id, seq: events.length }]))
    let inspected = 0, disposed = 0
    const fromTail = ['cold-tail','cold-synthetic','cold-extra'].includes(scenario)
    const cold = id => (fromTail || ['cold original','unpersisted terminal'].includes(scenario)) && id === 'old-a'
    host.ctx.sessions.get = id => cold(id) ? undefined : sessions.get(id)
    services.agents = { get: id => cold(id) ? undefined : host.agentOf(id) }
    services.sessionProjections = { snapshot: () => ({ asOfSeq: 10, values: { inbox: { 'next-step': [], 'next-turn': [] } } }) }
    services.sessionPersistence = {
      stat: async id => ({ header: { id }, revision: 'native-cut' }),
      open: async (id,mode) => {
        assert.equal(mode,'read'); assert.equal(id,'old-a')
        return { header:{id}, inheritedEventCount:0, async close(){}, async read(offset,length) {
          const last = parts.get(id).at(-1)
          assert.equal(offset,last.seq); assert.equal(length,2)
          return {events:scenario === 'cold-synthetic' ? [] : scenario === 'cold-extra' ? [last,{seq:last.seq+1}] : [last]}
        } }
      },
    }
    services.sessionQuery = { inspectSession: async (id, read) => read(sessions.get(id)), async observeSession(id) {
      assert.ok(parts.has(id)); inspected++
      const events = parts.get(id)
      if (scenario === 'changed cut' && id === 'ga') sessions.get('r1').seq++
      return { header: { id }, source: cold(id) ? 'prepared' : 'live', inheritedEventCount: 0, cursor: events.length - 1, events,
        ...(cold(id) ? { revision:'native-cut', ...(fromTail ? {} : { persistedEventCount:events.length - (scenario === 'unpersisted terminal' ? 1 : 0) }) } : {}),
        [Symbol.dispose]() { disposed++ } }
    } }
    if (scenario === 'wrong turn') body.admin.turn++
    if (scenario === 'wrong admin') room.admin = 'b'
    if (scenario === 'paused' || scenario === 'stopped') goal.status = scenario
    if (scenario === 'original queue busy') host.agentOf('old-a').inbox.nextTurn.push({ id: 'waiting' })
    if (scenario === 'passive-only') host.agentOf('r1').inbox.nextStep.push({...passiveScheduleNotice,id:'retired-notice'})
    const before = structuredClone(goal)
    if (scenario === 'scheduler') await host.rt.testScheduleOccurrence()
    else {
      const result = await host.call('goal-control', body)
      assert.equal(result.ok, ['operator','cold original','native-bound','passive-only','cold-tail'].includes(scenario), result.error)
    }
    assert.equal(disposed, inspected)
    assert.deepEqual(goal.stages, stages)
    assert.deepEqual([...parts.keys()].map(id => host.agentOf(id).calls.length), counts)
    if (['operator','cold original','scheduler','native-bound','passive-only','cold-tail'].includes(scenario)) {
      assert.equal(goal.reviewAttempt, undefined)
      const [resolution] = saved(host).rooms.r1.goal.reviewResolutions
      assert.equal(resolution.by, scenario === 'scheduler' ? 'host' : 'user')
      assert.equal(resolution.decision, 'inspection-ended')
      assert.deepEqual(resolution.root, body.root)
      assert.deepEqual(resolution.admin, body.admin)
      assert.deepEqual(resolution.attempt, before.reviewAttempt)
      assert.ok(goal.ownerReviewAt >= resolution.at + GOAL_REVIEW_INTERVAL_MS)
      const post = structuredClone(goal)
      await host.rt.goalDrive(room, { goalReviewId: attempt.id, goalNudge: true, slots: [{ id: 'a', status: 'passed' }] })
      assert.equal((await host.call('goal-control', body)).ok, true)
      assert.equal((await host.call('goal-control', { ...body, admin: { ...body.admin, end: body.admin.end + 1 } })).ok, false)
      assert.deepEqual(goal, post)
      if (scenario === 'operator') {
        await host.ctx.dispose()
        const reboot = await start(t, undefined, {}, {}, host.home)
        assert.equal((await reboot.call('goal-control', body)).ok, true)
        assert.deepEqual(saved(reboot).rooms.r1.goal.reviewResolutions, [resolution])
      }
    } else assert.deepEqual(goal, before)
  })
}


test('one native occurrence binds the current group, survives remount and only shows its directions to the original admin', async t => {
  const host = await start(t)
  await startGoal(host)
  const room = host.rt.roomOf('r1'), root = host.agentOf('r1')
  const key = JSON.stringify(['stable-schedule', new Date().toISOString()])
  const prompt = 'Check the v4 release and only new reviews against their original cards.'
  const msg = { id:'native-scheduled', role:'user', source:{kind:'schedule'}, content:[{ type:'text', text:'[SCHEDULE REMINDER]' }] }
  root.inbox.nextTurn.push(msg)
  root.inbox.nextStep.push(passiveScheduleNotice)
  const calls = []
  const original = host.rt.roomBusyForPatrol
  host.rt.roomBusyForPatrol = (...args) => { calls.push(args); return original(...args) }
  const result = await host.rt.runScheduledRoomReview(room, key, root, msg.id, prompt, msg)
  assert.equal(result.outcome, 'admitted')
  assert.equal(result.message.id, msg.id)
  assert.equal(result.message.source.roomId, room.id)
  assert.equal(result.message.source.reviewId, room.goal.reviewAttempt.id)
  assert.ok(calls.length >= 2 && calls.every(([r,m,id]) => r === room && m === msg.id && id === 'r1'))
  const id = room.goal.reviewAttempt.id
  assert.ok(host.rt.goalBlock(room, host.rt.botOf('a'), { nudge:true, reviewId:id }).includes(prompt))
  assert.ok(!host.rt.goalBlock(room, host.rt.botOf('b'), { nudge:true, reviewId:id }).includes(prompt))
  assert.ok(!host.rt.goalBlock(room, host.rt.botOf('a'), { nudge:true, reviewId:'old' }).includes(prompt))
  assert.equal(await host.rt.runScheduledRoomReview(room, key, root, msg.id, prompt), 'duplicate')
  // DSH is about to enter the current step with this relay; it must not leave
  // another waking message in next-turn when that shell closes.
  assert.equal(root.calls.filter(m => m.source.reviewId === id).length, 0)
  assert.equal(saved(host).rooms.r1.scheduledReviewOccurrence.reviewId, id)
  await host.ctx.dispose()
  const next = await start(t, undefined, undefined, undefined, host.home)
  assert.equal(await next.rt.runScheduledRoomReview(next.rt.roomOf('r1'), key, next.agentOf('r1')), 'duplicate')
  assert.equal(next.agentOf('r1').calls.length, 0)
})

test('a no-goal occurrence authorizes the caller fallback once, and a paused or completed goal stays silent', async t => {
  const host = await start(t), room = host.rt.roomOf('r1'), root = host.agentOf('r1')
  const fire = n => host.rt.runScheduledRoomReview(room, JSON.stringify(['room-task', new Date(n).toISOString()]), root)
  assert.equal(await fire(10), 'no-goal')
  assert.equal(await fire(10), 'duplicate')
  assert.equal(await fire(9), 'duplicate')
  await startGoal(host)
  room.goal.status = 'paused'
  assert.equal(await fire(11), 'paused')
  room.goal.status = 'complete'
  assert.equal(await fire(12), 'completed')
  assert.deepEqual(root.calls, [])
})

test('a native pre-step holding the root cannot block the evidence check on its original review', async t => {
  const host = await start(t), goal = await parkForReview(host)
  const room = host.rt.roomOf('r1'), root = host.agentOf('r1')
  await host.rt.testScheduleOccurrence(goal.reviewAt)
  const original = goal.reviewAttempt
  original.adminCompleted = true
  root.inbox.nextTurn.length = 0
  const key = JSON.stringify(['same-group', new Date(goal.reviewAt + GOAL_REVIEW_INTERVAL_MS).toISOString()])
  let finishRoot
  root.whenIdle = () => new Promise(resolve => { finishRoot = resolve })
  assert.equal(await host.rt.runScheduledRoomReview(room, key, root, 'schedule-pre-step'), 'pending')
  assert.equal(goal.reviewAttempt, original)
  assert.equal(root.calls.length, 1)
  finishRoot()
  await settle(() => goal.reviewAttempt === undefined)
  assert.equal(root.calls.length, 1)
})
