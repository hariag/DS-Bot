// Resume: Bot work that DeepSeek Harness dropped when it closed or restarted. DSH closes
// a turn it never finished as interrupted when the Session next opens, and a clean
// shutdown also cancels the messages still waiting in a Session's inbox; nothing would
// ever run either again, and whoever waited for them was not told. DS Bot notes each
// running Bot turn and each message it delivers until a turn takes it up, in
// inflight.json; what is still noted at the next start is picked up once.
//
// A turn that ends while DS Bot is not watching it (the plugin reloaded, DSH went on)
// is settled from the Session's durable log: an answer that was produced goes to the Bot
// that waits for it, and an outcome that cannot be read is said to be unknown. The
// request itself is never sent again there.
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { HISTORY_TIMEOUT_MS, MESSAGE_INLINE_MAX, SOURCE_KIND, STEER_CUT } from './constants.js'
import { answerSender, cutOffText, failureLine, turnFailure } from './turns.js'
import { replaceFile } from './files.js'
import { textOf } from './text.js'

// Long enough for DSH to finish opening its workspaces after a start.
export const RESUME_DELAY_MS = 3000

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
})

const readNotes = (file) => {
  let raw
  try {
    raw = readFileSync(file, 'utf8')
  } catch (error) {
    return error?.code === 'ENOENT' ? { turns: {}, queued: {}, raw: undefined }
      : { turns: {}, queued: {}, blocked: error?.code ?? error?.name ?? 'read error' }
  }
  try {
    const parsed = JSON.parse(raw)
    const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
    if (!object(parsed) || (parsed.turns !== undefined && !object(parsed.turns)) || (parsed.queued !== undefined && !object(parsed.queued))) throw new Error('invalid notes')
    return { turns: parsed.turns ?? {}, queued: parsed.queued ?? {}, raw }
  } catch {
    return { turns: {}, queued: {}, blocked: 'invalid recovery notes' }
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
  let turns = {}
  // A new delivery can persist before recovery runs; it must keep the old queue.
  /** @type {Record<string, {at:number, args:any}[]>} deliveries no turn has taken up, by Session */
  let queued = interrupted.queued
  let writing = Promise.resolve()
  let stopped = false
  let latest
  let due = false
  let pending
  rt.onHomeDrain(() => writing)
  const persist = ({ required = false } = {}) => {
    // Only the host that saves the team runs its work again.
    if (stopped || blocked !== undefined || rt.readOnly() !== undefined) {
      return required ? Promise.reject(new Error('Recovery notes cannot be saved by this host.')) : writing
    }
    latest = JSON.stringify({ turns, queued })
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
  const update = (id, change) => {
    const next = change(turns[id])
    if (next === turns[id]) return
    turns = { ...turns }
    if (next === undefined) delete turns[id]
    else turns[id] = next
    persist()
  }
  const forgetQueued = (exchangeId, onlySession) => {
    for (const [sessionId, list] of Object.entries(queued)) {
      if (onlySession !== undefined && sessionId !== onlySession) continue
      const at = list.findIndex(item => item.args.exchangeId === exchangeId)
      if (at === -1) continue
      const rest = list.toSpliced(at, 1)
      queued = { ...queued }
      if (rest.length === 0) delete queued[sessionId]
      else queued[sessionId] = rest
      persist()
      return
    }
  }
  const markSent = exchangeId => {
    for (const [sessionId, list] of Object.entries(queued)) {
      const at = list.findIndex(item => item.args.exchangeId === exchangeId)
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
  rt.deliver = async (args) => {
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
    queued = { ...queued, [sessionId]: [...(queued[sessionId] ?? []), { at: Date.now(), args: noted, recoveryHold: 'prepared' }] }
    await persist({ required: true })
    if (stopped) throw new Error('Bot delivery stopped after its recovery note was saved; the note is retained for recovery.')
    rt.requireHomeLock()
    try {
      const result = await deliver(noted)
      markSent(noted.exchangeId)
      return result
    } catch (error) {
      // The delivery outcome can be uncertain: its prepared note stays for review.
      // One whose Bot is gone is dropped, since it can never be sent.
      if (rt.botOf(noted.toId) === undefined) forgetQueued(noted.exchangeId)
      throw error
    }
  }

  // What a Session was sent and no turn has read yet.
  rt.unreadOf = sessionId => (queued[sessionId] ?? []).map(item => item.args)
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
    const incoming = [...(next[target] ?? [])]
    const present = new Set(incoming.map(item => item.args.exchangeId))
    let changed = false
    for (const [sessionId, list] of Object.entries(queued)) {
      if (sessionId === target) continue
      const rest = []
      for (const item of list) {
        if (!ids.has(item.args.exchangeId)) { rest.push(item); continue }
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
    const bot = rt.botOf(record.botId)
    if (bot === undefined) return
    const text = resumeText(record)
    if (record.roomId !== undefined) {
      const room = rt.roomOf(record.roomId)
      if (room === undefined || !room.members.includes(bot.id)) return
      await rt.postToRoom(room, bot, '', { resumed: true, quiet: true, ...(record.resumed ? { again: true } : {}) })
      // A turn already picked up once and cut off again stays stopped: a restart loop
      // must not run it forever.
      if (record.resumed) return
      await rt.deliver({ toId: bot.id, sessionId: room.sessions?.[bot.id] ?? sessionId, role: 'room', roomId: room.id, note: 'picking up after a restart', resumed: true, text, ...(record.trigger?.askedBy ? { askedBy: record.trigger.askedBy } : {}) })
      return
    }
    if (record.resumed) return
    const trigger = record.trigger
    if ((trigger?.role === 'request' || trigger?.role === 'stopped') && trigger.senderSessionId && trigger.audience !== 'user' && rt.botOf(trigger.senderSessionId)) {
      // The sender still waits for this turn's answer, so it goes on under the same exchange.
      await rt.deliver({ fromId: trigger.senderSessionId, toId: bot.id, role: trigger.role, ...(trigger.exchangeId ? { exchangeId: trigger.exchangeId } : {}), ...(trigger.senderRoomId ? { fromRoomId: trigger.senderRoomId } : {}), resumed: true, text })
      return
    }
    // A turn that went on with work another Bot asked for still owes that Bot its answer.
    await rt.deliver({ toId: bot.id, role: 'resume', resumed: true, text, ...(trigger?.work ? { work: trigger.work } : {}) })
  }

  // Where a queued note goes now: its Session if it still is one, else the
  // current Session of its Bot, or of its group when the message went to one.
  const sessionFor = (sessionId, args) => (rt.isBotSession(sessionId) ? sessionId
    : args?.roomId === undefined ? rt.chatOf(args?.toId) : rt.roomOf(args.roomId)?.sessions?.[args.toId])

  // A hard stop keeps the inbox, which the Session runs once it wakes; only what DSH
  // cancelled is sent again. The notes stay queued until a turn takes the messages
  // up, so a send that fails here, or a Session that cannot be opened, leaves them
  // for the next start instead of losing them.
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
      if (!agents.has(target)) agents.set(target, await rt.resolveAgent(target))
      const agent = agents.get(target)
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
      const seen = histories.some(events => events?.some(event => event.type === 'user/message' && event.data?.source?.exchangeId === args.exchangeId))
      const unreadable = histories.some(events => events === undefined)
      if (seen || unreadable) {
        held.add(args.exchangeId)
        const why = seen ? 'it appeared in a previous turn; its outcome is not established' : 'a relevant Session history could not be read'
        rt.warn('ds-bot: queued exchange %s for %s was not resent: %s; its recovery note is retained for review', args.exchangeId, target, why)
        rt.noteFailure?.({ level: 'warn', source: 'turn', code: 'RESUME_DELIVERY_UNCERTAIN', text: `Queued exchange ${args.exchangeId} was not resent: ${why}. Its recovery note is retained for review.`, sessionId: target })
        continue
      }
      if (taken?.has(args.exchangeId) === true) {
        forgetQueued(args.exchangeId)
        continue
      }
      // A request that waited through a restart reaches its target late: the work
      // it is for is marked, so the answer that comes back says so.
      if (args.role === 'request' || args.role === 'stopped') rt.lateWork?.(args.exchangeId)
      await deliver({ ...args, sessionId: sessionFor(sessionId, args), steer: false, resent: true })
        .catch(error => rt.warn('ds-bot: sending again what %s was sent failed: %s', sessionId, error))
    }
  }

  // A Session's durable log, as DSH keeps it: what happened there, and what it said.
  // Undefined when this DSH cannot read it, or when the Session is gone.
  async function logOf(sessionId) {
    const inspect = ctx.sessionController?.inspect
    if (typeof inspect !== 'function') return undefined
    const seen = await inspect(sessionId, AbortSignal.timeout(HISTORY_TIMEOUT_MS)).catch(() => undefined)
    return Array.isArray(seen?.events) ? seen.events : undefined
  }

  // A turn that ended while DS Bot was not watching it: its answer may exist and never
  // have gone to the Bot that waits for it. The Session's durable log says what it did;
  // the work it was for is settled once, the way a finished turn settles it.
  async function reconcileEnded(sessionId, record, ended) {
    const trigger = record.trigger
    if (trigger === undefined) return
    const workId = rt.workOf(trigger)
    if (!rt.ownsWork(record.botId, workId)) return
    const exchangeId = trigger.exchangeId
    const asker = rt.workAsker(workId)
    const sender = asker?.senderSessionId
    if (exchangeId === undefined || sender === undefined || rt.botOf(sender) === undefined) return
    const name = rt.botOf(rt.selfOf(sessionId))?.name ?? 'The other Bot'
    // DSH stopped that turn as it shut down: it is picked up at the next start.
    if (ended.reason?.kind === 'aborted' && ended.reason.reason?.kind === 'disposed') {
      update(sessionId, () => record)
      return
    }
    const events = await logOf(sessionId)
    if (events === undefined) {
      // The record of that work cannot be read: whether it answered cannot be
      // established. The sender is told that, and the work is not run again.
      const why = 'the record of that work could not be read'
      const text = `${name} could not answer your message: ${why}, so what it did is unknown (its session is ${sessionId}). It may have done part of the work. Tell the user if it matters; do not run the work again without asking.`
      const room = rt.roomOf(rt.groupOwners.get(sessionId)?.roomId)
      rt.noteFailure?.({
        level: 'warn',
        source: 'turn',
        text: `the result of the work ${name} was given is unknown`,
        bot: name,
        where: room === undefined ? 'own chat' : `group "${room.name}"`,
        sessionId,
      })
      answerSender(rt, sessionId, asker, text)
      return
    }
    const turn = turnOf(events, exchangeId)
    // The request was never taken up: it is still waiting, and the delivery that is
    // waiting for it keeps what it had.
    if (turn === undefined) return
    const said = turn.texts.join('\n\n')
    // The answer went up in another run: the work closes with what it said, and
    // nothing is sent twice.
    const back = rt.roomOf(asker.senderRoomId)?.sessions?.[sender]
    const sent = await logOf(back ?? rt.chatOf(sender))
    if (sent !== undefined && answeredIn(sent, workId)) {
      rt.closeWork?.(workId, name, rt.answerText(workId, said, name))
      return
    }
    const reason = turn.reason
    // A turn that went on to a fresh part goes on there; it is not settled here.
    if (reason?.kind === 'blocked') return
    // The turn was cut off before it finished: the work is picked up again, as after
    // a restart that cut it off.
    if (reason === undefined || reason.kind === 'interrupted') {
      await resumeTurn(sessionId, record)
      return
    }
    if (reason.kind === 'error') {
      const failure = turnFailure(reason.error)
      answerSender(rt, sessionId, asker, `${name} could not answer your message: its model call failed (${failureLine(failure)}). Tell the user if it matters; do not retry right away.`)
      return
    }
    if (reason.kind === 'aborted') {
      // The turn was stopped before it could answer: the sender is told, as it is told
      // when DS Bot watches the turn end.
      answerSender(rt, sessionId, asker, `${name} was stopped before it could answer your message.`)
      return
    }
    // A turn cut off at the output limit is not a finish: the answer says so, and the
    // diagnostics record it, with the route the Session's log holds for it.
    const cutOff = reason?.kind === 'max-tokens'
    const withoutText = cutOff && turn.texts.length === 0
    if (cutOff) {
      rt.noteCutOffTurn?.(sessionId, { withoutText })
      const context = events.findLast(event => event?.type === 'request/context')?.data
      const ref = context?.provider && context?.model ? `${context.provider}/${context.model}` : undefined
      const room = rt.roomOf(rt.groupOwners.get(sessionId)?.roomId)
      rt.noteFailure?.({
        level: 'warn',
        source: 'turn',
        code: 'MAX_TOKENS',
        text: `${withoutText
          ? 'the turn was cut off at the output limit before it wrote anything'
          : 'the turn was cut off at the output limit, so its answer is not complete'}${ref ? ` (${ref})` : ''}`,
        bot: name,
        where: room === undefined ? 'own chat' : `group "${room.name}"`,
        sessionId,
      })
    }
    const answer = cutOff ? cutOffText(said) : said
    // The turn ended with what it said: the answer goes up the way a finished turn's
    // does, with the results that came back for it and the text it held. A work that
    // still waits for what it handed on keeps its part until that comes back.
    if (rt.waitsWork(workId)) {
      rt.holdWork(workId, answer)
      return
    }
    const text = rt.answerText(workId, answer, name)
    const long = text.length > MESSAGE_INLINE_MAX ? await rt.attachLong(text, `Answer from ${name}.txt`) : undefined
    answerSender(rt, sessionId, asker, text, long)
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
    queued = {}
    for (const [oldId, list] of Object.entries(pending)) {
      if (!Array.isArray(list)) continue
      for (const item of list) {
        if (item?.args?.exchangeId === undefined || taken?.has(item.args.exchangeId) === true || rt.botOf(item.args.toId) === undefined) continue
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
        await reconcileEnded(sessionId, record, first).catch(error => rt.warn('ds-bot: settling the work of %s failed: %s', sessionId, error))
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
  }

  ctx.effect(() => {
    const pending = Object.keys(interrupted.turns).length > 0 || Object.keys(interrupted.queued).length > 0
    const timer = pending ? setTimeout(() => void resumeAll().catch(error => rt.warn('ds-bot: picking up interrupted work failed: %s', error)), RESUME_DELAY_MS) : undefined
    timer?.unref?.()
    // What the turns stopped by this shutdown left stays as last noted.
    return () => {
      stopped = true
      clearTimeout(timer)
      return writing
    }
  }, 'ds-bot: resume interrupted turns')
}
