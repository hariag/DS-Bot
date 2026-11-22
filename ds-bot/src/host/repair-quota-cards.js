import { HISTORY_TIMEOUT_MS } from './constants.js'
import { isForbiddenQuota } from '../shared/provider-quota.js'

// Anchor subsequent pages to the same snapshot if newer turns arrive during the read.
async function quotaTurnInHistory(controller, read, sessionId, turn) {
  const signal = AbortSignal.timeout(HISTORY_TIMEOUT_MS)
  const address = { kind: 'session', sessionId }
  let throughSeq, beforeSeq, inspected = 0
  for (let pageNumber = 0; pageNumber < 4; pageNumber++) {
    const page = await read.call(controller, { address, maxMessages: 12,
      ...(beforeSeq === undefined ? {} : { throughSeq, beforeSeq }) }, signal)
    if (!Number.isSafeInteger(page?.cursor) || page.cursor < 0 || !Array.isArray(page.records)
      || page.records.length === 0 || (throughSeq !== undefined && page.cursor !== throughSeq)) return false
    throughSeq = page.cursor
    let expected = (beforeSeq ?? throughSeq + 1) - 1
    for (let i = page.records.length - 1; i >= 0; i--) {
      const record = page.records[i]
      if (record?.type !== 'event' || record.event?.seq !== expected || inspected >= 200) return false
      inspected++
      expected--
      const { type, data } = record.event
      if (type === 'turn/end' && data?.turn === turn) {
        return data.reason?.kind === 'error' && isForbiddenQuota(data.reason.error)
      }
    }
    if (!page.hasMore || expected < 0 || inspected >= 200) return false
    beforeSeq = expected + 1
  }
  return false
}

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
      const matched = await quotaTurnInHistory(controller, read, sessionId, saved.turn).catch(() => false)
      if (!matched) continue
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
