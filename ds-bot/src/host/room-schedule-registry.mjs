import { randomUUID } from 'node:crypto'

const EVERY_SECONDS = 10 * 60
const titleOf = roomId => 'DSBOT-GROUP/' + roomId
const timing = {kind:'every', every_seconds:EVERY_SECONDS}
const marker = token => '[DS-Bot room timer ' + token + ']'
const previousPromptOf = token => 'The current group administrator checks this group’s board, its assigned owners, outstanding work and deadlines. Follow up through the original task and record verified changes. ' + marker(token)
const promptOf = token => [
  'Every 10 minutes, inspect this group’s goal and original task board. Stay silent while the group is actively progressing.',
  'If the goal is active and incomplete while this group is idle, take a concrete authorized step now; do not say only “waiting” or reply [PASS] because a task is blocked.',
  'Identify the highest-priority unfinished task, its exact owner, the next action or evidence, and who can clear any blocker. Follow up in the group using a plain-text @Name for the one person who must act; never put the mention in backticks, code, or a link, and never use @all. Include the task ID, requested action/evidence, feedback deadline, and next check. Make at most one effective follow-up per owner for the same task in this cycle and record progress on the original board item.',
  'For an uncertain handoff, inspect its original receipt and ask the known recipient only to confirm receipt and current status; explicitly do not repeat or restart the work. Do not send another assignment or change its request ID to bypass uncertainty.',
  'Do not repeat a follow-up while its stated deadline is still open. Use that time for independent authorized work and record the next check. If a deadline is missed or two scheduled checks pass without confirmation, escalate with a plain-text @Name to the specific authorized person who can unblock or decide; do not leave an ownerless or open-ended wait.',
  'If a shared lock is held, verify the current holder, ask that person to finish/report/release, and do not dispatch conflicting work. Once the lock is verified idle, continue the queued task. Honor an explicit user pause or stop and never mark reported work done without acceptance evidence.',
].join(' ') + ' ' + marker(token)
const currentPrompt = (prompt, token) => {
  const previous = previousPromptOf(token)
  return prompt === previous || prompt?.startsWith(previous)
    ? promptOf(token) + prompt.slice(previous.length)
    : prompt
}
const bearsMarker = (row, binding) => row?.prompt?.includes(marker(binding.token)) === true
const originalTarget = (row, binding) => sessionOf(row) === binding.target || row?.involvedSessionIds?.includes(binding.target) === true
const sessionOf = row => row?.target?.kind === 'session' ? row.target.sessionId : undefined

