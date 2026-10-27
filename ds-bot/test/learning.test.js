import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../index.js'
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

function start({ replies = [], config = {}, history = {}, seed = TEAM } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-learning-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(JSON.parse(JSON.stringify(seed))))
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
  apply(ctx, { home, ...settings })
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
  return { ctx, home, call, requests, history, learningPath, learningState, teamState, stop }
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

test('a waiting proposal is skipped and approval saves and attaches a learned skill', async t => {
  const history = { b2: [...ownChat] }
  const runtime = await startRuntime({ history, replies: [createReply, noneReply] })
  t.after(() => runtime.stop())
  await finishTurn(runtime.ctx)
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
  await until(() => runtime.learningState().cursors?.b2 === 13 && runtime.learningState().pending?.b2 === undefined)
  const saved = runtime.teamState()
  assert.equal(saved.capabilities.items['release-checks'].learned, true)
  assert.ok(saved.bots.b2.capabilities.includes('release-checks'))
  assert.equal(runtime.requests.length, 2)
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

test('an update approval fails if the learned skill changed after the proposal', async t => {
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
  const runtime = await startRuntime({ seed, replies: [updateReply] })
  t.after(() => runtime.stop())
  await finishTurn(runtime.ctx)
  await until(() => Object.keys(runtime.learningState().proposals ?? {}).length === 1)
  const proposal = (await runtime.call('state')).value.learning.b2[0]

  await runtime.call('capability-save', {
    name: 'release-checks',
    kind: 'skill',
    description: 'Use when checking a release.',
    content: 'Changed independently after the proposal.',
  })
  const answer = await runtime.call('learning-answer', { id: proposal.id, approve: true })
  assert.equal(answer.ok, false)
  assert.match(JSON.stringify(answer), /release-checks changed since this was proposed/)
  assert.equal(runtime.teamState().capabilities.items['release-checks'].content, 'Changed independently after the proposal.')
  assert.equal(Object.keys(runtime.learningState().proposals).length, 1)
  const declined = await runtime.call('learning-answer', { id: proposal.id, approve: false })
  assert.equal(declined.ok, true)
  assert.equal(Object.keys(runtime.learningState().proposals).length, 0)
})
