import { createHash } from 'node:crypto'

// Only metadata needed to find interrupted work may leave the recovery journal.
// Never return a record, trigger, message text, arbitrary reason or filesystem path.
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(value) ? value : undefined
const DELIVERY_STATUS = Object.freeze({
  prepared: 'send-outcome-unknown',
  'history-unavailable': 'history-unavailable',
  'history-seen': 'seen-in-history',
  'work-stopped': 'work-stopped',
  'review-uncertain': 'review-uncertain',
})

const decisionHistory = value => value === undefined || Array.isArray(value) && value.length <= 100
  && value.every((entry, index) => entry && entry.revision === index + 1 && ['ignored', 'open'].includes(entry.choice)
    && entry.by === 'user' && Number.isSafeInteger(entry.at))

export function heldTurnsView(held, scope, bots = {}) {
  const items = []
  let incomplete = false
  let scanned = 0
  if (!held || typeof held !== 'object' || Array.isArray(held) || !scope || !['room', 'personal'].includes(scope.kind) || !id(scope.id)) return { available: false, incomplete: true, items }
  for (const key in held) {
    if (!Object.hasOwn(held, key)) continue
    if (++scanned > 20_000) { incomplete = true; break }
    const value = held[key]
    const record = value?.record
    const recoveryId = /^[a-f0-9]{64}$/.test(key) ? key : undefined
    const sessionId = id(value?.sessionId)
    const botId = id(record?.botId)
    const roomId = record?.roomId === undefined ? undefined : id(record.roomId)
    if (!recoveryId || !sessionId || !botId || !record || typeof record !== 'object' || (record.roomId !== undefined && !roomId)) {
      incomplete = true
      continue
    }
    if (scope.kind === 'room' && roomId !== scope.id) continue
    if (scope.kind === 'personal' && scope.id !== 'user' && botId !== scope.id) continue
    if (items.length >= 500) { incomplete = true; break }
    const botName = Object.hasOwn(bots, botId) && typeof bots[botId]?.name === 'string' ? bots[botId].name.slice(0, 120) : botId
    const exchangeId = id(record.trigger?.exchangeId)
    const startedAt = Number.isSafeInteger(record.since) && record.since >= 0 && record.since <= 8_640_000_000_000_000 ? record.since : undefined
    const turn = Number.isSafeInteger(record.turn) && record.turn >= 0 ? record.turn : undefined
    const decisions = value.decisions
    if (!decisionHistory(decisions)) { incomplete = true; continue }
    const choice = decisions?.at(-1)?.choice ?? 'open'
    items.push({ recoveryId, botId, botName, sessionId, ...(roomId ? { roomId } : {}),
      ...(exchangeId ? { exchangeId } : {}), ...(startedAt !== undefined ? { startedAt } : {}),
      ...(turn !== undefined ? { turn } : {}), status: 'uncertain', decision: choice, decisionRevision: decisions?.length ?? 0, evidence: 'inflight.json' })
  }
  items.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0) || a.recoveryId.localeCompare(b.recoveryId))
  return { available: true, incomplete, items }
}

/** Project scoped metadata for deliveries recovery held without exposing inputs. */
export function queuedDeliveriesView(queued, scope, bots = {}) {
  const items = []
  let incomplete = false, scanned = 0
  if (!queued || typeof queued !== 'object' || Array.isArray(queued) || !scope
    || !['room', 'personal'].includes(scope.kind) || !id(scope.id)) return { incomplete: true, items }
  const inScope = args => {
    if (scope.kind === 'room') return args.roomId === scope.id
    if (args.roomId !== undefined && args.roomId !== '') return false
    if (args.groupKickoff === true || args.role === 'room' || args.role === 'report') return false
    return scope.id === 'user' || args.toId === scope.id
  }
  const seen = new Set()
  for (const [sessionId, entries] of Object.entries(queued)) {
    if (!Array.isArray(entries)) { incomplete = true; continue }
    for (const entry of entries) {
      if (++scanned > 20_000) { incomplete = true; break }
      if (!entry || typeof entry !== 'object' || Array.isArray(entry) || entry.recoveryHold === undefined) continue
      const args = entry.args
      if (!args || typeof args !== 'object' || Array.isArray(args)) { incomplete = true; continue }
      if (!inScope(args)) continue
      const status = DELIVERY_STATUS[entry.recoveryHold]
      const exchangeId = id(args.exchangeId), recipientId = id(args.toId), validSessionId = id(sessionId)
      if (!status || !exchangeId || !recipientId || !validSessionId || !decisionHistory(entry.decisions)) { incomplete = true; continue }
      const recoveryId = createHash('sha256').update(JSON.stringify(['ds-bot:queued-delivery:v1', sessionId, exchangeId])).digest('hex')
      if (seen.has(recoveryId)) { incomplete = true; continue }
      seen.add(recoveryId)
      const recipientName = Object.hasOwn(bots, recipientId) && typeof bots[recipientId]?.name === 'string'
        ? bots[recipientId].name.slice(0, 120) : recipientId
      const decisions = entry.decisions
      items.push({ recoveryId, exchangeId, sessionId:validSessionId, recipientId, recipientName, status,
        ...(Number.isSafeInteger(entry.at) && entry.at >= 0 && entry.at <= 8_640_000_000_000_000 ? { queuedAt:entry.at } : {}),
        decision:decisions?.at(-1)?.choice ?? 'open', decisionRevision:decisions?.length ?? 0 })
    }
    if (scanned > 20_000) break
  }
  items.sort((a, b) => (b.queuedAt ?? 0) - (a.queuedAt ?? 0) || a.recoveryId.localeCompare(b.recoveryId))
  return { incomplete, items }
}
