import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../index.js'
import { fakeContext } from './fake-ctx.js'

// A fake team of two Bots in one group; member answers are played back through the
// session/event listener, so a round runs with no model.
function start() {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-rounds-'))
  const ctx = fakeContext()
  const workspaces = new Map()
  const sent = []
  const prompts = []
  let sessions = 0
  Object.assign(ctx, {
    llm: {
      listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
      listModels: async () => [{ id: 'deepseek-v4-flash' }],
      resolveModelInfo: async () => ({}),
    },
    workspaceRegistry: {
      get: id => workspaces.get(id),
      resolveByPath: async () => undefined,
      create: async (path) => {
        const workspace = { id: `w${workspaces.size + 1}`, path }
        workspaces.set(workspace.id, workspace)
        return workspace
      },
      archiveSession: async () => {},
    },
    sessionController: {
      create: async () => ({ sessionId: `s${++sessions}` }),
      resolveAgent: async sessionId => ({ agent: { session: { id: sessionId }, followup: message => sent.push({ sessionId, message }) } }),
      selectModel: async () => {},
      prompt: async (request) => { prompts.push(request); return { accepted: true } },
      page: async () => ({ events: [] }),
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
  const call = async (endpoint, payload) => {
    const response = await route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))
    return response.json()
  }
  // Session events arrive one at a time in DSH; awaiting each listener keeps that order.
  const emit = async (sessionId, event) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) await listener({ id: sessionId }, event)
  }
  const userMessage = text => ({ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } })
  // The Bot's answer to its group turn: a delivery source plus the reply text.
  const answer = async (sessionId, exchangeId, text, turn) => {
    await emit(sessionId, { type: 'turn/start', data: { turn } })
    await emit(sessionId, { type: 'user/message', data: { source: { kind: 'bot', role: 'room', exchangeId }, content: [{ type: 'text', text: 'your turn' }] } })
    await emit(sessionId, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } })
    await emit(sessionId, { type: 'turn/end', data: { reason: { kind: 'stop' } } })
  }
  const stop = () => {
    ctx.dispose()
    rmSync(home, { recursive: true, force: true })
  }
  return { call, emit, userMessage, answer, stop, sent, prompts, ctx }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 20))
const waitFor = async (check) => {
  for (let at = 0; at < 100; at += 1) {
    const value = check()
    if (value !== undefined) return value
    await settle()
  }
  return undefined
}

test('a message sent mid-round joins the round: the next speaker sees it, the queued copy opens no round', async (t) => {
  const { call, emit, userMessage, answer, stop, sent, prompts, ctx } = start()
  t.after(stop)
  const chief = (await call('state', {})).value.mainBotId
  const writer = (await call('create-bot', { name: 'Writer' })).value
  const room = (await call('create-room', { members: [chief, writer.id] })).value
  await call('update-room', { id: room.id, mode: 'everyone' })
  sent.length = 0

  // The user's first message queues and the relay opens the round: admin speaks first.
  await emit(room.id, userMessage('Tell me a long story'))
  const relay = ctx.registeredTools.get('group_relay').execute({}, { agent: { id: room.id }, callId: 'relay', signal: new AbortController().signal })
  const first = await waitFor(() => sent.find(entry => entry.message.source.role === 'room'))
  assert.ok(first, 'the admin gets the first turn')

  // While the admin is still answering, the user sends another message.
  assert.equal((await call('send', { sessionId: room.id, text: '@Writer ping mid-round' })).ok, true)
  await settle()

  // The admin answers; the Writer's turn prompt must already carry the new line.
  await answer(first.sessionId, first.message.source.exchangeId, 'Once upon a time...', 1)
  const second = await waitFor(() => sent.find(entry => entry !== first && entry.message.source.role === 'room'))
  assert.ok(second, 'the Writer gets the next turn')
  assert.match(second.message.content[0].text, /@Writer ping mid-round/)
  assert.match(second.message.content[0].text, /the user mentioned you/)

  // The Writer answers and the round ends; the earlier send also reached the Session.
  await answer(second.sessionId, second.message.source.exchangeId, 'Ping back!', 2)
  const result = JSON.parse(await relay)
  assert.deepEqual(result.replies.map(reply => reply.name ?? 'User'), ['Chief', 'User', 'Writer'])

  // The queued copy of the mid-round message arrives with the next turn: nothing new.
  await emit(room.id, userMessage('@Writer ping mid-round'))
  const before = sent.length
  const again = JSON.parse(await ctx.registeredTools.get('group_relay').execute({}, { agent: { id: room.id }, callId: 'relay-2', signal: new AbortController().signal }))
  assert.deepEqual(again, { replies: [], passed: [] })
  assert.equal(sent.length, before)
})

test('a message sent between rounds still opens a full round', async (t) => {
  const { call, emit, userMessage, answer, stop, sent, ctx } = start()
  t.after(stop)
  const chief = (await call('state', {})).value.mainBotId
  const writer = (await call('create-bot', { name: 'Writer' })).value
  const room = (await call('create-room', { members: [chief, writer.id] })).value
  await call('update-room', { id: room.id, mode: 'everyone' })
  sent.length = 0

  await emit(room.id, userMessage('Hello group'))
  const relay = ctx.registeredTools.get('group_relay').execute({}, { agent: { id: room.id }, callId: 'relay', signal: new AbortController().signal })
  const first = await waitFor(() => sent.find(entry => entry.message.source.role === 'room'))
  assert.ok(first)
  await answer(first.sessionId, first.message.source.exchangeId, 'Hi!', 1)
  const second = await waitFor(() => sent.find(entry => entry !== first && entry.message.source.role === 'room'))
  assert.ok(second)
  await answer(second.sessionId, second.message.source.exchangeId, 'Hello!', 2)
  const result = JSON.parse(await relay)
  assert.deepEqual(result.replies.map(reply => reply.name ?? 'User'), ['Chief', 'Writer'])
})
