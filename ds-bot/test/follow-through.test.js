import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { afterRound } from './relay-rows.js'
import { setTimeout as realDelay } from 'node:timers/promises'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'
import { stripWrittenCalls, writesToolCall } from '../src/host/turns.js'
import { writeNotesAtomically } from '../src/host/resume.js'
import { errorCode } from '../src/host/channel.js'

// Chief in its own chat 'a'; Writer, the admin of group 'r1', speaks there from 'gb'.
const seed = () => ({
  version: 1,
  mainBotIds: ['a'],
  bots: {
    a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1 },
    b: { id: 'b', name: 'Writer', role: 'Write', sessionId: 'b', createdAt: 2 },
  },
  rooms: { r1: { id: 'r1', name: 'Ops', members: ['a', 'b'], mode: 'admin', admin: 'b', named: true, sessions: { b: 'gb' }, log: [], seq: 0, seen: {} } },
  agents: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
  prefs: {},
  revision: 0,
})

// One DS Bot host on `home`; a second start on the same home is a restart.
// Hosts by home: a home is removed only after its hosts stopped and their writes landed.
let rt
const started = new Map()

// The durable logs DSH keeps, by Session: what a Session's turns did and said.
// `inspect` stands in for DSH reading that log, when a test cannot read it.
async function start(home, logs, inspect) {
  const ctx = fakeContext()
  const agents = new Map()
  const agentOf = (sessionId) => {
    if (!agents.has(sessionId)) {
      const calls = []
      const inbox = { nextStep: [], nextTurn: [], remove: () => false }
      const keep = (message) => { calls.push(message) }
      agents.set(sessionId, { session: { id: sessionId }, calls, inbox, followup: keep, steer: keep, cancel() {} })
    }
    return agents.get(sessionId)
  }
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async path => ({ id: 'w1', path }), archiveSession: async () => {} },
    sessionController: {
      create: async () => ({ sessionId: 's1' }),
      resolveAgent: async sessionId => ({ agent: agentOf(sessionId) }),
      selectModel: async () => {},
      inspect: inspect ?? (async sessionId => ({ events: logs?.get(sessionId) ?? [] })),
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => { route = options; return register(options) }
  rt = createRuntime(ctx, { home })
  let seq = 0
  const emit = (id, type, data) => {
    // A Session already resolved by the test stands in for the one DSH emits, so a
    // test can give it a route or a size; otherwise only the id is known.
    const session = agents.get(id)?.session ?? { id }
    for (const listener of ctx.listeners.get('session/event') ?? []) {
      if (listener.length >= 2) listener(session, { type, seq: ++seq, data })
    }
  }
  const tool = (name, args, sessionId, exec = {}) => rt.teamTools.find(d => d.name === name).execute(args, { agent: { id: sessionId }, ...exec })
  const askApproval = sessionId => ctx.listeners.get('approval/request')[0]({ agent: { session: { id: sessionId } }, toolName: 'pwsh', reason: 'escalate sandbox' }, () => 'from-dsh')
  const call = async (endpoint, payload) => (await route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))).json()
  await tool('list_bots', {}, 'a')
  const host = { rt, ctx, agentOf, emit, tool, call, askApproval, stop: () => ctx.dispose() }
  started.set(home, [...(started.get(home) ?? []), host])
  return host
}

const freshHome = (t, state = seed()) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-follow-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(state))
  t.after(async () => {
    await Promise.all((started.get(home) ?? []).map(host => host.stop()))
    started.delete(home)
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })
  return home
}
const stateOf = home => JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))

test('ignore and undo retain the interrupted record, reject another scope and survive restart', async (t) => {
  const home = freshHome(t), id = 'a'.repeat(64)
  const record = {botId:'b',roomId:'r1',turn:7,trigger:{role:'room',exchangeId:'ex'}}
  writeFileSync(join(home,'inflight.json'),JSON.stringify({turns:{},queued:{},heldTurns:{[id]:{sessionId:'gb',record,reason:'interrupted outcome unknown'}}}))
  const host = await start(home)
  const scope = {kind:'room',id:'r1'}
  assert.equal((await host.rt.recoveryHeldView(scope)).items[0].decision,'open')
  await assert.rejects(host.rt.setHeldDecision({kind:'room',id:'other'},id,0,'ignored'))
  assert.deepEqual(await host.rt.setHeldDecision(scope,id,0,'ignored'),{decision:'ignored',revision:1})
  assert.deepEqual(await host.rt.setHeldDecision(scope,id,0,'ignored'),{decision:'ignored',revision:1})
  await assert.rejects(host.rt.setHeldDecision(scope,id,0,'open'))
  assert.deepEqual(notes(home).heldTurns[id].record,record)
  assert.equal(notes(home).heldTurns[id].decisions.length,1)
  await host.stop()
  const restarted = await start(home)
  const saved = (await restarted.rt.recoveryHeldView(scope)).items[0]
  assert.equal(saved.decision,'ignored')
  assert.equal(saved.status,'uncertain')
  assert.deepEqual(await restarted.rt.setHeldDecision(scope,id,1,'open'),{decision:'open',revision:2})
  assert.deepEqual(notes(home).heldTurns[id].record,record)
  assert.deepEqual(notes(home).heldTurns[id].decisions.map(item=>item.choice),['ignored','open'])
})
// The team file is written in the background, and Windows may hold it busy for a
// moment: the retry waits on the clock, which the tests mock.
const settleState = async (t, home, check) => {
  const deadline = performance.now() + 3000
  while (!check() && performance.now() < deadline) {
    t.mock.timers.tick(100)
    await realDelay(10)
  }
  assert.ok(check(), 'condition not reached')
}
const settle = async (check) => {
  const until = Date.now() + 3000
  while (!check() && Date.now() < until) await new Promise(resolve => setImmediate(resolve))
  assert.ok(check(), 'condition not reached')
}
const text = message => message.content.map(block => block.text ?? '').join('\n')
const notes = (home) => {
  try { return JSON.parse(readFileSync(join(home, 'inflight.json'), 'utf8')) } catch { return { turns: {}, queued: {} } }
}
// The diagnostics log, once the plugin's background write of it landed.
const readDiagnostics = async (home, wanted = () => true) => {
  const deadline = performance.now() + 3000
  while (performance.now() < deadline) {
    try {
      const text = readFileSync(join(home, 'logs', 'diagnostics.jsonl'), 'utf8')
      const entries = text.trim() === '' ? [] : text.trim().split('\n').map(line => JSON.parse(line))
      // The log is written in the background: wait for the entry a test is after.
      if (wanted(entries)) return entries
    } catch {}
    await realDelay(10)
  }
  return []
}
const inflight = home => notes(home).turns ?? {}
// A message as DSH would replay it: the turn starts and takes it up.
const run = (host, sessionId, turn, message) => {
  host.emit(sessionId, 'turn/start', { turn })
  host.emit(sessionId, 'user/message', { content: message.content, source: message.source })
}

// Starts a round in 'r1' and opens Writer's turn in 'gb'.
async function openRoomTurn(t, host) {
  let result
  const stop = new AbortController()
  t.after(() => stop.abort())
  void host.tool('group_relay', {}, 'r1', { callId: 'c1', signal: stop.signal }).then(async (value) => { result = await afterRound(rt, 'r1', value) })
  await settle(() => host.agentOf('gb').calls.length === 1)
  run(host, 'gb', 1, host.agentOf('gb').calls[0])
  return () => result
}

test('a group turn cut off by a restart is picked up once, and the group is told', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const home = freshHome(t)
  const first = await start(home)
  await openRoomTurn(t, first)
  void first.askApproval('gb')
  await settle(() => inflight(home).gb?.approval !== undefined)
  assert.deepEqual([inflight(home).gb.botId, inflight(home).gb.roomId, inflight(home).gb.trigger.role], ['b', 'r1', 'room'])
  await first.stop()

  const second = await start(home)
  t.mock.timers.tick(3000)
  await settle(() => second.agentOf('gb').calls.length === 1)
  const post = second.agentOf('r1').calls[0]
  assert.deepEqual([post.source.role, post.source.resumed, post.source.quiet, post.source.senderSessionId], ['post', true, true, 'b'])
  const resumed = second.agentOf('gb').calls[0]
  assert.deepEqual([resumed.source.role, resumed.source.resumed, resumed.source.roomId], ['room', true, 'r1'])
  assert.match(text(resumed), /^\[Group chat "Ops" · picking up after a restart\]/)
  assert.match(text(resumed), /approval to run pwsh \(escalate sandbox\)/)
  await settle(() => Object.keys(inflight(home)).length === 0)

  // The group shows the event, and the admin reads it on its next turn.
  second.emit('r1', 'user/message', { content: post.content, source: post.source })
  const relay = await afterRound(rt, 'r1', await second.tool('group_relay', {}, 'r1', { callId: 'c2', signal: new AbortController().signal }))
  assert.deepEqual(relay.replies.map(reply => [reply.kind, reply.name]), [['resumed', 'Writer']])
  const state = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
  assert.equal(state.rooms.r1.log.at(-1).kind, 'resumed')

  // Cut off again while picking it up: the group hears it, and the turn stays stopped.
  run(second, 'gb', 2, resumed)
  await settle(() => inflight(home).gb?.resumed === true)
  await second.stop()
  const third = await start(home)
  t.mock.timers.tick(3000)
  await settle(() => third.agentOf('r1').calls.length === 1)
  assert.equal(third.agentOf('r1').calls[0].source.again, true)
  assert.equal(third.agentOf('gb').calls.length, 0)
})

