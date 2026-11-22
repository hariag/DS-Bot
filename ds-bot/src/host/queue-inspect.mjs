import { createHash, createHmac, randomBytes } from 'node:crypto'
import { readSessionInbox } from './inbox-read.mjs'

const PAGE = 8
const MAX_READS = 3
const MAX_PENDING = 64
const invalid = message => Object.assign(new Error(message), { code: 'bot/invalid' })
const validId = id => typeof id === 'string' && id.length > 0

// Build identities from the roster, including origins outside the viewer's
// scope: if these share a Session with an otherwise visible source, no queue
// belonging to that Session can be attributed to either side.
function scopeOf(state, sessionId) {
  const origins = new Map()
  const now = Date.now()
  const add = (session, kind, earlier, botId, room, thread, endedAt) => {
    if (!validId(session)) return
    const origin = { sessionId:session, kind, earlier, botId, thread, roomId:room?.id, roomName:room?.name }
    if (earlier && Number.isSafeInteger(endedAt) && endedAt > 0 && endedAt <= now) origin.endedAt = endedAt
    const entries = origins.get(session)
    if (entries) entries.push(origin)
    else origins.set(session, [origin])
  }
  for (const bot of Object.values(state.bots)) {
    for (const part of [bot, ...(bot.openParts ?? [])]) {
      const thread = part.sessionId ?? (part === bot ? bot.id : undefined)
      add(thread, 'private', false, bot.id, undefined, thread)
      for (const old of part.segments ?? []) add(old.sessionId, 'private', true, bot.id, undefined, thread, old.endedAt)
    }
  }
  for (const room of Object.values(state.rooms)) {
    add(room.sessionId ?? room.id, 'post', false, undefined, room)
    for (const old of room.parts ?? []) add(old.sessionId, 'post', true, undefined, room, undefined, old.endedAt)
    for (const [botId, sid] of Object.entries(room.sessions ?? {})) add(sid, 'group', false, botId, room)
    for (const [botId, parts] of Object.entries(room.segments ?? {})) {
      for (const old of parts) add(old.sessionId, 'group', true, botId, room, undefined, old.endedAt)
    }
  }
  for (const agent of Object.values(state.agents ?? {})) {
    for (const sid of agent.sessions ?? []) add(sid, 'agent', false, agent.id)
  }
  const viewers = origins.get(sessionId) ?? []
  if (viewers.length !== 1 || !['private', 'post'].includes(viewers[0].kind)) throw invalid('Choose a uniquely owned Bot or group chat to inspect.')
  const viewer = viewers[0]
  const visible = row => {
    if (viewer.kind === 'post') return row.kind === 'post' && row.roomId === viewer.roomId
    if (row.botId !== viewer.botId) return false
    if (row.kind === 'private') return true
    return row.kind === 'group' && state.bots[viewer.botId]?.private !== true
      && state.rooms[row.roomId]?.members?.includes(viewer.botId) === true
  }
  const sources = []
  for (const entries of origins.values()) {
    const row = entries.find(visible)
    if (row) sources.push({ ...row, ambiguous:entries.length !== 1 })
  }
  // Open threads before archives, with the displayed part first. Recently
  // closed parts come before older or undated ones; IDs break ties.
  const rank = row => row.sessionId === sessionId ? 0 : row.earlier ? 3 : row.kind === 'group' ? 2 : 1
  sources.sort((a, b) => rank(a) - rank(b) || (b.endedAt ?? 0) - (a.endedAt ?? 0) || (a.sessionId < b.sessionId ? -1 : 1))
  const key = createHash('sha256').update(JSON.stringify([sessionId, viewer, sources])).digest('hex')
  return { key, sources }
}

function preview(message, index, sid) {
  const blocks = Array.isArray(message.content) ? message.content : []
  let text = '', attachments = 0
  for (const block of blocks) {
    if (block?.type === 'image' || block?.type === 'file') attachments++
    if (block?.type !== 'text' || typeof block.text !== 'string' || text.length > 400) continue
    if (text) text += '\n'
    text += block.text.slice(0, Math.max(0, 401 - text.length))
  }
  const exchangeId = message.source.exchangeId, messageId = message.id
  return {
    id: validId(messageId) ? messageId : validId(exchangeId) ? exchangeId : `${sid}:${index}`,
    ...(validId(messageId) ? { messageId } : {}), ...(validId(exchangeId) ? { exchangeId } : {}),
    senderName: typeof message.source.senderName === 'string' ? message.source.senderName.slice(0, 120) : '',
    text: text.length > 400 ? text.slice(0, 400) + '…' : text, attachments,
  }
}

