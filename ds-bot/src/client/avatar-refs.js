// Photos are fetched by content reference after the roster is ready. Only the
// current roster's references are queued, with a bounded number of requests.
export const AVATAR_RETRY_MS = 1_000

export function createAvatarRefCache(call, onChange, { concurrency = 3, timeoutMs = 4_500, retryMs = AVATAR_RETRY_MS } = {}) {
  const jobs = new Map()
  const shown = new Map()
  const overrides = new Map()
  let ownerRefs = new Map()
  let active = 0
  let notifyQueued = false
  let disposed = false

  const collections = [['bots', 'botId'], ['rooms', 'roomId']]
  const ownerOf = (kind, entry) => kind + ':' + entry.id
  const notify = () => {
    if (notifyQueued) return
    notifyQueued = true
    void Promise.resolve().then(() => {
      notifyQueued = false
      if (!disposed && jobs.size) onChange()
    })
  }

  // If the owner's photo changed before the fetch, the host returns its current
  // ref (or null). Apply that result only to the owner we looked up.
  const load = (job, owner, payload) => {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    const aborted = new Promise(resolve => controller.signal.addEventListener('abort', () => resolve(undefined), { once: true }))
    job.controller = controller
    active++
    const request = Promise.resolve().then(() => {
      if (!controller.signal.aborted) return call('avatar', payload, controller.signal)
    }).catch(() => undefined)

    void Promise.race([request, aborted]).then(reply => {
      if (jobs.get(job.ref) !== job) return
      if (typeof reply?.image === 'string' && reply.ref === job.ref) {
        job.image = reply.image
        job.failures = 0
        notify()
      } else if (job.owners.has(owner)) {
        if ((reply?.image === null && reply.ref === null) || (typeof reply?.image === 'string' && typeof reply.ref === 'string')) {
          overrides.set(owner, { ref: job.ref, image: reply.image ?? undefined })
          job.failures = 0
          notify()
        } else {
          const delay = retryMs * 2 ** Math.min(job.failures++, 5)
          job.retry = setTimeout(() => { job.retry = undefined; pump() }, delay)
        }
      }
    }).finally(() => {
      clearTimeout(timeout)
      job.controller = undefined
      active--
      pump()
    })
  }

  function pump() {
    for (const job of jobs.values()) {
      if (active >= concurrency) return
      if (job.controller || job.retry !== undefined || job.image !== undefined) continue
      for (const [owner, payload] of job.owners) {
        if (overrides.has(owner)) continue
        load(job, owner, payload)
        break
      }
    }
  }

  function withPhotos(value) {
    const updated = {}
    for (const [kind] of collections) {
      let changed = false
      const entries = value[kind].map(entry => {
        const owner = ownerOf(kind, entry)
        const ref = ownerRefs.get(owner)
        if (ref === undefined) return entry
        const override = overrides.get(owner)
        const image = override ? override.image : jobs.get(ref)?.image ?? shown.get(owner)
        if (image === undefined) shown.delete(owner)
        else shown.set(owner, image)
        if (entry.avatar.imageRef === undefined && entry.avatar.image === image) return entry
        const { imageRef: _ref, image: _image, ...avatar } = entry.avatar
        changed = true
        return { ...entry, avatar: image === undefined ? avatar : { ...avatar, image } }
      })
      if (changed) updated[kind] = entries
    }
    return Object.keys(updated).length ? { ...value, ...updated } : value
  }

  function track(value) {
    if (disposed) return value
    const next = new Map()
    const owners = new Map()
    const nextJobs = new Map()
    for (const [kind, key] of collections) {
      for (const entry of value[kind]) {
        const owner = ownerOf(kind, entry)
        const ref = entry.avatar?.imageRef
        owners.set(owner, entry.avatar?.image)
        if (typeof ref !== 'string' || !ref || typeof entry.avatar?.image === 'string') continue
        next.set(owner, ref)
        let job = nextJobs.get(ref)
        if (!job) {
          job = jobs.get(ref) ?? { ref, owners: new Map(), failures: 0 }
          job.owners.clear()
          nextJobs.set(ref, job)
        }
        job.owners.set(owner, { [key]: entry.id, ref })
      }
    }
    for (const [owner, image] of owners) {
      if (typeof image === 'string') shown.set(owner, image)
      else if (!next.has(owner)) shown.delete(owner)
    }
    for (const owner of shown.keys()) if (!owners.has(owner)) shown.delete(owner)
    for (const [owner, override] of overrides) if (next.get(owner) !== override.ref) overrides.delete(owner)
    for (const [ref, job] of jobs) {
      if (nextJobs.has(ref)) continue
      jobs.delete(ref)
      clearTimeout(job.retry)
      job.controller?.abort()
    }
    for (const [ref, job] of nextJobs) jobs.set(ref, job)
    ownerRefs = next
    const projected = withPhotos(value)
    pump()
    return projected
  }

  return {
    track,
    withPhotos,
    clear() {
      disposed = true
      for (const job of jobs.values()) {
        clearTimeout(job.retry)
        job.controller?.abort()
      }
      jobs.clear()
      shown.clear()
      overrides.clear()
      ownerRefs.clear()
    },
  }
}
