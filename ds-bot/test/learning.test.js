import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { LEARNING, parseJson, skillProblem } from '../src/host/learning.js'
import { fakeContext } from './fake-ctx.js'

const TEAM = {
  version: 1,
  mainBotIds: ['m1'],
  revision: 1,
  whaleStored: true,
  bots: {
    m1: { id: 'm1', sessionId: 'm1', name: 'Chief', role: 'Chief of Staff', model: 'deepseek/v4', instructions: '', capabilities: [], createdAt: 1 },
    b2: { id: 'b2', sessionId: 'b2', name: 'Writer', role: 'Writing', model: 'deepseek/v4', instructions: '', capabilities: [], createdAt: 2 },
  },
  rooms: {},
  capabilities: { items: {} },
  exchanges: [],
  exchangeTurns: {},
  questions: {},
}

const ownChat = [
  { event: { seq: 10, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Please review this work' }] } } },
  { event: { seq: 11, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'I finished the work.' }] } } } },
]

const createReply = JSON.stringify({
  action: 'create',
  name: 'release-checks',
  description: 'Use when checking a release.',
  content: 'Run the release checks.',
  why: 'The repeated work showed that the checks need to be kept.',
})
const noneReply = JSON.stringify({ action: 'none', reason: 'This work taught nothing reusable.' })

function start({ replies = [], config = {}, history = {}, seed = TEAM, learningSeed = {} } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-learning-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(JSON.parse(JSON.stringify(seed))))
  if (Object.keys(learningSeed).length > 0) {
    mkdirSync(join(home, 'learning'), { recursive: true })
    writeFileSync(join(home, 'learning', 'state.json'), JSON.stringify(learningSeed))
  }
  const ctx = fakeContext()
  const requests = []
  Object.assign(ctx, {
    llm: {
      listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
      listModels: async () => [{ id: 'v4' }],
      resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'off' }, { id: 'high' }] } }),
      async* stream(request) {
        requests.push(request)
        const reply = await replies.shift()
        if (reply instanceof Error) throw reply
        const out = typeof reply === 'object' && reply !== null ? reply : { text: reply ?? '' }
        yield { type: 'text-delta', index: 0, text: out.text ?? '' }
        yield { type: 'finish', reason: { kind: out.finish ?? 'stop', ...(out.failure ? { failure: { message: out.failure } } : {}) } }
      },
    },
    sessionController: {
      resolveAgent: async sessionId => ({
        agent: {
          id: sessionId,
          session: {
            id: sessionId,
            seq: (history[sessionId] ?? ownChat).at(-1).event.seq + 1,
            requestHeader: () => ({ config: { provider: 'deepseek', model: 'v4' } }),
          },
        },
      }),
      selectModel: async () => {},
      page: async ({ address, beforeSeq, maxMessages }) => {
        const all = (history[address.sessionId] ?? ownChat).filter(record => beforeSeq === undefined || record.event.seq < beforeSeq)
        const records = maxMessages === undefined ? all : all.slice(-maxMessages)
        return { records, hasMore: records.length < all.length }
      },
    },
    sessions: { messageProjections: [] },
    workspaceRegistry: { archiveSession: async () => {} },
  })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = options => {
    route = options
    return register(options)
  }
  const settings = {
    memoryReviewDelayMs: 60_000,
    ...config,
    learningTimes: { minTurnMs: 0, idleMs: 0, intervalMs: 0, tickMs: 10, ...config.learningTimes },
  }
  const rt = createRuntime(ctx, { home, ...settings })
  const call = async (endpoint, payload = {}) => {
    const response = await route.fetch(new Request('http://localhost/api/bot', {
      method: 'POST',
      body: JSON.stringify({ endpoint, payload }),
    }))
    return response.json()
  }
  const learningPath = join(home, 'learning', 'state.json')
  const learningState = () => existsSync(learningPath) ? JSON.parse(readFileSync(learningPath, 'utf8')) : {}
  const teamState = () => JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
  const stop = async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  return { ctx, home, call, requests, history, learningPath, learningState, teamState, rt, stop }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 20))

