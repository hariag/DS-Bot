// Group goals: one outcome the whole group works toward, checked stage by stage.
// The state lives on the room (room.goal, archived into room.pastGoals), the admin
// runs it with the group_goal tool, the user steers it from the goal endpoints,
// and the relay wakes the admin when nothing runs and the goal is not done.
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { dirname } from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { goalNoteContext, validGoalTime } from '../shared/goal-note.js'
import { SOURCE_KIND } from './constants.js'
import { headOf } from './text.js'
import { output } from './tools.js'
import { currentGoalBoardTaskId } from './legacy-goal.js'
import { completedInspection, inspectionMessageHash, inspectionSourceMatches } from './inspection-terminal.mjs'
import { syncDirectory } from './directory-sync.mjs'
import { scheduleChangeId } from './room-schedule-delivery.js'

// DSH can inject a schedule-change notice without waking an agent. Only a
// verified no-action notice may remain queued while the room is considered idle.
function quietInbox(agent, openingId) {
  const other = message => (openingId === undefined || message.id !== openingId) && !scheduleChangeId(message)
  return Array.isArray(agent?.inbox?.nextStep) && Array.isArray(agent?.inbox?.nextTurn)
    && !agent.inbox.nextStep.some(other) && !agent.inbox.nextTurn.some(other)
}

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
const inspectionFingerprint = (goal, includeRevision = true) => {
  if (!goal || typeof goal.id !== 'string') return undefined
  const stage = goal.stages?.[goal.current]
  return createHash('sha256').update(JSON.stringify({
    id: goal.id, ...(includeRevision ? { revision: goal.revision } : {}), status: goal.status, title: goal.title,
    objective: goal.objective, acceptance: goal.acceptance, constraints: goal.constraints,
    current: goal.current, stage: stage === undefined ? null : {
      id: stage.id, title: stage.title, acceptance: stage.acceptance, status: stage.status,
      tasks: (stage.tasks ?? []).map(reviewFingerprint),
    },
  })).digest('hex')
}

