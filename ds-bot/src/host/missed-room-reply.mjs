import { isDeepStrictEqual } from 'node:util'
import { symbols } from '@deepseek-ai/cordis'
import { createInboxAudit } from './inbox-audit.js'

// Only a completely recorded, text-only final step can be published without
// running anything. Earlier inputs may have occupied the member before the
// group steered it; only a silent PASS can precede that group's final step.
const contextInputs = new Map([
  ['ds-bot-group-memory', 'snapshot'], ['runtime-context', 'snapshot'],
  ['time-context', 'snapshot'], ['skill-catalog', 'catalog'],
])
const roomSourceKeys = new Set(['kind', 'form', 'role', 'exchangeId', 'roomId', 'senderName'])
const holdKeys = new Set(['botId', 'roomId', 'since', 'turn', 'trigger', 'recoveryHold'])
const receiptKeys = ['roomId', 'botId', 'memberSessionId', 'turn', 'exchangeId', 'inputId', 'inputSeq', 'terminalSeq']

function finalText(data) {
  const message = data?.message
  if (message?.role !== 'assistant' || message.source?.kind !== 'model' || !Array.isArray(message.content)
    || message.content.some(part => !['text', 'thinking'].includes(part?.type))) return
  const text = message.content.filter(part => part.type === 'text')
  if (text.length !== 1 || typeof text[0].text !== 'string' || !text[0].text.trim()) return
  if (data.stream !== undefined) {
    if (!Array.isArray(data.stream)) return
    const finishes = data.stream.filter(event => event?.chunk?.type === 'finish')
    if (finishes.length !== 1 || finishes[0].chunk.reason?.kind !== 'stop' || data.stream.at(-1) !== finishes[0]) return
  }
  return text[0].text
}

export function missedRoomTerminal(events, record) {
  if (!record?.roomId || !record.botId || !Number.isSafeInteger(record.turn) || !Number.isSafeInteger(record.since)
    || Object.keys(record).some(key => !holdKeys.has(key))
    || !Array.isArray(events)
    || events.some((e, index) => e?.seq !== index)) return
  const starts = events.filter(e => e.type === 'turn/start' && e.data?.turn === record.turn)
  if (starts.length !== 1 || starts[0].time !== record.since) return
  const turn = events.slice(starts[0].seq + 1)
  const end = turn.at(-1)
  if (end?.type !== 'turn/end' || end.data?.turn !== record.turn || end.data.reason?.kind !== 'completed') return
  let step, answer, closed, inputs, lastStep = 0
  for (const event of turn.slice(0, -1)) {
    const data = event.data
    switch (event.type) {
      case 'agent/inbox/spliced':
      case 'session-log-deepseek/delivery-accepted': break
      case 'step/start':
        if ((step && (!closed || inputs.length !== 1 || inputs[0].data.source.kind !== 'user' || !/^\s*(?:\[PASS\]|PASS)[.!。！]?\s*$/i.test(answer)))
          || data?.turn !== record.turn || data.step !== lastStep + 1) return
        step = data.step; lastStep = step; answer = undefined; closed = false; inputs = []
        break
      case 'user/message':
        if (!step || closed || answer !== undefined || data?.role !== 'user' || !data.source) return
        if (!contextInputs.has(data.source.kind) || contextInputs.get(data.source.kind) !== data.source.form) inputs.push(event)
        break
      case 'assistant/message':
        if (!step || closed || answer !== undefined || data?.turn !== record.turn || data.step !== step) return
        answer = finalText(data)
        if (answer === undefined) return
        break
      case 'step/end':
        if (!step || closed || answer === undefined || data?.turn !== record.turn || data.step !== step) return
        closed = true
        break
      default: return
    }
  }
  if (!closed || inputs.length !== 1) return
  const input = inputs[0], source = input.data.source
  if (source.kind !== 'bot' || source.form !== 'relay' || source.role !== 'room' || source.roomId !== record.roomId
    || !source.exchangeId || !input.data.id || Object.keys(source).some(key => !roomSourceKeys.has(key))
    || input.data.content?.length !== 1 || input.data.content[0]?.type !== 'text') return
  if (record.trigger && (record.trigger.role !== 'room' || record.trigger.exchangeId !== source.exchangeId
    || record.trigger.roomId !== source.roomId || Object.entries(record.trigger).some(([key, value]) => source[key] !== value))) return
  const matches = m => m?.id === input.data.id || m?.source?.exchangeId === source.exchangeId
  const entered = events.filter(e => e.type === 'user/message' && matches(e.data))
  const inserted = events.flatMap(e => e.type === 'agent/inbox/spliced'
    ? (e.data?.inserted ?? []).filter(matches).map(message => ({ event:e, message })) : [])
  if (entered.length !== 1 || inserted.length !== 1 || inserted[0].event.seq >= input.seq
    || !isDeepStrictEqual(inserted[0].message, input.data)) return
  try {
    const audit = createInboxAudit(record.roomId)
    for (const e of events) audit.observe(e)
    const row = audit.finish(events.length).records.find(r => r.id === input.data.id)
    if (row?.status !== 'entered-in-log' || row.removals[0].batchSize !== 1) return
  } catch { return }
  return { roomId:record.roomId, botId:record.botId, turn:record.turn, exchangeId:source.exchangeId,
    inputSeq:input.seq, inputId:input.data.id, terminalSeq:end.seq, admittedAt:inserted[0].event.time, text:answer }
}