async function until(check, message = 'condition did not hold within 4 s') {
  for (let tries = 0; tries < 200; tries += 1) {
    if (await check()) return
    await settle()
  }
  assert.fail(message)
}

async function startRuntime(options) {
  const runtime = start(options)
  await runtime.call('state')
  return runtime
}

async function finishTurn(ctx, { id = 'b2', duration = 0 } = {}) {
  const { agent } = await ctx.sessionController.resolveAgent(id)
  ctx.emit('agent/status', { agent, status: 'running' })
  if (duration > 0) await new Promise(resolve => setTimeout(resolve, duration))
  ctx.emit('agent/status', { agent, status: 'idle' })
}

function addNextTurn(history) {
  history.b2.push(
    { event: { seq: 12, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Please check the release process too.' }] } } },
    { event: { seq: 13, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'The release process is checked.' }] } } } },
  )
}

test('parseJson accepts fenced and unfenced objects and ignores garbage', () => {
  assert.deepEqual(parseJson('```json\n{"action":"none"}\n```'), { action: 'none' })
  assert.deepEqual(parseJson('Answer: {"action":"none"}'), { action: 'none' })
  const answer = JSON.stringify({ action: 'create', content: 'Use this:\n```js\nvalue\n```' })
  const expected = JSON.parse(answer)
  assert.deepEqual(parseJson(answer), expected)
  assert.deepEqual(parseJson('```json\n' + answer + '\n```'), expected)
  assert.equal(parseJson('No JSON was returned.'), undefined)
  assert.equal(parseJson('```json\n{"action":\n```'), undefined)
})

test('skillProblem validates actions, learned-skill limits, and secret-looking content', () => {
  const proposal = {
    action: 'create',
    name: 'release-checks',
    description: 'Use when checking a release.',
    content: 'Run the release checks.',
  }
  assert.equal(skillProblem({ action: 'none' }, { skills: {}, learned: [] }), undefined)
  assert.match(skillProblem({ ...proposal, name: 'Bad_Name' }, { skills: {}, learned: [] }), /capability name/)
  assert.match(skillProblem(proposal, { skills: { 'release-checks': { kind: 'skill' } }, learned: [] }), /already exists/)
  assert.match(skillProblem(proposal, { skills: {}, learned: ['one', 'two'], limit: 2 }), /learned skills/)
  assert.match(skillProblem({ ...proposal, action: 'update' }, { skills: { 'release-checks': { kind: 'skill', content: 'Old', description: 'Old' } }, learned: [] }), /not a learned skill/)
  assert.match(skillProblem({ ...proposal, action: 'update' }, {
    skills: { 'release-checks': { kind: 'skill', content: proposal.content, description: proposal.description } },
    learned: ['release-checks'],
  }), /changes nothing/)
  assert.match(skillProblem({ ...proposal, content: 'The root password is hunter2' }, { skills: {}, learned: [] }), /secret/)
  assert.match(skillProblem({ ...proposal, why: 'The root password is hunter2' }, { skills: {}, learned: [] }), /secret/)
  assert.equal(skillProblem({ ...proposal, content: 'Compare `password == input` with a timing-safe check' }, { skills: {}, learned: [] }), undefined)
  assert.match(skillProblem({ ...proposal, description: 'x'.repeat(LEARNING.descriptionMax + 1) }, { skills: {}, learned: [] }), /description/)
})

test('short turns do not mark a Bot chat; a longer turn marks it for review', async t => {
  const short = await startRuntime({ config: { learningTimes: { minTurnMs: 60_000, idleMs: 60_000 } } })
  t.after(() => short.stop())
  await finishTurn(short.ctx)
  await settle()
  assert.equal(existsSync(short.learningPath), false)

  const long = await startRuntime({ config: { learningTimes: { minTurnMs: 5, idleMs: 60_000 } } })
  t.after(() => long.stop())
  await finishTurn(long.ctx, { duration: 15 })
  await until(() => long.learningState().pending?.b2?.includes('b2'))
  assert.deepEqual(long.learningState().pending.b2, ['b2'])
})

