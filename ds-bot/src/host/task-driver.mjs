import { createHash } from 'node:crypto'

// A trigger is not delivery. The real host must provide a separately verified
// durable admission implementation; without it even claiming is forbidden.
export function createTaskDriver({ store, admission, authorized = () => false, onError = () => {}, maxPerPass = 20 }) {
  if (!store || !Number.isSafeInteger(maxPerPass) || maxPerPass < 1 || maxPerPass > 100) throw new TypeError('invalid task driver')
  let active, stopped = false, retrigger = false, cursor = 0
  const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x1f]/.test(value)
  // A journal payload is parsed JSON. Reproduce the store's sorted-key digest
  // and reject unsupported values rather than accepting a changed message.
  const canonical = value => {
    if (value === null || typeof value === 'boolean' || typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))) return JSON.stringify(value)
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
    if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('Invalid journal payload')
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  }
  const freeze = value => { if (value && typeof value === 'object') { for (const item of Object.values(value)) freeze(item); Object.freeze(value) }; return value }
  const matches = (record, action, task, intent) => {
    if (!record || task.actionRevision !== action.revision || task.stale || task.blocked || record.state !== 'claimed' || record.actionId !== action.id || record.targetBotId !== action.actor ||
      record.actionRevision !== action.revision || record.taskRevision !== task.revision || record.messageId !== record.payload?.id ||
      record.payload?.role !== 'user' || !Array.isArray(record.payload.content) || !record.payload.source?.kind ||
      !validId(record.targetSessionId) || !validId(record.admissionId) || !validId(record.messageId)) return false
    if (intent && (record.admissionId !== intent.admissionId || record.messageId !== intent.messageId || record.targetBotId !== intent.targetBotId ||
      record.targetSessionId !== intent.targetSessionId || canonical(record.payload) !== canonical(intent.payload))) return false
    return createHash('sha256').update(canonical(record.payload)).digest('hex') === record.payloadHash
  }
  async function pass() {
    // This capability is intentionally absent in the host until the real
    // preclaim implementation and recovery contract pass independent tests.
    if (!admission || await admission.available() !== true || stopped) return
    const tasks = store.list()
    if (!Array.isArray(tasks) || !tasks.length) return
    const start = cursor % tasks.length
    const ordered = tasks.slice(start).concat(tasks.slice(0, start))
    let claimedCount = 0
    for (const task of ordered) {
      if (stopped) return
      const action = store.listActions(task.id).find(item => item.state === 'pending')
      if (!action) continue
      let intent, claim
      try {
        if (await authorized(action, task) !== true || stopped) continue
        // Preparation has no side effect and does not put a message in DSH.
        intent = await admission.prepare(action, task)
        if (stopped || !intent || intent.targetBotId !== action.actor ||
          !validId(intent.targetSessionId) || !validId(intent.messageId) || !validId(intent.admissionId) || intent.payload === undefined) continue
        claim = store.claimAction({ actionId:action.id, actor:'scheduler', intent })
      } catch (error) { onError(error, action); continue }
      // An already claimed action is only reconciled by the original identity.
      // A duplicate claim response is NEVER permission to send again.
      if (claim?.claimedNow !== true) continue
      claimedCount += 1
      try {
        const current = store.get(task.id)
        const recorded = store.admission(action.id)
        if (stopped || !current || !matches(recorded, action, current, intent) || await authorized(action, current, recorded) !== true) throw new Error('Action authorization changed')
        const persistedIntent = freeze(recorded)
        const revalidate = async () => {
          const latest = store.get(task.id), saved = store.admission(action.id)
          return !stopped && !!latest && matches(saved, action, latest, persistedIntent) && await authorized(action, latest, saved) === true
        }
        // Required contract: admit holds the target input until the host's
        // current authority/grants are rechecked at its durable release gate.
        const receipt = await admission.admit({ action, task:current, intent:persistedIntent, revalidate })
        store.markAction({ actionId:action.id, actor:'scheduler', expectedState:'claimed', state:'accepted', receipt })
      } catch (error) {
        try { store.markAction({ actionId:action.id, actor:'scheduler', expectedState:'claimed', state:'uncertain', receipt:'admission outcome unknown' }) }
        catch (recordError) { onError(recordError, action) }
        onError(error, action)
      }
      cursor = (cursor + 1) % tasks.length
      if (claimedCount >= maxPerPass) { retrigger = true; return }
    }
  }
  function wake() {
    if (stopped) return Promise.resolve()
    retrigger = true
    if (active) return active
    active = (async () => { while (!stopped && retrigger) { retrigger = false; await pass() } })().finally(() => { active = undefined })
    return active
  }
  return { wake, async close() { stopped = true; if (active) await active } }
}
