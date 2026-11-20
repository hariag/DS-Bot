import { isDeepStrictEqual } from 'node:util'
import { symbols } from '@deepseek-ai/cordis'
import { createInboxAudit } from './inbox-audit.js'

const providerOf = service => service?.[symbols.original] ?? service
const comparableHeader = header => header && typeof header === 'object'
  ? { ...header, delegationDepth:header.delegationDepth === undefined ? 0 : header.delegationDepth } : header

// Read only: an unknown or incomplete prefix is never evidence of absence.
// This intentionally supports only a uniquely recorded Bot exchange from a
// stopped turn. Other histories stay unavailable for manual examination.
export function createUserRedoOriginalProof(rt, { timeoutMs = 15_000 } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new Error('invalid proof timeout')
  const pending = new Set()
  const read = async (scope, recoveryId) => {
    let reader
    try {
      const hold = await rt.recoveryHeldOriginal(scope, recoveryId)
      const trigger = hold?.record?.trigger
      if (!hold || !trigger || !['request', 'room'].includes(trigger.role) || trigger.reviewInspect === true
        || trigger.groupKickoff === true || trigger.reviewId !== undefined || typeof trigger.exchangeId !== 'string'
        || trigger.exchangeId === '' || (hold.record.turn !== undefined
          && (!Number.isSafeInteger(hold.record.turn) || hold.record.turn < 0)) || hold.isCurrent() !== true) return undefined
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
      const result = await reader.read(0, through, { signal })
      if (signal.aborted || !current() || !Array.isArray(result?.events) || result.events.length !== through
        || result.events.some((event, index) => event?.seq !== index || !isDeepStrictEqual(event, session.eventAt(index)))) return undefined
      const events = result.events, audit = createInboxAudit(hold.sessionId)
      const expectedTurn = hold.record.turn
      // Legacy `since` can have been synthesized with Date.now(), so even an
      // exact timestamp match cannot establish which persisted turn it meant.
      if (!Number.isSafeInteger(expectedTurn) || expectedTurn < 0) return undefined
      if (hold.record.since !== undefined) {
        if (!Number.isSafeInteger(hold.record.since) || hold.record.since < 0) return undefined
        const starts = events.filter(event => event.type === 'turn/start' && event.data?.turn === expectedTurn)
        if (starts.length !== 1 || (starts[0].time !== undefined && starts[0].time !== hold.record.since)) return undefined
      }
      for (const event of events) audit.observe(event)
      const folded = audit.finish(through)
      const matches = events.filter(event => event.type === 'user/message' && event.data?.source?.kind === 'bot'
        && event.data.source.exchangeId === trigger.exchangeId)
      if (matches.length !== 1) return undefined
      const event = matches[0], source = event.data.source
      const insertions = events.flatMap(entry => entry.type === 'agent/inbox/spliced'
        ? (entry.data?.inserted ?? []).filter(item => item?.id === event.data.id) : [])
      if (insertions.length !== 1 || !isDeepStrictEqual(insertions[0], event.data)) return undefined
      if (!['request', 'room'].includes(source.role) || source.reviewInspect === true
        || source.groupKickoff === true || source.reviewId !== undefined) return undefined
      if (Object.entries(trigger).some(([key, value]) => !isDeepStrictEqual(source[key], value))) return undefined
      const admissions = folded.records.filter(row => row.id === event.data.id)
      if (admissions.length !== 1 || admissions[0].status !== 'entered-in-log'
        || admissions[0].entered.length !== 1 || admissions[0].entered[0] !== event.seq) return undefined
      let openTurn, originalTurn, end, startSeq, endSeq, starts = 0
      for (const entry of events) {
        if (entry.type === 'turn/start') {
          if (openTurn !== undefined || !Number.isSafeInteger(entry.data?.turn)) return undefined
          openTurn = entry.data.turn
          if (openTurn === expectedTurn) startSeq = entry.seq
          if (originalTurn !== undefined && openTurn === originalTurn) return undefined
        } else if (entry.type === 'user/message' && entry.seq === event.seq) {
          if (openTurn === undefined) return undefined
          originalTurn = openTurn
          starts += 1
        } else if (entry.type === 'turn/end') {
          if (openTurn === undefined || entry.data?.turn !== openTurn) return undefined
          if (openTurn === originalTurn) { if (end !== undefined) return undefined; end = entry.data.reason; endSeq = entry.seq }
          openTurn = undefined
        }
      }
      const stopped = ['interrupted', 'error'].includes(end?.kind)
        || (end?.kind === 'aborted' && end.reason?.kind === 'disposed')
      const removals = folded.records.flatMap(row => row.removals
        .filter(removal => removal.seq > startSeq && removal.seq < endSeq).map(removal => ({ id:row.id, ...removal })))
      if (starts !== 1 || originalTurn !== expectedTurn || !stopped
        || events.filter(entry => entry.type === 'turn/start' && entry.data?.turn === originalTurn).length !== 1
        || events.filter(entry => entry.type === 'user/message' && entry.seq > startSeq && entry.seq < endSeq).length !== 1
        || removals.length !== 1 || removals[0].id !== event.data.id || removals[0].batchSize !== 1
        || !current()) return undefined
      return { complete:true, durability:'target-writer-v1', recoveryId, botId:hold.record.botId, sessionId:hold.sessionId,
        messageSeq:event.seq, turn:originalTurn,
        message:structuredClone({ id:event.data.id, role:'user', source:event.data.source, content:event.data.content }), isCurrent:current }
    } catch { return undefined } finally { await reader?.close().catch(() => {}) }
  }
  return async (scope, recoveryId) => {
    if (pending.has(recoveryId)) return undefined
    pending.add(recoveryId)
    const work = read(scope, recoveryId)
    void work.then(() => pending.delete(recoveryId), () => pending.delete(recoveryId))
    let timer
    try { return await Promise.race([work, new Promise(resolve => { timer = setTimeout(resolve, timeoutMs) })]) }
    finally { clearTimeout(timer) }
  }
}
