// Group goals: one outcome the whole group works toward, checked stage by stage.
// The state lives on the room (room.goal, archived into room.pastGoals), the admin
// runs it with the group_goal tool, the user steers it from the goal endpoints,
// and the relay wakes the admin when nothing runs and the goal is not done.
import { createHash, randomUUID } from 'node:crypto'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { goalNoteContext, validGoalTime } from '../shared/goal-note.js'
import { GOAL_IDLE_NUDGES, SOURCE_KIND } from './constants.js'
import { headOf } from './text.js'
import { output } from './tools.js'

const TITLE_MAX = 80
const BRIEF_MAX = 2000
const TEXT_MAX = 2000
const RULE_MAX = 300
const RULES_MAX = 20
const STAGES_MAX = 20
const STAGE_TITLE_MAX = 80
const STAGE_ACCEPTANCE_MAX = 1000
const TASKS_MAX = 12
const TASK_MAX = 500
const NOTE_MAX = 300
const NOTE_HISTORY_MAX = 5
const REASON_MAX = 300
const FEEDBACK_MAX = 1000
const EVENT_TEXT_MAX = 300
const EVENTS_MAX = 50
const PAST_MAX = 5
// A record proves only what the administrator explicitly reported, not the
// truth of the underlying evidence. Include all task fields affecting review.
const reviewFingerprint = task => createHash('sha256').update(JSON.stringify(task)).digest('hex')
// Bind a generated ledger to the exact goal and stage it describes. This is
// not proof that the model read the result or that an owner was checked.
const inspectionFingerprint = goal => {
  if (!goal || typeof goal.id !== 'string') return undefined
  const stage = goal.stages?.[goal.current]
  return createHash('sha256').update(JSON.stringify({
    id: goal.id, revision: goal.revision, status: goal.status, title: goal.title,
    objective: goal.objective, acceptance: goal.acceptance, constraints: goal.constraints,
    current: goal.current, stage: stage === undefined ? null : {
      id: stage.id, title: stage.title, acceptance: stage.acceptance, status: stage.status,
      tasks: (stage.tasks ?? []).map(reviewFingerprint),
    },
  })).digest('hex')
}

const openReviewTasks = goal => (goal?.stages?.[goal.current]?.tasks ?? []).filter(task => task.status !== 'done')
const reviewMissing = (goal, checkCurrent = () => false) => {
  const stage = goal?.stages?.[goal.current]
  const review = goal?.ownerReview
  return openReviewTasks(goal).filter(task => review?.stageId !== stage?.id
    || review?.checks?.[task.id]?.fingerprint !== reviewFingerprint(task)
    || review?.checks?.[task.id]?.unresolved === true
    || !checkCurrent(task, review.checks[task.id]))
}
// Short immediate checks are still bounded by GOAL_IDLE_NUDGES. Once that
// budget is exhausted, review an unfinished automatic idle at most twice an hour.
export const GOAL_REVIEW_INTERVAL_MS = 30 * 60 * 1000
const GOAL_REVIEW_POLL_MS = 60 * 1000
const AUTO_IDLE_REASONS = new Set(['admin-pass', 'nudge-limit'])

function automaticIdle(goal) {
  return goal?.status === 'active' && goal.idle === true
    && AUTO_IDLE_REASONS.has(goal.idleReason)
    && Number.isSafeInteger(goal.idleRevision) && goal.idleRevision === goal.revision
}

// Old versions did not distinguish automatic idle from a user stop. They may
// be inspected, but no such inspection may authorize dispatch or mutation.
function legacyIdle(goal) {
  return goal?.status === 'active' && goal.idle === true && goal.idleReason === undefined
}
function memberStoppedIdle(goal) {
  return goal?.status === 'active' && goal.idle === true && goal.idleReason === 'member-stop'
}
const inspectionOnlyIdle = goal => legacyIdle(goal) || memberStoppedIdle(goal)

function clearIdle(goal) {
  delete goal.idle
  delete goal.idleReason
  delete goal.idleRevision
  delete goal.reviewAt
}

function clearAutomaticIdle(goal) {
  // An older host may have recorded a user stop without understanding our
  // provenance fields. Never infer that such an idle is safe to wake.
  if (goal.idle === true && !automaticIdle(goal)) return
  clearIdle(goal)
}

const tooLong = (what, max) => `${what} is too long: at most ${max}.`
const tooMany = (what, max) => `At most ${max} ${what}.`
const required = (field, action) => `${field} is required for ${action}.`
const noGoal = room => `"${room.name}" has no goal. Start one with group_goal draft or start.`
const wrongState = (room, goal, action, allowed) => `The goal of "${room.name}" is ${goal.status}; ${action} needs it to be ${allowed}.`
const pausedRun = room => `The goal of "${room.name}" is paused. The user resumes it; until then, talk with the user and write their corrections in with revise.`
const allPassed = room => `Every stage of "${room.name}" has passed. Call group_goal complete with the evidence and a summary.`

// The version follows actual status transitions, not the goal's revision: a
// task can return to the same status while its earlier note is still historical.
function setTaskStatus(task, status, now, source) {
  if (task.status !== status) {
    if (Number.isSafeInteger(task.statusVersion) && task.statusVersion >= 0 && task.statusVersion < Number.MAX_SAFE_INTEGER) task.statusVersion += 1
    else {
      task.statusVersion = 1
      delete task.noteStatusVersion // legacy/overflow cannot prove an old note current
    }
    task.status = status
    task.statusUpdatedAt = now
    task.statusSource = source
  }
}

function setTaskNote(task, note, now) {
  if (!Number.isSafeInteger(task.statusVersion) || task.statusVersion < 0) task.statusVersion = 0
  task.note = note
  task.noteStatus = task.status
  task.noteStatusVersion = task.statusVersion
  task.noteAt = now
}

function clearTaskNotes(task) {
  for (const field of ['note', 'noteStatus', 'noteStatusVersion', 'noteAt', 'noteHistory']) delete task[field]
}

// An automatic failure/stop explanation replaces the current note. Keep a
// bounded trace of what was there; old notes without metadata remain unknown.
function rememberTaskNote(task, now) {
  if (typeof task.note !== 'string' || task.note === '') return
  const prior = {
    text: task.note.slice(0, NOTE_MAX),
    ...(typeof task.noteStatus === 'string' ? { status: task.noteStatus } : {}),
    ...(Number.isSafeInteger(task.noteStatusVersion) && task.noteStatusVersion >= 0 ? { statusVersion: task.noteStatusVersion } : {}),
    ...(Number.isFinite(task.noteAt) && task.noteAt > 0 ? { at: task.noteAt } : {}),
    supersededAt: now,
  }
  task.noteHistory = [...(Array.isArray(task.noteHistory) ? task.noteHistory.slice(-(NOTE_HISTORY_MAX - 1)) : []), prior]
}

export const TASK_LABEL = { pending: 'not started', working: 'working', reported: 'reported', done: 'done' }

// Notes without trustworthy status/version/time metadata are historical clues,
// not proof of the task's current condition. This also handles pre-upgrade data.
export function taskNoteText(task, now = Date.now()) {
  if (typeof task.note !== 'string' || task.note === '') return ''
  const context = goalNoteContext(task, now)
  const label = context.kind === 'current' ? 'note recorded for this status'
    : context.kind === 'historical' ? 'historical note from an earlier status'
      : context.kind === 'conflict' ? 'note provenance/time unknown; time conflict, verify' : 'note provenance/time unknown'
  const time = context.noteTimeKnown ? `, ${new Date(task.noteAt).toISOString()}` : ''
  const statusTime = context.statusTime === 'known' ? `; status changed ${new Date(task.statusUpdatedAt).toISOString()}` : '; status change time unknown'
  const history = Array.isArray(task.noteHistory) ? task.noteHistory.filter(entry => typeof entry?.text === 'string' && entry.text !== '') : []
  const previous = history.length > 0 ? `; ${history.length} earlier note(s), latest historical: ${headOf(history.at(-1).text, 160)}` : ''
  return ` — [${label}${time}${statusTime}] ${task.note}${previous}`
}

function taskStatusTimeText(task, now = Date.now()) {
  return validGoalTime(task.statusUpdatedAt, now)
    ? ` — [status changed ${new Date(task.statusUpdatedAt).toISOString()}]`
    : ' — [status change time unknown]'
}

const goalId = () => `goal-${randomUUID().replace(/-/g, '').slice(0, 8)}`

// The goal's own stamp on every change: a new revision the client polls, the
// change in its event list, and the idle bookkeeping reset.
export function touchGoal(goal, event, now = Date.now(), { keepNudges = false } = {}) {
  const autoIdle = automaticIdle(goal)
  if (!keepNudges) clearAutomaticIdle(goal)
  goal.revision += 1
  goal.updatedAt = now
  if (!keepNudges) {
    goal.nudges = 0
  } else if (autoIdle) {
    // A known task update does not invalidate the reason we parked this goal.
    goal.idleRevision = goal.revision
  }
  if (event !== undefined) goal.events = [...(goal.events ?? []), { at: now, ...event }].slice(-EVENTS_MAX)
}

export function archiveGoal(room) {
  const goal = room.goal
  if (goal === undefined) return
  room.pastGoals = [...(room.pastGoals ?? []), goal].slice(-PAST_MAX)
  delete room.goal
}

function newGoal({ brief = '', title, by = 'user', event = 'draft' } = {}, now) {
  const text = String(brief).trim()
  const goal = {
    id: goalId(),
    revision: 0,
    status: 'drafting',
    title: (title !== undefined && String(title).trim() !== '' ? String(title).trim() : text.split('\n')[0]).slice(0, TITLE_MAX),
    ...(text !== '' ? { brief: text.slice(0, BRIEF_MAX) } : {}),
    objective: '',
    acceptance: '',
    constraints: [],
    stages: [],
    current: -1,
    nudges: 0,
    by,
    createdAt: now,
    updatedAt: now,
    events: [],
    // Stage and task ids are never reused inside a goal, not even by a revise
    // that drops the stages they were on.
    counter: { stage: 0, task: 0 },
  }
  if (event !== undefined) touchGoal(goal, { kind: event, by }, now)
  return goal
}

