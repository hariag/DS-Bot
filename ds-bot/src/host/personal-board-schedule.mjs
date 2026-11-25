import { randomUUID } from 'node:crypto'

export const PERSONAL_POLL_SECONDS = 30 * 60
export const PERSONAL_SCHEDULE_TITLE = 'DSBOT-PERSONAL/user'
const timing = { kind: 'every', every_seconds: PERSONAL_POLL_SECONDS }
const marker = token => '[DS-Bot personal board timer ' + token + ']'
const previousPromptOf = token => [
  `主机器人每 ${PERSONAL_POLL_SECONDS / 60} 分钟回看一次用户个人任务看板（board_task list/show，涵盖 personal:user 及指派给用户的待办或待验收项）。用简体中文沟通与记录，文本采用 UTF-8，时间用北京时间 CST（Asia/Shanghai，UTC+08:00）。`,
  '核对每张未结卡的编号唯一性、负责人、状态、阻碍、子任务与父任务联动状态及截止时间；未在看板注册的任务不得推进，完成前必须同步最新状态回原卡。',
  '对已分派给机器人且条件齐全的任务，通过 message_bot 推动责任人执行或独立验收并在原卡 board_task comment 留痕；对受阻、逾期或需要用户本人确认与决断的卡片，按优先级汇总清单（任务编号、状态、待决点与建议选项）提醒用户推进。无未结事项或无新增变化时静默结束。',
].join('\n') + ' ' + marker(token)
const briefingPromptOf = token => [
  `主机器人每 ${PERSONAL_POLL_SECONDS / 60} 分钟回看一次用户个人任务看板（board_task list/show，涵盖 personal:user 及指派给用户的待办或待验收项）。用简体中文沟通与记录，文本采用 UTF-8，时间用北京时间 CST（Asia/Shanghai，UTC+08:00）。`,
  '核对每张未结卡的编号唯一性、负责人、状态、阻碍、子任务与父任务联动状态及截止时间；未用 board_task register 在看板立卡的任务不得推进，完成前必须同步最新状态回原卡。',
  '对已分派给机器人且条件齐全的任务，用稳定 request_id 通过 message_bot 推动责任人执行或独立验收并在原卡 board_task comment 留痕；交接不明时用 board_task operation 或原回执核实，不重派、不换 request_id。对受阻、逾期或需要用户本人确认与决断的卡片，按优先级汇总清单（任务编号、状态、待决点与建议选项）提醒用户推进。无未结事项或无新增变化时静默结束。',
].join('\n') + ' ' + marker(token)
const promptOf = token => [
  `主机器人每 ${PERSONAL_POLL_SECONDS / 60} 分钟回看一次用户个人任务看板。用 board_task list/show 查 personal:user 及指派给用户的待办和待验收项。使用简体中文、UTF-8 和 CST（Asia/Shanghai，UTC+08:00）。`,
  '核对原卡编号、负责人、依赖、子任务与父任务联动状态、证据和期限。只协调已立卡且就绪的任务；进展由原负责人记录，完成以独立验收和原卡状态为准。评论只记录交接。',
  '用稳定 request_id 定向交接，投递不明查原会话和接收回执。看板写入不明用原 operation_id 查 operation，提交后 show 回读。到期跟进；需用户决定时按优先级汇总卡号、待决点和建议。无就绪动作、到期跟进或待决变化时静默。',
].join('\n') + ' ' + marker(token)
const currentPrompt = (prompt, token) => {
  if (typeof prompt !== 'string') return prompt
  const previous = [previousPromptOf(token), briefingPromptOf(token)].find(text => prompt.startsWith(text))
  return previous ? promptOf(token) + prompt.slice(previous.length) : prompt
}

const bearsMarker = (row, binding) => row?.prompt?.includes(marker(binding.token)) === true
const sessionOf = row => row?.target?.kind === 'session' ? row.target.sessionId : undefined

function parseReminder(message) {
  if (message?.source?.kind !== 'schedule' || message.content?.length !== 1 || message.content[0].type !== 'text') return
  const text = message.content[0].text
  try {
    if (text.startsWith('[SCHEDULE REMINDER BATCH]\n')) {
      const line = /^reminders_json: (.+)$/m.exec(text)
      if (!line) return
      const entries = JSON.parse(line[1])
      if (Array.isArray(entries) && entries.length) return { entries, line, text }
    } else if (text.startsWith('[SCHEDULE REMINDER]\n')) {
      const entry = {
        schedule_id: JSON.parse(/^schedule_id_json: (.+)$/m.exec(text)?.[1]),
        occurrence_at: /^occurrence_at: (.+)$/m.exec(text)?.[1],
        reminder_prompt: JSON.parse(/^reminder_prompt_json: (.+)$/m.exec(text)?.[1]),
      }
      if (typeof entry.schedule_id === 'string' && typeof entry.reminder_prompt === 'string') return { entries: [entry] }
    }
  } catch { /* DSH owns unfamiliar reminder formats. */ }
}

