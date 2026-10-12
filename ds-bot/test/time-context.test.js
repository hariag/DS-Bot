import assert from 'node:assert/strict'
import { test } from 'node:test'
import { install } from '../src/host/time-context.js'
import { historyEntry } from '../src/host/parts.js'
import { fakeContext } from './fake-ctx.js'

const NOW = Date.UTC(2026, 9, 12, 4, 30)
const reading = (time, kind = 'ds-bot-time-context') => ({ type: 'user/message', time, data: { source: { kind } } })

function setup(t, { events = [], config = {}, owned = true } = {}) {
  t.mock.method(Date, 'now', () => NOW)
  const ctx = fakeContext()
  let reads = 0
  const rt = {
    ctx, config: { timeZone: 'Asia/Shanghai', ...config },
    load: async () => {},
    isBotSession: () => owned,
    async* eventsBackwards() {
      reads += 1
      yield* [...events].reverse()
    },
  }
  install(rt)
  const hook = ctx.listeners.get('agent/pre-step')[0]
  const message = { role: 'user', content: [{ type: 'text', text: 'Hello' }], source: { kind: 'user' } }
  const step = (decision = { kind: 'enter', messages: [message] }, payload = {}) => hook({
    agent: { id: 'bot', session: { id: 'bot' } }, turn: 1, step: 1,
    signal: new AbortController().signal, ...payload,
  }, async () => decision)
  return { step, message, reads: () => reads }
}

test('a first Bot step appends a dated, zoned snapshot without changing the user message', async (t) => {
  const { step, message } = setup(t)
  const result = await step()
  assert.equal(result.messages[0], message)
  const clock = result.messages[1]
  assert.match(clock.content[0].text, /2026-10-12.*12:30:00.*GMT\+08:00.*Asia\/Shanghai/)
  assert.deepEqual(clock.source, {
    kind: 'ds-bot-time-context', form: 'snapshot',
    sections: [{ name: 'ds-bot-time-context', text: clock.content[0].text }],
  })
  assert.equal(historyEntry({ type: 'user/message', data: clock }, false), undefined)
})

test('a resumed session suppresses readings before ten minutes and refreshes at the boundary', async (t) => {
  const { step } = setup(t, { events: [reading(NOW - 599_999)] })
  const decision = { kind: 'enter', messages: [] }
  assert.equal(await step(decision), decision)
  Date.now.mock.mockImplementation(() => NOW + 1)
  assert.equal((await step(decision)).messages.length, 1)
})

test('a long running turn refreshes on a later step', async (t) => {
  const { step } = setup(t, { events: [reading(NOW - 600_000)] })
  assert.equal((await step(undefined, { step: 3 })).messages.length, 2)
})

test('native DSH readings, pending or persisted, do not get a second clock', async (t) => {
  const { step, reads } = setup(t, { events: [reading(NOW - 1, 'time-context')] })
  const decision = { kind: 'enter', messages: [{ source: { kind: 'time-context' } }] }
  assert.equal(await step(decision), decision)
  assert.equal(reads(), 0)
  const empty = { kind: 'enter', messages: [] }
  assert.equal(await step(empty), empty)
})

test('an expired native DSH clock is refreshed when the preset no longer supplies one', async (t) => {
  const { step } = setup(t, { events: [reading(NOW - 600_000, 'time-context')] })
  assert.equal((await step()).messages.length, 2)
})

test('a rejection or cancellation does not add a reading or read history', async (t) => {
  const { step, reads } = setup(t)
  const reject = { kind: 'reject' }
  assert.equal(await step(reject), reject)
  const abort = new AbortController()
  abort.abort()
  const decision = { kind: 'enter', messages: [] }
  assert.equal(await step(decision, { signal: abort.signal }), decision)
  assert.equal(reads(), 0)
})

test('ordinary DSH sessions are unchanged', async (t) => {
  const { step, reads } = setup(t, { owned: false })
  const decision = { kind: 'enter', messages: [] }
  assert.equal(await step(decision), decision)
  assert.equal(reads(), 0)
})

test('group member sessions and fresh parts get their own clock', async (t) => {
  const { step } = setup(t)
  for (const id of ['group-member', 'fresh-part']) {
    assert.equal((await step(undefined, { agent: { id } })).messages.length, 2)
  }
})

test('a backward wall-clock change refreshes the stale future reading', async (t) => {
  const { step } = setup(t, { events: [reading(NOW + 1)] })
  assert.equal((await step()).messages.length, 2)
})

test('a zero interval refreshes every eligible step', async (t) => {
  const { step } = setup(t, { config: { timeRefreshIntervalMs: 0 }, events: [reading(NOW)] })
  assert.equal((await step()).messages.length, 2)
})

test('invalid intervals and zones fail at plugin installation', () => {
  for (const interval of [-1, 0.5, Infinity, NaN, '10']) {
    assert.throws(() => install({ ctx: fakeContext(), config: { timeRefreshIntervalMs: interval } }), /timeRefreshIntervalMs/)
  }
  assert.throws(() => install({ ctx: fakeContext(), config: { timeZone: 'invalid-zone' } }), RangeError)
})
