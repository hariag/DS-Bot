import { isDeepStrictEqual } from 'node:util'
import { symbols } from '@deepseek-ai/cordis'
import { createInboxAudit } from './inbox-audit.js'

const providerOf = service => service?.[symbols.original] ?? service
const comparableHeader = header => header && typeof header === 'object'
  ? { ...header, delegationDepth:header.delegationDepth === undefined ? 0 : header.delegationDepth } : header
const noControl = source => source && ['request', 'room'].includes(source.role) && source.reviewInspect !== true
  && source.groupKickoff !== true && source.reviewId === undefined
const sameRoom = (scope, roomId) => scope?.kind === 'room' ? typeof scope.id === 'string' && roomId === scope.id
  : scope?.kind === 'personal' && roomId === undefined
export const LEGACY_CANDIDATE_WARNING = Object.freeze({
  zh:'这段文字只是按时间匹配到的候选内容，无法确认发送者或原工作的结果，仅供核对，不能直接执行。',
  en:'This text is only a time-matched candidate. Its sender and original outcome are unverified; it is for inspection and cannot be executed directly.',
})

// This produces a read-only candidate, not an authenticated original input or
// authorization to run anything. The caller must authenticate the instance
// owner and authorize the scope before calling it. A timestamp match may be a
// synthetic Date.now() value, and stored source metadata is not producer proof.
// No result from this function has the proof shape accepted by the redo journal.
export function createLegacyRedoCandidate(rt, { timeoutMs = 15_000 } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new Error('invalid candidate timeout')
  // Every probe may read a full Session prefix. Bound work across different
  // recovery ids too; a timed-out disk read must not invite a parallel flood.
  let pending = false
  const read = async (scope, recoveryId) => {
    let reader
    try {
      const hold = await rt.recoveryHeldOriginal(scope, recoveryId)
      const record = hold?.record, trigger = record?.trigger
      if (!hold || record.turn !== undefined || !Number.isSafeInteger(record.since) || record.since < 0
        || !noControl(trigger) || typeof trigger.exchangeId !== 'string' || trigger.exchangeId === ''
        || (trigger.role === 'request' && (typeof trigger.senderSessionId !== 'string' || !trigger.senderSessionId))
        || !sameRoom(scope, record.roomId ?? trigger.roomId) || !sameRoom(scope, trigger.roomId)
        || (record.roomId !== undefined && trigger.roomId !== record.roomId) || hold.isCurrent() !== true) return undefined
      const ctx = rt.ctx, getPersistence = () => ctx.get?.('sessionPersistence') ?? ctx.sessionPersistence
      const sessions = ctx.sessions, persistence = getPersistence()
      const sessionsProvider = providerOf(sessions), persistenceProvider = providerOf(persistence)
      const session = sessions?.get?.(hold.sessionId), through = session?.seq
      if (!session || session.id !== hold.sessionId || typeof session.eventAt !== 'function'
        || !Number.isSafeInteger(through) || through < 1 || through > 200_000
        || typeof persistence?.flushLiveSession !== 'function' || typeof persistence?.open !== 'function') return undefined
      const current = () => hold.isCurrent() === true && providerOf(ctx.sessions) === sessionsProvider
        && providerOf(getPersistence()) === persistenceProvider && sessions.get(hold.sessionId) === session && session.seq === through
      const signal = AbortSignal.timeout(timeoutMs)
      await persistence.flushLiveSession(hold.sessionId)
      if (signal.aborted || !current()) return undefined
      reader = await persistence.open(hold.sessionId, 'read', { signal })
      if (!current() || reader?.id !== hold.sessionId
        || !isDeepStrictEqual(comparableHeader(reader.header), comparableHeader(session.header))
        || reader.inheritedEventCount !== session.inheritedEventCount) return undefined
      const { events } = await reader.read(0, through, { signal })
      if (signal.aborted || !current() || !Array.isArray(events) || events.length !== through
        || events.some((event, index) => event?.seq !== index || !isDeepStrictEqual(event, session.eventAt(index)))) return undefined

      // A single persisted timestamp match is merely a physical correlation;
      // it does not prove which turn the held record intended to identify.
      const starts = events.filter(event => event.type === 'turn/start' && event.time === record.since)
      if (starts.length !== 1 || !Number.isSafeInteger(starts[0].data?.turn) || starts[0].data.turn < 0
        || events.filter(event => event.type === 'turn/start' && event.data?.turn === starts[0].data.turn).length !== 1) return undefined
      const start = starts[0], tail = events.slice(start.seq + 1)
      const boundary = tail.findIndex(event => event.type === 'turn/start' || event.type === 'turn/end')
      const end = boundary < 0 ? undefined : tail[boundary]
      if (end?.type !== 'turn/end' || end.data?.turn !== start.data.turn
        || !(['interrupted', 'error'].includes(end.data?.reason?.kind)
          || (end.data?.reason?.kind === 'aborted' && end.data.reason.reason?.kind === 'disposed'))) return undefined
      const inputs = events.filter(event => event.type === 'user/message' && event.seq > start.seq && event.seq < end.seq)
      if (inputs.length !== 1) return undefined
      const event = inputs[0], message = event.data, source = message?.source
      if (source?.kind !== 'bot' || !noControl(source) || !sameRoom(scope, source.roomId)
        || source.exchangeId !== trigger.exchangeId || Object.entries(trigger).some(([key, value]) => !isDeepStrictEqual(source[key], value))
        || typeof message.id !== 'string' || !message.id || message.role !== 'user'
        || !Array.isArray(message.content) || message.content.length < 1
        || message.content.some(part => part?.type !== 'text' || typeof part.text !== 'string'
          || Object.keys(part).some(key => !['type', 'text'].includes(key)))
        || message.content.every(part => !part.text.trim()) || Buffer.byteLength(JSON.stringify(message.content)) > 65536) return undefined
      if (events.filter(item => item.type === 'user/message' && item.data?.source?.exchangeId === trigger.exchangeId).length !== 1) return undefined
      const insertions = events.flatMap(item => item.type === 'agent/inbox/spliced'
        ? (item.data?.inserted ?? []).filter(candidate => candidate?.id === message.id) : [])
      if (insertions.length !== 1 || !isDeepStrictEqual(insertions[0], message)) return undefined
      const audit = createInboxAudit(hold.sessionId)
      for (const item of events) audit.observe(item)
      const folded = audit.finish(through), admissions = folded.records.filter(row => row.id === message.id)
      const removals = folded.records.flatMap(row => row.removals
        .filter(removal => removal.seq > start.seq && removal.seq < end.seq).map(removal => ({ id:row.id, ...removal })))
      if (admissions.length !== 1 || admissions[0].status !== 'entered-in-log'
        || admissions[0].entered.length !== 1 || admissions[0].entered[0] !== event.seq
        || removals.length !== 1 || removals[0].id !== message.id || removals[0].batchSize !== 1 || !current()) return undefined
      return { kind:'unverified-legacy-candidate', producerVerified:false, executeAllowed:false, recoveryId,
        warning:LEGACY_CANDIDATE_WARNING,
        botId:record.botId, sessionId:hold.sessionId, ...(scope.kind === 'room' ? { roomId:scope.id } : {}),
        turn:start.data.turn, turnStartSeq:start.seq, messageSeq:event.seq, matchedTime:start.time,
        textSegments:message.content.map(part => part.text) }
    } catch { return undefined } finally { await reader?.close().catch(() => {}) }
  }
  return async (scope, recoveryId) => {
    if (pending) return undefined
    pending = true
    const work = read(scope, recoveryId)
    void work.then(() => { pending = false }, () => { pending = false })
    let timer
    try { return await Promise.race([work, new Promise(resolve => { timer = setTimeout(resolve, timeoutMs) })]) }
    finally { clearTimeout(timer) }
  }
}