export function filterPersonalReminderMessage(message, shouldSkip) {
  const frame = parseReminder(message)
  if (!frame) return message
  const kept = frame.entries.filter(entry => !shouldSkip(entry))
  if (kept.length === frame.entries.length) return message
  if (kept.length === 0) return undefined
  if (!frame.line) return undefined
  const remaining = frame.text.slice(0, frame.line.index) + 'reminders_json: ' + JSON.stringify(kept) + frame.text.slice(frame.line.index + frame.line[0].length)
  return { ...message, content: [{ ...message.content[0], text: remaining }] }
}

// Reconcile one managed 30-minute personal-board review task bound to the active
// Main Bot's private chat session so the user's own board does not go stale.
export function createPersonalBoardSchedule(rt, service) {
  let generation = 0, snapshot = new Map(), serial, dirty = false, stopped = false, unsaved = false, timer, lastTargetKey
  const host = () => {
    const current = service()
    return !stopped && typeof current?.edit === 'function' && typeof current.create === 'function' ? current : undefined
  }
  const fail = message => { throw new Error(message) }
  const targetBotId = () => (rt.state.mainBotIds ?? []).find(id => {
    const bot = rt.botOf?.(id)
    return bot && bot.private !== true
  })
  const targetSession = () => {
    const botId = targetBotId()
    const sessionId = botId ? rt.chatOf?.(botId) : undefined
    return botId && sessionId ? { botId, sessionId } : undefined
  }
  const targetKey = () => {
    const target = targetSession()
    return target ? `${target.botId}:${target.sessionId}:${!!rt.botOf(target.botId)?.kickoff}` : ''
  }

  async function refresh() {
    const source = host()
    if (!source) return
    await rt.load()
    const version = ++generation
    const rows = await source.catalog()
    if (source === host() && version === generation) snapshot = new Map(rows.map(row => [row.id, row]))
    return rows
  }

  function known(id) {
    if (!id) return false
    const binding = rt.state.personalBoardSchedule
    if (binding?.id === id || binding?.retired?.includes(id)) return true
    const row = snapshot.get(id)
    return !!binding && !binding.id && bearsMarker(row, binding) && row?.title === PERSONAL_SCHEDULE_TITLE
  }

  function isActiveManaged(id, sessionId) {
    const binding = rt.state.personalBoardSchedule
    if (!id || !binding || binding.id !== id) return false
    const row = snapshot.get(id)
    const target = targetSession()
    return !!target && target.sessionId === sessionId && row?.title === PERSONAL_SCHEDULE_TITLE
      && sessionOf(row) === sessionId && row?.status === 'active'
  }

  async function pass() {
    const source = host()
    if (!source) return
    await rt.load()
    if (source !== host()) return
    if (rt.readOnly() !== undefined) { schedule(30000); return }
    const opening = targetSession()
    if (opening && !rt.state.personalBoardSchedule) {
      // Creating a schedule produces a native change notice in the target
      // session. Do not let it get ahead of the Main Bot's opening turn.
      if (rt.botOf(opening.botId)?.kickoff) return
      if (rt.greetingOut?.(opening.botId) || rt.live?.get(opening.sessionId)?.turn !== undefined) {
        schedule(5000)
        return
      }
    }
    const lease = rt.homeLockVersion()
    const check = () => { if (source !== host() || rt.homeLockVersion() !== lease) fail('The personal schedule writer changed') }
    const rows = await refresh()
    check()
    const save = async () => { check(); unsaved = true; await rt.save({ required: true }); check(); unsaved = false }
    if (unsaved) await save()

    async function edit(row, change) {
      check()
      const result = await source.edit({ id: row.id, expectedUpdatedAt: row.updatedAt ?? null, ...change })
      check()
      if (result?.code && result.code !== 'schedule_not_found') fail('Personal board schedule changed during reconciliation')
    }

    const currentTarget = targetSession()
    let binding = rt.state.personalBoardSchedule
    if (!binding) {
      if (!currentTarget) return
      rt.state.personalBoardSchedule = binding = { token: randomUUID(), target: currentTarget.sessionId }
      await save()
    }
    if (typeof binding.token !== 'string' || !binding.token) fail('Invalid saved personal board schedule binding')
    const couldBeOurs = row => row.title === PERSONAL_SCHEDULE_TITLE || sessionOf(row) === binding.target || row?.involvedSessionIds?.includes(binding.target) === true
    let row = binding.id ? rows.find(candidate => candidate.id === binding.id) : undefined
    if (!row && !binding.id) {
      const matches = rows.filter(candidate => bearsMarker(candidate, binding))
      if (matches.length > 1) fail('Ambiguous personal board schedule creation')
      row = matches[0]
      if (!row && binding.beforeCreate && rows.some(candidate => couldBeOurs(candidate) && !binding.beforeCreate.includes(candidate.id))) {
        fail('Cannot identify personal board schedule after its creation receipt was lost')
      }
    }
    if (!currentTarget) {
      if (row) await edit(row, { action: 'delete' })
      if (!(await refresh()).some(r => r.id === row?.id) && !targetSession()) {
        delete rt.state.personalBoardSchedule
        await save()
      }
      return
    }
    if (!row) {
      if (binding.id) {
        const token = randomUUID()
        rt.state.personalBoardSchedule = binding = {
          token,
          target: currentTarget.sessionId,
          retired: [...(binding.retired ?? []), binding.id],
          ...(binding.paused ? { restorePaused: true } : {}),
          ...(binding.customPrompt ? { restorePrompt: binding.customPrompt.replace(marker(binding.token), marker(token)) } : {}),
        }
        await save()
      }
      const nextTarget = targetSession()
      if (!nextTarget) { dirty = true; return }
      if (!binding.beforeCreate || binding.target !== nextTarget.sessionId) {
        binding.target = nextTarget.sessionId
        binding.beforeCreate = rows.filter(couldBeOurs).map(entry => entry.id)
        await save()
      }
      if (targetSession()?.sessionId !== nextTarget.sessionId) { dirty = true; return }
      check()
      const created = await source.create({
        title: PERSONAL_SCHEDULE_TITLE,
        prompt: promptOf(binding.token),
        timing,
        target: { kind: 'session', sessionId: nextTarget.sessionId },
      })
      check()
      row = (await refresh()).find(entry => entry.id === created?.id)
      if (!row) fail('Personal board schedule creation could not be confirmed')
    }
    if (row.id !== binding.id) { binding.id = row.id; delete binding.beforeCreate; await save() }
    const target = targetSession()?.sessionId
    if (!target) { dirty = true; return }
    const patch = {}
    if (row.title !== PERSONAL_SCHEDULE_TITLE) patch.title = PERSONAL_SCHEDULE_TITLE
    if (sessionOf(row) !== target) patch.target = { kind: 'session', sessionId: target }
    if (row.kind !== 'every' || row.everySeconds !== PERSONAL_POLL_SECONDS) patch.timing = timing
    const desiredPrompt = currentPrompt(binding.restorePrompt ?? row.prompt, binding.token)
    if (desiredPrompt !== row.prompt) patch.prompt = desiredPrompt
    if (binding.restorePaused && row.status !== 'paused') patch.active = false
    else if (row.status === 'ended') patch.active = !binding.paused
    if (Object.keys(patch).length) {
      await edit(row, { action: 'update', patch })
      const changed = (await refresh()).find(r => r.id === binding.id)
      if (!changed || sessionOf(changed) !== target || changed.title !== PERSONAL_SCHEDULE_TITLE
        || changed.kind !== 'every' || changed.everySeconds !== PERSONAL_POLL_SECONDS || changed.status === 'ended'
        || (patch.prompt !== undefined && changed.prompt !== desiredPrompt)
        || (binding.restorePaused && changed.status !== 'paused')) fail('Personal board schedule update could not be confirmed')
      row = changed
    }
    const customPrompt = row.prompt === promptOf(binding.token) ? undefined : row.prompt
    if (binding.restorePaused || binding.restorePrompt || !!binding.paused !== (row.status === 'paused') || binding.customPrompt !== customPrompt || binding.target !== target) {
      binding.paused = row.status === 'paused'
      binding.customPrompt = customPrompt
      binding.target = target
      delete binding.restorePaused; delete binding.restorePrompt
      await save()
    }
  }

  function reconcile() {
    dirty = true
    if (!serial) {
      serial = (async () => {
        while (dirty && host()) { dirty = false; await pass() }
      })().finally(() => { serial = undefined })
    }
    return serial
  }

  function schedule(delay = 0) {
    if (!host() || timer) return
    timer = setTimeout(() => {
      timer = undefined
      reconcile().catch(error => { if (host()) { rt.warn?.('ds-bot: personal board schedule: %s', error.message); schedule(30000) } })
    }, delay)
    timer.unref?.()
  }

  function prime() { lastTargetKey = targetKey() }
  function scopeChanged() {
    const next = targetKey()
    if (lastTargetKey === undefined) { lastTargetKey = next; return }
    if (lastTargetKey !== next) { lastTargetKey = next; schedule() }
  }
  const off = rt.onSaved?.(scopeChanged) ?? (() => {})
  rt.onHomeDrain?.(() => { stopped = true; clearTimeout(timer); off(); return serial?.catch(() => {}) })
  return { refresh, reconcile, schedule, prime, known, isActiveManaged }
}