test('a request cut off by a restart goes on under the same exchange; own-chat work resumes in the chat', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const home = freshHome(t)
  const first = await start(home)
  run(first, 'b', 1, { content: [{ type: 'text', text: '[Message from Chief]\nDraft the plan' }], source: { kind: 'bot', form: 'relay', role: 'request', exchangeId: 'x1', senderName: 'Chief', senderSessionId: 'a', hop: 0 } })
  run(first, 'a', 1, { content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } })
  await settle(() => inflight(home).b?.trigger !== undefined && inflight(home).a !== undefined)
  await first.stop()

  const second = await start(home)
  t.mock.timers.tick(3000)
  await settle(() => second.agentOf('b').calls.length === 1 && second.agentOf('a').calls.length === 1)
  const request = second.agentOf('b').calls[0]
  assert.deepEqual([request.source.role, request.source.exchangeId, request.source.senderSessionId, request.source.resumed], ['request', 'x1', 'a', true])
  assert.match(text(request), /^\[Message from Chief · DeepSeek Harness restarted while you were working on it\]/)
  const own = second.agentOf('a').calls[0]
  assert.deepEqual([own.source.role, own.source.resumed], ['resume', true])
  assert.match(text(own), /^\[DeepSeek Harness restarted while you were working\]/)
  const state = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
  assert.equal(state.exchanges.length, 0)
})

test('when only DS Bot restarts, a turn still running or finished meanwhile is not picked up', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const home = freshHome(t)
  const first = await start(home)
  run(first, 'b', 1, { content: [{ type: 'text', text: '[Message from Chief]\nDraft the plan' }], source: { kind: 'bot', form: 'relay', role: 'request', exchangeId: 'x1', senderName: 'Chief', senderSessionId: 'a', hop: 0 } })
  run(first, 'a', 1, { content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } })
  await settle(() => inflight(home).b?.trigger !== undefined && inflight(home).a !== undefined)
  await first.stop()

  // DSH went on: Writer is still at work, and Chief's turn ends before the pick-up.
  const second = await start(home)
  second.agentOf('b').status = 'running'
  second.emit('a', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  t.mock.timers.tick(3000)
  // One read per check: two reads can see the old notes and the cleared ones.
  await settle(() => {
    const noted = inflight(home)
    return noted.b?.trigger?.exchangeId === 'x1' && noted.a === undefined
  })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual([second.agentOf('a').calls.length, second.agentOf('b').calls.length], [0, 0])

  // Writer's turn stays noted, so a real restart still picks it up.
  second.emit('b', 'turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'disposed' } } })
  await second.stop()
  const third = await start(home)
  t.mock.timers.tick(3000)
  await settle(() => third.agentOf('b').calls.length === 1)
  assert.deepEqual([third.agentOf('b').calls[0].source.exchangeId, third.agentOf('a').calls.length], ['x1', 0])
})

// Chief asks Writer for the plan; Writer's turn takes it up and the work waits.
const askWriter = async (host, home) => {
  await host.tool('message_bot', { to: 'Writer', message: 'Draft the plan' }, 'a')
  const request = host.agentOf('b').calls[0]
  run(host, 'b', 1, request)
  await settle(() => inflight(home).b?.trigger?.exchangeId === request.source.exchangeId)
  return request
}

// The durable log of Writer's Session: the turn that took the request up, and what it said.
const writerLog = (request, said, reason = { kind: 'completed' }, route) => [
  ...(route === undefined ? [] : [{ type: 'request/context', seq: 0, data: route }]),
  { type: 'turn/start', seq: 1, data: { turn: 1 } },
  { type: 'user/message', seq: 2, data: { source: request.source, content: request.content } },
  ...(said === undefined ? [] : [{ type: 'assistant/message', seq: 3, data: { turn: 1, message: { content: [{ type: 'text', text: said }] } } }]),
  { type: 'turn/end', seq: 4, data: { turn: 1, reason } },
]

for (const role of ['reply', 'report', 'resume']) {
  test(`a completed ${role} turn hands its continued work back after a plugin restart`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const state = seed()
    state.bots.c = { id: 'c', name: 'Reviewer', sessionId: 'c', createdAt: 3 }
    state.works = { x1: { from: 'a', to: 'b', open: [], results: [{ id: 'y1', name: 'Reviewer', text: 'The numbers check out.' }], at: 1 } }
    const home = freshHome(t, state)
    const logs = new Map()
    const first = await start(home, logs)
    const request = { content: [{ type: 'text', text: 'Go on with the plan.' }], source: { kind: 'bot', form: 'relay', role, exchangeId: 'continuation-1', work: 'x1', ...(role === 'reply' ? { senderSessionId: 'c', replyTo: 'y1' } : {}) } }
    run(first, 'b', 1, request)
    await settle(() => inflight(home).b?.trigger?.work === 'x1')
    logs.set('b', writerLog(request, 'The final plan is ready.'))
    await first.stop()
    const second = await start(home, logs)
    second.emit('b', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
    t.mock.timers.tick(3000)
    await settle(() => second.agentOf('a').calls.length === 1)
    const reply = second.agentOf('a').calls[0]
    assert.equal(reply.source.replyTo, 'x1')
    assert.match(text(reply), /The final plan is ready/)
    assert.match(text(reply), /The numbers check out/)
    assert.equal(second.agentOf('c').calls.length, 0)
    await settleState(t, home, () => stateOf(home).works?.x1 === undefined)
  })
}

test('an answer a turn produced while DS Bot was not watching goes to the Bot that waits for it, once', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const home = freshHome(t)
  const logs = new Map()
  const first = await start(home, logs)
  const request = await askWriter(first, home)
  const exchangeId = request.source.exchangeId
  // Writer answers, and DS Bot restarts before it sees the end of that turn.
  logs.set('b', writerLog(request, 'The plan is ready.'))
  await first.stop()

  const second = await start(home, logs)
  second.emit('b', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  t.mock.timers.tick(3000)
  await settle(() => second.agentOf('a').calls.length === 1)
  const reply = second.agentOf('a').calls[0]
  assert.deepEqual([reply.source.role, reply.source.replyTo], ['reply', exchangeId])
  assert.match(text(reply), /The plan is ready\./)
  // The work is settled, and the request is not run again.
  await settleState(t, home, () => stateOf(home).works?.[exchangeId] === undefined)
  assert.equal(second.agentOf('b').calls.length, 0)

  // Chief reads the answer; another restart finds nothing left to settle.
  second.emit('a', 'user/message', { content: reply.content, source: reply.source })
  await settleState(t, home, () => Object.keys(notes(home).queued ?? {}).length === 0)
  await second.stop()
  const third = await start(home, logs)
  t.mock.timers.tick(3000)
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual([third.agentOf('a').calls.length, third.agentOf('b').calls.length], [0, 0])
})

test('a turn whose record cannot be read says the result is unknown, and is not run again', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const home = freshHome(t)
  const logs = new Map()
  const first = await start(home, logs)
  const request = await askWriter(first, home)
  const exchangeId = request.source.exchangeId
  logs.set('b', writerLog(request, 'The plan is ready.'))
  await first.stop()

  // DSH cannot read that Session's record: whether the turn answered cannot be
  // established, so the sender is told that, and the work is not run again.
  const unreadable = async () => { throw new Error('session not found') }
  const second = await start(home, logs, unreadable)
  second.emit('b', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  t.mock.timers.tick(3000)
  await settle(() => second.agentOf('a').calls.length === 1)
  const reply = second.agentOf('a').calls[0]
  assert.deepEqual([reply.source.role, reply.source.replyTo], ['reply', exchangeId])
  assert.match(text(reply), /what it did is unknown/)
  // The work is settled, and the request is not run again.
  await settleState(t, home, () => stateOf(home).works?.[exchangeId] === undefined)
  assert.equal(second.agentOf('b').calls.length, 0)

  // Another restart finds nothing left to settle: nothing is said or run twice.
  second.emit('a', 'user/message', { content: reply.content, source: reply.source })
  await settleState(t, home, () => Object.keys(notes(home).queued ?? {}).length === 0)
  await second.stop()
  const third = await start(home, logs)
  t.mock.timers.tick(3000)
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual([third.agentOf('a').calls.length, third.agentOf('b').calls.length], [0, 0])
})

test('a turn that ended without saying anything says it finished', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const home = freshHome(t)
  const logs = new Map()
  const first = await start(home, logs)
  const request = await askWriter(first, home)
  const exchangeId = request.source.exchangeId
  logs.set('b', writerLog(request, undefined))
  await first.stop()

  const second = await start(home, logs)
  second.emit('b', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  t.mock.timers.tick(3000)
  await settle(() => second.agentOf('a').calls.length === 1)
  const reply = second.agentOf('a').calls[0]
  assert.deepEqual([reply.source.role, reply.source.replyTo], ['reply', exchangeId])
  assert.match(text(reply), /Writer finished without a reply\./)
  // The work is settled, and the request is not run again.
  await settleState(t, home, () => stateOf(home).works?.[exchangeId] === undefined)
  assert.equal(second.agentOf('b').calls.length, 0)
})