// Match the room's own persisted group_relay result to the ledger anchor.
// A native late post may already be in the inbox, even before a ledger row
// exists. Older posts have no final exchange key, so leave them for review.
export function relayRecorded(events, anchor, proof) {
  let resultSeq
  for (const e of events) {
    if (e.type === 'tool/result' && e.data?.message?.isError === false) {
      const call = events[e.sourceEventSeqs?.[0]]
      if (call?.type !== 'tool/call' || call.data?.name !== 'group_relay' || call.data.callId !== e.data.message.toolCallId) continue
      let body
      try { body = JSON.parse(e.data.message.content[0].text) } catch { continue }
      if (body?.anchor === anchor.id && body.from === anchor.from) {
        if (resultSeq !== undefined) return false
        resultSeq = call.seq
      }
    }
  }
  if (resultSeq === undefined) return false
  try {
    const audit = createInboxAudit(proof.roomId)
    for (const event of events) audit.observe(event)
    if (audit.finish(events.length).records.some(row => row.pending)) return false
  } catch { return false }
  return !events.some(e => e.seq >= resultSeq && (e.type === 'user/message' ? [e.data]
    : e.type === 'agent/inbox/spliced' ? e.data?.inserted ?? [] : [])
    .some(m => m?.source?.role === 'post' && m.source.senderSessionId === proof.botId))
}

export function sameReceipt(saved, proof) {
  return receiptKeys.every(key => saved?.[key] === proof[key])
}

// Bound the work per candidate. A truncated prefix cannot establish absence.
export async function readRoomReplyCut(ctx, sessionId) {
  const session = ctx.sessions?.get?.(sessionId), count = session?.seq
  const persistence = ctx.get?.('sessionPersistence')
  if (!persistence?.open || (typeof persistence.flushLiveSession !== 'function' && typeof ctx.sessions?.flush !== 'function') || session?.id !== sessionId
    || !Number.isSafeInteger(count) || count < 1 || count > 4096 || session.inheritedEventCount > 0) return
  const provider = persistence[symbols.original] ?? persistence
  const current = () => {
    const active = ctx.get('sessionPersistence')
    return (active?.[symbols.original] ?? active) === provider && ctx.sessions.get(sessionId) === session && session.seq === count
  }
  const signal = AbortSignal.timeout(5000)
  let reader
  try {
    if (typeof persistence.flushLiveSession === 'function') await persistence.flushLiveSession(sessionId)
    else await ctx.sessions.flush(session)
    reader = await persistence.open(sessionId, 'read', { signal })
    if (reader?.id !== sessionId || reader.inheritedEventCount !== session.inheritedEventCount) return
    const { events } = await reader.read(0, count, { signal })
    if (!signal.aborted && current() && events?.length === count
      && events.every((e, i) => e.seq === i && isDeepStrictEqual(e, session.eventAt(i)))) return { events, current }
  } finally { await reader?.close() }
}
