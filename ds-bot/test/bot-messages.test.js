import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { apply } from '../index.js'
import { fakeContext } from './fake-ctx.js'
import { install as installTurns } from '../src/host/turns.js'
import { install as installParts } from '../src/host/parts.js'
import { SOURCE_KIND } from '../src/host/constants.js'

// A two-Bot team, optionally with b in a group Session 'gb' of room 'Ops'.
function team({ group = false } = {}) {
  return {
    version: 1,
    mainBotIds: ['a'],
    bots: {
      a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1 },
      b: { id: 'b', name: 'Writer', role: 'Write', sessionId: 'b', createdAt: 2 },
    },
    rooms: group ? { r1: { id: 'r1', name: 'Ops', members: ['a', 'b'], mode: 'admin', admin: 'a', named: true, sessions: { b: 'gb' } } } : {},
    agents: {},
    exchanges: [],
    exchangeTurns: {},
    questions: {},
    prefs: {},
    revision: 0,
  }
}

// Services for a full apply(): resolveAgent returns a per-Session agent that
// records followup/steer/inject/cancel calls.
async function start(seed) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-messages-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(seed))
  const ctx = fakeContext()
  const agents = new Map()
  const agentOf = (sessionId) => {
    if (!agents.has(sessionId)) {
      const calls = []
      agents.set(sessionId, {
        session: { id: sessionId, requestHeader: () => undefined },
        id: sessionId,
        calls,
        status: 'idle',
        followup(message) { calls.push(['followup', message]) },
        steer(message) { calls.push(['steer', message]) },
        inject(message) { calls.push(['inject', message]) },
        cancel(cause) { calls.push(['cancel', cause]) },
        async whenIdle() {},
        async runMaintenance(fn) { return fn(AbortSignal.timeout(60_000)) },
        inbox: { nextStep: [], nextTurn: [], remove() {} },
      })
    }
    return agents.get(sessionId)
  }
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: {
      get: () => undefined,
      resolveByPath: async () => undefined,
      create: async path => ({ id: 'w1', path }),
      archiveSession: async () => {},
    },
    sessionController: {
      create: async () => ({ sessionId: 's1' }),
      resolveAgent: async sessionId => ({ agent: agentOf(sessionId) }),
      selectModel: async () => {},
      page: async () => ({ records: [], hasMore: false }),
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => {
    route = options
    return register(options)
  }
  apply(ctx, { home })
  let seq = 0
  const emit = (id, type, data) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) {
      if (listener.length >= 2) listener({ id }, { type, seq: ++seq, data })
    }
  }
  // Runs every registered waterfall listener; `next` settles the chain.
  const fire = (name, payload) => Promise.all((ctx.listeners.get(name) ?? []).map(listener => listener(payload, () => Promise.resolve(undefined))))
  const tool = (name, args, sessionId) => ctx.registeredTools.get(name).execute(args, { agent: { id: sessionId } })
  const call = async (endpoint, payload) => (await route.fetch(new Request('http://localhost/api/bot', {
    method: 'POST', body: JSON.stringify({ endpoint, payload }),
  }))).json()
  const exchanges = async () => (await call('exchange', { a: 'a', b: 'b' })).value ?? []
  const stop = () => {
    ctx.dispose()
    rmSync(home, { recursive: true, force: true })
  }
  // Loading once fills the Session-owner indexes turns.js filters events by.
  await tool('list_bots', {}, 'a')
  return { ctx, agents, agentOf, emit, fire, tool, call, exchanges, home, stop }
}

const textOf = content => content.map(block => block.text ?? '').join('\n')