test('a turn that ended on the token limit gives what it said, marked as not complete', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const home = freshHome(t)
  const logs = new Map()
  const first = await start(home, logs)
  const request = await askWriter(first, home)
  const exchangeId = request.source.exchangeId
  logs.set('b', writerLog(request, 'The plan is ready, up to the limit.', { kind: 'max-tokens' }, { provider: 'gateway', model: 'step-5' }))
  await first.stop()

  const second = await start(home, logs)
  second.emit('b', 'turn/end', { turn: 1, reason: { kind: 'max-tokens' } })
  t.mock.timers.tick(3000)
  await settle(() => second.agentOf('a').calls.length === 1)
  const reply = second.agentOf('a').calls[0]
  assert.deepEqual([reply.source.role, reply.source.replyTo], ['reply', exchangeId])
  assert.match(text(reply), /The plan is ready, up to the limit\./)
  // Half an answer is not passed on as a whole one.
  assert.match(text(reply), /\[cut off at the model's output limit; the answer is not complete\]$/)
  // The work is settled, and the request is not run again.
  await settleState(t, home, () => stateOf(home).works?.[exchangeId] === undefined)
  assert.equal(second.agentOf('b').calls.length, 0)
  // The diagnostics name the route, so a wrong contextWindow can be found from them.
  const entries = await readDiagnostics(home)
  const cutOff = entries.filter(entry => entry.code === 'MAX_TOKENS')
  assert.equal(cutOff.length, 1)
  assert.match(cutOff[0].text, /answer is not complete \(gateway\/step-5\)/)
  assert.deepEqual([cutOff[0].level, cutOff[0].bot, cutOff[0].where], ['warn', 'Writer', 'own chat'])
})

test('a turn cut off on the token limit without any text is not reported as finished', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const home = freshHome(t)
  const logs = new Map()
  const first = await start(home, logs)
  const request = await askWriter(first, home)
  const exchangeId = request.source.exchangeId
  logs.set('b', writerLog(request, undefined, { kind: 'max-tokens' }, { provider: 'gateway', model: 'step-5' }))
  await first.stop()

  const second = await start(home, logs)
  second.emit('b', 'turn/end', { turn: 1, reason: { kind: 'max-tokens' } })
  t.mock.timers.tick(3000)
  await settle(() => second.agentOf('a').calls.length === 1)
  const reply = second.agentOf('a').calls[0]
  assert.deepEqual([reply.source.role, reply.source.replyTo], ['reply', exchangeId])
  assert.match(text(reply), /\[cut off at the model's output limit before it wrote anything\]/)
  // Silence is not passed on as a deliberate finish.
  assert.doesNotMatch(text(reply), /finished without a reply/)
  await settleState(t, home, () => stateOf(home).works?.[exchangeId] === undefined)
  assert.equal(second.agentOf('b').calls.length, 0)
  const entries = await readDiagnostics(home)
  const cutOff = entries.filter(entry => entry.code === 'MAX_TOKENS')
  assert.equal(cutOff.length, 1)
  assert.match(cutOff[0].text, /cut off at the output limit before it wrote anything/)
})

test('a watched turn cut off without text tells the asker instead of finishing silently', async (t) => {
  const home = freshHome(t)
  const host = await start(home)
  await askWriter(host, home)
  host.agentOf('b').session.requestHeader = () => ({ config: { provider: 'gateway', model: 'step-5' } })
  host.emit('b', 'turn/end', { turn: 1, reason: { kind: 'max-tokens' } })
  await settle(() => host.agentOf('a').calls.length === 1)
  const reply = text(host.agentOf('a').calls[0])
  assert.match(reply, /\[cut off at the model's output limit before it wrote anything\]/)
  assert.doesNotMatch(reply, /finished without a reply/)
  // It is on record with the route that was over its window.
  const entries = await readDiagnostics(home, list => list.some(entry => entry.code === 'MAX_TOKENS'))
  const cutOff = entries.filter(entry => entry.code === 'MAX_TOKENS')
  assert.equal(cutOff.length, 1)
  assert.match(cutOff[0].text, /before it wrote anything \(gateway\/step-5\)/)
})

test('a watched turn cut off after writing text is passed on marked unfinished', async (t) => {
  const home = freshHome(t)
  const host = await start(home)
  await askWriter(host, home)
  host.emit('b', 'assistant/message', { message: { content: [{ type: 'text', text: 'The first half.' }] } })
  host.emit('b', 'turn/end', { turn: 1, reason: { kind: 'max-tokens' } })
  await settle(() => host.agentOf('a').calls.length === 1)
  const reply = text(host.agentOf('a').calls[0])
  assert.match(reply, /The first half\./)
  assert.match(reply, /\[cut off at the model's output limit; the answer is not complete\]$/)
})

test('the answer that goes up keeps what came back for the work', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const state = seed()
  // Writer handed the plan on; what came back for it is kept with the work.
  state.works = { x1: { from: 'a', to: 'b', open: [], results: [{ id: 'y1', name: 'Reviewer', text: 'The numbers check out.' }], at: 1 } }
  const home = freshHome(t, state)
  const logs = new Map()
  const first = await start(home, logs)
  const request = { content: [{ type: 'text', text: '[Message from Chief]\nDraft the plan' }], source: { kind: 'bot', form: 'relay', role: 'request', exchangeId: 'x1', senderName: 'Chief', senderSessionId: 'a', hop: 0 } }
  run(first, 'b', 1, request)
  await settle(() => inflight(home).b?.trigger?.exchangeId === 'x1')
  logs.set('b', writerLog(request, 'The plan is ready.'))
  await first.stop()

  const second = await start(home, logs)
  second.emit('b', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  t.mock.timers.tick(3000)
  await settle(() => second.agentOf('a').calls.length === 1)
  const reply = text(second.agentOf('a').calls[0])
  assert.match(reply, /The plan is ready\./)
  assert.match(reply, /Reviewer:\nThe numbers check out\./)
  // The work is settled, and the request is not run again.
  await settleState(t, home, () => stateOf(home).works?.x1 === undefined)
  assert.equal(second.agentOf('b').calls.length, 0)
})

test('an answer that already went up is not sent again', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const home = freshHome(t)
  const logs = new Map()
  const first = await start(home, logs)
  const request = await askWriter(first, home)
  const exchangeId = request.source.exchangeId
  logs.set('b', writerLog(request, 'The plan is ready.'))
  // Chief already has the answer: another run delivered it.
  logs.set('a', [{ type: 'user/message', seq: 1, data: { source: { kind: 'bot', role: 'reply', replyTo: exchangeId, senderSessionId: 'b' }, content: [{ type: 'text', text: '[Reply from Writer]\nThe plan is ready.' }] } }])
  await first.stop()

  const second = await start(home, logs)
  second.emit('b', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  t.mock.timers.tick(3000)
  await settleState(t, home, () => stateOf(home).works?.[exchangeId] === undefined)
  assert.deepEqual([second.agentOf('a').calls.length, second.agentOf('b').calls.length], [0, 0])
})

test('a work that still waits for what it handed on holds its text, and is not settled', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const state = seed()
  state.works = { x1: { from: 'a', to: 'b', open: ['y1'], results: [], at: 1 } }
  const home = freshHome(t, state)
  const logs = new Map()
  const first = await start(home, logs)
  const request = { content: [{ type: 'text', text: '[Message from Chief]\nDraft the plan' }], source: { kind: 'bot', form: 'relay', role: 'request', exchangeId: 'x1', senderName: 'Chief', senderSessionId: 'a', hop: 0 } }
  run(first, 'b', 1, request)
  await settle(() => inflight(home).b?.trigger?.exchangeId === 'x1')
  logs.set('b', writerLog(request, 'The plan is ready.'))
  await first.stop()

  const second = await start(home, logs)
  second.emit('b', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  t.mock.timers.tick(3000)
  await new Promise(resolve => setImmediate(resolve))
  // The work waits for what Writer handed on: nothing is sent, and it stays open.
  assert.deepEqual([second.agentOf('a').calls.length, second.agentOf('b').calls.length], [0, 0])
  // What the turn said is held for it, until what it handed on comes back.
  await settleState(t, home, () => stateOf(home).works.x1.held !== undefined)
  assert.equal(stateOf(home).works.x1.held, 'The plan is ready.')
  assert.deepEqual(stateOf(home).works.x1.open, ['y1'])
})

test('a finished turn leaves nothing to pick up', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const home = freshHome(t)
  const first = await start(home)
  run(first, 'a', 1, { content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } })
  first.emit('a', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await settle(() => Object.keys(inflight(home)).length === 0 && existsSync(join(home, 'inflight.json')))
  await first.stop()
  const second = await start(home)
  t.mock.timers.tick(3000)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(second.agentOf('a').calls.length, 0)
})

test('a turn DSH stops as it shuts down stays noted; one the user stops does not', async (t) => {
  const home = freshHome(t)
  const host = await start(home)
  run(host, 'a', 1, { content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } })
  run(host, 'b', 1, { content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } })
  host.emit('a', 'turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'disposed' } } })
  host.emit('b', 'turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } })
  await settle(() => inflight(home).a !== undefined && inflight(home).b === undefined)
})

test('a message a shutdown cancelled is sent again once; one still waiting, taken up or withdrawn is not', async (t) => {
  const home = freshHome(t)
  const first = await start(home)
  const send = message => first.tool('message_bot', { to: 'Writer', message, when: 'queue' }, 'a')
  await send('Draft the plan')
  await send('Check the numbers')
  await send('Read the notes')
  await send('Never mind')
  const [plan, numbers, notesMessage, withdrawn] = first.agentOf('b').calls
  // Taken up by a turn, or withdrawn while DS Bot runs (the user stopped the Bot).
  first.emit('b', 'user/message', { content: notesMessage.content, source: notesMessage.source })
  for (const listener of first.ctx.listeners.get('agent/inbox/discarded')) listener({ message: withdrawn })
  await settle(() => (notes(home).queued.b ?? []).length === 2)
  const original = (await first.call('exchange', { a: 'a', b: 'b' })).value.find(entry => entry.id === plan.source.exchangeId)
  await first.stop()

  t.mock.timers.enable({ apis: ['setTimeout'] })
  const second = await start(home)
  // A hard stop keeps the inbox: that message runs when the Session wakes.
  second.agentOf('b').inbox.nextTurn.push(numbers)
  t.mock.timers.tick(3000)
  await settle(() => second.agentOf('b').calls.length === 1)
  const [again] = second.agentOf('b').calls
  assert.deepEqual([again.source.exchangeId, again.source.role], [plan.source.exchangeId, 'request'])
  assert.match(text(again), /^\[Message from Chief · DeepSeek Harness restarted before it could reach you\]\nDraft the plan$/)
  // The resend is the same exchange, not a new one.
  const exchanges = (await second.call('exchange', { a: 'a', b: 'b' })).value
  assert.equal(exchanges.length, 4)
  assert.deepEqual(exchanges.find(entry => entry.id === plan.source.exchangeId), original)
  await second.stop()

  // Neither the resend nor a message kept in the inbox is lost at another restart.
  const third = await start(home)
  t.mock.timers.tick(3000)
  await settle(() => third.agentOf('b').calls.length === 2)
  assert.deepEqual(third.agentOf('b').calls.map(message => message.source.exchangeId), [plan, numbers].map(message => message.source.exchangeId))
})

test('moving a pending delivery keeps its recovery note through discard and restart', async (t) => {
  const home = freshHome(t)
  const first = await start(home)
  await first.tool('message_bot', { to: 'Writer', message: 'keep this', when: 'queue' }, 'a')
  const message = first.agentOf('b').calls[0]
  await settle(() => notes(home).queued?.b?.length === 1)

  first.rt.moveQueued('b-next', [message])
  for (const listener of first.ctx.listeners.get('agent/inbox/discarded')) listener({ agent: { id: 'b' }, message })
  await settle(() => notes(home).queued?.['b-next']?.length === 1 && notes(home).queued?.b === undefined)
  assert.equal(notes(home).queued['b-next'][0].args.exchangeId, message.source.exchangeId)
  await first.stop()

  const state = stateOf(home)
  state.bots.b.sessionId = 'b-next'
  writeFileSync(join(home, 'state.json'), JSON.stringify(state))
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const second = await start(home)
  second.agentOf('b-next').inbox.nextTurn.push(message)
  t.mock.timers.tick(3000)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(second.agentOf('b-next').calls.length, 0)
  second.emit('b-next', 'user/message', { content: message.content, source: message.source })
  await settle(() => notes(home).queued?.['b-next'] === undefined)
})

test('a large forwarded inbox keeps delivery identities through restart without resending', async (t) => {
  const home = freshHome(t)
  const first = await start(home)
  for (let i = 0; i < 235; i++) await first.tool('message_bot', { to: 'Writer', message: `queued ${i}`, when: 'queue' }, 'a')
  const messages = first.agentOf('b').calls.slice()
  const ids = messages.map(message => message.source.exchangeId)
  await settle(() => notes(home).queued?.b?.length === 235)
  first.rt.moveQueued('b-next', messages)
  for (const message of messages) {
    for (const listener of first.ctx.listeners.get('agent/inbox/discarded')) listener({ agent: { id: 'b' }, message })
  }
  await settle(() => notes(home).queued?.['b-next']?.length === 235 && notes(home).queued?.b === undefined)
  assert.deepEqual(notes(home).queued['b-next'].map(item => item.args.exchangeId), ids)
  await first.stop()
  const state = stateOf(home)
  state.bots.b.sessionId = 'b-next'
  writeFileSync(join(home, 'state.json'), JSON.stringify(state))
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const second = await start(home)
  second.agentOf('b-next').inbox.nextTurn.push(...messages)
  t.mock.timers.tick(3000)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(second.agentOf('b-next').calls.length, 0)
  assert.deepEqual(notes(home).queued['b-next'].map(item => item.args.exchangeId), ids)
})

test('a forwarded delivery taken up before note transfer is not noted again', async (t) => {
  const home = freshHome(t)
  const host = await start(home)
  await host.tool('message_bot', { to: 'Writer', message: 'take this', when: 'queue' }, 'a')
  const message = host.agentOf('b').calls[0]
  await settle(() => notes(home).queued?.b?.length === 1)
  host.emit('b-next', 'user/message', { content: message.content, source: message.source })
  host.rt.moveQueued('b-next', [message])
  await settle(() => Object.values(notes(home).queued ?? {}).every(list => list.every(item => item.args.exchangeId !== message.source.exchangeId)))
})

test('waking an inbox retains its delivery note while removing and resending', async (t) => {
  const home = freshHome(t)
  const host = await start(home)
  await host.tool('message_bot', { to: 'Writer', message: 'wake me', when: 'queue' }, 'a')
  const message = host.agentOf('b').calls[0]
  await settle(() => notes(home).queued?.b?.length === 1)
  const discard = () => {
    for (const listener of host.ctx.listeners.get('agent/inbox/discarded')) listener({ agent: { id: 'b' }, message })
  }
  host.rt.keepQueued('b', [message], discard)
  assert.equal(notes(home).queued.b[0].args.exchangeId, message.source.exchangeId)
  discard()
  await settle(() => notes(home).queued?.b === undefined)
})

test('a queued request kept over a restart is sent again however old, and the asker is told it was late', async (t) => {
  const home = freshHome(t)
  const first = await start(home)
  await first.tool('message_bot', { to: 'Writer', message: 'Draft the plan', when: 'queue' }, 'a')
  await settle(() => (notes(home).queued.b ?? []).length === 1)
  const [plan] = first.agentOf('b').calls
  await first.stop()

  // The note waited through a long stop: it is still sent again, not dropped.
  const file = join(home, 'inflight.json')
  const noted = notes(home)
  noted.queued.b[0].at = Date.now() - 25 * 60 * 60 * 1000
  writeFileSync(file, JSON.stringify(noted))

  t.mock.timers.enable({ apis: ['setTimeout'] })
  const second = await start(home)
  t.mock.timers.tick(3000)
  await settle(() => second.agentOf('b').calls.length === 1)
  const [again] = second.agentOf('b').calls
  assert.deepEqual([again.source.exchangeId, again.source.role], [plan.source.exchangeId, 'request'])
  assert.match(text(again), /^\[Message from Chief · DeepSeek Harness restarted before it could reach you\]/)

  // The work is marked, so the answer that goes up says the request arrived late.
  await settleState(t, home, () => stateOf(home).works?.[plan.source.exchangeId]?.late === true)
  run(second, 'b', 1, again)
  second.emit('b', 'assistant/message', { message: { content: [{ type: 'text', text: 'The plan is ready.' }] } })
  second.emit('b', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await settle(() => second.agentOf('a').calls.length === 1)
  const reply = text(second.agentOf('a').calls[0])
  assert.match(reply, /^\[Reply from Writer\]\n\[This request reached Writer only after DeepSeek Harness restarted\.\]/)
  assert.match(reply, /The plan is ready\./)
})

test('queued deliveries are kept whole, not cut at fifty', async (t) => {
  const home = freshHome(t)
  const first = await start(home)
  for (let at = 1; at <= 55; at += 1) await first.tool('message_bot', { to: 'Writer', message: `Task ${at}`, when: 'queue' }, 'a')
  await settle(() => (notes(home).queued.b ?? []).length === 55)
  await first.stop()

  t.mock.timers.enable({ apis: ['setTimeout'] })
  const second = await start(home)
  t.mock.timers.tick(3000)
  await settle(() => second.agentOf('b').calls.length === 55)
})

test('a delivery whose flush fails stays queued for review after restart', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const home = freshHome(t)
  const first = await start(home)
  const flushing = first.ctx.sessions.flush
  first.ctx.sessions.flush = async (session) => {
    if (session?.id === 'b') throw Object.assign(new Error('Session sess-b is gone'), { code: 'session/not-found' })
    return flushing(session)
  }
  await assert.rejects(first.tool('message_bot', { to: 'Writer', message: 'Draft the plan' }, 'a'), /sess-b is gone/)
  // Nothing is shown as delivered; the delivery stays queued, and the work it
  // opened stays with it.
  await settleState(t, home, () => (stateOf(home).exchanges ?? []).length === 0 && Object.keys(stateOf(home).works ?? {}).length === 1)
  await settle(() => (notes(home).queued.b ?? []).length === 1)
  await first.stop()

  const second = await start(home)
  t.mock.timers.tick(3000)
  const entries = await readDiagnostics(home, rows => rows.some(row => /send outcome is unknown/.test(row.text)))
  assert.ok(entries.some(row => /send outcome is unknown/.test(row.text)))
  assert.equal(second.agentOf('b').calls.length, 0)
  assert.equal(notes(home).queued.b[0].recoveryHold, 'prepared')
})

for (const ErrorType of [TypeError, ReferenceError, RangeError, SyntaxError]) {
  test(`pre-admission ${ErrorType.name} preserves identity and internal classification`, async (t) => {
    const home = freshHome(t)
    const host = await start(home)
    const root = new Error('root cause')
    const failure = Object.assign(new ErrorType('private detail', { cause: root }), { code: 'custom/lookup', status: 503, requestId: 'request-1' })
    host.ctx.sessionController.resolveAgent = async () => { throw failure }
    let notAdmitted = 0
    const actual = await host.rt.deliver({ toId: 'b', role: 'reply', text: 'result' }, { onNotAdmitted: () => { notAdmitted += 1 } }).catch(error => error)
    assert.equal(actual, failure)
    assert.equal(actual.cause, root)
    assert.equal(actual.code, 'custom/lookup')
    assert.equal(actual.status, 503)
    assert.equal(actual.requestId, 'request-1')
    assert.equal(errorCode(actual), 'bot/internal')
    assert.equal(notAdmitted, 1)
    assert.equal(host.agentOf('b').calls.length, 0)
  })
}

test('observers are per delivery even if the same error object is thrown concurrently', async (t) => {
  const home = freshHome(t)
  const host = await start(home)
  const failure = new Error('shared failure')
  const ensure = host.rt.ensureCapabilities
  host.rt.ensureCapabilities = sessionId => sessionId === 'b' ? Promise.reject(failure) : ensure(sessionId)
  host.agentOf('a').followup = () => { throw failure }
  const observed = []
  const result = await Promise.allSettled([
    host.rt.deliver({ toId: 'b', role: 'reply', text: 'first' }, { onNotAdmitted: () => observed.push('before') }),
    host.rt.deliver({ toId: 'a', role: 'reply', text: 'second' }, { onNotAdmitted: () => observed.push('after') }),
  ])
  assert.deepEqual(result.map(item => item.reason), [failure, failure])
  assert.deepEqual(observed, ['before'])
})

test('a failed recovery-note write does not report that the lower delivery was attempted', async (t) => {
  const home = freshHome(t)
  const host = await start(home)
  writeFileSync(join(home, 'inflight.json'), JSON.stringify({ turns: {}, queued: {} }))
  let notAdmitted = 0
  const failure = await host.rt.deliver({ toId: 'b', role: 'reply', text: 'result' }, { onNotAdmitted: () => { notAdmitted += 1 } }).catch(error => error)
  assert.equal(failure.code, 'ECONFLICT')
  assert.equal(notAdmitted, 0)
  assert.equal(host.agentOf('b').calls.length, 0)
})

test('a reply whose recovery-note write fails is not retried as a failure notice', async (t) => {
  const state = seed()
  state.bots.c = { id: 'c', name: 'Reviewer', sessionId: 'c', createdAt: 3 }
  state.works = { y1: { from: 'b', to: 'c', open: [], results: [], at: 2 } }
  const home = freshHome(t, state)
  const host = await start(home)
  run(host, 'c', 1, { content: [{ type: 'text', text: 'Check the numbers' }], source: { kind: 'bot', role: 'request', exchangeId: 'y1', senderSessionId: 'b' } })
  await settle(() => notes(home).turns?.c?.trigger?.exchangeId === 'y1')
  writeFileSync(join(home, 'inflight.json'), JSON.stringify({ turns: {}, queued: {} }))
  host.emit('c', 'assistant/message', { message: { content: [{ type: 'text', text: 'The numbers check out.' }] } })
  host.emit('c', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  const entries = await readDiagnostics(home, rows => rows.some(row => row.code === 'REPLY_DELIVERY_UNCERTAIN'))
  assert.ok(entries.some(row => row.code === 'REPLY_DELIVERY_UNCERTAIN' && row.text.includes('y1')))
  assert.equal(host.agentOf('b').calls.length, 0)
})

test('message construction failure signals non-admission and preserves the original error if the observer throws', async (t) => {
  const home = freshHome(t)
  const host = await start(home)
  let observed = 0
  const failure = await host.rt.deliver({ toId: 'b', role: 'reply', text: 'result', images: null }, { onNotAdmitted: () => { observed += 1; throw new Error('observer failure') } }).catch(error => error)
  assert.ok(failure instanceof TypeError)
  assert.equal(errorCode(failure), 'bot/internal')
  assert.equal(observed, 1)
  assert.equal(host.agentOf('b').calls.length, 0)
})

for (const stage of ['ensureCapabilities', 'ledger.written']) {
  test(`a reply failure during ${stage} sends one failure notice`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const state = seed()
    state.bots.c = { id: 'c', name: 'Reviewer', sessionId: 'c', createdAt: 3 }
    state.works = {
      x1: { from: 'a', to: 'b', open: ['y1'], results: [], at: 1 },
      y1: { from: 'b', to: 'c', parent: 'x1', open: [], results: [], at: 2 },
    }
    const home = freshHome(t, state)
    const host = await start(home)
    let fail = true
    if (stage === 'ensureCapabilities') {
      const original = host.rt.ensureCapabilities
      host.rt.ensureCapabilities = async (...args) => {
        if (fail) { fail = false; throw Object.assign(new Error('injected capability failure'), { code: 'CAP_FAIL' }) }
        return original(...args)
      }
    } else {
      const original = host.rt.ledger.written
      host.rt.ledger.written = async (...args) => {
        if (fail) { fail = false; throw Object.assign(new Error('injected ledger failure'), { code: 'LEDGER_FAIL' }) }
        return original(...args)
      }
    }
    run(host, 'c', 1, { content: [{ type: 'text', text: 'Check the numbers' }], source: { kind: 'bot', role: 'request', exchangeId: 'y1', senderSessionId: 'b' } })
    host.emit('c', 'assistant/message', { message: { content: [{ type: 'text', text: 'The numbers check out.' }] } })
    host.emit('c', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
    await settle(() => host.agentOf('b').calls.length === 1)
    const notice = host.agentOf('b').calls[0]
    assert.equal(notice.source.replyTo, 'y1')
    assert.match(text(notice), /could not send its reply to you/)
    await settleState(t, home, () => stateOf(home).works?.x1?.results[0]?.failed === true)
    assert.equal(host.agentOf('b').calls.length, 1)
  })
}

for (const failure of ['flush after insertion', 'insertion then synchronous throw', 'insertion then recipient removed', 'insertion then already read']) {
  test(`an uncertain reply is not sent a second time: ${failure}`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const state = seed()
    state.bots.c = { id: 'c', name: 'Reviewer', sessionId: 'c', createdAt: 3 }
    state.works = {
      x1: { from: 'a', to: 'b', open: ['y1'], results: [], at: 1 },
      y1: { from: 'b', to: 'c', parent: 'x1', open: [], results: [], at: 2 },
    }
    const home = freshHome(t, state)
    const host = await start(home)
    const receiver = host.agentOf('b')
    const send = receiver.followup
    if (failure !== 'flush after insertion') {
      receiver.followup = message => {
        send(message)
        if (failure === 'insertion then recipient removed') delete host.rt.state.bots.b
        if (failure === 'insertion then already read') host.emit('b', 'user/message', { content: message.content, source: message.source })
        throw Object.assign(new Error('wake failed'), { code: 'WAKE_FAILED' })
      }
    } else {
      const flush = host.ctx.sessions.flush
      host.ctx.sessions.flush = session => session?.id === 'b' ? Promise.reject(new Error('flush failed')) : flush(session)
    }
    run(host, 'c', 1, { content: [{ type: 'text', text: 'Check the numbers' }], source: { kind: 'bot', role: 'request', exchangeId: 'y1', senderSessionId: 'b' } })
    host.emit('c', 'assistant/message', { message: { content: [{ type: 'text', text: 'The numbers check out.' }] } })
    host.emit('c', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
    const entries = await readDiagnostics(home, rows => rows.some(row => row.code === 'REPLY_DELIVERY_UNCERTAIN' || /reply failure notice not delivered/.test(row.text)))
    assert.equal(receiver.calls.length, 1)
    assert.ok(entries.some(row => row.code === 'REPLY_DELIVERY_UNCERTAIN' && row.text.includes('y1')))
    const sent = receiver.calls[0]
    assert.equal(sent.source.replyTo, 'y1')
    assert.match(text(sent), /The numbers check out\./)
    if (failure === 'insertion then already read') {
      await settle(() => !(notes(home).queued.b ?? []).some(item => item.args.exchangeId === sent.source.exchangeId))
    } else {
      await settle(() => (notes(home).queued.b ?? []).some(item => item.args.exchangeId === sent.source.exchangeId))
      assert.equal(notes(home).queued.b.find(item => item.args.exchangeId === sent.source.exchangeId).recoveryHold, 'prepared')
    }
    assert.equal(stateOf(home).works.x1.results[0].failed, undefined)
  })
}

test('a reply that fails to reach the asker reaches it as a failure notice carrying the answer', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const state = seed()
  // Chief asked Writer; Writer handed part of it to Reviewer.
  state.bots.c = { id: 'c', name: 'Reviewer', sessionId: 'c', createdAt: 3 }
  state.works = {
    x1: { from: 'a', to: 'b', open: ['y1'], results: [], at: 1 },
    y1: { from: 'b', to: 'c', parent: 'x1', open: [], results: [], at: 2 },
  }
  const home = freshHome(t, state)
  const host = await start(home)
  // Reviewer finished; its reply to Writer fails once, so the failure reaches
  // Writer as a notice instead, carrying what Reviewer answered.
  let fails = 1
  const resolving = host.ctx.sessionController.resolveAgent
  host.ctx.sessionController.resolveAgent = async (sessionId) => {
    if (sessionId === 'b' && fails > 0) {
      fails -= 1
      throw Object.assign(new Error('Session sess-b is gone'), { code: 'session/not-found' })
    }
    return resolving(sessionId)
  }
  run(host, 'c', 1, { content: [{ type: 'text', text: '[Message from Writer]\nCheck the numbers' }], source: { kind: 'bot', form: 'relay', role: 'request', exchangeId: 'y1', senderName: 'Writer', senderSessionId: 'b', hop: 0 } })
  host.emit('c', 'assistant/message', { message: { content: [{ type: 'text', text: 'The numbers check out.' }] } })
  host.emit('c', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await settle(() => host.agentOf('b').calls.length === 1)
  const notice = host.agentOf('b').calls[0]
  assert.deepEqual([notice.source.role, notice.source.replyTo, notice.source.work], ['reply', 'y1', 'x1'])
  assert.match(text(notice), /^\[Reply from Reviewer · for the work Chief asked you for; your answer goes to Chief once everything you handed on is back\]\nReviewer could not send its reply to you \(session\/not-found: Session sess-b is gone\); what it had answered:\nThe numbers check out\.$/)
  // The wait stays until the notice is read; the kept result is marked.
  await settleState(t, home, () => stateOf(home).works?.x1?.results[0]?.failed === true)
  assert.deepEqual(stateOf(home).works.x1.open, ['y1'])

  // Writer reads the notice, the wait ends, and the answer that goes up names it.
  run(host, 'b', 2, notice)
  host.emit('b', 'assistant/message', { message: { content: [{ type: 'text', text: 'The plan is ready.' }] } })
  host.emit('b', 'turn/end', { turn: 2, reason: { kind: 'completed' } })
  await settle(() => host.agentOf('a').calls.length === 1)
  const reply = text(host.agentOf('a').calls[0])
  assert.match(reply, /The plan is ready\./)
  assert.match(reply, /Reviewer could not send its reply to you; what it had answered:\nThe numbers check out\./)
  // Nothing of the lost reply is sent again: the notice carried it.
  await settle(() => (notes(home).queued.b ?? []).length === 0)
})

test('a failure notice with an uncertain send stays queued for review after restart', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const state = seed()
  state.bots.c = { id: 'c', name: 'Reviewer', sessionId: 'c', createdAt: 3 }
  state.works = {
    x1: { from: 'a', to: 'b', open: ['y1'], results: [], at: 1 },
    y1: { from: 'b', to: 'c', parent: 'x1', open: [], results: [], at: 2 },
  }
  const home = freshHome(t, state)
  const first = await start(home)
  first.ctx.sessionController.resolveAgent = async sessionId => sessionId === 'b'
    ? { error: { code: 'session/not-found', message: 'Session sess-b is gone' } }
    : { agent: first.agentOf(sessionId) }
  run(first, 'c', 1, { content: [{ type: 'text', text: '[Message from Writer]\nCheck the numbers' }], source: { kind: 'bot', form: 'relay', role: 'request', exchangeId: 'y1', senderName: 'Writer', senderSessionId: 'b' } })
  first.emit('c', 'assistant/message', { message: { content: [{ type: 'text', text: 'The numbers check out.' }] } })
  first.emit('c', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await settle(() => {
    const queued = notes(home).queued.b ?? []
    return queued.length === 1 && /could not send its reply/.test(queued[0].args.text)
  })
  await settleState(t, home, () => stateOf(home).works?.x1?.results[0]?.failed === true)
  await first.stop()

  const second = await start(home)
  t.mock.timers.tick(3000)
  const entries = await readDiagnostics(home, rows => rows.some(row => /send outcome is unknown/.test(row.text)))
  assert.ok(entries.some(row => /send outcome is unknown/.test(row.text)))
  assert.equal(second.agentOf('b').calls.length, 0)
  assert.match(notes(home).queued.b[0].args.text, /could not send its reply/)
})

test('new deliveries before recovery do not overwrite the saved queue', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const home = freshHome(t)
  const first = await start(home)
  await first.tool('message_bot', { to: 'Writer', message: 'Task before shutdown', when: 'queue' }, 'a')
  await first.stop()

  const second = await start(home)
  await second.tool('message_bot', { to: 'Writer', message: 'Task before recovery', when: 'queue' }, 'a')
  await second.stop()
  assert.equal(notes(home).queued.b.length, 2)

  const third = await start(home)
  t.mock.timers.tick(3000)
  await settle(() => third.agentOf('b').calls.length === 2)
  assert.match(text(third.agentOf('b').calls[0]), /Task before shutdown$/)
  assert.match(text(third.agentOf('b').calls[1]), /Task before recovery$/)
})

test('a resend that cannot open the Session keeps the whole queue for the next start', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const home = freshHome(t)
  const first = await start(home)
  for (const message of ['Task 1', 'Task 2', 'Task 3']) await first.tool('message_bot', { to: 'Writer', message, when: 'queue' }, 'a')
  await settle(() => (notes(home).queued.b ?? []).length === 3)
  await first.stop()

  // The Session cannot be opened at this start: all three stay queued, none is
  // silently dropped.
  const warnings = []
  const second = await start(home)
  second.ctx.logger.warn = (...args) => warnings.push(args.join(' '))
  second.ctx.sessionController.resolveAgent = async (sessionId) => {
    if (sessionId === 'b') throw Object.assign(new Error('Session sess-b is gone'), { code: 'session/not-found' })
    return { agent: second.agentOf(sessionId) }
  }
  t.mock.timers.tick(3000)
  await settle(() => warnings.some(line => /sending again/.test(line)))
  await second.stop()
  assert.equal((notes(home).queued.b ?? []).length, 3)

  // The next start delivers all three.
  const third = await start(home)
  t.mock.timers.tick(3000)
  await settle(() => third.agentOf('b').calls.length === 3)
})

test('a request with an uncertain send keeps its work for review after restart', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const state = seed()
  state.bots.c = { id: 'c', name: 'Reviewer', sessionId: 'c', createdAt: 3 }
  state.works = { x1: { from: 'a', to: 'b', open: [], results: [], at: 1 } }
  const home = freshHome(t, state)
  const first = await start(home)
  // Writer hands part of Chief's work to Reviewer. A Session flush failure occurs
  // after followup, so whether the request reached Reviewer is uncertain.
  run(first, 'b', 1, { content: [{ type: 'text', text: '[Message from Chief]\nDraft the plan' }], source: { kind: 'bot', form: 'relay', role: 'request', exchangeId: 'x1', senderName: 'Chief', senderSessionId: 'a', hop: 0 } })
  const flushing = first.ctx.sessions.flush
  first.ctx.sessions.flush = async (session) => {
    if (session?.id === 'c') throw Object.assign(new Error('Session sess-c is gone'), { code: 'session/not-found' })
    return flushing(session)
  }
  await assert.rejects(first.tool('message_bot', { to: 'Reviewer', message: 'Check the numbers' }, 'b'), /sess-c is gone/)
  // Writer ends its turn waiting for what it handed on.
  first.emit('b', 'assistant/message', { message: { content: [{ type: 'text', text: 'Reviewer is on the numbers.' }] } })
  first.emit('b', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  // The delivery stays queued, so the work it opened stays too.
  await settleState(t, home, () => Object.values(stateOf(home).works ?? {}).some(work => work.to === 'c' && work.parent === 'x1'))
  await settle(() => (notes(home).queued.c ?? []).length === 1)
  await first.stop()

  const second = await start(home)
  t.mock.timers.tick(3000)
  const entries = await readDiagnostics(home, rows => rows.some(row => /send outcome is unknown/.test(row.text)))
  assert.ok(entries.some(row => /send outcome is unknown/.test(row.text)))
  assert.equal(second.agentOf('c').calls.length, 0)
  assert.equal(notes(home).queued.c[0].recoveryHold, 'prepared')
  assert.ok(Object.values(stateOf(home).works).some(work => work.to === 'c' && work.parent === 'x1'))
})

test('a failed flush is not claimed as delivered or automatically resent', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const home = freshHome(t)
  const first = await start(home)
  const flushing = first.ctx.sessions.flush
  first.ctx.sessions.flush = async (session) => {
    if (session?.id === 'b') throw Object.assign(new Error('Session sess-b is gone'), { code: 'session/not-found' })
    return flushing(session)
  }
  await assert.rejects(first.tool('message_bot', { to: 'Writer', message: 'Draft the plan' }, 'a'), /sess-b is gone/)
  await settle(() => (notes(home).queued.b ?? []).length === 1)
  await first.stop()

  const second = await start(home)
  t.mock.timers.tick(3000)
  const entries = await readDiagnostics(home, rows => rows.some(row => /send outcome is unknown/.test(row.text)))
  assert.ok(entries.some(row => /send outcome is unknown/.test(row.text)))
  assert.equal(second.agentOf('b').calls.length, 0)
  assert.equal((stateOf(home).exchanges ?? []).length, 0)
  // The upstream pair ledger can contain a pre-send record, which must not be
  // exposed as a delivery when the Session flush failed.
  assert.deepEqual((await second.call('exchange', { a: 'a', b: 'b' })).value, [])
})

const WRITTEN = 'Checking now.\n<tool_call>\n<function=pwsh>\n<parameter=command>\nGet-ChildItem E:\\\n</parameter>\n</function>\n</tool_call>'
// A reply cut off inside the model's own call template keeps only its closing tags,
// as the group report shows (it pasted the CJK brackets the model wrote).
const ORPHAN_TAGS = '＜/parameter＞\n＜/function＞\n＜/tool_call＞'
const MIXED_TAGS = '＜/parameter＞ ＜parameter=name＞length"＞15 Hi, everyone.'

test('a tool call written as text gets one more turn on the same round slot', async (t) => {
  const home = freshHome(t)
  const host = await start(home)
  const result = await openRoomTurn(t, host)
  host.emit('gb', 'assistant/message', { message: { content: [{ type: 'text', text: WRITTEN }] } })
  host.emit('gb', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await settle(() => host.agentOf('gb').calls.length === 2)
  const retry = host.agentOf('gb').calls[1]
  assert.deepEqual([retry.source.role, retry.source.retried, retry.source.exchangeId], ['room', true, host.agentOf('gb').calls[0].source.exchangeId])
  assert.match(text(retry), /^\[Group chat "Ops" · your tool call did not run\]/)
  assert.equal(result(), undefined)

  // Written again: the text goes on without the call.
  run(host, 'gb', 2, retry)
  host.emit('gb', 'assistant/message', { message: { content: [{ type: 'text', text: WRITTEN }] } })
  host.emit('gb', 'turn/end', { turn: 2, reason: { kind: 'completed' } })
  await settle(() => result() !== undefined)
  assert.deepEqual(result().replies.map(reply => reply.text), ['Checking now.'])
  assert.equal(host.agentOf('gb').calls.length, 2)
})

test('a group member that leaves only the call tags gets the same retry, and never posts the tags', async (t) => {
  const home = freshHome(t)
  const host = await start(home)
  const result = await openRoomTurn(t, host)
  host.emit('gb', 'assistant/message', { message: { content: [{ type: 'text', text: ORPHAN_TAGS }] } })
  host.emit('gb', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await settle(() => host.agentOf('gb').calls.length === 2)
  const retry = host.agentOf('gb').calls[1]
  assert.deepEqual([retry.source.role, retry.source.retried, retry.source.exchangeId], ['room', true, host.agentOf('gb').calls[0].source.exchangeId])
  assert.match(text(retry), /^\[Group chat "Ops" · your tool call did not run\]/)
  assert.equal(result(), undefined)

  // Leftover tags again: the round gets one readable line, no markup.
  run(host, 'gb', 2, retry)
  host.emit('gb', 'assistant/message', { message: { content: [{ type: 'text', text: ORPHAN_TAGS }] } })
  host.emit('gb', 'turn/end', { turn: 2, reason: { kind: 'completed' } })
  await settle(() => result() !== undefined)
  assert.deepEqual(result().replies.map(reply => reply.text), ['Tried to run a tool but wrote the call as text, so it did not run.'])
  assert.equal(host.agentOf('gb').calls.length, 2)
})

test('call tags mixed into the text are stripped, and the readable part still goes out', async (t) => {
  const home = freshHome(t)
  const host = await start(home)
  const result = await openRoomTurn(t, host)
  host.emit('gb', 'assistant/message', { message: { content: [{ type: 'text', text: MIXED_TAGS }] } })
  host.emit('gb', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await settle(() => host.agentOf('gb').calls.length === 2)
  const retry = host.agentOf('gb').calls[1]
  assert.equal(retry.source.retried, true)
  assert.equal(result(), undefined)

  // Written again: what was said around the tags goes on, without them.
  run(host, 'gb', 2, retry)
  host.emit('gb', 'assistant/message', { message: { content: [{ type: 'text', text: MIXED_TAGS }] } })
  host.emit('gb', 'turn/end', { turn: 2, reason: { kind: 'completed' } })
  await settle(() => result() !== undefined)
  const [reply] = result().replies.map(entry => entry.text)
  assert.match(reply, /Hi, everyone\./)
  assert.doesNotMatch(reply, /parameter|function|tool_call/)
})

test('a group member cut off on the token limit is not counted as a silent pass', async (t) => {
  const home = freshHome(t)
  const host = await start(home)
  const result = await openRoomTurn(t, host)
  // The turn wrote nothing: the round must not read it as the member having passed.
  host.emit('gb', 'turn/end', { turn: 1, reason: { kind: 'max-tokens' } })
  await settle(() => result() !== undefined)
  assert.deepEqual(result().replies.map(reply => reply.text), ['[cut off at the model\'s output limit before it wrote anything]'])
  assert.equal(host.agentOf('gb').calls.length, 1)
})

test('a group member cut off on the token limit keeps what it said and marks it unfinished', async (t) => {
  const home = freshHome(t)
  const host = await start(home)
  const result = await openRoomTurn(t, host)
  host.emit('gb', 'assistant/message', { message: { content: [{ type: 'text', text: 'Half of the answer.' }] } })
  host.emit('gb', 'turn/end', { turn: 1, reason: { kind: 'max-tokens' } })
  await settle(() => result() !== undefined)
  assert.deepEqual(result().replies.map(reply => reply.text), ['Half of the answer.\n\n[cut off at the model\'s output limit; the answer is not complete]'])
  assert.equal(host.agentOf('gb').calls.length, 1)
})

test('in its own chat, a Bot that wrote a tool call as text is asked to make it', async (t) => {
  const home = freshHome(t)
  const host = await start(home)
  run(host, 'b', 1, { content: [{ type: 'text', text: 'move the docs' }], source: { kind: 'user' } })
  // A call made for real, with or without text around it, is no retry.
  host.emit('b', 'assistant/message', { message: { content: [{ type: 'text', text: 'On it.' }, { type: 'tool-call', id: 'k1', name: 'pwsh', arguments: '{}' }] } })
  host.emit('b', 'assistant/message', { message: { content: [{ type: 'text', text: WRITTEN }] } })
  host.emit('b', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await settle(() => host.agentOf('b').calls.length === 1)
  const retry = host.agentOf('b').calls[0]
  assert.deepEqual([retry.source.role, retry.source.retried], ['retry', true])
  assert.match(text(retry), /^\[Your last reply wrote a tool call as text, so nothing ran\]/)
})

test('a written tool call is told apart from text about one', () => {
  assert.equal(writesToolCall(WRITTEN), true)
  assert.equal(writesToolCall('<function=read>\n<parameter=path>a.md</parameter></function>'), true)
  assert.equal(writesToolCall('Models such as Step write `<tool_call>` tags in their template.'), false)
  assert.equal(writesToolCall(undefined), false)
  assert.equal(stripWrittenCalls(WRITTEN), 'Checking now.')

  // A call cut off before its opening tags is still one.
  assert.equal(writesToolCall('</parameter>\n</function>\n</tool_call>'), true)
  assert.equal(writesToolCall(ORPHAN_TAGS), true)
  assert.equal(writesToolCall(MIXED_TAGS), true)
  assert.equal(stripWrittenCalls('</parameter>\n</function>\n</tool_call>'), '')
  assert.equal(stripWrittenCalls(ORPHAN_TAGS), '')
  assert.equal(stripWrittenCalls(MIXED_TAGS), 'length"＞15 Hi, everyone.')
  assert.equal(stripWrittenCalls('Checking </parameter> now.'), 'Checking now.')

  // Ordinary text keeps its marks, also when it talks about the tags.
  assert.equal(stripWrittenCalls('plain <text> with an angle or two'), 'plain <text> with an angle or two')
  assert.equal(writesToolCall('plain <text> with an angle or two'), false)
  assert.equal(stripWrittenCalls('a < b or c > d'), 'a < b or c > d')
})

for (const reason of ['completed', 'error', 'interrupted']) {
  test(`a queued note already seen in a previous ${reason} turn is held for review`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const home = freshHome(t)
    const first = await start(home)
    await first.tool('message_bot', { to: 'Writer', message: 'Draft the plan', when: 'queue' }, 'a')
    const message = first.agentOf('b').calls[0]
    await settle(() => notes(home).queued?.b?.length === 1)
    await first.stop()
    // The turn's user/message made the Session log, but the asynchronous removal
    // from inflight.json did not. Its outcome cannot be inferred from the reason.
    const logs = new Map([['b', [
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'user/message', data: { source: message.source } },
      { type: 'turn/end', data: { reason: { kind: reason } } },
    ]]])
    const warnings = []
    const second = await start(home, logs)
    second.ctx.logger.warn = (...args) => warnings.push(args.join(' '))
    t.mock.timers.tick(3000)
    await settle(() => warnings.some(line => /not resent/.test(line)))
    assert.equal(second.agentOf('b').calls.length, 0)
    assert.equal(notes(home).queued.b[0].args.exchangeId, message.source.exchangeId)
  })
}

test('a queued delivery with unreadable history is retained and reported', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const home = freshHome(t)
  const first = await start(home)
  await first.tool('message_bot', { to: 'Writer', message: 'Draft the plan', when: 'queue' }, 'a')
  const message = first.agentOf('b').calls[0]
  await settle(() => notes(home).queued?.b?.length === 1)
  await first.stop()
  const warnings = []
  const second = await start(home, undefined, async () => { throw new Error('unavailable') })
  second.ctx.logger.warn = (...args) => warnings.push(args.join(' '))
  t.mock.timers.tick(3000)
  await settle(() => warnings.some(line => /history could not be read/.test(line)))
  assert.equal(second.agentOf('b').calls.length, 0)
  assert.equal(notes(home).queued.b[0].args.exchangeId, message.source.exchangeId)
})

test('an uncertain queued exchange is not restarted through the interrupted-turn path', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const home = freshHome(t)
  const first = await start(home)
  await first.tool('message_bot', { to: 'Writer', message: 'Draft the plan', when: 'queue' }, 'a')
  const message = first.agentOf('b').calls[0]
  await settle(() => notes(home).queued?.b?.length === 1)
  await first.stop()
  const original = notes(home)
  original.turns.b = { botId: 'b', since: 1, trigger: { role: 'request', exchangeId: message.source.exchangeId, senderSessionId: 'a' } }
  writeFileSync(join(home, 'inflight.json'), JSON.stringify(original))
  const logs = new Map([['b', [{ type: 'user/message', data: { source: message.source } }]]])
  const warnings = []
  const second = await start(home, logs)
  second.ctx.logger.warn = (...args) => warnings.push(args.join(' '))
  t.mock.timers.tick(3000)
  await settle(() => warnings.some(line => /not resent/.test(line)))
  await settle(() => notes(home).turns?.b?.trigger?.exchangeId === message.source.exchangeId)
  assert.equal(second.agentOf('b').calls.length, 0)
  assert.equal(notes(home).queued.b[0].args.exchangeId, message.source.exchangeId)
})

test('a moved delivery retains its old history for later restart reconciliation', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const home = freshHome(t)
  const first = await start(home)
  await first.tool('message_bot', { to: 'Writer', message: 'Draft the plan', when: 'queue' }, 'a')
  const message = first.agentOf('b').calls[0]
  await settle(() => notes(home).queued?.b?.length === 1)
  first.rt.moveQueued('b-next', [message])
  await settle(() => notes(home).queued?.['b-next']?.length === 1)
  await first.stop()
  assert.deepEqual(notes(home).queued['b-next'][0].resumeOrigins, ['b'])
  const state = stateOf(home)
  state.bots.b.sessionId = 'b-next'
  writeFileSync(join(home, 'state.json'), JSON.stringify(state))
  const logs = new Map([['b', [{ type: 'user/message', data: { source: message.source } }]]])
  const warnings = []
  const second = await start(home, logs)
  second.ctx.logger.warn = (...args) => warnings.push(args.join(' '))
  t.mock.timers.tick(3000)
  await settle(() => warnings.some(line => /not resent/.test(line)))
  assert.equal(second.agentOf('b-next').calls.length, 0)
  await second.stop()
  assert.ok(notes(home).queued['b-next'][0].resumeOrigins.includes('b'))
})

test('corrupt recovery notes are preserved and block new Bot deliveries', async (t) => {
  const home = freshHome(t)
  const file = join(home, 'inflight.json')
  const original = Buffer.from('{"turns":{"b":', 'utf8')
  writeFileSync(file, original)
  const host = await start(home)
  await assert.rejects(host.tool('message_bot', { to: 'Writer', message: 'Draft the plan' }, 'a'), /Recovery notes are unavailable/)
  assert.equal(host.agentOf('b').calls.length, 0)
  await host.stop()
  assert.deepEqual(readFileSync(file), original)
  const entries = await readDiagnostics(home, rows => rows.some(row => /recovery notes.*unreadable/i.test(row.text)))
  assert.ok(entries.some(row => /original file is preserved/i.test(row.text)))
})

test('failure before replacement keeps the original recovery bytes', async (t) => {
  const home = freshHome(t)
  const file = join(home, 'inflight.json')
  const original = Buffer.from('{"turns":{},"queued":{}}')
  writeFileSync(file, original)
  const ops = {
    writeFile: fsp.writeFile,
    unlink: fsp.unlink,
    replaceFile: async () => { throw Object.assign(new Error('injected rename failure'), { code: 'EIO' }) },
  }
  await assert.rejects(writeNotesAtomically(file, '{"new":true}', () => {}, ops), { code: 'EIO' })
  assert.deepEqual(readFileSync(file), original)
  assert.deepEqual((await fsp.readdir(home)).filter(name => name.endsWith('.tmp')), [])
})

test('external recovery-file changes are preserved and halt future Bot deliveries', async (t) => {
  const home = freshHome(t)
  const file = join(home, 'inflight.json')
  const host = await start(home)
  await host.tool('message_bot', { to: 'Writer', message: 'First', when: 'queue' }, 'a')
  await settle(() => notes(home).queued?.b?.length === 1)
  const external = Buffer.from('{"turns":{},"queued":{"other":[]}}')
  writeFileSync(file, external)
  await assert.rejects(host.tool('message_bot', { to: 'Writer', message: 'Second', when: 'queue' }, 'a'), /ECONFLICT/)
  const entries = await readDiagnostics(home, rows => rows.some(row => /noting running turns failed/.test(row.text)))
  assert.ok(entries.some(row => /ECONFLICT/.test(row.text)))
  await assert.rejects(host.tool('message_bot', { to: 'Writer', message: 'Third' }, 'a'), /Recovery notes are unavailable/)
  assert.deepEqual(readFileSync(file), external)
})

test('a lost team lock prevents recovery notes from overwriting the previous file', async (t) => {
  const home = freshHome(t)
  const file = join(home, 'inflight.json')
  const host = await start(home)
  await host.tool('message_bot', { to: 'Writer', message: 'First', when: 'queue' }, 'a')
  await settle(() => notes(home).queued?.b?.length === 1)
  const original = readFileSync(file)
  writeFileSync(join(home, 'state.lock'), JSON.stringify({ pid: process.ppid, host: hostname(), token: 'new-owner' }))
  await assert.rejects(host.rt.deliver({ fromId: 'a', toId: 'b', role: 'request', text: 'Second' }), /ELOCKLOST/)
  const entries = await readDiagnostics(home, rows => rows.some(row => /noting running turns failed/.test(row.text)))
  assert.ok(entries.some(row => /ELOCKLOST/.test(row.text)))
  await assert.rejects(host.rt.deliver({ fromId: 'a', toId: 'b', role: 'request', text: 'Third' }), /Recovery notes are unavailable/)
  assert.deepEqual(readFileSync(file), original)
})

test('shutdown holds the state lock until concurrent recovery-note writes drain', async (t) => {
  const home = freshHome(t)
  const host = await start(home)
  const file = join(home, 'inflight.json')
  const originalRename = fsp.rename
  let entered
  let release
  const atRename = new Promise(resolve => { entered = resolve })
  const gate = new Promise(resolve => { release = resolve })
  let first = true
  fsp.rename = async (from, to) => {
    if (to === file && first) { first = false; entered(); await gate }
    return originalRename(from, to)
  }
  syncBuiltinESMExports()
  try {
    const one = host.rt.deliver({ fromId: 'a', toId: 'b', role: 'request', text: 'First' })
    await atRename
    const two = host.rt.deliver({ fromId: 'a', toId: 'b', role: 'request', text: 'Second' })
    await new Promise(resolve => setImmediate(resolve))
    const stopping = host.stop()
    assert.equal(existsSync(join(home, 'state.lock')), true)
    release()
    await Promise.all([assert.rejects(one, /delivery stopped/), assert.rejects(two, /delivery stopped/)])
    await stopping
    assert.equal(existsSync(join(home, 'state.lock')), false)
    assert.equal(notes(home).queued.b.length, 2)
    assert.ok(notes(home).queued.b.every(item => item.recoveryHold === 'prepared'))
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const restarted = await start(home)
    t.mock.timers.tick(3000)
    const entries = await readDiagnostics(home, rows => rows.filter(row => /send outcome is unknown/.test(row.text)).length >= 2)
    assert.ok(entries.filter(row => /send outcome is unknown/.test(row.text)).length >= 2)
    assert.equal(restarted.agentOf('b').calls.length, 0)
    assert.equal(notes(home).queued.b.length, 2)
  } finally {
    release()
    fsp.rename = originalRename
    syncBuiltinESMExports()
  }
})

test('a concurrent delivery waits for a snapshot containing its own exchange', async (t) => {
  const home = freshHome(t)
  const host = await start(home)
  const file = join(home, 'inflight.json')
  const originalRename = fsp.rename
  let firstEntered, secondEntered, releaseFirst, releaseSecond
  const firstAt = new Promise(resolve => { firstEntered = resolve })
  const secondAt = new Promise(resolve => { secondEntered = resolve })
  const firstGate = new Promise(resolve => { releaseFirst = resolve })
  const secondGate = new Promise(resolve => { releaseSecond = resolve })
  let count = 0
  fsp.rename = async (from, to) => {
    if (to === file && ++count === 1) { firstEntered(); await firstGate }
    else if (to === file && count === 2) { secondEntered(); await secondGate }
    return originalRename(from, to)
  }
  syncBuiltinESMExports()
  try {
    const one = host.rt.deliver({ fromId: 'a', toId: 'b', role: 'request', text: 'First', exchangeId: 'barrier-one' })
    await firstAt
    const two = host.rt.deliver({ fromId: 'a', toId: 'b', role: 'request', text: 'Second', exchangeId: 'barrier-two' })
    assert.equal(host.agentOf('b').calls.length, 0)
    releaseFirst()
    await secondAt
    await settle(() => host.agentOf('b').calls.length === 1)
    assert.equal(host.agentOf('b').calls[0].source.exchangeId, 'barrier-one')
    assert.deepEqual(notes(home).queued.b.map(item => item.args.exchangeId), ['barrier-one'])
    releaseSecond()
    await Promise.all([one, two])
    assert.deepEqual(host.agentOf('b').calls.map(message => message.source.exchangeId), ['barrier-one', 'barrier-two'])
  } finally {
    releaseFirst()
    releaseSecond()
    fsp.rename = originalRename
    syncBuiltinESMExports()
  }
})

test('sender identity remains stable if the Bot is deleted during the write barrier', async (t) => {
  const home = freshHome(t)
  const host = await start(home)
  const file = join(home, 'inflight.json')
  const originalRename = fsp.rename
  let release, entered
  const gate = new Promise(resolve => { release = resolve })
  const atRename = new Promise(resolve => { entered = resolve })
  fsp.rename = async (from, to) => {
    if (to === file) { entered(); await gate }
    return originalRename(from, to)
  }
  syncBuiltinESMExports()
  try {
    const pending = host.rt.deliver({ fromId: 'b', toId: 'a', role: 'reply', text: 'Writer was deleted.' })
    await atRename
    delete host.rt.state.bots.b
    release()
    await pending
    assert.match(text(host.agentOf('a').calls[0]), /^\[Reply from Writer\]/)
  } finally {
    release()
    fsp.rename = originalRename
    syncBuiltinESMExports()
  }
})
