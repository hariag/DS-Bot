// DSH's recurring schedule advances once its followup returns. Filter this one
// occurrence before the real Agent is woken so a busy room never receives it.
const TITLED_PATROL = /^(?:巡检$|patrol$|DSBOT-PATROL\/|(?:定时|定期|例行|增量|群)巡检(?:$|[：:\s])|(?:scheduled|periodic|routine) patrol(?:$|[\s:]))/i
const PATROL_PROMPT = /^(?:巡检[。.!！]?\s*$|patrol[.!]?\s*$|[【[][^】\]\n]{0,32}(?:巡检|patrol)[】\]]|(?:定时|定期|例行|增量|群)巡检(?:$|[。：:\s])|(?:scheduled|periodic|routine) patrol(?:$|[.:\s])|你是[^。\n]{1,40}。\s*(?:这是项目[^。\n]{1,80}的定时兜底，不是全量重复巡检|此定时回合(?:作为交接与设计质量的兜底，不是全量重复巡检|仅作为未闭环事项的低频兜底，不做全量角色巡检)))/i

// The normal pre-step assembly decorates claimed inputs with these snapshots.
// Losing the only input also removes its context. Unrecognized additions stay.
const CONTEXT_SOURCES = new Set(['runtime-context', 'time-context', 'ds-bot-time-context',
  'ds-bot-group-memory', 'ds-bot-memory-update', 'ds-bot-memory-recall'])

function reminder(message) {
  if (message?.source?.kind !== 'schedule' || message.content?.length !== 1 || message.content[0].type !== 'text') return
  const text = message.content[0].text
  if (typeof text !== 'string') return
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
  } catch { /* Leave unfamiliar schedule frames intact. */ }
}

const valid = entry => typeof entry?.schedule_id === 'string' && entry.schedule_id.length > 0
  && typeof entry.occurrence_at === 'string' && entry.occurrence_at.length > 0 && typeof entry.reminder_prompt === 'string'

export function installScheduledPatrol(rt, schedule) {
  const { ctx } = rt
  const skippedTurns = new Map()
  let titles = new Map(), reading, generation = 0
  // A catalog snapshot contains titles, which DSH omits from the reminder frame.
  // Refresh asynchronously on catalog changes and coalesce pending notifications.
  // Neither scheduler delivery nor an agent step waits on a catalog read.
  function readTitles() {
    if (reading || !schedule()?.catalog) return
    const version = generation
    reading = Promise.resolve().then(() => schedule()?.catalog()).then(entries => {
      if (version === generation && Array.isArray(entries)) {
        titles = new Map(entries.filter(row => TITLED_PATROL.test(row.title)).map(row => [row.id, row]))
      }
    }).catch(() => {}).finally(() => {
      reading = undefined
      if (generation !== version) readTitles()
    })
  }
  function catalogChanged() {
    generation++
    titles.clear()
    readTitles()
  }
  ctx.on('schedule/changed', catalogChanged)

  function roomsFor(sessionId) {
    const room = rt.roomOf(sessionId)
    if (room) return [room]
    const owner = rt.groupOwners.get(sessionId) ?? rt.pastOwners.get(sessionId)
    if (owner?.roomId) return [rt.roomOf(owner.roomId)].filter(Boolean)
    const botId = rt.chatOwners.get(sessionId) ?? owner?.botId
    return botId ? Object.values(rt.state.rooms).filter(group => group.members.includes(botId)) : []
  }

  function filter(sessionId, message, openingSessionId) {
    const frame = reminder(message)
    if (!frame || rt.readOnly?.() !== undefined) return message
    const removed = [], kept = []
    let busyRoom
    for (const entry of frame.entries) {
      const row = titles.get(entry.schedule_id)
      const named = row?.prompt === entry.reminder_prompt && (row.target?.sessionId ?? row.sessionId) === sessionId
      if (named || PATROL_PROMPT.test(entry.reminder_prompt.trimStart())) {
        busyRoom ??= roomsFor(sessionId).find(room => rt.roomBusyForPatrol(room, message.id, openingSessionId))
        if (busyRoom) { removed.push(entry); continue }
      }
      kept.push(entry)
    }
    if (!removed.length) return message
    for (const entry of removed) {
      rt.noteFailure?.({ level: 'info', source: 'schedule', code: 'SCHEDULE_PATROL_SKIPPED', sessionId,
        roomId: busyRoom.id, scheduleId: entry.schedule_id, occurrenceAt: entry.occurrence_at, messageId: message.id,
        text: 'Skipped this scheduled patrol because group work was active.' })
    }
    if (!kept.length) return undefined
    const { text, line } = frame
    const remainder = text.slice(0, line.index) + 'reminders_json: ' + JSON.stringify(kept) + text.slice(line.index + line[0].length)
    return { ...message, content: [{ ...message.content[0], text: remainder }] }
  }

  ctx.on('schedule/resolve-agent', async (sessionId, next) => {
    const [agent] = await Promise.all([next(), rt.load()])
    if (!roomsFor(sessionId).length) return agent
    let skipped = false
    return new Proxy(agent, { get(target, property) {
      if (property === 'followup') return message => {
        const remaining = filter(sessionId, message)
        skipped = !remaining
        if (remaining) target.followup(remaining)
      }
      if (property === 'whenIdle' && skipped) return () => Promise.resolve()
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    } })
  }, { prepend: true })

  // A room can become busy after admission, including while a restored inbox
  // waits for its turn. Only remove the scheduled parts of the claimed inputs.
  ctx.on('agent/pre-step', async ({ agent, messages, step, turn }, next) => {
    if (!messages?.some(message => message.source?.kind === 'schedule')) return next()
    await rt.load()
    if (!roomsFor(agent.id).length) return next()
    const decision = await next()
    if (decision.kind !== 'enter') return decision
    const claims = new Set(messages.filter(message => message.source?.kind === 'schedule').map(message => message.id))
    const removed = new Set(), retained = []
    let changed = false
    for (const message of decision.messages) {
      const kept = claims.has(message.id) ? filter(agent.id, message, step === 1 ? agent.id : undefined) : message
      if (kept) retained.push(kept)
      else removed.add(message.id)
      if (kept !== message) changed = true
    }
    if (!changed) return decision
    if (step === 1 && messages.every(message => removed.has(message.id))
      && retained.every(message => message.source?.form === 'snapshot' && CONTEXT_SOURCES.has(message.source.kind))) {
      skippedTurns.set(agent.id, turn)
      return { ...decision, messages: [] }
    }
    return { ...decision, messages: retained }
  }, { prepend: true })

  rt.consumeSkippedPatrolTurn = (sessionId, turn) => Number.isSafeInteger(turn) && skippedTurns.get(sessionId) === turn && skippedTurns.delete(sessionId)
  return catalogChanged
}
