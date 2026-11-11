import { test } from 'node:test'
import assert from 'node:assert/strict'
import { review } from '../scripts/recovery-audit.mjs'

const record = (id, overrides = {}) => ({ exchangeId: id, before_stop: [{ session: 'old' }], current_pending: [], post_restart_reads: [], inflight: [], ...overrides })
const snapshot = records => ({ scope: 'fixture sessions only', sessions_attempted: 2, started_at: '2026-01-01T00:01:00Z', finished_at: '2026-01-01T00:01:01Z', stop_cutoff: '2026-01-01T00:00:00Z', restart_process_start: '2026-01-01T00:00:30Z', ledger_changed_during_read: false, errors: [], records })
const options = { now: Date.parse('2026-01-01T00:01:02Z') }

test('classifies evidence without claiming completion or replay safety', () => {
  const data = snapshot([
    record('p', { current_pending: [{ session: 'new' }] }),
    record('c', { post_restart_reads: [{ turn_end: { reason: 'completed' } }] }),
    record('u', { post_restart_reads: [{ turn_end: null }] }),
    record('l', { inflight: [{ session: 'old' }] }),
    record('n'),
    record('m', { current_pending: [{ session: 'new' }], post_restart_reads: [{ turn_end: { reason: 'completed' } }] }),
  ])
  const report = review(data, options)
  assert.deepEqual(report.items.map(item => item.status), ['pending', 'entered_completed_turn', 'entered_unfinished_or_aborted_turn', 'ledger_only', 'not_observed', 'pending_and_entered_review'])
  assert.ok(report.items.every(item => item.replaySafe === false))
  assert.equal(report.coverage, 'bounded_asynchronous_snapshot')
  assert.equal(report.freshness, 'within_window')
})

test('duplicates, absent evidence and invalid or ambiguous clocks fail closed', () => {
  assert.throws(() => review(snapshot([record('x'), record('x')]), options), /duplicate exchangeId/)
  assert.throws(() => review(snapshot([record('x', { before_stop: [] })]), options), /missing pre-stop evidence/)
  assert.throws(() => review({ ...snapshot([]), stop_cutoff: '2026-01-01T00:00:00' }, options), /timezone/)
  assert.throws(() => review({ ...snapshot([]), restart_process_start: '2026-01-01T00:02:00Z' }, options), /out of order/)
})

test('stale snapshots, changing ledgers, future clocks and duplicate pending sessions stay explicit', () => {
  const data = snapshot([record('x', { current_pending: [{ session: 'a' }, { session: 'b' }] })])
  const report = review({ ...data, ledger_changed_during_read: true }, { now: options.now + 300_000 })
  assert.equal(report.coverage, 'incomplete')
  assert.equal(report.freshness, 'stale')
  assert.equal(report.items[0].multiplePendingSessions, true)
  assert.equal(report.items[0].multiplePendingOccurrences, true)
  assert.equal(report.items[0].replaySafe, false)
  assert.equal(review(data, { now: options.now - 10_000 }).freshness, 'future_clock')
  assert.equal(review({ ...data, sessions_attempted: undefined }, options).coverage, 'incomplete')
})
