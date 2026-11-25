// A managed occurrence is a clock tick for one room. DSH persists the reminder
// before its first step. Only the host can turn that tick into an admin review.
import { createHash } from 'node:crypto'

const contextSources = new Set(['runtime-context', 'time-context', 'ds-bot-time-context',
  'ds-bot-group-memory', 'ds-bot-memory-update', 'ds-bot-memory-recall'])
const contextOnly = message => (message.source?.form === 'snapshot' && contextSources.has(message.source.kind))
  || (message.source?.form === 'catalog' && message.source.kind === 'skill-catalog')

// DSH injects this administrative notice into a session without waking it.
// Unlike a reminder, it can stay queued in an otherwise idle group indefinitely.
export function scheduleChangeId(message) {
  if (message?.source?.kind !== 'schedule' || message.content?.length !== 1 || message.content[0].type !== 'text') return
  const text = message.content[0].text
  if (!text.startsWith('[SCHEDULE CHANGE]\n') || !text.includes('This notice is not a delivery of the task and needs no action.')) return
  try {
    const id = JSON.parse(/^schedule_id_json: (.+)$/m.exec(text)?.[1])
    if (typeof id === 'string' && id) return id
  } catch { /* Treat an unfamiliar native message as possible work. */ }
}

function reminder(message) {
  if (message?.source?.kind !== 'schedule' || message.content?.length !== 1 || message.content[0].type !== 'text') return
  const text = message.content[0].text
  try {
    if (text.startsWith('[SCHEDULE REMINDER BATCH]\n')) {
      const line = /^reminders_json: (.+)$/m.exec(text)
      if (!line) return
      const entries = JSON.parse(line[1])
      if (Array.isArray(entries) && entries.length && entries.every(valid)) return { entries, line, text }
    } else if (text.startsWith('[SCHEDULE REMINDER]\n')) {
      const entry = { schedule_id: JSON.parse(/^schedule_id_json: (.+)$/m.exec(text)?.[1]),
        occurrence_at: /^occurrence_at: (.+)$/m.exec(text)?.[1], reminder_prompt: JSON.parse(/^reminder_prompt_json: (.+)$/m.exec(text)?.[1]) }
      if (valid(entry)) return { entries: [entry] }
    }
  } catch { /* DSH owns unfamiliar reminder formats. */ }
}
const valid = entry => typeof entry?.schedule_id === 'string' && typeof entry.occurrence_at === 'string'
  && Number.isFinite(Date.parse(entry.occurrence_at)) && typeof entry.reminder_prompt === 'string'

function keepEntries(message, frame, accept) {
  const kept = frame.entries.filter(accept)
  if (kept.length === frame.entries.length) return message
  if (!kept.length) return
  const { text, line } = frame
  const remaining = text.slice(0,line.index) + 'reminders_json: ' + JSON.stringify(kept) + text.slice(line.index + line[0].length)
  return { ...message, content: [{ ...message.content[0], text: remaining }] }
}

