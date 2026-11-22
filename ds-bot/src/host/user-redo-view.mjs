import { isDeepStrictEqual } from 'node:util'
import { userRedoIdentity } from './user-redo-journal.mjs'

// The redo journal has no result receipt yet. Do not interpret a stored state,
// text, or a caller-provided Session as proof that a run started or finished.
// Board access and the held-record view must already have been authorized by
// the authenticated owner route before this projection is called.
export function userRedoView({ principal, scope, state, recovery }) {
  if (principal?.kind !== 'user' || principal.id !== 'user' || !scope
    || !['room', 'personal'].includes(scope.kind) || typeof scope.id !== 'string'
    || !state) return { available:false, incomplete:true, items:[] }
  if (recovery?.available !== true || !Array.isArray(recovery.items)) return recovery
  const held = recovery.items.map(({ redo: _, ...item }) => item)
  const rows = state.userRedos
  if (rows === undefined) return { ...recovery, items:held }
  if (!rows || typeof rows !== 'object' || Array.isArray(rows)) return { ...recovery, incomplete:true, items:held }
  const candidates = new Map()
  let incomplete = recovery.incomplete === true, scanned = 0
  for (const key in rows) {
    if (!Object.hasOwn(rows, key)) continue
    if (++scanned > 20_000) { incomplete = true; break }
    const entry = rows[key]
    if (!entry || !isDeepStrictEqual(entry.scope, scope)) continue
    const item = held.find(row => row.recoveryId === entry.recoveryId)
    if (!item) continue
    let valid = false
    try {
      const identity = userRedoIdentity(key), original = entry.original
      const bot = Object.hasOwn(state.bots ?? {}, item.botId) ? state.bots[item.botId] : undefined
      const room = scope.kind === 'room' && Object.hasOwn(state.rooms ?? {}, scope.id) ? state.rooms[scope.id] : undefined
      valid = entry.operationId === key && isDeepStrictEqual(entry.identity, identity)
        && /^[a-f0-9]{64}$/.test(entry.recoveryId) && entry.acknowledged === true
        && original?.botId === item.botId && original?.sessionId === item.sessionId && !!bot
        && typeof original.messageId === 'string' && original.messageId.length > 0
        && /^[a-f0-9]{64}$/.test(original.messageHash)
        && Number.isSafeInteger(original.messageSeq) && original.messageSeq >= 0
        && Number.isSafeInteger(original.turn) && original.turn >= 0
        && (scope.kind === 'room' ? item.roomId === scope.id && Array.isArray(room?.members) && room.members.includes(item.botId)
          : item.roomId === undefined && (scope.id === 'user' || scope.id === item.botId))
    } catch { valid = false }
    if (!valid || candidates.has(entry.recoveryId)) {
      candidates.set(entry.recoveryId, null)
      incomplete = true
      continue
    }
    candidates.set(entry.recoveryId, { operationId:key, status:'unknown' })
  }
  return { ...recovery, incomplete, items:held.map(item => {
    const redo = candidates.get(item.recoveryId)
    return redo ? { ...item, redo } : item
  }) }
}