// What every task's bot must be: a current member, named exactly. `memberOf`
// resolves a name to the member or undefined; `memberNames` is for the refusal.
function cleanStages(room, list, action, memberOf, memberNames) {
  if (!Array.isArray(list) || list.length === 0) return { error: required('stages', action) }
  if (list.length > STAGES_MAX) return { error: tooMany('stages', STAGES_MAX) }
  const stages = []
  for (const [index, item] of list.entries()) {
    const n = index + 1
    const title = String(item?.title ?? '').trim()
    if (title === '') return { error: required(`stage ${n} title`, action) }
    if (title.length > STAGE_TITLE_MAX) return { error: tooLong(`stage ${n} title`, STAGE_TITLE_MAX) }
    const acceptance = String(item?.acceptance ?? '').trim()
    if (acceptance === '') return { error: required(`stage ${n} acceptance`, action) }
    if (acceptance.length > STAGE_ACCEPTANCE_MAX) return { error: tooLong(`stage ${n} acceptance`, STAGE_ACCEPTANCE_MAX) }
    const items = Array.isArray(item?.tasks) ? item.tasks : []
    if (items.length === 0) return { error: required(`stage ${n} tasks`, action) }
    if (items.length > TASKS_MAX) return { error: tooMany(`tasks in stage ${n}`, TASKS_MAX) }
    const tasks = []
    for (const entry of items) {
      const name = String(entry?.bot ?? '').trim()
      const task = String(entry?.task ?? '').trim()
      if (task === '') return { error: required(`a task of stage ${n}`, action) }
      if (task.length > TASK_MAX) return { error: tooLong(`a task in stage ${n}`, TASK_MAX) }
      const bot = memberOf(name)
      if (bot === undefined) return { error: `${name} is not a member of "${room.name}". Members: ${memberNames.join(', ')}.` }
      tasks.push({ botId: bot.id, task })
    }
    stages.push({ title, acceptance, tasks })
  }
  return { stages }
}

function cleanConstraints(list, action) {
  if (list === undefined) return {}
  if (!Array.isArray(list)) return { error: required('constraints', action) }
  if (list.length > RULES_MAX) return { error: tooMany('constraints', RULES_MAX) }
  const constraints = []
  for (const item of list) {
    const text = String(item ?? '').trim()
    if (text === '') continue
    if (text.length > RULE_MAX) return { error: tooLong('a constraint', RULE_MAX) }
    constraints.push(text)
  }
  return { constraints }
}

function cleanFields(input, fields) {
  for (const [field, max] of fields) {
    const value = input[field]
    if (value === undefined) continue
    if (String(value).trim().length > max) return { error: tooLong(field, max) }
  }
  return {}
}

// A cleaned stage becomes a stored one: fresh ids, tasks pending unless the same
// member had the same task in the stage this one replaces (a revise keeps it).
function buildStage(goal, stage, position, previous, status) {
  return {
    id: `s${++goal.counter.stage}`,
    title: stage.title,
    acceptance: stage.acceptance,
    status,
    tasks: stage.tasks.map((task) => {
      const kept = previous?.tasks.find(old => old.botId === task.botId && old.task === task.task)
      return { id: `t${++goal.counter.task}`, ...task, status: kept?.status ?? 'pending' }
    }),
    reworks: 0,
  }
}

export function draftGoal(room, { brief = '', title, by = 'user' } = {}, now = Date.now()) {
  const goal = room.goal
  if (goal !== undefined && (goal.status === 'active' || goal.status === 'paused')) {
    return { error: wrongState(room, goal, 'draft', 'new or drafting') }
  }
  const text = String(brief ?? '').trim()
  if (text === '') return { error: required('brief', 'draft') }
  if (text.length > BRIEF_MAX) return { error: tooLong('brief', BRIEF_MAX) }
  const cut = cleanFields({ title }, [['title', TITLE_MAX]])
  if (cut.error !== undefined) return cut
  if (goal?.status === 'complete' || goal?.status === 'stopped') archiveGoal(room)
  const drafting = room.goal?.status === 'drafting' ? room.goal : undefined
  if (drafting !== undefined) {
    drafting.brief = text
    drafting.title = (title !== undefined && String(title).trim() !== '' ? String(title).trim() : text.split('\n')[0]).slice(0, TITLE_MAX)
    touchGoal(drafting, { kind: 'draft', by, text: headOf(text, EVENT_TEXT_MAX) }, now)
    return { goal: drafting, reply: { event: 'draft', title: drafting.title, count: drafting.stages.length } }
  }
  const next = newGoal({ brief: text, title, by }, now)
  room.goal = next
  return { goal: next, reply: { event: 'draft', title: next.title, count: 0 } }
}

export function startGoal(room, input, by, memberOf, memberNames, now = Date.now()) {
  const goal = room.goal
  if (goal !== undefined && (goal.status === 'active' || goal.status === 'paused')) {
    return { error: wrongState(room, goal, 'start', 'new or drafting') }
  }
  const objective = String(input.objective ?? '').trim()
  if (objective === '') return { error: required('objective', 'start') }
  const acceptance = String(input.acceptance ?? '').trim()
  if (acceptance === '') return { error: required('acceptance', 'start') }
  const cut = cleanFields(input, [['objective', TEXT_MAX], ['acceptance', TEXT_MAX], ['title', TITLE_MAX]])
  if (cut.error !== undefined) return cut
  const rules = cleanConstraints(input.constraints, 'start')
  if (rules.error !== undefined) return rules
  const cleaned = cleanStages(room, input.stages, 'start', memberOf, memberNames)
  if (cleaned.error !== undefined) return cleaned
  if (goal?.status === 'complete' || goal?.status === 'stopped') archiveGoal(room)
  const draft = room.goal?.status === 'drafting' ? room.goal : undefined
  const next = draft ?? newGoal({ by, event: undefined }, now)
  if (draft === undefined) room.goal = next
  next.status = 'active'
  next.objective = objective
  next.acceptance = acceptance
  next.constraints = rules.constraints ?? []
  next.title = String(input.title ?? '').trim() || next.title || objective.split('\n')[0].slice(0, TITLE_MAX)
  delete next.brief
  next.stages = cleaned.stages.map((stage, index) => buildStage(next, stage, index, undefined, index === 0 ? 'active' : 'pending'))
  next.current = 0
  next.startedAt = now
  // Task status updates must not indefinitely postpone the owner's review.
  next.ownerReviewAt = now + GOAL_REVIEW_INTERVAL_MS
  delete next.endedAt
  delete next.summary
  delete next.evidence
  delete next.reason
  delete next.pausedBy
  touchGoal(next, { kind: 'start', by }, now)
  return { goal: next, reply: { event: 'start', title: next.title, stage: 1, count: next.stages.length, next: next.stages[0].title } }
}

export function reviseGoal(room, input, by, memberOf, memberNames, now = Date.now()) {
  const goal = room.goal
  if (goal === undefined) return { error: noGoal(room) }
  if (goal.status !== 'active' && goal.status !== 'paused') return { error: wrongState(room, goal, 'revise', 'active or paused') }
  const reason = String(input.reason ?? '').trim()
  if (reason === '') return { error: required('reason', 'revise') }
  if (reason.length > FEEDBACK_MAX) return { error: tooLong('reason', FEEDBACK_MAX) }
  const cut = cleanFields(input, [['title', TITLE_MAX], ['objective', TEXT_MAX], ['acceptance', TEXT_MAX]])
  if (cut.error !== undefined) return cut
  if (input.objective !== undefined && String(input.objective).trim() === '') return { error: required('objective', 'revise') }
  if (input.acceptance !== undefined && String(input.acceptance).trim() === '') return { error: required('acceptance', 'revise') }
  const rules = cleanConstraints(input.constraints, 'revise')
  if (rules.error !== undefined) return rules
  // Everything validates before anything changes: a refused revise leaves the goal as it was.
  let cleaned
  let keep = []
  if (input.stages !== undefined) {
    cleaned = cleanStages(room, input.stages, 'revise', memberOf, memberNames)
    if (cleaned.error !== undefined) return cleaned
    keep = goal.stages.slice(0, Math.max(0, goal.current))
    if (keep.length + cleaned.stages.length > STAGES_MAX) return { error: tooMany('stages', STAGES_MAX) }
  }
  if (input.title !== undefined && String(input.title).trim() !== '') goal.title = String(input.title).trim()
  if (input.objective !== undefined) goal.objective = String(input.objective).trim()
  if (input.acceptance !== undefined) goal.acceptance = String(input.acceptance).trim()
  if (rules.constraints !== undefined) goal.constraints = rules.constraints
  if (cleaned !== undefined) {
    const previous = goal.stages[goal.current]
    const replacement = cleaned.stages.map((stage, index) => {
      const position = keep.length + index
      return buildStage(goal, stage, position, position === goal.current ? previous : undefined, position === goal.current ? 'active' : 'pending')
    })
    goal.stages = [...keep, ...replacement]
  }
  touchGoal(goal, { kind: 'revise', by, text: headOf(reason, EVENT_TEXT_MAX) }, now)
  return { goal, reply: { event: 'revise', title: goal.title, count: goal.stages.length, text: reason } }
}

export function taskGoal(room, input, by, memberOf, memberNames, now = Date.now()) {
  const goal = room.goal
  if (goal === undefined) return { error: noGoal(room) }
  if (goal.status !== 'active') return { error: wrongState(room, goal, 'task', 'active') }
  const number = input.stage === undefined ? goal.current + 1 : Number(input.stage)
  const stage = Number.isInteger(number) ? goal.stages[number - 1] : undefined
  if (stage === undefined) return { error: `The goal of "${room.name}" has no stage ${number}.` }
  const name = String(input.bot ?? '').trim()
  if (name === '') return { error: required('bot', 'task') }
  const bot = memberOf(name)
  if (bot === undefined) return { error: `${name} is not a member of "${room.name}". Members: ${memberNames.join(', ')}.` }
  const task = stage.tasks.find(item => item.botId === bot.id)
  if (task === undefined) return { error: `${name} has no task in stage ${number} of "${room.name}".` }
  const status = input.status === undefined ? undefined : String(input.status)
  const note = input.note === undefined ? undefined : String(input.note).trim()
  if (status === undefined && note === undefined) return { error: required('status or note', 'task') }
  if (note !== undefined && note.length > NOTE_MAX) return { error: tooLong('note', NOTE_MAX) }
  const before = task.status
  if (status !== undefined) setTaskStatus(task, status, now, 'manual')
  if (note !== undefined) {
    if (note === '') clearTaskNotes(task)
    else setTaskNote(task, note, now)
  }
  touchGoal(goal, { kind: 'task', by, stage: stage.id, taskId: task.id, botId: task.botId, fromStatus: before, toStatus: task.status, text: headOf(note ?? status, EVENT_TEXT_MAX) }, now, { keepNudges: true })
  return { goal }
}

export function passGoal(room, input, by, now = Date.now()) {
  const goal = room.goal
  if (goal === undefined) return { error: noGoal(room) }
  if (goal.status === 'paused') return { error: pausedRun(room) }
  if (goal.status !== 'active') return { error: wrongState(room, goal, 'pass', 'active') }
  const stage = goal.stages[goal.current]
  if (stage === undefined) return { error: allPassed(room) }
  const evidence = String(input.evidence ?? '').trim()
  if (evidence === '') return { error: required('evidence', 'pass') }
  if (evidence.length > TEXT_MAX) return { error: tooLong('evidence', TEXT_MAX) }
  stage.status = 'passed'
  stage.evidence = evidence
  stage.passedAt = now
  for (const task of stage.tasks) setTaskStatus(task, 'done', now, 'pass')
  goal.current += 1
  const next = goal.stages[goal.current]
  if (next !== undefined) next.status = 'active'
  touchGoal(goal, { kind: 'pass', by, stage: stage.id, text: headOf(evidence, EVENT_TEXT_MAX) }, now)
  return { goal, reply: { event: 'pass', title: goal.title, stage: goal.current, count: goal.stages.length, ...(next !== undefined ? { next: next.title } : {}), text: evidence } }
}

