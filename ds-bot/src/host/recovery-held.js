// Only metadata needed to find an interrupted turn may leave the recovery journal.
// Never return the record, trigger, text, arbitrary reason or filesystem path.
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(value) ? value : undefined

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
    if (decisions !== undefined && (!Array.isArray(decisions) || decisions.length > 100 || decisions.some((entry, index) => !entry || entry.revision !== index + 1 || !['ignored', 'open'].includes(entry.choice) || entry.by !== 'user' || !Number.isSafeInteger(entry.at)))) { incomplete = true; continue }
    const choice = decisions?.at(-1)?.choice ?? 'open'
    items.push({ recoveryId, botId, botName, sessionId, ...(roomId ? { roomId } : {}),
      ...(exchangeId ? { exchangeId } : {}), ...(startedAt !== undefined ? { startedAt } : {}),
      ...(turn !== undefined ? { turn } : {}), status: 'uncertain', decision: choice, decisionRevision: decisions?.length ?? 0, evidence: 'inflight.json' })
  }
  items.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0) || a.recoveryId.localeCompare(b.recoveryId))
  return { available: true, incomplete, items }
}