test('message_bot steers by default; on an idle Bot it opens the next turn', async (t) => {
  const { agents, emit, tool, stop } = await start(team())
  t.after(stop)

  // Idle: the message goes to the Bot's own chat and starts its next turn.
  const idle = await tool('message_bot', { to: 'Writer', message: 'how are you' }, 'a')
  assert.equal(idle, 'Delivered to Writer. Its reply will arrive later as a new message; do not wait for it.')
  assert.deepEqual(agents.get('b').calls.map(([kind]) => kind), ['steer'])
  assert.match(textOf(agents.get('b').calls[0][1].content), /^\[Message from Chief\]/)
  assert.equal(agents.get('b').calls[0][1].source.role, 'request')

  // Running: the message cuts into that turn instead of queuing.
  emit('b', 'turn/start', { turn: 1 })
  const busy = await tool('message_bot', { to: 'Writer', message: 'watch out' }, 'a')
  assert.equal(busy, 'Delivered to Writer while it is working: it reads your message at its next step. Its reply will arrive later as a new message; do not wait for it.')
  assert.deepEqual(agents.get('b').calls.map(([kind]) => kind), ['steer', 'steer'])
})

test('message_bot when "queue" waits for the current work, and reply_to "user" always queues', async (t) => {
  const { agents, emit, tool, stop } = await start(team())
  t.after(stop)

  emit('b', 'turn/start', { turn: 1 })
  const queued = await tool('message_bot', { to: 'Writer', message: 'later', when: 'queue' }, 'a')
  assert.equal(queued, 'Queued for Writer: it reads your message after its current work. Its reply will arrive later as a new message; do not wait for it.')
  assert.deepEqual(agents.get('b').calls.map(([kind]) => kind), ['followup'])

  const toUser = await tool('message_bot', { to: 'Writer', message: 'tell them', reply_to: 'user', when: 'now' }, 'a')
  assert.equal(toUser, 'Delivered to Writer. It will answer the user in its own chat; nothing comes back to you, so point the user to Writer\'s chat instead of relaying.')
  assert.deepEqual(agents.get('b').calls.map(([kind]) => kind), ['followup', 'followup'])
  assert.equal(agents.get('b').calls[1][1].source.audience, 'user')
})

test('a non-Main Bot can steer a message to a Main Bot', async (t) => {
  const { agents, tool, stop } = await start(team())
  t.after(stop)

  const out = await tool('message_bot', { to: 'Chief', message: 'heads up' }, 'b')
  assert.equal(out, 'Delivered to Chief. Its reply will arrive later as a new message; do not wait for it.')
  assert.deepEqual(agents.get('a').calls.map(([kind]) => kind), ['steer'])
  assert.equal(agents.get('a').calls[0][1].source.senderSessionId, 'b')
})

test('stop_bot cancels the running turns and tells the Bot why in a new turn', async (t) => {
  const { agents, emit, tool, stop } = await start(team({ group: true }))
  t.after(stop)

  await assert.rejects(tool('stop_bot', { bot: 'Writer' }, 'a'), /not running/)
  assert.deepEqual(agents.get('b')?.calls ?? [], [])

  emit('b', 'turn/start', { turn: 1 })
  emit('gb', 'turn/start', { turn: 1 })
  const out = await tool('stop_bot', { bot: 'Writer', reason: 'that command deletes data' }, 'a')
  assert.match(out, /Stopped Writer in its own chat and group "Ops"/)
  assert.deepEqual(agents.get('b').calls.map(([kind]) => kind), ['cancel', 'followup'])
  assert.deepEqual(agents.get('b').calls[0][1], { kind: 'hook', reason: 'ds-bot/stopped' })
  assert.deepEqual(agents.get('gb').calls.map(([kind]) => kind), ['cancel'])
  const notice = agents.get('b').calls[1][1]
  assert.match(textOf(notice.content), /^\[Stopped by Chief\]\nthat command deletes data$/)
  assert.equal(notice.source.role, 'stopped')
})

test('stop_bot belongs to a Main Bot', async (t) => {
  const { tool, stop } = await start(team())
  t.after(stop)

  await assert.rejects(tool('stop_bot', { bot: 'Writer' }, 'b'), { message: 'Only a Main Bot can stop other Bots.' })
  await assert.rejects(tool('stop_bot', { bot: 'Chief' }, 'a'), { message: 'You cannot stop yourself.' })
  await assert.rejects(tool('stop_bot', { bot: 'Writer' }, 'a'), { message: 'Writer is not running right now, so there is nothing to stop. Use message_bot to reach it.' })
})