const receiptStatus = (receipt, now = Date.now()) => {
  if (receipt.state === 'needs-decision') return 'user decision needed; no independent board reviewer is assigned'
  if (receipt.state === 'answered') return 'reply recorded (self-report; check evidence)'
  if (now < receipt.deadline) return `follow-up ${receipt.state}; response due ${new Date(receipt.deadline).toISOString()}`
  return `follow-up ${receipt.state}; deadline passed without a reply. Check the original group record, then escalate to the authorized reviewer or ask the user for a decision. Do not resend the same question.`
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
// The reconciliation horizon for existing review receipts. Native schedules own new occurrences.
export const GOAL_REVIEW_INTERVAL_MS = 30 * 60 * 1000
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

const TASK_NOTE_FIELDS = ['note', 'noteStatus', 'noteStatusVersion', 'noteAt', 'noteHistory']

function clearTaskNotes(task) {
  for (const field of TASK_NOTE_FIELDS) delete task[field]
}

export function taskNoteUnchanged(task, note, now) {
  if (note === undefined) return true
  if (note === '') return TASK_NOTE_FIELDS.every(field => !Object.hasOwn(task, field))
  return task.note === note && goalNoteContext(task, now).kind === 'current'
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

const goalHasBoardImages = goal => (goal?.stages ?? []).some(stage => (stage?.tasks ?? []).some(task => Array.isArray(task?.boardImages) && task.boardImages.length>0))
const goalHasBoardDetails = goal => (goal?.stages ?? []).some(stage => (stage?.tasks ?? []).some(task => {
  const data=task?.boardDetails
  return !!(data?.description || data?.dueDate || data?.labels?.length || data?.checklist?.length || task?.boardComments?.length)
}))
const goalHasTaskAudit = goal => !!goal?.retiredGoalTasks?.length || (goal?.stages ?? []).some(stage => (stage?.tasks ?? []).some(task => task?.goalBoardReplies?.length))
const goalHasCardRevisions = goal => goal?.boardCards !== undefined && (!goal.boardCards || typeof goal.boardCards!=='object'
  || Array.isArray(goal.boardCards) || Object.keys(goal.boardCards).length>0)

export function archiveGoal(room) {
  const goal = room.goal
  if (goal === undefined) return
  const all=[...(room.pastGoals ?? []),goal]
  // Keep the sole copy of board data when ordinary goal history rolls over.
  room.pastGoals = [...all.slice(0,-PAST_MAX).filter(goal=>goalHasBoardImages(goal)||goalHasBoardDetails(goal)||goalHasTaskAudit(goal)||goalHasCardRevisions(goal)||goal.reviewResolutions!==undefined),...all.slice(-PAST_MAX)]
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
  const retain = previous && previous.title === stage.title && previous.acceptance === stage.acceptance
  return {
    id: retain ? previous.id : `s${++goal.counter.stage}`,
    title: stage.title,
    acceptance: stage.acceptance,
    status,
    tasks: stage.tasks.map((task) => {
      const matches = previous?.tasks.filter(old => old.botId === task.botId && old.task === task.task) ?? []
      const duplicates = stage.tasks.filter(item => item.botId === task.botId && item.task === task.task)
      const kept = matches.length === 1 && duplicates.length === 1 ? matches[0] : undefined
      return retain && kept ? { ...kept, ...task, id:kept.id } : { id: `t${++goal.counter.task}`, ...task, status:'pending' }
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
    if(goalHasCardRevisions(goal)) {
      const stageIds=new Set(goal.stages.slice(Math.max(0,goal.current)).map(stage=>stage.id))
      const records=goal.boardCards && typeof goal.boardCards==='object' && !Array.isArray(goal.boardCards)?Object.values(goal.boardCards):[]
      if(!records.length || records.some(record=>!record || typeof record.stageId!=='string' || stageIds.has(record.stageId))) {
        return {error:'These stages have card revision history. Preserve that history before rebuilding the stages.'}
      }
    }
    if(goal.stages.slice(Math.max(0,goal.current)).some(stage=>goalHasBoardImages({stages:[stage]}))) {
      return {error:'These stages contain board images. Download and remove the images before rebuilding the stages.'}
    }
    if(goal.stages.slice(Math.max(0,goal.current)).some(stage=>goalHasBoardDetails({stages:[stage]}))) {
      return {error:'These stages contain board details or comments. Preserve them before rebuilding the stages.'}
    }
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
    const removed = goal.stages.slice(Math.max(0,goal.current)).flatMap(oldStage => {
      const survivor = replacement.find(stage => stage.id === oldStage.id)
      const retainedIds = new Set((survivor?.tasks ?? []).map(task => task.id))
      return oldStage.tasks.filter(task => !retainedIds.has(task.id))
        .map(task => ({stage:{id:oldStage.id,title:oldStage.title,acceptance:oldStage.acceptance},task,at:now}))
    })
    if (removed.length) goal.retiredGoalTasks = [...(goal.retiredGoalTasks ?? []), ...removed]
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
  if ((status === undefined || status === before) && taskNoteUnchanged(task, note, now)) return { goal, unchanged: true }
  if (status !== undefined) setTaskStatus(task, status, now, 'manual')
  if (note !== undefined) {
    if (note === '') clearTaskNotes(task)
    else setTaskNote(task, note, now)
  }
  task.goalBoardReplies = [...(Array.isArray(task.goalBoardReplies) ? task.goalBoardReplies : []), {
    id:`goal-update:${goal.revision + 1}:${stage.id}:${task.id}`, author:by, at:now, workflowAction:'goal-update',
    text:`[group_goal ${task.status}] ${note === undefined ? 'Status updated' : note || 'Note cleared'}`,
  }]
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
  if (goal.inspectionBackoff) {
    delete goal.inspectionBackoff
    goal.ownerReviewAt = Math.min(Number.isFinite(goal.ownerReviewAt) ? goal.ownerReviewAt : Infinity, now + GOAL_REVIEW_INTERVAL_MS)
  }
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
const OWNER_REVIEW = 'Read the current group goal and this group’s task board first. Reuse original cards, items, owners, recent evidence and handoff receipts. When the group is idle and the goal is incomplete, take concrete authorized next steps this cycle for every independent eligible task; do not stop after moving only one Bot when other independent tasks can proceed. In one group reply, give each distinct owner a separate line starting with the exact plain-text @Name, followed by task ID, requested action or evidence, and a feedback deadline. Keep active mentions outside backticks, code blocks and Markdown links; those are literal text and are neither highlighted nor dispatched. Respect dependencies by waiting for a prerequisite result before calling its dependent owner. Make at most one effective follow-up per owner for the same task in this cycle. Record progress, blocker owner, and next check on the original item. Do not duplicate an outstanding or uncertain assignment; query its original recipient for receipt/status without restarting the work. Do not repeat a follow-up before its deadline. If the deadline is missed or two scheduled checks pass without confirmation, escalate to the specific person authorized to unblock or decide and continue independent authorized work. Do not leave an incomplete goal in an ownerless or open-ended wait. Honor explicit user pause/stop and do not mark reported work done without acceptance evidence.'
const DUTY_PASSED = 'Every stage passed. Check the overall "done when", then call group_goal complete with the evidence and a summary for the user.'
const DUTY_PAUSED = "This group goal is paused. Do not assume who paused it without evidence, assign new work or pass stages for it. Continue unrelated user-authorized work that does not depend on the paused goal. Resume only on an explicit user request."
const dutyOf = goal => (goal.status === 'paused' ? DUTY_PAUSED : goal.stages[goal.current] === undefined ? DUTY_PASSED : `${DUTY_ACTIVE} ${OWNER_REVIEW}`)

const DUTY_DRAFT = [
  'Establish the goal from the user request and available facts; follow goal-grill when available and ask only for decisions genuinely needed:',
  '1. Find the facts yourself (files, code, records) or ask members with @Name. Never ask the user what you can look up.',
  '2. List the decisions only the user can make. Ask them in one message, numbered, each with your recommended answer, so the user can reply "as recommended". Skip this when nothing is open.',
  '3. When the goal is sufficiently clear, call group_goal start with objective, acceptance, rules and stages; use at most one aggregated task per Bot in each stage and track independent items on the project board.',
].join('\n')
const NUDGE_LINE = `Goal check from DS Bot: no work is currently running in this group and this goal is not finished; members may still be working elsewhere. ${OWNER_REVIEW} Dispatch only ready, authorized tasks that need assignment and fit capacity; review reported work without redispatching it. Process every independent eligible owner in this review, while keeping dependent tasks in order. Record external blockers and their owners, or complete the goal only when all requirements are verified. Use group_goal review-follow-up with the exact task ID and fingerprint from show for a real status question; each distinct task may be followed once in the same review, so do not stop after the first. Do not post a second copy for the same task. Do not reply [PASS] while an authorized action, targeted follow-up, or overdue escalation is due. If an existing follow-up is still within its stated deadline, do not repeat it; continue independent authorized work and record the exact next-check time.`
const INSPECTION_DUTY = 'This is a bounded inspection because an earlier delivery or stop is unresolved. First call group_goal show for the current group; read the original board items with board_task list/show using the exact room_id and check read_group_chat for handoffs if needed. Do not assign or restart the uncertain work, change task state, pass a stage, or override an explicit user pause/stop. Do not leave the group with only “waiting”. If the active goal is incomplete, call group_goal review-follow-up once for each distinct eligible current task that needs a receipt or exact missing evidence, using that task ID and fingerprint from show; the review permits different tasks to be followed in the same cycle. Do not stop after the first owner. Each follow-up sends a status-only group reply with one exact plain-text @Name outside backticks, code blocks and Markdown links, task ID, concrete receipt/status or exact missing-evidence question, and response deadline. For uncertain delivery, explicitly say not to repeat or restart the original work. Do not repeat the same task before its deadline. Once its recorded deadline passes without a reply, call review-follow-up again to escalate once to the linked board reviewer or record that the user needs to name a reviewer; keep only that affected action frozen and continue independent authorized work. Respect dependencies, and if no safe owner can be identified, state the exact uncertainty and who must resolve it; do not guess or wait without a next-check time. A goal panel is not proof of acceptance or completion; reported work remains incomplete until verified.'
const SCOPED_INSPECTION_DUTY = 'First call group_goal show for this group and read its original board items with board_task list/show using the exact room_id. Earlier deliveries have unresolved outcomes for specific owners; never repeat or redispatch that work. For every other current owner, inspect status, evidence, dependencies and capacity and record review-check for the exact task and current fingerprint. If the active goal is incomplete and this group is idle, take concrete authorized steps this cycle: read evidence for reported work; assign each uniquely owned, ready pending task with message_bot when="queue", full task text and request_id "goal-review:<reviewId>:<taskId>:assign"; or request exact missing evidence from each unblocked reported owner after recording review-check, using its review_next and request_id "goal-review:<reviewId>:<taskId>:evidence" with when="now". For each earlier delivery to a uniquely identifiable owner that is unresolved, call group_goal review-follow-up once with the exact task ID and fingerprint from show. Different tasks may be followed in the same review; do not stop after the first owner or duplicate a task. Each status-only group reply must put the exact plain-text @Name outside backticks, code blocks and Markdown links, with task ID, receipt/status question and deadline; explicitly do not repeat the original work. Never use @all. Respect dependencies; do not repeat a follow-up before its deadline; after the recorded deadline, escalate once to the linked board reviewer or record that the user needs to name a reviewer. Never use a new request ID to retry an uncertain assignment. Do not change task status or pass a stage from this inspection. A goal panel is not proof of acceptance or completion; unknown facts remain unknown.'
const RESUME_LINE = 'The user resumed the goal. Take the next step now.'

export const goalReviewGuard = (live, roomOf = () => undefined, pickRoom = () => undefined, scoped = () => false) => exec => {
  const info = live?.get(exec.agent?.id)?.info
  if (info?.reviewInspect !== true || !info.reviewId) return undefined
  if (exec.name === 'list_bots' || (exec.name === 'group_goal' && exec.arguments?.action === 'show')) return undefined
  const room = roomOf(info.roomId)
  if (exec.name === 'board_task' && room && exec.arguments?.room_id === room.id
    && ['list', 'show'].includes(exec.arguments.action)) return undefined
  if (exec.name === 'read_group_chat' && room && typeof exec.arguments?.group === 'string'
    && exec.arguments.group.trim() === room.name && pickRoom(exec.arguments.group, exec.agent?.id)?.room?.id === room.id) return undefined
  if (room && scoped(room, info, exec) === true) return undefined
  return 'This action is blocked in a delivery inspection. The original work is held. Use the allowed evidence reads, review-check or the task-bound follow-up described in your group goal.'
}

export function install(rt) {
  const { ctx } = rt
  // A legacy caller can use its last returned ledger while the exact goal is current.
  // Keep one observation per Bot and originating room (or its private chat).
  const goalReads = new WeakMap()
  const goalBinding = room => `room_id=${room.id} goal_id=${room.goal?.id ?? 'none'} expected_revision=${room.goal?.revision ?? 0}`
  let reviewDisposed = false
  const reviewing = new Set()
  const reviewNotified = new Set()
  // An unresolved admission blocks dispatch. The host can still inspect the
  // current ledger without opening an agent, running tools, or changing the goal.
  const blockedReviewReads = new WeakMap()
  // Remember only native record coordinates. Resolve a failed inspection from
  // two bounded original turns, without scanning either session's full log.
  const reviewInputs = new WeakMap()
  const terminalCheckAt = new WeakMap()
  const terminalChecks = new Set()
  const reviewTurnEnds = new Map()
  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/end') {
      const input = reviewTurnEnds.get(session.id)
      if (input) {
        reviewTurnEnds.delete(session.id)
        input.end = event.seq
        input.turn = event.data?.turn
      }
      return
    }
    if (event.type !== 'user/message') return
    const source = event.data?.source
    if (source?.kind !== SOURCE_KIND || source.form !== 'relay' || source.reviewInspect !== true) return
    const room = rt.roomOf(source.roomId), attempt = room?.goal?.reviewAttempt
    if (attempt?.id !== source.reviewId || attempt?.inspectOnly !== true || !Number.isSafeInteger(event.seq)) return
    const root = source.role === 'goal' && source.goalId === room.goal.id && session.id === attempt.rootSessionId
    const admin = source.role === 'room' && session.id === attempt.adminSessionId
    if (!root && !admin) return
    const inputs = reviewInputs.get(attempt) ?? {}
    reviewInputs.set(attempt, inputs)
    const side = root ? 'root' : 'admin'
    if (inputs[side]) { inputs.ambiguous = true; return }
    inputs[side] = { sessionId: session.id, seq: event.seq }
    reviewTurnEnds.set(session.id, inputs[side])
  })
  const passiveEvents = new Set(['step/start', 'step/end', 'request/header', 'assistant/attempt'])
  async function verifyInspectionTurn(room, attempt, side, input) {
    const root = side === 'root'
    const { seq, end, sessionId, turn } = input
    if (!Number.isSafeInteger(turn) || !Number.isSafeInteger(end) || end <= seq || end - seq > 48) return false
    const page = await ctx.sessionController.events({ address: { kind: 'session', sessionId }, throughSeq: end,
      maxMessages: 8, turnWindow: { minMessages: 1, minTurns: 1 } }, AbortSignal.timeout(5000))
    if (page?.cursor !== end || !Array.isArray(page.records) || page.records.length > 64) return false
    const events = page.records.map(row => row?.type === 'event' && row.event)
    const start = events[0], terminal = events.at(-1)
    if (start?.type !== 'turn/start' || start.data?.turn !== turn || terminal?.type !== 'turn/end'
      || terminal.seq !== end || terminal.data?.turn !== turn || terminal.data.reason?.kind !== (root ? 'completed' : 'error')) return false
    let received = false, relayId, relayEnded = false
    for (const [index, event] of events.entries()) {
      if (!event || event.seq !== start.seq + index || (event.data?.turn !== undefined && event.data.turn !== turn)) return false
      if (index === 0 || index === events.length - 1 || passiveEvents.has(event.type)) continue
      if (event.type === 'agent/inbox/spliced') {
        // Consuming this one input is expected. Insertion, batching, and an
        // unknown splice might carry independent work into the observed turn.
        if (!Array.isArray(event.data?.inserted) || event.data.inserted.length || event.data.removedCount !== 1) return false
        continue
      }
      if (event.type === 'user/message') {
        const source = event.data?.source
        if (source?.kind === 'time-context' && source.form === 'snapshot') continue
        if (received || event.seq !== seq || !inspectionSourceMatches(source, room, attempt, root)) return false
        received = true
      } else if (root && received && event.type === 'assistant/message') {
        continue
      } else if (root && received && event.type === 'tool/call' && relayId === undefined && event.data?.name === 'group_relay' && typeof event.data.callId === 'string') {
        relayId = event.data.callId
      } else if (root && relayId !== undefined && !relayEnded && event.type === 'tool/result'
        && event.data?.message?.role === 'tool' && event.data.message.toolCallId === relayId && event.data.message.isError === false) {
        relayEnded = true
      } else return false
    }
    return received && (!root || relayEnded)
  }
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
  const pendingBatches = room => Object.values(rt.state.roomBatches ?? {}).filter(batch => batch.roomId === room.id && batch.pending?.length)
  const inspectionRequired = room => inspectionOnlyIdle(room.goal) || hasUnreadRoomDeliveries(room) || rt.roomBatchPending?.(room.id) === true

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
    if (rt.roomBatchPending?.(room.id)) {
      const batches = pendingBatches(room)
      has = true
      if (!batches.length) unknown = true
      for (const batch of batches) for (const id of batch.pending) {
        if (room.members.includes(id)) blocked.add(id)
        else unknown = true
      }
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
  const reportedReviewTask = (room, id) => {
    if (inspectionOnlyIdle(room.goal) || stopsPending.has(room.id) || room.goal?.status !== 'active') return undefined
    const matches = (room.goal.stages?.[room.goal.current]?.tasks ?? []).filter(task => task.id === id)
    const task = matches[0]
    if (matches.length === 1 && task.status === 'reported' && room.members.includes(task.botId)) return task
  }
  const canRecordReviewCheck = (room, args) => scopedReviewTask(room, args.review_task) !== undefined
    || (args.review_complete === false && reportedReviewTask(room, args.review_task) !== undefined)
  const scopedReviewMessage = (room, info, exec) => {
    const args=exec.arguments
    if(exec.name!=='message_bot' || !args || typeof args!=='object' || Array.isArray(args)
      || args.reply_to==='user' || typeof args.to!=='string' || typeof args.message!=='string')return false
    const scope=recoveryOwners(room)
    if(!scope.has || scope.unknown)return false
    const target=rt.findBot(args.to)
    if(!target || !room.members.includes(target.id) || scope.blocked.has(target.id))return false
    const stage=room.goal?.stages?.[room.goal.current],tasks=stage?.tasks ?? []
    const owned=tasks.filter(task=>task.botId===target.id && task.status!=='done')
    if(owned.length!==1)return false
    const task=owned[0],message=args.message.trim()
    if(typeof task.id!=='string' || task.id.length>64 || !message.includes(task.id))return false
    if(task.status==='pending')return args.when==='queue' && args.request_id===`goal-review:${info.reviewId}:${task.id}:assign` && message.includes(task.task)
    if(task.status!=='reported' || args.when!==undefined && args.when!=='now')return false
    const check=room.goal.ownerReview?.stageId===stage.id ? room.goal.ownerReview.checks?.[task.id] : undefined
    const queueVersion=rt.reviewQueueVersion?.(room.id,target.id)
    return args.request_id===`goal-review:${info.reviewId}:${task.id}:evidence`
      && check?.owner===target.id && check.fingerprint===reviewFingerprint(task) && check.unresolved===true
      && check.scopedQueueVersion!==undefined && check.scopedQueueVersion===queueVersion
      && typeof check.review_next==='string' && check.review_next.trim()!=='' && message.includes(check.review_next.trim())
  }
  const scopedReviewAction = (room, info, exec) => {
    if(info?.reviewInspect!==true || info.reviewReceipt || !goalReviewAllowed(room,info.reviewId)
      || room.goal.reviewAttempt.adminSessionId !== exec.agent?.id) return false
    if (exec.name === 'group_goal' && exec.arguments?.action === 'review-follow-up') return !inspectionOnlyIdle(room.goal)
    if (exec.name === 'group_goal' && exec.arguments?.action === 'review-check') return canRecordReviewCheck(room, exec.arguments)
    if(exec.name==='message_bot')return scopedReviewMessage(room,info,exec)
    if(['read','glob','grep'].includes(exec.name)) {
      const stage=room.goal?.stages?.[room.goal.current]
      return (stage?.tasks ?? []).some(task => reportedReviewTask(room, task.id) !== undefined)
    }
    return false
  }
  // This action asks for information only, including when an older assignment
  // to this owner cannot be safely replayed. The reply never settles that work.
  async function followUpOnReview(room, self, sessionId, args, info) {
    const goal = room.goal, attempt = goal?.reviewAttempt, stage = goal?.stages?.[goal.current]
    const task = stage?.tasks.find(item => item.id === args.review_task && item.status !== 'done')
    const fingerprint = args.review_fingerprint
    const stageRecords = () => goal?.reviewFollowUps?.stageId === stage?.id ? goal.reviewFollowUps?.records ?? {} : {}
    const previous = task && stageRecords()[task.id]
    const escalating = !!previous && previous.fingerprint === fingerprint && previous.state !== 'answered' && Date.now() >= previous.deadline
    const recordKey = task && (escalating ? `${task.id}:escalation` : task.id)
    const reviewer = () => rt.goalItemReviewer?.(room.id, currentGoalBoardTaskId(room, goal, stage, task))
    const contact = rt.botOf(escalating ? reviewer() : task?.botId)
    const taskCurrent = () => !!attempt && !info?.reviewReceipt && room.admin === self
      && attempt.adminSessionId === sessionId && attempt.id === info?.reviewId && goalReviewAllowed(room, attempt.id)
      && !inspectionOnlyIdle(goal) && !!task && !goalDispatchBlocked(room, task.botId)
      && room.goal === goal && goal.stages[goal.current] === stage
      && stage.tasks.includes(task) && task.status !== 'done' && reviewFingerprint(task) === fingerprint
    const current = () => taskCurrent() && !!contact && contact.id !== self && contact.private !== true
      && rt.botOf(contact.id) === contact && room.members.includes(contact.id) && !goalDispatchBlocked(room, contact.id)
      && (!escalating || (contact.id !== task.botId && contact.id === reviewer() && previous.state !== 'answered'))
    if (!taskCurrent()) return 'Choose an unfinished task and its exact fingerprint from show in the active scheduled review.'
    const exists = stageRecords()[recordKey]
    if (exists?.fingerprint === fingerprint) return `Task ${task.id} follow-up: ${receiptStatus(exists)}`
    const used = () => Object.entries(stageRecords()).some(([key, record]) => record.reviewId === attempt.id
      && (record.taskId === task.id || key === task.id || key === `${task.id}:escalation`))
    if (used()) return `Task ${task.id} already has a follow-up in this scheduled review. Continue with other eligible tasks.`
    if (!current()) {
      if (!escalating) return 'This task has no available group recipient. Inspect the board or ask for an explicit decision.'
      const decision = { reviewId:attempt.id, taskId:task.id, fingerprint, state:'needs-decision' }
      goal.reviewFollowUps = { stageId:stage.id, records:{ ...stageRecords(), [recordKey]:decision } }
      await rt.save({ required:true })
      await rt.postToRoom(room, rt.botOf(self), `Task ${task.id} @${nameOf(self)}: the owner’s response deadline passed and there is no available independent board reviewer. Ask the user to name the person who should verify the original handoff.`, { quiet:true })
      return receiptStatus(decision)
    }
    const target = await rt.ensureGroupTaskSession(room.id, contact.id)
    // Recheck after opening the target. A concurrent call may already have claimed this cycle.
    if (!current() || room.sessions?.[contact.id] !== target) return 'The task or recipient changed. Read the group goal again.'
    const latest = stageRecords()
    if (latest[recordKey]?.fingerprint === fingerprint || used()) return `Task ${task.id} already has a follow-up in this scheduled review.`
    const receipt = { exchangeId:randomUUID(), reviewId:attempt.id, fingerprint, escalation:escalating,
      taskId:task.id, contactId:contact.id, adminId:self, sessionId:target, deadline:Date.now() + 20 * 60 * 1000, state:'claimed' }
    goal.reviewFollowUps = { stageId:stage.id, records:{ ...latest, [recordKey]:receipt } }
    await rt.save({ required:true })
    const request = escalating
      ? `The follow-up to @${nameOf(task.botId)} missed its response deadline. As the original board reviewer, check the group record and say who can confirm the handoff and what evidence is still needed.`
      : 'Confirm whether you received the original handoff, its current status and existing evidence or blocker.'
    const question = `Task ${task.id}: ${request} Do not start, repeat or resume work. Reply in this group by ${new Date(receipt.deadline).toISOString()}.`
    let refused = false
    try {
      await rt.deliver({ roomId:room.id, toId:contact.id, sessionId:target, role:'room', fromId:self, exchangeId:receipt.exchangeId,
        note:'scheduled status question', reviewId:attempt.id, reviewInspect:true, reviewReceipt:true, text:question }, {
        beforeAdmission(agent, message) {
          if (!current() || !rt.goalReceiptCurrent(target, message.source)
            || !quietInbox(agent) || agent.status === 'running'
            || rt.live.get(target)?.turn !== undefined || rt.hasSubagents?.(target) || rt.waitsForApproval?.(target)) {
            throw new Error('The receipt recipient is busy or the review changed')
          }
        },
        onNotAdmitted() { refused = true },
      })
    } catch {
      if (refused) {
        rt.forgetDelivery?.(receipt.exchangeId, target)
        const currentRecords = goal.reviewFollowUps?.records
        if (currentRecords?.[recordKey] === receipt) delete currentRecords[recordKey]
      } else if (receipt.state === 'claimed') receipt.state = 'uncertain'
      await rt.save({ required:true })
      return refused ? 'The status question was not admitted. Check again when the recipient is idle.'
        : 'The status question may have reached the recipient. Check its original record before any further action.'
    }
    if (receipt.state === 'claimed') receipt.state = 'sent'
    await rt.save({ required:true })
    try {
      await rt.postToRoom(room, rt.botOf(self), `@${contact.name} ${question}`, { quiet:true })
    } catch (error) {
      rt.warn('ds-bot: status question %s was sent but its group post could not be confirmed: %s', receipt.exchangeId, error)
      return `Sent a read-only status question for ${task.id} to @${contact.name}; the group post could not be confirmed. Do not send another copy.`
    }
    return `Sent a read-only status question for ${task.id} to @${contact.name} in this group. The original task and delivery are unchanged. Next check: ${new Date(receipt.deadline).toISOString()}.`
  }

  rt.goalReceiptCurrent = (sessionId, info) => {
    if (info?.kind !== SOURCE_KIND || info.form !== 'relay' || info.role !== 'room'
      || info.reviewReceipt !== true || info.reviewInspect !== true || !info.reviewId) return false
    const room = rt.roomOf(info.roomId), goal = room?.goal, stage = goal?.stages?.[goal.current]
    if (!room || !stage || goal.status !== 'active' || inspectionOnlyIdle(goal)
      || goal.reviewFollowUps?.stageId !== stage.id || rt.readOnly() !== undefined) return false
    const receipt = Object.values(goal.reviewFollowUps.records ?? {}).find(record => record.exchangeId === info.exchangeId
      && record.reviewId === info.reviewId && record.sessionId === sessionId && record.adminId === info.senderSessionId)
    const task = stage.tasks.find(item => item.id === receipt?.taskId)
    if (!task || task.status === 'done' || reviewFingerprint(task) !== receipt.fingerprint || receipt.adminId !== room.admin) return false
    const contactId = receipt.contactId
    const isCurrentContact = receipt.escalation
      ? contactId !== task.botId && contactId === rt.goalItemReviewer?.(room.id, currentGoalBoardTaskId(room, goal, stage, task))
      : contactId === task.botId
    return isCurrentContact && room.members.includes(contactId) && room.sessions?.[contactId] === sessionId
      && !goalDispatchBlocked(room, task.botId) && !goalDispatchBlocked(room, contactId)
      && ['claimed', 'sent', 'uncertain'].includes(receipt.state) && Date.now() <= receipt.deadline
  }

  rt.goalReceiptResult = async (room, sessionId, info, answered) => {
    const state = room.goal?.reviewFollowUps
    const receipt = Object.values(state?.records ?? {}).find(record => record.exchangeId === info.exchangeId
      && record.sessionId === sessionId && record.reviewId === info.reviewId)
    if (!receipt || receipt.state === 'answered') return
    receipt.state = answered ? 'answered' : 'unanswered'
    await rt.save({ required:true })
    return answered ? { taskId:receipt.taskId, adminId:receipt.adminId } : undefined
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
    const current = room?.goal
    const observed = blockedReviewReads.get(current?.reviewAttempt)
    const goal = observed ? { ...current, blockedReviewObservation: observed } : current
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

  function boardLocator(room, goal, stage, task) {
    const id = currentGoalBoardTaskId(room, goal, stage, task)
    return id ? ` board_task.task_id=${id}` : ''
  }

  // The full ledger is returned on demand. The routine admin prompt omits per-item board IDs.
  function ledgerLines(room, goal, { board = true } = {}) {
    const lines = [`Goal: ${goal.title}`, `Objective: ${goal.objective}`, `Done when: ${goal.acceptance}`]
    if (goal.constraints.length > 0) lines.push('Rules:', ...goal.constraints.map(rule => `- ${rule}`))
    lines.push('Stages:')
    goal.stages.forEach((stage, index) => {
      const n = index + 1
      if (stage.status === 'passed') lines.push(`[passed] ${n}. ${stage.title}`)
      else if (index === goal.current) {
        lines.push(`[current] ${n}. ${stage.title} — done when: ${stage.acceptance}`)
        for (const task of stage.tasks) lines.push(`  - ${nameOf(task.botId)}: ${task.task} [${TASK_LABEL[task.status] ?? 'status unknown'}]${taskNoteText(task) || taskStatusTimeText(task)} (stage ${stage.id}, task ${task.id}, review fingerprint ${reviewFingerprint(task)})${board ? boardLocator(room, goal, stage, task) : ''}`)
        if (goal.reviewFollowUps?.stageId === stage.id) {
          for (const task of stage.tasks) {
            const receipt = goal.reviewFollowUps.records?.[task.id]
            const escalation = goal.reviewFollowUps.records?.[`${task.id}:escalation`]
            if (receipt?.fingerprint === reviewFingerprint(task)) lines.push(`  - Status question ${task.id} @${nameOf(receipt.contactId)}: ${receiptStatus(receipt)}`)
            if (escalation?.fingerprint === reviewFingerprint(task)) lines.push(`  - Escalation for ${task.id}: ${receiptStatus(escalation)}`)
          }
        }
        if (stage.reworks > 0) lines.push(`  Sent back ${stage.reworks} ${stage.reworks === 1 ? 'time' : 'times'}. Latest feedback: ${stage.feedback ?? ''}`)
      } else lines.push(`[next] ${n}. ${stage.title}: ${[...new Set(stage.tasks.map(task => nameOf(task.botId)))].join(', ')}`)
    })
    if (goal.stages[goal.current]?.tasks.length) lines.push(board
      ? `Use board_task show in room_id=${room.id} for the original item, its feature/bugfix parent and minor release when assigned.`
      : 'group_goal show gives the original board_task ID for each current task.')
    const corrections = (goal.events ?? []).filter(event => event.kind === 'revise' && event.text).slice(-3).map(event => event.text)
    if (corrections.length > 0) lines.push(`Latest corrections from the user: ${corrections.join(' / ')}`)
    if (goal.inspectionBackoff?.fingerprint === inspectionFingerprint(goal, false) && Number.isSafeInteger(goal.inspectionBackoff.count) && goal.inspectionBackoff.count > 0 && Number.isFinite(goal.ownerReviewAt)) lines.push(`Inspection incomplete ${goal.inspectionBackoff.count} consecutive time(s): no current goal ledger was generated. Owner checks remain pending for the next scheduled group inspection.`)
    if (goal.reviewAttempt?.terminalFailure) lines.push(`Periodic review ${goal.reviewAttempt.id} failed before administrator tools. Future reviews wait for the room's pending work to settle.`)
    else if (goal.reviewAttempt) lines.push(`Periodic review ${goal.reviewAttempt.id} is ${goal.reviewAttempt.state}; do not send it again until its original outcome is known.`)
    const observed = blockedReviewReads.get(goal.reviewAttempt)
    if (observed) lines.push(`Read-only host observation at ${new Date(observed.at).toISOString()} (revision ${observed.revision}): ${observed.open} unfinished task(s); current owner checks missing for ${observed.missing.join(', ') || 'none'}. The original review remains unresolved.`)
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
      else for (const task of tasks) lines.push(`Your task in it: ${task.task} (${TASK_LABEL[task.status] ?? 'status unknown'}).${taskNoteText(task) || taskStatusTimeText(task)}${boardLocator(room, goal, stage, task)}`)
      if (tasks.length) lines.push(`Use board_task show in room_id=${room.id} to read the original item and its current instructions. Record progress or evidence on that item under the existing workflow.`)
    }
    lines.push('Work toward this group goal and any other active goals explicitly requested by the user, within your assigned role and scope. A new request does not cancel an earlier goal unless the user clearly changes, pauses, or cancels it. When you finish your task, end your reply with the evidence: the files you changed, the commands you ran and what they printed.')
    if (goal.status === 'paused') lines.push('This group goal is paused: finish only work already underway for it and start no new work on this goal. Follow separate user requests within their authorization.')
    return { lines, stage: `${stage === undefined ? count : goal.current + 1}/${count}` }
  }

  // The <group_goal> block in every round's prompt; nudge and resume add a line
  // after it for the admin. No block at all with no goal or a finished one.
  function goalBlock(room, member, { nudge = false, resume = false, inspectOnly = false, reviewId } = {}) {
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
      const evidence = inspectOnly && !inspectionOnlyIdle(goal) && openReviewTasks(goal).some(task => reportedReviewTask(room, task.id))
        ? 'For reported tasks, inspect existing evidence with read, glob or grep under normal file permissions. Record findings with group_goal review-check and review_complete=false while an original outcome is unresolved. This does not change the card status. Shell commands are unavailable during a delivery inspection.' : ''
      block = [`<group_goal status="${goal.status}">`, ...ledgerLines(room, goal, { board: false }), inspectOnly ? (scoped ? SCOPED_INSPECTION_DUTY : INSPECTION_DUTY) : dutyOf(goal), evidence, '</group_goal>'].filter(Boolean).join('\n')
    } else {
      const view = memberLines(room, goal, member)
      block = [`<group_goal status="${goal.status}" stage="${view.stage}">`, ...view.lines, '</group_goal>'].join('\n')
    }
    if (isAdmin && nudge && reviewId && goal.reviewAttempt?.id === reviewId && goal.reviewAttempt.adminId === member.id
      && goal.reviewAttempt.scheduledPrompt) {
      block += '\nRoom schedule instructions, within the current goal, permissions and review restrictions:\n' + goal.reviewAttempt.scheduledPrompt
        + '\nA status question in this scheduled review is sent by group_goal review-follow-up. Process every distinct eligible unfinished task in this review, overdue tasks first; one task is one deduplication unit, and multiple different tasks may be followed. Do not post a second copy for a task or repeat a question from the goal ledger. Keep each active @Name on its own plain-text line outside code or Markdown links; respect task dependencies.'
    }
    if (goal.status !== 'drafting') block += '\nApply each saved goal rule only to its stated scope. Honor the latest explicit user instruction and any still-valid approval for the same action, object, environment and conditions; do not ask for the same approval again. Do not extend a lock rule beyond the operations it actually covers: evidence from a different scope can be reported for its own scope but is not a substitute for the required gate evidence. If the applicable authorization or rule scope cannot be verified, pause only the affected action and continue independent authorized work. Tell the goal owner when saved rules need a scoped update.'
    if (isAdmin && nudge && !inspectOnly) block += `\n${NUDGE_LINE}\nFor each current unfinished task you actually checked, call group_goal review-check with its task ID and exact review fingerprint from show plus the requested structured fields and evidence. Unknown or unverified facts must be marked unknown and review_complete false; only set review_complete true when the required check is actually finished. The runtime records your assertion and will continue missing or changed tasks in another turn; it does not verify the truth of your evidence.`
    if (isAdmin && resume) block += `\n${RESUME_LINE}`
    return `${block}\nCurrent goal binding: ${goalBinding(room)}. Use these fields for changes; read the goal again when they change.`
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
  function goalRelayMessage(room, goal, text, senderName, options) {
    return createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: SOURCE_KIND, form: 'relay', role: 'goal', goal, goalId: room.goal?.id,
        exchangeId: options.reviewId ?? randomUUID(), senderName, roomId: room.id,
        ...(options.reviewId ? { reviewId: options.reviewId, ...(options.inspectOnly ? { reviewInspect: true } : {}) } : {}) },
    })
  }
  async function queueGoalRelay(room, goal, text, senderName = 'You', options = {}) {
    const agent = options.agent ?? await rt.resolveAgent(rt.sessionOfRoom(room))
    if (options.valid !== undefined && !options.valid()) return false
    agent.followup(goalRelayMessage(room, goal, text, senderName, options))
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
  const pendingReviewResolutions = new Set()
  const pendingReviewRooms = new Set()
  const confirmedReviewResolutions = new WeakMap()
  const durableReviewResolutions = async (room,goal) => {
    const entries = goal.reviewResolutions
    const failure = goal.reviewAttempt?.terminalFailure
    if (entries === undefined && failure === undefined) return
    if (entries !== undefined && !Array.isArray(entries)) throw new Error('Review decision history is unavailable')
    rt.requireHomeLock()
    const lease = rt.homeLockVersion(), confirmed = confirmedReviewResolutions.get(goal)
    if (confirmed?.lease === lease && confirmed.entries === entries && confirmed.failure === failure) return
    const file = await open(rt.statePath, (process.platform === 'win32' ? constants.O_RDWR : constants.O_RDONLY) | (constants.O_NOFOLLOW ?? 0))
    try {
      const before = await file.stat()
      if (!before.isFile()) throw new Error('Review decision journal is unavailable')
      const saved = JSON.parse(await file.readFile('utf8'))?.rooms?.[room.id]?.goal
      if (saved?.id !== goal.id || JSON.stringify(saved.reviewResolutions) !== JSON.stringify(entries)
        || JSON.stringify(saved.reviewAttempt?.terminalFailure) !== JSON.stringify(failure)
        || (failure && saved.reviewAttempt?.id !== goal.reviewAttempt?.id)) throw new Error('Review decision was not saved')
      await file.sync()
      await syncDirectory(dirname(rt.statePath))
      const afterFile = await file.stat(), after = await lstat(rt.statePath)
      rt.requireHomeLock()
      if (!after.isFile() || after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino
        || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.size !== afterFile.size || before.mtimeMs !== afterFile.mtimeMs
        || rt.homeLockVersion() !== lease || rt.roomOf(room.id) !== room || room.goal !== goal
        || goal.reviewResolutions !== entries || goal.reviewAttempt?.terminalFailure !== failure) throw new Error('Review decision changed during confirmation')
      confirmedReviewResolutions.set(goal,{entries,lease,failure})
    } finally { await file.close() }
  }
  async function goalControl(roomId, body = {}, provenFailure, backgroundTerminal = false) {
    const room = rt.roomOf(roomId)
    if (room === undefined) return { error: 'Unknown group chat' }
    const goal = room.goal
    if (goal === undefined || goal.id !== String(body.goalId ?? '')) return { error: 'The goal has changed. Look again.', code: 'bot/stale' }
    const action = String(body.action ?? '')
    if (action === 'review-resolve' || action === 'review-record-failure' || action === 'review-confirm-terminal') {
      const terminal = action === 'review-confirm-terminal'
      const sameCoordinates = (record, supplied) => ['root', 'admin'].every(side =>
        record?.[side] && supplied?.[side] && ['sessionId','seq','end','turn'].every(key => record[side][key] === supplied[side][key]))
      const recordOnly = action === 'review-record-failure'
      const attempt = goal.reviewAttempt
      const allowFuture = body.decision === 'allow-future'
      const originalFailureEvidence = 'The original root turn only relayed this inspection. The administrator failed before any tool call. Owner checks remain unverified.'
      const evidence = terminal ? 'The original inspection turns ended. Owner checks and task completion remain unverified. Future inspections may run on schedule.' : recordOnly || provenFailure ? originalFailureEvidence : allowFuture ? 'User allowed future inspections; the previous outcome remains unknown.' : String(body.evidence ?? '').trim()
      if ((terminal && (body.decision !== undefined || (!backgroundTerminal && !['root','admin'].every(side => {
        const input = body[side]
        return typeof input?.sessionId === 'string' && [input.seq,input.end,input.turn].every(Number.isSafeInteger)
          && input.seq >= 0 && input.turn >= 0 && input.end > input.seq
      })))) || body.confirmed !== true || (!allowFuture && (evidence.length < 8 || evidence.length > TEXT_MAX))) return { error: 'Confirm the decision before continuing.', code: 'bot/invalid' }
      const resolutions = goal.reviewResolutions ?? []
      if (!Array.isArray(resolutions) || resolutions.length >= 10000) return { error:'Review decision history is unavailable or full.', code:'bot/refused' }
      const resolutionKey = JSON.stringify([room.id,goal.id,body.reviewId])
      if (pendingReviewResolutions.has(resolutionKey)) return { error:'The earlier decision outcome is unknown; refresh later.', code:'bot/refused' }
      const settled = resolutions.find(item => item?.id === body.reviewId)
      if (settled) {
        if ((settled.decision === 'inspection-ended') !== terminal || (terminal && !backgroundTerminal && !sameCoordinates(settled, body))) {
          return { error: 'The saved decision or native coordinates differ.', code: 'bot/stale' }
        }
        if (recordOnly && !['root', 'admin'].every(side => {
          const saved = settled.attempt?.terminalFailure?.[side] ?? settled[side], supplied = body[side]
          return saved && supplied && ['sessionId', 'seq', 'end', 'turn'].every(key => supplied[key] === saved[key])
        })) return { error: 'The recorded native coordinates differ.', code: 'bot/stale' }
        if (attempt?.id === body.reviewId) return { error:'Review identity was reused; inspect it before continuing.', code:'bot/stale' }
        try { await durableReviewResolutions(room,goal); return {} } catch { return { error:'The earlier decision outcome is unknown; refresh later.', code:'bot/refused' } }
      }
      if (!reviewEligible(goal) || attempt === undefined || attempt.id !== body.reviewId
        || !['uncertain', 'admitting', 'cancelled-uncertain'].includes(attempt.state)
        || (attempt.state === 'admitting' && (!Number.isFinite(attempt.at) || Date.now() - attempt.at < GOAL_REVIEW_INTERVAL_MS))) return { error: 'The review is not eligible for recovery, or the goal was paused or stopped.', code: 'bot/stale' }
      if (terminal && (attempt.inspectOnly !== true || !['uncertain','admitting'].includes(attempt.state) || attempt.terminalFailure
        || attempt.saveOutcomeUnknown || reviewInputs.get(attempt)?.ambiguous || stopsPending.has(room.id)
        || !Number.isFinite(attempt.at) || Date.now() - attempt.at < GOAL_REVIEW_INTERVAL_MS)) return { error:'This inspection is not eligible for terminal verification.', code:'bot/stale' }
      const currentAdminSession = room.sessions?.[attempt.adminId]
      // A verified inspection may have finished in an earlier part belonging
      // to this same admin in this same room. Never infer ownership by name.
      const sessionsMatch = () => room.admin === attempt.adminId && room.members.includes(attempt.adminId)
        && rt.sessionOfRoom(room) === attempt.rootSessionId && room.sessions?.[attempt.adminId] === currentAdminSession
        && (currentAdminSession === attempt.adminSessionId || (!allowFuture && attempt.inspectOnly === true && (terminal || attempt.state === 'uncertain' || attempt.terminalFailure)
          && typeof currentAdminSession === 'string' && typeof attempt.adminSessionId === 'string'
          && room.segments?.[attempt.adminId]?.some(part => part.sessionId === attempt.adminSessionId)))
      if (!sessionsMatch()) return { error: 'The group or administrator session changed; inspect the original sessions before recovery.', code: 'bot/stale' }
      if (recordOnly) {
        if (allowFuture || attempt.inspectOnly !== true || attempt.state !== 'uncertain' || attempt.saveOutcomeUnknown === true
          || stopsPending.has(room.id) || reviewInputs.get(attempt)?.ambiguous) return { error: 'Only an active, uncertain inspection can record its original failure.', code: 'bot/stale' }
        const inputs = {}
        for (const [side, sessionId] of [['root', attempt.rootSessionId], ['admin', attempt.adminSessionId]]) {
          const input = body[side]
          if (!input || typeof sessionId !== 'string' || input.sessionId !== sessionId || ![input.seq,input.end,input.turn].every(Number.isSafeInteger)
            || input.seq < 0 || input.turn < 0 || input.end <= input.seq || input.end - input.seq > 48) {
            return { error: 'Original inspection session and turn coordinates are required.', code: 'bot/invalid' }
          }
          inputs[side] = { sessionId, seq: input.seq, end: input.end, turn: input.turn }
        }
        const recorded = attempt.terminalFailure
        if (recorded) {
          if (!['root','admin'].every(side => JSON.stringify(recorded[side]) === JSON.stringify(inputs[side]))) return { error: 'The recorded native coordinates differ.', code: 'bot/stale' }
          await durableReviewResolutions(room,goal)
          return {}
        }
        const verified = (await Promise.all(['root', 'admin'].map(side => verifyInspectionTurn(room, attempt, side, inputs[side])))).every(Boolean)
        if (provenFailure && reviewInputs.get(attempt) === provenFailure) provenFailure.proven = verified
        if (!verified || reviewInputs.get(attempt)?.ambiguous || rt.roomOf(room.id) !== room || room.goal !== goal || goal.reviewAttempt !== attempt
          || !sessionsMatch() || !reviewEligible(goal) || stopsPending.has(room.id) || attempt.state !== 'uncertain'
          || attempt.saveOutcomeUnknown === true || attempt.terminalFailure || (provenFailure && reviewInputs.get(attempt) !== provenFailure)
          || pendingReviewResolutions.has(resolutionKey)) {
          return { error: 'The original inspection failure could not be verified.', code: 'bot/stale' }
        }
        rt.requireHomeLock()
        const now = Date.now(), wasAutomatic = automaticIdle(goal)
        // Keep the original admission fence intact. Only the ordinary quiet-room
        // resolver can retire it, after existing deliveries have settled.
        attempt.terminalFailure = { ...inputs, at: now }
        goal.revision += 1
        if (wasAutomatic) goal.idleRevision = goal.revision
        goal.updatedAt = now
        goal.events = [...(goal.events ?? []), { kind: 'review-failure-recorded', by: provenFailure ? 'host' : 'user', at: now, reviewId: attempt.id, text: evidence }].slice(-EVENTS_MAX)
        await rt.save({ required: true })
        await durableReviewResolutions(room,goal)
        return {}
      }
      if (allowFuture && attempt.terminalFailure) return { error: 'The original inspection already has a verified outcome.', code: 'bot/stale' }
      const previousFailure = attempt.terminalFailure
      // A failed, tool-free administrator inspection cannot own a later batch
      // pending only for other members. Release only its proven failure; keep
      // every batch and its owners fenced for the next independent occurrence.
      const independentBacklog = () => {
        if (!previousFailure || previousFailure !== provenFailure || !attempt.inspectOnly || rt.roomBusyForPatrol(room)) return false
        const batches = pendingBatches(room)
        return batches.length > 0 && batches.every(batch => batch.at > attempt.at
          && batch.pending.every(id => id !== attempt.adminId && room.members.includes(id)))
      }
      const roomBusy = () => [...rt.roomProgress.values()].some(round => round.roomId === room.id)
        || (rt.workingInRoom?.(room) ?? []).length > 0 || (rt.roomBatchPending?.(room.id) === true && !independentBacklog())
        || (rt.roomInbox.get(room.id)?.length ?? 0) > 0 || (rt.roomLaterCount?.(room.id) ?? 0) > 0
      const busy = { error: 'The goal changed or related work is still pending. Check it before recovery.', code: 'bot/stale' }
      if (roomBusy()) return busy
      const ids = [...new Set([attempt.rootSessionId, attempt.adminSessionId, currentAdminSession].filter(id => id !== undefined))]
      let proof
      if (terminal) {
        if (terminalChecks.has(room.id)) return { error: 'Inspection verification is already in progress.', code: 'bot/refused' }
        terminalChecks.add(room.id)
        try { proof = await completedInspection(rt, room, attempt) } finally { terminalChecks.delete(room.id) }
        if (!proof?.isCurrent() || (!backgroundTerminal && !sameCoordinates(proof, body))) {
          return { error: 'No unique completed inspection was confirmed at these coordinates in the quiet original sessions.', code: 'bot/stale' }
        }
      }
      const agents = terminal ? [] : await Promise.all(ids.map(id => rt.resolveAgent(id)))
      const quietAgent = agent => quietInbox(agent)
        && rt.live.get(agent.session.id)?.turn === undefined && rt.hasSubagents?.(agent.session.id) !== true
        && rt.waitsForApproval?.(agent.session.id) !== true
      if (rt.roomOf(room.id) !== room || room.goal !== goal || goal.reviewAttempt !== attempt || !reviewEligible(goal)
        || stopsPending.has(room.id) || attempt.terminalFailure !== previousFailure || (provenFailure && attempt.terminalFailure !== provenFailure
          && (reviewInputs.get(attempt) !== provenFailure || provenFailure.proven !== true || provenFailure.ambiguous))
        || (terminal && (!proof.isCurrent() || !['uncertain','admitting'].includes(attempt.state) || attempt.saveOutcomeUnknown
          || reviewInputs.get(attempt)?.ambiguous || pendingReviewResolutions.has(resolutionKey)))
        || !sessionsMatch() || !agents.every((agent, i) => agent?.session?.id === ids[i] && quietAgent(agent)) || roomBusy()) return busy
      rt.requireHomeLock()
      const wasAutomatic = automaticIdle(goal)
      const now = Date.now()
      pendingReviewResolutions.add(resolutionKey)
      pendingReviewRooms.add(room.id)
      const by = provenFailure || backgroundTerminal ? 'host' : 'user'
      const resolution = { id:attempt.id, attempt:structuredClone(attempt), decision:terminal?'inspection-ended':provenFailure?'failed-before-tools':allowFuture?'allow-future':'verified', by, at:now,
        ...(terminal ? { root: proof.root, admin: proof.admin } : {}),
        ...(provenFailure ? { root: { ...provenFailure.root }, admin: { ...provenFailure.admin } } : {}) }
      goal.reviewResolutions = [...resolutions, resolution]
      delete goal.reviewAttempt
      goal.revision += 1
      goal.updatedAt = now
      if (wasAutomatic) { goal.idleRevision = goal.revision; goal.reviewAt = now + GOAL_REVIEW_INTERVAL_MS }
      if (provenFailure || terminal) goal.ownerReviewAt = now + GOAL_REVIEW_INTERVAL_MS
      goal.events = [...(goal.events ?? []), { at: now, kind: 'review-resolved', by, reviewId: attempt.id, text: evidence }].slice(-EVENTS_MAX)
      await rt.save({ required: true })
      await durableReviewResolutions(room,goal)
      pendingReviewResolutions.delete(resolutionKey)
      pendingReviewRooms.delete(room.id)
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
        if (goal.inspectionBackoff) {
          delete goal.inspectionBackoff
          goal.ownerReviewAt = Math.min(Number.isFinite(goal.ownerReviewAt) ? goal.ownerReviewAt : Infinity, Date.now() + GOAL_REVIEW_INTERVAL_MS)
        }
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
    && !room.goal.reviewAttempt?.terminalFailure && room.goal.reviewAttempt?.saveOutcomeUnknown !== true
    && room.goal.reviewAttempt?.id === id && ['admitting', 'uncertain'].includes(room.goal.reviewAttempt.state)
    && (!inspectionOnlyIdle(room.goal) || room.goal.reviewAttempt.inspectOnly === true)
    && room.goal.reviewAttempt.adminId === room.admin && room.members.includes(room.admin)
    && room.goal.reviewAttempt.rootSessionId === rt.sessionOfRoom(room)
    && room.goal.reviewAttempt.adminSessionId === room.sessions?.[room.admin] && !reviewDisposed

  // When same-room recovery notes have unknown provenance, let the admin
  // inspect and report, but do not permit tools with possible side effects.
  ctx.tools.guard(exec => {
    const info = rt.live.get(exec.agent?.id)?.info
    if (info?.reviewReceipt === true) {
      if (!info.reviewId || info.reviewInspect !== true) return 'This status question is not bound to a review.'
      return goalReviewGuard(rt.live, rt.roomOf, (name, agentId) => rt.pickRoom(name, rt.selfOf(agentId)))(exec)
    }
    if (info?.reviewId && !goalReviewAllowed(rt.roomOf(info.roomId), info.reviewId)) {
      if (exec.name === 'list_bots' || (exec.name === 'group_goal' && exec.arguments?.action === 'show')) return undefined
      return 'The goal review was stopped or its identity changed; no further action is allowed.'
    }
    return goalReviewGuard(rt.live, rt.roomOf, (name, agentId) => rt.pickRoom(name, rt.selfOf(agentId)), scopedReviewAction)(exec)
  })

  async function goalReviewBind(room, id, sessionId) {
    const attempt = room?.goal?.reviewAttempt
    if (!reviewEligible(room?.goal) || attempt?.id !== id || attempt.terminalFailure || !['admitting', 'uncertain'].includes(attempt.state)
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
    if (inspectOnly) {
      const attempt = goal.reviewAttempt
      const generated = Number.isFinite(attempt?.inspectionLedgerAt) && typeof attempt.inspectionLedgerFingerprint === 'string'
      const current = generated && attempt.inspectionLedgerFingerprint === inspectionFingerprint(goal)
      const status = current ? 'ledger-generated' : generated ? 'stale-ledger' : 'not-generated'
      goal.lastInspection = { reviewId: attempt.id, at: now, status, ...(current ? { ledgerAt: attempt.inspectionLedgerAt, fingerprint: attempt.inspectionLedgerFingerprint } : {}) }
      const fingerprint = inspectionFingerprint(goal, false)
      if (current) delete goal.inspectionBackoff
      else {
        const previous = goal.inspectionBackoff
        const count = previous?.fingerprint === fingerprint && Number.isSafeInteger(previous.count) && previous.count > 0 ? Math.min(previous.count + 1, Number.MAX_SAFE_INTEGER) : 1
        goal.inspectionBackoff = { fingerprint, count }
      }
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
      if (!remaining.length) {
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

  const skipReviewPeriod = (goal, now) => {
    rt.requireHomeLock()
    goal.ownerReviewAt = Math.max(now, Date.now()) + GOAL_REVIEW_INTERVAL_MS
    if (automaticIdle(goal)) goal.reviewAt = goal.ownerReviewAt
  }

  // Another opener or a busy administrator consumed this opportunity. Only
  // this unadmitted review is retired; the next scheduled cycle can try again.
  async function goalReviewNotOpened(room, id) {
    const goal = room?.goal
    const attempt = goal?.reviewAttempt
    if (attempt?.id !== id || attempt.terminalFailure) return
    const autoIdle = automaticIdle(goal)
    delete goal.reviewAttempt
    goal.revision += 1
    goal.updatedAt = Date.now()
    if (autoIdle) goal.idleRevision = goal.revision
    if (reviewEligible(goal)) skipReviewPeriod(goal, attempt.at ?? goal.updatedAt)
    await rt.save({ required: true })
  }

  async function reconcileOriginalReview(room, now) {
    if (reviewDisposed) return
    await rt.load()
    if (reviewDisposed || rt.readOnly() !== undefined) return
    if (pendingReviewRooms.has(room.id)) return
    const goal = room.goal
    if (goal?.reviewResolutions !== undefined || goal?.reviewAttempt?.terminalFailure) { try { await durableReviewResolutions(room,goal) } catch { return } }
    const attempt = goal?.reviewAttempt
    if (attempt && !attempt.terminalFailure && Number.isFinite(attempt.at) && now - attempt.at >= GOAL_REVIEW_INTERVAL_MS && !reviewNotified.has(attempt.id)) {
      reviewNotified.add(attempt.id)
      rt.noteFailure?.({ level: 'warn', source: 'goal', code: 'GOAL_REVIEW_UNCERTAIN', text: `Periodic goal review ${attempt.id} for ${room.name} is still unresolved; inspect its original work before recovery.` })
    }
    if (attempt?.inspectOnly === true && attempt.state === 'uncertain' && reviewEligible(goal)
      && !stopsPending.has(room.id) && Number.isFinite(attempt.at) && now - attempt.at >= GOAL_REVIEW_INTERVAL_MS) {
      const previous = blockedReviewReads.get(attempt)
      if (!previous || now - previous.at >= GOAL_REVIEW_INTERVAL_MS) {
        blockedReviewReads.set(attempt, { at: now, reviewId: attempt.id, revision: goal.revision,
          open: openReviewTasks(goal).length, missing: missingFor(room).map(task => task.id) })
      }
    }
    const recorded = attempt?.terminalFailure
    const inputs = recorded ?? reviewInputs.get(attempt)
    if (attempt?.state === 'uncertain' && attempt.inspectOnly === true && reviewEligible(goal) && !stopsPending.has(room.id)
      && inputs?.proven !== false && !(inputs?.retryAt > now) && inputs?.root?.end !== undefined && inputs.admin?.end !== undefined && !inputs.ambiguous && !reviewing.has(room.id)) {
      reviewing.add(room.id)
      await (async () => {
        try {
          const request = { goalId: goal.id, reviewId: attempt.id, confirmed: true }
          if (!recorded) {
            const result = await goalControl(room.id, { ...request, action: 'review-record-failure', root: inputs.root, admin: inputs.admin }, inputs)
            if (result.error) return
          }
          if (inputs.ambiguous || room.goal !== goal || goal.reviewAttempt !== attempt || !attempt.terminalFailure) return
          await goalControl(room.id, { ...request, action: 'review-resolve' }, attempt.terminalFailure)
        } catch (error) {
          if (!recorded) inputs.retryAt = now + GOAL_REVIEW_INTERVAL_MS
          rt.warn('ds-bot: original inspection evidence for %s could not be confirmed: %s', attempt.id, error)
        } finally { reviewing.delete(room.id) }
      })()
      return
    }
    if (attempt?.adminCompleted === true && goalReviewAllowed(room, attempt.id) && !reviewing.has(room.id)) {
      reviewing.add(room.id)
      await (async () => {
        try {
          const root = await rt.resolveAgent(attempt.rootSessionId)
          const adminAgent = await rt.resolveAgent(attempt.adminSessionId)
          const quiet = agent => quietInbox(agent)
            && rt.live.get(agent.session.id)?.turn === undefined && rt.hasSubagents?.(agent.session.id) !== true
            && rt.waitsForApproval?.(agent.session.id) !== true
          // Finalizing an inspection records what the admin checked. An old
          // batch still fences its original work but cannot keep that inspection open.
          const heldWork = hasUnreadRoomDeliveries(room) || rt.roomBatchPending?.(room.id) === true
          if (!goalReviewAllowed(room, attempt.id) || !quiet(root) || !quiet(adminAgent)
            || rt.roomBusyForPatrol(room) || (rt.workingInRoom?.(room) ?? []).length > 0
            || (!attempt.inspectOnly && heldWork)) return
          finishReview(room, 'admin-pass', now)
          await rt.save({ required: true })
        } catch (error) {
          rt.warn('ds-bot: completed goal review recovery in %s failed: %s', room.name, error)
        } finally { reviewing.delete(room.id) }
      })()
      return
    }
    // A restart can lose the in-memory end callback after both native turns
    // already finished. Check only this overdue inspection's bound parts.
    if (attempt?.inspectOnly && ['admitting','uncertain'].includes(attempt.state) && !attempt.terminalFailure
      && !attempt.saveOutcomeUnknown && reviewEligible(goal) && !stopsPending.has(room.id) && !reviewing.has(room.id)
      && Number.isFinite(attempt.at) && now - attempt.at >= GOAL_REVIEW_INTERVAL_MS
      && now >= (terminalCheckAt.get(attempt) ?? 0)) {
      terminalCheckAt.set(attempt, now + GOAL_REVIEW_INTERVAL_MS)
      reviewing.add(room.id)
      await (async () => {
        try {
          await goalControl(room.id, { action: 'review-confirm-terminal', confirmed: true, goalId: goal.id, reviewId: attempt.id }, undefined, true)
        } catch (error) {
          rt.warn('ds-bot: terminal inspection verification for %s failed: %s', attempt.id, error)
        } finally { reviewing.delete(room.id) }
      })()
      return
    }
  }
  // The native schedule is the sole producer of automatic checks. Consume
  // each occurrence once per room, including skips and uncertain admissions.
  // The watermark also survives part rotation, restarts and goal replacement.
  const receivingRooms = new Set()
  async function runScheduledRoomReview(room, occurrenceKey, agent, openingMessageId, verifiedPrompt, nativeOpening) {
    let identity
    try { identity = JSON.parse(occurrenceKey) } catch { return 'invalid' }
    if (!Array.isArray(identity) || identity.length !== 2 || typeof identity[0] !== 'string' || !identity[0]
      || identity[0].length > 256 || typeof identity[1] !== 'string' || identity[1].length > 64) return 'invalid'
    if (nativeOpening && (!openingMessageId || nativeOpening.id !== openingMessageId || nativeOpening.source?.kind !== 'schedule')) return 'invalid'
    const at = Date.parse(identity[1])
    if (!Number.isSafeInteger(at) || !room || !agent || agent.session?.id !== rt.sessionOfRoom(room)
      || rt.roomOf(room.id) !== room || reviewDisposed || rt.readOnly() !== undefined) return 'invalid'
    if (room.scheduledReviewOccurrence?.at >= at || receivingRooms.has(room.id)) return 'duplicate'
    receivingRooms.add(room.id)
    const now = Date.now()
    const goal = room.goal
    const activeRoom = () => !reviewDisposed && rt.readOnly() === undefined && rt.roomOf(room.id) === room
      && agent.session?.id === rt.sessionOfRoom(room) && room.goal === goal && !stopsPending.has(room.id)
    const quiet = () => quietInbox(agent, openingMessageId)
      && !rt.roomBusyForPatrol(room, openingMessageId, openingMessageId ? agent.session.id : undefined)
    // A durable claim precedes every possible send, including the no-goal
    // fallback handled by the caller. An uncertain save cannot authorize a retry.
    const occurrence = { key:occurrenceKey, at, outcome:'claimed' }
    const result = async outcome => {
      occurrence.outcome = outcome
      await rt.save({ required:true })
      return outcome
    }
    try {
      rt.requireHomeLock()
      room.scheduledReviewOccurrence = occurrence
      if (!activeRoom() || !room.admin || !room.members.includes(room.admin)) return await result('paused')
      if (!quiet()) return await result('busy')
      if (goal?.reviewAttempt) {
        const original = goal.reviewAttempt
        await result('pending')
        const reconcile = () => {
          if (activeRoom() && goal.reviewAttempt === original) return reconcileOriginalReview(room, Date.now())
        }
        // Native pre-step is itself a running root turn. The original proof
        // requires an idle root. Wait for this shell's completion separately
        // so the step never waits for itself. Reconciliation cannot dispatch.
        if (openingMessageId && typeof agent.whenIdle === 'function') {
          void agent.whenIdle().then(reconcile).catch(error => rt.warn('ds-bot: original room review in %s could not be checked: %s', room.id, error))
        } else await reconcile()
        return 'pending'
      }
      if (pendingReviewRooms.has(room.id) || reviewing.has(room.id)) return await result('pending')
      if (!goal) {
        await result('no-goal')
        return activeRoom() && quiet() ? 'no-goal' : await result('busy')
      }
      if (goal.status === 'complete') return await result('completed')
      if (!reviewEligible(goal)) return await result('paused')
      const admin = rt.botOf(room.admin)
      if (!admin) return await result('invalid')
      const id = randomUUID()
      const stageId = goal.stages[goal.current]?.id
      if (goal.ownerReview?.stageId !== stageId) goal.ownerReview = { stageId, checks:{} }
      const attempt = { id, at:now, state:'admitting', adminId:admin.id, rootSessionId:agent.session.id,
        adminSessionId:room.sessions?.[admin.id],
        ...(typeof verifiedPrompt === 'string' && verifiedPrompt.trim() ? { scheduledPrompt:verifiedPrompt } : {}),
        ...(inspectionRequired(room) ? { inspectOnly:true } : {}) }
      const options = { agent, reviewId:id, inspectOnly:attempt.inspectOnly === true }
      const message = nativeOpening && Object.freeze({ ...goalRelayMessage(room, 'nudge', '[Scheduled group board review]', 'DS Bot', options), id:openingMessageId })
      if (message && attempt.inspectOnly) attempt.nativeOpening = { id:openingMessageId,
        inputHash:inspectionMessageHash(nativeOpening), relayHash:inspectionMessageHash(message) }
      goal.reviewAttempt = attempt
      goal.revision += 1
      if (goal.idle) goal.idleRevision = goal.revision
      goal.updatedAt = now
      occurrence.reviewId = id
      await result(message ? 'admitted' : 'admitting')
      const valid = () => activeRoom() && room.scheduledReviewOccurrence === occurrence && goalReviewAllowed(room, id)
      if (!valid() || !quiet() || (inspectionRequired(room) && !attempt.inspectOnly)) {
        if (goal.reviewAttempt === attempt && room.goal === goal) {
          const automatic = automaticIdle(goal)
          delete goal.reviewAttempt
          goal.revision++
          if (automatic) goal.idleRevision = goal.revision
        }
        return await result('busy')
      }
      // The native schedule already owns the root's first pre-step. Returning its
      // relay in that step records one user/message. Enqueuing another next-turn
      // here would leave it asleep when DSH finishes the otherwise empty shell.
      if (message) return { outcome:'admitted', message }
      await queueGoalRelay(room, 'nudge', '[Scheduled group board review]', 'DS Bot', { ...options, valid })
      return await result('admitted')
    } catch (error) {
      if (goal?.reviewAttempt && goal.reviewAttempt.id === occurrence.reviewId) goal.reviewAttempt.state = 'uncertain'
      occurrence.outcome = 'uncertain'
      await rt.save({ required:true }).catch(() => {})
      rt.warn('ds-bot: scheduled group check in %s could not be confirmed: %s', room.id, error)
      return 'uncertain'
    } finally { receivingRooms.delete(room.id) }
  }
  ctx.effect(() => () => { reviewDisposed = true }, 'ds-bot: scheduled group checks')

  // Finalize a relay that was already admitted, including legacy progress.
  // A normal round or a worker finishing never starts a scheduled occurrence.
  async function goalDrive(room, round) {
    if (pendingReviewRooms.has(room.id)) return
    const goal = room.goal
    if (goal?.reviewResolutions !== undefined || goal?.reviewAttempt?.terminalFailure) { try { await durableReviewResolutions(room,goal) } catch { return } }
    const admin = room.admin === undefined || room.admin === null ? undefined : rt.botOf(room.admin)
    // A delayed callback from an already confirmed inspection cannot start a
    // normal goal drive or change task progress.
    if (round.goalReviewId && goal?.reviewResolutions?.some(record =>
      record.id === round.goalReviewId && record.decision === 'inspection-ended')) return
    if (round.goalReviewId && goalReviewAllowed(room, round.goalReviewId)) {
      const slot = round.slots.find(item => item.id === admin?.id)
      if ((slot !== undefined && ['passed', 'posted'].includes(slot.status)) || goal.reviewAttempt?.adminCompleted === true) {
        finishReview(room, slot?.status === 'passed' ? 'admin-pass' : 'nudge-limit')
        await rt.save({ required: true })
      }
      return
    }
    if (goal?.reviewAttempt || goal?.status !== 'active' || goal.idle || !admin) return
    // A legacy nudge can already have been admitted by an earlier release.
    if (round.goalNudge && round.slots.some(slot => slot.id === admin.id && slot.status === 'passed')) {
      parkAutomatically(goal, 'admin-pass')
      await rt.save()
    }
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
    if (goal === undefined) return
    // A new user message can contain a correction not yet reflected in the
    // structured goal. Reset backoff without resuming a stopped goal.
    if (goal.inspectionBackoff && reviewEligible(goal)) {
      delete goal.inspectionBackoff
      goal.ownerReviewAt = Math.min(Number.isFinite(goal.ownerReviewAt) ? goal.ownerReviewAt : Infinity, Date.now() + GOAL_REVIEW_INTERVAL_MS)
      if (automaticIdle(goal)) goal.reviewAt = Math.min(Number.isFinite(goal.reviewAt) ? goal.reviewAt : Infinity, goal.ownerReviewAt)
      void rt.save().catch(() => {})
    }
    if (goal.idle === undefined && goal.nudges === 0) return
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
    description: "Track independent goals separately. Show the target before changes. Copy room_id, goal_id and expected_revision. On conflict re-read and reconcile. Read authorized groups, write in the target group. Start only without an active/paused goal. Pass marks all current-stage tasks done. Verify each completion and its evidence or reconcile scope first. Pause/resume need explicit user direction. Stop requires a request to stop the whole goal and may halt members. Review-check cites sources and marks unknowns. Review-follow-up sends one read-only status question to the current task owner from a scheduled review.",
    parameters: {
      group: { type: 'string', description: 'Exact name from list_bots. Must match room_id if both supplied.' },
      room_id: { type: 'string', description: 'Exact target group ID. Defaults to this group.' },
      goal_id: { type: 'string', description: 'From show. Use none for an empty room.' },
      expected_revision: { type: 'integer', description: 'From the same goal ledger.' },
      action: { type: 'string', required: true, enum: ['show', 'draft', 'start', 'revise', 'task', 'pass', 'rework', 'complete', 'pause', 'resume', 'stop', 'review-check', 'review-follow-up'] },
      review_task: { type: 'string', description: 'Task ID from show.' },
      review_fingerprint: { type: 'string', description: 'Exact task fingerprint from show.' },
      review_assignment: { type: 'string', description: 'Received/queued/unknown and source.' },
      review_progress: { type: 'string', description: 'Arrangement and progress.' },
      review_dependencies: { type: 'string', description: 'Dependencies and blockers.' },
      review_next: { type: 'string', description: 'Next action and owner.' },
      review_deadline: { type: 'string', description: 'Response/check time.' },
      review_complete: { type: 'boolean', description: 'True only for a completed, verified owner check.' },
      title: { type: 'string', description: 'Up to 80 characters.' },
      brief: { type: 'string', description: 'Draft: user request.' },
      objective: { type: 'string', description: 'Start/revise: group outcome.' },
      acceptance: { type: 'string', description: 'Start/revise: checks and required evidence.' },
      constraints: { type: 'array', items: { type: 'string' }, description: 'Start/revise: full replacement, including user corrections.' },
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
        description: 'Start with ordered stages. Revise rebuilds current/future stages, losing IDs, notes and rework feedback. Show omits full future definitions. Preserve definitions and evidence first. One aggregated task per exact Bot name per stage. Track separate acceptance items on the board.',
      },
      bot: { type: 'string', description: 'Task member. Before rework, verify this member has a current task. It resets all their tasks and notes, or the entire stage if omitted. Preserve evidence first.' },
      stage: { type: 'integer', description: '1-based task stage, defaults to current.' },
      status: { type: 'string', enum: ['pending', 'working', 'reported', 'done'] },
      note: { type: 'string', description: 'Task: brief progress.' },
      evidence: { type: 'string', description: 'Pass/complete/review-check: verified results.' },
      reason: { type: 'string', description: 'Revise/rework/stop.' },
      summary: { type: 'string', description: 'Complete: delivery for the user.' },
    },
    output,
    async execute(args, exec) {
      await rt.load()
      const sessionId = exec.agent?.id
      const self = rt.selfOf(sessionId)
      const member = rt.botOf(self)
      if (member === undefined) return 'Only Bots on the team can use group_goal.'
      const action = String(args.action ?? '')
      const origin = rt.roomOf(rt.groupOwners.get(sessionId)?.roomId)
      if (rt.pastOwners.has(sessionId) || (origin && !origin.members.includes(self))) return 'This group session is no longer current. Open the target group again.'
      const group = args.group?.trim(), roomId = args.room_id?.trim()
      if ((args.group !== undefined && !group) || (args.room_id !== undefined && !roomId)) return 'The supplied group or room_id is empty. Use an exact group or omit it inside that group.'
      let room = origin
      if (roomId || group) {
        const selected = rt.pickRoom(roomId || group, self)
        if (selected.error !== undefined) return selected.error
        room = selected.room
        if (roomId && (room.id !== roomId || (group && rt.pickRoom(group, self).room?.id !== room.id))) return 'room_id and group select different groups. Check the target with list_bots.'
      }
      if (!room) return required('group', action)
      if (origin && origin !== room && !room.members.includes(self)) return 'Cross-group goal reads require membership in the target group.'
      const review = rt.live.get(sessionId)?.info
      if (review?.reviewId && review.roomId !== room.id) return 'This scheduled goal review can inspect only its assigned group.'
      const admin = room.members.map(rt.botOf).filter(Boolean).find(bot => rt.isAdminOf(room, bot.id))
      const change = action !== 'show'
      if (change && origin && origin !== room) return `Open "${room.name}" (room_id=${room.id}) and make this change from the target group. Neither goal was changed.`
      if (change && !rt.isMain(self) && !rt.isAdminOf(room, self)) {
        return admin !== undefined
          ? `Only ${admin.name}, the admin of "${room.name}", or a Main Bot changes its goal. Tell the admin in the group.`
          : `Only a Main Bot changes the goal of "${room.name}".`
      }
      if ((action === 'draft' || action === 'start') && admin === undefined) {
        return `"${room.name}" has no admin, and a goal needs one to run it. Set an admin with update_group first.`
      }
      const caller = origin ?? member
      const last = goalReads.get(caller)?.get(self)
      const hasVersion = args.goal_id !== undefined || args.expected_revision !== undefined
      const matches = hasVersion
        ? args.goal_id === (room.goal?.id ?? 'none') && args.expected_revision === (room.goal?.revision ?? 0)
        : last?.sessionId === sessionId && last.binding === goalBinding(room)
      if (change && (hasVersion || room.goal || room.pastGoals?.length || last) && !matches) {
        return `Goal binding is missing or stale for room_id=${room.id}. Show the target group again, reconcile its current instructions, and use its goal_id and expected_revision.`
      }
      const observedLedger = options => {
        const binding = goalBinding(room)
        let reads = goalReads.get(caller)
        if (!reads) {
          reads = new Map()
          goalReads.set(caller, reads)
        }
        reads.set(self, { sessionId, binding })
        return `${binding}\n${goalLedger(room, member, options)}`
      }
      const of = memberOf(room)
      const names = memberNames(room)
      let result
      let next = ''
      let post
      switch (action) {
        case 'show': {
          const fingerprint = inspectionFingerprint(room.goal)
          const ledger = observedLedger({ showBackup: true })
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
        case 'review-follow-up':
          return followUpOnReview(room, self, sessionId, args, review)
        case 'review-check': {
          const info = rt.live.get(exec.agent?.id)?.info
          const goal = room.goal
          const stage = goal?.stages?.[goal.current]
          const reviewId = info?.reviewId
          if (!reviewId || !rt.isAdminOf(room, self) || !goalReviewAllowed(room, reviewId)
            || (info.reviewInspect === true && !canRecordReviewCheck(room, args))) return 'Only an active review with an unrelated, unblocked task may record a completed check. For a reported task, record available evidence as unresolved.'
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
          const savedCheck = goal.ownerReview?.stageId === stage.id ? goal.ownerReview.checks?.[task.id] : undefined
          if (scopedQueueVersion !== undefined && (goal.ownerReview !== updated
            || reviewFingerprint(task) !== args.review_fingerprint
            || rt.reviewQueueVersion?.(room.id, task.botId) !== scopedQueueVersion
            || savedCheck !== updated.checks[task.id]
            || savedCheck?.scopedQueueVersion !== scopedQueueVersion)) {
            return 'The queue or task changed while saving; the recorded check is unresolved and must be inspected again.'
          }
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
      if (result.unchanged) return observedLedger()
      if (result.reply !== undefined) announce(room, result.reply)
      await rt.save()
      if (post !== undefined) await post()
      const ledger = observedLedger()
      return next === '' ? ledger : `${ledger}\n${next}`
    },
  }))

  Object.assign(rt, {
    goalBlock, goalLedger, goalDraft, goalControl, goalDrive, goalUserMessage, goalUserStopped, goalUndoEmptyMemberStop, goalStopBegin, goalStopEnd, goalDispatchBlocked, goalRecoveryBlocked, runScheduledRoomReview, goalReviewAllowed, goalReviewBind, goalReviewFinished, goalReviewFailed, goalReviewNotOpened,
    goalTaskWorking: (roomId, botId) => mark(roomId, botId, 'pending', 'working'),
    goalTaskReported: (roomId, botId) => mark(roomId, botId, 'working', 'reported'),
    goalTaskReset: (roomId, botId, note) => mark(roomId, botId, 'working', 'pending', note),
  })
}