export function installRoomScheduleDelivery(rt) {
  const skippedTurns = new Map()
  const known = id => rt.isManagedRoomScheduleId?.(id) === true
  function bindingFor(entry, sessionId) {
    const binding = rt.managedRoomSchedule?.(entry.schedule_id, sessionId)
    if (binding && binding.prompt === entry.reminder_prompt) return binding
  }
  const busy = (room, messageId, opening) => !room || rt.readOnly?.() !== undefined || rt.roomBusyForPatrol(room, messageId, opening)

  rt.ctx.on('schedule/resolve-agent', async (sessionId, next) => {
    const [agent] = await Promise.all([next(), rt.load()])
    // Catalog reads must not edit schedules while DSH owns its delivery lock.
    if (rt.roomOf(sessionId)) await rt.refreshRoomScheduleBindings?.()
    let skipped = false
    return new Proxy(agent, { get(target, property) {
      if (property === 'followup') return message => {
        const frame = reminder(message)
        const ordinary = frame?.entries.some(entry => !known(entry.schedule_id))
        const remaining = frame ? keepEntries(message, frame, entry => {
          if (!known(entry.schedule_id)) return true
          const binding = bindingFor(entry, sessionId)
          if (!binding) return false
          const room = rt.roomOf(binding.roomId)
          const occupied = ordinary || busy(room, message.id)
          if (occupied) retryScheduledReview(room, binding, JSON.stringify([entry.schedule_id, entry.occurrence_at]))
          return !occupied
        }) : message
        skipped = !remaining
        if (remaining) target.followup(remaining)
      }
      if (property === 'whenIdle' && skipped) return () => Promise.resolve()
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    } })
  }, { prepend: true })

  async function checkBoardWithoutGoal(room, binding, key, messageId, root) {
    const [scheduleId] = JSON.parse(key)
    const openingSessionId = messageId === undefined ? undefined : root.id
    const blocker = target => {
      const active = rt.managedRoomSchedule?.(scheduleId, root.id)
      const occurrence = room.scheduledReviewOccurrence
      if (disposed || rt.readOnly?.() !== undefined || active?.roomId !== room.id
        || active.adminId !== binding.adminId || active.prompt !== binding.prompt
        || rt.roomOf(room.id) !== room || room.admin !== binding.adminId || room.goal
        || rt.sessionOfRoom(room) !== root.id || occurrence?.key !== key || occurrence.outcome !== 'no-goal'
        || (target !== undefined && room.sessions?.[binding.adminId] !== target)) return 'invalid'
      if (busy(room, messageId, openingSessionId)) return 'busy'
    }
    const beforeResolve = blocker()
    if (beforeResolve) return beforeResolve
    const target = await rt.ensureGroupTaskSession(room.id, binding.adminId)
    if (!target) return 'invalid'
    const beforeSend = blocker(target)
    if (beforeSend) return beforeSend
    const text = '本群尚无群目标。按已有任务看板和授权推进，记录结果或阻碍及负责人；没有可办事项时静默结束。\n' + (binding.instructions ?? binding.prompt)
    const exchangeId = createHash('sha256').update(JSON.stringify([room.id,key])).digest('hex')
    const rejected = new Error('The group or its administrator cannot receive the board check now')
    let beforeAdmission
    try {
      await rt.deliver({ roomId:room.id, toId:binding.adminId, sessionId:target, role:'room', fromName:'DS Bot', text,
        exchangeId, note:'scheduled group board check' }, {
        beforeAdmission() {
          beforeAdmission = blocker(target)
          if (beforeAdmission) throw rejected
        },
      })
      return 'delivered'
    } catch (error) {
      if (error !== rejected) throw error
      rt.forgetDelivery?.(exchangeId)
      return beforeAdmission
    }
  }

  // A managed reminder that lands together with ordinary room traffic is stripped
  // from that turn. Silently dropping it loses the whole cycle (the room is busy
  // nearly all day), so ask for the review again as a normal nudge once the room is
  // quiet. The occurrence key keeps retries idempotent; the next scheduled tick is
  // still the fallback if every retry finds the room busy.
  const retriggers = new Map()
  let disposed = false
  rt.ctx.effect?.(() => () => {
    disposed = true
    for (const retry of retriggers.values()) clearTimeout(retry.timer)
    retriggers.clear()
  }, 'ds-bot: managed room schedule retries')
  function retryScheduledReview(room, binding, key, tries = 0, boardOnly = false) {
    if (disposed || rt.readOnly?.() !== undefined || !room || tries >= 6) return
    const pending = retriggers.get(key)
    if (pending) {
      if (boardOnly) pending.boardOnly = true
      return
    }
    const retry = { boardOnly }
    retry.timer = setTimeout(() => {
      if (disposed) return
      void (async () => {
        // `load()` may adopt a newer state object between the schedule and this timer.
        // Reusing the captured room or agent would fail the review's object/session
        // identity checks and silently consume every delayed retry as invalid.
        await rt.load()
        await rt.refreshRoomScheduleBindings?.()
        const currentRoom = rt.roomOf(room.id)
        if (disposed || rt.readOnly?.() !== undefined || !currentRoom) return 'invalid'
        const sessionId = rt.sessionOfRoom(currentRoom)
        if (!sessionId) return 'invalid'
        const identity = JSON.parse(key)
        const currentBinding = rt.managedRoomSchedule?.(identity[0], sessionId)
        if (!currentBinding || currentBinding.roomId !== currentRoom.id
          || currentBinding.adminId !== binding.adminId || currentBinding.prompt !== binding.prompt) return 'invalid'
        const currentAgent = await rt.resolveAgent(sessionId)
        if (disposed || currentAgent?.session?.id !== sessionId) return 'invalid'
        // A no-goal occurrence already owns the durable claim. If the room turns
        // busy before delivery, retry only its board check, never the claim.
        const outcome = retry.boardOnly ? 'no-goal' : await rt.runScheduledRoomReview(currentRoom, key, currentAgent, undefined, currentBinding.instructions ?? currentBinding.prompt, undefined)
        if (outcome === 'no-goal') retry.boardOnly = true
        return retry.boardOnly ? checkBoardWithoutGoal(currentRoom, currentBinding, key, undefined, currentAgent) : outcome
      })()
        .then(outcome => {
          retriggers.delete(key)
          if (!disposed && (outcome === 'busy' || outcome === 'pending')) retryScheduledReview(room, binding, key, tries + 1, retry.boardOnly)
        })
        .catch(error => {
          retriggers.delete(key)
          rt.warn?.('ds-bot: deferred group check in %s failed: %s', room.id, error)
        })
    }, 15000 + tries * 15000)
    retry.timer.unref?.()
    retriggers.set(key, retry)
  }

  rt.ctx.on('agent/pre-step', async ({ agent, messages, step, turn }, next) => {
    if (!messages?.some(message => message.source?.kind === 'schedule')) return next()
    await rt.load()
    if (rt.roomOf(agent.id)) await rt.refreshRoomScheduleBindings?.()
    const decision = await next()
    if (decision.kind !== 'enter') return decision
    const claimed = new Set(messages.filter(m => m.source?.kind === 'schedule').map(m => m.id))
    const work = [], retained = []
    let changed = false
    for (const message of decision.messages) {
      const frame = claimed.has(message.id) && reminder(message)
      if (!frame) { retained.push(message); continue }
      const remaining = keepEntries(message, frame, entry => {
        if (!known(entry.schedule_id)) return true
        const binding = bindingFor(entry, agent.id)
        if (binding) work.push({ message, entry, binding })
        return false
      })
      if (remaining) retained.push(remaining)
      if (remaining !== message) changed = true
    }
    if (!changed) return decision
    // A native change notice is passive metadata. Preserve unrelated notices in
    // the ordinary turn, and consume the managed timer's own when both arrive.
    const ownChange = message => {
      const id = scheduleChangeId(message)
      return id && rt.managedRoomSchedule?.(id, agent.id)
    }
    if (step !== 1 || retained.some(message => !contextOnly(message) && !ownChange(message))) {
      for (const { entry, binding } of work) {
        const room = rt.roomOf(binding.roomId)
        if (room) retryScheduledReview(room, binding, JSON.stringify([entry.schedule_id, entry.occurrence_at]))
      }
      return { ...decision, messages: retained }
    }
    // All managed reminders in this turn are consumed. Even a recovered batch
    // of ticks for the same room may open at most one administrative check.
    const latest = work.sort((a,b) => Date.parse(b.entry.occurrence_at) - Date.parse(a.entry.occurrence_at))[0]
    if (latest) {
      const { message, entry, binding } = latest
      const room = rt.roomOf(binding.roomId)
      const key = JSON.stringify([entry.schedule_id,entry.occurrence_at])
      if (!busy(room, message.id, agent.id)) {
        const result = await rt.runScheduledRoomReview(room, key, agent, message.id, binding.instructions ?? binding.prompt, message)
        // Use this claimed native step for the verified root relay. DSH can
        // park a new followup forever if the opening step returns empty.
        if (result?.outcome === 'admitted' && result.message) {
          return { ...decision, messages: [result.message, ...retained.filter(contextOnly)] }
        }
        if (result === 'busy' || result === 'pending') retryScheduledReview(room, binding, key)
        if (result === 'no-goal' && await checkBoardWithoutGoal(room, binding, key, message.id, agent) === 'busy') {
          retryScheduledReview(room, binding, key, 0, true)
        }
      } else retryScheduledReview(room, binding, key)
    }
    skippedTurns.set(agent.id, turn)
    return { ...decision, messages: [] }
  }, { prepend: true })

  rt.consumeSkippedPatrolTurn = (sessionId, turn) => Number.isSafeInteger(turn) && skippedTurns.get(sessionId) === turn && skippedTurns.delete(sessionId)
}

// Plugin modules are installed through the shared `install(rt)` contract.
export { installRoomScheduleDelivery as install }
