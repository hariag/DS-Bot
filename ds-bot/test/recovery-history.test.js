import test from 'node:test'
import assert from 'node:assert/strict'
import { historyMentionsSource, readDurableReply, readRecoveryHistory, replyContainsInlineResults, observedOutputLimit } from '../src/host/recovery-history.js'

const event = (seq, type, data = {}) => ({ seq, type, data })
const reply = (seq, overrides = {}) => event(seq, 'user/message', { source: { kind: 'bot', role: 'reply', senderSessionId: 'worker', replyTo: 'work', ...overrides }, content: [{ type: 'text', text: 'original result' }] })

function persistence(events) {
  const session = { seq: events.length, eventAt: seq => events[seq] }
  const ctx = { sessions: { get: () => session }, sessionPersistence: {
    flushLiveSession: async () => {}, open: async () => ({ read: async () => ({ events }), close: async () => {} }),
  } }
  return { ctx, session }
}

test('pages a fixed ordered history and treats gaps as unreadable', async () => {
  const events = [event(0, 'turn/start'), event(1, 'turn/end')]
  const controller = { page: async ({ beforeSeq }) => beforeSeq === undefined
    ? { cursor: 1, records: [{ type: 'event', event: events[1] }], hasMore: true }
    : { cursor: 1, records: [{ type: 'event', event: events[0] }], hasMore: false } }
  assert.deepEqual(await readRecoveryHistory(controller, 's'), events)
  assert.equal(await readRecoveryHistory({ page: async () => ({ cursor: 3, records: [{ type: 'event', event: events[1] }], hasMore: false }) }, 's'), undefined)
  assert.equal(historyMentionsSource([event(0, 'agent/inbox/spliced', { inserted: [{ source: { exchangeId: 'x' } }] })], 'exchangeId', 'x'), true)
})

test('accepts one exact persisted reply and rejects ambiguous or unavailable evidence', async () => {
  const resolve = ({ ctx }) => readDurableReply(ctx, 'sender', 'work', 'worker', 'bot')
  assert.equal(await resolve(persistence([reply(0)])), 'original result')
  assert.equal(await resolve(persistence([reply(0), reply(1)])), undefined)
  assert.equal(await resolve(persistence([reply(0, { senderSessionId: 'different' })])), undefined)
  assert.equal(await resolve(persistence([event(0, 'user/message', { source: { kind: 'bot', role: 'reply', senderSessionId: 'worker', replyTo: 'work' }, content: [{ type: 'image' }] })])), undefined)
  const failed = persistence([reply(0)]); failed.ctx.sessionPersistence.flushLiveSession = async () => { throw Error('failed') }
  assert.equal(await resolve(failed), undefined)
  const changed = persistence([reply(0)]); changed.ctx.sessionPersistence.flushLiveSession = async () => { changed.ctx.sessions.get = () => ({ seq: 1 }) }
  assert.equal(await resolve(changed), undefined)
  const incomplete = persistence([reply(0)]); incomplete.session.seq = 2
  assert.equal(await resolve(incomplete), undefined)
})

test('refuses a changing prefix, wrong event order, and a reply for other work', async () => {
  const resolve = ({ ctx }) => readDurableReply(ctx, 'sender', 'work', 'worker', 'bot')
  const moving = persistence([reply(0)])
  moving.ctx.sessionPersistence.flushLiveSession = async () => { moving.session.seq += 1 }
  assert.equal(await resolve(moving), undefined)
  const gap = persistence([reply(1)])
  assert.equal(await resolve(gap), undefined)
  assert.equal(await resolve(persistence([reply(0, { replyTo: 'other' })])), undefined)
  assert.equal(await readDurableReply({ sessions: { get: () => ({ seq: 1 }) }, sessionPersistence: {} }, 'sender', 'work', 'worker', 'bot'), undefined)
})


test('child results are reconciled only when the received reply contains each complete inline result', () => {
  const results = [{ id: 'c1', name: 'Reviewer', text: 'The numbers check out.' }]
  const reply = '[Reply from Writer]\nDone.\n\n[Handed back to Writer for this work]\n\nReviewer:\nThe numbers check out.'
  assert.equal(replyContainsInlineResults(reply, results, 'Writer'), true)
  assert.equal(replyContainsInlineResults(reply, [{ ...results[0], text: 'Different numbers' }], 'Writer'), false)
  assert.equal(replyContainsInlineResults(reply, [{ ...results[0], length: 100 }], 'Writer'), false)
  assert.equal(replyContainsInlineResults(reply, [{ ...results[0], file: 'result.txt' }], 'Writer'), false)
  assert.equal(replyContainsInlineResults(reply, [{ ...results[0], failed: true }], 'Writer'), false)
  assert.equal(replyContainsInlineResults(reply, [results[0], results[0]], 'Writer'), false)
  assert.equal(replyContainsInlineResults(reply.replace('[Handed back to Writer for this work]', ''), results, 'Writer'), false)
})


test('output-limit observation requires one matching message and one contiguous matching turn', () => {
  const events = [event(0, 'turn/start', { turn: 4 }),
    event(1, 'user/message', { source: { kind: 'bot', role: 'request', exchangeId: 'x' } }),
    event(2, 'turn/end', { turn: 4, reason: { kind: 'max-tokens' } })]
  assert.equal(observedOutputLimit(events, 'x', 4, 'request'), true)
  assert.equal(observedOutputLimit(events, 'x', 5, 'request'), false)
  assert.equal(observedOutputLimit(events, 'other', 4, 'request'), false)
  assert.equal(observedOutputLimit(events, 'x', 4, 'reply'), false)
  assert.equal(observedOutputLimit([events[0], { ...events[1], seq: 9 }, events[2]], 'x', 4, 'request'), false)
  assert.equal(observedOutputLimit([...events, event(3, 'user/message', { source: { exchangeId: 'x' } })], 'x', 4, 'request'), false)
  assert.equal(observedOutputLimit([events[0], events[1], event(2, 'turn/end', { turn: 4, reason: { kind: 'completed' } })], 'x', 4, 'request'), false)
})
