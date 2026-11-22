import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { symbols } from '@deepseek-ai/cordis'

// JSONL persists an absent top-level delegationDepth as zero. All other
// metadata remains part of the exact identity comparison.
const comparableHeader = header => header && typeof header === 'object'
  ? { ...header, delegationDepth:header.delegationDepth === undefined ? 0 : header.delegationDepth } : header

// This is only a fixed-prefix observation, not a durable result receipt. The
// caller must persist the result atomically in the authorized operation journal
// and re-authorize every read before presenting it to a user.
export async function captureGuardedRedoResult({ ctx, session, input, admissionId, turn, isCurrent }) {
  let reader
  try {
    if (!ctx || !session || typeof session.id !== 'string' || typeof session.eventAt !== 'function'
      || typeof isCurrent !== 'function' || typeof admissionId !== 'string' || !admissionId
      || !input || typeof input.id !== 'string' || !input.id || input.role !== 'user'
      || input.source?.kind !== 'ds-bot-user-redo' || Object.keys(input.source).some(key => key !== 'kind')
      || !turn || !Number.isSafeInteger(turn.turn) || turn.turn < 0
      || !Number.isSafeInteger(turn.turnStartSeq) || turn.turnStartSeq < 0) return undefined
    const sessions = ctx.sessions, persistence = ctx.sessionPersistence
    // Cordis returns a new use-site proxy on each service access. Compare the
    // underlying provider identity, not the ephemeral proxy object.
    const providerOf = service => service?.[symbols.original] ?? service
    const sessionsProvider = providerOf(sessions), persistenceProvider = providerOf(persistence)
    if (typeof sessions?.get !== 'function' || typeof persistence?.flushLiveSession !== 'function'
      || typeof persistence?.open !== 'function') return undefined
    const count = session.seq
    // Bound both work and memory. Larger histories need an independently
    // verified streaming implementation; a partial prefix is never accepted.
    if (!Number.isSafeInteger(count) || count < 1 || count > 100_000) return undefined
    const current = () => providerOf(ctx.sessions) === sessionsProvider && providerOf(ctx.sessionPersistence) === persistenceProvider
      && sessions.get(session.id) === session && session.seq === count && isCurrent() === true
    if (!current()) return undefined
    await persistence.flushLiveSession(session.id)
    if (!current()) return undefined
    reader = await persistence.open(session.id, 'read')
    if (!current() || reader?.id !== session.id || !isDeepStrictEqual(comparableHeader(reader.header), comparableHeader(session.header))
      || reader.inheritedEventCount !== session.inheritedEventCount) return undefined
    const { events } = await reader.read(0, count)
    if (!current() || !Array.isArray(events) || events.length !== count) return undefined
    for (let index = 0; index < count; index++) {
      if (events[index]?.seq !== index || !isDeepStrictEqual(events[index], session.eventAt(index))) return undefined
    }
    const start = events[turn.turnStartSeq]
    if (start?.type !== 'turn/start' || start.data?.turn !== turn.turn) return undefined
    const queues = { 'next-step':[], 'next-turn':[] }
    let holds = 0, releases = 0, insertions = 0, removals = 0, selected = 0, end, lastAssistant
    let holdSeq, releaseSeq, insertSeq, removalSeq, selectedSeq
    for (const event of events) {
      if (event.type === 'agent/admission/hold' && (event.data?.messageId === input.id || event.data?.admissionId === admissionId)) {
        if (event.data?.messageId !== input.id || event.data?.admissionId !== admissionId) return undefined
        holds++; holdSeq = event.seq
      }
      if (event.type === 'agent/admission/release' && (event.data?.messageId === input.id || event.data?.admissionId === admissionId)) {
        if (event.data?.messageId !== input.id || event.data?.admissionId !== admissionId) return undefined
        releases++; releaseSeq = event.seq
      }
      if (event.type === 'agent/admission/cancel' && event.data?.messageId === input.id) return undefined
      if (event.type === 'agent/inbox/spliced') {
        const { target, start:at, removedCount = 0, inserted } = event.data ?? {}
        const queue = queues[target]
        if (!queue || !Number.isSafeInteger(at) || at < 0 || at > queue.length || !Number.isSafeInteger(removedCount)
          || removedCount < 0 || at + removedCount > queue.length || !Array.isArray(inserted)) return undefined
        const removed = queue.slice(at, at + removedCount)
        if (inserted.some(message => message?.id === input.id)) {
          if (target !== 'next-turn' || inserted.filter(message => message?.id === input.id).length !== 1
            || !isDeepStrictEqual(inserted.find(message => message?.id === input.id), input)) return undefined
          insertions++; insertSeq = event.seq
        }
        if (removed.some(message => message?.id === input.id)) {
          if (target !== 'next-turn' || removed.length !== 1 || event.seq <= turn.turnStartSeq || end !== undefined) return undefined
          removals++; removalSeq = event.seq
        }
        queue.splice(at, removedCount, ...inserted)
      }
      if (event.type === 'user/message' && event.data?.id === input.id) {
        if (event.seq <= turn.turnStartSeq || end !== undefined || !isDeepStrictEqual(event.data, input)) return undefined
        selected++; selectedSeq = event.seq
      } else if (event.type === 'user/message' && event.seq > turn.turnStartSeq && end === undefined) {
        // Do not attribute a mixed or unverified producer batch to this redo.
        return undefined
      }
      if (event.seq > turn.turnStartSeq && end === undefined && event.type === 'turn/start') return undefined
      if (event.seq > turn.turnStartSeq && end === undefined && event.type === 'turn/end' && event.data?.turn !== turn.turn) return undefined
      if (event.seq > turn.turnStartSeq && end === undefined && event.type === 'assistant/message') {
        if (event.data?.turn !== turn.turn) return undefined
        lastAssistant = event
      }
      if (event.seq > turn.turnStartSeq && end === undefined && event.type === 'turn/end' && event.data?.turn === turn.turn) end = event
    }
    if (holds !== 1 || releases !== 1 || insertions !== 1 || removals !== 1 || selected !== 1
      || !(holdSeq < insertSeq && insertSeq < releaseSeq && releaseSeq < turn.turnStartSeq
        && turn.turnStartSeq < removalSeq && removalSeq < selectedSeq)
      || !end || end.data?.reason?.kind !== 'completed' || !lastAssistant || lastAssistant.seq <= selectedSeq) return undefined
    if (lastAssistant.data?.interrupted === true || lastAssistant.data?.message?.role !== 'assistant'
      || lastAssistant.data?.message?.source?.kind !== 'model') return undefined
    const content = lastAssistant.data?.message?.content
    if (!Array.isArray(content) || content.some(part => part?.type !== 'text' || typeof part.text !== 'string')) return undefined
    const text = content.map(part => part.text).join('')
    if (!text.trim() || Buffer.byteLength(text, 'utf8') > 65_536 || !current()) return undefined
    await reader.close(); reader = undefined
    if (!current()) return undefined
    const digest = createHash('sha256').update(text, 'utf8').digest('hex')
    const proofCurrent = () => { try { return current() } catch { return false } }
    return Object.freeze({ durability:'target-writer-v1', sessionId:session.id,
      turn:Object.freeze({ turn:turn.turn, turnStartSeq:turn.turnStartSeq }),
      endSeq:end.seq, throughSeq:count - 1, messageId:input.id, admissionId,
      resultDigest:digest, resultRef:Object.freeze({ kind:'session-events', sessionId:session.id,
        firstSeq:lastAssistant.seq, lastSeq:lastAssistant.seq }), isCurrent:proofCurrent, text })
  } catch { return undefined } finally { if (reader) { try { await reader.close() } catch {} } }
}
