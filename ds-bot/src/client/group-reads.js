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
