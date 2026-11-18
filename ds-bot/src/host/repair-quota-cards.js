import { HISTORY_TIMEOUT_MS } from './constants.js'
import { isForbiddenQuota } from '../shared/provider-quota.js'

// Older releases removed the upstream detail when storing AUTH. Only the owning
// session's recorded turn can distinguish a quota rejection from a rejected key.
export async function repairQuotaCards(rt) {
  await rt.load()
  const controller = rt.ctx.sessionController
  const read = controller?.events ?? controller?.page
  if (typeof read !== 'function' || rt.readOnly() !== undefined) return
  let changed = false
  for (const bot of Object.values(rt.state.bots)) {
    for (const [sessionId, saved] of Object.entries(bot.failures ?? {})) {
      if (saved?.code !== 'AUTH' || !Number.isSafeInteger(saved.turn) || rt.selfOf(sessionId) !== bot.id) continue
      // Only the recent page is needed for a current repair card. An archived or
      // unavailable turn keeps its original diagnosis until there is evidence.
      const page = await read.call(controller, { address: { kind: 'session', sessionId }, maxMessages: 12 },
        AbortSignal.timeout(HISTORY_TIMEOUT_MS)).catch(() => undefined)
      const end = page?.records?.findLast(row => row.type === 'event' && row.event?.type === 'turn/end'
        && row.event.data?.turn === saved.turn)?.event
      if (end?.data?.reason?.kind !== 'error' || !isForbiddenQuota(end.data.reason.error)) continue
      if (rt.stopping || rt.readOnly() !== undefined) return
      if (rt.botOf(bot.id) !== bot || bot.failures?.[sessionId] !== saved) continue
      bot.failures[sessionId] = { ...saved, code: 'QUOTA', status: 403, message: '' }
      const block = bot.blocked
      if (block?.code === 'AUTH' && block.provider === saved.provider && (block.sessionId === sessionId && block.turn === saved.turn
        || (block.sessionId === undefined && block.turn === undefined && saved.requestId && block.requestId === saved.requestId))) {
        bot.blocked = { ...block, code: 'QUOTA', status: 403, sessionId, turn: saved.turn }
      }
      changed = true
    }
  }
  if (changed && !rt.stopping && rt.readOnly() === undefined) await rt.save({ required: true })
}
