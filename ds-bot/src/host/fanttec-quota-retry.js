// Retry the failed model request inside the current DSH step. No Bot message, turn
// or tool is submitted again. The session journal owns the budget across reloads.
import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { isForbiddenQuota } from '../shared/provider-quota.js'

const PROVIDER = 'fanttec'
const POLICY_KEY = 'ds-bot/fanttec/insufficient-user-quota/v1'
const MAX_RETRIES = 10
const MAX_HISTORY_PAGES = 32
const MAX_HISTORY_EVENTS = 1024
const HISTORY_TIMEOUT_MS = 5000

function unusedAttempt(stream, failure) {
  if (!Array.isArray(stream) || !stream.length) return false
  const end = stream.at(-1)
  if (end?.type !== 'chunk' || end.chunk?.type !== 'finish' || end.chunk.reason?.kind !== 'error') return false
  const terminal = end.chunk.reason.failure
  if (failure && (terminal?.code !== failure.code || terminal.message !== failure.message)) return false
  return stream.slice(0, -1).every(record => {
    const chunk = record?.chunk
    return record?.type === 'chunk' && chunk?.type === 'usage'
      && chunk.usage?.outputTokens === 0 && Object.values(chunk.usage).every(value => value === 0)
  })
}

async function retryBudget(controller, payload, throughSeq, signal) {
  const { agent, turn, step, failure } = payload
  const address = { kind: 'session', sessionId: agent.id }
  let expected = throughSeq
  let latest
  let count = 0
  const read = (controller.events ?? controller.page).bind(controller)
  for (let pages = 0; pages < MAX_HISTORY_PAGES && expected >= 0; pages++) {
    signal.throwIfAborted()
    const page = await read({ address, throughSeq, beforeSeq: expected + 1, maxMessages: 1 }, signal)
    if (!page.records?.length) return
    for (let i = page.records.length - 1; i >= 0; i--) {
      const event = page.records[i].event
      if (event?.seq !== expected || throughSeq - expected >= MAX_HISTORY_EVENTS) return
      const { type, data } = event
      const current = expected === throughSeq
      if (current && type !== 'assistant/attempt') return
      if (type === 'assistant/attempt' && (data.turn !== turn || data.step !== step
        || !unusedAttempt(data.stream, current ? failure : undefined))) return
      expected--
      if (type === 'step/start') {
        if (data.turn !== turn || data.step !== step || (latest && latest.retry !== count)) return
        return { retry: count + 1, retryId: latest?.retryId ?? randomUUID() }
      }
      if (type === 'turn/start' || type === 'turn/end' || type === 'step/end' || type === 'assistant/message' || type === 'tool/call' || type === 'tool/result') return
      if (type !== 'llm/retry' || data.policyKey !== POLICY_KEY) continue
      if (data.provider !== PROVIDER || data.turn !== turn || data.step !== step || typeof data.retryId !== 'string') return
      latest ??= data
      if (data.retryId !== latest.retryId || data.retry !== latest.retry - count) return
      count++
      if (count >= MAX_RETRIES) return
    }
    if (!page.hasMore) return
  }
}

export function install(rt, { delay = sleep } = {}) {
  const { ctx } = rt
  const lifetime = new AbortController()
  ctx.effect(() => () => lifetime.abort(), 'ds-bot: cancel Fanttec quota retries')
  ctx.on('agent/request-error', async (payload, next) => {
    const { provider, failure, agent, turn, step, signal } = payload
    if (provider !== PROVIDER || !isForbiddenQuota(failure) || !rt.isBotSession(agent.id)) return next()
    if (rt.readOnly?.() !== undefined || signal.aborted || lifetime.signal.aborted) return
    const active = AbortSignal.any([signal, lifetime.signal])
    const throughSeq = agent.session.seq - 1
    if (!Number.isSafeInteger(throughSeq) || throughSeq < 0) return
    try {
      const readSignal = AbortSignal.any([active, AbortSignal.timeout(HISTORY_TIMEOUT_MS)])
      const budget = await retryBudget(ctx.sessionController, payload, throughSeq, readSignal)
      // Another handler or attempt may have advanced the journal during the read.
      if (!budget || readSignal.aborted || rt.readOnly?.() !== undefined || agent.session.seq !== throughSeq + 1) return
      const { retry, retryId } = budget
      const delayMs = 1000 * 2 ** (retry - 1)
      agent.session.append('llm/retry', { retryId, turn, step, provider, mode: 'normal', policyKey: POLICY_KEY,
        retry, maxRetries: MAX_RETRIES, delayMs, failure: { code: 'QUOTA', status: 403, message: '' } })
      await delay(delayMs, undefined, { signal: active })
      if (active.aborted || rt.readOnly?.() !== undefined) return
      agent.session.append('llm/retry-started', { retryId, turn, step, retry })
      return { kind: 'retry' }
    } catch {
      if (!active.aborted) rt.warn?.('ds-bot: could not confirm or record the Fanttec quota retry')
    }
  }, { prepend: true })
}
