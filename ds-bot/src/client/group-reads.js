// Multiple transcript cells can render the same call. Each action set belongs
// to a single plugin instance, so a reload or another host has separate data.
const clients = new WeakMap()

export function groupReads(actions) {
  if (clients.has(actions)) return clients.get(actions)
  const pending = new Map()
  const closed = new Map()
  const latest = new Map()
  function read(key, cursor, fetch) {
    const current = pending.get(key)
    if (current) {
      if (current.cursor === cursor && !current.next) return current.task
      // A newer cursor arrived during a read. Its caller needs a fresh answer;
      // additional changes before the follow-up starts share that same answer.
      if (!current.next) {
        current.next = current.task.then(() => read(key, current.latest, fetch))
      }
      current.latest = cursor
      return current.next
    }
    if (typeof cursor === 'string' && latest.get(key)?.cursor === cursor) return Promise.resolve(latest.get(key).value)
    const entry = { cursor }
    entry.task = Promise.resolve().then(fetch).catch(() => null).then(value => {
      if (typeof cursor === 'string' && value != null) {
        latest.set(key, { cursor, value })
        if (latest.size > 16) latest.delete(latest.keys().next().value)
      }
      return value
    }).finally(() => pending.delete(key))
    pending.set(key, entry)
    return entry.task
  }
  const client = {
    read,
    closed: key => closed.get(key),
    settle(key, view) {
      closed.set(key, view)
      if (closed.size > 128) closed.delete(closed.keys().next().value)
    },
  }
  clients.set(actions, client)
  return client
}

// Collect distinct ranges rendered by one feed pass and keep each room independent.
// Older hosts expose only the single-range request.
export function createGroupRowsReader(call, maxRanges) {
  const rooms = new Map()
  async function flush(roomId, batch) {
    rooms.delete(roomId)
    clearTimeout(batch.timer)
    const entries = batch.entries
    let result
    try {
      result = await call('group-rows', { roomId, ranges: entries.map(entry => entry.range) })
    } catch { /* the cell retries an unavailable range */ }
    const valid = Array.isArray(result) && result.length === entries.length
    entries.forEach((entry, index) => entry.resolve(valid ? result[index] : null))
  }
  return (roomId, from, to, anchor) => {
    const limit = maxRanges()
    const range = { from, ...(to === undefined ? {} : { to }), ...(anchor === undefined ? {} : { anchor }) }
    if (!Number.isSafeInteger(limit) || limit < 2) return call('group-rows', { roomId, ...range }).catch(() => null)
    let batch = rooms.get(roomId)
    if (!batch) {
      batch = { entries: [] }
      rooms.set(roomId, batch)
      batch.timer = setTimeout(() => void flush(roomId, batch), 8)
    }
    return new Promise(resolve => {
      batch.entries.push({ range, resolve })
      if (batch.entries.length >= limit) void flush(roomId, batch)
    })
  }
}
