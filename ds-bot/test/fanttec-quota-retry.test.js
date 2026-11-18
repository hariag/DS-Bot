import assert from 'node:assert/strict'
import { test } from 'node:test'
import { install } from '../src/host/fanttec-quota-retry.js'

const failure = { code: 'AUTH', message: 'fanttec API error (403): {"code":"insufficient_user_quota","message":"private gateway diagnostic"}' }
const chunk = chunk => ({ type: 'chunk', time: 1, chunk })
const usage = chunk({ type: 'usage', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } })
const finish = chunk({ type: 'finish', reason: { kind: 'error', failure } })
const step = { turn: 2, step: 3 }

function scenario({ log = [], delay, readOnly } = {}) {
  let handler, dispose, delegated = 0
  const waits = []
  const control = new AbortController()
  const session = {
    get seq() { return log.length },
    append(type, data) {
      const event = { seq: log.length, type, data }
      log.push(event)
      return event
    },
  }
  const agent = { id: 'fixture-bot', session }
  const controller = {
    async page({ address, throughSeq, beforeSeq }, signal) {
      assert.equal(address.sessionId, agent.id)
      signal.throwIfAborted()
      // Multiple pages exercise the read bound to the same immutable tail.
      const end = Math.min(beforeSeq, throughSeq + 1)
      const start = Math.max(0, end - 3)
      return { records: log.slice(start, end).map(event => ({ event })), hasMore: start > 0 }
    },
  }
  const ctx = {
    sessionController: controller,
    effect(fn) { dispose = fn() },
    on(event, listener, options) {
      assert.equal(event, 'agent/request-error')
      assert.equal(options.prepend, true)
      handler = listener
    },
  }
  install({ ctx, isBotSession: id => id === agent.id, readOnly }, {
    delay: async (ms, value, options) => {
      waits.push(ms)
      if (delay) await delay(ms, value, options)
    },
  })
  const attempt = (stream = [usage, finish], fields = {}) => session.append('assistant/attempt', { ...step, ...fields, stream })
  const recover = (extra = {}) => handler({ ...step, agent, provider: 'fanttec', failure, signal: control.signal, ...extra }, () => { delegated++; return 'next' })
  const begin = () => session.append('step/start', step)
  return { log, waits, session, attempt, recover, begin, control, dispose, controller, get delegated() { return delegated } }
}

test('ten scheduled retries double their delay, retain one budget after reload and stop after the tenth', async () => {
  const log = []
  let host = scenario({ log })
  host.begin()
  for (let retry = 1; retry <= 10; retry++) {
    if (retry === 6) {
      host.dispose()
      host = scenario({ log })
    }
    host.attempt()
    assert.deepEqual(await host.recover(), { kind: 'retry' })
  }
  host.attempt()
  assert.equal(await host.recover(), undefined)
  const scheduled = log.filter(e => e.type === 'llm/retry').map(e => e.data)
  assert.deepEqual(scheduled.map(e => e.delayMs), [1000, 2000, 4000, 8000, 16000, 32000, 64000, 128000, 256000, 512000])
  assert.deepEqual(scheduled.map(e => e.retry), Array.from({ length: 10 }, (_, i) => i + 1))
  assert.equal(new Set(scheduled.map(e => e.retryId)).size, 1)
  assert.equal(log.filter(e => e.type === 'llm/retry-started').length, 10)
  assert.ok(scheduled.every(e => e.maxRetries === 10 && e.provider === 'fanttec'))
  assert.ok(scheduled.every(e => e.failure.code === 'QUOTA' && e.failure.message === ''))
  assert.ok(!JSON.stringify(scheduled).includes('private gateway'))
  assert.equal(host.delegated, 0)
})

test('success ends the request series and a later step receives its own budget', async () => {
  const h = scenario()
  h.begin()
  h.attempt()
  assert.deepEqual(await h.recover(), { kind: 'retry' })
  h.session.append('assistant/message', step)
  h.session.append('step/end', step)
  assert.equal(await h.recover(), undefined)
  assert.deepEqual(h.waits, [1000])
  const next = { ...step, step: step.step + 1 }
  h.session.append('step/start', next)
  h.attempt([usage, finish], next)
  assert.deepEqual(await h.recover(next), { kind: 'retry' })
  assert.deepEqual(h.waits, [1000, 1000])
})

test('ordinary auth failures, non-Bot sessions, other providers and other model errors are delegated', async () => {
  const h = scenario()
  h.begin()
  h.attempt()
  for (const override of [
    { failure: { code: 'AUTH', message: 'fanttec API error (401): {"code":"invalid_api_key"}' } },
    { failure: { code: 'AUTH', message: 'fanttec API error (403): {"code":"forbidden"}' } },
    { failure: { code: 'TIMEOUT', message: 'timeout' } },
    { agent: { id: 'different', session: h.session } }, { provider: 'other' },
  ]) assert.equal(await h.recover(override), 'next')
  assert.equal(h.delegated, 5)
  assert.equal(h.waits.length, 0)
})

