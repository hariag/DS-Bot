import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { createInboxAudit } from '../src/host/inbox-audit.js'

const msg = (id, exchangeId = id) => ({ id, source: { exchangeId }, content: 'private content should never be emitted' })
const splice = (target, start, removedCount, inserted, outcome) => ({
  type: 'agent/inbox/spliced', data: { target, start, removedCount, inserted, ...(outcome ? { outcome } : {}) },
})
const user = message => ({ type: 'user/message', data: message })
const fold = events => {
  const audit = createInboxAudit('test-session')
  events.forEach((event, seq) => audit.observe({ ...event, seq }))
  return audit.finish(events.length)
}

test('a claimed batch tracks each admission independently and retains unresolved removals', () => {
  const messages = Array.from({ length: 235 }, (_, n) => msg(`m${n}`))
  const result = fold([
    splice('next-step', 0, 0, messages),
    splice('next-step', 0, messages.length, []),
    ...messages.slice(0, 17).map(user),
  ])
  assert.equal(result.records.length, 235)
  assert.equal(result.records.filter(record => record.status === 'entered-in-log').length, 17)
  assert.equal(result.records.filter(record => record.status === 'uncertain').length, 218)
  assert.deepEqual(result.records[234].removals, [{ seq: 1, index: 234, batchSize: 235 }])
  assert.equal(JSON.stringify(result).includes('private content'), false)
})

test('removed input without matching admission remains uncertain, including canceled and migrated input', () => {
  const result = fold([
    splice('next-turn', 0, 0, [msg('a'), msg('b')]),
    splice('next-turn', 0, 1, [], 'canceled'),
    user(msg('a')),
    splice('next-turn', 0, 1, []),
    { type: 'turn/end', data: { error: 'interrupted' } },
  ])
  assert.deepEqual(result.records.map(record => record.status), ['uncertain', 'uncertain'])
})

test('reused message IDs, duplicate admissions and exchange conflicts never infer entry', () => {
  const result = fold([
    splice('next-turn', 0, 0, [msg('a'), msg('b'), msg('c')]),
    splice('next-turn', 0, 1, [], 'canceled'),
    splice('next-step', 0, 0, [msg('a')]),
    splice('next-step', 0, 1, []),
    user(msg('a')),
    splice('next-turn', 0, 2, []),
    user(msg('b')), user(msg('b')), user(msg('c', 'other-exchange')),
  ])
  assert.deepEqual(result.records.map(record => record.status), ['uncertain', 'uncertain', 'uncertain'])
  assert.deepEqual(result.records[2].exchangeIds, ['c', 'other-exchange'])
})

test('pending projection supports replacement and migration without declaring completion', () => {
  const result = fold([
    splice('next-turn', 0, 0, [msg('a'), msg('b')]),
    splice('next-turn', 0, 1, [msg('a')], 'canceled'),
    splice('next-turn', 1, 1, [], 'canceled'),
    splice('next-step', 0, 0, [msg('b')]),
    user(msg('unknown')), { type: 'user/message', data: {} },
  ])
  assert.equal(result.untrackedAdmissions, 2)
  assert.deepEqual(result.records.map(record => [record.id, record.status, record.pending]), [
    ['a', 'pending-in-log', { target: 'next-turn', index: 0 }],
    ['b', 'pending-in-log', { target: 'next-step', index: 0 }],
  ])
})

test('gaps, malformed splices and duplicate pending IDs invalidate the entire audit', () => {
  const cases = [
    [{ seq: 1, type: 'turn/start' }],
    [{ seq: 0, type: 'turn/start' }, { seq: 2, type: 'turn/end' }],
    [{ seq: 0, ...splice('next-step', 1, 0, []) }],
    [{ seq: 0, ...splice('next-step', 0, 1, []) }],
    [{ seq: 0, ...splice('next-step', 0, 0, [msg('a'), msg('a')]) }],
    [{ seq: 0, ...splice('next-step', 0, 0, [msg('a')]) }, { seq: 1, ...splice('next-turn', 0, 0, [msg('a')]) }],
    [{ seq: 0, ...splice('next-step', 0, 0, [{}]) }],
    [{ seq: 0, ...splice('bad-target', 0, 0, []) }],
  ]
  for (const events of cases) {
    const audit = createInboxAudit('test-session')
    assert.throws(() => events.forEach(event => audit.observe(event)), { code: 'inbox-audit/incomplete' })
    assert.throws(() => audit.finish(events.length), { code: 'inbox-audit/incomplete' })
  }
})

test('the caller must supply the exact independently acquired exclusive boundary', () => {
  const audit = createInboxAudit('test-session')
  audit.observe({ seq: 0, type: 'turn/start' })
  assert.throws(() => audit.finish(2), { code: 'inbox-audit/incomplete' })
  assert.throws(() => audit.finish(1), { code: 'inbox-audit/incomplete' })
})