// The semaphore is shared by all requests for this host. Identical reads
// share one underlying projection. Departing callers drop their own wait;
// the final caller also cancels the read, which owns its slot until it ends.
function sharedReads(ctx, read) {
  const jobs = new Map(), waiting = []
  let running = 0
  const pump = () => {
    while (running < MAX_READS && waiting.length) {
      const job = waiting.shift()
      if (job.controller.signal.aborted) continue
      for (const waiter of [...job.waiters]) {
        try { waiter.check() } catch (error) { waiter.finish(undefined, error) }
      }
      if (!job.waiters.size) continue
      running++
      // Start immediately after checking each reader's current ownership.
      void (async () => read(ctx, job.id, job.controller.signal))().catch(() => ({ status:'unavailable' }))
        .then(value => {
          for (const waiter of [...job.waiters]) waiter.finish(value)
        }).finally(() => { running--; pump() })
    }
  }
  return (id, signal, check) => {
    signal.throwIfAborted()
    let job = jobs.get(id)
    if (!job) {
      if (jobs.size >= MAX_PENDING) return Promise.resolve({ status:'unavailable' })
      job = { id, controller:new AbortController(), waiters:new Set() }
      jobs.set(id, job)
      waiting.push(job)
    }
    return new Promise((resolve, reject) => {
      const finish = (value, error) => {
        signal.removeEventListener('abort', cancel)
        job.waiters.delete(waiter)
        if (!job.waiters.size) {
          jobs.delete(id)
          const index = waiting.indexOf(job)
          if (index !== -1) waiting.splice(index, 1)
          job.controller.abort()
        }
        if (error) reject(error)
        else resolve(value)
      }
      const cancel = () => finish(undefined, signal.reason)
      const waiter = { check, finish }
      job.waiters.add(waiter)
      signal.addEventListener('abort', cancel, { once:true })
      pump()
    })
  }
}

export function createQueueInspector(rt, read = readSessionInbox) {
  const lookup = sharedReads(rt.ctx, read)
  const secret = randomBytes(32)
  const cursorFor = (scope, offset) => `${offset}.${createHmac('sha256', secret).update(`${scope}:${offset}`).digest('base64url')}`
  return async (args, signal) => {
    const { sessionId, cursor } = args
    if (!validId(sessionId) || Object.keys(args).some(key => !['sessionId', 'cursor'].includes(key))) throw invalid('Choose a displayed chat to inspect.')
    const plan = scopeOf(rt.state, sessionId)
    let start = 0
    if (cursor !== undefined && cursor !== null) {
      const match = typeof cursor === 'string' && /^([1-9]\d{0,8})\.[\w-]{43}$/.exec(cursor)
      start = match ? Number(match[1]) : 0
      if (!match || cursor !== cursorFor(plan.key, start) || start % PAGE || start >= plan.sources.length) throw invalid('The inbox scope changed. Start the inspection again.')
    }
    const timeout = AbortSignal.timeout(30_000)
    const deadline = signal ? AbortSignal.any([signal, timeout]) : timeout
    const check = () => {
      deadline.throwIfAborted()
      if (scopeOf(rt.state, sessionId).key !== plan.key) throw invalid('The inbox scope changed. Start the inspection again.')
    }
    const page = plan.sources.slice(start, start + PAGE)
    const sources = await Promise.all(page.map(async source => {
      const { sessionId:id, kind, earlier, roomId, roomName, endedAt } = source
      const data = source.ambiguous ? {status:'ambiguous'} : await lookup(id, deadline, check)
      const rows = []
      if (data.status === 'ready') {
        for (const message of [...data.nextStep, ...data.nextTurn]) {
          if (message?.source?.kind !== 'bot' || (kind === 'post' && message.source.role !== 'post')) continue
          rows.push(preview(message, rows.length, id))
        }
      }
      return { sessionId:id, kind, earlier, ...(endedAt ? {endedAt} : {}), ...(roomId ? {roomId, roomName} : {}), status:data.status, rows }
    }))
    await rt.refresh?.()
    check()
    const end = start + page.length
    return { sources, nextCursor:end < plan.sources.length ? cursorFor(plan.key, end) : null, total:plan.sources.length, readAt:Date.now() }
  }
}