function turnsHost() {
  let listener
  const delivered = []
  const rt = {
    ctx: { on: (name, fn) => { if (name === 'session/event') listener = fn } },
    state: { exchangeTurns: {}, questions: {} },
    bots: { a: { id: 'a', name: 'Chief' }, b: { id: 'b', name: 'Writer' } },
    isBotSession: () => true,
    roomOf: () => undefined,
    groupOwners: new Map(),
    chatOwners: new Map(),
    botOf: id => rt.bots[id],
    selfOf: id => id,
    save: async () => {},
    deliver: async (args) => { delivered.push(args) },
    noteFailure() {},
    warn() {},
    switchJobs: () => [],
    dropKickoff() {},
  }
  installTurns(rt)
  let seq = 0
  const emit = (id, type, data) => listener({ id }, { type, seq: ++seq, data })
  return { rt, emit, delivered }
}

const replySource = (role, extra = {}) => ({ kind: SOURCE_KIND, role, senderSessionId: 'a', senderName: 'Chief', exchangeId: 'x1', hop: 0, ...extra })
const textBlock = (content) => [{ type: 'text', text: content }]
const assistantText = text => ({ message: { content: textBlock(text) } })

test('a stopped notice routes the acknowledgement back like a request', () => {
  const { rt, emit, delivered } = turnsHost()
  emit('b', 'turn/start', { turn: 1 })
  emit('b', 'user/message', { content: textBlock('[Stopped by Chief]\nwhy'), source: replySource('stopped', { exchangeId: 's1' }) })
  assert.deepEqual(rt.state.exchangeTurns.b, [1])
  emit('b', 'assistant/message', assistantText('understood'))
  emit('b', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  assert.equal(delivered.length, 1)
  assert.equal(delivered[0].toId, 'a')
  assert.equal(delivered[0].role, 'reply')
  assert.equal(delivered[0].replyTo, 's1')
  assert.equal(delivered[0].text, 'understood')
})

test('a request that joins a user-started turn answers with the text that follows it', () => {
  const { rt, emit, delivered } = turnsHost()
  emit('b', 'turn/start', { turn: 1 })
  emit('b', 'user/message', { content: textBlock('write the letter'), source: { kind: 'user' } })
  emit('b', 'assistant/message', assistantText('first half'))
  emit('b', 'user/message', { content: textBlock('[Message from Chief]\nmake it shorter'), source: replySource('request', { exchangeId: 'e1' }) })
  emit('b', 'assistant/message', assistantText('second half'))
  emit('b', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  assert.equal(delivered.length, 1)
  assert.equal(delivered[0].toId, 'a')
  assert.equal(delivered[0].role, 'reply')
  assert.equal(delivered[0].replyTo, 'e1')
  assert.equal(delivered[0].text, 'second half')
  assert.deepEqual(rt.state.exchangeTurns, {})
})

test('a request that joins a Bot-triggered turn gets only the after-text, the trigger the whole turn', () => {
  const { rt, emit, delivered } = turnsHost()
  emit('b', 'turn/start', { turn: 1 })
  emit('b', 'user/message', { content: textBlock('[Message from Chief]\ntask'), source: replySource('request', { exchangeId: 'e0' }) })
  emit('b', 'assistant/message', assistantText('first half'))
  emit('b', 'user/message', { content: textBlock('[Message from Chief]\nmore'), source: replySource('request', { exchangeId: 'e1' }) })
  emit('b', 'assistant/message', assistantText('second half'))
  emit('b', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  assert.deepEqual(rt.state.exchangeTurns.b, [1])
  assert.deepEqual(delivered.map(job => [job.replyTo, job.text]), [['e0', 'first half\n\nsecond half'], ['e1', 'second half']])
})

test('a joined request aborted without after-text still answers its sender', () => {
  const { emit, delivered } = turnsHost()
  emit('b', 'turn/start', { turn: 1 })
  emit('b', 'user/message', { content: textBlock('write the letter'), source: { kind: 'user' } })
  emit('b', 'assistant/message', assistantText('first half'))
  emit('b', 'user/message', { content: textBlock('[Message from Chief]\nmore'), source: replySource('request', { exchangeId: 'e1' }) })
  emit('b', 'turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'hook', reason: 'ds-bot/stopped' } } })
  assert.equal(delivered.length, 1)
  assert.equal(delivered[0].toId, 'a')
  assert.equal(delivered[0].replyTo, 'e1')
  assert.match(delivered[0].text, /was stopped before it could answer/)
})

test('a joined request gets the failure notice when the model call fails', () => {
  const { emit, delivered } = turnsHost()
  emit('b', 'turn/start', { turn: 1 })
  emit('b', 'user/message', { content: textBlock('write the letter'), source: { kind: 'user' } })
  emit('b', 'assistant/message', assistantText('first half'))
  emit('b', 'user/message', { content: textBlock('[Message from Chief]\nmore'), source: replySource('request', { exchangeId: 'e1' }) })
  emit('b', 'turn/end', { turn: 1, reason: { kind: 'error', error: { code: 'SERVER', message: 'upstream busy', status: 503 } } })
  assert.equal(delivered.length, 1)
  assert.equal(delivered[0].replyTo, 'e1')
  assert.match(delivered[0].text, /^Writer could not answer your message: its model call failed \(SERVER 503: upstream busy\)/)
})

test('a joined request never claims the next turn', () => {
  const { rt, emit, delivered } = turnsHost()
  emit('b', 'turn/start', { turn: 1 })
  emit('b', 'user/message', { content: textBlock('write the letter'), source: { kind: 'user' } })
  emit('b', 'user/message', { content: textBlock('[Message from Chief]\nmore'), source: replySource('request', { exchangeId: 'e1' }) })
  emit('b', 'assistant/message', assistantText('answer'))
  emit('b', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  emit('b', 'turn/start', { turn: 2 })
  emit('b', 'user/message', { content: textBlock('next task'), source: { kind: 'user' } })
  emit('b', 'assistant/message', assistantText('for the user'))
  emit('b', 'turn/end', { turn: 2, reason: { kind: 'completed' } })
  assert.equal(delivered.length, 1)
  assert.equal(delivered[0].replyTo, 'e1')
  assert.deepEqual(rt.state.exchangeTurns, {})
})

test('a schedule-started turn stays visible when a request joins', () => {
  const { rt, emit, delivered } = turnsHost()
  emit('b', 'turn/start', { turn: 1 })
  emit('b', 'user/message', { content: textBlock('routine'), source: { kind: 'schedule' } })
  emit('b', 'assistant/message', assistantText('before'))
  emit('b', 'user/message', { content: textBlock('[Message from Chief]\nmore'), source: replySource('request', { exchangeId: 'e1' }) })
  emit('b', 'assistant/message', assistantText('after'))
  emit('b', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  assert.equal(delivered.length, 1)
  assert.equal(delivered[0].replyTo, 'e1')
  assert.equal(delivered[0].text, 'after')
  assert.deepEqual(rt.state.exchangeTurns, {})
})

test('a duplicate exchangeId joins no second reply', () => {
  const { emit, delivered } = turnsHost()
  emit('b', 'turn/start', { turn: 1 })
  emit('b', 'user/message', { content: textBlock('[Message from Chief]\ntask'), source: replySource('request', { exchangeId: 'e0' }) })
  emit('b', 'user/message', { content: textBlock('[Message from Chief]\ntask'), source: replySource('request', { exchangeId: 'e0' }) })
  emit('b', 'assistant/message', assistantText('answer'))
  emit('b', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  assert.equal(delivered.length, 1)
  assert.equal(delivered[0].replyTo, 'e0')
})

test('a joined request crosses a part switch and is answered in the new part', async (t) => {
  const { agents, agentOf, emit, fire, stop } = await start(team())
  t.after(stop)

  emit('b', 'turn/start', { turn: 1 })
  emit('b', 'user/message', { content: textBlock('[Message from Chief]\ntask'), source: replySource('request', { exchangeId: 'e0' }) })
  emit('b', 'assistant/message', assistantText('half'))
  emit('b', 'user/message', { content: textBlock('[Message from Chief]\nmore'), source: replySource('request', { exchangeId: 'e1' }) })
  // The model call hits the window: the turn stops and the part moves on.
  await fire('agent/request-error', { failure: { code: 'CONTEXT_WINDOW_EXCEEDED' }, signal: AbortSignal.timeout(60_000), agent: agentOf('b') })
  emit('b', 'turn/end', { turn: 1, reason: { kind: 'error', error: { code: 'CONTEXT_WINDOW_EXCEEDED' } } })
  // Neither the trigger nor the joined request answers from the old part.
  for (let count = 0; count < 200 && agents.get('s1')?.calls.find(([, message]) => message.source?.handoff === true) === undefined; count += 1) await delay(5)
  const handoff = agents.get('s1').calls.find(([, message]) => message.source?.handoff === true)[1]
  assert.equal((agents.get('a')?.calls ?? []).filter(([, message]) => message.source?.role === 'reply').length, 0)
  assert.equal(handoff.source.exchangeId, 'e0')
  assert.deepEqual(handoff.source.joined.map(info => info.exchangeId), ['e1'])

  // The resumed turn routes the trigger's and the joined request's replies.
  emit('s1', 'turn/start', { turn: 1 })
  emit('s1', 'user/message', { content: textBlock('[Handoff]\npackage'), source: handoff.source })
  emit('s1', 'assistant/message', assistantText('done'))
  emit('s1', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  for (let count = 0; count < 200 && (agents.get('a')?.calls ?? []).length < 2; count += 1) await delay(5)
  const replies = (agents.get('a')?.calls ?? []).filter(([, message]) => message.source?.role === 'reply')
  assert.deepEqual(replies.map(([, message]) => message.source.replyTo), ['e0', 'e1'])
  assert.equal(textOf(replies[0][1].content), '[Reply from Writer]\ndone')
  assert.equal(textOf(replies[1][1].content), '[Reply from Writer]\ndone')
})

test('the caller hop is the highest of the turn\'s trigger and joined requests', async (t) => {
  const { agents, emit, tool, stop } = await start(team())
  t.after(stop)

  emit('b', 'turn/start', { turn: 1 })
  emit('b', 'user/message', { content: textBlock('[Message from Chief]\ntask'), source: replySource('request', { exchangeId: 'e0', hop: 1 }) })
  emit('b', 'user/message', { content: textBlock('[Message from Chief]\nmore'), source: replySource('request', { exchangeId: 'e1', hop: 4 }) })
  await tool('message_bot', { to: 'Chief', message: 'onward' }, 'b')
  assert.equal(agents.get('a').calls[0][1].source.hop, 4)
})

test('an earlier part keeps the request its Bot answered', async () => {
  const writer = { id: 'b', name: 'Writer', createdAt: 1, sessionId: 'b2', segments: [{ sessionId: 'b1', endedAt: 2 }] }
  const events = [
    { type: 'user/message', seq: 1, time: 10, data: { turn: 1, content: [{ type: 'text', text: '[Message from Chief]\nDo not delete that' }], source: replySource('request') } },
    { type: 'assistant/message', seq: 2, time: 11, data: { turn: 1, message: { content: [{ type: 'text', text: 'Understood, I stopped.' }] } } },
  ]
  const rt = {
    ctx: { on() {}, effect() {}, get() {}, sessionController: { page: async () => ({ records: events.map(event => ({ event })), hasMore: false }) } },
    config: {},
    state: { exchangeTurns: {} },
    chatOwners: new Map([['b2', 'b']]),
    pastOwners: new Map([['b1', { botId: 'b' }]]),
    botOf: id => (id === 'b' ? writer : undefined),
    roomOf: () => undefined,
    chatOf: () => 'b2',
    resolveAgent: async id => ({ session: { id, seq: 3 } }),
  }
  installParts(rt)
  const { items } = await rt.earlierPage('b2')
  assert.deepEqual(items.map(item => [item.kind, item.role ?? item.text]), [['event', 'request'], ['bot', 'Understood, I stopped.']])
  assert.equal(items[0].botId, 'a')
})