// DSH assigns the schedule ID after creation. Persist a unique creation marker first
// so a restart between the two stores can recover precisely that DSH row.
export function createRoomScheduleRegistry(rt, service) {
  let generation = 0, snapshot = new Map(), serial, dirty = false, stopped = false, unsaved = false, timer, rosterKey
  const host = () => {
    const current = service()
    return !stopped && typeof current?.edit === 'function' && typeof current.create === 'function' ? current : undefined
  }
  const bindings = () => rt.state.roomSchedules ?? {}
  const rooms = () => Object.values(rt.state.rooms)
  const scopeKey = () => JSON.stringify(rooms().map(room => [room.id, rt.sessionOfRoom(room)]))
  const fail = message => { throw new Error(message) }

  async function refresh() {
    const source = host()
    if (!source) return
    await rt.load()
    const version = ++generation
    const rows = await source.catalog()
    if (source === host() && version === generation) snapshot = new Map(rows.map(row => [row.id, row]))
    return rows
  }
  function ownerOf(id) {
    if (!id) return undefined
    return Object.keys(bindings()).find(roomId => bindings()[roomId]?.id === id)
  }
  function known(id) {
    if (ownerOf(id)) return true
    if (!id) return false
    const row = snapshot.get(id)
    return Object.values(bindings()).some(binding => binding.retired?.includes(id)
      || (!binding.id && bearsMarker(row,binding) && originalTarget(row,binding)))
  }
  function lookup(id, sessionId) {
    const roomId = ownerOf(id), room = roomId && rt.state.rooms[roomId], row = snapshot.get(id)
    if (!host() || !room || bindings()[roomId]?.restorePaused || !sessionId || rt.sessionOfRoom(room) !== sessionId || !room.members.includes(room.admin)
      || !rt.botOf(room.admin) || rt.botOf(room.admin).private === true || sessionOf(row) !== sessionId || row.status !== 'active'
      || row.kind !== 'every' || row.everySeconds !== EVERY_SECONDS || row.title !== titleOf(roomId)) return
    return { roomId, adminId:room.admin, scheduleId:id, sessionId, prompt:row.prompt }
  }

  async function pass() {
    const source = host()
    if (!source) return
    await rt.load()
    if (source !== host()) return
    if (rt.readOnly() !== undefined) { schedule(30000); return }
    const lease = rt.homeLockVersion()
    const check = () => { if (source !== host() || rt.homeLockVersion() !== lease) fail('The schedule writer changed') }
    const rows = await refresh()
    check()
    const registry = rt.state.roomSchedules ??= {}
    const save = async () => { check(); unsaved = true; await rt.save({required:true}); check(); unsaved = false }
    if (unsaved) await save()
    async function edit(row, change) {
      check()
      const result = await source.edit({id:row.id,expectedUpdatedAt:row.updatedAt ?? null,...change})
      check()
      if (result?.code && result.code !== 'schedule_not_found') fail('Room schedule changed during reconciliation')
    }
    // Recheck the room after every durable write: its part, membership or
    // existence can change while the native service is waiting for its lock.
    async function ensureRoom(roomId) {
      check()
      const current = () => rt.state.rooms[roomId]
      let binding = registry[roomId]
      if (!binding) {
        if (!current()) return
        registry[roomId] = binding = {token:randomUUID(), target:rt.sessionOfRoom(current())}
        await save()
      }
      if (typeof binding.token !== 'string' || !binding.token) fail('Invalid saved room schedule binding')
      const findPending = pool => pool.filter(row => bearsMarker(row, binding))
      const couldBeOurs = row => row.title === titleOf(roomId) || originalTarget(row,binding)
      let row = binding.id ? rows.find(candidate => candidate.id === binding.id) : undefined
      if (!row && !binding.id) {
        const matches = findPending(rows)
        if (matches.length > 1 || (matches.length && !originalTarget(matches[0],binding))) fail('Ambiguous native room schedule creation')
        row = matches[0]
        if (!row && binding.beforeCreate && rows.some(candidate => couldBeOurs(candidate) && !binding.beforeCreate.includes(candidate.id))) {
          fail('Cannot identify native room schedule after its creation receipt was lost')
        }
      }
      if (!current()) {
        if (row) await edit(row,{action:'delete'})
        if (!(await refresh()).some(r => r.id === row?.id) && !current()) { delete registry[roomId]; await save() }
        return
      }
      if (!row) {
        if (binding.id) {
          // An externally deleted task is replaced under a new creation marker.
          const token = randomUUID()
          registry[roomId] = binding = {token, target:rt.sessionOfRoom(current()), retired:[...(binding.retired ?? []),binding.id],
            ...(binding.paused ? {restorePaused:true} : {}),
            ...(binding.customPrompt ? {restorePrompt:binding.customPrompt.replace(marker(binding.token),marker(token))} : {})}
          await save()
        }
        if (!current()) { dirty = true; return }
        const target = {kind:'session', sessionId:rt.sessionOfRoom(current())}
        if (!binding.beforeCreate || binding.target !== target.sessionId) {
          binding.target = target.sessionId
          binding.beforeCreate = rows.filter(couldBeOurs).map(entry => entry.id)
          await save()
        }
        if (!current() || rt.sessionOfRoom(current()) !== target.sessionId) { dirty = true; return }
        check()
        const created = await source.create({title:titleOf(roomId),prompt:promptOf(binding.token),timing,target})
        check()
        row = (await refresh()).find(entry => entry.id === created?.id)
        if (!row) fail('Native room schedule creation could not be confirmed')
      }
      if (row.id !== binding.id) { binding.id = row.id; delete binding.beforeCreate; await save() }
      if (!current()) { dirty = true; return }
      const target = rt.sessionOfRoom(current()), patch = {}
      if (row.title !== titleOf(roomId)) patch.title = titleOf(roomId)
      if (sessionOf(row) !== target) patch.target = {kind:'session',sessionId:target}
      if (row.kind !== 'every' || row.everySeconds !== EVERY_SECONDS) patch.timing = timing
      const updatedPrompt = currentPrompt(binding.restorePrompt ?? row.prompt, binding.token)
      if (updatedPrompt !== row.prompt) patch.prompt = updatedPrompt
      if (binding.restorePaused && row.status !== 'paused') patch.active = false
      else if (row.status === 'ended') patch.active = !binding.paused
      if (Object.keys(patch).length) {
        await edit(row,{action:'update',patch})
        const changed = (await refresh()).find(r => r.id === binding.id)
        if (!changed || sessionOf(changed) !== target || changed.title !== titleOf(roomId)
          || changed.kind !== 'every' || changed.everySeconds !== EVERY_SECONDS || changed.status === 'ended'
          || binding.restorePaused && changed.status !== 'paused' || updatedPrompt !== row.prompt && changed.prompt !== updatedPrompt) fail('Native room schedule update could not be confirmed')
        row = changed
      }
      const customPrompt = row.prompt === promptOf(binding.token) ? undefined : row.prompt
      if (binding.restorePaused || binding.restorePrompt || !!binding.paused !== (row.status === 'paused') || binding.customPrompt !== customPrompt) {
        binding.paused = row.status === 'paused'
        binding.customPrompt = customPrompt
        delete binding.restorePaused; delete binding.restorePrompt
        await save()
      }
    }
    let failure
    for (const roomId of new Set([...Object.keys(registry), ...rooms().map(room => room.id)])) {
      try { await ensureRoom(roomId) }
      catch (error) { check(); failure ??= error }
    }
    if (failure) throw failure
    await refresh()
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
      reconcile().catch(error => { if (host()) { rt.warn('ds-bot: room schedules: %s', error.message); schedule(30000) } })
    },delay)
    timer.unref?.()
  }
  function rosterChanged() {
    const next = scopeKey()
    if (rosterKey !== next) { rosterKey = next; schedule() }
  }
  const off = rt.onSaved(rosterChanged)
  rt.onHomeDrain(() => { stopped = true; clearTimeout(timer); off(); return serial?.catch(() => {}) })
  return {refresh, reconcile, schedule, ownerOf, known, lookup}
}
