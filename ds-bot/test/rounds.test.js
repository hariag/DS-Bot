import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeAttachments, fakeContext } from './fake-ctx.js'

// A fake team of two Bots in one group; member answers are played back through the
// session/event listener, so a round runs with no model. Prompts land in the
// Session's inbox the way DSH holds them while a turn runs: queued for the next turn,
// or steered into the next step.
// `home`: start on the data of an earlier run, as after a restart.
function start({ home = mkdtempSync(join(tmpdir(), 'ds-bot-rounds-')) } = {}) {
  const ctx = fakeContext()
  const workspaces = new Map()
  const sent = []
  const inboxes = new Map()
  const inboxOf = (sessionId) => {
    if (!inboxes.has(sessionId)) {
      const inbox = { nextTurn: [], nextStep: [] }
      inbox.remove = (id) => {
        for (const list of ['nextTurn', 'nextStep']) {
          const at = inbox[list].findIndex(message => message.id === id)
          if (at !== -1) {
            inbox[list] = inbox[list].toSpliced(at, 1)
            return true
          }
        }
        return false
      }
      inboxes.set(sessionId, inbox)
    }
    return inboxes.get(sessionId)
  }
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
      prompt: async (request) => {
        const inbox = inboxOf(request.sessionId)
        inbox[request.mode === 'steer' ? 'nextStep' : 'nextTurn'].push({ id: randomUUID(), role: 'user', source: { kind: 'user', rpcId: request.requestId }, content: request.content })
        return { accepted: true }
      },
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
  const rt = createRuntime(ctx, { home })
  const call = async (endpoint, payload) => {
    const response = await route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))
    return response.json()
  }
  // Session events arrive one at a time in DSH; awaiting each listener keeps that order.
  const emit = async (sessionId, event) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) await listener({ id: sessionId }, event)
  }
  const userMessage = text => ({ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } })
  // What the shell's composer does: prompt the group's Session directly.
  const compose = (sessionId, content, mode = 'queue') => ctx.sessionController.prompt({
    requestId: randomUUID(),
    sessionId,
    mode,
    content: typeof content === 'string' ? [{ type: 'text', text: content }] : content,
  })
  const relay = (roomId, callId, signal = new AbortController().signal) => ctx.registeredTools.get('group_relay')
    .execute({}, { agent: { id: roomId, inbox: inboxOf(roomId) }, callId, signal })
  // The Bot's answer to its group turn: a delivery source plus the reply text.
  const answer = async (sessionId, exchangeId, text, turn) => {
    await emit(sessionId, { type: 'turn/start', data: { turn } })
    await emit(sessionId, { type: 'user/message', data: { source: { kind: 'bot', role: 'room', exchangeId }, content: [{ type: 'text', text: 'your turn' }] } })
    await emit(sessionId, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } })
    await emit(sessionId, { type: 'turn/end', data: { reason: { kind: 'stop' } } })
  }
  const stop = async ({ keep = false } = {}) => {
    await ctx.dispose()
    if (!keep) rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  return { call, emit, userMessage, compose, relay, inboxOf, answer, stop, sent, ctx, home, rt }
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
const turnFor = (sent, ...earlier) => waitFor(() => sent.find(entry => !earlier.includes(entry) && entry.message.source.role === 'room'))

test('a new group Session waits for capabilities before its first member prompt', async (t) => {
  const { call, emit, userMessage, relay, answer, stop, sent, rt } = start()
  t.after(stop)
  const room = await team(call, sent)
  await emit(room.id, userMessage('Start'))

  let release
  let markStarted
  const gate = new Promise(resolve => { release = resolve })
  const started = new Promise(resolve => { markStarted = resolve })
  rt.ensureCapabilities = async sessionId => {
    markStarted(sessionId)
    await gate
  }
  const running = relay(room.id, 'first-turn')
  const sessionId = await started
  assert.equal(sent.length, 0)
  release()

  const first = await turnFor(sent)
  assert.equal(first.sessionId, sessionId)
  await answer(first.sessionId, first.message.source.exchangeId, 'Chief ready.', 1)
  const second = await turnFor(sent, first)
  assert.ok(second)
  await answer(second.sessionId, second.message.source.exchangeId, 'Writer ready.', 2)
  await running
})

async function team(call, sent) {
  const chief = (await call('state', {})).value.mainBotId
  const writer = (await call('create-bot', { name: 'Writer' })).value
  const room = (await call('create-room', { name: 'R1', members: [chief, writer.id] })).value
  await call('update-room', { id: room.id, mode: 'everyone' })
  sent.length = 0
  return room
}

test('a message the composer queues mid-round joins the round and leaves the Session\'s queue', async (t) => {
  const { call, emit, userMessage, compose, relay, inboxOf, answer, stop, sent } = start()
  t.after(stop)
  const room = await team(call, sent)

  // The user's first message opens the round: the admin speaks first.
  await emit(room.id, userMessage('Tell me a long story'))
  const running = relay(room.id, 'relay')
  const first = await turnFor(sent)
  assert.ok(first, 'the admin gets the first turn')

  // While the admin is still answering, the user sends another message.
  await compose(room.id, '@Writer ping mid-round')

  // The admin answers; the Writer's turn prompt must already carry the new line.
  await answer(first.sessionId, first.message.source.exchangeId, 'Once upon a time...', 1)
  const second = await turnFor(sent, first)
  assert.ok(second, 'the Writer gets the next turn')
  assert.match(second.message.content[0].text, /@Writer ping mid-round/)
  assert.match(second.message.content[0].text, /the user mentioned you/)

  await answer(second.sessionId, second.message.source.exchangeId, 'Ping back!', 2)
  const result = JSON.parse(await running)
  assert.deepEqual(result.replies.map(reply => reply.name ?? 'User'), ['Chief', 'User', 'Writer'])
  // Taken out of the queue, the message opens no second round after this one.
  assert.deepEqual(inboxOf(room.id).nextTurn, [])
})

test('a plain message steered mid-round is answered by everyone, admin first, inside the round', async (t) => {
  const { call, emit, userMessage, compose, relay, inboxOf, answer, stop, sent } = start()
  t.after(stop)
  const room = await team(call, sent)

  await emit(room.id, userMessage('Start'))
  const running = relay(room.id, 'relay')
  const first = await turnFor(sent)
  await compose(room.id, 'steer this way', 'steer')
  await answer(first.sessionId, first.message.source.exchangeId, 'one', 1)
  // The admin already spoke, so it gets one more turn for the new message.
  const second = await turnFor(sent, first)
  assert.equal(second.sessionId, first.sessionId)
  assert.match(second.message.content[0].text, /steer this way/)
  assert.match(second.message.content[0].text, /new message from the user/)
  await answer(second.sessionId, second.message.source.exchangeId, 'one again', 2)
  const third = await turnFor(sent, first, second)
  assert.match(third.message.content[0].text, /steer this way/)
  await answer(third.sessionId, third.message.source.exchangeId, 'two', 3)
  const result = JSON.parse(await running)
  assert.deepEqual(result.replies.map(reply => reply.name ?? 'User'), ['Chief', 'User', 'Chief', 'Writer'])
  assert.deepEqual(inboxOf(room.id).nextStep, [])
})

test('a message sent during the last speaker\'s turn is still answered in the round', async (t) => {
  const { call, emit, userMessage, relay, answer, stop, sent } = start()
  t.after(stop)
  const room = await team(call, sent)

  await emit(room.id, userMessage('Kick it off'))
  const running = relay(room.id, 'relay')
  const first = await turnFor(sent)
  await answer(first.sessionId, first.message.source.exchangeId, 'Chief first', 1)
  const second = await turnFor(sent, first)

  // The last member is already answering when the message lands.
  assert.equal((await call('send', { sessionId: room.id, text: 'one more thing' })).ok, true)
  await answer(second.sessionId, second.message.source.exchangeId, 'Writer done', 2)

  const third = await turnFor(sent, first, second)
  assert.ok(third, 'the admin answers the late message')
  assert.match(third.message.content[0].text, /one more thing/)
  await answer(third.sessionId, third.message.source.exchangeId, 'Back again', 3)
  const fourth = await turnFor(sent, first, second, third)
  assert.ok(fourth, 'and so does the Writer')
  await answer(fourth.sessionId, fourth.message.source.exchangeId, 'Me too', 4)
  const result = JSON.parse(await running)
  assert.deepEqual(result.replies.map(reply => reply.name ?? 'User'), ['Chief', 'Writer', 'User', 'Chief', 'Writer'])
})

test('in admin mode a plain mid-round message goes to the admin', async (t) => {
  const { call, emit, userMessage, compose, relay, answer, stop, sent } = start()
  t.after(stop)
  const room = await team(call, sent)
  await call('update-room', { id: room.id, mode: 'admin' })

  await emit(room.id, userMessage('Start'))
  const running = relay(room.id, 'relay')
  // The admin answers alone and calls the Writer.
  const first = await turnFor(sent)
  await answer(first.sessionId, first.message.source.exchangeId, '@Writer your call', 1)
  const second = await turnFor(sent, first)
  assert.notEqual(second.sessionId, first.sessionId)
  await compose(room.id, 'what do you think?')
  await answer(second.sessionId, second.message.source.exchangeId, 'Writer here', 2)
  const third = await turnFor(sent, first, second)
  assert.equal(third.sessionId, first.sessionId, 'the admin answers the user')
  assert.match(third.message.content[0].text, /what do you think\?/)
  await answer(third.sessionId, third.message.source.exchangeId, 'Admin here', 3)
  const result = JSON.parse(await running)
  assert.deepEqual(result.replies.map(reply => reply.name ?? 'User'), ['Chief', 'Writer', 'User', 'Chief'])
})

test('a message with an image or a chat reference waits for its own round, and so does what follows it', async (t) => {
  const { call, emit, userMessage, compose, relay, inboxOf, answer, stop, sent } = start()
  t.after(stop)
  const room = await team(call, sent)

  await emit(room.id, userMessage('Start'))
  const running = relay(room.id, 'relay')
  const first = await turnFor(sent)
  await compose(room.id, [{ type: 'text', text: 'see this' }, { type: 'image', data: 'AAAA', mediaType: 'image/png' }])
  await compose(room.id, 'after the image')
  await compose(room.id, 'about @[Notes](dsh-session:abc123)', 'steer')
  await answer(first.sessionId, first.message.source.exchangeId, 'one', 1)
  const second = await turnFor(sent, first)
  assert.doesNotMatch(second.message.content[0].text, /see this|after the image|about @/)
  await answer(second.sessionId, second.message.source.exchangeId, 'two', 2)
  const result = JSON.parse(await running)
  assert.deepEqual(result.replies.map(reply => reply.name ?? 'User'), ['Chief', 'Writer'])
  assert.equal(inboxOf(room.id).nextTurn.length, 2)
  assert.equal(inboxOf(room.id).nextStep.length, 1)
})

test('the greeting round leaves a waiting message for its own round', async (t) => {
  const { call, emit, compose, relay, inboxOf, answer, stop, sent } = start()
  t.after(stop)
  const room = await team(call, sent)

  await emit(room.id, { type: 'user/message', data: { source: { kind: 'bot', role: 'kickoff' }, content: [{ type: 'text', text: '[Group chat created]' }] } })
  const running = relay(room.id, 'relay')
  const first = await turnFor(sent)
  await compose(room.id, 'hello there')
  await answer(first.sessionId, first.message.source.exchangeId, 'Welcome!', 1)
  const result = JSON.parse(await running)
  assert.deepEqual(result.replies.map(reply => reply.name ?? 'User'), ['Chief'])
  assert.equal(inboxOf(room.id).nextTurn.length, 1)
})

test('a stopped round leaves a waiting message for the next round', async (t) => {
  const { call, emit, userMessage, compose, relay, inboxOf, stop, sent } = start()
  t.after(stop)
  const room = await team(call, sent)

  await emit(room.id, userMessage('Start'))
  const controller = new AbortController()
  const running = relay(room.id, 'relay', controller.signal)
  await turnFor(sent)
  await compose(room.id, 'still there?')
  controller.abort()
  const result = JSON.parse(await running)
  assert.equal(result.replies.some(reply => reply.kind === 'user'), false)
  assert.equal(inboxOf(room.id).nextTurn.length, 1)
})

test('a message sent between rounds still opens a full round', async (t) => {
  const { call, emit, userMessage, relay, answer, stop, sent } = start()
  t.after(stop)
  const room = await team(call, sent)

  await emit(room.id, userMessage('Hello group'))
  const running = relay(room.id, 'relay')
  const first = await turnFor(sent)
  assert.ok(first)
  await answer(first.sessionId, first.message.source.exchangeId, 'Hi!', 1)
  const second = await turnFor(sent, first)
  assert.ok(second)
  await answer(second.sessionId, second.message.source.exchangeId, 'Hello!', 2)
  const result = JSON.parse(await running)
  assert.deepEqual(result.replies.map(reply => reply.name ?? 'User'), ['Chief', 'Writer'])
})

// #206: state.json is written whole on every save, so a long group line keeps its start
// there and its whole text in a file of its own. Members still read it whole.
test('a long group line keeps its start in state.json, and members and read_group_chat read it whole', async (t) => {
  const { call, emit, userMessage, relay, answer, stop, sent, ctx, home, rt } = start()
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))
  const room = await team(call, sent)
  const long = `${'长'.repeat(9000)}结尾`
  await emit(room.id, userMessage('Write it all out'))
  const running = relay(room.id, 'relay')
  const first = await turnFor(sent)
  await answer(first.sessionId, first.message.source.exchangeId, long, 1)
  const second = await turnFor(sent, first)
  assert.ok(second.message.content[0].text.includes(long), 'the next member reads the line whole')
  await answer(second.sessionId, second.message.source.exchangeId, 'Thanks.', 2)
  assert.equal(JSON.parse(await running).replies[0].text, long)

  await rt.save()
  const saved = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')).rooms[room.id].log.find(line => line.length !== undefined)
  assert.equal(saved.text.length, 2000)
  assert.equal(saved.length, long.length)
  assert.equal(readFileSync(join(home, 'group-lines', room.id, `${saved.seq}.txt`), 'utf8'), long)
  const read = ctx.registeredTools.get('read_group_chat')
  const exec = { agent: { id: first.sessionId } }
  assert.match(await read.execute({ group: 'R1' }, exec), new RegExp(`cut; ${long.length} characters in all; read_group_chat with seq ${saved.seq} reads it whole`))
  assert.ok((await read.execute({ group: 'R1', seq: saved.seq }, exec)).endsWith(long))
  await stop({ keep: true })

  // The log is full (60 lines) when DSH starts again, the long line second oldest.
  const file = join(home, 'state.json')
  const onDisk = JSON.parse(readFileSync(file, 'utf8'))
  const kept = onDisk.rooms[room.id]
  const fillers = Array.from({ length: 60 - kept.log.length }, (_, at) => ({ who: 'User', text: `line ${at}`, seq: kept.seq + at + 1 }))
  kept.log = [...kept.log, ...fillers]
  kept.seq += fillers.length
  writeFileSync(file, JSON.stringify(onDisk))

  // After a restart the whole line is read back from its file.
  const again = start({ home })
  t.after(() => again.stop({ keep: true }))
  await again.call('state', {})
  const whole = await again.ctx.registeredTools.get('read_group_chat').execute({ group: 'R1', seq: saved.seq }, exec)
  assert.ok(whole.endsWith(long))

  // The file goes with the line once the log moves past it, and with the group.
  await again.emit(room.id, again.userMessage('Next'))
  const next = again.relay(room.id, 'relay-2')
  const one = await turnFor(again.sent)
  await again.answer(one.sessionId, one.message.source.exchangeId, 'One.', 3)
  const two = await turnFor(again.sent, one)
  await again.answer(two.sessionId, two.message.source.exchangeId, 'Two.', 4)
  await next
  await waitFor(() => (existsSync(join(home, 'group-lines', room.id, `${saved.seq}.txt`)) ? undefined : true))
  assert.equal(existsSync(join(home, 'group-lines', room.id, `${saved.seq}.txt`)), false)
  await again.call('delete-room', { id: room.id })
  await waitFor(() => (existsSync(join(home, 'group-lines', room.id)) ? undefined : true))
  assert.equal(existsSync(join(home, 'group-lines', room.id)), false)
})

