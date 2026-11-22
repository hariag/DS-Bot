// Offline, metadata-only fold of one complete Session log. It never sends or
// changes messages and cannot decide whether an external effect happened.

const bad = message => Object.assign(new Error(message), { code: 'inbox-audit/incomplete' })
const identity = value => typeof value === 'string' && value !== ''

export function createInboxAudit(sessionId) {
  if (!identity(sessionId)) throw new TypeError('sessionId must be a nonempty string')
  const queues = { 'next-step': [], 'next-turn': [] }
  const records = new Map()
  let nextSeq = 0
  let untrackedAdmissions = 0
  let closed = false
  let failed = false

  const observe = event => {
    if (closed || failed) throw bad('The audit is closed or invalid')
    try {
      if (!event || !Number.isSafeInteger(event.seq) || event.seq !== nextSeq || typeof event.type !== 'string') {
        throw bad(`Expected contiguous Session event ${nextSeq}`)
      }
      const data = event.data
      if (event.type === 'agent/inbox/spliced') {
        if (!data || !Object.hasOwn(queues, data.target) || !Number.isSafeInteger(data.start) || data.start < 0
          || !Number.isSafeInteger(data.removedCount ?? 0) || (data.removedCount ?? 0) < 0
          || !Array.isArray(data.inserted)) throw bad(`Invalid inbox splice at ${nextSeq}`)
        const queue = queues[data.target]
        const count = data.removedCount ?? 0
        if (data.start > queue.length || data.start + count > queue.length) throw bad(`Inbox splice is out of bounds at ${nextSeq}`)
        const inserted = data.inserted.map(message => {
          if (!message || !identity(message.id)) throw bad(`Inbox message has no stable id at ${nextSeq}`)
          return message.id
        })
        const replacement = queue.toSpliced(data.start, count, ...inserted)
        const other = queues[data.target === 'next-step' ? 'next-turn' : 'next-step']
        if (new Set([...replacement, ...other]).size !== replacement.length + other.length) throw bad(`Duplicate pending message at ${nextSeq}`)
        const removed = queue.slice(data.start, data.start + count)
        queues[data.target] = replacement
        for (const [index, id] of removed.entries()) {
          const record = records.get(id)
          if (record === undefined) throw bad(`Removed message has no origin at ${nextSeq}`)
          record.removals.push({ seq: event.seq, index, batchSize: removed.length, ...(data.outcome === undefined ? {} : { outcome: String(data.outcome) }) })
        }
        data.inserted.forEach((message, index) => {
          let record = records.get(message.id)
          if (record === undefined) {
            record = { id: message.id, origin: { seq: event.seq, index }, inserts: [], removals: [], entered: [], exchangeIds: new Set() }
            records.set(message.id, record)
          }
          record.inserts.push({ seq: event.seq, index, target: data.target })
          const exchangeId = message.source?.exchangeId
          if (identity(exchangeId)) record.exchangeIds.add(exchangeId)
        })
      } else if (event.type === 'user/message') {
        const record = identity(data?.id) ? records.get(data.id) : undefined
        if (record === undefined) untrackedAdmissions += 1
        else {
          record.entered.push(event.seq)
          const exchangeId = data.source?.exchangeId
          if (identity(exchangeId)) record.exchangeIds.add(exchangeId)
        }
      }
      nextSeq += 1
    } catch (error) {
      failed = true
      throw error
    }
  }

  const finish = expectedEndExclusive => {
    if (closed || failed) throw bad('The audit is closed or invalid')
    if (!Number.isSafeInteger(expectedEndExclusive) || expectedEndExclusive < 0 || expectedEndExclusive !== nextSeq) {
      failed = true
      throw bad('The Session event coverage does not match the supplied boundary')
    }
    closed = true
    const positions = new Map()
    for (const [target, queue] of Object.entries(queues)) queue.forEach((id, index) => positions.set(id, { target, index }))
    return {
      sessionId, fromSeq: 0, endExclusive: nextSeq, untrackedAdmissions,
      records: [...records.values()].map(record => {
        const pending = positions.get(record.id)
        // Reused ids, cancellation, duplicate admissions and conflicting exchanges
        // make correspondence ambiguous; never infer delivery from those histories.
        const enteredUnambiguously = record.inserts.length === 1 && record.removals.length === 1
          && record.removals[0].outcome === undefined && record.entered.length === 1
          && record.entered[0] > record.removals[0].seq && record.exchangeIds.size <= 1
        return {
          id: record.id, origin: record.origin, inserts: record.inserts, removals: record.removals,
          entered: record.entered, exchangeIds: [...record.exchangeIds],
          status: pending !== undefined ? 'pending-in-log' : enteredUnambiguously ? 'entered-in-log' : 'uncertain',
          ...(pending === undefined ? {} : { pending }),
        }
      }),
    }
  }
  return { observe, finish }
}
