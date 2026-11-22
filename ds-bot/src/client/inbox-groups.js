const validId = value => typeof value === 'string' && value.length > 0

// Keep earlier observations only while retrying the same roster range. The
// latest status and time describe this attempt; rowsReadAt dates the evidence.
export function keepInboxPageOnRetry(previous, page) {
  const samePart = (old, source) => old.sessionId === source.sessionId && old.kind === source.kind
    && old.roomId === source.roomId && old.earlier === source.earlier && old.endedAt === source.endedAt
  if (page.total !== previous.total || page.nextCursor !== previous.nextCursor
      || page.sources.length !== previous.sources.length
      || !page.sources.every((source, i) => samePart(previous.sources[i], source))) return page
  const sources = page.sources.map((source, i) => {
    if (source.status === 'ready' || source.status === 'ambiguous') return source
    const old = previous.sources[i]
    const rowsReadAt = old.status === 'ready' ? previous.readAt : old.rowsReadAt
    if (!Number.isFinite(rowsReadAt)) return source
    return {...source, rows:old.rows, rowsReadAt}
  })
  return {...page, sources}
}

function pageCoverage(pages) {
  let next = null
  const seen = new Set()
  const total = pages[0]?.page.total
  for (const { cursor, page } of pages) {
    if ((cursor ?? null) !== next || (seen.size && next === null) || page.total !== total) return false
    for (const source of page.sources) {
      if (!validId(source.sessionId) || seen.has(source.sessionId)) return false
      seen.add(source.sessionId)
    }
    next = page.nextCursor
  }
  return next === null && seen.size === total
}

function uniqueRows(candidates) {
  const rows = []
  const byPart = new Map()
  const exchanges = new Map()
  // An exchange can disambiguate a rotation only when it occurs on at most
  // one separately addressed message per Session, regardless of sample order.
  for (const row of candidates) {
    const exchangeId = row.exchangeId ?? row.row?.source?.exchangeId
    if (!validId(row.sessionId) || !validId(exchangeId)) continue
    let exchange = exchanges.get(exchangeId)
    if (!exchange) exchanges.set(exchangeId, exchange = {parts:new Map(), conflict:false})
    const messageId = row.messageId ?? row.row?.id
    if (exchange.parts.has(row.sessionId) && (!validId(messageId) || exchange.parts.get(row.sessionId) !== messageId)) exchange.conflict = true
    exchange.parts.set(row.sessionId, messageId)
  }
  // Older host state has only "id", which may be a message ID or exchange ID.
  // Use it to match an unlocated row only if it identifies a single known row.
  const aliases = new Map()
  let uncertain = false
  let missingExchange = false
  function recordAlias(alias, index) {
    if (!validId(alias)) return
    if (!aliases.has(alias)) aliases.set(alias, index)
    else if (aliases.get(alias) !== index) aliases.set(alias, -1)
  }
  for (const row of candidates) {
    if (!validId(row.sessionId)) continue
    let part = byPart.get(row.sessionId)
    if (!part) byPart.set(row.sessionId, part = new Map())
    const messageId = row.messageId ?? row.row?.id
    const exchangeId = row.exchangeId ?? row.row?.source?.exchangeId
    if (!validId(exchangeId)) missingExchange = true
    const own = validId(messageId) ? part.get(messageId) : undefined
    const exchange = validId(exchangeId) ? exchanges.get(exchangeId) : undefined
    let index = own?.index
    if (own && own.exchangeId && exchangeId && own.exchangeId !== exchangeId) uncertain = true
    if (exchange?.parts.size > 1) {
      if (exchange.conflict || (index !== undefined && exchange.index !== undefined && index !== exchange.index)) uncertain = true
      else index ??= exchange.index
    }
    index ??= rows.push(row) - 1
    if (validId(messageId)) part.set(messageId, {index, exchangeId})
    else if (!validId(exchangeId)) uncertain = true
    if (exchange) exchange.index ??= index
    for (const id of [messageId, exchangeId]) recordAlias(id, index)
  }
  const matched = new Set()
  const unlocatedIds = new Set()
  for (const row of candidates) {
    if (validId(row.sessionId)) continue
    const matches = new Set([row.id, row.messageId, row.exchangeId].filter(validId)
      .map(id => aliases.get(id)).filter(index => index !== undefined))
    if (matches.size === 1 && !matches.has(-1)) {
      const [index] = matches
      const knownExchange = rows[index].exchangeId ?? rows[index].row?.source?.exchangeId
      if (!matched.has(index) && !(knownExchange && row.exchangeId && row.exchangeId !== knownExchange)) {
        matched.add(index)
        continue
      }
    }
    if (matches.size || !validId(row.id) || unlocatedIds.has(row.id)) uncertain = true
    unlocatedIds.add(row.id)
    rows.push(row)
  }
  return {rows, uncertain:uncertain || (missingExchange && byPart.size > 1)}
}

function warmIdentity(row) {
  const message = row.messageId ?? row.row?.id ?? row.id
  const exchange = row.exchangeId ?? row.row?.source?.exchangeId
  if (!validId(message) && !validId(exchange)) return null
  return JSON.stringify([row.sessionId ?? null, message ?? null, exchange ?? null])
}

