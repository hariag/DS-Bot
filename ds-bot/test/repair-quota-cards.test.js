import assert from 'node:assert/strict'
import test from 'node:test'
import { repairQuotaCards } from '../src/host/repair-quota-cards.js'

function fixture() {
  const saved = { code: 'AUTH', provider: 'fanttec', turn: 3, requestId: 'original', message: '' }
  const bot = { id: 'b', failures: { s: saved }, blocked: { code: 'AUTH', provider: 'fanttec', requestId: 'original' } }
  const record = { type: 'event', event: { seq: 0, type: 'turn/end', data: { turn: 3, reason: { kind: 'error', error: {
    code: 'AUTH', message: 'fanttec API error (403): {"code":"insufficient_user_quota"}',
  } } } } }
  let saves = 0
  const ctx = { sessionController: { events: async ({ address, maxMessages }) => {
    assert.deepEqual(address, { kind: 'session', sessionId: 's' }); assert.equal(maxMessages, 12)
    return { cursor: 0, hasMore: false, records: [record] }
  } } }
  const rt = { state: { bots: { b: bot } }, ctx, load: async () => {}, readOnly: () => undefined,
    selfOf: id => id === 's' ? 'b' : undefined, botOf: id => id === 'b' ? bot : undefined,
    save: async opts => { assert.equal(opts.required, true); saves++ } }
  return { rt, bot, record, saves: () => saves }
}

test('reclassifies the saved turn and its own block once without retrying the turn', async () => {
  const { rt, bot, saves } = fixture()
  await repairQuotaCards(rt); await repairQuotaCards(rt)
  assert.equal(bot.failures.s.code, 'QUOTA'); assert.equal(bot.failures.s.status, 403)
  assert.equal(bot.blocked.code, 'QUOTA'); assert.equal(bot.blocked.sessionId, 's'); assert.equal(bot.blocked.turn, 3)
  assert.equal(saves(), 1)
})

test('a newer block, another turn, genuine auth error, unavailable history or a concurrent replacement is preserved', async () => {
  for (const situation of ['other-block', 'other-turn', 'auth', 'unavailable', 'concurrent', 'read-only']) {
    const { rt, bot, record, saves } = fixture()
    if (situation === 'other-block') bot.blocked.requestId = 'another'
    if (situation === 'other-turn') record.event.data.turn++
    if (situation === 'auth') record.event.data.reason.error.message = 'invalid key'
    if (situation === 'unavailable') rt.ctx.sessionController.events = async () => { throw Error('unavailable') }
    if (situation === 'concurrent') rt.ctx.sessionController.events = async () => {
      bot.failures.s = { ...bot.failures.s, turn: 4 }; return { cursor: 0, hasMore: false, records: [record] }
    }
    if (situation === 'read-only') rt.readOnly = () => 'reader'
    await repairQuotaCards(rt)
    assert.equal(bot.blocked.code, 'AUTH', situation)
    assert.equal(bot.failures.s.code, situation === 'other-block' ? 'QUOTA' : 'AUTH', situation)
    assert.equal(saves(), situation === 'other-block' ? 1 : 0, situation)
  }
})


test('an older failure in the next page is bound to the first snapshot and exact turn', async () => {
  for (const variant of ['anchored', 'changed-cut', 'gap']) {
    const { rt, bot, record } = fixture()
    const newer = Array.from({ length: 96 }, (_, i) => ({ type: 'event', event: { seq: i + 1, type: 'step/end', data: { turn: 4 } } }))
    const calls = []
    rt.ctx.sessionController.events = async request => {
      calls.push(request)
      if (calls.length === 1) return { cursor: 96, records: newer, hasMore: true }
      assert.equal(request.throughSeq, 96); assert.equal(request.beforeSeq, 1)
      if (variant === 'gap') record.event.seq = 1
      return { cursor: variant === 'changed-cut' ? 97 : 96, records: [record], hasMore: false }
    }
    await repairQuotaCards(rt)
    assert.equal(calls.length, 2); assert.equal(bot.blocked.code, variant === 'anchored' ? 'QUOTA' : 'AUTH')
  }
})
