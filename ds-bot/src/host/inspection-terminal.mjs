import { isDeepStrictEqual } from 'node:util'
import { createInboxAudit } from './inbox-audit.js'
import { readSessionInbox } from './inbox-read.mjs'

// Rotations can add parts between the original administrator delivery and today.
// Inherited events belong to the parent and must not count as another delivery.
function reviewParts(room, attempt) {
  const admin = attempt.adminId, original = attempt.adminSessionId, current = room.sessions?.[admin]
  if (room.admin !== admin || !room.members.includes(admin) || !original || !current || !attempt.rootSessionId) return
  const historical = (room.segments?.[admin] ?? []).map(part => part.sessionId)
  const chain = [...historical, current], start = chain.indexOf(original)
  if (start < 0 || chain.some(id => typeof id !== 'string' || !id)
    || new Set([attempt.rootSessionId, ...chain]).size !== chain.length + 1) return
  return [attempt.rootSessionId, ...chain.slice(start)]
}

export function inspectionSourceMatches(source, room, attempt, root) {
  return source?.kind === 'bot' && source.form === 'relay' && source.reviewInspect === true
    && source.reviewId === attempt.id && source.roomId === room.id && source.role === (root ? 'goal' : 'room')
    && (!root || source.goalId === room.goal.id)
}

function completedTurn(events, start, end, input, root) {
  if (end.seq - start.seq > 512 || end.data?.reason?.kind !== 'completed') return false
  const calls = new Map()
  for (let i = start.seq + 1; i < end.seq; ++i) {
    const event = events[i], data = event.data
    if (data?.turn !== undefined && data.turn !== start.data.turn) return false
    if (event.type === 'agent/inbox/spliced' && (data.removedCount !== 1 || data.inserted?.length !== 0)) return false
    if (event.type === 'user/message' && i !== input.seq) {
      const source = data.source
      if (!(source?.form === 'snapshot' && (source.kind === 'time-context'
        || (!root && source.kind === 'bot' && source.role === 'continue')))) return false
    }
    if (event.type === 'tool/call') {
      if (i < input.seq || typeof data.callId !== 'string' || !data.callId || calls.has(data.callId)
        || (root && (calls.size || data.name !== 'group_relay'))) return false
      calls.set(data.callId, false)
    }
    if (event.type === 'tool/result') {
      const result = data.message
      if (result?.role !== 'tool' || calls.get(result.toolCallId) !== false || (root && result.isError !== false)) return false
      calls.set(result.toolCallId, true)
    }
  }
  return (!root || calls.size === 1) && [...calls.values()].every(Boolean)
}

function readPart(cut, room, attempt, side) {
  const count = cut.cursor + 1, first = cut.inheritedEventCount
  if (!Number.isSafeInteger(count) || count < 0 || count > 200_000 || !Number.isSafeInteger(first) || first < 0 || first > count
    || (cut.source === 'prepared' && cut.persistedEventCount !== count)) return
  const events = cut.events
  if (!Array.isArray(events) || events.length !== count) return
  const audit = createInboxAudit(cut.header.id), jobs = new Set()
  let start, input, admission, coordinates, originalStart
  for (let i = 0; i < count; ++i) {
    const event = events[i]
    audit.observe(event)
    if (i < first) continue
    const data = event.data
    if (event.type === 'turn/start') {
      if (start || !Number.isSafeInteger(data?.turn)) return
      start = event
    } else if (event.type === 'turn/end') {
      if (!start || start.data.turn !== data?.turn) return
      if (input && !coordinates) {
        if (!completedTurn(events, start, event, input, side === 'root')) return
        originalStart = start.seq
        coordinates = { sessionId: cut.header.id, seq: input.seq, end: i, turn: data.turn }
      }
      start = undefined
    } else if (event.type === 'user/message' && data?.source?.reviewId === attempt.id) {
      if (!start || input || !side || !inspectionSourceMatches(data.source, room, attempt, side === 'root')
        || !admission || typeof data.id !== 'string' || !data.id || !isDeepStrictEqual(admission, data)) return
      input = event
    } else if (event.type === 'agent/inbox/spliced') {
      if (!Array.isArray(data?.inserted)) return
      for (const message of data.inserted) {
        if (message?.source?.reviewId !== attempt.id) continue
        if (admission || !side) return
        admission = message
      }
    } else if (event.type === 'job/registered') {
      if (typeof data?.jobId !== 'string') return
      jobs.add(data.jobId)
    } else if (event.type === 'job/settled') jobs.delete(data?.jobId)
  }
  if (start || jobs.size || (side && !coordinates)) return
  const { records } = audit.finish(count)
  if (records.some(record => record.pending)) return
  if (side) {
    const delivered = records.find(record => record.id === input.data.id)
    if (delivered?.status !== 'entered-in-log' || delivered.entered[0] !== input.seq
      || delivered.removals[0].seq <= originalStart || delivered.removals[0].batchSize !== 1) return
  }
  return { coordinates }
}

// Only for an overdue fenced inspection. Read its root and original/later
// administrator parts without opening an Agent or draining its queue.
export async function completedInspection(rt, room, attempt) {
  const ids = reviewParts(room, attempt), ctx = rt.ctx
  if (!ids || ids.length > 32) return
  const signal = AbortSignal.timeout(30_000), unchanged = [], stored = [], result = {}
  try {
    const query = ctx.get?.('sessionQuery') ?? ctx.sessionQuery, sessions = ctx.sessions
    if (typeof query?.observeSession !== 'function' || typeof sessions?.get !== 'function') return
    for (const [i, id] of ids.entries()) {
      const cut = await query.observeSession(id, { signal, projectionMode: 'none' })
      try {
        const side = i === 0 ? 'root' : i === 1 ? 'admin' : undefined
        if (cut.header?.id !== id || !['live', 'prepared'].includes(cut.source)) return
        const part = readPart(cut, room, attempt, side)
        if (!part) return
        if (side) result[side] = part.coordinates
        const live = sessions.get(id), count = cut.cursor + 1
        if (cut.source === 'live' ? live?.id !== id || live.seq !== count : live !== undefined) return
        if (!live) {
          if (typeof cut.revision !== 'string') return
          stored.push({ id, revision: cut.revision })
        }
        unchanged.push(() => sessions.get(id) === live && (!live || live.seq === count)
          && rt.live.get(id)?.turn === undefined && !rt.hasSubagents?.(id) && !rt.waitsForApproval?.(id))
        const inbox = await readSessionInbox(ctx, id, signal)
        if (inbox.status !== 'ready' || inbox.nextStep.length || inbox.nextTurn.length) return
      } finally { cut[Symbol.dispose]() }
    }
    if (stored.length) {
      const persistence = ctx.get?.('sessionPersistence') ?? ctx.sessionPersistence
      const revisions = await Promise.all(stored.map(({ id }) => persistence.stat(id, { signal })))
      if (revisions.some((snapshot, i) => snapshot?.header?.id !== stored[i].id || snapshot.revision !== stored[i].revision)) return
    }
    const isCurrent = () => !signal.aborted && isDeepStrictEqual(reviewParts(room, attempt), ids) && unchanged.every(check => check())
    if (isCurrent()) return { ...result, isCurrent }
  } catch { /* An unreadable or changing cut cannot release an inspection. */ }
}
