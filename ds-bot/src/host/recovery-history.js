// Read one exact Session history before deciding what a restart may have done.
// Page results are accepted only if every event through one fixed cursor is
// present in order. Missing, truncated, malformed or timed-out reads are unknown.
export async function readRecoveryHistory(controller, sessionId, signal, options = {}) {
  if (typeof controller?.inspect === 'function') {
    try {
      const seen = await controller.inspect(sessionId, signal)
      return Array.isArray(seen?.events) ? seen.events : undefined
    } catch { return undefined }
  }
  const pageHistory = typeof controller?.events === 'function' ? controller.events.bind(controller)
    : typeof controller?.page === 'function' ? controller.page.bind(controller) : undefined
  if (pageHistory === undefined) return undefined
  const maxEvents = options.maxEvents ?? 200_000
  const maxPages = options.maxPages ?? 1_000
  const pageSize = options.pageSize ?? 200
  const pages = []
  let cursor, before, total = 0
  try {
    for (let count = 0; count < maxPages; count += 1) {
      signal?.throwIfAborted?.()
      const request = { address: { kind: 'session', sessionId }, maxMessages: pageSize,
        ...(cursor === undefined ? {} : { throughSeq: cursor }),
        ...(before === undefined ? {} : { beforeSeq: before }) }
      const page = await pageHistory(request, signal)
      if (!page || !Number.isSafeInteger(page.cursor) || page.cursor < -1 || !Array.isArray(page.records) || typeof page.hasMore !== 'boolean') return undefined
      if (cursor === undefined) cursor = page.cursor
      else if (page.cursor !== cursor) return undefined
      const events = page.records.map(record => record?.type === 'event' ? record.event : undefined)
      const end = before ?? cursor + 1
      if (events.length === 0) return end === 0 && !page.hasMore && total === 0 ? [] : undefined
      const first = events[0]?.seq
      if (!Number.isSafeInteger(first) || first < 0 || first + events.length !== end) return undefined
      if (events.some((event, index) => !event || event.seq !== first + index || typeof event.type !== 'string')) return undefined
      total += events.length
      if (total > maxEvents || page.hasMore !== (first > 0)) return undefined
      pages.unshift(events)
      if (!page.hasMore) return pages.flat()
      before = first
    }
  } catch { return undefined }
  return undefined
}

// A matching message anywhere in the journal is evidence of possible prior
// admission, even when it is no longer in the live inbox.
export function historyMentionsSource(events, field, id) {
  return events.some(event => {
    if (event.type === 'user/message' && event.data?.source?.[field] === id) return true
    if (event.type !== 'agent/inbox/spliced' || !Array.isArray(event.data?.inserted)) return false
    return event.data.inserted.some(message => message?.source?.[field] === id)
  })
}

// A controller page is not a durability barrier. Obtain a fixed prefix only
// from the exact live writer and verify its entire sequence before using a reply.
export async function readDurableReply(ctx, sessionId, workId, botId, sourceKind, signal) {
  let handle
  try {
    const store = ctx?.sessions
    // Optional Cordis services must be queried, not accessed as uninjected properties.
    const persistence = typeof ctx?.get === 'function' ? ctx.get('sessionPersistence') : ctx?.sessionPersistence
    if (typeof store?.get !== 'function' || typeof persistence?.flushLiveSession !== 'function' || typeof persistence?.open !== 'function') return undefined
    const session = store.get(sessionId)
    const through = session?.seq
    if (!session || typeof session.eventAt !== 'function' || !Number.isSafeInteger(through) || through <= 0 || through > 200_000) return undefined
    signal?.throwIfAborted?.()
    await persistence.flushLiveSession(sessionId)
    signal?.throwIfAborted?.()
    if (store.get(sessionId) !== session || session.seq !== through) return undefined
    handle = await persistence.open(sessionId, 'read', { signal })
    const read = await handle.read(0, through, { signal })
    signal?.throwIfAborted?.()
    if (store.get(sessionId) !== session || session.seq !== through || !Array.isArray(read?.events) || read.events.length !== through) return undefined
    if (read.events.some((event, index) => event?.seq !== index || typeof event.type !== 'string')) return undefined
    const replies = read.events.filter(event => event.type === 'user/message' && event.data?.source?.replyTo === workId)
    if (replies.length !== 1 || JSON.stringify(session.eventAt(replies[0].seq)) !== JSON.stringify(replies[0])) return undefined
    const { source, content } = replies[0].data ?? {}
    if (source?.kind !== sourceKind || source?.role !== 'reply' || source?.senderSessionId !== botId
      || !Array.isArray(content) || content.length === 0
      || content.some(block => block?.type !== 'text' || typeof block.text !== 'string')) return undefined
    const text = content.map(block => block.text).join('\n').trim()
    return text === '' ? undefined : text
  } catch { return undefined } finally { await handle?.close().catch(() => {}) }
}

// A received answer may reconcile inline child results only when the exact
// rendered handoff contains each complete result, in order. Never infer that
// a truncated, missing, file-backed or failed result was handed over.
export function replyContainsInlineResults(reply, results, botName) {
  if (typeof reply !== 'string' || !Array.isArray(results) || typeof botName !== 'string' || botName === '') return false
  if (results.length === 0) return true
  const marker = `[Handed back to ${botName} for this work]`
  let at = reply.indexOf(marker)
  if (at < 0) return false
  at += marker.length
  for (const result of results) {
    if (!result || typeof result.name !== 'string' || result.name === ''
      || typeof result.text !== 'string' || result.text === ''
      || result.failed === true || result.length !== undefined || result.file !== undefined) return false
    const piece = `${result.name}:\n${result.text}`
    const found = reply.indexOf(piece, at)
    if (found < 0) return false
    at = found + piece.length
  }
  return true
}

// This is an observation of a session turn, not proof that its work finished.
// Only an exact, contiguous history with one matching message and turn qualifies.
export function observedOutputLimit(events, exchangeId, turnId, role) {
  if (!Array.isArray(events) || typeof exchangeId !== 'string' || exchangeId === '' || typeof role !== 'string' || role === '' || !Number.isSafeInteger(turnId) || turnId < 0) return false
  let current, starts = 0, matches = 0, inTarget = 0, ended = false
  for (let i = 0; i < events.length; i += 1) {
    const event = events[i]
    if (!event || event.seq !== i || typeof event.type !== 'string') return false
    if (event.type === 'turn/start') {
      if (current !== undefined) return false
      current = event.data?.turn
      if (!Number.isSafeInteger(current) || current < 0) return false
      if (current === turnId) starts += 1
    } else if (event.type === 'user/message' && event.data?.source?.exchangeId === exchangeId) {
      matches += 1
      if (current === turnId && event.data?.source?.kind === 'bot' && event.data.source.role === role) inTarget += 1
    } else if (event.type === 'turn/end') {
      if (current === undefined || (event.data?.turn !== undefined && event.data.turn !== current)) return false
      if (current === turnId && event.data?.reason?.kind === 'max-tokens') ended = true
      current = undefined
    }
  }
  return starts === 1 && matches === 1 && inTarget === 1 && ended
}