test('a none reply makes no proposal and advances the chat cursor', async t => {
  const runtime = await startRuntime({ replies: [noneReply] })
  t.after(() => runtime.stop())
  await finishTurn(runtime.ctx)
  await until(() => runtime.learningState().cursors?.b2 === 11 && runtime.learningState().pending?.b2 === undefined)
  assert.equal(runtime.requests.length, 1)
  assert.deepEqual((await runtime.call('state')).value.learning ?? {}, {})
})

test('long turns ending during review remain pending for the next pass', async t => {
  const history = { b2: [...ownChat], b3: [...ownChat] }
  const runtime = await startRuntime({
    history,
    replies: [noneReply, noneReply],
    config: { learningTimes: { tickMs: 100_000 } },
  })
  t.after(() => runtime.stop())
  const load = runtime.rt.load
  runtime.rt.load = async (...args) => {
    const result = await load(...args)
    runtime.rt.chatOwners.set('b3', 'b2')
    return result
  }
  runtime.rt.chatOwners.set('b3', 'b2')
  const b3Statuses = []
  runtime.ctx.on('agent/status', ({ agent, status }) => {
    if (agent?.id === 'b3') b3Statuses.push(status)
  })
  assert.equal(runtime.rt.chatOwners.get('b3'), 'b2')
  assert.equal(runtime.rt.isBotSession('b3'), true)
  await finishTurn(runtime.ctx)
  await until(() => runtime.learningState().pending?.b2?.includes('b2'))

  const botShot = runtime.rt.botShot
  let endedDuringReview = false
  runtime.rt.botShot = async (...args) => {
    if (!endedDuringReview) {
      endedDuringReview = true
      addNextTurn(history)
      history.b3.push(
        { event: { seq: 12, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Please keep this new work too.' }] } } },
        { event: { seq: 13, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'The second chat has new work.' }] } } } },
      )
      await finishTurn(runtime.ctx, { id: 'b2' })
      await finishTurn(runtime.ctx, { id: 'b3' })
      assert.deepEqual(b3Statuses, ['running', 'idle'])
    }
    return botShot(...args)
  }

  await runtime.rt.learningRun()

  assert.deepEqual(runtime.learningState().pending.b2, ['b2', 'b3'])
  assert.equal(runtime.learningState().cursors.b2, 11)

  await runtime.rt.learningRun()

  assert.equal(runtime.requests.length, 2)
  const request = runtime.requests[1].messages[0].content[0].text
  assert.match(request, /Please check the release process too\./)
  assert.match(request, /Please keep this new work too\./)
  assert.equal(runtime.learningState().pending.b2, undefined)
})

