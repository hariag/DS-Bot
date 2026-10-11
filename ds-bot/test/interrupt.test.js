import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../index.js'
import { fakeContext } from './fake-ctx.js'
import { install as installTurns } from '../src/host/turns.js'
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
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-interrupt-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(seed))
  const ctx = fakeContext()
  const agents = new Map()
  const agentOf = (sessionId) => {
    if (!agents.has(sessionId)) {
      const calls = []
      agents.set(sessionId, {
        session: { id: sessionId },
        calls,
        status: 'idle',
        followup(message) { calls.push(['followup', message]) },
        steer(message) { calls.push(['steer', message]) },
        inject(message) { calls.push(['inject', message]) },
        cancel(cause) { calls.push(['cancel', cause]) },
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
  return { ctx, agents, agentOf, emit, tool, call, exchanges, home, stop }
}

const textOf = content => content.map(block => block.text ?? '').join('\n')

test('interrupt_bot steers into the Bot\'s running turn; on an idle Bot it opens the next turn', async (t) => {
  const { agents, emit, tool, stop } = await start(team())
  t.after(stop)

  // Idle: the interrupt goes to the Bot's own chat and starts its next turn.
  const idle = await tool('interrupt_bot', { to: 'Writer', message: 'Stop — do not run that' }, 'a')
  assert.match(idle, /not running/)
  assert.deepEqual(agents.get('b').calls.map(([kind]) => kind), ['steer'])
  assert.match(textOf(agents.get('b').calls[0][1].content), /^\[Interrupt from Chief\]/)
  assert.equal(agents.get('b').calls[0][1].source.role, 'interrupt')

  // Running: the interrupt cuts into that turn instead of queuing.
  emit('b', 'turn/start', { turn: 1 })
  const busy = await tool('interrupt_bot', { to: 'Writer', message: 'Really, stop' }, 'a')
  assert.match(busy, /Interrupted Writer/)
  assert.deepEqual(agents.get('b').calls.map(([kind]) => kind), ['steer', 'steer'])
})

test('interrupt_bot steers every Session the Bot is running in, recording one exchange', async (t) => {
  const { agents, emit, tool, exchanges, stop } = await start(team({ group: true }))
  t.after(stop)

  emit('b', 'turn/start', { turn: 1 })
  emit('gb', 'turn/start', { turn: 1 })
  const out = await tool('interrupt_bot', { to: 'Writer', message: 'Hands off' }, 'a')
  assert.match(out, /its own chat/)
  assert.match(out, /group "Ops"/)
  assert.deepEqual(agents.get('b').calls.map(([kind]) => kind), ['steer'])
  assert.deepEqual(agents.get('gb').calls.map(([kind]) => kind), ['steer'])
  const logged = await exchanges()
  assert.equal(logged.filter(entry => entry.role === 'interrupt').length, 1)
})

test('interrupt_bot and stop_bot belong to a Main Bot', async (t) => {
  const { agents, tool, stop } = await start(team())
  t.after(stop)

  assert.equal(await tool('interrupt_bot', { to: 'Writer', message: 'x' }, 'b'), 'Only a Main Bot can interrupt other Bots.')
  assert.equal(await tool('stop_bot', { bot: 'Writer' }, 'b'), 'Only a Main Bot can stop other Bots.')
  assert.equal(await tool('interrupt_bot', { to: 'Chief', message: 'x' }, 'a'), 'You cannot interrupt yourself.')
  assert.equal(await tool('stop_bot', { bot: 'Chief' }, 'a'), 'You cannot stop yourself.')
  assert.deepEqual(agents.get('b')?.calls ?? [], [])
})

test('stop_bot cancels the running turns and tells the Bot why in a new turn', async (t) => {
  const { agents, emit, tool, stop } = await start(team({ group: true }))
  t.after(stop)

  assert.match(await tool('stop_bot', { bot: 'Writer' }, 'a'), /not running/)

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

test('a steered interrupt never claims the running turn or steals the next one', () => {
  const { emit, delivered } = turnsHost()
  // The running turn answers a request; an interrupt cuts in mid-turn.
  emit('b', 'turn/start', { turn: 1 })
  emit('b', 'user/message', { content: [{ type: 'text', text: 'hi' }], source: replySource('request') })
  emit('b', 'user/message', { content: [{ type: 'text', text: 'stop' }], source: replySource('interrupt', { exchangeId: 'i1' }) })
  emit('b', 'assistant/message', { message: { content: [{ type: 'text', text: 'done' }] } })
  emit('b', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  // The turn's reply routes to the request, not to the interrupt.
  assert.equal(delivered.length, 1)
  assert.equal(delivered[0].replyTo, 'x1')
  assert.equal(delivered[0].role, 'reply')

  // An interrupt left behind must not claim the next turn either.
  emit('b', 'turn/start', { turn: 2 })
  emit('b', 'user/message', { content: [{ type: 'text', text: 'q' }], source: replySource('request', { exchangeId: 'x2' }) })
  emit('b', 'assistant/message', { message: { content: [{ type: 'text', text: 'ok' }] } })
  emit('b', 'turn/end', { turn: 2, reason: { kind: 'completed' } })
  assert.equal(delivered.length, 2)
  assert.equal(delivered[1].replyTo, 'x2')
})

test('a turn stopped before answering still closes the exchange for the sender', () => {
  const { emit, delivered } = turnsHost()
  emit('b', 'turn/start', { turn: 1 })
  emit('b', 'user/message', { content: [{ type: 'text', text: 'hi' }], source: replySource('request') })
  emit('b', 'turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'hook', reason: 'ds-bot/stopped' } } })
  assert.equal(delivered.length, 1)
  assert.equal(delivered[0].toId, 'a')
  assert.equal(delivered[0].role, 'reply')
  assert.equal(delivered[0].replyTo, 'x1')
  assert.match(delivered[0].text, /was stopped before it could answer/)
})

test('a stopped notice routes the acknowledgement back like a request', () => {
  const { rt, emit, delivered } = turnsHost()
  emit('b', 'turn/start', { turn: 1 })
  emit('b', 'user/message', { content: [{ type: 'text', text: 'why' }], source: replySource('stopped', { exchangeId: 's1' }) })
  assert.deepEqual(rt.state.exchangeTurns.b, [1])
  emit('b', 'assistant/message', { message: { content: [{ type: 'text', text: 'understood' }] } })
  emit('b', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  assert.equal(delivered.length, 1)
  assert.equal(delivered[0].toId, 'a')
  assert.equal(delivered[0].role, 'reply')
  assert.equal(delivered[0].replyTo, 's1')
  assert.equal(delivered[0].text, 'understood')
})
