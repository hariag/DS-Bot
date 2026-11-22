// Offline review of a previously exported, metadata-only recovery snapshot.
// This tool never opens a DSH home, changes queues, or sends messages.
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const VERSION = 1
const fail = message => { throw new TypeError(message) }
const array = (value, name) => Array.isArray(value) ? value : fail(`${name} must be an array`)
const time = (value, name) => {
  if (typeof value !== 'string' || !/(?:Z|[+-]\d\d:\d\d)$/.test(value)) fail(`${name} must include a timezone`)
  const ms = Date.parse(value)
  if (!Number.isFinite(ms)) fail(`${name} must be a valid time`)
  return ms
}

export function review(snapshot, { now = Date.now(), maxAgeMs = 120_000 } = {}) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) fail('snapshot must be an object')
  if (!Number.isFinite(now) || !Number.isFinite(maxAgeMs) || maxAgeMs < 0) fail('invalid freshness parameters')
  const started = time(snapshot.started_at, 'started_at')
  const finished = time(snapshot.finished_at, 'finished_at')
  const stopped = time(snapshot.stop_cutoff, 'stop_cutoff')
  const restarted = time(snapshot.restart_process_start, 'restart_process_start')
  if (stopped > restarted || restarted > started || started > finished) fail('snapshot times are out of order')
  const errors = array(snapshot.errors, 'errors')
  const records = array(snapshot.records, 'records')
  const seen = new Set()
  const counts = Object.create(null)
  const items = records.map((record, index) => {
    if (!record || typeof record.exchangeId !== 'string' || !record.exchangeId.trim()) fail(`record ${index}: missing exchangeId`)
    if (seen.has(record.exchangeId)) fail(`record ${index}: duplicate exchangeId`)
    seen.add(record.exchangeId)
    const before = array(record.before_stop, 'before_stop')
    const pending = array(record.current_pending, 'current_pending')
    const reads = array(record.post_restart_reads, 'post_restart_reads')
    const ledger = array(record.inflight, 'inflight')
    if (before.length === 0) fail(`record ${index}: missing pre-stop evidence`)
    const completed = reads.some(read => read?.turn_end?.reason === 'completed')
    const unfinished = reads.some(read => read?.turn_end?.reason !== 'completed')
    const status = pending.length && reads.length ? 'pending_and_entered_review'
      : pending.length ? 'pending'
        : completed && unfinished ? 'mixed_turns_review'
          : completed ? 'entered_completed_turn'
            : reads.length ? 'entered_unfinished_or_aborted_turn'
              : ledger.length ? 'ledger_only'
                : 'not_observed'
    counts[status] = (counts[status] ?? 0) + 1
    const pendingSessions = new Set(pending.map(item => item?.session).filter(value => typeof value === 'string'))
    return {
      exchangeId: record.exchangeId,
      status,
      beforeSessions: [...new Set(before.map(item => item?.session).filter(value => typeof value === 'string'))],
      pendingSessions: [...pendingSessions],
      pendingOccurrences: pending.length,
      observedReads: reads.length,
      ledgerOccurrences: ledger.length,
      multiplePendingSessions: pendingSessions.size > 1,
      multiplePendingOccurrences: pending.length > 1,
      replaySafe: false,
    }
  })
  const freshness = finished > now ? 'future_clock' : now - finished > maxAgeMs ? 'stale' : 'within_window'
  return {
    version: VERSION,
    snapshotStartedAt: snapshot.started_at,
    snapshotFinishedAt: snapshot.finished_at,
    stopCutoff: snapshot.stop_cutoff,
    restartProcessStart: snapshot.restart_process_start,
    scope: typeof snapshot.scope === 'string' ? snapshot.scope : 'unspecified',
    freshness,
    coverage: errors.length === 0 && snapshot.ledger_changed_during_read === false
      && typeof snapshot.scope === 'string' && snapshot.scope.trim() !== ''
      && Number.isSafeInteger(snapshot.sessions_attempted) && snapshot.sessions_attempted > 0
      ? 'bounded_asynchronous_snapshot' : 'incomplete',
    counts,
    items,
    warnings: [
      'No status proves business completion or exactly-once effects.',
      'Not observed is not proof of loss; investigate earlier sessions and side effects.',
      'Never replay automatically from this report.',
    ],
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 3) throw new Error('Usage: node scripts/recovery-audit.mjs <exported-metadata.json>')
    const snapshot = JSON.parse(readFileSync(process.argv[2], 'utf8'))
    process.stdout.write(`${JSON.stringify(review(snapshot), null, 2)}\n`)
  } catch (error) {
    process.stderr.write(`recovery-audit: ${error.message}\n`)
    process.exitCode = 1
  }
}
