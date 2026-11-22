// Versions describe logical status association; timestamps are separate
// observations and can disagree when host clocks or persisted data differ.
const STATUSES = new Set(['pending', 'working', 'reported', 'done'])

export function validGoalTime(value, now = Date.now()) {
  return Number.isSafeInteger(value) && value > 0 && value <= now && Number.isFinite(new Date(value).getTime())
}

export function goalNoteContext(task, now = Date.now()) {
  const noteTimeKnown = validGoalTime(task.noteAt, now)
  const hasStatusTime = task.statusUpdatedAt !== undefined
  const statusTime = !hasStatusTime ? 'missing' : validGoalTime(task.statusUpdatedAt, now) ? 'known' : 'invalid'
  const versionsKnown = Number.isSafeInteger(task.statusVersion) && task.statusVersion >= 0 && Number.isSafeInteger(task.noteStatusVersion) && task.noteStatusVersion >= 0
  const statusesKnown = STATUSES.has(task.status) && STATUSES.has(task.noteStatus)
  if (!noteTimeKnown || !versionsKnown || !statusesKnown || statusTime === 'invalid' || task.noteStatusVersion > task.statusVersion) return { kind: 'unknown', noteTimeKnown, statusTime }
  if (task.noteStatusVersion === task.statusVersion && task.noteStatus !== task.status) return { kind: 'unknown', noteTimeKnown, statusTime }
  // Conflict is a reason to verify both observations, not proof of clock order.
  if (statusTime === 'known' && ((task.noteStatusVersion < task.statusVersion && task.noteAt > task.statusUpdatedAt) || (task.noteStatusVersion === task.statusVersion && task.noteAt < task.statusUpdatedAt))) return { kind: 'conflict', noteTimeKnown, statusTime }
  return { kind: task.noteStatusVersion === task.statusVersion ? 'current' : 'historical', noteTimeKnown, statusTime }
}
