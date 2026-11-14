// Preserve original Bot work across a restart. The recovery journal can outlive
// an interrupted delivery, and an unflushed history cannot establish that an
// absent message was never executed. Ambiguous records remain held without replay.
// A unique, durably received reply can reconcile its exact original work item.
import { createHash, randomUUID } from 'node:crypto'
import { constants, readFileSync } from 'node:fs'
import { lstat, mkdir, open, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { HISTORY_TIMEOUT_MS, SOURCE_KIND, STEER_CUT, TEXT_KEPT } from './constants.js'
import { readRecoveryHistory, historyMentionsSource, readDurableReply, replyContainsInlineResults, observedOutputLimit } from './recovery-history.js'
import { replaceFile } from './files.js'
import { textOf } from './text.js'
import { heldTurnsView } from './recovery-held.js'
import { collectRecoveryCandidates, collectRecoveryOrigins, observeRecoveryRecords } from './recovery-observation.mjs'

// Long enough for DSH to finish opening its workspaces after a start.
export const RESUME_DELAY_MS = 3000
const RECOVERY_VIEW_MAX_BYTES = 64 * 1024 * 1024
const RECOVERY_VIEW_TIMEOUT_MS = 5000
const unavailableRecoveryView = () => ({ available: false, incomplete: true, items: [] })

// A stuck filesystem or writer must not keep a board request open indefinitely.
export async function boundedRecoveryView(work, timeoutMs = RECOVERY_VIEW_TIMEOUT_MS) {
  let timer
  try {
    return await Promise.race([work.catch(() => unavailableRecoveryView()), new Promise(resolve => {
      timer = setTimeout(() => resolve(unavailableRecoveryView()), timeoutMs)
    })])
  } finally { clearTimeout(timer) }
}

export const resumeText = record => [
  'DeepSeek Harness restarted while you were working on this, so your last turn stopped before it finished.',
  record.approval ? `You were waiting for the user's approval to run ${record.approval.tool || 'a tool'}${record.approval.reason ? ` (${record.approval.reason})` : ''}; that request is gone, so ask again if you still need it.` : '',
  'Check what is already done (files, commands, messages) before you repeat anything, then finish the task and give your reply.',
].filter(Boolean).join(' ')

// The turns of a Session's durable log, each with the exchanges it took up, what it
// said and how it ended.
export function turnsOf(events) {
  const turns = []
  let current
  for (const event of events) {
    if (event.type === 'turn/start') {
      current = { turn: event.data?.turn, took: [], texts: [], reason: undefined }
      turns.push(current)
      continue
    }
    if (current === undefined) continue
    if (event.type === 'step/start') {
      current.stepFrom = current.texts.length
      continue
    }
    if (event.type === 'user/message') {
      const source = event.data?.source
      if (source?.exchangeId !== undefined) current.took.push(source)
      continue
    }
    if (event.type === 'assistant/message') {
      const text = textOf(event.data?.message?.content)
      if (text !== '') current.texts.push(text)
      continue
    }
    if (event.type === 'turn/end') current.reason = event.data?.reason
  }
  return turns
}

// The last turn that took up an exchange: what it said and how it ended. A turn cut
// by a user steer keeps going in the turn that starts right after it, so the reason
// that counts is the continuation's.
export function turnOf(events, exchangeId) {
  const turns = turnsOf(events)
  const steerCut = turn => turn?.reason?.kind === 'aborted'
    && turn.reason.reason?.kind === 'hook'
    && turn.reason.reason?.reason === STEER_CUT
  for (let at = turns.length - 1; at >= 0; at -= 1) {
    if (!turns[at].took.some(source => source.exchangeId === exchangeId)) continue
    let found = turns[at]
    let next = at + 1
    // A steer cut lands inside a step's model call, so the cut turn's last step left
    // an interrupted draft: texts before the last step/start stay, the rest is a
    // fragment the continuation replaces.
    const finished = turn => turn.texts.slice(0, turn.stepFrom ?? turn.texts.length)
    while (steerCut(found) && next < turns.length) {
      const follow = turns[next]
      const kept = finished(found)
      found = { ...follow, took: [...found.took, ...follow.took], texts: [...kept, ...follow.texts], stepFrom: kept.length + (follow.stepFrom ?? follow.texts.length) }
      next += 1
    }
    return steerCut(found) ? { ...found, texts: finished(found), reason: undefined } : found
  }
  return undefined
}

// Whether a Session already holds the answer to an exchange.
export function answeredIn(events, exchangeId) {
  return events.some(event => event.type === 'user/message' && event.data?.source?.replyTo === exchangeId)
}

// The trigger fields a resumed turn needs to answer the same sender.
const triggerOf = info => ({
  role: info.role,
  ...(info.exchangeId ? { exchangeId: info.exchangeId } : {}),
  ...(info.senderSessionId ? { senderSessionId: info.senderSessionId } : {}),
  ...(info.roomId ? { roomId: info.roomId } : {}),
  ...(info.work ? { work: info.work } : {}),
  ...(info.audience ? { audience: info.audience } : {}),
  ...(info.askedBy ? { askedBy: info.askedBy } : {}),
  ...(info.senderRoomId ? { senderRoomId: info.senderRoomId } : {}),
  ...(info.reviewId ? { reviewId: info.reviewId } : {}),
  ...(info.reviewInspect === true ? { reviewInspect: true } : {}),
})

const readNotes = (file) => {
  let raw
  try {
    raw = readFileSync(file, 'utf8')
  } catch (error) {
    return error?.code === 'ENOENT' ? { turns: {}, queued: {}, heldTurns: {}, raw: undefined }
      : { turns: {}, queued: {}, heldTurns: {}, blocked: error?.code ?? error?.name ?? 'read error' }
  }
  try {
    const parsed = JSON.parse(raw)
    const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
    if (!object(parsed) || (parsed.turns !== undefined && !object(parsed.turns)) || (parsed.queued !== undefined && !object(parsed.queued)) || (parsed.heldTurns !== undefined && !object(parsed.heldTurns))) throw new Error('invalid notes')
    return { turns: parsed.turns ?? {}, queued: parsed.queued ?? {}, heldTurns: parsed.heldTurns ?? {}, raw }
  } catch {
    return { turns: {}, queued: {}, heldTurns: {}, blocked: 'invalid recovery notes' }
  }
}

// The injectable file operations allow a failed replacement to be tested without
// touching an active host's recovery file.
export async function writeNotesAtomically(file, snapshot, check, ops = { writeFile, unlink, replaceFile }) {
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`
  try {
    check()
    await ops.writeFile(temp, snapshot, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    check()
    await ops.replaceFile(temp, file, check)
  } catch (error) {
    await ops.unlink(temp).catch(() => {})
    throw error
  }
}

export function install(rt) {
  const { ctx, home } = rt
  const file = join(home, 'inflight.json')

  // What the last run left; read before this run notes anything.
  let interrupted = readNotes(file)
  let expected = interrupted.raw
  let blocked = interrupted.blocked
  if (blocked !== undefined) rt.warn('ds-bot: recovery notes %s are unreadable (%s); the original file is preserved and Bot deliveries are paused until it is repaired and the plugin is reloaded', file, blocked)

  /** @type {Record<string, {botId:string, roomId?:string, since:number, trigger?:any, approval?:{tool:string, reason:string}, resumed?:boolean}>} */
  // Keep every original turn until recovery has actually inspected it: a
  // crash while resumeAll prepares the queue must not erase other work either.
  let turns = { ...interrupted.turns }
  let unknownQueueGeneration = 0n
  // A later turn in the same session must not overwrite an older uncertain
  // interruption. Preserve it separately before the first possible snapshot.
  const heldTurns = { ...interrupted.heldTurns }
  const holdTurn = (sessionId, value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid interrupted turn; inspect recovery notes')
    const { recoveryHold: _, ...record } = value
    const id = createHash('sha256').update(JSON.stringify([sessionId, record])).digest('hex')
    if (heldTurns[id] === undefined) {
      // A newly held turn can invalidate checks for any room until its exact
      // provenance has been matched to the current roster.
      unknownQueueGeneration += 1n
      heldTurns[id] = { sessionId, record, reason: 'interrupted outcome unknown' }
    }
  }
  for (const [sessionId, value] of Object.entries(interrupted.turns)) {
    try { holdTurn(sessionId, value) } catch {
      blocked = 'invalid interrupted turn'
      rt.warn('ds-bot: invalid interrupted turn for %s; the original recovery notes are preserved for inspection', sessionId)
    }
  }
  // A new delivery can persist before recovery runs; it must keep the old queue.
  /** @type {Record<string, {at:number, args:any}[]>} deliveries no turn has taken up, by Session */
  let queued = interrupted.queued
  let writing = Promise.resolve()
  let stopped = false
  // Scoped review evidence is valid only in this exact host incarnation and
  // while no queue mutation has occurred. Reloading loses the epoch on purpose.
  const reviewQueueEpoch = randomUUID()
  const roomQueueGenerations = new Map()
  const ownerQueueGenerations = new Map()
  const bump = (map, key) => map.set(key, (map.get(key) ?? 0n) + 1n)
  const bumpRoomNote = args => {
    const room = rt.roomOf(args.roomId), bot = typeof args.toId === 'string' ? rt.botOf(args.toId) : undefined
    if (!bot || !Array.isArray(room?.members) || !room.members.includes(bot.id)) bump(roomQueueGenerations, args.roomId)
    else bump(ownerQueueGenerations, JSON.stringify([args.roomId, bot.id]))
  }
  const queueChanged = (args, sessionId) => {
    if (!args || typeof args !== 'object') { unknownQueueGeneration += 1n; return }
    if (typeof args.roomId === 'string' && args.roomId !== '') { bumpRoomNote(args); return }
    if (args.role === 'room' || args.role === 'report' || typeof args.role !== 'string') { unknownQueueGeneration += 1n; return }
    for (const inferred of roomNotesForTurn(sessionId,{botId:args.toId,trigger:{role:args.role}})) {
      if (inferred.roomId) bumpRoomNote(inferred)
      else unknownQueueGeneration += 1n
    }
  }
  rt.reviewQueueVersion = (roomId, ownerId) => {
    if (stopped || blocked !== undefined || rt.readOnly() !== undefined) return undefined
    if (typeof roomId !== 'string' || typeof ownerId !== 'string') return undefined
    let lease
    try { lease = rt.homeLockVersion?.() } catch { return undefined }
    if (lease === undefined) return undefined
    return `${reviewQueueEpoch}:${unknownQueueGeneration}:${roomQueueGenerations.get(roomId) ?? 0n}:${ownerQueueGenerations.get(JSON.stringify([roomId, ownerId])) ?? 0n}:${lease}`
  }
  // A secondary host cannot know the live writer's current in-memory notes.
  // Return no possibly stale records until this host can read its own state.
  const unavailableHeld = unavailableRecoveryView
  const ownsRecoveryView = () => {
    if (blocked !== undefined || stopped || rt.readOnly() !== undefined) return false
    // readOnly() alone does not cover an unusable lock or a lock whose token
    // has been replaced before holder state is refreshed. Do not present this
    // host's in-memory snapshot as current unless it actually owns the lock.
    try { rt.requireHomeLock(); return true } catch { return false }
  }
  // Do not present a pending or externally changed file snapshot as current.
  // Read the visible file bytes with a fixed memory bound, then
  // recheck the path identity and the writer/lock after asynchronous I/O.
  const readRecoveryForView = async () => {
    let handle
    try {
      handle = await open(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0))
      const before = await handle.stat({ bigint: true })
      if (!before.isFile() || before.size > BigInt(RECOVERY_VIEW_MAX_BYTES)) return { ok:false }
      const buffer = Buffer.alloc(Number(before.size) + 1)
      let length = 0
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length)
        if (bytesRead === 0) break
        length += bytesRead
      }
      const after = await handle.stat({ bigint: true })
      const entry = await lstat(file, { bigint: true })
      if (!entry.isFile() || BigInt(length) !== before.size) return { ok:false }
      for (const key of ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs']) {
        if (before[key] !== after[key] || after[key] !== entry[key]) return { ok:false }
      }
      return { ok:true, raw:buffer.subarray(0, length).toString('utf8') }
    } catch (error) {
      return error?.code === 'ENOENT' && !handle ? { ok:true, raw:undefined } : { ok:false }
    } finally { await handle?.close().catch(() => {}) }
  }
  const sampleRecoveryHeld = async scope => {
    if (ownsRecoveryView() !== true) return unavailableHeld()
    const pendingWrite = writing
    await pendingWrite
    if (writing !== pendingWrite || ownsRecoveryView() !== true) return unavailableHeld()
    const saved = expected
    const disk = await readRecoveryForView()
    if (!disk.ok || disk.raw !== saved || expected !== saved || writing !== pendingWrite || ownsRecoveryView() !== true) return unavailableHeld()
    // Startup copies interrupted turns into memory before the first file
    // replacement. Do not show those new holds as a saved snapshot until
    // the visible recovery file contains exactly the same held records.
    const parsed = disk.raw === undefined ? {} : JSON.parse(disk.raw)
    const savedHolds = parsed?.heldTurns ?? {}
    if (!savedHolds || typeof savedHolds !== 'object' || Array.isArray(savedHolds)
      || JSON.stringify(savedHolds) !== JSON.stringify(heldTurns)) return unavailableHeld()
    if (expected !== saved || writing !== pendingWrite || ownsRecoveryView() !== true) return unavailableHeld()
    return { ...heldTurnsView(savedHolds, scope, rt.state?.bots), sampledAt:Date.now() }
  }
  let recoverySample
  rt.recoveryHeldView = async scope => {
    // A slow filesystem read may outlive the caller's timeout. Never stack
    // additional large reads while that earlier read is still running.
    if (recoverySample) return unavailableHeld()
    const work = sampleRecoveryHeld(scope)
    recoverySample = work
    void work.then(() => { if (recoverySample === work) recoverySample = undefined },
      () => { if (recoverySample === work) recoverySample = undefined })
    return boundedRecoveryView(work)
  }
  // Read-only origins for an owner-initiated manual review. A missing result is
  // not evidence that the work did not execute; it never triggers a delivery.
  rt.recoveryWorkOrigins = async workId => {
    if (recoverySample || typeof workId !== 'string' || !workId) return undefined
    const sample = (async () => {
      if (ownsRecoveryView() !== true) return undefined
      const pendingWrite = writing
      await pendingWrite
      if (writing !== pendingWrite || ownsRecoveryView() !== true) return undefined
      const saved = expected, disk = await readRecoveryForView()
      if (!disk.ok || disk.raw !== saved || expected !== saved || writing !== pendingWrite || ownsRecoveryView() !== true) return undefined
      const raw = disk.raw === undefined ? {} : JSON.parse(disk.raw)
      const parsed = { queued: raw.queued ?? {}, turns: raw.turns ?? {}, heldTurns: raw.heldTurns ?? {} }
      const observed = observeRecoveryRecords({ workId, inflight: parsed })
      const ids = collectRecoveryOrigins({ workId, inflight: parsed })
      if (!ids || expected !== saved || writing !== pendingWrite || ownsRecoveryView() !== true) return undefined
      return { ids, observed, sampledAt: Date.now() }
    })()
    recoverySample = sample
    void sample.finally(() => { if (recoverySample === sample) recoverySample = undefined }).catch(() => {})
    return boundedRecoveryView(sample)
  }
  rt.recoveryWorkCandidates = async () => {
    if (recoverySample) return undefined
    const sample = (async () => {
      if (ownsRecoveryView() !== true) return undefined
      const pendingWrite = writing
      await pendingWrite
      if (writing !== pendingWrite || ownsRecoveryView() !== true) return undefined
      const saved=expected,disk=await readRecoveryForView()
      if(!disk.ok || disk.raw!==saved || expected!==saved || writing!==pendingWrite || ownsRecoveryView()!==true)return undefined
      const raw=disk.raw===undefined?{}:JSON.parse(disk.raw)
      const result=collectRecoveryCandidates({queued:raw.queued??{},turns:raw.turns??{},heldTurns:raw.heldTurns??{}})
      if(expected!==saved || writing!==pendingWrite || ownsRecoveryView()!==true)return undefined
      return result
    })()
    recoverySample=sample
    void sample.finally(()=>{if(recoverySample===sample)recoverySample=undefined}).catch(()=>{})
    return boundedRecoveryView(sample)
  }
  let latest
  let due = false
  let pending
  rt.onHomeDrain(() => writing)
  const persist = ({ required = false } = {}) => {
    // Only the host that saves the team runs its work again.
    if (stopped || blocked !== undefined || rt.readOnly() !== undefined) {
      return required ? Promise.reject(new Error('Recovery notes cannot be saved by this host.')) : writing
    }
    latest = JSON.stringify({ turns, queued, ...(Object.keys(heldTurns).length ? { heldTurns } : {}) })
    // One write waits at a time and takes the latest notes, so a busy round does not
    // write the file once per change.
    if (due) return pending
    due = true
    const run = writing.then(async () => {
      due = false
      if (blocked !== undefined) throw new Error(`Recovery notes are unavailable (${blocked}).`)
      const snapshot = latest
      await mkdir(home, { recursive: true })
      const check = () => {
        rt.requireHomeLock()
        let actual
        try { actual = readFileSync(file, 'utf8') } catch (error) { if (error?.code !== 'ENOENT') throw error }
        if (actual !== expected) throw Object.assign(new Error('Recovery notes changed outside this host.'), { code: 'ECONFLICT' })
      }
      await writeNotesAtomically(file, snapshot, check)
      expected = snapshot
    })
    pending = run
    writing = run.catch(error => {
      blocked = error?.code ?? error?.name ?? 'write error'
      rt.warn('ds-bot: noting running turns failed (%s); Bot deliveries are paused and recovery notes require review', blocked)
    })
    return run
  }
  const roomNotesForTurn = (sessionId, record) => {
    if (!record || typeof record !== 'object') return []
    const trigger = record?.trigger
    const explicit = record?.roomId ?? trigger?.roomId
    if (typeof explicit === 'string' && explicit !== '') return [{role:'room',roomId:explicit,toId:record?.botId}]
    const rooms = Object.values(rt.state?.rooms ?? {})
    const matches = rooms.filter(room => [rt.sessionOfRoom(room), ...Object.values(room.sessions ?? {}),
      ...(room.parts ?? []).map(part => part?.sessionId),
      ...Object.values(room.segments ?? {}).flat().map(part => part?.sessionId)].includes(sessionId))
    if (matches.length) return matches.map(room => ({role:'room',roomId:room.id,toId:record?.botId}))
    if (['request','reply','stopped','kickoff','handoff'].includes(trigger?.role)) return []
    const bot = typeof record?.botId === 'string' ? rt.botOf(record.botId) : undefined
    if (bot) return rooms.filter(room => room.members?.includes(bot.id)).map(room => ({role:'room',roomId:room.id,toId:bot.id}))
    return [{role:'room',toId:record?.botId}]
  }
  const update = (id, change) => {
    const next = change(turns[id])
    if (next === turns[id]) return
    for (const args of roomNotesForTurn(id, turns[id])) queueChanged(args)
    for (const args of roomNotesForTurn(id, next)) queueChanged(args)
    turns = { ...turns }
    if (next === undefined) delete turns[id]
    else turns[id] = next
    persist()
  }
  const forgetQueued = (exchangeId, onlySession) => {
    for (const [sessionId, list] of Object.entries(queued)) {
      if (onlySession !== undefined && sessionId !== onlySession) continue
      if (!Array.isArray(list)) continue
      const at = list.findIndex(item => item?.args?.exchangeId === exchangeId)
      if (at === -1) continue
      const rest = list.toSpliced(at, 1)
      queueChanged(list[at].args,sessionId)
      queued = { ...queued }
      if (rest.length === 0) delete queued[sessionId]
      else queued[sessionId] = rest
      persist()
      return
    }
  }
  const markSent = exchangeId => {
    for (const [sessionId, list] of Object.entries(queued)) {
      if (!Array.isArray(list)) continue
      const at = list.findIndex(item => item?.args?.exchangeId === exchangeId)
      if (at === -1 || list[at].recoveryHold !== 'prepared') continue
      const next = [...list]
      const { recoveryHold: _, ...item } = next[at]
      next[at] = item
      queued = { ...queued, [sessionId]: next }
      persist()
      return
    }
  }

  const deliver = rt.deliver
  rt.deliver = async (args, observation) => {
    if (blocked !== undefined) throw new Error(`Recovery notes are unavailable (${blocked}); Bot delivery is paused until the notes are repaired and the plugin is reloaded.`)
    if (stopped || rt.readOnly() !== undefined) throw new Error('Recovery notes cannot be saved by this host.')
    // The sender can be removed or renamed while the write barrier is pending.
    // Keep the identity visible at admission, including in a recovered delivery.
    const fromName = args.fromName ?? rt.botOf(args.fromId)?.name
    const noted = { ...args, ...(fromName === undefined ? {} : { fromName }), exchangeId: args.exchangeId ?? randomUUID() }
    const sessionId = noted.sessionId ?? rt.chatOf(noted.toId)
    // Noted before it is sent: a turn may take it up before the send returns. Notes
    // are kept whole; nothing waits out a delivery silently.
    // If this process stops between saving the note and calling deliver, the
    // caller may see a failure and retry. A prepared note is held for review on
    // restart; it must not be silently turned into an automatic extra delivery.
    queueChanged(noted,sessionId)
    queued = { ...queued, [sessionId]: [...(queued[sessionId] ?? []), { at: Date.now(), args: { ...noted }, recoveryHold: 'prepared' }] }
    await persist({ required: true })
    if (stopped) throw new Error('Bot delivery stopped after its recovery note was saved; the note is retained for recovery.')
    rt.requireHomeLock()
    let notAdmitted = false
    try {
      const result = await deliver(noted, { beforeAdmission: observation?.beforeAdmission, onNotAdmitted: () => {
        notAdmitted = true
        try { observation?.onNotAdmitted?.() } catch {}
      } })
      markSent(noted.exchangeId)
      return result
    } catch (error) {
      // The delivery outcome can be uncertain: its prepared note stays for review.
      // If admission was not reached and the Bot is gone, it cannot be sent.
      // After a possible admission, keep the note even if the Bot was removed.
      if (notAdmitted && rt.botOf(noted.toId) === undefined) forgetQueued(noted.exchangeId)
      throw error
    }
  }

  // What a Session was sent and no turn has read yet.
  // Do not expose mutable queue entries: changing a recipient through a
  // reference would bypass the generation used by scoped reviews.
  rt.unreadOf = sessionId => Array.isArray(queued[sessionId]) ? queued[sessionId].map(item => ({ ...item?.args }))
    : queued[sessionId] === undefined ? [] : [{}]
  // Recovery may still be keyed by an old or unknown Session. Room provenance,
  // not the current Session map, is the authority for inspection fencing.
  rt.unreadRoomOf = roomId => {
    const notes = []
    for (const [sessionId,list] of Object.entries(queued)) {
      if (!Array.isArray(list)) { notes.push({role:'room'}); continue }
      for (const item of list) {
        const args = item?.args
        if (!args || typeof args !== 'object' || typeof args.role !== 'string') {
          for (const unknown of roomNotesForTurn(sessionId, {}))
            if (!unknown.roomId || unknown.roomId === roomId) notes.push(unknown)
        } else if (typeof args.roomId === 'string' && args.roomId !== '') {
          if (args.roomId === roomId) notes.push({ ...args })
        } else if (args.role === 'room' || args.role === 'report') {
          notes.push({ ...args })
        } else {
          for (const inferred of roomNotesForTurn(sessionId,{botId:args.toId,trigger:{role:args.role}}))
            if (!inferred.roomId || inferred.roomId === roomId) notes.push(inferred)
        }
      }
    }
    for (const held of Object.values(heldTurns)) for (const args of roomNotesForTurn(held?.sessionId,held?.record))
      if (!args.roomId || args.roomId === roomId) notes.push(args)
    for (const [sessionId,record] of Object.entries(turns)) for (const args of roomNotesForTurn(sessionId,record))
      if (!args.roomId || args.roomId === roomId) notes.push(args)
    return notes
  }
  rt.forgetDelivery = forgetQueued
  const retained = new Map()
  rt.keepQueued = (sessionId, messages, action) => {
    const ids = new Set(messages.filter(message => message.source?.kind === SOURCE_KIND).map(message => message.source.exchangeId).filter(Boolean))
    const counts = retained.get(sessionId) ?? new Map()
    retained.set(sessionId, counts)
    for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1)
    try { return action() } finally {
      for (const id of ids) {
        const remaining = counts.get(id) - 1
        if (remaining === 0) counts.delete(id)
        else counts.set(id, remaining)
      }
      if (counts.size === 0) retained.delete(sessionId)
    }
  }
  rt.moveQueued = (target, messages) => {
    const ids = new Set(messages.filter(message => message.source?.kind === SOURCE_KIND).map(message => message.source.exchangeId).filter(Boolean))
    if (ids.size === 0) return
    const next = { ...queued }
    if (next[target] !== undefined && !Array.isArray(next[target])) return
    const incoming = [...(next[target] ?? [])]
    const present = new Set(incoming.map(item => item?.args?.exchangeId))
    let changed = false
    for (const [sessionId, list] of Object.entries(queued)) {
      if (sessionId === target) continue
      if (!Array.isArray(list)) continue
      const rest = []
      for (const item of list) {
        if (!ids.has(item?.args?.exchangeId)) { rest.push(item); continue }
        queueChanged(item.args,sessionId)
        if (!present.has(item.args.exchangeId)) {
          incoming.push({ ...item, resumeOrigins: [...new Set([...(Array.isArray(item.resumeOrigins) ? item.resumeOrigins : []), sessionId])] })
          present.add(item.args.exchangeId)
        }
        changed = true
      }
      if (rest.length === 0) delete next[sessionId]
      else if (rest.length !== list.length) next[sessionId] = rest
    }
    if (!changed) return
    next[target] = incoming
    queued = next
    persist()
  }

  // A message is done with once a turn takes it up, or once it leaves the inbox untaken
  // while DS Bot runs: the user stopped the Bot, or DS Bot moved or withdrew it.
  ctx.on('agent/inbox/discarded', ({ agent, message } = {}) => {
    if (message?.source?.kind !== SOURCE_KIND || !message.source.exchangeId) return
    if (retained.get(agent?.id)?.has(message.source.exchangeId)) return
    forgetQueued(message.source.exchangeId, agent?.id)
  })
  // Exchanges a turn took up since this start, until the resends are done, so a resend
  // never repeats one.
  let taken = Object.keys(interrupted.queued).length > 0 ? new Set() : undefined
  // The first turn event of each Session since this start, until the noted turns are
  // picked up. A turn that ends, or still runs, before one starts here outlived the
  // last run: only DS Bot restarted (the plugin reloaded) and DSH went on.
  let firstTurn = Object.keys(interrupted.turns).length > 0 ? new Map() : undefined
  ctx.on('session/event', (session, event) => {
    const id = session?.id
    if (id === undefined) return
    if ((event.type === 'turn/start' || event.type === 'turn/end') && firstTurn?.has(id) === false) {
      firstTurn.set(id, { type: event.type, turn: event.data?.turn, reason: event.data?.reason })
    }
    if (event.type === 'user/message' && event.data?.source?.kind === SOURCE_KIND && event.data.source.exchangeId) {
      taken?.add(event.data.source.exchangeId)
      forgetQueued(event.data.source.exchangeId)
    }
    if (!rt.isBotSession(id)) return
    switch (event.type) {
      case 'turn/start': {
        const owner = rt.groupOwners.get(id)
        const botId = owner?.botId ?? rt.chatOwners.get(id)
        // turns.js runs first and has already claimed or restored the trigger.
        const info = rt.live.get(id)?.info
        update(id, () => ({ botId, ...(owner ? { roomId: owner.roomId } : {}), since: event.time ?? Date.now(), ...(info !== undefined ? { trigger: triggerOf(info) } : {}) }))
        break
      }
      case 'user/message': {
        if (event.data?.source?.kind !== SOURCE_KIND) break
        // turns.js, installed earlier, has already claimed the turn's trigger.
        const info = rt.live.get(id)?.info
        update(id, record => (record === undefined || record.trigger !== undefined || info === undefined ? record
          : { ...record, trigger: triggerOf(info), ...(info.resumed ? { resumed: true } : {}) }))
        break
      }
      case 'turn/end': {
        // DSH stops every turn as it shuts down; that one is picked up at the next start.
        const reason = event.data?.reason
        if (reason?.kind === 'aborted' && reason.reason?.kind === 'disposed') break
        update(id, () => undefined)
        break
      }
    }
  })

  // An approval the restart drops is named when the turn is picked up.
  rt.noteApproval = (sessionId, approval) => update(sessionId, record => (record === undefined ? record
    : approval === undefined ? (({ approval: _, ...rest }) => rest)(record) : { ...record, approval }))

  async function resumeTurn(sessionId, record) {
    // A restart does not prove whether an external effect happened. Keep the
    // original trigger and do not generate a second, unrelated exchange ID.
    holdTurn(sessionId, record)
    update(sessionId, current => current === undefined || current === record
      ? { ...record, recoveryHold: 'interrupted outcome unknown' } : current)
    await persist({ required: true })
    if (record.trigger?.reviewId) {
      await rt.goalReviewFailed?.(rt.roomOf(record.roomId), sessionId, record.trigger.reviewId)
    }
    rt.noteFailure?.({ level: 'warn', source: 'turn', code: 'RESUME_UNCERTAIN_HOLD', text: `Interrupted work in ${sessionId} was retained without replay; inspect its original result before recovery.`, sessionId })
  }
  rt.holdInterruptedTurn = resumeTurn

  // Where a queued note goes now: its Session if it still is one, else the
  // current Session of its Bot, or of its group when the message went to one.
  const sessionFor = (sessionId, args) => (rt.isBotSession(sessionId) ? sessionId
    : args?.roomId === undefined ? rt.chatOf(args?.toId) : rt.roomOf(args.roomId)?.sessions?.[args.toId])

  // A surviving inbox retains its original messages. Otherwise preserve each
  // uncertain delivery for reconciliation; do not create a replacement message.
  async function resendQueued(sessionId, list, held) {
    for (const item of list) if (taken?.has(item?.args?.exchangeId) === true) held.add(item.args.exchangeId)
    const fresh = list.filter(item => rt.botOf(item.args?.toId) !== undefined
      && sessionFor(sessionId, item.args) !== undefined && taken?.has(item.args.exchangeId) !== true)
    if (fresh.length === 0) return
    const agents = new Map()
    const logs = new Map()
    const logFor = id => {
      if (!logs.has(id)) logs.set(id, logOf(id))
      return logs.get(id)
    }
    for (const { args, resumeOrigins, recoveryHold } of fresh) {
      const target = sessionFor(sessionId, args)
      const room = args.roomId && args.role === 'room' ? rt.roomOf(args.roomId) : undefined
      const blocked = () => room !== undefined && rt.goalRecoveryBlocked?.(room, args.toId) === true
      if (!agents.has(target)) agents.set(target, await rt.resolveAgent(target))
      const agent = agents.get(target)
      if (args.reviewId && args.role === 'room') {
        const room = rt.roomOf(args.roomId)
        const stillAllowed = rt.goalReviewAllowed?.(room, args.reviewId) === true
        const waiting = [...(agent.inbox?.nextStep ?? []), ...(agent.inbox?.nextTurn ?? [])]
          .filter(message => message.source?.exchangeId === args.exchangeId)
        if (!stillAllowed) for (const message of waiting) agent.inbox?.remove?.(message.id)
        held.add(args.exchangeId)
        if (waiting.length === 0) {
          await rt.goalReviewFailed?.(room, target, args.reviewId)
          rt.noteFailure?.({ level: 'warn', source: 'goal', code: 'GOAL_REVIEW_UNCERTAIN', text: `Goal review ${args.reviewId} was not resent after restart; inspect the original delivery before recovery.` })
        }
        continue
      }
      if (blocked()) {
        held.add(args.exchangeId)
        const waiting = [...(agent.inbox?.nextStep ?? []), ...(agent.inbox?.nextTurn ?? [])]
          .filter(message => message.source?.exchangeId === args.exchangeId)
        rt.keepQueued(target, waiting, () => { for (const message of waiting) agent.inbox?.remove?.(message.id) })
        rt.noteFailure?.({ level: 'warn', source: 'turn', code: 'RESUME_STOPPED_HOLD', text: `Queued group delivery ${args.exchangeId} is held because its work is stopped or its stop state is unknown.`, sessionId: target })
        continue
      }
      const waiting = () => [...(agent.inbox?.nextStep ?? []), ...(agent.inbox?.nextTurn ?? [])]
        .some(message => message.source?.exchangeId === args.exchangeId)
      if (waiting()) { held.add(args.exchangeId); continue }
      if (recoveryHold === 'prepared') {
        held.add(args.exchangeId)
        const text = `Queued exchange ${args.exchangeId} was prepared for delivery, but its send outcome is unknown. Its recovery note is retained for review.`
        rt.warn('ds-bot: %s', text)
        rt.noteFailure?.({ level: 'warn', source: 'turn', code: 'RESUME_DELIVERY_UNCERTAIN', text, sessionId: target })
        continue
      }
      // A note can outlive the turn that took it: note writes run asynchronously.
      // An earlier user/message is not proof of completion (it may be a joined,
      // deferred or failed input), so retain it for reconciliation rather than
      // sending it again or dropping it. Include old parts after a Session move.
      const origins = [...new Set([sessionId, target, ...(Array.isArray(resumeOrigins) ? resumeOrigins : [])]
        .filter(id => typeof id === 'string' && id !== ''))]
      const histories = await Promise.all(origins.map(logFor))
      if (waiting() || taken?.has(args.exchangeId) === true) { held.add(args.exchangeId); continue }
      const seen = histories.some(events => events && historyMentionsSource(events, 'exchangeId', args.exchangeId))
      const unreadable = histories.some(events => events === undefined)
      // An absent event is not evidence of non-admission: a crash may have
      // discarded its unflushed log after the work already caused side effects.
      held.add(args.exchangeId)
      const why = seen ? 'it appeared in a previous turn or inbox; its outcome is not established'
        : unreadable ? 'a relevant Session history could not be read'
          : 'history does not establish whether its original admission happened'
      rt.warn('ds-bot: queued exchange %s for %s was not resent: %s; its recovery note is retained for review', args.exchangeId, target, why)
      rt.noteFailure?.({ level: 'warn', source: 'turn', code: 'RESUME_DELIVERY_UNCERTAIN', text: `Queued exchange ${args.exchangeId} was not resent: ${why}. Its recovery note is retained for review.`, sessionId: target })
    }
  }

  // The controller history may include unflushed events; it is diagnostic
  // evidence only and absence must never authorize a replay.
  async function logOf(sessionId) {
    const signal = AbortSignal.timeout(HISTORY_TIMEOUT_MS)
    return Promise.race([
      readRecoveryHistory(ctx.sessionController, sessionId, signal),
      new Promise(resolve => signal.addEventListener('abort', () => resolve(undefined), { once: true })),
    ])
  }

  // Preserve a bounded observation for the held-record UI. It cannot settle,
  // resume, or alter the part steward's consecutive-cutoff counter.
  async function observeInterruptedCutoff(sessionId, record, ended) {
    const exchangeId = record.trigger?.exchangeId
    if (ended?.reason?.kind !== 'max-tokens' || typeof exchangeId !== 'string') return
    const candidates = Object.entries(heldTurns).filter(([, held]) => held?.sessionId === sessionId
      && held.observation !== 'output-limit' && JSON.stringify(held.record) === JSON.stringify(record))
    if (candidates.length === 0) return
    const events = await logOf(sessionId)
    if (!observedOutputLimit(events, exchangeId, ended.turn, record.trigger?.role) || stopped || blocked !== undefined || rt.readOnly() !== undefined) return
    rt.requireHomeLock()
    let changed = false
    for (const [id, previous] of candidates) {
      if (heldTurns[id] !== previous) continue
      heldTurns[id] = { ...previous, observation: 'output-limit' }
      changed = true
    }
    if (!changed) return
    unknownQueueGeneration += 1n
    await persist({ required: true })
    rt.noteFailure?.({ level: 'warn', source: 'turn', code: 'MAX_TOKENS', sessionId,
      text: 'An observed turn containing this interrupted exchange reached the output limit; its work outcome remains unknown.' })
  }

  // Only a durable, unique, explicitly attributed reply to this exact work may
  // reconcile an old work item. A merged turn's assistant text is not a receipt.
  async function reconcileEnded(sessionId, record) {
    const workId = rt.workOf(record.trigger)
    const work = rt.state?.works?.[workId]
    const asker = rt.workAsker(workId)
    const sender = asker?.senderSessionId
    if (!work || !rt.ownsWork(record.botId, workId) || !sender || !rt.botOf(sender) || rt.waitsWork(workId)
      || !Array.isArray(work.results)
      || Object.values(rt.state.works).some(child => child?.parent === workId)) return
    const parent = work.parent === undefined ? undefined : rt.state.works[work.parent]
    if (work.parent !== undefined && (!parent || !Array.isArray(parent.open) || !parent.open.includes(workId)
      || !Array.isArray(parent.results) || parent.results.some(result => result?.id === workId))) return
    const parentBefore = JSON.stringify(parent)
    const name = rt.botOf(record.botId)?.name ?? 'The other Bot'
    const destination = rt.roomOf(asker.senderRoomId)?.sessions?.[sender] ?? rt.chatOf(sender)
    if (!destination || rt.selfOf(sessionId) !== record.botId) return
    const before = JSON.stringify(work)
    const signal = AbortSignal.timeout(HISTORY_TIMEOUT_MS)
    const reply = await Promise.race([
      readDurableReply(ctx, destination, workId, record.botId, SOURCE_KIND, signal),
      new Promise(resolve => signal.addEventListener('abort', () => resolve(undefined), { once: true })),
    ])
    if (reply === undefined || reply.length > TEXT_KEPT || !replyContainsInlineResults(reply, work.results, name)
      || stopped || blocked !== undefined || rt.readOnly() !== undefined) return
    rt.requireHomeLock()
    if (!rt.ownsWork(record.botId, workId) || rt.waitsWork(workId) || JSON.stringify(rt.state?.works?.[workId]) !== before
      || JSON.stringify(work.parent === undefined ? undefined : rt.state.works[work.parent]) !== parentBefore
      || (rt.botOf(record.botId)?.name ?? 'The other Bot') !== name || !rt.botOf(sender)
      || (rt.roomOf(asker.senderRoomId)?.sessions?.[sender] ?? rt.chatOf(sender)) !== destination
      || Object.values(rt.state.works).some(child => child?.parent === workId)) return
    rt.closeWork?.(workId, name, reply)
    await rt.save({ required: true, durable: true })
    return true
  }

  // Retry held records with positive evidence only; a missing receipt stays held.
  // Clearing the recovery note is separate from the already-durable work save.
  async function clearReconciled(sessionId, record) {
    const exchangeId = record.trigger?.exchangeId
    if (Object.values(queued).some(list => Array.isArray(list) && list.some(item => item?.args?.exchangeId === exchangeId))) return
    let changed = false
    for (const [id, held] of Object.entries(heldTurns)) {
      if (held?.sessionId === sessionId && JSON.stringify(held.record) === JSON.stringify(record)) {
        delete heldTurns[id]
        changed = true
      }
    }
    const current = turns[sessionId]
    if (current?.recoveryHold) {
      const { recoveryHold: _, ...plain } = current
      if (JSON.stringify(plain) === JSON.stringify(record)) update(sessionId, () => undefined)
    }
    if (changed) { unknownQueueGeneration += 1n; await persist({ required: true }) }
  }

  let scanning = false
  async function scanHeld() {
    if (scanning || stopped || blocked !== undefined || rt.readOnly() !== undefined) return
    scanning = true
    try {
      for (const held of Object.values(heldTurns)) {
        if (stopped || blocked !== undefined || rt.readOnly() !== undefined) break
        if (await reconcileEnded(held.sessionId, held.record)) await clearReconciled(held.sessionId, held.record)
      }
    } finally { scanning = false }
  }

  async function resumeAll() {
    await rt.load()
    if (rt.readOnly() !== undefined) return
    const { turns: noted, queued: dropped } = interrupted
    interrupted = { turns: {}, queued: {} }
    // What the last run still had on the way is noted again first, under the
    // Session it would go to now: nothing is cleared before it is handed over.
    // A Bot that is gone takes its notes with it; what a turn already read here
    // is done with.
    const pending = queued
    for (const [sessionId,list] of Object.entries(pending)) if (Array.isArray(list)) for (const item of list) queueChanged(item?.args,sessionId)
    queued = {}
    for (const [oldId, list] of Object.entries(pending)) {
      if (!Array.isArray(list)) { queued = { ...queued, [oldId]: list }; continue }
      for (const item of list) {
        if (item?.args?.exchangeId !== undefined && taken?.has(item.args.exchangeId) === true) continue
        // Preserve unresolved notes even when their recipient was removed or the
        // record lacks an exchange id. Neither condition proves completion.
        if (!item?.args || item.args.exchangeId === undefined || rt.botOf(item.args.toId) === undefined) {
          queued = { ...queued, [oldId]: [...(queued[oldId] ?? []), item] }
          continue
        }
        const key = sessionFor(oldId, item.args) ?? oldId
        const resumeOrigins = [...new Set([...(Array.isArray(item.resumeOrigins) ? item.resumeOrigins : []), oldId])]
        queued = { ...queued, [key]: [...(queued[key] ?? []), { ...item, resumeOrigins }] }
      }
    }
    persist()
    // Agents and inboxes are read before anything wakes their Sessions.
    const cut = []
    for (const [sessionId, record] of Object.entries(noted)) {
      const first = firstTurn.get(sessionId)
      if (first?.type === 'turn/end') {
        // The turn ended while DS Bot was not watching it: what it did is settled from
        // the Session's durable log.
        await observeInterruptedCutoff(sessionId, record, first).catch(error => rt.warn('ds-bot: recording the observed output limit for %s failed: %s', sessionId, error))
        const settled = await reconcileEnded(sessionId, record).catch(error => { rt.warn('ds-bot: settling the work of %s failed: %s', sessionId, error); return false })
        if (settled) await clearReconciled(sessionId, record)
        continue
      }
      // Still running: noted again, as if it had started here.
      if (first === undefined && (await rt.resolveAgent(sessionId).catch(() => undefined))?.status === 'running') update(sessionId, () => record)
      else cut.push([sessionId, record])
    }
    firstTurn = undefined
    const held = new Set()
    for (const [sessionId, list] of Object.entries(dropped)) {
      if (!Array.isArray(list)) continue
      await resendQueued(sessionId, list, held).catch(error => {
        for (const item of list) if (typeof item?.args?.exchangeId === 'string') held.add(item.args.exchangeId)
        rt.warn('ds-bot: sending again what %s was sent failed: %s', sessionId, error)
      })
    }
    taken = undefined
    for (const [sessionId, record] of cut) {
      if (held.has(record.trigger?.exchangeId)) {
        // Do not bypass the queued-delivery hold by starting the same exchange
        // through the interrupted-turn recovery path.
        update(sessionId, current => current ?? record)
        continue
      }
      await resumeTurn(sessionId, record).catch(error => rt.warn('ds-bot: picking up the turn of %s failed: %s', sessionId, error))
    }
    // What a group's members were asked for and will not pick up is settled now.
    await rt.settleRoomBatches?.()
    await scanHeld()
  }

  ctx.effect(() => {
    const pending = Object.keys(interrupted.turns).length > 0 || Object.keys(interrupted.queued).length > 0
    const reportHolds = () => {
      const count = Object.keys(heldTurns).length
      if (!count) return
      rt.warn('ds-bot: %d interrupted turn record(s) remain held in %s; inspect their original results before recovery', count, file)
      rt.noteFailure?.({ level: 'warn', source: 'turn', code: 'RESUME_HELD_RECORDS', text: `${count} interrupted turn record(s) remain held in recovery notes; inspect their original results before recovery.` })
    }
    // With nothing to pick up, the group batches a restart left are settled at once.
    const timer = pending
      ? setTimeout(() => { reportHolds(); void resumeAll().catch(error => rt.warn('ds-bot: picking up interrupted work failed: %s', error)) }, RESUME_DELAY_MS)
      : setTimeout(() => { reportHolds(); void rt.load().then(async () => { await rt.settleRoomBatches?.(); await scanHeld() }).catch(error => rt.warn('ds-bot: settling group batches failed: %s', error)) }, 0)
    timer?.unref?.()
    const retry = setInterval(() => { void scanHeld().catch(error => rt.warn('ds-bot: reviewing held work failed: %s', error)) }, 30 * 60 * 1000)
    retry?.unref?.()
    // What the turns stopped by this shutdown left stays as last noted.
    return () => {
      stopped = true
      clearTimeout(timer)
      clearInterval(retry)
      return writing
    }
  }, 'ds-bot: resume interrupted turns')
}