test('approval ownership survives a normal skill edit and remains learned on review', async t => {
  const history = { b2: [...ownChat] }
  const updateReply = JSON.stringify({
    action: 'update',
    name: 'release-checks',
    description: 'Use when checking any release.',
    content: 'Run the release checks.',
    why: 'The work showed the scope should be broader.',
  })
  const runtime = await startRuntime({
    history,
    replies: [createReply, updateReply],
    config: { learningTimes: { tickMs: 100_000 } },
  })
  t.after(() => runtime.stop())
  await finishTurn(runtime.ctx)
  await runtime.rt.learningRun()
  await until(() => Object.keys(runtime.learningState().proposals ?? {}).length === 1)
  const proposal = (await runtime.call('state')).value.learning.b2[0]
  assert.equal(proposal.name, 'release-checks')

  addNextTurn(history)
  await finishTurn(runtime.ctx)
  await until(() => runtime.learningState().pending?.b2?.includes('b2'))
  await settle()
  assert.equal(runtime.requests.length, 1)
  const answer = await runtime.call('learning-answer', { id: proposal.id, approve: true })
  assert.equal(answer.value.applied, true)
  await runtime.call('capability-save', {
    name: 'release-checks',
    kind: 'skill',
    description: 'Use when checking a release candidate.',
    content: 'Run the release checks.',
  })
  await runtime.rt.learningRun()
  await until(() => runtime.requests.length === 2)
  await until(() => Object.values(runtime.learningState().proposals ?? {}).some(entry => entry.action === 'update'))
  const saved = runtime.teamState()
  assert.equal(saved.capabilities.items['release-checks'].learned, undefined)
  assert.ok(saved.bots.b2.capabilities.includes('release-checks'))
  assert.deepEqual(runtime.learningState().learned.b2, ['release-checks'])
  assert.match(runtime.requests[1].messages[0].content[0].text, /This Bot's learned skills[\s\S]*Use when checking a release candidate\./)
})

test('a failed create attachment can be retried without resaving or losing the proposal', async t => {
  const runtime = await startRuntime({ replies: [createReply] })
  t.after(() => runtime.stop())
  await finishTurn(runtime.ctx)
  await until(() => Object.keys(runtime.learningState().proposals ?? {}).length === 1)
  const proposal = Object.values(runtime.learningState().proposals)[0]
  const attach = runtime.rt.capabilityEndpoint
  let fail = true
  runtime.rt.capabilityEndpoint = async (...args) => {
    if (fail) {
      fail = false
      throw new Error('temporary attachment failure')
    }
    return attach(...args)
  }

  const first = await runtime.call('learning-answer', { id: proposal.id, approve: true })
  assert.equal(first.ok, false)
  assert.equal(runtime.learningState().proposals[proposal.id].saved, true)
  assert.ok(runtime.learningState().learned.b2.includes('release-checks'))
  assert.ok(runtime.learningState().proposals[proposal.id])

  const second = await runtime.call('learning-answer', { id: proposal.id, approve: true })
  assert.equal(second.value.applied, true)
  assert.equal(runtime.learningState().proposals[proposal.id], undefined)
  assert.ok(runtime.teamState().bots.b2.capabilities.includes('release-checks'))
})

test('a recreated approved skill is learned when its saved proposal is retried', async t => {
  const runtime = await startRuntime({ replies: [createReply] })
  t.after(() => runtime.stop())
  await finishTurn(runtime.ctx)
  await until(() => Object.keys(runtime.learningState().proposals ?? {}).length === 1)
  const proposal = Object.values(runtime.learningState().proposals)[0]
  const endpoint = runtime.rt.capabilityEndpoint
  let fail = true
  runtime.rt.capabilityEndpoint = async (name, body, ...args) => {
    if (name === 'bot-capability' && fail) {
      fail = false
      throw new Error('temporary attachment failure')
    }
    return endpoint(name, body, ...args)
  }

  const first = await runtime.call('learning-answer', { id: proposal.id, approve: true })
  assert.equal(first.ok, false)
  assert.equal(runtime.learningState().proposals[proposal.id].saved, true)
  assert.deepEqual(runtime.learningState().learned.b2, ['release-checks'])

  const deleted = await runtime.call('capability-delete', { name: 'release-checks' })
  assert.equal(deleted.ok, true)
  assert.deepEqual(runtime.learningState().learned.b2, [])
  await runtime.call('capability-save', {
    name: 'release-checks',
    kind: 'skill',
    description: 'Use when checking a release.',
    content: 'Run the release checks.',
  })

  const retry = await runtime.call('learning-answer', { id: proposal.id, approve: true })
  assert.equal(retry.value.applied, true)
  assert.equal(runtime.learningState().proposals[proposal.id], undefined)
  assert.deepEqual(runtime.learningState().learned.b2, ['release-checks'])
  assert.ok(runtime.teamState().bots.b2.capabilities.includes('release-checks'))
})

test('a failed create retry refuses a skill edited after it was saved', async t => {
  const runtime = await startRuntime({ replies: [createReply] })
  t.after(() => runtime.stop())
  await finishTurn(runtime.ctx)
  await until(() => Object.keys(runtime.learningState().proposals ?? {}).length === 1)
  const proposal = Object.values(runtime.learningState().proposals)[0]
  const endpoint = runtime.rt.capabilityEndpoint
  let fail = true
  runtime.rt.capabilityEndpoint = async (name, body, ...args) => {
    if (name === 'bot-capability' && fail) {
      fail = false
      throw new Error('temporary attachment failure')
    }
    return endpoint(name, body, ...args)
  }

  const first = await runtime.call('learning-answer', { id: proposal.id, approve: true })
  assert.equal(first.ok, false)
  assert.equal(runtime.learningState().proposals[proposal.id].saved, true)
  const edit = await runtime.call('capability-save', {
    name: 'release-checks',
    kind: 'skill',
    description: 'Use when checking a release.',
    content: 'Run the revised release checks.',
  })
  assert.equal(edit.ok, true)

  const retry = await runtime.call('learning-answer', { id: proposal.id, approve: true })
  assert.equal(retry.ok, false)
  assert.match(JSON.stringify(retry), /release-checks changed since this was proposed/)
  assert.ok(runtime.learningState().proposals[proposal.id])
  assert.equal(runtime.teamState().capabilities.items['release-checks'].content, 'Run the revised release checks.')
  assert.equal(runtime.teamState().bots.b2.capabilities.includes('release-checks'), false)
})

test('deleting a learned skill clears ownership before a same-name skill is recreated', async t => {
  const history = { b2: [...ownChat] }
  const runtime = await startRuntime({
    history,
    replies: [createReply, noneReply],
    config: { learningTimes: { tickMs: 100_000 } },
  })
  t.after(() => runtime.stop())
  await finishTurn(runtime.ctx)
  await runtime.rt.learningRun()
  await until(() => Object.keys(runtime.learningState().proposals ?? {}).length === 1)
  const proposal = Object.values(runtime.learningState().proposals)[0]
  const answer = await runtime.call('learning-answer', { id: proposal.id, approve: true })
  assert.equal(answer.value.applied, true)
  assert.deepEqual(runtime.learningState().learned.b2, ['release-checks'])

  const deleted = await runtime.call('capability-delete', { name: 'release-checks' })
  assert.equal(deleted.ok, true)
  assert.deepEqual(runtime.learningState().learned.b2, [])
  await runtime.call('capability-save', {
    name: 'release-checks',
    kind: 'skill',
    description: 'Use when checking a release.',
    content: 'Run the release checks.',
  })
  await runtime.call('bot-capability', { botId: 'b2', name: 'release-checks', attached: true })
  assert.ok(runtime.teamState().bots.b2.capabilities.includes('release-checks'))

  addNextTurn(history)
  await finishTurn(runtime.ctx)
  await runtime.rt.learningRun()
  assert.equal(runtime.requests.length, 2)
  const request = runtime.requests[1].messages[0].content[0].text
  assert.match(request, /This Bot has no learned skills yet\./)
  assert.match(request, /Other skills on the team:\n- release-checks:/)
  assert.deepEqual(runtime.learningState().learned.b2, [])
})

test('declined proposals are recorded and included in the next skill request', async t => {
  const history = { b2: [...ownChat] }
  const runtime = await startRuntime({ history, replies: [createReply, noneReply] })
  t.after(() => runtime.stop())
  await finishTurn(runtime.ctx)
  await until(() => Object.keys(runtime.learningState().proposals ?? {}).length === 1)
  const proposal = (await runtime.call('state')).value.learning.b2[0]

  addNextTurn(history)
  await finishTurn(runtime.ctx)
  await until(() => runtime.learningState().pending?.b2?.includes('b2'))
  await settle()
  assert.equal(runtime.requests.length, 1)

  const answer = await runtime.call('learning-answer', { id: proposal.id, approve: false })
  assert.equal(answer.value.applied, false)
  await until(() => runtime.learningState().cursors?.b2 === 13 && runtime.learningState().pending?.b2 === undefined)
  assert.equal(runtime.teamState().capabilities.items['release-checks'], undefined)
  assert.equal(runtime.learningState().declined[0].name, 'release-checks')
  assert.match(runtime.requests[1].messages[0].content[0].text, /Proposals the user declined[\s\S]*- release-checks: Use when checking a release\./)
})

test('an update approval fails if the learned skill description alone changed', async t => {
  const seed = JSON.parse(JSON.stringify(TEAM))
  seed.bots.b2.capabilities = ['release-checks']
  seed.capabilities.items['release-checks'] = {
    name: 'release-checks',
    kind: 'skill',
    description: 'Use when checking a release.',
    content: 'Run the original release checks.',
    createdBy: 'b2',
    createdAt: 3,
    updatedAt: 3,
    learned: true,
  }
  const updateReply = JSON.stringify({
    action: 'update',
    name: 'release-checks',
    description: 'Use when checking a release.',
    content: 'Run the new release checks.',
    why: 'The work showed an additional step.',
  })
  const runtime = await startRuntime({ seed, replies: [updateReply], learningSeed: { learned: { b2: ['release-checks'] } } })
  t.after(() => runtime.stop())
  await finishTurn(runtime.ctx)
  await until(() => Object.keys(runtime.learningState().proposals ?? {}).length === 1)
  const proposal = (await runtime.call('state')).value.learning.b2[0]

  await runtime.call('capability-save', {
    name: 'release-checks',
    kind: 'skill',
    description: 'Use when checking a release candidate.',
    content: 'Run the original release checks.',
  })
  const answer = await runtime.call('learning-answer', { id: proposal.id, approve: true })
  assert.equal(answer.ok, false)
  assert.match(JSON.stringify(answer), /release-checks changed since this was proposed/)
  assert.equal(runtime.teamState().capabilities.items['release-checks'].description, 'Use when checking a release candidate.')
  assert.equal(Object.keys(runtime.learningState().proposals).length, 1)
  const declined = await runtime.call('learning-answer', { id: proposal.id, approve: false })
  assert.equal(declined.ok, true)
  assert.equal(Object.keys(runtime.learningState().proposals).length, 0)
})

test('a saved secret in a proposed skill is not shown as a proposal', async t => {
  const secretValue = 'saved-secret-value-37'
  const runtime = await startRuntime({
    replies: [JSON.stringify({
      action: 'create',
      name: 'release-checks',
      description: 'Use when checking a release.',
      content: `Run with ${secretValue}.`,
      why: 'The work showed it is needed.',
    })],
  })
  t.after(() => runtime.stop())
  await runtime.call('secret-set', { name: 'LEARNING_TEST', value: secretValue })
  await finishTurn(runtime.ctx)
  await until(() => runtime.learningState().cursors?.b2 === 11)
  assert.deepEqual(runtime.learningState().proposals, {})
})

test('user corrections remain in long chat reviews after the text budget', async t => {
  const runtime = await startRuntime({ replies: [noneReply], config: { learningTimes: { tickMs: 100_000 } } })
  t.after(() => runtime.stop())
  const lines = Array.from({ length: 30 }, (_, index) => ({
    seq: 41 - index,
    who: 'assistant',
    text: `Bot: ${'x'.repeat(1_200)}`,
  }))
  lines.push({ seq: 10, who: 'user', text: 'User: Keep the correction even when the Bot writes a long answer.' })
  runtime.rt.partLines = async function* () {
    yield* lines
  }
  await finishTurn(runtime.ctx)
  await runtime.rt.learningRun()
  assert.match(runtime.requests[0].messages[0].content[0].text, /User: Keep the correction even when the Bot writes a long answer\./)
})

test('a failed chat read keeps that Bot pending while other Bots are reviewed', async t => {
  const seed = JSON.parse(JSON.stringify(TEAM))
  seed.bots.b3 = { id: 'b3', sessionId: 'b3', name: 'Coder', role: 'Coding', model: 'deepseek/v4', instructions: '', capabilities: [], createdAt: 3 }
  const runtime = await startRuntime({ seed, replies: [noneReply], config: { learningTimes: { tickMs: 100_000 } } })
  t.after(() => runtime.stop())
  runtime.rt.partLines = async function* (sessionId) {
    if (sessionId === 'b2') throw new Error('session read failed')
    yield { seq: 11, who: 'user', text: 'User: Review this work' }
  }
  await finishTurn(runtime.ctx, { id: 'b2' })
  await finishTurn(runtime.ctx, { id: 'b3' })
  await until(() => runtime.learningState().pending?.b2?.length && runtime.learningState().pending?.b3?.length)

  await runtime.rt.learningRun()

  assert.deepEqual(runtime.learningState().pending.b2, ['b2'])
  assert.equal(runtime.learningState().pending.b3, undefined)
  assert.equal(runtime.learningState().cursors.b3, 11)
  assert.equal(runtime.requests.length, 1)
})