test('partial text, reasoning, tools, use, or an unknown or different attempt never retry', async () => {
  for (const stream of [
    [{ type: 'text-chunks', texts: ['visible'] }, finish],
    [{ type: 'reasoning-chunks', texts: ['visible'] }, finish],
    [{ type: 'tool-call-chunks', args: ['{}'] }, finish],
    [chunk({ type: 'block-start', blockType: 'text' }), finish],
    [chunk({ type: 'usage', usage: { inputTokens: 0, outputTokens: 1 } }), finish],
    [chunk({ type: 'new-event' }), finish],
    [usage], [],
    [chunk({ type: 'finish', reason: { kind: 'error', failure: { ...failure, message: failure.message + ' from another request' } } })],
  ]) {
    const h = scenario()
    h.begin()
    h.attempt(stream)
    assert.equal(await h.recover(), undefined)
    assert.equal(h.delegated, 0)
    assert.equal(h.waits.length, 0)
  }
  const h = scenario()
  h.begin()
  h.attempt([chunk({ type: 'block-end' }), finish])
  h.attempt()
  assert.equal(await h.recover(), undefined)
  h.session.append('tool/result', step)
  assert.equal(await h.recover(), undefined)
  h.attempt([usage, finish], { ...step, turn: 99 })
  assert.equal(await h.recover(), undefined)
  assert.equal(h.delegated, 0)
  assert.equal(h.waits.length, 0)
})

test('duplicate hooks, unreadable journal, and a stale or incomplete journal cannot schedule extra attempts', async () => {
  const h = scenario()
  h.begin()
  h.attempt()
  const concurrent = await Promise.all([h.recover(), h.recover()])
  assert.equal(concurrent.filter(x => x?.kind === 'retry').length, 1)
  assert.deepEqual(h.waits, [1000])
  assert.equal(await h.recover(), undefined)
  h.attempt()
  h.controller.page = async () => { throw new Error('unavailable') }
  assert.equal(await h.recover(), undefined)
  h.controller.page = async () => ({ records: [{ event: h.log[0] }], hasMore: false })
  assert.equal(await h.recover(), undefined)
  const missing = scenario()
  missing.attempt()
  assert.equal(await missing.recover(), undefined)
  assert.equal(h.delegated, 0)
  assert.equal(missing.delegated, 0)
})

test('cancellation and disposal interrupt the wait and suppress the next model request', async () => {
  for (const stop of ['cancel', 'dispose']) {
    const entered = Promise.withResolvers()
    const h = scenario({ delay: async (ms, _, { signal }) => {
      entered.resolve()
      await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
    } })
    h.begin()
    h.attempt()
    const pending = h.recover()
    await entered.promise
    if (stop === 'cancel') h.control.abort()
    else h.dispose()
    assert.equal(await pending, undefined)
    assert.equal(await h.recover(), undefined)
    assert.equal(h.log.filter(e => e.type === 'llm/retry').length, 1)
    assert.equal(h.log.filter(e => e.type === 'llm/retry-started').length, 0)
    assert.equal(h.delegated, 0)
  }
})

test('current history API takes precedence, long or missing journals stop within a bounded read', async () => {
  const h = scenario()
  h.begin()
  h.attempt()
  h.controller.events = h.controller.page
  h.controller.page = () => { throw new Error('legacy fallback should not run') }
  assert.deepEqual(await h.recover(), { kind: 'retry' })

  const missing = scenario()
  for (let i = 0; i < 200; i++) missing.session.append('system/message', {})
  missing.attempt()
  let pages = 0
  const read = missing.controller.page
  missing.controller.events = (...args) => { pages++; return read(...args) }
  assert.equal(await missing.recover(), undefined)
  assert.equal(pages, 32)
  assert.equal(missing.waits.length, 0)
})

test('an already stopped Bot or loss of the write lock cannot launch another request', async () => {
  let readOnly
  const h = scenario({ readOnly: () => readOnly, delay: async () => { readOnly = 'locked' } })
  h.begin()
  h.attempt()
  assert.equal(await h.recover(), undefined)
  assert.equal(h.log.filter(e => e.type === 'llm/retry-started').length, 0)
  h.attempt()
  assert.equal(await h.recover(), undefined)
  assert.equal(h.waits.length, 1)
  const stopped = scenario()
  stopped.begin()
  stopped.attempt()
  stopped.control.abort()
  assert.equal(await stopped.recover(), undefined)
  assert.equal(stopped.waits.length, 0)
})