export function reworkGoal(room, input, by, memberOf, memberNames, now = Date.now()) {
  const goal = room.goal
  if (goal === undefined) return { error: noGoal(room) }
  if (goal.status === 'paused') return { error: pausedRun(room) }
  if (goal.status !== 'active') return { error: wrongState(room, goal, 'rework', 'active') }
  const stage = goal.stages[goal.current]
  if (stage === undefined) return { error: allPassed(room) }
  const reason = String(input.reason ?? '').trim()
  if (reason === '') return { error: required('reason', 'rework') }
  if (reason.length > FEEDBACK_MAX) return { error: tooLong('reason', FEEDBACK_MAX) }
  let only
  if (input.bot !== undefined && String(input.bot).trim() !== '') {
    const name = String(input.bot).trim()
    only = memberOf(name)
    if (only === undefined) return { error: `${name} is not a member of "${room.name}". Members: ${memberNames.join(', ')}.` }
  }
  for (const task of stage.tasks) {
    if (only !== undefined && task.botId !== only.id) continue
    setTaskStatus(task, 'pending', now, 'rework')
    clearTaskNotes(task)
  }
  stage.reworks += 1
  stage.feedback = reason
  touchGoal(goal, { kind: 'rework', by, stage: stage.id, text: headOf(reason, EVENT_TEXT_MAX) }, now)
  return { goal, reply: { event: 'rework', title: goal.title, stage: goal.current + 1, count: goal.stages.length, text: reason } }
}

export function completeGoal(room, input, by, now = Date.now()) {
  const goal = room.goal
  if (goal === undefined) return { error: noGoal(room) }
  if (goal.status === 'paused') return { error: pausedRun(room) }
  if (goal.status !== 'active') return { error: wrongState(room, goal, 'complete', 'active') }
  const open = goal.stages.findIndex(stage => stage.status !== 'passed')
  if (open !== -1) return { error: `Stage ${open + 1} "${goal.stages[open].title}" has not passed yet. Pass every stage before complete.` }
  const evidence = String(input.evidence ?? '').trim()
  if (evidence === '') return { error: required('evidence', 'complete') }
  if (evidence.length > TEXT_MAX) return { error: tooLong('evidence', TEXT_MAX) }
  const summary = String(input.summary ?? '').trim()
  if (summary === '') return { error: required('summary', 'complete') }
  if (summary.length > TEXT_MAX) return { error: tooLong('summary', TEXT_MAX) }
  goal.status = 'complete'
  goal.summary = summary
  goal.evidence = evidence
  goal.endedAt = now
  touchGoal(goal, { kind: 'complete', by }, now)
  return { goal, reply: { event: 'complete', title: goal.title, count: goal.stages.length, text: summary } }
}

export function pauseGoal(room, by, now = Date.now()) {
  const goal = room.goal
  if (goal === undefined) return { error: noGoal(room) }
  if (goal.status !== 'active') return { error: wrongState(room, goal, 'pause', 'active') }
  goal.status = 'paused'
  if (goal.reviewAttempt) goal.reviewAttempt.state = 'cancelled-uncertain'
  goal.pausedBy = by
  touchGoal(goal, { kind: 'pause', by }, now)
  return { goal, reply: { event: 'pause', title: goal.title, count: goal.stages.length } }
}

export function resumeGoal(room, by, now = Date.now()) {
  const goal = room.goal
  if (goal === undefined) return { error: noGoal(room) }
  if (goal.status !== 'paused') return { error: wrongState(room, goal, 'resume', 'paused') }
  goal.status = 'active'
  delete goal.pausedBy
  clearIdle(goal)
  touchGoal(goal, { kind: 'resume', by }, now)
  return { goal, reply: { event: 'resume', title: goal.title, count: goal.stages.length } }
}

export function stopGoal(room, reason, by, now = Date.now()) {
  const goal = room.goal
  if (goal === undefined) return { error: noGoal(room) }
  if (!['drafting', 'active', 'paused'].includes(goal.status)) {
    return { error: wrongState(room, goal, 'stop', 'drafting, active or paused') }
  }
  const text = String(reason ?? '').trim()
  if (text === '') return { error: required('reason', 'stop') }
  if (text.length > REASON_MAX) return { error: tooLong('reason', REASON_MAX) }
  goal.status = 'stopped'
  if (goal.reviewAttempt) goal.reviewAttempt.state = 'cancelled-uncertain'
  goal.reason = text
  goal.endedAt = now
  touchGoal(goal, { kind: 'stop', by, text: headOf(text, EVENT_TEXT_MAX) }, now)
  return { goal, reply: { event: 'stop', title: goal.title, count: goal.stages.length, text } }
}

// Automatic task status, from what happens in the room rather than the tool:
// the admin calling a member moves its task to working, the member's answer
// moves it to reported, and a failure or a user stop puts it back to pending.
// No log line, no round reply — only a new revision.
export function markTasks(room, botId, from, to, note, now = Date.now()) {
  const goal = room.goal
  if (goal?.status !== 'active') return false
  const stage = goal.stages[goal.current]
  if (stage === undefined) return false
  let changed = false
  for (const task of stage.tasks) {
    if (task.botId !== botId || task.status !== from) continue
    if (note !== undefined && task.note !== note) rememberTaskNote(task, now)
    setTaskStatus(task, to, now, 'automatic')
    if (note !== undefined) setTaskNote(task, note, now)
    changed = true
  }
  if (!changed) return false
  goal.nudges = 0
  clearAutomaticIdle(goal)
  goal.revision += 1
  goal.updatedAt = now
  return true
}

const DUTY_ACTIVE = "You run this goal. First check current task states, existing owners and work in other conversations, dependencies, authorization, resource locks and available capacity. Call only members whose tasks are ready and need assignment; members named in one message start together. Do not redispatch working or reported work without a concrete reason. Review every task in the current stage and every stage acceptance item with evidence; group_goal pass marks every stage task done, so pass only when each task to be marked done is actually complete and verified. If a task is no longer applicable, first record the authorized scope decision and safely reconcile the stage; never falsely mark it done just to advance. If a specific member must redo work, first verify that member has an affected task in the current stage, preserve evidence and the affected task notes before group_goal rework with that bot; targeted rework also clears that member's affected task notes, while leaving bot out resets every task and clears all task notes. If the member has no current task, track the work on the project board or use a safe scoped revision. Record external blockers and work on independent authorized actions rather than treating waiting as rework. Revise this goal for an explicit user correction, or for necessary task or dependency adjustments within its existing authorized objective and acceptance; never materially change the user objective or acceptance scope or weaken its standard without explicit user direction; refine verification details within the authorized original acceptance and record the change. Use task to update one member status without passing stages. Revising constraints replaces the entire list. Revising stages rebuilds current and future stages and loses task notes, stage rework and feedback, and original IDs; show omits complete future task definitions. Before such a replacement, retrieve and preserve the complete current and future definitions, task states, notes, feedback and evidence from verifiable records; if unavailable, do not guess or rebuild, and track the work on the project board. When calling revise, supply only fields that need changing and reconcile all affected work after the revision. Track independent new user goals separately without overwriting this goal. Each stage should have at most one aggregated task per Bot; track separate acceptance items on the project board. Pause or resume this goal only on an explicit user request; an external blocker is not a pause, and do not attribute a Bot action to the user. Stop can stop other group members and their work; use it only for an explicit request to stop this whole goal after assessing impact. Keep all work within applicable user authorization and rules. Ask the user only for decisions you cannot make."
const OWNER_REVIEW = "At each periodic review, show the current stage and check every unfinished task and each distinct owner, including whether the original assignment was received or is still queued, their current work arrangement, progress, dependencies, blockers, next action and response deadline. Follow up each unfinished item with its responsible owner through the existing handoff, combining items for the same owner and giving task ID, requested status or action, evidence and response deadline. Reuse credible progress when the agreed deadline has not passed; do not duplicate an outstanding or uncertain message, change its request ID, redispatch work already underway or repeat a completed delivery. For reported work follow the assigned independent reviewer or request missing evidence, not the original implementation. For a paused or stopped goal, an authorization wait or an external blocker, respect the restriction and follow only the person empowered to unblock it. Escalate unconfirmed handoffs after their deadline or two cycles according to the reporting rules. Record the result and next review for each owner; if the 30-step turn budget is insufficient, leave a checkpoint and continue the remaining owners in the next turn."
const DUTY_PASSED = 'Every stage passed. Check the overall "done when", then call group_goal complete with the evidence and a summary for the user.'
const DUTY_PAUSED = "This group goal is paused. Do not assume who paused it without evidence, assign new work or pass stages for it. Continue unrelated user-authorized work that does not depend on the paused goal. Resume only on an explicit user request."
const dutyOf = goal => (goal.status === 'paused' ? DUTY_PAUSED : goal.stages[goal.current] === undefined ? DUTY_PASSED : `${DUTY_ACTIVE} ${OWNER_REVIEW}`)

const DUTY_DRAFT = [
  'Establish the goal from the user request and available facts; follow goal-grill when available and ask only for decisions genuinely needed:',
  '1. Find the facts yourself (files, code, records) or ask members with @Name. Never ask the user what you can look up.',
  '2. List the decisions only the user can make. Ask them in one message, numbered, each with your recommended answer, so the user can reply "as recommended". Skip this when nothing is open.',
  '3. When the goal is sufficiently clear, call group_goal start with objective, acceptance, rules and stages; use at most one aggregated task per Bot in each stage and track independent items on the project board.',
].join('\n')
const NUDGE_LINE = `Goal check from DS Bot: no work is currently running in this group and this goal is not finished; members may still be working elsewhere. ${OWNER_REVIEW} Dispatch only ready, authorized tasks that need assignment and fit capacity; review reported work without redispatching it. Record external blockers and their owners, or complete the goal only when all requirements are verified. If no authorized step can progress while waiting, record the unblock condition and reply [PASS].`
const INSPECTION_DUTY = 'This is a read-only goal inspection because earlier work or a stop is unresolved. Your first action must be group_goal show for the current group; read the result and identify the current stage, unfinished owners and evidence gaps. If needed, use read_group_chat for the current group only to inspect existing handoffs and evidence. Do not call review-check, assign, dispatch, send reminders, change task state, or take external actions. The shown goal is not proof that an owner accepted or completed work. If show fails, report the failure; otherwise give a short factual inspection or reply [PASS] if nothing changed. Full owner checks and follow-up remain pending.'
const SCOPED_INSPECTION_DUTY = 'First call group_goal show for this group. Earlier deliveries have unresolved outcomes for specific owners; do not repeat or dispatch their work. For other owners, inspect existing status and evidence and record review-check for the exact task and current fingerprint. You may read evidence for independently reviewable reported work. Do not dispatch, send reminders or change task status from this inspection. A goal panel is not proof of acceptance or completion; unknown facts remain unknown.'
const RESUME_LINE = 'The user resumed the goal. Take the next step now.'

