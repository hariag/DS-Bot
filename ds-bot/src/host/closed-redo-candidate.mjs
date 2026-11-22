import { isDeepStrictEqual } from 'node:util'
import { symbols } from '@deepseek-ai/cordis'
import { LEGACY_CANDIDATE_WARNING } from './user-redo-legacy-candidate.mjs'

const providerOf = service => service?.[symbols.original] ?? service
const noControl = source => source && ['request', 'room'].includes(source.role) && source.reviewInspect !== true
  && source.groupKickoff !== true && source.reviewId === undefined && source.recoveryIds === undefined
  && source.recoveryKey === undefined && source.resumed !== true && source.retried !== true
  && source.abandoned !== true && source.deferred !== true
const sameRoom = (scope, roomId) => scope?.kind === 'room' ? typeof scope.id === 'string' && roomId === scope.id
  : scope?.kind === 'personal' && roomId === undefined
const sameOriginRoom = (scope, roomId) => roomId === undefined || (scope?.kind === 'room' && roomId === scope.id)

// Read-only, unverified snapshot for an unloaded historical Session. This is
// NOT a producer proof or a durable execution authority, even if stat() is
// stable: another process may hold a writer and unflushed data is invisible.
// An owner must never use this projection as a claim or an execution receipt.
export function createClosedRedoCandidatePreview(rt, { timeoutMs = 15_000, maxBytes = 32 * 1024 * 1024, maxEvents = 200_000 } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000
    || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isSafeInteger(maxEvents) || maxEvents < 1) throw Error('invalid candidate limits')
  let pending = false
  const read = async (scope, recoveryId) => {
    let reader
    try {
      const held = await rt.recoveryHeldOriginal(scope, recoveryId), record = held?.record, trigger = record?.trigger
      if (!held || record.turn !== undefined || !Number.isSafeInteger(record.since) || record.since < 0
        || !noControl(trigger) || typeof trigger.exchangeId !== 'string' || !trigger.exchangeId
        || (trigger.role === 'request' && (typeof trigger.senderSessionId !== 'string' || !trigger.senderSessionId))
        || !sameRoom(scope, record.roomId ?? trigger.roomId) || !sameRoom(scope, trigger.roomId)
        || !sameOriginRoom(scope, trigger.senderRoomId)
        || (record.roomId !== undefined && record.roomId !== trigger.roomId) || held.isCurrent() !== true) return undefined
      const ctx = rt.ctx, sessions = ctx.sessions, getPersistence = () => ctx.get?.('sessionPersistence') ?? ctx.sessionPersistence
      const persistence = getPersistence(), sessionsProvider = providerOf(sessions), persistenceProvider = providerOf(persistence)
      if (typeof sessions?.get !== 'function' || sessions.get(held.sessionId) !== undefined
        || typeof persistence?.stat !== 'function' || typeof persistence?.open !== 'function') return undefined
      const current = () => held.isCurrent() === true && providerOf(ctx.sessions) === sessionsProvider
        && providerOf(getPersistence()) === persistenceProvider && sessions.get(held.sessionId) === undefined
      const signal = AbortSignal.timeout(timeoutMs), before = await persistence.stat(held.sessionId, { signal })
      if (!current() || signal.aborted || !before || before.header?.id !== held.sessionId || before.formatStatus !== 'current'
        || before.revision === undefined || !Number.isSafeInteger(before.sizeBytes) || before.sizeBytes < 1 || before.sizeBytes > maxBytes) return undefined
      reader = await persistence.open(held.sessionId, 'read', { signal })
      if (!current() || reader?.id !== held.sessionId || !isDeepStrictEqual(reader.header, before.header)) return undefined
      const { events } = await reader.read(0, maxEvents + 1, { signal })
      if (!Array.isArray(events) || !events.length || events.length > maxEvents
        || events.some((event, index) => event?.seq !== index)) return undefined
      const after = await persistence.stat(held.sessionId, { signal })
      if (signal.aborted || !current() || !after || !isDeepStrictEqual(before, after)) return undefined
      const starts = events.filter(event => event.type === 'turn/start' && event.time === record.since)
      if (starts.length !== 1) return undefined
      const start = starts[0], endings = events.filter(event => event.seq > start.seq && event.type === 'turn/end' && event.data?.turn === start.data?.turn)
      if (endings.length !== 1) return undefined
      const end = endings[0]
      // A closed snapshot is not proof that the earlier turn failed or that
      // its other inputs were included. Pick only one exchange-matched input;
      // the UI explicitly warns that other context may be omitted.
      const inputs = events.filter(event => event.type === 'user/message' && event.seq > start.seq && event.seq < end.seq
        && event.data?.source?.exchangeId === trigger.exchangeId)
      if (inputs.length !== 1) return undefined
      const event = inputs[0], message = event.data, source = message?.source
      if (source?.kind !== 'bot' || !noControl(source) || !sameRoom(scope, source.roomId) || !sameOriginRoom(scope, source.senderRoomId)
        || source.exchangeId !== trigger.exchangeId || Object.entries(trigger).some(([key, value]) => !isDeepStrictEqual(source[key], value))
        || typeof message.id !== 'string' || !message.id || message.role !== 'user'
        || !Array.isArray(message.content) || !message.content.length
        || message.content.some(part => part?.type !== 'text' || typeof part.text !== 'string' || Object.keys(part).some(key => !['type', 'text'].includes(key)))
        || message.content.every(part => !part.text.trim()) || Buffer.byteLength(JSON.stringify(message.content)) > 65_536) return undefined
      if (events.filter(item => item.type === 'user/message' && item.data?.source?.exchangeId === trigger.exchangeId).length !== 1) return undefined
      const insertions = events.flatMap(item => item.type === 'agent/inbox/spliced'
        ? (item.data?.inserted ?? []).filter(candidate => candidate?.id === message.id) : [])
      if (insertions.length !== 1 || !isDeepStrictEqual(insertions[0], message)) return undefined
      const final = await persistence.stat(held.sessionId, { signal })
      if (signal.aborted || !current() || !isDeepStrictEqual(before, final)) return undefined
      return { kind:'unverified-legacy-candidate', producerVerified:false, executeAllowed:false, snapshotOnly:true, recoveryId,
        warning:LEGACY_CANDIDATE_WARNING, botId:record.botId, sessionId:held.sessionId,
        ...(scope.kind === 'room' ? { roomId:scope.id } : {}), turn:start.data.turn, turnStartSeq:start.seq,
        messageSeq:event.seq, messageId:message.id, matchedTime:start.time, textSegments:message.content.map(part => part.text) }
    } catch { return undefined } finally { if (reader) await reader.close().catch(() => {}) }
  }
  return async (scope, recoveryId) => {
    if (pending) return undefined
    pending = true
    const work = read(structuredClone(scope), recoveryId)
    void work.then(() => { pending = false }, () => { pending = false })
    let timer
    try { return await Promise.race([work, new Promise(resolve => { timer = setTimeout(resolve, timeoutMs) })]) }
    finally { clearTimeout(timer) }
  }
}
