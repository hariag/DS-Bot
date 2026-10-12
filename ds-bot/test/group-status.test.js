import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../index.js'
import { fakeContext } from './fake-ctx.js'
import { ROOM_REPLY_TIMEOUT_MS } from '../src/host/constants.js'

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

async function start() {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-status-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(seed()))
  const ctx = fakeContext()
  const agents = new Map()
  const agentOf = (sessionId) => {
    if (!agents.has(sessionId)) {
      const calls = []
      agents.set(sessionId, { session: { id: sessionId }, calls, followup(message) { calls.push(message) }, steer(message) { calls.push(message) } })
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
  apply(ctx, { home })
  let seq = 0
  const emit = (id, type, data) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) {
      if (listener.length >= 2) listener({ id }, { type, seq: ++seq, data })
    }
  }
  const tool = (name, args, sessionId, exec = {}) => ctx.registeredTools.get(name).execute(args, { agent: { id: sessionId }, ...exec })
  const call = async (endpoint, payload) => (await route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))).json()
  const askApproval = (sessionId, extra = {}, next = () => 'from-dsh') => ctx.listeners.get('approval/request')[0]({ agent: { session: { id: sessionId } }, toolName: 'pwsh', reason: 'escalate sandbox', ...extra }, next)
  const stop = () => { ctx.dispose(); rmSync(home, { recursive: true, force: true }) }
  await tool('list_bots', {}, 'a')
  return { agentOf, emit, tool, call, askApproval, stop }
}

// Waits on real I/O (state writes) without timers, which some tests mock.
const settle = async (check) => {
  const until = Date.now() + 3000
  while (!check() && Date.now() < until) await new Promise(resolve => setImmediate(resolve))
  assert.ok(check(), 'condition not reached')
}
const text = message => message.content.map(block => block.text ?? '').join('\n')

// Starts a round in 'r1' and opens Writer's turn in 'gb'; the round stops with the test.
async function openTurn(t, { agentOf, emit, tool }) {
  let result
  const stop = new AbortController()
  t.after(() => stop.abort())
  void tool('group_relay', {}, 'r1', { callId: 'c1', signal: stop.signal }).then((value) => { result = JSON.parse(value) })
  await settle(() => agentOf('gb').calls.length === 1)
  const message = agentOf('gb').calls[0]
  emit('gb', 'turn/start', { turn: 1 })
  emit('gb', 'user/message', { content: message.content, source: message.source })
  return () => result
}

test('a group Session\'s approval waits in the team view, frees the round, and the late reply reaches the group', async (t) => {
  const host = await start()
  t.after(host.stop)
  const result = await openTurn(t, host)
  host.emit('gb', 'tool/call', { callId: 'k1', name: 'pwsh', arguments: JSON.stringify({ command: 'Copy-Item a.md E:/docs', description: 'Copy the doc' }) })
  const outcome = host.askApproval('gb', { callId: 'k1' })

  await settle(() => result() !== undefined)
  assert.deepEqual(result().replies.map(reply => [reply.kind, reply.name]), [['approval', 'Writer']])

  const { value } = await host.call('state', {})
  assert.equal(value.activity.b, 'alert')
  const [approval] = value.work.approvals
  assert.deepEqual([approval.botId, approval.roomId, approval.tool, approval.answerable], ['b', 'r1', 'pwsh', true])
  assert.deepEqual(approval.detail, { text: 'Copy the doc', code: 'Copy-Item a.md E:/docs' })
  assert.equal(value.work.bots.b.roomId, 'r1')
  assert.equal(value.work.bots.b.tool, 'pwsh')

  assert.equal((await host.call('approval-answer', { id: approval.id, choice: 'allow' })).ok, true)
  assert.equal(await outcome, 'allowed-once')
  assert.equal((await host.call('approval-answer', { id: approval.id, choice: 'allow' })).error.code, 'bot/stale')
  assert.deepEqual((await host.call('state', {})).value.work.approvals, [])

  host.emit('gb', 'tool/result', { callId: 'k1' })
  host.emit('gb', 'assistant/message', { message: { content: [{ type: 'text', text: 'Writer: Copied the doc to E:/docs.' }] } })
  host.emit('gb', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await settle(() => host.agentOf('r1').calls.length === 1)
  const post = host.agentOf('r1').calls[0]
  assert.deepEqual([post.source.role, post.source.late, post.source.senderSessionId], ['post', true, 'b'])
  assert.equal(text(post), '[Group post from Writer]\nCopied the doc to E:/docs.')
})

test('an own chat\'s approval stays with DSH and is listed while it waits', async (t) => {
  const host = await start()
  t.after(host.stop)
  let release
  const outcome = host.askApproval('a', {}, () => new Promise((resolve) => { release = resolve }))
  const [approval] = (await host.call('state', {})).value.work.approvals
  assert.deepEqual([approval.botId, approval.roomId, approval.answerable], ['a', undefined, false])
  assert.equal((await host.call('approval-answer', { id: approval.id, choice: 'allow' })).error.code, 'bot/stale')
  release('rejected')
  assert.equal(await outcome, 'rejected')
  assert.deepEqual((await host.call('state', {})).value.work.approvals, [])
  // Sessions off the team are not DS Bot's to answer.
  assert.equal(await host.askApproval('elsewhere'), 'from-dsh')
})

test('a member at work keeps its turn; one quiet for the whole wait is missed, and a later [PASS] stays out of the group', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const host = await start()
  t.after(host.stop)
  const result = await openTurn(t, host)
  t.mock.timers.tick(ROOM_REPLY_TIMEOUT_MS - 1000)
  host.emit('gb', 'tool/call', { callId: 'k1', name: 'shell', arguments: '{}' })
  t.mock.timers.tick(ROOM_REPLY_TIMEOUT_MS - 1000)
  await settle(() => true)
  assert.equal(result(), undefined)

  t.mock.timers.tick(1000)
  await settle(() => result() !== undefined)
  assert.deepEqual(result().replies.map(reply => [reply.kind, reply.name]), [['missed', 'Writer']])

  host.emit('gb', 'assistant/message', { message: { content: [{ type: 'text', text: '[PASS]' }] } })
  host.emit('gb', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await settle(() => true)
  assert.equal(host.agentOf('r1').calls.length, 0)
})