export const goalReviewGuard = (live, roomOf = () => undefined, pickRoom = () => undefined, scoped = () => false) => exec => {
  const info = live?.get(exec.agent?.id)?.info
  if (info?.reviewInspect !== true || !info.reviewId) return undefined
  if (exec.name === 'list_bots' || (exec.name === 'group_goal' && exec.arguments?.action === 'show')) return undefined
  const room = roomOf(info.roomId)
  if (exec.name === 'read_group_chat' && room && typeof exec.arguments?.group === 'string'
    && exec.arguments.group.trim() === room.name && pickRoom(exec.arguments.group, exec.agent?.id)?.room?.id === room.id) return undefined
  if (room && scoped(room, info, exec) === true) return undefined
  return 'This goal review is inspection only because a stop or earlier group delivery is unresolved. Report evidence and do not assign or change work.'
}

export function install(rt) {
  const { ctx } = rt
  let reviewDisposed = false
  const reviewing = new Set()
  const reviewNotified = new Set()
  const stopsPending = new Map()
  const goalStopBegin = roomId => stopsPending.set(roomId, (stopsPending.get(roomId) ?? 0) + 1)
  const goalStopEnd = roomId => {
    const remaining = (stopsPending.get(roomId) ?? 1) - 1
    if (remaining > 0) stopsPending.set(roomId, remaining)
    else stopsPending.delete(roomId)
  }
  const goalDispatchBlocked = (room, targetId) => {
    if (stopsPending.has(room.id)) return true
    const goal = room.goal
    if (goal?.status === 'paused' || goal?.status === 'stopped') return true
    if (goal?.status !== 'active' || goal.idle !== true) return false
    if (goal.idleReason === 'user-stop' || goal.idleReason === undefined) return true
    return goal.idleReason === 'member-stop' && (goal.stoppedMembers ?? []).includes(targetId)
  }
  const goalRecoveryBlocked = (room, targetId) => ['paused', 'stopped'].includes(room.goal?.status)
    || goalDispatchBlocked(room, targetId)
  // Old recovery notes can also include private or other-room messages. Only
  // a delivery addressed to this room can block this room's review. A legacy
  // same-room note without a review id remains ambiguous and must be inspected.
  const hasUnreadRoomDeliveries = room => {
    const notes = rt.unreadRoomOf?.(room.id)
    return !Array.isArray(notes) || notes.length > 0
  }
  const inspectionRequired = room => inspectionOnlyIdle(room.goal) || hasUnreadRoomDeliveries(room)

  // Old delivery notes do not reliably identify a task, but their recipient
  // can bound the uncertainty to that owner. Never infer an owner from text.
  const recoveryOwners = room => {
    const blocked=new Set();let unknown=false,has=false
    const notes=rt.unreadRoomOf?.(room.id)
    if(!Array.isArray(notes))return {has:true,unknown:true,blocked}
    for(const args of notes) {
        has=true
        const bot=typeof args.toId==='string' ? rt.botOf(args.toId) : undefined
        if(args.roomId!==room.id || !bot || !room.members.includes(bot.id))unknown=true
        else blocked.add(bot.id)
    }
    return {has,unknown,blocked}
  }
  const scopedReviewTask = (room, id, scope = recoveryOwners(room)) => {
    if(!room || inspectionOnlyIdle(room.goal) || stopsPending.has(room.id) || room.goal?.status!=='active')return undefined
    const stage=room.goal.stages?.[room.goal.current],tasks=stage?.tasks ?? []
    const matching=tasks.filter(item=>item.id===id && item.status!=='done'),task=matching[0]
    if(!scope.has || scope.unknown || matching.length!==1 || !task || tasks.filter(item=>item.botId===task.botId).length!==1
      || !room.members.includes(task.botId) || scope.blocked.has(task.botId))return undefined
    return task
  }
  const scopedReviewAction = (room, info, exec) => {
    if(info?.reviewInspect!==true || !goalReviewAllowed(room,info.reviewId))return false
    if(exec.name==='group_goal' && exec.arguments?.action==='review-check')return scopedReviewTask(room,exec.arguments.review_task)!==undefined
    if(['read','glob','grep'].includes(exec.name)) {
      const stage=room.goal?.stages?.[room.goal.current]
      return (stage?.tasks ?? []).some(task=>task.status==='reported' && task.botId!==room.admin && scopedReviewTask(room,task.id)!==undefined)
    }
    return false
  }
  // Every consumer treats a scoped assertion as unresolved if its original
  // queue generation is unavailable, changed, or its owner is now blocked.
  const missingFor = room => {
    const scope = recoveryOwners(room)
    return reviewMissing(room.goal, (task, check) => {
      if(scope.unknown || scope.blocked.has(task.botId)) return false
      const current = rt.reviewQueueVersion?.(room.id, task.botId)
      if(current === undefined) return false
      // Existing records predate queue versions. Their historical contents are
      // retained, but cannot count while their owner or provenance is unresolved.
      return check.scopedQueueVersion === undefined || current === check.scopedQueueVersion
    })
  }
  // UI/API callers must see the effective result, not an earlier assertion
  // whose queue generation is no longer current.
  rt.goalView = room => {
    const goal = room?.goal
    if (!goal?.ownerReview?.checks) return goal
    const missing = new Set(missingFor(room).map(task => task.id))
    const stage = goal.stages?.[goal.current]
    const checks = Object.fromEntries(Object.entries(goal.ownerReview.checks).map(([id, check]) => [id,
      check && (missing.has(id) || (check.scopedQueueVersion !== undefined && (goal.ownerReview.stageId !== stage?.id
        || !stage?.tasks?.some(task => task.id === id && task.status !== 'done'))))
        ? { ...check, unresolved: true } : check]))
    return { ...goal, ownerReview: { ...goal.ownerReview, checks } }
  }

  const memberOf = room => (ref) => {
    const bot = rt.findBot(ref)
    return bot !== undefined && room.members.includes(bot.id) ? bot : undefined
  }
  const memberNames = room => room.members.map(id => rt.botOf(id)?.name).filter(Boolean)
  const nameOf = id => rt.botOf(id)?.name ?? 'a member'

  // The admin's ledger: the whole goal, for the prompt block and the tool's answer.
  function ledgerLines(room, goal) {
    const lines = [`Goal: ${goal.title}`, `Objective: ${goal.objective}`, `Done when: ${goal.acceptance}`]
    if (goal.constraints.length > 0) lines.push('Rules:', ...goal.constraints.map(rule => `- ${rule}`))
    lines.push('Stages:')
    goal.stages.forEach((stage, index) => {
      const n = index + 1
      if (stage.status === 'passed') lines.push(`[passed] ${n}. ${stage.title}`)
      else if (index === goal.current) {
        lines.push(`[current] ${n}. ${stage.title} — done when: ${stage.acceptance}`)
        for (const task of stage.tasks) lines.push(`  - ${nameOf(task.botId)}: ${task.task} [${TASK_LABEL[task.status] ?? 'status unknown'}]${taskNoteText(task) || taskStatusTimeText(task)} (stage ${stage.id}, task ${task.id}, review fingerprint ${reviewFingerprint(task)})`)
        if (stage.reworks > 0) lines.push(`  Sent back ${stage.reworks} ${stage.reworks === 1 ? 'time' : 'times'}. Latest feedback: ${stage.feedback ?? ''}`)
      } else lines.push(`[next] ${n}. ${stage.title}: ${[...new Set(stage.tasks.map(task => nameOf(task.botId)))].join(', ')}`)
    })
    const corrections = (goal.events ?? []).filter(event => event.kind === 'revise' && event.text).slice(-3).map(event => event.text)
    if (corrections.length > 0) lines.push(`Latest corrections from the user: ${corrections.join(' / ')}`)
    if (goal.reviewAttempt) lines.push(`Periodic review ${goal.reviewAttempt.id} is ${goal.reviewAttempt.state}; do not send it again until its original outcome is known.`)
    if (goal.ownerReview?.stageId === goal.stages[goal.current]?.id) lines.push(`Periodic owner review still needs: ${missingFor(room).map(task => task.id).join(', ') || 'none'}. Records are administrator assertions with cited evidence, not independent proof.`)
    return lines
  }

  // A member's share of the goal: the current stage and its own task in it.
  function memberLines(room, goal, member) {
    const count = goal.stages.length
    const stage = goal.stages[goal.current]
    const lines = [
      `The group works toward: ${goal.title} — ${headOf(goal.objective, 600)}`,
      ...(goal.constraints.length > 0 ? [`Rules: ${goal.constraints.join('; ')}`] : []),
    ]
    if (stage === undefined) lines.push('Every stage passed; the admin is checking the whole goal.')
    else {
      lines.push(`Current stage ${goal.current + 1} "${stage.title}", done when: ${stage.acceptance}`)
      const tasks = stage.tasks.filter(task => task.botId === member.id)
      if (tasks.length === 0) lines.push('You have no task in this stage.')
      else for (const task of tasks) lines.push(`Your task in it: ${task.task} (${TASK_LABEL[task.status] ?? 'status unknown'}).${taskNoteText(task) || taskStatusTimeText(task)}`)
    }
    lines.push('Work toward this group goal and any other active goals explicitly requested by the user, within your assigned role and scope. A new request does not cancel an earlier goal unless the user clearly changes, pauses, or cancels it. When you finish your task, end your reply with the evidence: the files you changed, the commands you ran and what they printed.')
    if (goal.status === 'paused') lines.push('This group goal is paused: finish only work already underway for it and start no new work on this goal. Follow separate user requests within their authorization.')
    return { lines, stage: `${stage === undefined ? count : goal.current + 1}/${count}` }
  }

  // The <group_goal> block in every round's prompt; nudge and resume add a line
  // after it for the admin. No block at all with no goal or a finished one.
  function goalBlock(room, member, { nudge = false, resume = false, inspectOnly = false } = {}) {
    const goal = room.goal
    if (goal === undefined || goal.status === 'complete' || goal.status === 'stopped') return ''
    const isAdmin = rt.isAdminOf(room, member.id)
    let block
    if (goal.status === 'drafting') {
      block = isAdmin
        ? ['<group_goal status="drafting">', `The user wants this group to reach a goal: ${goal.brief ?? ''}`, DUTY_DRAFT, '</group_goal>'].join('\n')
        : ['<group_goal status="drafting">', `The admin is aligning a new goal for this group with the user: ${headOf(goal.brief ?? '', 300)}. Help with facts when you are asked.`, '</group_goal>'].join('\n')
    } else if (isAdmin) {
      const scoped=inspectOnly && (goal.stages?.[goal.current]?.tasks ?? []).some(task=>scopedReviewTask(room,task.id)!==undefined)
      block = [`<group_goal status="${goal.status}">`, ...ledgerLines(room, goal), inspectOnly ? (scoped ? SCOPED_INSPECTION_DUTY : INSPECTION_DUTY) : dutyOf(goal), '</group_goal>'].join('\n')
    } else {
      const view = memberLines(room, goal, member)
      block = [`<group_goal status="${goal.status}" stage="${view.stage}">`, ...view.lines, '</group_goal>'].join('\n')
    }
    if (goal.status !== 'drafting') block += '\nApply each saved goal rule only to its stated scope. Honor the latest explicit user instruction and any still-valid approval for the same action, object, environment and conditions; do not ask for the same approval again. Do not extend a lock rule beyond the operations it actually covers: evidence from a different scope can be reported for its own scope but is not a substitute for the required gate evidence. If the applicable authorization or rule scope cannot be verified, pause only the affected action and continue independent authorized work. Tell the goal owner when saved rules need a scoped update.'
    if (isAdmin && nudge && !inspectOnly) block += `\n${NUDGE_LINE}\nFor each current unfinished task you actually checked, call group_goal review-check with its task ID and exact review fingerprint from show plus the requested structured fields and evidence. Unknown or unverified facts must be marked unknown and review_complete false; only set review_complete true when the required check is actually finished. The runtime records your assertion and will continue missing or changed tasks in another turn; it does not verify the truth of your evidence.`
    if (isAdmin && resume) block += `\n${RESUME_LINE}`
    return block
  }

  // The tool's answer: the ledger as the caller sees it, without the block's tags.
  function goalLedger(room, member, { showBackup = false } = {}) {
    const goal = room.goal
    if (goal === undefined) return noGoal(room)
    if (goal.status === 'complete') return `Goal "${goal.title}" is complete.`
    if (goal.status === 'stopped') return `Goal "${goal.title}" was stopped${goal.reason ? `: ${goal.reason}` : ''}.`
    if (goal.status === 'drafting') {
      return rt.isAdminOf(room, member.id)
        ? `The user wants this group to reach a goal: ${goal.brief ?? ''}`
        : `The admin is aligning a new goal for this group with the user: ${headOf(goal.brief ?? '', 300)}. Help with facts when you are asked.`
    }
    // A Main Bot may audit a group it belongs to as the admin's backup, but
    // only when it explicitly asks to show the goal; its routine prompt stays scoped.
    if (rt.isAdminOf(room, member.id) || (showBackup && rt.isMain(member.id) && room.members.includes(member.id))) return ledgerLines(room, goal).join('\n')
    return memberLines(room, goal, member).lines.join('\n')
  }

  // Every non-task change is a group event: a notice the members read, which the
  // group chat shows as a goal row.
  const announce = (room, reply) => {
    rt.logRoom?.(room, { who: 'DS Bot', kind: 'notice', reason: 'goal', ...reply })
  }

  // A goal message into the room's own Session, which relays it as a new round:
  // the user's draft request, a resume after the user continues, or an idle nudge.
  async function queueGoalRelay(room, goal, text, senderName = 'You', options = {}) {
    const agent = options.agent ?? await rt.resolveAgent(rt.sessionOfRoom(room))
    if (options.valid !== undefined && !options.valid()) return false
    agent.followup(createUserMessage({
      content: [{ type: 'text', text }],
    source: { kind: SOURCE_KIND, form: 'relay', role: 'goal', goal, goalId: room.goal?.id, exchangeId: options.reviewId ?? randomUUID(), ...(options.reviewId ? { reviewId: options.reviewId, ...(options.inspectOnly ? { reviewInspect: true } : {}) } : {}), senderName, roomId: room.id },
    }))
    const flushed = await ctx.sessions.flush(agent.session)
    if (options.reviewId && flushed === false) throw new Error('goal review persistence was not acknowledged')
    return true
  }

  // goal-draft { roomId, text }: the user's one-line ask opens a drafting goal.
  async function goalDraft(roomId, text) {
    const room = rt.roomOf(roomId)
    if (room === undefined) return { error: 'Unknown group chat' }
    const input = String(text ?? '').trim()
    if (input === '' || input.length > BRIEF_MAX) return { error: 'Write what this group should achieve, in at most 2000 characters.', code: 'bot/invalid' }
    const admin = room.members.map(rt.botOf).filter(Boolean).find(bot => rt.isAdminOf(room, bot.id))
    if (admin === undefined) return { error: 'This group has no admin. Set one in the group settings first.' }
    if (room.goal !== undefined && (room.goal.status === 'active' || room.goal.status === 'paused')) {
      return { error: 'This group already has a goal. Stop it first.' }
    }
    const result = draftGoal(room, { brief: input, by: 'user' })
    if (result.error !== undefined) return { error: result.error }
    announce(room, result.reply)
    await rt.save()
    await queueGoalRelay(room, 'draft', `[Goal request]\n${input}`)
    return {}
  }

  // goal-control { roomId, goalId, action, stopWork? }: the user's pause, resume,
  // stop and clear from the goal panel.
  async function goalControl(roomId, body = {}) {
    const room = rt.roomOf(roomId)
    if (room === undefined) return { error: 'Unknown group chat' }
    const goal = room.goal
    if (goal === undefined || goal.id !== String(body.goalId ?? '')) return { error: 'The goal has changed. Look again.', code: 'bot/stale' }
    const action = String(body.action ?? '')
    if (action === 'review-resolve') {
      const attempt = goal.reviewAttempt
      const evidence = String(body.evidence ?? '').trim()
      if (body.confirmed !== true || evidence.length < 8 || evidence.length > TEXT_MAX) return { error: 'Confirm that the original review was investigated and provide its outcome (8–2000 characters).', code: 'bot/invalid' }
      if (!reviewEligible(goal) || attempt === undefined || attempt.id !== body.reviewId
        || !['uncertain', 'admitting', 'cancelled-uncertain'].includes(attempt.state)
        || (attempt.state === 'admitting' && (!Number.isFinite(attempt.at) || Date.now() - attempt.at < GOAL_REVIEW_INTERVAL_MS))) return { error: 'The review is not eligible for recovery, or the goal was paused or stopped.', code: 'bot/stale' }
      if (room.admin !== attempt.adminId || !room.members.includes(attempt.adminId)
        || rt.sessionOfRoom(room) !== attempt.rootSessionId || room.sessions?.[attempt.adminId] !== attempt.adminSessionId) return { error: 'The group or administrator session changed; inspect the original sessions before recovery.', code: 'bot/stale' }
      const root = await rt.resolveAgent(attempt.rootSessionId)
      const adminAgent = attempt.adminSessionId === undefined ? undefined : await rt.resolveAgent(attempt.adminSessionId)
      const quietAgent = agent => Array.isArray(agent?.inbox?.nextStep) && Array.isArray(agent?.inbox?.nextTurn)
        && agent.inbox.nextStep.length === 0 && agent.inbox.nextTurn.length === 0
        && rt.live.get(agent.session.id)?.turn === undefined && rt.hasSubagents?.(agent.session.id) !== true
        && rt.waitsForApproval?.(agent.session.id) !== true
      if (rt.roomOf(room.id) !== room || room.goal !== goal || goal.reviewAttempt !== attempt || !reviewEligible(goal)
        || room.admin !== attempt.adminId || !room.members.includes(attempt.adminId)
        || rt.sessionOfRoom(room) !== attempt.rootSessionId || room.sessions?.[attempt.adminId] !== attempt.adminSessionId
        || !quietAgent(root) || (adminAgent !== undefined && !quietAgent(adminAgent)) || [...rt.roomProgress.values()].some(round => round.roomId === room.id)
        || (rt.workingInRoom?.(room) ?? []).length > 0 || rt.roomBatchPending?.(room.id) === true
        || (rt.roomInbox.get(room.id)?.length ?? 0) > 0 || (rt.roomLaterCount?.(room.id) ?? 0) > 0) return { error: 'The goal changed or related work is still pending. Check it before recovery.', code: 'bot/stale' }
      rt.requireHomeLock()
      const wasAutomatic = automaticIdle(goal)
      const now = Date.now()
      delete goal.reviewAttempt
      goal.revision += 1
      goal.updatedAt = now
      if (wasAutomatic) { goal.idleRevision = goal.revision; goal.reviewAt = now + GOAL_REVIEW_INTERVAL_MS }
      goal.events = [...(goal.events ?? []), { at: now, kind: 'review-resolved', by: 'user', reviewId: attempt.id, text: evidence }].slice(-EVENTS_MAX)
      await rt.save({ required: true })
      return {}
    }
    if (action === 'pause') {
      if (goal.status !== 'active') return { error: wrongState(room, goal, 'pause', 'active') }
      const result = pauseGoal(room, 'user')
      announce(room, result.reply)
      await rt.save({ required: true })
      if (body.stopWork === true) await rt.stopRoomWork(room.id)
      return {}
    }
    if (action === 'resume') {
      if (goal.status === 'active' && goal.idle === true && !automaticIdle(goal)) {
        clearIdle(goal)
        delete goal.stoppedMembers
        goal.revision += 1
        goal.updatedAt = Date.now()
        goal.events = [...(goal.events ?? []), { kind: 'resume', by: 'user', at: goal.updatedAt }].slice(-EVENTS_MAX)
        await rt.save({ required: true })
        // An unresolved review must be investigated separately before new work.
        if (goal.reviewAttempt === undefined) await queueGoalRelay(room, 'resume', '[Goal resumed]')
        return {}
      }
      if (goal.status !== 'paused') return { error: wrongState(room, goal, 'resume', 'paused') }
      const result = resumeGoal(room, 'user')
      announce(room, result.reply)
      await rt.save({ required: true })
      if (goal.reviewAttempt === undefined) await queueGoalRelay(room, 'resume', '[Goal resumed]')
      return {}
    }
    if (action === 'stop') {
      if (!['drafting', 'active', 'paused'].includes(goal.status)) return { error: wrongState(room, goal, 'stop', 'drafting, active or paused') }
      const result = stopGoal(room, 'Stopped by the user', 'user')
      announce(room, result.reply)
      await rt.save({ required: true })
      await rt.stopRoomWork(room.id)
      return {}
    }
    if (action === 'clear') {
      if (goal.status === 'active' || goal.status === 'paused') {
        return { error: `The goal of "${room.name}" is ${goal.status}; clear needs it to be drafting, complete or stopped.` }
      }
      if (goal.status === 'drafting') delete room.goal
      else archiveGoal(room)
      await rt.save()
      return {}
    }
    return { error: 'Nothing to do', code: 'bot/invalid' }
  }

  const parkAutomatically = (goal, reason, now = Date.now()) => {
    goal.idle = true
    goal.idleReason = reason
    goal.reviewAt = now + GOAL_REVIEW_INTERVAL_MS
    if (goal.reviewAttempt) goal.ownerReviewAt = now + GOAL_REVIEW_INTERVAL_MS
    delete goal.reviewAttempt
    goal.revision += 1
    goal.idleRevision = goal.revision
    goal.updatedAt = now
  }

  // Only an attempt whose provenance still matches this exact idle may pass
  // through the group relay. This is rechecked after every asynchronous step.
  const reviewEligible = goal => goal?.status === 'active' && (goal.idle !== true || automaticIdle(goal) || inspectionOnlyIdle(goal))
  const goalReviewAllowed = (room, id) => reviewEligible(room?.goal)
    && !stopsPending.has(room.id)
    && room.goal.reviewAttempt?.saveOutcomeUnknown !== true
    && room.goal.reviewAttempt?.id === id && ['admitting', 'uncertain'].includes(room.goal.reviewAttempt.state)
    && (!inspectionOnlyIdle(room.goal) || room.goal.reviewAttempt.inspectOnly === true)
    && room.goal.reviewAttempt.adminId === room.admin && room.members.includes(room.admin)
    && room.goal.reviewAttempt.rootSessionId === rt.sessionOfRoom(room)
    && room.goal.reviewAttempt.adminSessionId === room.sessions?.[room.admin] && !reviewDisposed

  // When same-room recovery notes have unknown provenance, let the admin
  // inspect and report, but do not permit tools with possible side effects.
  ctx.tools.guard(exec => {
    const info = rt.live.get(exec.agent?.id)?.info
    if (info?.reviewId && !goalReviewAllowed(rt.roomOf(info.roomId), info.reviewId)) {
      if (exec.name === 'list_bots' || (exec.name === 'group_goal' && exec.arguments?.action === 'show')) return undefined
      return 'The goal review was stopped or its identity changed; no further action is allowed.'
    }
    return goalReviewGuard(rt.live, rt.roomOf, (name, agentId) => rt.pickRoom(name, rt.selfOf(agentId)), scopedReviewAction)(exec)
  })

  async function goalReviewBind(room, id, sessionId) {
    const attempt = room?.goal?.reviewAttempt
    if (!reviewEligible(room?.goal) || attempt?.id !== id || !['admitting', 'uncertain'].includes(attempt.state)
      || attempt.adminId !== room.admin || !room.members.includes(room.admin)
      || attempt.rootSessionId !== rt.sessionOfRoom(room) || room.sessions?.[room.admin] !== sessionId) return false
    if (attempt.adminSessionId !== undefined) return attempt.adminSessionId === sessionId
    attempt.adminSessionId = sessionId
    await rt.save({ required: true })
    return goalReviewAllowed(room, id)
  }

  const finishReview = (room, reason, now = Date.now()) => {
    const goal = room.goal
    const remaining = missingFor(room)
    const inspectOnly = goal.reviewAttempt?.inspectOnly === true
    const checkedBefore = goal.reviewAttempt?.checkedBefore ?? 0
    const checkedNow = openReviewTasks(goal).length - remaining.length
    if (inspectOnly) {
      const attempt = goal.reviewAttempt
      const generated = Number.isFinite(attempt?.inspectionLedgerAt) && typeof attempt.inspectionLedgerFingerprint === 'string'
      const current = generated && attempt.inspectionLedgerFingerprint === inspectionFingerprint(goal)
      const status = current ? 'ledger-generated' : generated ? 'stale-ledger' : 'not-generated'
      goal.lastInspection = { reviewId: attempt.id, at: now, status, ...(current ? { ledgerAt: attempt.inspectionLedgerAt, fingerprint: attempt.inspectionLedgerFingerprint } : {}) }
      if (!current) rt.noteFailure?.({ level: 'warn', source: 'goal', code: 'GOAL_INSPECTION_INCOMPLETE', text: `Goal inspection ${attempt.id} did not produce a current goal ledger; owner checks remain pending.` })
      if (!inspectionOnlyIdle(goal)) parkAutomatically(goal, reason, now)
      else {
        delete goal.reviewAttempt
        goal.ownerReviewAt = now + GOAL_REVIEW_INTERVAL_MS
        goal.updatedAt = now
        goal.revision += 1
      }
      return
    }
    if (!inspectionOnlyIdle(goal)) {
      parkAutomatically(goal, reason, now)
      if (remaining.length > 0) {
        if (!inspectOnly && checkedNow > checkedBefore) goal.reviewAt = goal.ownerReviewAt = now + GOAL_REVIEW_POLL_MS
      } else {
        goal.lastOwnerReview = { ...goal.ownerReview, completedAt: now }
        delete goal.ownerReview
      }
      return
    }
    // Do not convert an ambiguous historical stop into automatic idle.
    delete goal.reviewAttempt
    // An inspection-only turn is deliberately unable to record checks. Do not
    // spin every minute while human investigation of the old stop is pending.
    goal.ownerReviewAt = now + GOAL_REVIEW_INTERVAL_MS
    goal.updatedAt = now
    goal.revision += 1
  }

  async function goalReviewFinished(room, sessionId, id) {
    if (!goalReviewAllowed(room, id) || room.sessions?.[room.admin] !== sessionId) return
    // The round may still be dispatching the admin's replies to other members.
    // Keep the fence until the round finishes; a long-running admin turn whose
    // round already ended must instead finish the check here.
    if ([...rt.roomProgress.values()].some(round => round.roomId === room.id && round.goalReviewId === id)) {
      room.goal.reviewAttempt.adminCompleted = true
      await rt.save({ required: true })
      return
    }
    finishReview(room, 'admin-pass')
    await rt.save({ required: true })
  }

  async function goalReviewFailed(room, sessionId, id) {
    if (!goalReviewAllowed(room, id) || room.sessions?.[room.admin] !== sessionId) return
    room.goal.reviewAttempt.state = 'uncertain'
    try { await rt.save({ required: true }) } finally {
      rt.noteFailure?.({ level: 'warn', source: 'goal', code: 'GOAL_REVIEW_UNCERTAIN', text: `Periodic goal review ${id} for ${room.name} did not complete; inspect its original work before recovery.` })
    }
  }

  // The root relay took this review into a batch but chose a different opener.
  // No admin delivery exists for it, so it is safe to retire the intent and
  // let the ordinary round-end driver or the next timer make a fresh check.
  async function goalReviewNotOpened(room, id) {
    const goal = room?.goal
    if (goal?.reviewAttempt?.id !== id) return
    const autoIdle = automaticIdle(goal)
    delete goal.reviewAttempt
    goal.revision += 1
    goal.updatedAt = Date.now()
    if (autoIdle) {
      goal.idleRevision = goal.revision
      goal.reviewAt = goal.updatedAt + GOAL_REVIEW_POLL_MS
    }
    if (goal.idle !== true || inspectionOnlyIdle(goal)) goal.ownerReviewAt = goal.updatedAt + GOAL_REVIEW_POLL_MS
    await rt.save({ required: true })
  }

  async function goalReviewPoll(now = Date.now()) {
    if (reviewDisposed) return
    await rt.load()
    if (reviewDisposed || rt.readOnly() !== undefined) return
    const jobs = []
    for (const room of Object.values(rt.state.rooms ?? {})) {
      const goal = room.goal
      const attempt = goal?.reviewAttempt
      if (attempt && Number.isFinite(attempt.at) && now - attempt.at >= GOAL_REVIEW_INTERVAL_MS && !reviewNotified.has(attempt.id)) {
        reviewNotified.add(attempt.id)
        rt.noteFailure?.({ level: 'warn', source: 'goal', code: 'GOAL_REVIEW_UNCERTAIN', text: `Periodic goal review ${attempt.id} for ${room.name} is still unresolved; inspect its original work before recovery.` })
      }
      if (attempt?.adminCompleted === true && goalReviewAllowed(room, attempt.id) && !reviewing.has(room.id)) {
        reviewing.add(room.id)
        jobs.push((async () => {
          try {
            const root = await rt.resolveAgent(attempt.rootSessionId)
            const adminAgent = await rt.resolveAgent(attempt.adminSessionId)
            const quiet = agent => Array.isArray(agent?.inbox?.nextStep) && Array.isArray(agent?.inbox?.nextTurn)
              && agent.inbox.nextStep.length === 0 && agent.inbox.nextTurn.length === 0
              && rt.live.get(agent.session.id)?.turn === undefined && rt.hasSubagents?.(agent.session.id) !== true
              && rt.waitsForApproval?.(agent.session.id) !== true
            if (!goalReviewAllowed(room, attempt.id) || !quiet(root) || !quiet(adminAgent)
              || [...rt.roomProgress.values()].some(round => round.roomId === room.id)
              || (!attempt.inspectOnly && hasUnreadRoomDeliveries(room)) || (rt.workingInRoom?.(room) ?? []).length > 0 || rt.roomBatchPending?.(room.id) === true
              || (rt.roomInbox.get(room.id)?.length ?? 0) > 0 || (rt.roomLaterCount?.(room.id) ?? 0) > 0) return
            finishReview(room, 'admin-pass', now)
            await rt.save({ required: true })
          } catch (error) {
            rt.warn('ds-bot: completed goal review recovery in %s failed: %s', room.name, error)
          } finally { reviewing.delete(room.id) }
        })())
        continue
      }
      // A different owner's progress must not reset the period for everyone.
      const due = goal?.idle === true && !inspectionOnlyIdle(goal) ? goal.reviewAt
        : Number.isFinite(goal?.ownerReviewAt) ? goal.ownerReviewAt
          : (goal?.startedAt ?? goal?.createdAt ?? goal?.updatedAt) + GOAL_REVIEW_INTERVAL_MS
      if (reviewEligible(goal) && Number.isFinite(due) && due <= now && hasUnreadRoomDeliveries(room) && !reviewNotified.has(`unread:${room.id}`)) {
        reviewNotified.add(`unread:${room.id}`)
        rt.noteFailure?.({ level: 'warn', source: 'goal', code: 'GOAL_ROOM_DELIVERY_UNCERTAIN', text: `Group ${room.name} has unresolved delivery notes. Goal reviews are restricted to inspection until their outcome is known.` })
      }
      if (!reviewEligible(goal) || goal.reviewAttempt !== undefined || reviewing.has(room.id)
        || !Number.isFinite(due) || due > now) continue
      const admin = room.admin === undefined || room.admin === null ? undefined : rt.botOf(room.admin)
      if (admin === undefined || !room.members.includes(admin.id)) continue
      const adminBusy = () => {
        const sessionId = room.sessions?.[admin.id]
        return sessionId !== undefined && (rt.live.get(sessionId)?.turn !== undefined
          || rt.hasSubagents?.(sessionId) === true || rt.waitsForApproval?.(sessionId) === true)
      }
      if (adminBusy()) {
        const key = `busy:${room.id}`
        if (now - due >= GOAL_REVIEW_POLL_MS && !reviewNotified.has(key)) {
          reviewNotified.add(key)
          rt.noteFailure?.({ level: 'warn', source: 'goal', code: 'GOAL_REVIEW_DELAYED', text: `Goal review in ${room.name} is overdue while its administrator is busy; it will be checked again.` })
        }
        continue
      }
      reviewNotified.delete(`busy:${room.id}`)
      reviewing.add(room.id)
      jobs.push((async () => {
      const id = randomUUID()
      try {
        const root = await rt.resolveAgent(rt.sessionOfRoom(room))
        // Appending to nextTurn preserves existing room work and arrival order.
        const canQueue = () => Array.isArray(root.inbox?.nextStep) && Array.isArray(root.inbox?.nextTurn)
          && root.session?.id === rt.sessionOfRoom(room) && !adminBusy()
        if (rt.roomOf(room.id) !== room || room.goal !== goal || !reviewEligible(goal) || goal.reviewAttempt !== undefined
          || !canQueue()) return
        rt.requireHomeLock()
        const current = () => rt.roomOf(room.id) === room && room.goal === goal && goalReviewAllowed(room, id)
          && room.admin === admin.id && room.members.includes(admin.id)
          && root.session?.id === rt.sessionOfRoom(room)
        const stageId = goal.stages[goal.current]?.id
        if (goal.ownerReview?.stageId !== stageId) goal.ownerReview = { stageId, checks: {} }
        goal.reviewAttempt = { id, at: now, state: 'admitting', adminId: admin.id, rootSessionId: root.session.id, adminSessionId: room.sessions?.[admin.id], checkedBefore: openReviewTasks(goal).length - missingFor(room).length, ...(inspectionRequired(room) ? { inspectOnly: true } : {}) }
        goal.revision += 1
        if (goal.idle === true) goal.idleRevision = goal.revision
        goal.updatedAt = now
        // Persist before admission: if the host dies after this point, never
        // guess whether the same check was sent or create another check.
        await rt.save({ required: true })
        if (!current() || !canQueue() || (inspectionRequired(room) && goal.reviewAttempt.inspectOnly !== true)) {
          // The check has not been admitted, so this particular intent can be
          // cancelled safely when other work appeared during the save.
          if (room.goal === goal && goal.reviewAttempt?.id === id) {
            const autoIdle = automaticIdle(goal)
            delete goal.reviewAttempt
            goal.revision += 1
            if (autoIdle) goal.idleRevision = goal.revision
            await rt.save({ required: true })
          }
          return
        }
        await queueGoalRelay(room, 'nudge', '[Goal check]', 'DS Bot', { reviewId: id, inspectOnly: goal.reviewAttempt.inspectOnly === true, valid: current, agent: root })
      } catch (error) {
        // followup can insert before it throws or before flush fails. Keep the
        // attempt for inspection; neither timer nor restart may resend it.
        if (goal.reviewAttempt?.id !== id) {
          rt.warn('ds-bot: periodic goal review preparation for %s failed or already settled: %s', room.name, error)
          return
        }
        rt.warn('ds-bot: periodic goal review for %s has an uncertain outcome: %s', room.name, error)
        if (goal.reviewAttempt?.id === id && goal.reviewAttempt.state === 'admitting') goal.reviewAttempt.state = 'uncertain'
        await rt.save({ required: true }).catch(() => {})
        rt.noteFailure?.({ level: 'warn', source: 'goal', code: 'GOAL_REVIEW_UNCERTAIN', text: `Periodic goal review ${id} for ${room.name} requires inspection before retry.` })
      } finally {
        reviewing.delete(room.id)
      }
      })())
    }
    await Promise.allSettled(jobs)
  }

  ctx.effect(() => {
    const timer = setInterval(() => void goalReviewPoll().catch(error => rt.warn('ds-bot: periodic goal review failed: %s', error)), GOAL_REVIEW_POLL_MS)
    timer.unref?.()
    return () => { reviewDisposed = true; clearInterval(timer) }
  }, 'ds-bot: periodic goal review')

  // The idle driver: once a round ends with the goal active and nothing running,
  // wake the admin for a goal check. Progress — a user message or a member's work
  // (the admin's own tools do not count) — only resets the check count; the round
  // still gets its check. An admin that passes waits for the user, and two checks
  // without progress mark the goal idle until something happens.
  async function goalDrive(room, round) {
    const goal = room.goal
    const admin = room.admin === undefined || room.admin === null ? undefined : rt.botOf(room.admin)
    if (round.goalReviewId && goalReviewAllowed(room, round.goalReviewId)) {
      const slot = round.slots.find(item => item.id === admin?.id)
      if ((slot !== undefined && ['passed', 'posted'].includes(slot.status)) || goal.reviewAttempt?.adminCompleted === true) {
        finishReview(room, slot?.status === 'passed' ? 'admin-pass' : 'nudge-limit')
        await rt.save({ required: true })
      }
      return
    }
    // A scheduled review may already have been consumed or admitted even if
    // its outcome is unknown. The ordinary idle driver must not send another.
    if (goal?.reviewAttempt !== undefined) return
    if (goal === undefined || goal.status !== 'active' || goal.idle === true || admin === undefined || !room.members.includes(admin.id)) return
    // A round nobody spoke in — e.g. a stop notice or a stale check — never nudges.
    if (round.stoppedOnly === true || round.slots.length === 0) return
    if (round.userMessage === true || round.slots.some(slot => slot.worked === true && slot.id !== admin.id)) goal.nudges = 0
    if (round.goalNudge === true && round.slots.some(slot => slot.id === admin.id && slot.status === 'passed')) {
      parkAutomatically(goal, 'admin-pass')
      await rt.save()
      return
    }
    if ((rt.workingInRoom?.(room) ?? []).length > 0) return
    if (rt.roomBatchPending?.(room.id) === true) return
    if ((rt.roomInbox.get(room.id)?.length ?? 0) > 0) return
    if (goal.nudges >= GOAL_IDLE_NUDGES) {
      parkAutomatically(goal, 'nudge-limit')
      await rt.save()
      return
    }
    goal.nudges += 1
    goal.revision += 1
    goal.updatedAt = Date.now()
    await rt.save()
    await queueGoalRelay(room, 'nudge', '[Goal check]', 'DS Bot')
  }

  // Member work can outlive the round it grew out of; the round-end check then
  // skips the room, and nothing else would wake the admin when the last of it
  // settles. Settle — no round running, nobody working, no call batch, an
  // empty inbox — runs the same check once: the fake round's one worked slot
  // only says progress happened (the work that just ended), so the check gets
  // a fresh budget.
  const SETTLE_ROUND = Object.freeze({ stoppedOnly: false, slots: Object.freeze([{ id: '', worked: true }]) })

  async function goalSettled(room) {
    if (room === undefined) return
    if ([...rt.roomProgress.values()].some(round => round.roomId === room.id)) return
    await goalDrive(room, SETTLE_ROUND)
  }

  // The user pressed stop in the group: the goal waits for them instead of
  // waking the admin through the stop-notice round.
  const goalUserStopped = async (roomId, memberId) => {
    const room = rt.roomOf(roomId)
    const goal = room?.goal
    if (goal?.status !== 'active') return
    if (memberId !== undefined && !room.members.includes(memberId)) return
    if (memberId !== undefined && goal.idleReason === 'user-stop') return
    const previous = Object.fromEntries(['idle', 'idleReason', 'idleRevision', 'stoppedMembers'].map(key => [key, goal[key]]))
    goal.idle = true
    goal.idleReason = memberId === undefined ? 'user-stop' : 'member-stop'
    if (memberId !== undefined) goal.stoppedMembers = [...new Set([...(goal.stoppedMembers ?? []), memberId])]
    if (goal.reviewAttempt) goal.reviewAttempt.state = 'cancelled-uncertain'
    goal.revision += 1
    goal.updatedAt = Date.now()
    const revision = goal.revision
    await rt.save({ required: true })
    return { goal, revision, previous }
  }

  // A stop-member command which proved that there was no running work did not
  // stop this member. Restore only our own fence, and never overwrite a later
  // goal update. A review cancelled during the fence stays uncertain.
  async function goalUndoEmptyMemberStop(roomId, token) {
    const goal = rt.roomOf(roomId)?.goal
    if (!token || goal !== token.goal || goal.revision !== token.revision) return
    for (const key of ['idle', 'idleReason', 'idleRevision', 'stoppedMembers']) {
      if (token.previous[key] === undefined) delete goal[key]
      else goal[key] = token.previous[key]
    }
    goal.revision += 1
    if (goal.idle === true && AUTO_IDLE_REASONS.has(goal.idleReason)) goal.idleRevision = goal.revision
    goal.updatedAt = Date.now()
    await rt.save({ required: true })
  }

  // A user post in the room — its own message or a goal draft — brings the goal
  // out of its idle wait and resets the count of fruitless wakes.
  const goalUserMessage = (roomId) => {
    const goal = rt.roomOf(roomId)?.goal
    if (goal === undefined || (goal.idle === undefined && goal.nudges === 0)) return
    if (goal.idle === true && !automaticIdle(goal)) return
    clearIdle(goal)
    goal.nudges = 0
    goal.revision += 1
    goal.updatedAt = Date.now()
    void rt.save().catch(() => {})
  }

  const mark = (roomId, botId, from, to, note) => {
    const room = rt.roomOf(roomId)
    if (room !== undefined && markTasks(room, botId, from, to, note)) void rt.save().catch(() => {})
  }

  rt.teamTools.push(defineTool({
    name: 'group_goal',
    description: "Set and run one group goal. Show an existing goal before changing it; independent goals are tracked separately. Start only when no active or paused group goal exists. Revise constraints replaces the full list; revise stages rebuilds current and later stages and loses notes, rework feedback and IDs, while show omits complete future task details. Update one status with task; before replacing stages, retrieve and preserve complete definitions and evidence, or do not rebuild. Register at most one aggregated task per Bot per stage. Pass marks every current-stage task done: first verify every task to be marked done is actually complete and all acceptance evidence is valid; handle inapplicable tasks by a documented scope decision and safe stage reconciliation, not a false done. Rework with bot targets one member; first verify the member has a task in the current stage and preserve evidence and notes. Targeted rework clears affected task notes; without bot it resets the whole stage and clears all task notes. Pause or resume only on explicit user request. Stop may stop other members working in the group; use only for an explicit request to stop the whole goal. Keep current user authorization and applicable rules.",
    parameters: {
      group: { type: 'string', description: 'Exact group chat name from list_bots; leave out inside that group' },
      action: { type: 'string', required: true, enum: ['show', 'draft', 'start', 'revise', 'task', 'pass', 'rework', 'complete', 'pause', 'resume', 'stop', 'review-check'], description: 'What to do' },
      review_task: { type: 'string', description: 'review-check: current task ID from show' },
      review_fingerprint: { type: 'string', description: 'review-check: exact current task review fingerprint from show' },
      review_assignment: { type: 'string', description: 'review-check: received, queued, or unknown and source' },
      review_progress: { type: 'string', description: 'review-check: work arrangement and progress, or unknown' },
      review_dependencies: { type: 'string', description: 'review-check: dependencies and blockers, or unknown' },
      review_next: { type: 'string', description: 'review-check: next action and responsible person, or unknown' },
      review_deadline: { type: 'string', description: 'review-check: response/check time, or unknown' },
      review_complete: { type: 'boolean', description: 'review-check: true only if the actual task/owner check is complete; false for unknown or incomplete checks' },
      title: { type: 'string', description: 'Short title, up to 80 characters' },
      brief: { type: 'string', description: 'draft: what the user wants, in their words' },
      objective: { type: 'string', description: 'start, revise: the one outcome the group must reach' },
      acceptance: { type: 'string', description: 'start, revise: how to check the whole goal is done: commands or tests to run, files or results to look at, and the evidence to show' },
      constraints: { type: 'array', items: { type: 'string' }, description: 'start, revise: rules every member keeps, including the user\'s corrections. Replaces the list' },
      stages: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          // Not schema-required so a missing field gets the refusal text the
          // caller can fix, not a bare argument error.
          properties: {
            title: { type: 'string' },
            acceptance: { type: 'string' },
            tasks: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  bot: { type: 'string' },
                  task: { type: 'string' },
                },
              },
            },
          },
        },
        description: 'start: every stage, in order. revise: replaces the current stage and every stage after it; passed stages stay. Each stage has a title, a check and at most one aggregated task per member by exact name; track separately required acceptance items on the project board',
      },
      bot: { type: 'string', description: "task: the member whose task changes. rework: name the affected member and first confirm they have a task in the current stage; the tool does not verify this. Targeted rework clears that member's affected task notes; omitting bot resets the entire current stage and clears all task notes. If a member has multiple tasks, all of that member's tasks are reset." },
      stage: { type: 'integer', description: 'task: stage number, 1 for the first; the current stage when left out' },
      status: { type: 'string', enum: ['pending', 'working', 'reported', 'done'], description: 'task: the task\'s new status' },
      note: { type: 'string', description: 'task: where the task stands, in a few words' },
      evidence: { type: 'string', description: 'pass, complete: what shows it is done: test output, changed files, check results' },
      reason: { type: 'string', description: 'revise, rework, stop: why' },
      summary: { type: 'string', description: 'complete: what the group delivered, for the user' },
    },
    output,
    async execute(args, exec) {
      await rt.load()
      const self = rt.selfOf(exec.agent?.id)
      const member = rt.botOf(self)
      if (member === undefined) return 'Only Bots on the team can use group_goal.'
      const action = String(args.action ?? '')
      let room = rt.roomOf(rt.groupOwners.get(exec.agent?.id)?.roomId)
      if (room === undefined) {
        if (String(args.group ?? '').trim() === '') return required('group', action)
        const picked = rt.pickRoom(args.group, self)
        if (picked.error !== undefined) return picked.error
        room = picked.room
      }
      const admin = room.members.map(rt.botOf).filter(Boolean).find(bot => rt.isAdminOf(room, bot.id))
      const change = action !== 'show'
      if (change && !rt.isMain(self) && !rt.isAdminOf(room, self)) {
        return admin !== undefined
          ? `Only ${admin.name}, the admin of "${room.name}", or a Main Bot changes its goal. Tell the admin in the group.`
          : `Only a Main Bot changes the goal of "${room.name}".`
      }
      if ((action === 'draft' || action === 'start') && admin === undefined) {
        return `"${room.name}" has no admin, and a goal needs one to run it. Set an admin with update_group first.`
      }
      const of = memberOf(room)
      const names = memberNames(room)
      let result
      let next = ''
      let post
      switch (action) {
        case 'show': {
          const fingerprint = inspectionFingerprint(room.goal)
          const ledger = goalLedger(room, member, { showBackup: true })
          const info = rt.live.get(exec.agent?.id)?.info
          const attempt = room.goal?.reviewAttempt
          if (info?.reviewInspect === true && info.reviewId && rt.isAdminOf(room, self)
            && attempt?.id === info.reviewId && goalReviewAllowed(room, info.reviewId)) {
            if (!fingerprint || fingerprint !== inspectionFingerprint(room.goal)) return 'Goal changed while producing its ledger; do not dispatch or claim it complete.'
            attempt.inspectionLedgerAt = Date.now()
            attempt.inspectionLedgerFingerprint = fingerprint
            try { await rt.save({ required: true }) } catch {
              delete attempt.inspectionLedgerAt
              delete attempt.inspectionLedgerFingerprint
              attempt.state = 'uncertain'
              attempt.saveOutcomeUnknown = true
              rt.noteFailure?.({ level: 'warn', source: 'goal', code: 'GOAL_INSPECTION_SAVE_UNCERTAIN', text: `The goal inspection ${info.reviewId} could not be durably confirmed.` })
              return 'Goal inspection could not be durably confirmed; do not dispatch or retry until its outcome is inspected.'
            }
            if (!goalReviewAllowed(room, info.reviewId) || fingerprint !== inspectionFingerprint(room.goal)) return 'Goal inspection changed while saving; do not dispatch or claim it complete.'
          }
          return ledger
        }
        case 'review-check': {
          const info = rt.live.get(exec.agent?.id)?.info
          const goal = room.goal
          const stage = goal?.stages?.[goal.current]
          const reviewId = info?.reviewId
          if (!reviewId || !rt.isAdminOf(room, self) || !goalReviewAllowed(room, reviewId)
            || (info.reviewInspect === true && scopedReviewTask(room,args.review_task)===undefined)) return 'Only an active review with an unrelated, unblocked task may record a check.'
          const task = stage?.tasks?.find(item => item.id === args.review_task && item.status !== 'done')
          if (!task || args.review_fingerprint !== reviewFingerprint(task)) return 'Task changed or is not an unfinished task in the current stage; show the goal again.'
          const fields = ['review_assignment', 'review_progress', 'review_dependencies', 'review_next', 'review_deadline', 'evidence']
          if (fields.some(key => typeof args[key] !== 'string' || !args[key].trim() || args[key].length > TEXT_MAX)) return 'Provide each review field and evidence, marking unknown facts explicitly.'
          if (args.review_complete === true && fields.some(key => /\b(?:unknown|unverified|not verified|not checked|pending verification)\b|未知|未核|待核|不确定|待确认|无法确认/i.test(args[key]))) return 'Unknown or unverified facts require review_complete false; retain the task for a later check.'
          const previous = goal.ownerReview
          const checks = previous?.stageId === stage.id ? { ...previous.checks } : {}
          const scopedQueueVersion = rt.reviewQueueVersion?.(room.id, task.botId)
          if (scopedQueueVersion === undefined) return 'Recovery queue version is unavailable; this check remains unresolved.'
          checks[task.id] = { fingerprint: args.review_fingerprint, owner: task.botId, at: Date.now(), by: self, unresolved: args.review_complete !== true, ...(scopedQueueVersion === undefined ? {} : { scopedQueueVersion }), ...Object.fromEntries(fields.map(key => [key, args[key].trim()])) }
          const updated = { stageId: stage.id, checks }
          goal.ownerReview = updated
          try { await rt.save({ required: true }) } catch (error) {
            // The atomic replacement may already have happened even if a later
            // stamp failed. Never claim this assertion was not saved or let this
            // review continue in the current host under an ambiguous outcome.
            if (goal.ownerReview === updated) updated.checks[task.id].unresolved = true
            if (goal.reviewAttempt?.id === reviewId) {
              goal.reviewAttempt.state = 'uncertain'
              goal.reviewAttempt.saveOutcomeUnknown = true
            }
            rt.noteFailure?.({ level: 'warn', source: 'goal', code: 'GOAL_REVIEW_SAVE_UNCERTAIN', text: `The owner review record for ${task.id} may have been saved; inspect before retrying.` })
            throw error
          }
          if (!goalReviewAllowed(room, reviewId)) return 'The review stopped while saving. Its record must be inspected before further action.'
          if (scopedQueueVersion !== undefined && missingFor(room).some(item => item.id === task.id)) return 'The queue or task changed while saving; the recorded check is unresolved and must be inspected again.'
          return `Recorded the administrator's check for ${task.id}; ${missingFor(room).length} current task(s) remain unchecked or changed.`
        }
        case 'draft':
          result = draftGoal(room, { brief: args.brief, title: args.title, by: self })
          next = 'Aligning. Ask the user only what is still open, then call group_goal start.'
          break
        case 'start':
          result = startGoal(room, args, self, of, names)
          next = 'Started. Check ownership, dependencies, authorization and capacity; hand out only ready tasks needing assignment with @Name, and record blockers.'
          break
        case 'revise':
          result = reviseGoal(room, args, self, of, names)
          next = 'Changed. Tell the group what changed, and go on with the current stage.'
          break
        case 'task':
          result = taskGoal(room, args, self, of, names)
          break
        case 'pass':
          result = passGoal(room, args, self)
          next = result.goal === undefined ? ''
            : result.goal.stages[result.goal.current] !== undefined
              ? `Stage ${result.goal.current} passed. Stage ${result.goal.current + 1} "${result.goal.stages[result.goal.current].title}" is current: check ownership, dependencies, authorization and capacity, then hand out only ready tasks needing assignment with @Name.`
              : 'Every stage passed. Check the overall "done when", then call group_goal complete with the evidence and a summary for the user.'
          break
        case 'rework':
          result = reworkGoal(room, args, self, of, names)
          next = 'Sent back. Preserve prior evidence, identify the affected owner and missing work, and assign only when ready and not already being handled.'
          break
        case 'complete':
          result = completeGoal(room, args, self)
          next = 'Complete. Tell the user what was delivered.'
          break
        case 'pause':
          result = pauseGoal(room, self)
          next = 'Paused. Hand out no stage work until the goal is resumed.'
          break
        case 'resume':
          result = resumeGoal(room, self)
          next = 'Resumed. Take the next step now.'
          break
        case 'stop':
          result = stopGoal(room, args.reason, self)
          next = 'Stopped.'
          // The caller keeps running; the other members' work stops.
          post = async () => {
            for (const id of room.members.filter(other => other !== self)) await rt.stopMemberWork?.(room.id, id)
          }
          break
        default:
          return `Unknown action ${action}.`
      }
      if (result.error !== undefined) return result.error
      if (result.reply !== undefined) announce(room, result.reply)
      await rt.save()
      if (post !== undefined) await post()
      const ledger = goalLedger(room, member)
      return next === '' ? ledger : `${ledger}\n${next}`
    },
  }))

  Object.assign(rt, {
    goalBlock, goalLedger, goalDraft, goalControl, goalDrive, goalSettled, goalUserMessage, goalUserStopped, goalUndoEmptyMemberStop, goalStopBegin, goalStopEnd, goalDispatchBlocked, goalRecoveryBlocked, goalReviewPoll, goalReviewAllowed, goalReviewBind, goalReviewFinished, goalReviewFailed, goalReviewNotOpened,
    goalTaskWorking: (roomId, botId) => mark(roomId, botId, 'pending', 'working'),
    goalTaskReported: (roomId, botId) => mark(roomId, botId, 'working', 'reported'),
    goalTaskReset: (roomId, botId, note) => mark(roomId, botId, 'working', 'pending', note),
  })
}