test('a group line longer than a member reads is cut in its prompt, with its length, and its file keeps only that', async (t) => {
  const { call, emit, userMessage, relay, answer, stop, sent, home, rt } = start()
  t.after(stop)
  const room = await team(call, sent)
  await emit(room.id, userMessage('Go'))
  const running = relay(room.id, 'relay')
  const first = await turnFor(sent)
  await answer(first.sessionId, first.message.source.exchangeId, 'x'.repeat(25_000), 1)
  const second = await turnFor(sent, first)
  const prompt = second.message.content[0].text
  assert.ok(prompt.includes(`${'x'.repeat(20_000)}… (cut; 25000 characters in all)`))
  assert.ok(!prompt.includes('x'.repeat(20_001)))
  await answer(second.sessionId, second.message.source.exchangeId, 'Ok.', 2)
  await running
  const line = rt.state.rooms[room.id].log.find(entry => entry.length === 25_000)
  assert.equal(readFileSync(join(home, 'group-lines', room.id, `${line.seq}.txt`), 'utf8').length, 20_000)
})

// 公开#176: a PDF the user sent in a group reached neither the log nor any member, so
// every Bot said it could not read it; in a Bot's own chat the same file worked.
test('a file the user sends in a group reaches each member the line is shown to, once', async (t) => {
  const { call, emit, relay, answer, stop, sent, rt } = start()
  t.after(stop)
  const room = await team(call, sent)
  const pdf = { attachmentId: 'sha256:39cb3dab00', name: 'report-XYZ176.pdf', bytes: 607 }
  await emit(room.id, { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Read this PDF' }, { type: 'file', attachment: pdf }] } })
  let running = relay(room.id, 'r1')
  const first = await turnFor(sent)
  const files = message => message.content.filter(block => block.type === 'file').map(block => block.attachment)
  assert.deepEqual(files(first.message), [pdf])
  assert.match(first.message.content[0].text, /User: Read this PDF\n\[File "report-XYZ176\.pdf" \(607 bytes\) attached\]/)
  await answer(first.sessionId, first.message.source.exchangeId, 'Reading it.', 1)
  const second = await turnFor(sent, first)
  assert.deepEqual(files(second.message), [pdf])
  await answer(second.sessionId, second.message.source.exchangeId, 'Me too.', 2)
  await running
  assert.deepEqual(rt.roomOf(room.id).log.find(line => line.who === 'User').files, [pdf])

  sent.length = 0
  await emit(room.id, { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Thanks' }] } })
  running = relay(room.id, 'r2')
  const next = await turnFor(sent)
  assert.deepEqual(files(next.message), [])
  await answer(next.sessionId, next.message.source.exchangeId, 'OK.', 3)
  const after = await turnFor(sent, next)
  await answer(after.sessionId, after.message.source.exchangeId, 'OK.', 4)
  await running
})

// #206: a Bot's post past 20,000 characters goes as a file; the line keeps the file and
// each member it is shown to gets it with its prompt.
test('a long post goes to the group as a file, and reaches the member with its prompt', async (t) => {
  const { call, emit, relay, answer, stop, sent, ctx, rt } = start()
  t.after(stop)
  const store = fakeAttachments()
  ctx.get = name => (name === 'attachments' ? store : undefined)
  const room = await team(call, sent)
  const chief = rt.state.mainBotIds[0]
  const long = `${Array.from({ length: 400 }, (_, at) => `第 ${at + 1} 行：${'报告内容。'.repeat(10)}`).join('\n')}\n结尾`
  const posted = await ctx.registeredTools.get('post_to_group').execute({ group: 'R1', message: long }, { agent: { id: rt.chatOf(chief) } })
  assert.match(posted, /^Posted in "R1"/)
  const post = sent.find(entry => entry.sessionId === room.id && entry.message.source.role === 'post')
  const file = post.message.content.find(block => block.type === 'file')?.attachment
  assert.equal(file?.name, 'Post from Chief.txt')
  assert.equal(post.message.source.length, long.length)
  assert.equal(new TextDecoder().decode(store.files.get(file.attachmentId)), long)

  sent.length = 0
  await emit(room.id, { type: 'user/message', data: { source: post.message.source, content: post.message.content } })
  const running = relay(room.id, 'relay')
  const turn = await turnFor(sent)
  assert.deepEqual(turn.message.content.filter(block => block.type === 'file').map(block => block.attachment), [file])
  const prompt = turn.message.content[0].text
  assert.ok(prompt.includes(`Chief: [A long message: ${long.length} characters.`))
  assert.ok(prompt.includes(`[File "Post from Chief.txt" (${file.bytes} bytes) attached]`))
  assert.ok(prompt.length < 6000, `the prompt has ${prompt.length} characters`)
  await answer(turn.sessionId, turn.message.source.exchangeId, 'Read it.', 1)
  await running
  const line = rt.state.rooms[room.id].log.find(entry => entry.botId === chief)
  assert.deepEqual(line.files, [file])
  assert.equal(line.length, undefined, 'the line is short; no file of its own')
})
