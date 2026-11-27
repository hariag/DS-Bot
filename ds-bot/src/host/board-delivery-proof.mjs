import { symbols } from '@deepseek-ai/cordis'
import { isDeepStrictEqual } from 'node:util'
import { createInboxAudit } from './inbox-audit.js'

export const heldDeliveryNotStopped = 'The original delivery could not be shown to have stopped. The card was not changed.'
const providerOf = service => service?.[symbols.original] ?? service
const maxEvents = 50_000
const maxBytes = 96 * 1024 * 1024
const proofTimeoutMs = 90_000

export function closedInput(events, intent) {
  const audit = createInboxAudit(intent.targetSessionId)
  let turn, inputTurn, inputSeq, endSeq
  for (const event of events) {
    audit.observe(event)
    switch (event.type) {
      case 'turn/start':
        if (turn !== undefined || !Number.isSafeInteger(event.data?.turn)) return
        turn = event.data.turn
        break
      case 'user/message':
        if (event.data?.id !== intent.messageId) break
        if (inputSeq !== undefined || turn === undefined || !isDeepStrictEqual(event.data, intent.payload)) return
        inputTurn = turn
        inputSeq = event.seq
        break
      case 'turn/end':
        if (turn === undefined || event.data?.turn !== turn) return
        if (turn === inputTurn) {
          if (endSeq !== undefined || !['completed','aborted','error','blocked','max-tokens'].includes(event.data?.reason?.kind)) return
          endSeq = event.seq
        }
        turn = undefined
        break
      default:
        break
    }
  }
  const input = audit.finish(events.length).records.find(item => item.id === intent.messageId)
  if (turn === undefined && endSeq !== undefined && input?.status === 'entered-in-log' && input.entered[0] === inputSeq) return { inputSeq, endSeq }
}

export function createHeldDeliveryProof(rt) {
  const { ctx } = rt
  const persistenceOf = () => ctx.get?.('sessionPersistence') ?? ctx.sessionPersistence
  const archived = sid => ctx.workspaceRegistry?.archivedSessionIds?.includes(sid) === true
  const available = sid => archived(sid) && typeof ctx.sessions?.get === 'function' && ctx.sessions.get(sid) === undefined
    && rt.live?.get(sid)?.turn === undefined
  let inspecting = false
  return { available, async inspect(intent, commit) {
    const sid = intent.targetSessionId
    const persistence = persistenceOf(), provider = providerOf(persistence)
    const sessions = providerOf(ctx.sessions)
    if (inspecting) throw Object.assign(new Error('A delivery check is in progress. Check the card again shortly.'), { code:'bot/refused' })
    if (!available(sid) || typeof persistence?.stat !== 'function' || typeof persistence?.open !== 'function'
      || typeof ctx.waterfall !== 'function') return
    inspecting = true
    let handle, evidence
    const signal = AbortSignal.timeout(proofTimeoutMs)
    const current = () => !signal.aborted && !rt.stopping && available(sid)
      && providerOf(ctx.sessions) === sessions && providerOf(persistenceOf()) === provider
    const idle = async () => {
      const activity = await ctx.waterfall('workspace/session-activity', { sessionId:sid }, async () => [])
      return Array.isArray(activity) && !activity.length
    }
    try {
      try {
        if (!await idle()) return
        const before = await persistence.stat(sid, { signal })
        if (!current() || before?.header?.id !== sid || before.formatStatus !== 'current' || before.revision === undefined
          || !Number.isSafeInteger(before.sizeBytes) || before.sizeBytes < 1 || before.sizeBytes > maxBytes) return
        // Keep exclusive storage ownership through the synchronous board commit. No DSH event is appended.
        handle = await persistence.open(sid, 'write', { signal })
        if (!current() || handle?.id !== sid || handle.access !== 'write' || handle.inheritedEventCount !== 0
          || !isDeepStrictEqual(handle.header, before.header)) return
        const { events } = await handle.read(0, maxEvents + 1, { signal })
        if (!Array.isArray(events) || !events.length || events.length > maxEvents
          || (before.eventCount !== undefined && before.eventCount !== events.length)) return
        const match = closedInput(events, intent)
        const after = match && await persistence.stat(sid, { signal })
        if (!match || !isDeepStrictEqual(before, after) || !await idle()) return
        evidence = { sessionId:sid, ...match }
      } catch { return }
      if (current()) return commit(evidence, current)
    } finally {
      await handle?.close().catch(() => {})
      inspecting = false
      if (signal.aborted) rt.warn?.('ds-bot: archived task delivery proof exceeded %d ms', proofTimeoutMs)
    }
  } }
}
