import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, truncateSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { afterRound } from './relay-rows.js'
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

async function start(t, room, services, extraRooms, existingHome) {
  const home = existingHome ?? mkdtempSync(join(tmpdir(), 'ds-bot-goal-'))
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
  await tool('list_bots', {}, 'a')
  return { home, ctx, rt, agentOf, emit, tool, call, begin, finish, round, say, takePost, takeGoal }
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

async function parkForReview(host) {
  await startGoal(host)
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
  await host.rt.goalReviewPoll(g.ownerReviewAt)
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
  await host.rt.goalReviewPoll(g.ownerReviewAt)
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
  assert.ok(g.reviewAt - g.updatedAt <= 60_000)
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

test('owner check survives restart without falsely completing remaining tasks', async (t) => {
  const host = await start(t)
  await startGoal(host, { stages: [{ title: 'Draft', acceptance: 'reviewed', tasks: [{ bot: 'Writer', task: 'write' }, { bot: 'Tester', task: 'test' }] }] })
  const g = host.rt.roomOf('r1').goal
  await host.rt.goalReviewPoll(g.ownerReviewAt)
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
  await restarted.rt.goalReviewPoll(restored.reviewAt)
  assert.equal(restarted.agentOf('r1').calls.length, 1)
})

test('owner review completes only after two bounded turns cover all current tasks', async (t) => {
  const host = await start(t)
  await startGoal(host, { stages: [{ title: 'Draft', acceptance: 'reviewed', tasks: [{ bot: 'Writer', task: 'write' }, { bot: 'Tester', task: 'test' }] }] })
  const g = host.rt.roomOf('r1').goal
  await host.rt.goalReviewPoll(g.ownerReviewAt)
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
  await host.rt.goalReviewPoll(g.reviewAt)
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
  await host.rt.goalReviewPoll(g.reviewAt)
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
  await host.rt.goalReviewPoll(g.reviewAt - 1)
  assert.equal(root.calls.length, 0)
  await host.rt.goalReviewPoll(g.reviewAt)
  assert.equal(root.calls.length, 1)
  assert.equal(root.calls[0].source.goal, 'nudge')
  assert.ok(root.calls[0].source.reviewId)
  await host.rt.goalReviewPoll(g.reviewAt + 3_600_000)
  assert.equal(root.calls.length, 1, 'an unresolved review must not be sent twice')
  assert.equal(g.stages[0].tasks[0].status, 'pending')
})

test('a completed review without a current admin slot retires without throwing', async (t) => {
  const host = await start(t)
  const g = await parkForReview(host)
  await host.rt.goalReviewPoll(g.reviewAt)
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
  await host.rt.goalReviewPoll(due)
  assert.equal(host.agentOf('r1').calls.length, 0)
  host.rt.goalUserStopped('r1')
  await host.rt.goalReviewPoll(due + 3_600_000)
  assert.equal(host.agentOf('r1').calls.length, 0)
  assert.equal(g.idleReason, 'user-stop')
  delete g.idleReason
  delete g.idleRevision
  await host.rt.goalReviewPoll(due + 7_200_000)
  assert.equal(host.agentOf('r1').calls.length, 1)
  assert.equal(host.agentOf('r1').calls[0].source.reviewInspect, true)
  assert.equal(g.idle, true)
  assert.equal(g.idleReason, undefined)
})

test('an unresolved same-room batch does not prevent a read-only legacy inspection', async (t) => {
  const host = await start(t)
  const g = await parkForReview(host)
  delete g.idleReason
  delete g.idleRevision
  host.rt.roomBatchPending = () => true
  const original = host.ctx.sessionController.resolveAgent
  host.ctx.sessionController.resolveAgent = async id => { if (id === 'gb') throw new Error('old delivery unknown'); return original(id) }
  await assert.rejects(host.rt.deliver({ toId: 'b', sessionId: 'gb', role: 'room', roomId: 'r1', text: 'old assignment' }))
  host.ctx.sessionController.resolveAgent = original
  await host.rt.goalReviewPoll(g.ownerReviewAt)
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
  await host.rt.goalReviewPoll(g.reviewAt + 3_600_000)
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
  await host.rt.goalReviewPoll(g.ownerReviewAt)
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
  await host.rt.goalReviewPoll(g.reviewAt)
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
  await host.rt.goalReviewPoll(due - 1)
  assert.equal(host.agentOf('r1').calls.length, 0)
  await host.rt.goalReviewPoll(due)
  assert.equal(host.agentOf('r1').calls.length, 1)
  const prompt = host.rt.goalBlock(room, host.rt.state.bots.a, { nudge: true })
  assert.match(prompt, /each distinct owner/)
  assert.match(prompt, /do not duplicate an outstanding or uncertain message/i)
  assert.match(prompt, /assigned independent reviewer/)
})

test('a busy group queues one review behind existing root messages without steering', async (t) => {
  const host = await start(t)
  await startGoal(host)
  const room = host.rt.roomOf('r1')
  const g = room.goal
  const root = host.agentOf('r1')
  const existing = { id: 'already-queued', source: { kind: 'user' } }
  root.inbox.nextTurn.push(existing)
  host.rt.workingInRoom = () => [{ botId: 'b' }]
  host.rt.roomProgress.set('busy-round', { roomId: 'r1' })
  await host.rt.goalReviewPoll(g.ownerReviewAt)
  assert.equal(root.inbox.nextTurn[0], existing)
  assert.equal(root.inbox.nextTurn.length, 2)
  assert.ok(root.inbox.nextTurn[1].source.reviewId)
  await host.rt.goalReviewPoll(g.ownerReviewAt + 3_600_000)
  assert.equal(root.inbox.nextTurn.length, 2)
  assert.equal(root.inbox.nextStep.length, 0)
})

test('a review merged behind another opener is retried on the next poll', async (t) => {
  const host = await start(t)
  const g = await parkForReview(host)
  const room = host.rt.roomOf('r1')
  await host.rt.goalReviewPoll(g.reviewAt)
  const first = host.takeGoal()
  host.agentOf('r1').inbox.nextTurn.length = 0
  await host.rt.goalReviewNotOpened(room, first.source.reviewId)
  const next = g.reviewAt
  await host.rt.goalReviewPoll(next - 1)
  assert.equal(host.agentOf('r1').calls.length, 0)
  await host.rt.goalReviewPoll(next)
  assert.equal(host.agentOf('r1').calls.length, 1)
})

test('a periodic review whose flush fails is never automatically sent again', async (t) => {
  const host = await start(t)
  const g = await parkForReview(host)
  host.ctx.sessions.flush = async () => { throw new Error('disk uncertain') }
  const root = host.agentOf('r1')
  await host.rt.goalReviewPoll(g.reviewAt)
  assert.equal(root.calls.length, 1)
  assert.ok(g.reviewAttempt)
  root.inbox.nextTurn.length = 0 // even an unavailable current inbox cannot establish the result
  await host.rt.goalReviewPoll(g.reviewAt + 7_200_000)
  assert.equal(root.calls.length, 1)
})

test('an admin model failure leaves a visible unresolved review without redispatch', async (t) => {
  const host = await start(t)
  const g = await parkForReview(host)
  await host.rt.goalReviewPoll(g.reviewAt)
  const post = host.takeGoal()
  host.agentOf('r1').inbox.nextTurn.length = 0
  const read = host.round('failed-admin-review', post)
  await settle(() => host.agentOf('ga').calls.length > 0)
  host.begin('ga')
  host.emit('ga', 'turn/end', { turn: 1, reason: { kind: 'error', error: { code: 'FAILED', message: 'model failed' } } })
  await settle(() => read() !== undefined)
  await settle(() => g.reviewAttempt?.state === 'uncertain')
  await host.rt.goalReviewPoll(g.reviewAt + 3_600_000)
  assert.equal(host.agentOf('r1').calls.length, 0)
  assert.match(await host.tool('group_goal', { action: 'show' }, 'ga'), /awaiting|uncertain/)
})

test('a review observed after an uncertain root flush can complete without resending', async (t) => {
  const host = await start(t)
  const g = await parkForReview(host)
  let first = true
  host.ctx.sessions.flush = async () => { if (first) { first = false; throw new Error('uncertain flush') } }
  await host.rt.goalReviewPoll(g.reviewAt)
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
  await host.rt.goalReviewPoll(g.reviewAt)
  const reviewId = g.reviewAttempt.id
  host.ctx.sessions.flush = async () => true
  const body = { roomId: 'r1', goalId: g.id, action: 'review-resolve', reviewId, evidence: 'Confirmed no task was dispatched', confirmed: true }
  assert.ok((await host.call('goal-control', { ...body, confirmed: false })).error)
  assert.ok((await host.call('goal-control', body)).error, 'the original root message remains queued')
  host.agentOf('r1').inbox.nextTurn.length = 0
  assert.equal((await host.call('goal-control', body)).ok, true)
  assert.equal(g.reviewAttempt, undefined)
  assert.equal(g.events.at(-1).kind, 'review-resolved')
  await host.rt.goalReviewPoll(g.reviewAt - 1)
  assert.equal(host.agentOf('r1').calls.length, 1)
  await host.rt.goalReviewPoll(g.reviewAt)
  assert.equal(host.agentOf('r1').calls.length, 2)
})

test('review recovery cannot bypass pause or user stop but works after explicit resume', async (t) => {
  const host = await start(t)
  const g = await parkForReview(host)
  await host.rt.goalReviewPoll(g.reviewAt)
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
  await host.rt.goalReviewPoll(Date.now() + 3_600_000)
  assert.equal(g.idleReason, 'user-stop')
})

test('user-stopped uncertain review requires explicit resume before resolution', async (t) => {
  const host = await start(t)
  const g = await parkForReview(host)
  await host.rt.goalReviewPoll(g.reviewAt)
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
  await host.rt.goalReviewPoll(g.reviewAt)
  const reviewId = g.reviewAttempt.id
  await host.ctx.dispose()
  const restarted = await start(t, undefined, undefined, undefined, host.home)
  const restored = restarted.rt.roomOf('r1').goal
  assert.equal(restored.reviewAttempt.id, reviewId)
  const failures = []
  restarted.rt.noteFailure = failure => failures.push(failure)
  await restarted.rt.goalReviewPoll(restored.reviewAt + 3_600_000)
  assert.equal(restarted.agentOf('r1').calls.length, 0)
  assert.equal(failures[0]?.code, 'GOAL_REVIEW_UNCERTAIN')
  assert.match(failures[0]?.text, new RegExp(reviewId))
})

test('a persisted admin completion can rearm after runtime restart', async (t) => {
  const host = await start(t)
  const g = await parkForReview(host)
  const firstDue = g.reviewAt
  await host.rt.goalReviewPoll(firstDue)
  g.reviewAttempt.adminCompleted = true // persisted completion before round finalization
  await host.rt.save({ required: true })
  await host.ctx.dispose()
  const restarted = await start(t, undefined, undefined, undefined, host.home)
  const restored = restarted.rt.roomOf('r1').goal
  await restarted.rt.goalReviewPoll(firstDue + 1000)
  assert.equal(restored.reviewAttempt, undefined)
  assert.equal(restarted.agentOf('r1').calls.length, 0)
  await restarted.rt.goalReviewPoll(restored.reviewAt)
  assert.equal(restarted.agentOf('r1').calls.length, 1)
})

test('a real prepared worker delivery blocks completed review recovery after restart', async (t) => {
  const host = await start(t)
  const g = await parkForReview(host)
  const firstDue = g.reviewAt
  await host.rt.goalReviewPoll(firstDue)
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
  await restarted.rt.goalReviewPoll(firstDue + 1000)
  assert.ok(restored.reviewAttempt)
  await restarted.rt.goalReviewPoll(firstDue + 3_600_000)
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
  await host.rt.goalReviewPoll(g.reviewAt)
  assert.equal(host.agentOf('r1').calls.length, 1)
})

test('legacy same-room recovery notes permit only inspection and cannot dispatch workers', async (t) => {
  const host = await start(t)
  const g = await parkForReview(host)
  const original = host.ctx.sessionController.resolveAgent
  host.ctx.sessionController.resolveAgent = async id => { if (id === 'gb') throw new Error('legacy note'); return original(id) }
  await assert.rejects(host.rt.deliver({ toId: 'b', sessionId: 'gb', role: 'room', roomId: 'r1', text: 'historical assignment' }))
  host.ctx.sessionController.resolveAgent = original
  await host.rt.goalReviewPoll(g.reviewAt)
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
  await host.rt.goalReviewPoll(g.reviewAt)
  assert.equal(host.agentOf('r1').calls.length, 1)
  assert.equal(host.agentOf('r1').calls[0].source.reviewInspect, true)
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
    await host.rt.goalReviewPoll(g.reviewAt)
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
  await host.rt.goalReviewPoll(g.reviewAt)
  const post = host.takeGoal()
  host.agentOf('r1').inbox.nextTurn.length = 0
  const read = host.round('blocked-inspection', post)
  await settle(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')
  host.emit('ga', 'turn/end', { turn: 1, reason: { kind: 'blocked' } })
  await settle(() => read() !== undefined)
  assert.equal(g.reviewAttempt?.state, 'uncertain')
  await host.rt.goalReviewPoll(g.reviewAt + 3_600_000)
  assert.equal(host.agentOf('r1').calls.length, 0)
})

test('confirmed inspection recovery remains read-only while legacy notes remain unresolved', async (t) => {
  const host = await start(t)
  const g = await parkForReview(host)
  const original = host.ctx.sessionController.resolveAgent
  host.ctx.sessionController.resolveAgent = async id => { if (id === 'gb') throw new Error('legacy note'); return original(id) }
  await assert.rejects(host.rt.deliver({ toId: 'b', sessionId: 'gb', role: 'room', roomId: 'r1', text: 'historical assignment' }))
  host.ctx.sessionController.resolveAgent = original
  await host.rt.goalReviewPoll(g.reviewAt)
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
  await host.rt.goalReviewPoll(g.reviewAt)
  assert.equal(host.agentOf('r1').calls.length, 1)
  assert.equal(host.agentOf('r1').calls[0].source.reviewInspect, true)
  assert.equal(host.agentOf('gb').calls.length, 0)
})

test('a user request arriving during inspection waits for its own normal round', async (t) => {
  const host = await start(t)
  const g = await parkForReview(host)
  const original = host.ctx.sessionController.resolveAgent
  host.ctx.sessionController.resolveAgent = async id => { if (id === 'gb') throw new Error('legacy note'); return original(id) }
  await assert.rejects(host.rt.deliver({ toId: 'b', sessionId: 'gb', role: 'room', roomId: 'r1', text: 'historical assignment' }))
  host.ctx.sessionController.resolveAgent = original
  await host.rt.goalReviewPoll(g.reviewAt)
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
  await host.rt.goalReviewPoll(g.reviewAt)
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
  await host.rt.goalReviewPoll(g.reviewAt)
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

test('resume of a paused goal does not dispatch with an unresolved review', async (t) => {
  const host = await start(t)
  const g = await parkForReview(host)
  await host.rt.goalReviewPoll(g.reviewAt)
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
  assert.equal(held.turn, undefined, 'turn number is not in the original durable note')
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
  writeFileSync(join(restarted.home, 'state.lock'), JSON.stringify({ pid: 1, token: 'a-different-owner' }))
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
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-goal-'))
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
  await host.rt.goalReviewPoll(g.reviewAt)
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
  await host.rt.goalReviewPoll(g.reviewAt)
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
  await restarted.rt.goalReviewPoll(due)
  assert.equal(restarted.agentOf('r1').calls.length, 1)
})

test('an old host stop invalidates auto-idle evidence across a runtime restart', async (t) => {
  const host = await start(t)
  const g = await parkForReview(host)
  g.revision += 1 // an old version records stop but leaves fields it does not understand
  await host.rt.save({ required: true })
  await host.ctx.dispose()
  const restarted = await start(t, undefined, undefined, undefined, host.home)
  await restarted.rt.goalReviewPoll(g.reviewAt + 3_600_000)
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
  const review = host.rt.goalReviewPoll(g.reviewAt)
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
  await host.rt.goalReviewPoll(g.reviewAt)
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
  await host.rt.goalReviewPoll(g.reviewAt)
  assert.equal(host.agentOf('r1').calls.length, 1)
})

test('a long-running admin review holds its attempt until its actual turn completes', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const host = await start(t)
  const g = await parkForReview(host)
  await host.rt.goalReviewPoll(g.reviewAt)
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
  await host.rt.goalReviewPoll(g.reviewAt + 3_600_000)
  assert.equal(host.agentOf('r1').calls.length, 0)
  host.finish('ga', '[PASS]')
  await settle(() => g.reviewAttempt === undefined)
  await host.rt.goalReviewPoll(g.reviewAt)
  assert.equal(host.agentOf('r1').calls.length, 1)
})

test('admin completion between the grace timer and round finalization is retained', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const host = await start(t)
  const g = await parkForReview(host)
  await host.rt.goalReviewPoll(g.reviewAt)
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
  await host.rt.goalReviewPoll(g.reviewAt)
  assert.equal(host.agentOf('r1').calls.length, 1)
})

test('an admin review waiting for approval resumes without duplicate review', async (t) => {
  const host = await start(t)
  const g = await parkForReview(host)
  await host.rt.goalReviewPoll(g.reviewAt)
  const post = host.takeGoal()
  host.agentOf('r1').inbox.nextTurn.length = 0
  const read = host.round('review-approval', post)
  await settle(() => host.agentOf('ga').calls.length > 0)
  host.begin('ga')
  host.emit('ga', 'tool/call', { callId: 'k1', name: 'pwsh', arguments: '{}' })
  const approval = host.ctx.listeners.get('approval/request')[0]({ agent: { session: { id: 'ga' } }, toolName: 'pwsh', reason: 'approval', callId: 'k1' }, () => 'from-dsh')
  await settle(() => read() !== undefined)
  assert.ok(g.reviewAttempt)
  await host.rt.goalReviewPoll(g.reviewAt + 3_600_000)
  assert.equal(host.agentOf('r1').calls.length, 0)
  const [pending] = host.rt.approvalsView()
  assert.equal((await host.call('approval-answer', { id: pending.id, choice: 'allow' })).ok, true)
  assert.equal(await approval, 'allowed-once')
  host.emit('ga', 'tool/result', { callId: 'k1' })
  host.finish('ga', '[PASS]')
  await settle(() => g.reviewAttempt === undefined)
  await host.rt.goalReviewPoll(g.reviewAt)
  assert.equal(host.agentOf('r1').calls.length, 1)
})

test('a periodic review can dispatch the work the admin calls out', async (t) => {
  const host = await start(t)
  const g = await parkForReview(host)
  await host.rt.goalReviewPoll(g.reviewAt)
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
  await host.rt.goalReviewPoll(g.reviewAt)
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
  await host.rt.goalReviewPoll(g.reviewAt)
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

test('a review mixed behind a user post is retired before the normal follow-up check', async (t) => {
  const host = await start(t)
  const g = await parkForReview(host)
  await host.rt.goalReviewPoll(g.reviewAt)
  const post = host.takeGoal()
  host.agentOf('r1').inbox.nextTurn.length = 0
  host.emit('r1', 'user/message', host.say('@Chief decide the new request'))
  const read = host.round('mixed-review', post)
  await settle(() => host.agentOf('ga').calls.length > 0)
  host.begin('ga')
  host.finish('ga', '[PASS]')
  await settle(() => read() !== undefined)
  assert.equal(g.reviewAttempt, undefined)
  assert.equal(host.agentOf('r1').calls.length, 1)
  assert.equal(host.agentOf('r1').calls[0].source.goal, 'nudge')
})

for (const change of ['admin', 'member', 'root', 'stop']) {
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
    const poll = host.rt.goalReviewPoll(g.reviewAt)
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
  })
}

test('a stop during admin resolution prevents a queued periodic review from reaching the admin', async (t) => {
  const host = await start(t)
  const g = await parkForReview(host)
  await host.rt.goalReviewPoll(g.reviewAt)
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
  await host.rt.goalReviewPoll(g.reviewAt)
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
  await host.rt.goalReviewPoll(g.reviewAt)
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
  await host.rt.goalReviewPoll(g.updatedAt + 30 * 60 * 1000 - 1)
  assert.equal(host.agentOf('r1').calls.length, 0)
  await host.rt.goalReviewPoll(g.updatedAt + 30 * 60 * 1000)
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
  const poll = host.rt.goalReviewPoll(g.reviewAt)
  await resolving
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
  assert.deepEqual(revised.stages.map(stage => [stage.id, stage.status]), [['s1', 'passed'], ['s3', 'active'], ['s4', 'pending']])
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

test('events keep the newest 50 and pastGoals keep 5', async (t) => {
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
  assert.equal(room.pastGoals.length, 5)
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

test('an idle round wakes the admin for a goal check; [PASS] waits for the user', async (t) => {
  const host = await start(t)
  await startGoal(host)
  // A user-message round ends with nothing running: the goal check queues once.
  const first = host.round('c1', host.say('@Chief go'))
  await settle(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')
  host.finish('ga', 'on it')
  await settle(() => first() !== undefined)
  const nudge = host.takeGoal()
  assert.ok(nudge !== undefined, 'one goal check was queued')
  assert.match(text(nudge), /^\[Goal check\]$/)
  // The check opens a round on the admin alone, with the goal-check line.
  const check = host.round('c2', nudge)
  await settle(() => host.agentOf('ga').calls.length === 2)
  const prompt = text(host.agentOf('ga').calls[1])
  assert.match(prompt, /goal check/)
  assert.match(prompt, /Goal check from DS Bot/)
  host.begin('ga')
  host.finish('ga', '[PASS]')
  await settle(() => check() !== undefined)
  assert.equal(goal(host).idle, true)
  assert.equal(host.agentOf('r1').calls.filter(call => call.source?.role === 'goal' && call.source.goal === 'nudge').length, 0)
})

test('two goal checks without progress mark the goal idle; a user message clears it', async (t) => {
  const host = await start(t)
  await startGoal(host)
  const first = host.round('c1', host.say('@Chief go'))
  await settle(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')
  host.finish('ga', 'on it')
  await settle(() => first() !== undefined)
  // The first check: the admin only runs its own tools — that is not progress, so
  // the next check still queues.
  const one = host.round('c2', host.takeGoal())
  await settle(() => host.agentOf('ga').calls.length === 2)
  host.begin('ga')
  host.emit('ga', 'tool/call', { callId: 'k1', name: 'list_bots', arguments: '{}' })
  host.finish('ga', 'waiting on the user')
  await settle(() => one() !== undefined)
  assert.equal(goal(host).nudges, 2)
  // The second check: same, so the goal waits for the user instead.
  const two = host.round('c3', host.takeGoal())
  await settle(() => host.agentOf('ga').calls.length === 3)
  host.begin('ga')
  host.finish('ga', 'still waiting')
  await settle(() => two() !== undefined)
  assert.equal(goal(host).idle, true)
  // A user message clears the idle wait and the count starts over.
  const third = host.round('c4', host.say('@Chief new ask'))
  await settle(() => host.agentOf('ga').calls.length === 4)
  host.begin('ga')
  host.finish('ga', '[PASS]')
  await settle(() => third() !== undefined)
  assert.deepEqual([goal(host).idle, goal(host).nudges], [undefined, 1])
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
  await startGoal(host)
  // Drive the goal to idle: a user round, then two checks the admin passes on.
  const first = host.round('c1', host.say('@Chief go'))
  await settle(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')
  host.finish('ga', '[PASS]')
  await settle(() => first() !== undefined)
  const one = host.round('c2', host.takeGoal())
  await settle(() => host.agentOf('ga').calls.length === 2)
  host.begin('ga')
  host.finish('ga', 'waiting')
  await settle(() => one() !== undefined)
  const two = host.round('c3', host.takeGoal())
  await settle(() => host.agentOf('ga').calls.length === 3)
  host.begin('ga')
  host.finish('ga', 'still waiting')
  await settle(() => two() !== undefined)
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

test('a member still working at round end wakes the admin when its work settles', async (t) => {
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

test('read-only review asks for show and does not count silent pass as successful inspection', async (t) => {
  const host = await start(t); const g = await parkForReview(host)
  const original = host.ctx.sessionController.resolveAgent
  host.ctx.sessionController.resolveAgent = async id => { if (id === 'gb') throw new Error('legacy note'); return original(id) }
  await assert.rejects(host.rt.deliver({ toId: 'b', sessionId: 'gb', role: 'room', roomId: 'r1', text: 'historical assignment' }))
  host.ctx.sessionController.resolveAgent = original
  await host.rt.goalReviewPoll(g.reviewAt); const post = host.takeGoal(); host.agentOf('r1').inbox.nextTurn.length = 0
  const read = host.round('inspect-without-show', post); await settle(() => host.agentOf('ga').calls.length > 0)
  const input = host.begin('ga')
  assert.match(text(input), /first action must be group_goal show/)
  assert.doesNotMatch(text(input), /For each current unfinished task you actually checked, call group_goal review-check/)
  host.finish('ga', '[PASS]'); await settle(() => read() !== undefined)
  assert.equal(g.lastInspection?.status, 'not-generated'); assert.equal(g.lastOwnerReview, undefined)
  assert.deepEqual(g.ownerReview?.checks, {}); assert.equal(host.agentOf('gb').calls.length, 0)
  assert.ok(g.ownerReviewAt > g.lastInspection.at)
})

test('read-only review records only a successful show, never owner checks', async (t) => {
  const host = await start(t); const g = await parkForReview(host)
  const original = host.ctx.sessionController.resolveAgent
  host.ctx.sessionController.resolveAgent = async id => { if (id === 'gb') throw new Error('legacy note'); return original(id) }
  await assert.rejects(host.rt.deliver({ toId: 'b', sessionId: 'gb', role: 'room', roomId: 'r1', text: 'historical assignment' }))
  host.ctx.sessionController.resolveAgent = original
  await host.rt.goalReviewPoll(g.reviewAt); const post = host.takeGoal(); host.agentOf('r1').inbox.nextTurn.length = 0
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
    await host.rt.goalReviewPoll(g.reviewAt); const post = host.takeGoal(); host.agentOf('r1').inbox.nextTurn.length = 0
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
    await host.rt.goalReviewPoll(Date.now() + 3_600_000)
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
    await host.rt.goalReviewPoll(g.reviewAt); const post = host.takeGoal(); host.agentOf('r1').inbox.nextTurn.length = 0
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
  await host.rt.goalReviewPoll(g.reviewAt); const post = host.takeGoal(); host.agentOf('r1').inbox.nextTurn.length = 0
  const read = host.round('inspect-invalid-idle', post); await settle(() => host.agentOf('ga').calls.length > 0); host.begin('ga')
  assert.match(await host.tool('group_goal', { action: 'show' }, 'ga'), /Goal:/)
  g.revision += 1 // Invalidates idleRevision without asserting who changed it.
  host.finish('ga', '[PASS]'); await settle(() => read() !== undefined)
  assert.equal(g.lastInspection, undefined); assert.ok(g.reviewAttempt)
  assert.equal(g.lastOwnerReview, undefined); assert.equal(host.agentOf('gb').calls.length, 0)
  await host.rt.goalReviewPoll(Date.now() + 3_600_000)
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
  await host.rt.goalReviewPoll(g.reviewAt)
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

test('a scoped check becomes unresolved if the queue changes while its save is pending', async t=>{
  const host=await start(t)
  await startGoal(host,{stages:[{title:'Draft',acceptance:'reviewed',tasks:[{bot:'Writer',task:'write'},{bot:'Tester',task:'test'}]}]})
  const g=host.rt.roomOf('r1').goal
  await host.rt.goalDrive(host.rt.roomOf('r1'),{goalNudge:true,slots:[{id:'a',status:'passed'}]})
  const original=host.ctx.sessionController.resolveAgent
  host.ctx.sessionController.resolveAgent=async id=>{if(id==='gb'||id==='gc')throw Error('held delivery');return original(id)}
  await assert.rejects(host.rt.deliver({toId:'b',sessionId:'gb',role:'room',roomId:'r1',text:'old work'}))
  await host.rt.goalReviewPoll(g.reviewAt)
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
  await host.rt.goalReviewPoll(g.reviewAt)
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
  await host.rt.goalReviewPoll(g.ownerReviewAt)
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
  const home=mkdtempSync(join(tmpdir(),'ds-bot-old-room-'))
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