function rowCounts(rows) {
  const counts = new Map()
  for (const row of rows) {
    const key = warmIdentity(row)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return counts
}

function sameCounts(a, b) {
  return a.size === b.size && [...a].every(([key, count]) => b.get(key) === count)
}

function sessionCoverage(group) {
  const live = new Set(group.liveSessionIds)
  const sources = new Map((group.sources ?? []).map(source => [source.sessionId, source.status]))
  return {live, sources}
}

function sameCoverage(group, old) {
  if ((group.partial === false) !== (old.partial === false)) return false
  if (group.liveSessionIds === old.liveSessionIds && group.sources === old.sources) return true
  const current = sessionCoverage(group), before = sessionCoverage(old)
  return current.live.size === before.live.size && [...current.live].every(sid => before.live.has(sid))
    && current.sources.size === before.sources.size
    && [...current.sources].every(([sid, status]) => before.sources.has(sid) && before.sources.get(sid) === status)
}

// Compare with the last committed render. Preview text, row order, display names
// and changes in other rooms do not advance a group's observation revision.
export function stampInboxGroups(groups, previousGroups = []) {
  const previous = new Map(previousGroups.map(group => [group.key, group]))
  return groups.map(group => {
    const old = previous.get(group.key)
    const same = old && sameCoverage(group, old) && (group.rows === old.rows
      || sameCounts(rowCounts(group.rows ?? []), rowCounts(old.rows ?? [])))
    const liveRevision = same ? old.liveRevision : (old?.liveRevision ?? 0) + 1
    return {...group, liveRevision}
  })
}

function mergeGroup(group, samples, complete) {
  const live = new Set(group.liveSessionIds)
  const warm = group.rows ?? []
  const sources = new Map((group.sources ?? []).map(source => [source.sessionId, source]))
  const candidates = warm.filter(row => live.has(row.sessionId))
  const ready = new Set()
  const previousObservations = []
  const captures = new Map()
  const sourceCaptures = new Map()
  let currentCounts
  let liveAfterRead = false
  let unread = false
  for (const [sid, {source, readAt, atStart}] of samples) {
    let capture
    if (atStart !== undefined) {
      capture = captures.get(atStart)
      if (!capture) {
        const counts = rowCounts(atStart?.rows ?? [])
        currentCounts ??= rowCounts(warm)
        const revisionChanged = atStart?.liveRevision !== undefined && group.liveRevision !== undefined
          && group.liveRevision !== atStart.liveRevision
        const newer = group.partial === false &&
          (revisionChanged || atStart?.partial !== false || !sameCounts(counts, currentCounts))
        capture = {counts, newer}
        captures.set(atStart, capture)
      }
      sourceCaptures.set(sid, capture)
      liveAfterRead ||= capture.newer
    }
    const {rows, ...meta} = source
    sources.set(sid, {...meta, readAt, ...(source.status === 'ready' ? {sampledCount:rows.length} : {})})
    if (source.status !== 'ready') {
      if (!live.has(sid)) unread = true
      if (!live.has(sid) && !capture?.newer && source.status !== 'ambiguous' && Number.isFinite(source.rowsReadAt)) {
        for (const row of rows) previousObservations.push({...row, sessionId:sid, earlier:source.earlier, readAt:source.rowsReadAt})
      }
      continue
    }
    ready.add(sid)
    if (live.has(sid) || capture?.newer) continue
    for (const row of rows) candidates.push({...row, sessionId:sid, earlier:source.earlier, readAt})
  }
  const allInspected = complete && samples.size > 0 && [...sources.keys()].every(sid => ready.has(sid) || live.has(sid))
  const seen = new Map()
  for (const row of warm) {
    if (live.has(row.sessionId)) continue
    const id = warmIdentity(row)
    const occurrence = (seen.get(id) ?? 0) + 1
    seen.set(id, occurrence)
    if (validId(row.sessionId)) {
      const capture = sourceCaptures.get(row.sessionId)
      if (ready.has(row.sessionId) && (!capture || (!capture.newer && id && capture.counts.get(id) >= occurrence))) continue
    } else if (allInspected && !liveAfterRead) {
      // Old hosts omitted the Session. Only replace rows present when every
      // candidate page started; a late addition may belong to any of them.
      if (!captures.size || (id && [...captures.values()].every(({counts}) => counts.get(id) >= occurrence))) continue
    }
    candidates.push(row)
  }
  const {rows, uncertain} = uniqueRows(candidates.concat(previousObservations))
  const partial = uncertain || unread || previousObservations.length > 0 || (group.partial !== false && !allInspected)
  return {key:group.key, name:group.name, rows, sources:[...sources.values()], partial, knownCount:rows.length, count:partial ? null : rows.length}
}

export function inboxGroups(liveGroups = [], pages = []) {
  const groups = new Map(liveGroups.map(group => [group.key, group]))
  const samples = new Map()
  for (const {page, liveGroups:atStart} of pages) {
    const captured = atStart && new Map(atStart.map(group => [group.key, group]))
    for (const source of page.sources) {
      const key = source.kind === 'private' ? 'private' : source.roomId
      if (!validId(key) || !validId(source.sessionId)) continue
      if (!groups.has(key)) groups.set(key, {key, name:source.roomName, partial:true})
      if (!samples.has(key)) samples.set(key, new Map())
      samples.get(key).set(source.sessionId, {source, readAt:page.readAt, atStart:captured ? captured.get(key) ?? null : undefined})
    }
  }
  const complete = pageCoverage(pages)
  return [...groups.values()].map(group => mergeGroup(group, samples.get(group.key) ?? new Map(), complete))
}
