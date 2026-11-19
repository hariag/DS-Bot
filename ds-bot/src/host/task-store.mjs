import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { lstatSync, openSync, closeSync, readSync, fsyncSync, constants } from 'node:fs'
import { dirname, isAbsolute } from 'node:path'
import { isPrivateDirectory, isPrivateFile } from './private-storage.mjs'
import { syncDirectorySync } from './directory-sync.mjs'
import { canConfigureReleaseTeam, invalidReleaseTeam, lifecyclePlan, resolveReleaseTeam } from './release-team.mjs'
import { isFeatureCard, isManualBoardTask, isUnassignedItemDraft } from './board-intake.mjs'

// The caller must authenticate actors and authorize every command and query.
// This module is an isolated task journal: it does not send messages or prove
// that a DSH inbox or an external side effect has been durably committed.
const validId = x => typeof x === 'string' && x.length > 0 && x.length <= 256 && !/[\x00-\x1f]/.test(x)
const requireId = (x, field) => { if (!validId(x)) throw new Error(`invalid ${field}`); return x }
const string = (x, field) => { if (typeof x !== 'string' || !x.trim() || Buffer.byteLength(x) > 8192) throw new Error(`invalid ${field}`); return x }
const stable = value => {
  const seen = new Set(); let count = 0
  const visit = (x, depth) => {
    if (++count > 3000 || depth > 12) throw new Error('payload too complex')
    if (x === null || typeof x === 'boolean') return JSON.stringify(x)
    if (typeof x === 'string') { if (Buffer.byteLength(x) > 8192) throw new Error('payload string too long'); return JSON.stringify(x) }
    if (typeof x === 'number' && Number.isFinite(x)) return JSON.stringify(x)
    if (!x || typeof x !== 'object' || seen.has(x)) throw new Error('invalid JSON payload')
    const array = Array.isArray(x), proto = Object.getPrototypeOf(x)
    if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) throw new Error('invalid payload prototype')
    seen.add(x); const descriptors = Object.getOwnPropertyDescriptors(x), keys = Object.keys(descriptors)
    if (array && (keys.length !== x.length + 1 || keys.at(-1) !== 'length')) throw new Error('invalid array')
    const names = array ? Array.from({ length: x.length }, (_, i) => String(i)) : keys.sort()
    const parts = names.map(k => {
      const d = descriptors[k]
      if (!d || !d.enumerable || !Object.hasOwn(d, 'value') || ['__proto__', 'constructor', 'prototype'].includes(k)) throw new Error('invalid payload property')
      return array ? visit(d.value, depth + 1) : `${JSON.stringify(k)}:${visit(d.value, depth + 1)}`
    })
    seen.delete(x); return array ? `[${parts.join(',')}]` : `{${parts.join(',')}}`
  }
  const result = visit(value, 0)
  if (Buffer.byteLength(result) > 65536) throw new Error('payload too large')
  return result
}
const digest = x => createHash('sha256').update(stable(x)).digest('hex')
const read = row => row ? JSON.parse(row.body) : undefined
const actionId = (id, rev, kind) => digest([id, rev, kind])
export const boardRegistrationReference = task => `board:${task.id}:${task.revision}`
export const TASK_TYPES = ['requirement','design','feature','development','test','deployment','operations','bugfix','ui','ux','other']
const MAX_TASKS = 1000
const schema = [
  { type:'index', name:'actions_task', tbl_name:'actions', sql:'CREATE INDEX actions_task ON actions(task_id,state)' },
  { type:'index', name:'task_dependencies_reverse', tbl_name:'task_dependencies', sql:'CREATE INDEX task_dependencies_reverse ON task_dependencies(dependency_id,task_id)' },
  { type:'table', name:'actions', tbl_name:'actions', sql:'CREATE TABLE actions (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, revision INTEGER NOT NULL, kind TEXT NOT NULL, actor TEXT NOT NULL, state TEXT NOT NULL, receipt TEXT, FOREIGN KEY(task_id) REFERENCES tasks(id))' },
  { type:'table', name:'admission_decisions', tbl_name:'admission_decisions', sql:'CREATE TABLE admission_decisions (operation_id TEXT PRIMARY KEY, action_id TEXT NOT NULL, admission_id TEXT, actor TEXT NOT NULL, task_revision INTEGER NOT NULL, previous_state TEXT NOT NULL, outcome TEXT NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL, FOREIGN KEY(action_id) REFERENCES actions(id))' },
  { type:'table', name:'admission_intents', tbl_name:'admission_intents', sql:'CREATE TABLE admission_intents (action_id TEXT PRIMARY KEY, admission_id TEXT NOT NULL UNIQUE, message_id TEXT NOT NULL UNIQUE, target_bot_id TEXT NOT NULL, target_session_id TEXT NOT NULL, task_revision INTEGER NOT NULL, action_revision INTEGER NOT NULL, payload_hash TEXT NOT NULL, payload TEXT NOT NULL, FOREIGN KEY(action_id) REFERENCES actions(id))' },
  { type:'table', name:'board_requests', tbl_name:'board_requests', sql:'CREATE TABLE board_requests (operation_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, task_id TEXT NOT NULL, status TEXT NOT NULL, result TEXT, message TEXT)' },
  { type:'table', name:'events', tbl_name:'events', sql:'CREATE TABLE events (operation_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, task_id TEXT NOT NULL, result TEXT NOT NULL, FOREIGN KEY(task_id) REFERENCES tasks(id))' },
  { type:'table', name:'history', tbl_name:'history', sql:'CREATE TABLE history (sequence INTEGER PRIMARY KEY, operation_id TEXT NOT NULL, actor TEXT NOT NULL, task_id TEXT NOT NULL, before TEXT, after TEXT NOT NULL)' },
  { type:'table', name:'operations', tbl_name:'operations', sql:'CREATE TABLE operations (operation_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, subject_id TEXT NOT NULL, result TEXT NOT NULL)' },
  { type:'table', name:'proposals', tbl_name:'proposals', sql:'CREATE TABLE proposals (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, body TEXT NOT NULL)' },
  { type:'table', name:'releases', tbl_name:'releases', sql:'CREATE TABLE releases (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, body TEXT NOT NULL)' },
  { type:'table', name:'task_dependencies', tbl_name:'task_dependencies', sql:'CREATE TABLE task_dependencies (task_id TEXT NOT NULL, dependency_id TEXT NOT NULL, grant_id TEXT, PRIMARY KEY(task_id,dependency_id), FOREIGN KEY(task_id) REFERENCES tasks(id), FOREIGN KEY(dependency_id) REFERENCES tasks(id))' },
  { type:'table', name:'tasks', tbl_name:'tasks', sql:'CREATE TABLE tasks (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, body TEXT NOT NULL)' },
]
const keysOnly = (value, allowed) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !allowed.includes(k))) throw new Error('invalid fields')
}
const POSITION_DIGITS = '0123456789abcdefghijklmnopqrstuvwxyz'
const positionDigit = value => POSITION_DIGITS.indexOf(value)
const validPosition = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && value.at(-1) !== '0'
  && [...value].every(digit => positionDigit(digit) !== -1)
const positionMidpoint = (lower, upper) => {
  let prefix = ''
  for (let index = 0; ; index += 1) {
    if (prefix.length >= 256) throw new Error('invalid position')
    const left = index < lower.length ? positionDigit(lower[index]) : 0
    const right = upper !== null && index < upper.length ? positionDigit(upper[index]) : POSITION_DIGITS.length
    if (left === right) { prefix += POSITION_DIGITS[left]; continue }
    if (right - left > 1) return prefix + POSITION_DIGITS[Math.floor((left + right) / 2)]
    return prefix + POSITION_DIGITS[left] + positionMidpoint(lower.slice(index + 1), null)
  }
}
// Keys are base-36 fractions compared as strings: no trailing zero keeps
// lexicographic order equal to numeric order so a card can always be placed
// between two existing neighbours.
const positionBetween = (lower, upper) => {
  if (lower !== null && !validPosition(lower)) throw new Error('invalid position')
  if (upper !== null && !validPosition(upper)) throw new Error('invalid position')
  if (lower !== null && upper !== null && lower >= upper) throw new Error('invalid position order')
  return positionMidpoint(lower ?? '', upper)
}
const positionOf = task => task && typeof task.position === 'string' ? task.position : undefined
const compareCards = (left, right) => {
  const a = positionOf(left), b = positionOf(right)
  if (a === undefined && b !== undefined) return -1
  if (a !== undefined && b === undefined) return 1
  if (a !== undefined && a !== b) return a < b ? -1 : 1
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
}
const cardLane = task => task.personalProgress ?? task.status
const sameCardLane = (left, right) => left.scope === right.scope && cardLane(left) === cardLane(right)
const TASK_TYPE_SET = new Set(TASK_TYPES)
const validTaskType = value => typeof value === 'string' && TASK_TYPE_SET.has(value)
const dueDateIsValid = value => {
  if (typeof value !== 'string') return false
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/.exec(value)
  if (!match) return false
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3])
  if (month < 1 || month > 12 || day < 1) return false
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  if (day > days[month - 1]) return false
  return match[4] === undefined || (Number(match[4]) <= 23 && Number(match[5]) <= 59)
}
const applyCardDetails = (target, value) => {
  keysOnly(value, ['description', 'stage', 'dueDate', 'dueComplete', 'labels', 'checklist', 'coverImageId', 'type'])
  if (Object.hasOwn(value, 'type')) {
    if (!validTaskType(value.type)) throw new Error('invalid card details')
    target.type = value.type
  }
  if (Object.hasOwn(value, 'stage')) {
    if (typeof value.stage !== 'string' || /[\r\n]/.test(value.stage) || Buffer.byteLength(value.stage.trim()) > 120) throw new Error('invalid task stage')
    if (value.stage.trim()) target.stage = value.stage.trim()
    else delete target.stage
  }
  if (Object.hasOwn(value, 'description')) {
    if (typeof value.description !== 'string' || Buffer.byteLength(value.description) > 8192) throw new Error('invalid card details')
    target.description = value.description
  }
  if (Object.hasOwn(value, 'dueDate')) {
    if (value.dueDate !== null && !dueDateIsValid(value.dueDate)) throw new Error('invalid card details')
    target.dueDate = value.dueDate
  }
  if (Object.hasOwn(value, 'dueComplete')) {
    if (typeof value.dueComplete !== 'boolean') throw new Error('invalid card details')
    target.dueComplete = value.dueComplete
  }
  if (Object.hasOwn(value, 'labels')) {
    if (!Array.isArray(value.labels) || value.labels.length > 20 || value.labels.some(label => typeof label !== 'string' || !label.trim() || Buffer.byteLength(label) > 40)) throw new Error('invalid card details')
    const labels = value.labels.map(label => label.trim())
    if (new Set(labels).size !== labels.length) throw new Error('invalid card details')
    target.labels = labels
  }
  if (Object.hasOwn(value, 'checklist')) {
    if (!Array.isArray(value.checklist) || value.checklist.length > 100) throw new Error('invalid card details')
    const ids = new Set()
    target.checklist = value.checklist.map(item => {
      keysOnly(item, ['id', 'text', 'checked'])
      if (!validId(item.id) || ids.has(item.id) || typeof item.text !== 'string' || !item.text.trim() || Buffer.byteLength(item.text) > 512 || typeof item.checked !== 'boolean') throw new Error('invalid card details')
      ids.add(item.id)
      return { id: item.id, text: item.text.trim(), checked: item.checked }
    })
  }
  if (Object.hasOwn(value, 'coverImageId')) {
    // A cover names an image already on the card; a new card has no
    // attachments, so it can only be chosen after an upload.
    if (value.coverImageId !== null && (typeof value.coverImageId !== 'string' || !(target.attachments ?? []).some(item => item.id === value.coverImageId))) throw new Error('invalid card details')
    target.coverImageId = value.coverImageId
  }
}

/** Open a private task journal. The containing directory must be private. */
export function openTaskStore(path, { authorize = () => false, verifyRegistration = () => false, verifyEvidence = () => false, verifyGoalItems = () => false, verifyReceipt = () => false, verifyInvalidation = () => false, verifyAttachment = () => false, verifyShare = () => false, verifyDependency = () => false, verifyAdmission = () => false, assertWriteLock = () => { throw new Error('write lock required') } } = {}) {
  if (!isAbsolute(path)) throw new Error('database path must be absolute')
  const dir = lstatSync(dirname(path))
  if (!isPrivateDirectory(dirname(path), dir)) throw new Error('database directory must be private')
  let created = false
  try {
    if (!lstatSync(path)) throw new Error('unreachable')
  } catch (e) {
    if (e.code !== 'ENOENT') throw e
    assertWriteLock()
    const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600)
    fsyncSync(fd); closeSync(fd); created = true
  }
  const file = lstatSync(path)
  if (!isPrivateFile(path, file)) throw new Error('database must be a private file')
  if (!created) {
    // Refuse an unknown file before sqlite opens it: a failed constructor can
    // leave the handle to be reclaimed only by GC, which keeps the file locked.
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      const header = Buffer.alloc(16), bytes = readSync(fd, header, 0, header.length, 0)
      if (bytes !== header.length || header.toString('latin1') !== 'SQLite format 3\u0000') throw new Error('unknown or damaged task database')
    } finally { closeSync(fd) }
  }
  const db = new DatabaseSync(path)
  db.exec('PRAGMA busy_timeout=0; PRAGMA synchronous=EXTRA; PRAGMA foreign_keys=ON')
  if (created) db.exec('PRAGMA journal_mode=DELETE')
  if (db.prepare('PRAGMA journal_mode').get().journal_mode !== 'delete') { db.close(); throw new Error('invalid task journal mode') }
  const version = db.prepare('PRAGMA user_version').get().user_version
  if (!created && (db.prepare('PRAGMA application_id').get().application_id !== 0x44534254 || ![5, 6].includes(version) || db.prepare('PRAGMA quick_check').get().quick_check !== 'ok')) { db.close(); throw new Error('unknown or damaged task database') }
  if (created) {
    db.exec('BEGIN IMMEDIATE')
    for (const item of schema.filter(item => item.type === 'table')) db.exec(item.sql)
    for (const item of schema.filter(item => item.type === 'index')) db.exec(item.sql)
    db.exec('PRAGMA application_id=1146307156; PRAGMA user_version=6')
    try { assertWriteLock(); db.exec('COMMIT') } catch (e) { try { db.exec('ROLLBACK') } finally { db.close() }; throw e }
    syncDirectorySync(dirname(path))
  } else if (version === 5) {
    // Schema v5 lacks releases and proposals. Create only the missing objects
    // after proving every existing object still matches its declared SQL.
    const existing = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all()
    const expected = new Map(schema.map(item => [`${item.type}:${item.name}`, item]))
    if (existing.some(item => expected.get(`${item.type}:${item.name}`)?.sql !== item.sql)) { db.close(); throw new Error('unknown or damaged task database schema') }
    const missing = schema.filter(item => !existing.some(row => row.type === item.type && row.name === item.name))
    assertWriteLock()
    db.exec('BEGIN IMMEDIATE')
    try {
      for (const item of missing) db.exec(item.sql)
      db.exec('PRAGMA user_version=6')
      db.exec('COMMIT')
    } catch (error) { try { db.exec('ROLLBACK') } finally { db.close() }; throw error }
    syncDirectorySync(dirname(path))
  }
  const objects = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all().map(row => ({ ...row }))
  if (JSON.stringify(objects) !== JSON.stringify(schema) || db.prepare('PRAGMA foreign_key_check').all().length) { db.close(); throw new Error('unknown or damaged task database schema') }
  try {
    const rows = db.prepare('SELECT id,revision,body FROM tasks').all(), expected = new Map()
    if (rows.length > MAX_TASKS) throw new Error('task limit exceeded')
    for (const row of rows) {
      const task = JSON.parse(row.body), dependencies = task.dependencies, bindings = task.dependencyGrants ?? []
      if (task.id !== row.id || task.revision !== row.revision || !Array.isArray(dependencies) || dependencies.length > 100 || new Set(dependencies).size !== dependencies.length || !Array.isArray(bindings)) throw new Error('invalid task record')
      const grants = new Map()
      for (const binding of bindings) { if (!validId(binding?.taskId) || !validId(binding?.grantId) || grants.has(binding.taskId) || !dependencies.includes(binding.taskId)) throw new Error('invalid dependency binding'); grants.set(binding.taskId, binding.grantId) }
      for (const id of dependencies) { if (!validId(id)) throw new Error('invalid dependency'); expected.set(JSON.stringify([row.id,id]), grants.get(id) ?? null) }
    }
    const edges = db.prepare('SELECT task_id,dependency_id,grant_id FROM task_dependencies').all()
    if (edges.length !== expected.size || edges.some(edge => !expected.has(JSON.stringify([edge.task_id,edge.dependency_id])) || expected.get(JSON.stringify([edge.task_id,edge.dependency_id])) !== edge.grant_id)) throw new Error('dependency index mismatch')
  } catch { db.close(); throw new Error('unknown or damaged task dependency index') }
  const getRow = db.prepare('SELECT * FROM tasks WHERE id=?')
  const getTask = id => read(getRow.get(id))
  const getAll = () => db.prepare('SELECT body FROM tasks ORDER BY id').all().map(read)
  const getReleaseRow = db.prepare('SELECT * FROM releases WHERE id=?')
  const getRelease = id => read(getReleaseRow.get(id))
  const getAllReleases = () => db.prepare('SELECT body FROM releases ORDER BY id').all().map(read)
  const saveRelease = (before, after) => {
    if (before) {
      if (db.prepare('UPDATE releases SET revision=?,body=? WHERE id=? AND revision=?').run(after.revision, JSON.stringify(after), before.id, before.revision).changes !== 1) throw new Error('release revision conflict')
    } else db.prepare('INSERT INTO releases(id,revision,body) VALUES(?,?,?)').run(after.id, after.revision, JSON.stringify(after))
  }
  const releaseItems = id => getAll().filter(task => task.releaseId === id).sort((left, right) => {
    const a = typeof left.releasePosition === 'string' ? left.releasePosition : undefined
    const b = typeof right.releasePosition === 'string' ? right.releasePosition : undefined
    if (a === undefined && b !== undefined) return -1
    if (a !== undefined && b === undefined) return 1
    if (a !== undefined && a !== b) return a < b ? -1 : 1
    return compareCards(left, right)
  })
  const releaseMembershipEditable = task => !task?.releaseId || ['draft','queued'].includes(getRelease(task.releaseId)?.status)
  const releaseOrder = scope => getAllReleases().filter(release => release.scope === scope).sort((left, right) => left.position < right.position ? -1 : left.position > right.position ? 1 : 0)
  const releasePositionAfter = (releaseId, afterId, exceptId) => {
    const items = releaseItems(releaseId).filter(task => task.id !== exceptId)
    let index = -1
    if (afterId === null) {
      // Release assignment appends by default; item reordering passes an explicit afterId.
      const last = items.at(-1)
      return positionBetween(typeof last?.releasePosition === 'string' ? last.releasePosition : null, null)
    }
    if (afterId !== null) {
      index = items.findIndex(task => task.id === afterId)
      if (index === -1) throw new Error('release item target unavailable')
    }
    const previous = index >= 0 ? items[index] : undefined
    const next = items[index + 1]
    const before = typeof previous?.releasePosition === 'string' ? previous.releasePosition : undefined
    const after = typeof next?.releasePosition === 'string' ? next.releasePosition : undefined
    if (before !== undefined && after !== undefined) return positionBetween(before, after)
    if (after !== undefined) return positionBetween(null, after)
    if (before !== undefined) return positionBetween(before, null)
    return positionBetween(null, null)
  }
  const RELEASE_GATES = ['docs', 'artifacts', 'environment', 'summary']
const RELEASE_GATE_STATUSES = new Set(['pending', 'passed', 'failed'])
const defaultReleaseGates = () => Object.fromEntries(RELEASE_GATES.map(gate => [gate, { status:'pending' }]))
const gatesPassed = release => {
  const gates = release?.gates
  return !!gates && RELEASE_GATES.every(gate => gates[gate]?.status === 'passed')
}
const releaseIsDone = release => {
    if (!release || release.status !== 'running' || !gatesPassed(release)) return false
    const items = releaseItems(release.id)
    return items.length > 0 && items.every(task => task.status === 'done' && task.stale !== true && !unfinishedItems.get(task.id) && (!task.goalItemIds?.length || verifyGoalItems(task) === true))
  }
  const startReleaseTx = release => {
    if (!release || !['draft','queued'].includes(release.status)) throw new Error('release is not startable')
    if (getAllReleases().some(item => item.scope === release.scope && item.status === 'running' && item.id !== release.id)) throw new Error('another release is running in this scope')
    const items = releaseItems(release.id)
    if (!items.length) throw new Error('release has no items')
    const nextRelease = { ...release, revision: release.revision + 1, status:'running', startedAt: Date.now(), updatedAt: Date.now() }
    saveRelease(release, nextRelease)
    const parents = new Set(items.map(task => task.id))
    // Human-planned items enter the normal receipt-based workflow when this release
    // is explicitly started. Chat-tracked items continue in their existing sessions.
    const executableItems = getAll().filter(task => parents.has(task.parentTaskId) && !isManualBoardTask(task))
    for (const task of [...items, ...executableItems]) {
      if (isUnassignedItemDraft(task) || !['draft','proposed','waiting','ready'].includes(task.status) || task.blocked || task.stale) continue
      let next = { ...task, revision: task.revision + 1, authority: { kind:'personal', reference:boardRegistrationReference({ id:task.id, revision:task.revision + 1 }) } }
      if (next.status === 'draft' || next.status === 'proposed') next.status = 'waiting'
      save(task, next)
      if (dependenciesDone(next)) ready(next)
    }
    return nextRelease
  }
  const reconcileRelease = releaseId => {
    const release = getRelease(releaseId)
    if (!releaseIsDone(release)) return release
    const published = { ...release, revision: release.revision + 1, status:'published', publishedAt: Date.now(), updatedAt: Date.now() }
    saveRelease(release, published)
    const next = releaseOrder(release.scope).find(item => item.status === 'queued')
    if (next) {
      db.exec('SAVEPOINT next_release')
      try { startReleaseTx(next); db.exec('RELEASE next_release') }
      catch { db.exec('ROLLBACK TO next_release'); db.exec('RELEASE next_release') }
    }
    return published
  }
  const getProposalRow = db.prepare('SELECT * FROM proposals WHERE id=?')
  const getProposal = id => read(getProposalRow.get(id))
  const getAllProposals = () => db.prepare('SELECT body FROM proposals ORDER BY id').all().map(read)
  const saveProposal = (before, after) => {
    if (before) {
      if (db.prepare('UPDATE proposals SET revision=?,body=? WHERE id=? AND revision=?').run(after.revision, JSON.stringify(after), before.id, before.revision).changes !== 1) throw new Error('proposal revision conflict')
    } else db.prepare('INSERT INTO proposals(id,revision,body) VALUES(?,?,?)').run(after.id, after.revision, JSON.stringify(after))
  }
  const appendPosition = scope => {
    let last
    for (const task of getAll()) {
      if (task.scope !== scope) continue
      const value = positionOf(task)
      if (value !== undefined && (last === undefined || value > last)) last = value
    }
    return positionBetween(last ?? null, null)
  }
  const laneOrder = (scope, lane, exceptId) => getAll()
    .filter(task => task.scope === scope && cardLane(task) === lane && task.id !== exceptId)
    .sort(compareCards)
  const positionAfter = (scope, lane, afterId, exceptId) => {
    const list = laneOrder(scope, lane, exceptId)
    let index = -1
    if (afterId !== null) {
      if (afterId === exceptId) throw new Error('invalid reorder')
      index = list.findIndex(task => task.id === afterId)
      if (index === -1) throw new Error('reorder target unavailable')
    }
    const previous = index >= 0 ? list[index] : undefined
    const next = list[index + 1]
    const before = positionOf(previous), after = positionOf(next)
    if (before !== undefined && after !== undefined) return positionBetween(before, after)
    if (after !== undefined) return positionBetween(null, after)
    if (before !== undefined) return positionBetween(before, null)
    return positionBetween(null, null)
  }
  const getOp = db.prepare('SELECT * FROM events WHERE operation_id=?')
  const addOp = db.prepare('INSERT INTO events(operation_id,fingerprint,task_id,result) VALUES(?,?,?,?)')
  const update = db.prepare('UPDATE tasks SET revision=?,body=? WHERE id=? AND revision=?')
  const insertEdge = db.prepare('INSERT INTO task_dependencies(task_id,dependency_id,grant_id) VALUES(?,?,?)')
  const insertEdges = task => { const grants = new Map((task.dependencyGrants ?? []).map(entry => [entry.taskId, entry.grantId])); for (const id of task.dependencies) insertEdge.run(task.id, id, grants.get(id) ?? null) }
  const reverseEdges = db.prepare('SELECT task_id FROM task_dependencies WHERE dependency_id=? ORDER BY task_id')
  const dependents = id => reverseEdges.all(id).map(row => row.task_id)
  let audit
  const addHistory = db.prepare('INSERT INTO history(operation_id,actor,task_id,before,after) VALUES(?,?,?,?,?)')
  const save = (before, after) => {
    if (update.run(after.revision, JSON.stringify(after), before.id, before.revision).changes !== 1) throw new Error('revision conflict')
    if (stable(before.dependencies) !== stable(after.dependencies) || stable(before.dependencyGrants ?? []) !== stable(after.dependencyGrants ?? [])) {
      db.prepare('DELETE FROM task_dependencies WHERE task_id=?').run(after.id); insertEdges(after)
    }
    if (!audit) throw new Error('missing audit context')
    addHistory.run(audit.operationId, audit.actor, before.id, JSON.stringify(before), JSON.stringify(after))
    if (after.parentTaskId && before.status === 'done' && !before.stale && !before.blocked
      && (after.status !== 'done' || after.stale || after.blocked)) {
      const parent = getTask(after.parentTaskId)
      if (parent && !parent.stale && ['reported','done'].includes(parent.status)) {
        db.prepare("UPDATE actions SET state='cancelled' WHERE task_id=? AND state='pending'").run(parent.id)
        db.prepare("UPDATE actions SET state='uncertain',receipt=COALESCE(receipt,'item acceptance changed') WHERE task_id=? AND state IN ('claimed','accepted')").run(parent.id)
        save(parent, { ...parent, revision:parent.revision + 1, stale:true,
          blocked:{ reason:'item acceptance changed', condition:'revalidate items and card', owner:parent.reviewer } })
      }
    }
  }
  const addAction = db.prepare("INSERT OR IGNORE INTO actions(id,task_id,revision,kind,actor,state) VALUES(?,?,?,?,?,'pending')")
  const action = (task, kind, actor) => {
    if (!isManualBoardTask(task)) addAction.run(actionId(task.id, task.actionRevision, kind), task.id, task.actionRevision, kind, actor)
  }
  let poisoned = false, inTransaction = false
  const tx = fn => {
    if (poisoned) throw new Error('task store requires reconciliation')
    if (inTransaction) return fn()
    assertWriteLock()
    const dirNow = lstatSync(dirname(path)), fileNow = lstatSync(path)
    if (dirNow.dev !== dir.dev || dirNow.ino !== dir.ino || fileNow.dev !== file.dev || fileNow.ino !== file.ino) throw new Error('task database identity changed')
    db.exec('BEGIN IMMEDIATE'); let committing = false; inTransaction = true
    try { const value = fn(); assertWriteLock(); committing = true; db.exec('COMMIT'); return value } catch (e) { try { db.exec('ROLLBACK') } catch { poisoned = true }; if (committing) poisoned = true; throw e } finally { inTransaction = false }
  }
  const transact = (op, actor, payload, permission, work) => tx(() => {
    if (authorize(permission()) !== true) throw new Error('not authorized')
    requireId(op, 'operation id'); const fingerprint = digest(payload); const existing = getOp.get(op)
    if (existing) { if (existing.fingerprint !== fingerprint) throw new Error('operation id conflict'); return JSON.parse(existing.result) }
    audit = { operationId: op, actor }; try { const result = work(); addOp.run(op, fingerprint, result.id, JSON.stringify(result)); return result } finally { audit = undefined }
  })
  const getSubjectOp = db.prepare('SELECT * FROM operations WHERE operation_id=?')
  const addSubjectOp = db.prepare('INSERT INTO operations(operation_id,fingerprint,subject_id,result) VALUES(?,?,?,?)')
  // Releases and proposals are not task rows, so their durable operation
  // receipt uses the FK-free operations table instead of events.
  const transactSubject = (op, actor, payload, permission, work) => tx(() => {
    if (authorize(permission()) !== true) throw new Error('not authorized')
    requireId(op, 'operation id'); const fingerprint = digest(payload); const existing = getSubjectOp.get(op)
    if (existing) { if (existing.fingerprint !== fingerprint) throw new Error('operation id conflict'); return JSON.parse(existing.result) }
    audit = { operationId: op, actor }
    try { const result = work(); addSubjectOp.run(op, fingerprint, result.id, JSON.stringify(result)); return result } finally { audit = undefined }
  })
  const checkGraph = (id, depends) => {
    if (!Array.isArray(depends) || depends.length > 100 || new Set(depends).size !== depends.length) throw new Error('invalid dependencies')
    for (const dep of depends) requireId(dep, 'dependency')
    const seen = new Set()
    const pending = [...depends]
    while (pending.length) { const taskId = pending.pop(); if (taskId === id) throw new Error('dependency cycle'); if (seen.has(taskId)) continue; seen.add(taskId); if (seen.size > 10000) throw new Error('dependency graph too large'); const t = getTask(taskId); if (!t) throw new Error('unknown dependency'); pending.push(...t.dependencies) }
  }
  const validDependency = (task, dep) => {
    if (!dep) return false
    if (dep.scope === task.scope) return true
    const binding = (task.dependencyGrants ?? []).find(entry => entry.taskId === dep.id)
    const grant = dep.shares?.find(entry => entry.id === binding?.grantId && !entry.revoked && entry.taskId === dep.id && entry.targetRoomId === task.scope.slice(5))
    return !!grant && task.scope.startsWith('room:') && verifyDependency(task, dep, grant) === true
  }
  const checkBindings = (task, dependencies, bindings) => {
    if (!Array.isArray(bindings) || bindings.length > 100) throw new Error('invalid dependency grants')
    const ids = new Set()
    for (const binding of bindings) { keysOnly(binding, ['taskId','grantId']); requireId(binding.taskId, 'dependency'); requireId(binding.grantId, 'grant id'); if (ids.has(binding.taskId) || !dependencies.includes(binding.taskId)) throw new Error('invalid dependency grants'); ids.add(binding.taskId) }
    const candidate = { ...task, dependencies, dependencyGrants:bindings }
    for (const id of dependencies) {
      const dep = getTask(id)
      if (!dep || !validDependency(candidate, dep) || (dep.scope === task.scope && ids.has(id))) throw new Error('dependency grant unavailable')
    }
  }
  const dependenciesDone = task => task.dependencies.every(id => { const dep = getTask(id); return dep?.status === 'done' && dep.stale !== true && validDependency(task, dep) })
  const unfinishedItems = db.prepare("SELECT 1 FROM tasks WHERE json_extract(body,'$.parentTaskId')=? AND (json_extract(body,'$.status')!='done' OR json_extract(body,'$.stale')=1 OR json_type(body,'$.blocked')='object') LIMIT 1")
  const hasItems = db.prepare("SELECT 1 FROM tasks WHERE json_extract(body,'$.parentTaskId')=? LIMIT 1")
  const parentOpen = parent => !!parent && !parent.archivedAt && !parent.blocked && !parent.stale && !['reported','done','cancelled'].includes(parent.status)
  const itemContextOpen = task => {
    if (!task.parentTaskId) return true
    const parent = getTask(task.parentTaskId)
    return parentOpen(parent) && (!parent.releaseId || getRelease(parent.releaseId)?.status === 'running')
  }
  const ready = task => {
    if (isManualBoardTask(task) || task.archivedAt || task.status !== 'waiting' || task.blocked || task.stale || !dependenciesDone(task)) return task
    const next = { ...task, revision: task.revision + 1, actionRevision: task.revision + 1, status: 'ready' }; save(task, next); action(next, 'execute', next.owner); return next
  }
  const unresolved = id => db.prepare("SELECT 1 FROM actions WHERE task_id=? AND state IN ('claimed','accepted','uncertain') LIMIT 1").get(id)
  const finishAction = (id, kind) => {
    const changes = db.prepare("UPDATE actions SET state='done' WHERE task_id=? AND kind=? AND state='accepted'").run(id, kind).changes
    if (changes !== 1) throw new Error('verified action receipt required')
  }
  // A committed owner start acknowledges this execution even if DSH has since rotated
  // the Session. Preserve the current card and its workflow gates; never re-admit input.
  const ownerStart = db.prepare(`SELECT operation_id, after FROM history
    WHERE task_id=? AND actor=? AND json_extract(before,'$.status')='ready'
      AND json_extract(after,'$.status')='working' AND json_extract(after,'$.actionRevision')=?
    ORDER BY sequence DESC LIMIT 1`)
  const acknowledgedStart = (row, intent, task) => {
    if (row.kind !== 'execute' || task?.status !== 'working' || task.owner !== row.actor || task.actionRevision !== row.revision
      || !intent || intent.target_bot_id !== row.actor || intent.action_revision !== row.revision) return undefined
    const start = ownerStart.get(row.task_id, row.actor, row.revision)
    if (!start) return undefined
    const original = JSON.parse(start.after)
    if (original.id !== task.id || original.owner !== task.owner || original.reviewer !== task.reviewer || original.scope !== task.scope
      || original.releaseId !== task.releaseId || original.parentTaskId !== task.parentTaskId) return undefined
    return start.operation_id
  }
  return {
    close() { db.close() },
    holdInterruptedAdmissions() {
      return tx(() => {
        const reason = 'process restarted; delivery outcome unknown'
        const rows = db.prepare("SELECT * FROM actions WHERE state IN ('claimed','accepted') OR (state='uncertain' AND receipt=?) ORDER BY rowid").all(reason)
        let held = 0
        for (const row of rows) {
          const intent = db.prepare('SELECT admission_id,target_bot_id,action_revision FROM admission_intents WHERE action_id=?').get(row.id)
          const task = getTask(row.task_id)
          const start = row.state !== 'claimed' && acknowledgedStart(row, intent, task)
          if (row.state === 'accepted' && start) continue
          let operationId, outcome, receipt, decision
          if (row.state === 'uncertain') {
            if (!start || task.blocked || task.stale || task.archivedAt) continue
            // Only the old startup handler discarded a receipt under this exact decision.
            // User cancellations, invalidations and failed admissions keep their holds.
            const previous = db.prepare(`SELECT h.before FROM admission_decisions d JOIN history h
              ON h.operation_id=d.operation_id AND h.task_id=? AND h.actor=d.actor
              JOIN history received ON received.task_id=h.task_id AND received.operation_id='action:'||d.action_id||':accepted'
                AND received.sequence<h.sequence AND json_extract(received.after,'$.receipt')=json_extract(h.before,'$.receipt')
              WHERE d.operation_id=? AND d.action_id=? AND d.admission_id=? AND d.task_revision=? AND d.actor='scheduler'
                AND d.previous_state='accepted' AND d.outcome='uncertain' AND d.reason=?
                AND NOT EXISTS (SELECT 1 FROM admission_decisions newer WHERE newer.action_id=d.action_id AND newer.rowid>d.rowid)
                AND json_extract(h.before,'$.id')=d.action_id AND json_extract(h.before,'$.state')='accepted'`)
              .get(row.task_id, `recovery:${row.id}`, row.id, intent.admission_id, row.revision, reason)
            if (!previous) continue
            receipt = JSON.parse(previous.before).receipt
            if (typeof receipt !== 'string' || !receipt) continue
            operationId = `owner-start-confirmed:${row.id}`
            outcome = 'accepted'
            decision = `Delivery confirmed by owner start ${start}`
          } else {
            operationId = `recovery-hold:${row.id}:${task.revision}`
            outcome = 'uncertain'
            receipt = decision = reason
            held++
          }
          const changed = db.prepare('UPDATE actions SET state=?,receipt=? WHERE id=? AND state=?').run(outcome, receipt, row.id, row.state).changes
          if (changed !== 1) throw new Error('action recovery conflict')
          db.prepare('INSERT INTO admission_decisions(operation_id,action_id,admission_id,actor,task_revision,previous_state,outcome,reason,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
            .run(operationId, row.id, intent?.admission_id ?? null, 'scheduler', task.revision, row.state, outcome, decision, new Date().toISOString())
          addHistory.run(operationId, 'scheduler', row.task_id, JSON.stringify(row), JSON.stringify({ ...row, state:outcome, receipt }))
        }
        return held
      })
    },
    limits() { return { tasks:MAX_TASKS, dependencies:100 } },
    // Internal refresh cursor only; callers must not expose global changes to
    // actors who cannot view every task in this database.
    version() {
      const dirNow = lstatSync(dirname(path)), fileNow = lstatSync(path)
      if (dirNow.dev !== dir.dev || dirNow.ino !== dir.ino || fileNow.dev !== file.dev || fileNow.ino !== file.ino) throw new Error('task database identity changed')
      const version = db.prepare('SELECT COALESCE(MAX(sequence),0) AS version FROM history').get().version
      if (!Number.isSafeInteger(version) || version < 0) throw new Error('invalid task version')
      return version
    },
    get(id) { return getTask(requireId(id, 'task id')) },
    list() { return getAll() },
    listSchedule() {
      const releases = new Map(getAllReleases().map(release => [release.id, release]))
      return getAll().filter(task => !task.archivedAt && itemContextOpen(task) && (!task.releaseId || releases.get(task.releaseId)?.status === 'running')).sort((left, right) => {
        const a = left.releaseId ? releases.get(left.releaseId) : undefined
        const b = right.releaseId ? releases.get(right.releaseId) : undefined
        const priority = item => item?.status === 'running' ? 0 : 1
        if (priority(a) !== priority(b)) return priority(a) - priority(b)
        if (priority(a) === 0) {
          const ap = typeof left.releasePosition === 'string' ? left.releasePosition : undefined
          const bp = typeof right.releasePosition === 'string' ? right.releasePosition : undefined
          if (ap !== undefined && bp !== undefined && ap !== bp) return ap < bp ? -1 : 1
          if (ap !== undefined && bp === undefined) return -1
          if (ap === undefined && bp !== undefined) return 1
        }
        return compareCards(left, right)
      })
    },
    listReleases(scope, {summary = false} = {}) {
      if (typeof scope !== 'string' || !scope) throw new Error('invalid release scope')
      const releases = releaseOrder(scope)
      if (summary) return releases.map(({id, name, version, status}) => ({id, name, version, status}))
      return releases.map(release => ({ ...release, items: releaseItems(release.id).map(task => ({ id:task.id, title:task.title, status:task.status, owner:task.owner, revision:task.revision })) }))
    },
    getRelease(id) { return getRelease(requireId(id, 'release id')) },
    createRelease({ operationId, actor, release }) {
      requireId(actor, 'actor')
      if (!release || typeof release !== 'object' || Array.isArray(release)) throw new Error('invalid release')
      keysOnly(release, ['id','scope','name','version','position','note','groupId','projectManagerId','roles','gates'])
      const id = requireId(release.id, 'release id'), scope = requireId(release.scope, 'scope')
      string(release.name, 'release name'); string(release.version, 'release version')
      if (release.groupId !== undefined) requireId(release.groupId, 'release group id')
      if (release.projectManagerId !== undefined) requireId(release.projectManagerId, 'project manager id')
      if (release.roles !== undefined) {
        if (!release.roles || typeof release.roles !== 'object' || Array.isArray(release.roles) || Object.values(release.roles).some(value => !validId(value))) throw new Error('invalid release roles')
      }
      if (release.gates !== undefined) {
        if (!release.gates || typeof release.gates !== 'object' || Array.isArray(release.gates) || Object.keys(release.gates).some(key => !RELEASE_GATES.includes(key))
          || Object.values(release.gates).some(gate => !gate || typeof gate !== 'object' || Array.isArray(gate) || !RELEASE_GATE_STATUSES.has(gate.status))) throw new Error('invalid release gates')
      }
      if (release.note !== undefined && (typeof release.note !== 'string' || Buffer.byteLength(release.note) > 4096)) throw new Error('invalid release note')
      const payload = { type:'release-create', actor, release }
      return transactSubject(operationId, actor, payload, () => ({ type:'release', actor }), () => {
        if (actor !== 'user') throw new Error('release creation is not authorized')
        if (getRelease(id)) throw new Error('release id exists')
        let position = release.position
        if (position !== undefined && !validPosition(position)) throw new Error('invalid release position')
        if (position === undefined) {
          const last = releaseOrder(scope).at(-1)
          position = positionBetween(typeof last?.position === 'string' ? last.position : null, null)
        }
        const now = Date.now()
        const record = { id, scope, revision:1, name:release.name.trim(), version:release.version.trim(), position, status:'draft', createdAt:now, updatedAt:now, createdBy:actor,
          gates: release.gates ?? defaultReleaseGates(), ...(release.groupId ? { groupId:release.groupId } : {}),
          ...(release.projectManagerId ? { projectManagerId:release.projectManagerId } : {}),
          ...(release.roles ? { roles:release.roles } : {}), ...(release.note ? { note:release.note } : {}) }
        saveRelease(null, record)
        return record
      })
    },
    configureReleaseTeam({ operationId, actor, roomId, releaseId, expectedRevision, team, bots }) {
      requireId(roomId, 'room id'); requireId(releaseId, 'release id')
      if (actor !== 'user') throw new Error('release team configuration is not authorized')
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1 || !team || typeof team !== 'object' || Array.isArray(team)) throw invalidReleaseTeam('Invalid release team request')
      keysOnly(team, ['projectManagerId','roles'])
      const payload = { type:'release-configure-team', actor, roomId, releaseId, expectedRevision, team }
      return transactSubject(operationId, actor, payload, () => ({ type:'release', actor }), () => {
        const release = getRelease(releaseId)
        if (!canConfigureReleaseTeam(release, roomId)) throw invalidReleaseTeam('Only an unconfigured draft release in this group can receive a team')
        if (release.revision !== expectedRevision) throw new Error('release revision conflict')
        const { projectManagerId, roles } = resolveReleaseTeam({ bots, projectManagerId:team.projectManagerId, roles:team.roles, explicitOnly:true })
        // Configuration is one-time. Check every planned owner/reviewer pair before saving it.
        lifecyclePlan({ release, requirement:release.name, roles })
        const next = { ...release, projectManagerId, roles, revision:release.revision + 1, updatedAt:Date.now() }
        saveRelease(release, next)
        return next
      })
    },
    updateRelease({ operationId, actor, releaseId, expectedRevision, value }) {
      requireId(actor, 'actor'); requireId(releaseId, 'release id')
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1 || !value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid release update')
      keysOnly(value, ['name','version','position','note'])
      if (!Object.keys(value).length) throw new Error('empty release update')
      const payload = { type:'release-update', actor, releaseId, expectedRevision, value }
      return transactSubject(operationId, actor, payload, () => ({ type:'release', actor }), () => {
        if (actor !== 'user') throw new Error('release update is not authorized')
        const old = getRelease(releaseId)
        if (!old || old.revision !== expectedRevision) throw new Error('release revision conflict')
        if (!['draft','queued'].includes(old.status)) throw new Error('release is not editable')
        const next = { ...old, revision: old.revision + 1, updatedAt: Date.now() }
        if (Object.hasOwn(value, 'name')) next.name = string(value.name, 'release name').trim()
        if (Object.hasOwn(value, 'version')) next.version = string(value.version, 'release version').trim()
        if (Object.hasOwn(value, 'position')) { if (!validPosition(value.position)) throw new Error('invalid release position'); next.position = value.position }
        if (Object.hasOwn(value, 'note')) { if (typeof value.note !== 'string' || Buffer.byteLength(value.note) > 4096) throw new Error('invalid release note'); next.note = value.note }
        saveRelease(old, next); return next
      })
    },
    assignRelease({ operationId, actor, releaseId, expectedReleaseRevision, taskId, expectedTaskRevision, afterId = null }) {
      requireId(actor, 'actor'); requireId(releaseId, 'release id'); requireId(taskId, 'task id')
      if (!Number.isSafeInteger(expectedReleaseRevision) || expectedReleaseRevision < 1 || !Number.isSafeInteger(expectedTaskRevision) || expectedTaskRevision < 1) throw new Error('invalid release assignment')
      if (afterId !== null && !validId(afterId)) throw new Error('invalid release position')
      const payload = { type:'release-assign', actor, releaseId, expectedReleaseRevision, taskId, expectedTaskRevision, afterId }
      return transactSubject(operationId, actor, payload, () => ({ type:'release', actor }), () => {
        if (actor !== 'user') throw new Error('release assignment is not authorized')
        const release = getRelease(releaseId)
        if (!release) throw new Error('release unavailable')
        if (release.revision !== expectedReleaseRevision) throw new Error('release revision conflict')
        if (!['draft','queued'].includes(release.status)) throw new Error('release is not editable')
        const task = getTask(taskId)
        if (!task || task.revision !== expectedTaskRevision) throw new Error('task revision conflict')
        if (task.parentTaskId || task.scope !== release.scope || ['done','cancelled'].includes(task.status)) throw new Error('release task unavailable')
        if (!releaseMembershipEditable(task)) throw new Error('release is not editable')
        const next = { ...task, revision: task.revision + 1, releaseId, releasePosition: releasePositionAfter(releaseId, afterId, taskId) }
        save(task, next); return next
      })
    },
    removeFromRelease({ operationId, actor, releaseId, expectedReleaseRevision, taskId, expectedTaskRevision }) {
      requireId(actor, 'actor'); requireId(releaseId, 'release id'); requireId(taskId, 'task id')
      if (!Number.isSafeInteger(expectedReleaseRevision) || expectedReleaseRevision < 1 || !Number.isSafeInteger(expectedTaskRevision) || expectedTaskRevision < 1) throw new Error('invalid release removal')
      const payload = { type:'release-remove', actor, releaseId, expectedReleaseRevision, taskId, expectedTaskRevision }
      return transactSubject(operationId, actor, payload, () => ({ type:'release', actor }), () => {
        if (actor !== 'user') throw new Error('release removal is not authorized')
        const release = getRelease(releaseId)
        if (!release || release.revision !== expectedReleaseRevision) throw new Error('release revision conflict')
        if (!['draft','queued'].includes(release.status)) throw new Error('release is not editable')
        const task = getTask(taskId)
        if (!task || task.revision !== expectedTaskRevision || task.releaseId !== releaseId) throw new Error('release task unavailable')
        const next = { ...task, revision: task.revision + 1, releaseId: null, releasePosition: null }
        save(task, next); return next
      })
    },
    startRelease({ operationId, actor, releaseId, expectedRevision }) {
      requireId(actor, 'actor'); requireId(releaseId, 'release id')
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new Error('invalid release start')
      const payload = { type:'release-start', actor, releaseId, expectedRevision }
      return transactSubject(operationId, actor, payload, () => ({ type:'release', actor }), () => {
        if (actor !== 'user') throw new Error('release start is not authorized')
        const release = getRelease(releaseId)
        if (!release || release.revision !== expectedRevision) throw new Error('release revision conflict')
        return startReleaseTx(release)
      })
    },
    queueRelease({ operationId, actor, releaseId, expectedRevision }) {
      requireId(actor, 'actor'); requireId(releaseId, 'release id')
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new Error('invalid release queue')
      const payload = { type:'release-queue', actor, releaseId, expectedRevision }
      return transactSubject(operationId, actor, payload, () => ({ type:'release', actor }), () => {
        if (actor !== 'user') throw new Error('release queue is not authorized')
        const release = getRelease(releaseId)
        if (!release || release.revision !== expectedRevision) throw new Error('release revision conflict')
        if (release.status !== 'draft') throw new Error('release is not queueable')
        const next = { ...release, revision: release.revision + 1, status:'queued', updatedAt: Date.now() }
        saveRelease(release, next); return next
      })
    },
    cancelRelease({ operationId, actor, releaseId, expectedRevision }) {
      requireId(actor, 'actor'); requireId(releaseId, 'release id')
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new Error('invalid release cancellation')
      const payload = { type:'release-cancel', actor, releaseId, expectedRevision }
      return transactSubject(operationId, actor, payload, () => ({ type:'release', actor }), () => {
        if (actor !== 'user') throw new Error('release cancellation is not authorized')
        const release = getRelease(releaseId)
        if (!release || release.revision !== expectedRevision) throw new Error('release revision conflict')
        if (!['draft','queued','running'].includes(release.status)) throw new Error('release is not cancellable')
        const items = releaseItems(release.id)
        const itemIds = new Set(items.map(task => task.id))
        const childItems = getAll().filter(task => itemIds.has(task.parentTaskId))
        const affected = [...new Map([...items, ...childItems].map(task => [task.id, task])).values()]
        if (release.status === 'running' && affected.some(task => ['working','reported'].includes(task.status) || unresolved(task.id))) throw new Error('release has active work')
        const next = { ...release, revision: release.revision + 1, status:'cancelled', updatedAt: Date.now() }
        saveRelease(release, next)
        for (const task of affected) {
          if (['done','cancelled'].includes(task.status)) continue
          db.prepare("UPDATE actions SET state='cancelled' WHERE task_id=? AND state='pending'").run(task.id)
          save(task, { ...task, revision: task.revision + 1, status:'proposed', actionRevision:null, authority:null, blocked:null, stale:false, evidence:null,
            ...(task.releaseId === release.id ? { releaseId:null, releasePosition:null } : {}) })
        }
        return next
      })
    },
    setReleaseGate({ operationId, actor, releaseId, expectedRevision, gate, status, evidence }) {
      requireId(actor, 'actor'); requireId(releaseId, 'release id')
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1 || !RELEASE_GATES.includes(gate)
        || !RELEASE_GATE_STATUSES.has(status) || (evidence !== undefined && (typeof evidence !== 'string' || Buffer.byteLength(evidence) > 16384))) throw new Error('invalid release gate')
      const payload = { type:'release-gate', actor, releaseId, expectedRevision, gate, status, evidence }
      return transactSubject(operationId, actor, payload, () => ({ type:'release', actor }), () => {
        if (actor !== 'user') throw new Error('release gate is not authorized')
        const old = getRelease(releaseId)
        if (!old || old.revision !== expectedRevision) throw new Error('release revision conflict')
        if (!['draft','queued','running'].includes(old.status)) throw new Error('release is not editable')
        const gates = { ...(old.gates ?? defaultReleaseGates()), [gate]: { status, updatedAt: Date.now(), ...(evidence ? { evidence } : {}) } }
        const next = { ...old, revision: old.revision + 1, updatedAt: Date.now(), gates }
        saveRelease(old, next); return next
      })
    },
    checkRelease({ operationId, actor, releaseId, expectedRevision }) {
      requireId(actor, 'actor'); requireId(releaseId, 'release id')
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new Error('invalid release check')
      const payload = { type:'release-check', actor, releaseId, expectedRevision }
      return transactSubject(operationId, actor, payload, () => ({ type:'release', actor }), () => {
        if (actor !== 'user') throw new Error('release check is not authorized')
        const old = getRelease(releaseId)
        if (!old || old.revision !== expectedRevision) throw new Error('release revision conflict')
        if (old.status !== 'running') throw new Error('release is not running')
        const items = releaseItems(old.id)
        const failedGate = RELEASE_GATES.find(gate => old.gates?.[gate]?.status === 'failed')
        if (!items.length || items.some(task => task.status === 'cancelled') || failedGate) {
          const reason = failedGate ? `Release gate ${failedGate} failed` : !items.length ? 'Release has no items' : 'A release item was cancelled'
          const next = { ...old, revision: old.revision + 1, status:'failed', failure:reason, updatedAt: Date.now() }
          saveRelease(old, next); return next
        }
        if (!releaseIsDone(old)) return old
        const published = { ...old, revision: old.revision + 1, status:'published', publishedAt: Date.now(), updatedAt: Date.now() }
        saveRelease(old, published)
        const nextQueued = releaseOrder(old.scope).find(item => item.status === 'queued')
        if (nextQueued) {
          db.exec('SAVEPOINT next_release')
          try { startReleaseTx(nextQueued); db.exec('RELEASE next_release') }
          catch { db.exec('ROLLBACK TO next_release'); db.exec('RELEASE next_release') }
        }
        return published
      })
    },
    listRunningReleases() {
      return getAllReleases().filter(release => release.status === 'running')
    },
    // Publishing can happen inside a task transaction (the last review), outside the
    // release monitor; the service sweeps these to write the report and notify the group.
    listPublishedWithoutReport() {
      return getAllReleases().filter(release => release.status === 'published' && !release.report)
    },
    setReleaseReport({ releaseId, report }) {
      requireId(releaseId, 'release id')
      if (!report || typeof report !== 'object' || Array.isArray(report) || typeof report.markdownPath !== 'string' || typeof report.htmlPath !== 'string' || !Number.isSafeInteger(report.generatedAt)) throw new Error('invalid release report')
      return tx(() => {
        const old = getRelease(releaseId)
        if (!old) throw new Error('release unavailable')
        const next = { ...old, revision: old.revision + 1, updatedAt: Date.now(), report }
        saveRelease(old, next); return next
      })
    },
    listProposals(scope) {
      if (typeof scope !== 'string' || !scope) throw new Error('invalid proposal scope')
      return getAllProposals().filter(proposal => proposal.scope === scope).sort((left, right) => {
        if (left.status === 'pending' && right.status !== 'pending') return -1
        if (left.status !== 'pending' && right.status === 'pending') return 1
        return (right.createdAt ?? 0) - (left.createdAt ?? 0)
      })
    },
    createProposal({ operationId, actor, proposal }) {
      requireId(actor, 'actor')
      if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal)) throw new Error('invalid proposal')
      const id = requireId(proposal.id, 'proposal id'), scope = requireId(proposal.scope, 'scope')
      if (!['create','update','status','release'].includes(proposal.kind)) throw new Error('invalid proposal kind')
      if (!['pending','confirmed','rejected'].includes(proposal.status ?? 'pending')) throw new Error('invalid proposal status')
      const payload = { type:'proposal-create', actor, proposal }
      const target = getTask(proposal.taskId) ?? (proposal.kind === 'create' ? {
        id: proposal.taskId, scope: proposal.scope, owner: proposal.command?.value?.owner, reviewer: proposal.command?.value?.reviewer,
      } : undefined)
      return transactSubject(operationId, actor, payload, () => ({ type:'proposal', actor, task:target }), () => {
        if (getProposal(id)) throw new Error('proposal id exists')
        if (getAllProposals().filter(item => item.status === 'pending').length >= 200) throw new Error('proposal limit reached')
        const now = Date.now()
        const record = { ...proposal, id, scope, revision:1, status:'pending', proposer:actor, createdAt:now }
        saveProposal(null, record); return record
      })
    },
    decideProposal({ operationId, actor, proposalId, expectedRevision, decision, note, apply }) {
      requireId(actor, 'actor'); requireId(proposalId, 'proposal id')
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1 || !['confirm','reject'].includes(decision) || typeof apply !== 'function') throw new Error('invalid proposal decision')
      if (note !== undefined && (typeof note !== 'string' || Buffer.byteLength(note) > 2000)) throw new Error('invalid proposal note')
      return tx(() => {
        if (actor !== 'user') throw new Error('proposal decision is not authorized')
        const old = getProposal(proposalId)
        if (!old || old.revision !== expectedRevision || old.status !== 'pending') throw new Error('proposal revision conflict')
        const applied = decision === 'confirm' ? apply(old) : undefined
        const next = { ...old, revision: old.revision + 1, status: decision === 'confirm' ? 'confirmed' : 'rejected', decidedAt: Date.now(), decidedBy: actor, decisionOperationId: operationId, ...(note ? { decisionNote: note } : {}) }
        saveProposal(old, next)
        return { proposal: next, ...(applied === undefined ? {} : { applied }) }
      })
    },
    admission(id) {
      requireId(id, 'action id')
      const row = db.prepare('SELECT i.*,a.state FROM admission_intents i JOIN actions a ON a.id=i.action_id WHERE i.action_id=?').get(id)
      return row ? { actionId:row.action_id, admissionId:row.admission_id, messageId:row.message_id, targetBotId:row.target_bot_id, targetSessionId:row.target_session_id, taskRevision:row.task_revision, actionRevision:row.action_revision, payloadHash:row.payload_hash, payload:JSON.parse(row.payload), state:row.state } : undefined
    },
    inspectAdmission({ admissionId, messageId, targetSessionId, payloadHash } = {}) {
      if (![admissionId, messageId, targetSessionId].every(validId) || typeof payloadHash !== 'string' || !/^[0-9a-f]{64}$/.test(payloadHash)) return { decision:'unknown' }
      try {
        const row = db.prepare('SELECT i.*,a.state,a.task_id FROM admission_intents i JOIN actions a ON a.id=i.action_id WHERE i.admission_id=?').get(admissionId)
        if (!row || row.message_id !== messageId || row.target_session_id !== targetSessionId || row.payload_hash !== payloadHash) return { decision:'unknown' }
        // A matching record is only an identity clue, not permission to resume.
        return { decision:'unknown', actionId:row.action_id, actionRevision:row.action_revision, state:row.state }
      } catch { return { decision:'unknown' } }
    },
    cancelAction({ operationId, actor, actionId:id, expectedTaskRevision, expectedActionState, expectedAdmissionId, reason }) {
      requireId(actor, 'actor'); requireId(id, 'action id'); string(reason, 'reason')
      if (!Number.isSafeInteger(expectedTaskRevision) || expectedTaskRevision < 1 || !['pending','claimed','accepted'].includes(expectedActionState) || (expectedAdmissionId !== null && !validId(expectedAdmissionId))) throw new Error('invalid cancellation')
      const payload = { type:'cancel-action', actor, actionId:id, expectedTaskRevision, expectedActionState, expectedAdmissionId, reason }
      return transact(operationId, actor, payload, () => ({ type:'cancel-action', actor, action:db.prepare('SELECT * FROM actions WHERE id=?').get(id) }), () => {
        const action = db.prepare('SELECT * FROM actions WHERE id=?').get(id)
        if (!action) throw new Error('action unavailable')
        const task = getTask(action.task_id), intent = db.prepare('SELECT * FROM admission_intents WHERE action_id=?').get(id)
        if (!task || task.revision !== expectedTaskRevision || action.state !== expectedActionState || (intent?.admission_id ?? null) !== expectedAdmissionId) throw new Error('cancellation conflict')
        const state = action.state === 'pending' ? 'cancelled' : 'uncertain'
        const changed = db.prepare('UPDATE actions SET state=? WHERE id=? AND state=?').run(state, id, expectedActionState).changes
        if (changed !== 1) throw new Error('cancellation conflict')
        db.prepare('INSERT INTO admission_decisions(operation_id,action_id,admission_id,actor,task_revision,previous_state,outcome,reason,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
          .run(operationId, id, intent?.admission_id ?? null, actor, task.revision, action.state, state, reason, new Date().toISOString())
        const next = { ...task, revision:task.revision + 1, blocked:{ reason, condition:state === 'cancelled' ? 'user resumes or revises this task' : 'reconcile the prior action outcome', owner:actor } }
        save(task, next)
        addHistory.run(operationId, actor, task.id, JSON.stringify(action), JSON.stringify({ ...action, state }))
        return next
      })
    },
    operation(id) {
      requireId(id, 'operation id')
      const request = db.prepare('SELECT * FROM board_requests WHERE operation_id=?').get(id)
      if (request) return { taskId: request.task_id, fingerprint: request.fingerprint, status: request.status, ...(request.status === 'committed' ? { result: JSON.parse(request.result) } : { message: request.message }) }
      const subject = getSubjectOp.get(id)
      if (subject) return { taskId: subject.subject_id, fingerprint: subject.fingerprint, status: 'committed', result: JSON.parse(subject.result) }
      const row = getOp.get(id); return row ? { taskId: row.task_id, fingerprint: row.fingerprint, status: 'committed', result: JSON.parse(row.result) } : undefined
    },
    request({ operationId, actor, taskId, payload, isRejection }, execute) {
      requireId(operationId, 'operation id'); requireId(actor, 'actor'); requireId(taskId, 'task id')
      if (typeof execute !== 'function' || typeof isRejection !== 'function') throw new Error('invalid request handler')
      const fingerprint = digest(payload)
      return tx(() => {
        const found = db.prepare('SELECT * FROM board_requests WHERE operation_id=?').get(operationId)
        if (found) {
          if (found.fingerprint === '!cancelled') return { state: 'rejected', message: found.message }
          if (found.fingerprint !== fingerprint || found.task_id !== taskId) throw new Error('operation id conflict')
          return found.status === 'committed' ? { state: 'committed', value: JSON.parse(found.result) } : { state: 'rejected', message: found.message }
        }
        db.exec('SAVEPOINT board_request')
        let outcome
        try {
          const value = execute()
          if (value && typeof value.then === 'function') throw new Error('async request handler unsupported')
          db.exec('RELEASE board_request'); outcome = { state: 'committed', value }
        } catch (error) {
          db.exec('ROLLBACK TO board_request'); db.exec('RELEASE board_request')
          if (isRejection(error) !== true) throw error
          outcome = { state: 'rejected', message: String(error.message).slice(0, 500) }
        }
        db.prepare('INSERT INTO board_requests(operation_id,fingerprint,task_id,status,result,message) VALUES(?,?,?,?,?,?)').run(operationId, fingerprint, taskId, outcome.state, outcome.state === 'committed' ? JSON.stringify(outcome.value) : null, outcome.message ?? null)
        return outcome
      })
    },
    cancelRequest({ operationId, actor }) {
      requireId(operationId, 'operation id'); requireId(actor, 'actor')
      return tx(() => {
        if (authorize({ type: 'cancel', actor }) !== true) throw new Error('not authorized')
        const found = db.prepare('SELECT * FROM board_requests WHERE operation_id=?').get(operationId)
        if (found) return found.status === 'committed' ? { state:'committed', result:JSON.parse(found.result) } : { state:'rejected', message:found.message }
        const existing = getOp.get(operationId)
        if (existing) return { state:'committed', result:JSON.parse(existing.result) }
        const message = 'Request cancelled before commit'
        db.prepare('INSERT INTO board_requests(operation_id,fingerprint,task_id,status,result,message) VALUES(?,?,?,\'rejected\',NULL,?)').run(operationId, '!cancelled', '', message)
        return { state:'rejected', message }
      })
    },
    listActions(id) { return db.prepare('SELECT id,task_id AS taskId,revision,kind,actor,state,receipt FROM actions WHERE task_id=? ORDER BY rowid').all(requireId(id, 'task id')) },
    history(id) {
      const rows = db.prepare(`SELECT h.before,h.after,d.created_at AS confirmed_at FROM history h LEFT JOIN admission_decisions d
        ON d.operation_id=h.operation_id AND d.actor=h.actor AND d.operation_id='owner-start-confirmed:'||d.action_id
          AND d.previous_state='uncertain' AND d.outcome='accepted' AND d.actor='scheduler'
        WHERE h.task_id=? ORDER BY h.sequence DESC LIMIT 51`).all(requireId(id, 'task id'))
      const fields = ['title', 'owner', 'reviewer', 'acceptance', 'dependencies', 'description', 'stage', 'dueDate', 'dueComplete', 'labels', 'checklist', 'coverImageId', 'progress']
      const project = value => {
        if (!value) return null
        const record = JSON.parse(value), result = { revision:record.revision }
        for (const field of fields) if (Object.hasOwn(record, field)) result[field] = record[field]
        return result
      }
      return { truncated:rows.length > 50, entries:rows.slice(0, 50).map(row => ({ before:project(row.before), after:project(row.after),
        ...(row.confirmed_at ? { deliveryConfirmedAt:Date.parse(row.confirmed_at) } : {}) })) }
    },
    create({ operationId, actor, task, intake }) {
      if (!task || typeof task !== 'object') throw new Error('invalid task')
      requireId(actor, 'actor'); stable(task); keysOnly(task, ['id','title','owner','reviewer','scope','acceptance','dependencies','dependencyGrants','personalProgress','description','stage','dueDate','dueComplete','labels','checklist','coverImageId','type','draft','parentTaskId'])
      const payload = { type: 'create', actor, task }
      if (intake !== undefined) {
        stable(intake); keysOnly(intake, ['parentTaskId','releaseId'])
        if (actor === 'user' || actor === 'scheduler' || !task.scope?.startsWith('room:') || task.scope.length <= 5) throw new Error('invalid task intake')
        keysOnly(task, ['id','title','owner','reviewer','scope','acceptance','description','type'])
        if (Object.hasOwn(intake, 'parentTaskId')) requireId(intake.parentTaskId, 'parent task id')
        else if (!isFeatureCard(task)) throw new Error('top-level card must be a feature or bugfix')
        payload.type = 'intake-create'
        payload.intake = intake
      }
      if (task.parentTaskId !== undefined && actor !== 'user') throw new Error('invalid parent task')
      const parentTaskId = intake?.parentTaskId ?? task.parentTaskId
      const releaseId = intake?.releaseId
      if (parentTaskId !== undefined) requireId(parentTaskId, 'parent task id')
      if (releaseId !== undefined) requireId(releaseId, 'release id')
      return transact(operationId, actor, payload, () => ({ type:payload.type, actor, task, ...(parentTaskId ? { parentTaskId } : {}), ...(releaseId ? { releaseId } : {}) }), () => {
        const id = requireId(task.id, 'task id'), {owner,reviewer} = task
        if (!(actor === 'user' && isUnassignedItemDraft(task))) {
          requireId(owner, 'owner'); requireId(reviewer, 'reviewer')
          if (owner === reviewer) throw new Error('reviewer must be independent')
        }
        if (task.personalProgress !== undefined && (actor !== 'user' || task.scope !== 'personal:user' || owner !== 'user' || !['todo','doing','finished'].includes(task.personalProgress))) throw new Error('invalid personal progress')
        string(task.title, 'title'); string(task.acceptance, 'acceptance'); requireId(task.scope, 'scope')
        if (getTask(id)) throw new Error('task id exists')
        if (parentTaskId) {
          const parent = getTask(parentTaskId)
          if (!task.scope.startsWith('room:') || !isFeatureCard(parent) || parent.scope !== task.scope || !parentOpen(parent)) throw new Error('parent card unavailable')
          if (releaseId && parent.releaseId !== releaseId) throw new Error('item inherits its parent release')
          if (parent.releaseId && !['draft','queued','running'].includes(getRelease(parent.releaseId)?.status)) throw new Error('release unavailable')
        } else if (releaseId) {
          const release = getRelease(releaseId)
          if (release?.scope !== task.scope || !['draft','queued'].includes(release.status)) throw new Error('release unavailable')
        }
        if (db.prepare('SELECT count(*) AS n FROM tasks').get().n >= MAX_TASKS) throw new Error('task limit reached')
        const dependencies = task.dependencies ?? [], dependencyGrants = task.dependencyGrants ?? []; checkGraph(id, dependencies)
        checkBindings({ scope:task.scope, owner, reviewer }, dependencies, dependencyGrants)
        const card = {}
        applyCardDetails(card, Object.fromEntries(['description','stage','dueDate','dueComplete','labels','checklist','coverImageId','type']
          .filter(key => Object.hasOwn(task, key)).map(key => [key, task[key]])))
        if (task.draft !== undefined && typeof task.draft !== 'boolean') throw new Error('invalid draft state')
        const record = { id, title: task.title, owner, reviewer, scope: task.scope, acceptance: task.acceptance, dependencies, dependencyGrants, attachments: [], shares: [], revision: 1, actionRevision: null, status: task.draft === true ? 'draft' : 'proposed', type: 'other', authority: null, evidence: null, blocked: null, stale: false, position: appendPosition(task.scope),
          ...card, ...(task.personalProgress !== undefined ? {personalProgress:task.personalProgress} : {}),
          ...(intake !== undefined ? { intake:{ kind:'chat', actor, at:Date.now() } } : {}), ...(parentTaskId ? { parentTaskId } : {}),
          ...(releaseId && !parentTaskId ? { releaseId, releasePosition:releasePositionAfter(releaseId, null, id) } : {}) }
        db.prepare('INSERT INTO tasks(id,revision,body) VALUES(?,?,?)').run(id, 1, JSON.stringify(record)); insertEdges(record)
        addHistory.run(operationId, actor, id, null, JSON.stringify(record)); return record
      })
    },
    proposeChange({ operationId, actor, taskId, expectedRevision, value }) {
      requireId(actor, 'actor'); requireId(taskId, 'task id')
      if (actor !== 'user' || !Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new Error('invalid revision')
      keysOnly(value, ['title','owner','reviewer','acceptance','dependencies','dependencyGrants','description','type'])
      const payload = { type:'propose-change', actor, taskId, expectedRevision, value }; stable(payload)
      return transact(operationId, actor, payload, () => ({type:'edit', actor, task:getTask(taskId)}), () => {
        const old = getTask(taskId)
        if (!old) throw new Error('unknown task')
        if (old.revision !== expectedRevision) throw new Error('revision conflict')
        if (!['working','reported','done'].includes(old.status)) throw new Error('change proposal unavailable')
        if (db.prepare('SELECT count(*) AS n FROM tasks').get().n >= MAX_TASKS) throw new Error('task limit reached')
        const fields = ['title','owner','reviewer','acceptance','dependencies','description','type']
        const before = Object.fromEntries(fields.map(field => [field, old[field]]))
        const after = Object.fromEntries(fields.map(field => [field, value[field]]))
        before.description ??= ''
        before.type ??= 'other'
        after.type ??= before.type
        string(after.title, 'title'); string(after.acceptance, 'acceptance')
        if (after.type !== undefined && !validTaskType(after.type)) throw new Error('invalid card details')
        if (typeof after.description !== 'string' || Buffer.byteLength(after.description) > 8192) throw new Error('invalid card details')
        requireId(after.owner, 'owner'); requireId(after.reviewer, 'reviewer')
        if (after.owner === after.reviewer) throw new Error('reviewer must be independent')
        if (!Array.isArray(after.dependencies)) throw new Error('invalid dependencies')
        if (stable(before) === stable(after)) throw new Error('empty edit')
        const dependencies = [...new Set([taskId, ...after.dependencies])], grants = value.dependencyGrants ?? []
        const id = `change-${digest([operationId, taskId])}`
        checkGraph(id, dependencies); checkBindings({scope:old.scope, owner:after.owner, reviewer:after.reviewer}, dependencies, grants)
        const change = { sourceTaskId:taskId, sourceRevision:old.revision, before, after }
        const duplicate = getAll().some(item => item.change?.sourceTaskId === taskId && item.change?.sourceRevision === old.revision && stable(item.change.after) === stable(after))
        if (duplicate) throw new Error('change proposal already exists')
        // Keep an active feature's change request with its source item. For a
        // closed feature, follow-up work gets its own card and retains the source link.
        const parent = old.parentTaskId && getTask(old.parentTaskId)
        const attachToParent = parent && parentOpen(parent)
        const record = { id, ...(attachToParent ? {parentTaskId:parent.id} : {}), title:after.title, owner:after.owner, reviewer:after.reviewer, scope:old.scope,
          acceptance:after.acceptance, description:after.description, dependencies, dependencyGrants:grants, attachments:[], shares:[], revision:1,
          actionRevision:null, status:'waiting', type:parent && !attachToParent ? parent.type : after.type ?? old.type ?? 'other', authority:{kind:'personal',reference:boardRegistrationReference({id,revision:1})}, evidence:null, blocked:null, stale:false,
          position:appendPosition(old.scope), change }
        db.prepare('INSERT INTO tasks(id,revision,body) VALUES(?,?,?)').run(id, 1, JSON.stringify(record)); insertEdges(record)
        addHistory.run(operationId, actor, id, null, JSON.stringify(record)); return ready(record)
      })
    },
    command({ operationId, taskId, expectedRevision, actor, type, value, sessionId }) {
      requireId(taskId, 'task id'); requireId(actor, 'actor')
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new Error('invalid revision')
      const payload = { type, taskId, expectedRevision, actor, ...(value !== undefined ? { value } : {}) }; stable(payload)
      return transact(operationId, actor, payload, () => ({ type, actor, task: getTask(taskId) }), () => {
        const old = getTask(taskId); if (!old) throw new Error('unknown task')
        if (old.revision !== expectedRevision) throw new Error('revision conflict')
        if (old.change && ['edit','card-details'].includes(type)) throw new Error('change proposal is immutable')
        const manual = isManualBoardTask(old)
        if (['start','progress','report','review'].includes(type)) {
          if (old.archivedAt) throw new Error('card is archived')
          if (!itemContextOpen(old)) throw new Error('parent card or release unavailable')
          if (manual && old.releaseId && getRelease(old.releaseId)?.status !== 'running') throw new Error('release is not running')
          if ((type === 'report' || type === 'review' && value?.result === 'pass') && !old.parentTaskId && (unfinishedItems.get(old.id) || (old.goalItemIds?.length && verifyGoalItems(old) !== true))) throw new Error('finish and review all items before completing the card')
        }
        let next = { ...old, revision: old.revision + 1 }
        let reply
        switch (type) {
          case 'personal-progress':
            // A personal reminder is separate from the verified workflow and
            // cannot complete a dependency or grant an Agent an action.
            if (actor !== 'user' || old.owner !== 'user' || old.scope !== 'personal:user'
              || old.status !== 'proposed' || old.actionRevision != null || old.evidence || old.blocked || old.stale) throw new Error('personal progress unavailable')
            keysOnly(value, ['progress', 'afterId'])
            if (!['todo', 'doing', 'finished'].includes(value.progress)) throw new Error('invalid personal progress')
            if (Object.hasOwn(value, 'afterId')) {
              const afterId = value.afterId
              if (afterId !== null && (!validId(afterId) || afterId === taskId)) throw new Error('invalid personal progress')
              if (afterId !== null) {
                const after = getTask(afterId)
                if (!after) throw new Error('reorder target unavailable')
                if (!sameCardLane({ ...old, personalProgress: value.progress }, after)) throw new Error('cards must be in the same lane')
              }
              next.position = positionAfter(old.scope, value.progress, afterId, old.id)
            }
            next.personalProgress = value.progress; break
          case 'card-details': {
            // Card presentation is distinct from acceptance and workflow.
            // An item ticked here never completes a task or a dependency.
            keysOnly(value, ['description', 'stage', 'dueDate', 'dueComplete', 'labels', 'checklist', 'coverImageId', 'type'])
            if (!Object.keys(value).length) throw new Error('invalid card details')
            if (value.type !== undefined && !old.parentTaskId && (old.intake || old.goalItemIds?.length || hasItems.get(old.id)) && !isFeatureCard({ type:value.type })) throw new Error('top-level card must be a feature or bugfix')
            applyCardDetails(next, value)
            break
          }
          case 'reorder': {
            keysOnly(value, ['afterId'])
            if (!Object.hasOwn(value, 'afterId')) throw new Error('invalid reorder')
            const afterId = value.afterId
            if (afterId !== null && (!validId(afterId) || afterId === taskId)) throw new Error('invalid reorder')
            if (afterId !== null) {
              const after = getTask(afterId)
              if (!after) throw new Error('reorder target unavailable')
              if (!sameCardLane(old, after)) throw new Error('cards must be in the same lane')
            }
            next.position = positionAfter(old.scope, cardLane(old), afterId, old.id)
            break
          }
          case 'card-comment': {
            keysOnly(value,['text'])
            if(actor!=='user'||typeof value.text!=='string'||!value.text.trim()||Buffer.byteLength(value.text)>2048)throw new Error('invalid card comment')
            const comments=Array.isArray(old.comments)?old.comments:[]
            if(comments.filter(comment => !comment.workflowAction).length>=100)throw new Error('card comment limit reached')
            next.comments=[...comments,{id:operationId,author:'user',text:value.text.trim(),at:Date.now()}]
            break
          }
          case 'card-comment-edit': {
            keysOnly(value, ['commentId', 'text'])
            if (actor !== 'user' || typeof value.text !== 'string' || !value.text.trim() || Buffer.byteLength(value.text) > 2048) throw new Error('invalid card comment')
            requireId(value.commentId, 'comment id')
            const comments = Array.isArray(old.comments) ? old.comments : []
            const index = comments.findIndex(comment => comment?.id === value.commentId && !comment.workflowAction)
            if (index === -1) throw new Error('unknown card comment')
            next.comments = comments.map((comment, at) => at === index ? { ...comment, text: value.text.trim() } : comment)
            break
          }
          case 'card-comment-delete': {
            keysOnly(value, ['commentId'])
            if (actor !== 'user') throw new Error('invalid card comment')
            requireId(value.commentId, 'comment id')
            const comments = Array.isArray(old.comments) ? old.comments : []
            if (!comments.some(comment => comment?.id === value.commentId && !comment.workflowAction)) throw new Error('unknown card comment')
            next.comments = comments.filter(comment => comment?.id !== value.commentId)
            break
          }
          case 'submit':
            if (actor !== 'user' || old.status !== 'draft' || isUnassignedItemDraft(old)) throw new Error('invalid state')
            next.status = 'proposed'; break
          case 'cancel': {
            if (actor !== 'user' || old.status === 'done' || old.status === 'cancelled') throw new Error('invalid state')
            if (unresolved(old.id)) throw new Error('task action unresolved')
            const reason = value === undefined ? 'Cancelled by the user' : (typeof value?.reason === 'string' && value.reason.trim() ? value.reason.trim().slice(0, 500) : '')
            if (!reason) throw new Error('invalid cancellation reason')
            db.prepare("UPDATE actions SET state='cancelled' WHERE task_id=? AND state='pending'").run(old.id)
            next.status = 'cancelled'; next.actionRevision = null
            next.blocked = { reason, condition: 'user restores the task', owner: 'user' }
            break
          }
          case 'restore':
            if (actor !== 'user' || old.status !== 'cancelled') throw new Error('invalid state')
            next.status = old.owner === null ? 'draft' : 'proposed'; next.actionRevision = null; next.authority = null; next.blocked = null; next.stale = false; next.evidence = null; break
          case 'release-assign': {
            if (old.parentTaskId) throw new Error('item inherits its parent release')
            if (actor !== 'user' || !value || typeof value !== 'object' || !Object.hasOwn(value, 'releaseId')) throw new Error('invalid release assignment')
            keysOnly(value, ['releaseId', 'releasePosition'])
            const releaseId = value.releaseId
            if (releaseId !== null && !validId(releaseId)) throw new Error('invalid release assignment')
            if (!releaseMembershipEditable(old)) throw new Error('release is not editable')
            if (releaseId !== null) {
              const release = getRelease(releaseId)
              if (!release || release.scope !== old.scope || !['draft','queued'].includes(release.status) || old.status === 'done' || old.status === 'cancelled') throw new Error('release unavailable')
            }
            next.releaseId = releaseId
            next.releasePosition = releaseId === null ? null : (value.releasePosition ?? null)
            if (next.releasePosition !== null && !validPosition(next.releasePosition)) throw new Error('invalid release position')
            break
          }
          case 'register':
            if (old.status !== 'proposed') throw new Error('invalid state')
            keysOnly(value, ['kind','commit','blob','reference'])
            if (value.kind === 'git') {
              if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value.commit) || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value.blob)) throw new Error('invalid authority evidence')
            } else if (value.kind === 'personal') { string(value.reference, 'personal authority') } else throw new Error('invalid authority kind')
            if (verifyRegistration(old, value, actor) !== true) throw new Error('authority evidence unverified')
            next.authority = JSON.parse(JSON.stringify(value)); next.status = 'waiting'; break
          case 'schedule':
            // An archived card is outside the workflow: scheduling it would create an
            // action the scheduler never lists, leaving the card ready but undeliverable.
            if (actor !== 'user' || old.archivedAt || old.blocked || old.stale || old.evidence || unresolved(old.id)) throw new Error('task is not schedulable')
            if (old.status === 'proposed') {
              keysOnly(value, ['kind','reference'])
              if (value.kind !== 'personal' || verifyRegistration(old, value, actor) !== true) throw new Error('authority evidence unverified')
              next.authority = JSON.parse(JSON.stringify(value)); next.status = 'waiting'
            } else if (['waiting','ready'].includes(old.status)) {
              if (!old.authority || verifyRegistration(old, old.authority, actor) !== true) throw new Error('task authority unavailable')
              if (old.status === 'waiting' && !dependenciesDone(old)) return old
              const existing = db.prepare('SELECT state FROM actions WHERE task_id=? AND revision=? AND kind=?').get(old.id, old.actionRevision, old.status === 'reported' ? 'review' : 'execute')
              if (old.status === 'ready' && ['pending','claimed','accepted','uncertain'].includes(existing?.state)) return old
              if (old.status === 'ready') throw new Error('task action unavailable')
            } else throw new Error('task is not schedulable')
            break
          case 'unschedule':
            if (actor !== 'user' || old.blocked || old.stale || old.change) throw new Error('task is not scheduled')
            if (old.status === 'ready') {
              const pending = db.prepare("SELECT 1 FROM actions WHERE task_id=? AND state='pending' AND kind='execute'").get(old.id)
              if (!pending) throw new Error('task action unavailable')
              db.prepare("UPDATE actions SET state='cancelled' WHERE task_id=? AND state='pending'").run(old.id)
              next.status = 'waiting'; next.actionRevision = null
            } else if (old.status === 'waiting' && old.authority) {
              next.status = 'proposed'; next.authority = null; next.actionRevision = null
            } else throw new Error('task is not scheduled')
            break
          case 'move-item':
          case 'move-goal-item': {
            const legacy = type === 'move-goal-item'
            keysOnly(value, legacy ? ['itemId','parentTaskId'] : ['parentTaskId'])
            const source = legacy ? old : getTask(requireId(old.parentTaskId,'parent task id'))
            const target = getTask(requireId(value.parentTaskId,'parent task id'))
            const draftCard = card => isFeatureCard(card) && parentOpen(card) && ['draft','proposed'].includes(card.status) && !card.authority
            if (actor !== 'user' || !old.scope.startsWith('room:') || !draftCard(source) || !draftCard(target)
              || source.id === target.id || source.scope !== old.scope || target.scope !== old.scope
              || (source.releaseId ?? null) !== (target.releaseId ?? null)
              || (source.releaseId && !['draft','queued'].includes(getRelease(source.releaseId)?.status))) throw new Error('item cannot move between these cards')
            if (legacy) {
              if (!source.goalItemIds?.includes(value.itemId) || target.goalItemIds?.includes(value.itemId)
                || (target.goalItemIds?.length ?? 0) >= 100) throw new Error('item cannot move between these cards')
              next.goalItemIds = source.goalItemIds.filter(id => id !== value.itemId)
              save(target, {...target, revision:target.revision + 1, goalItemIds:[...(target.goalItemIds ?? []),value.itemId]})
            } else {
              if (!parentOpen(old) || !['draft','proposed'].includes(old.status) || old.authority || unresolved(old.id)) throw new Error('item cannot move between these cards')
              next.parentTaskId = target.id
            }
            break
          }
          case 'link-goal-items': {
            keysOnly(value, ['itemIds'])
            if (actor !== 'user' || !old.scope.startsWith('room:') || !isFeatureCard(old) || !parentOpen(old)
              || !Array.isArray(value.itemIds) || !value.itemIds.length || value.itemIds.length > 100
              || value.itemIds.some(id => typeof id !== 'string' || !/^legacy-[a-f0-9]{64}$/.test(id))) throw new Error('invalid goal item links')
            const requested = new Set(value.itemIds)
            if (getAll().some(row => row.id !== old.id && row.goalItemIds?.some(id => requested.has(id)))) throw new Error('goal item already belongs to a card')
            next.goalItemIds = [...new Set([...(old.goalItemIds ?? []), ...requested])]
            break
          }
          case 'reply':
            keysOnly(value, ['text'])
            if (actor === 'user' || actor === 'scheduler' || old.status !== 'draft' || old.authority || old.archivedAt || old.stale
              || !old.scope.startsWith('room:') || (actor !== old.owner && actor !== old.reviewer)
              || typeof value.text !== 'string' || !value.text.trim() || Buffer.byteLength(value.text) > 2048) throw new Error('invalid card reply')
            reply = {text:value.text.trim()}; break
          case 'start':
            if (!(manual ? ['proposed','waiting'].includes(old.status) : old.status === 'ready') || old.stale || old.blocked || actor !== old.owner || !dependenciesDone(old)) throw new Error('cannot start')
            if (!manual && !db.prepare("SELECT 1 FROM actions WHERE task_id=? AND revision=? AND kind='execute' AND state='accepted'").get(old.id, old.actionRevision)) throw new Error('verified action receipt required')
            if (sessionId !== undefined) next.workSessionId = requireId(sessionId, 'work session')
            next.status = 'working'; delete next.progress; reply = {}; break
          case 'progress': {
            if ((!old.authority && !manual) || old.status !== 'working' || old.stale || old.blocked || old.archivedAt || actor !== old.owner || !dependenciesDone(old)) throw new Error('cannot update task progress')
            keysOnly(value, ['summary','next'])
            const summary = string(value.summary, 'progress summary').trim()
            const nextStep = string(value.next, 'next step').trim()
            if (Buffer.byteLength(summary) > 1024 || Buffer.byteLength(nextStep) > 1024) throw new Error('task progress too long')
            if (old.progress?.summary === summary && old.progress?.next === nextStep) return old
            reply = { text:summary, next:nextStep }
            break
          }
          case 'report':
            if (old.status !== 'working' || old.stale || old.blocked || actor !== old.owner || !dependenciesDone(old)) throw new Error('cannot report')
            keysOnly(value, ['kind','evidence','targetCommit','targetBlob','acceptanceBlob','environment'])
            string(value.evidence, 'evidence'); string(value.environment, 'environment')
            if (value.kind === 'git') {
              for (const key of ['targetCommit','targetBlob','acceptanceBlob']) if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value[key])) throw new Error('invalid evidence identity')
            } else if (value.kind === 'personal') {
              if (['targetCommit','targetBlob','acceptanceBlob'].some(key => Object.hasOwn(value, key))) throw new Error('invalid personal evidence')
            } else throw new Error('invalid evidence kind')
            next.evidence = JSON.parse(JSON.stringify(value))
            if (verifyEvidence(old, value, actor, 'report') !== true) throw new Error('report evidence unverified')
            if (!manual) { finishAction(old.id, 'execute'); next.actionRevision = next.revision }
            next.status = 'reported'
            reply = { text:value.evidence, environment:value.environment }; break
          case 'archive':
            if (actor !== 'user') throw new Error('archive is not authorized')
            if (old.archivedAt) throw new Error('task is already archived')
            if (['ready', 'working', 'reported'].includes(old.status)) throw new Error('finish or cancel active work before archiving')
            if (old.releaseId) {
              const release = getRelease(old.releaseId)
              if (release && !['published', 'cancelled'].includes(release.status)) throw new Error('remove the card from its release before archiving')
            }
            next = { ...next, archivedAt: Date.now() }
            break
          case 'unarchive':
            if (actor !== 'user') throw new Error('unarchive is not authorized')
            if (!old.archivedAt) throw new Error('task is not archived')
            next = { ...next }
            delete next.archivedAt
            break
          case 'review':
            if (old.status !== 'reported' || old.stale || old.blocked || actor !== old.reviewer || actor === old.owner || !dependenciesDone(old)) throw new Error('cannot review')
            keysOnly(value, ['evidence','result']); string(value.evidence, 'review evidence'); if (!['pass', 'rework'].includes(value.result)) throw new Error('invalid review')
            if (verifyEvidence(old, value, actor, 'review') !== true) throw new Error('review evidence unverified')
            if (!manual) finishAction(old.id, 'review')
            next.review = { result: value.result, evidence: value.evidence, actor }; next.status = value.result === 'pass' ? 'done' : 'waiting'
            reply = { text:value.evidence, result:value.result }; break
          case 'block':
            if (old.status === 'done' || (old.status === 'proposed' && !manual) || (manual && (old.status === 'cancelled' || old.archivedAt))) throw new Error('cannot block')
            // The working owner may block the execution they already accepted. An
            // unknown delivery or any other in-flight action still needs reconciliation.
            if (unresolved(old.id)) {
              const acceptedExecution = old.status === 'working' && actor === old.owner ? actionId(old.id, old.actionRevision, 'execute') : ''
              if (db.prepare("SELECT 1 FROM actions WHERE task_id=? AND state IN ('claimed','accepted','uncertain') AND NOT (id=? AND state='accepted') LIMIT 1").get(old.id, acceptedExecution)) throw new Error('action outcome unresolved')
            }
            keysOnly(value, ['reason','condition','owner'])
            db.prepare("UPDATE actions SET state='cancelled' WHERE task_id=? AND state='pending'").run(old.id)
            if (old.status === 'ready') next.status = 'waiting'
            next.blocked = { reason: string(value?.reason, 'reason'), condition: string(value?.condition, 'condition'), owner: requireId(value?.owner, 'block owner') }
            if (stable(old.blocked ?? null) === stable(next.blocked)) return old
            reply = { text:next.blocked.reason, condition:next.blocked.condition, blockOwner:next.blocked.owner }; break
          case 'unblock':
            if (!old.blocked || old.stale) throw new Error('not blocked or evidence stale'); next.blocked = null; if (!manual && old.status === 'reported') next.actionRevision = next.revision
            reply = {}; break
          case 'dependencies':
            if (!['proposed', 'waiting'].includes(old.status)) throw new Error('cannot change dependencies in active task')
            checkGraph(taskId, value); checkBindings(old, value, []); next.dependencies = value; next.dependencyGrants = []; break
          case 'invalidate':
            keysOnly(value, ['reason','evidence']); string(value.reason, 'reason'); string(value.evidence, 'invalidation evidence')
            if (old.stale || !old.evidence || verifyInvalidation(old, value, actor) !== true) throw new Error('invalidation unverified')
            next.stale = true; next.blocked = { reason: value.reason, condition: 'independent evidence revalidation', owner: old.reviewer }; break
          case 'revalidate':
            keysOnly(value, ['evidence']); string(value.evidence, 'revalidation evidence')
            if (!old.stale || actor !== old.reviewer || unresolved(old.id) || !dependenciesDone(old) || unfinishedItems.get(old.id) || verifyEvidence(old, value, actor, 'revalidate') !== true) throw new Error('cannot revalidate')
            next.stale = false; next.blocked = null; if (!manual && old.status === 'reported') next.actionRevision = next.revision; break
          case 'edit': {
            keysOnly(value, ['title','owner','reviewer','acceptance','dependencies','dependencyGrants'])
            const fields = Object.keys(value)
            if (!fields.length) throw new Error('empty edit')
            const significant = fields.some(k => k !== 'title' && stable(value[k]) !== stable(old[k]))
            if (significant && (!['draft','proposed','waiting','ready'].includes(old.status) || old.evidence || (old.stale && old.status !== 'waiting') || unresolved(old.id))) throw new Error('responsibility or acceptance change requires separate reconciliation')
            if (Object.hasOwn(value, 'title')) next.title = string(value.title, 'title')
            if (!isUnassignedItemDraft({...next,...value})) {
              if (Object.hasOwn(value, 'owner')) next.owner = requireId(value.owner, 'owner')
              if (Object.hasOwn(value, 'reviewer')) next.reviewer = requireId(value.reviewer, 'reviewer')
              if (next.owner === next.reviewer) throw new Error('reviewer must be independent')
            } else { next.owner = null; next.reviewer = null }
            if (Object.hasOwn(value, 'acceptance')) next.acceptance = string(value.acceptance, 'acceptance')
            if (Object.hasOwn(value, 'dependencies') || Object.hasOwn(value, 'dependencyGrants')) {
              const dependencies = value.dependencies ?? old.dependencies, grants = value.dependencyGrants ?? old.dependencyGrants ?? []
              checkGraph(taskId, dependencies); checkBindings(next, dependencies, grants); next.dependencies = dependencies; next.dependencyGrants = grants
            }
            if (significant && !['draft','proposed'].includes(old.status)) {
              db.prepare("UPDATE actions SET state='cancelled' WHERE task_id=? AND state='pending'").run(old.id)
              next.status = 'proposed'; next.authority = null; next.actionRevision = null; next.blocked = null; next.stale = false
            }
            break
          }
          case 'attach': {
            keysOnly(value, ['images'])
            if (!Array.isArray(value.images) || !value.images.length || value.images.length > 20) throw new Error('invalid attachments')
            const items = [...old.attachments], seen = new Map(items.map(item => [item.id, item]))
            for (const item of value.images) {
              keysOnly(item, ['id','sha256','mediaType','size','name']); requireId(item.id, 'attachment id')
              if (!/^[0-9a-f]{64}$/.test(item.sha256) || !['image/png','image/jpeg','image/webp','image/gif','application/pdf','application/zip','text/plain','text/markdown','application/json'].includes(item.mediaType) || !Number.isSafeInteger(item.size) || item.size < 1 || item.size > 20 * 1024 * 1024 || typeof item.name !== 'string' || !item.name.trim() || Buffer.byteLength(item.name) > 255 || /[\\/\x00-\x1f]/.test(item.name)) throw new Error('invalid attachment reference')
              if (verifyAttachment(old, item, actor) !== true) throw new Error('attachment unverified')
              const prior = seen.get(item.id)
              if (prior && stable(prior) !== stable(item)) throw new Error('attachment id conflict')
              if (!prior) { const saved = { id: item.id, sha256: item.sha256, mediaType: item.mediaType, size: item.size, name: item.name }; items.push(saved); seen.set(item.id, saved) }
            }
            if (items.length > 20) throw new Error('too many attachments')
            next.attachments = items; break
          }
          case 'detach': {
            keysOnly(value, ['ids'])
            if (!Array.isArray(value.ids) || !value.ids.length || value.ids.length > 20 || new Set(value.ids).size !== value.ids.length) throw new Error('invalid attachments')
            for (const id of value.ids) if (!validId(id) || !old.attachments.some(item => item.id === id)) throw new Error('unknown attachment')
            next.attachments = old.attachments.filter(item => !value.ids.includes(item.id)); if (value.ids.includes(next.coverImageId)) next.coverImageId = null; break
          }
          case 'remove-image': {
            keysOnly(value, ['imageId']); requireId(value.imageId, 'image id')
            if (!old.attachments.some(item => item.id === value.imageId)) throw new Error('unknown attachment')
            next.attachments = old.attachments.filter(item => item.id !== value.imageId); if (next.coverImageId === value.imageId) next.coverImageId = null; break
          }
          case 'share': {
            keysOnly(value, ['targetRoomId','fields']); requireId(value.targetRoomId, 'target room id')
            if (actor !== 'user' || !old.scope.startsWith('room:') || !Array.isArray(value.fields) || !value.fields.includes('status') || value.fields.length > 2 || new Set(value.fields).size !== value.fields.length || value.fields.some(field => !['status','title'].includes(field)) || verifyShare(old, value, actor) !== true) throw new Error('share not authorized')
            const shares = old.shares ?? []
            if (shares.length >= 100 || shares.some(share => !share.revoked && share.targetRoomId === value.targetRoomId)) throw new Error('share already exists or limit reached')
            const fields = [...value.fields].sort()
            const entry = { id:digest(['share', old.id, value.targetRoomId, old.revision]), taskId:old.id, targetRoomId:value.targetRoomId, revoked:false, grantedBy:'user', fields, ...(fields.includes('title') ? { titleSnapshot:old.title } : {}) }
            next.shares = [...shares, entry]; break
          }
          case 'unshare': {
            keysOnly(value, ['shareId']); requireId(value.shareId, 'share id')
            if (actor !== 'user') throw new Error('share not authorized')
            const shares = old.shares ?? [], found = shares.find(share => share.id === value.shareId && !share.revoked)
            if (!found) throw new Error('share unavailable')
            next.shares = shares.map(share => share.id === value.shareId ? { ...share, revoked:true } : share); break
          }
          default: throw new Error('unknown command')
        }
        if (reply) {
          const at = Date.now()
          if (type === 'progress') next.progress = { summary:reply.text, next:reply.next, actor, at }
          // Keep the latest workflow replies on the card without using the human comment quota.
          const comments = [...(old.comments ?? [])]
          if (comments.filter(item => item.workflowAction).length >= 50) {
            const oldestMilestone = comments.findIndex(item => item.workflowAction === 'progress')
            comments.splice(oldestMilestone >= 0 ? oldestMilestone : comments.findIndex(item => item.workflowAction), 1)
          }
          comments.push({ id:operationId, author:actor, at, workflowAction:type, ...reply })
          next.comments = comments
        }
        if(['edit','card-details','card-comment','card-comment-edit','card-comment-delete','move-item','move-goal-item','reorder','personal-progress','attach','remove-image','share','unshare','submit','cancel','restore','release-assign'].includes(type)) {
          const activity=Array.isArray(old.boardActivity)?old.boardActivity:[]
          next.boardActivity=[...activity,{id:operationId,actor,type,at:Date.now()}].slice(-50)
        }
        save(old, next)
        if (type === 'report') action(next, 'review', next.reviewer)
        if (type === 'register' || type === 'schedule' || type === 'review' && value.result === 'rework' || type === 'unblock' || type === 'dependencies') next = ready(next)
        if (type === 'unblock' && next.status === 'reported') action(next, 'review', next.reviewer)
        if (type === 'review' && value.result === 'pass') for (const id of dependents(taskId)) { const task = getTask(id); if (task) ready(task) }
        if (next.status === 'done' && next.releaseId) reconcileRelease(next.releaseId)
        if (type === 'invalidate') {
          db.prepare("UPDATE actions SET state='cancelled' WHERE task_id=? AND state='pending'").run(taskId)
          db.prepare("UPDATE actions SET state='uncertain',receipt=COALESCE(receipt,'evidence invalidated; outcome unknown') WHERE task_id=? AND state IN ('claimed','accepted')").run(taskId)
          const queue = [taskId], seen = new Set(queue)
          for (let cursor = 0; cursor < queue.length; cursor += 1) {
            for (const id of dependents(queue[cursor])) {
              if (seen.has(id)) continue
              seen.add(id); queue.push(id)
              const child = getTask(id)
              if (!child) continue
              db.prepare("UPDATE actions SET state='cancelled' WHERE task_id=? AND state='pending'").run(child.id)
              db.prepare("UPDATE actions SET state='uncertain',receipt=COALESCE(receipt,'dependency evidence invalidated; outcome unknown') WHERE task_id=? AND state IN ('claimed','accepted')").run(child.id)
              if (['proposed', 'waiting'].includes(child.status) || child.stale) continue
              const blocked = { reason: 'dependency evidence invalidated', condition: 'independent evidence revalidation', owner: child.reviewer }
              const changed = { ...child, revision: child.revision + 1, stale: true, blocked, ...(child.status === 'ready' ? { status: 'waiting' } : {}) }
              save(child, changed)
            }
          }
        }
        if (type === 'unshare') {
          const queue = db.prepare('SELECT task_id FROM task_dependencies WHERE dependency_id=? AND grant_id=? ORDER BY task_id').all(taskId, value.shareId).map(row => row.task_id), seen = new Set()
          for (let cursor = 0; cursor < queue.length; cursor += 1) {
            const id = queue[cursor]
            if (seen.has(id)) continue
            seen.add(id)
            const child = getTask(id)
            if (!child) continue
            queue.push(...dependents(id))
            const blocked = { reason:'dependency grant revoked', condition:'restore an authorized dependency and reconcile prior work', owner:child.reviewer }
            const changed = { ...child, revision:child.revision + 1, stale:true, blocked, ...(child.status === 'ready' ? { status:'waiting' } : {}) }
            db.prepare("UPDATE actions SET state='cancelled' WHERE task_id=? AND state='pending'").run(child.id)
            db.prepare("UPDATE actions SET state='uncertain',receipt=COALESCE(receipt,'dependency grant revoked; outcome unknown') WHERE task_id=? AND state IN ('claimed','accepted')").run(child.id)
            save(child, changed)
          }
        }
        if (type === 'revalidate') {
          next = ready(next)
          if (next.status === 'reported') action(next, 'review', next.reviewer)
          if (next.status === 'done') for (const id of dependents(taskId)) { const task = getTask(id); if (task) ready(task) }
        }
        return next
      })
    },
    claimAction({ actionId: id, actor, intent }) {
      requireId(id, 'action id'); requireId(actor, 'actor')
      stable(intent); keysOnly(intent, ['admissionId','messageId','targetBotId','targetSessionId','payload'])
      for (const key of ['admissionId','messageId','targetBotId','targetSessionId']) requireId(intent[key], key)
      if (!intent.payload || typeof intent.payload !== 'object' || Array.isArray(intent.payload) || intent.payload.id !== intent.messageId || intent.payload.role !== 'user' || !Array.isArray(intent.payload.content) || !intent.payload.source || typeof intent.payload.source.kind !== 'string' || !intent.payload.source.kind) throw new Error('invalid admission payload')
      const payload = stable(intent.payload), payloadHash = createHash('sha256').update(payload).digest('hex')
      return tx(() => {
        const row = db.prepare('SELECT * FROM actions WHERE id=?').get(id)
        if (!row) throw new Error('action unavailable')
        const task = getTask(row.task_id)
        if (authorize({ type: 'claim', actor, task, action: row }) !== true) throw new Error('not authorized')
        const existing = db.prepare('SELECT * FROM admission_intents WHERE action_id=?').get(id)
        if (existing) {
          if (existing.admission_id !== intent.admissionId || existing.message_id !== intent.messageId || existing.target_bot_id !== intent.targetBotId || existing.target_session_id !== intent.targetSessionId || existing.payload_hash !== payloadHash || existing.payload !== payload) throw new Error('admission intent conflict')
          return { ...row, targetId:row.actor, claimedNow:false }
        }
        if (row.state !== 'pending') throw new Error('action unavailable')
        if (!itemContextOpen(task) || task.actionRevision !== row.revision || task.blocked || task.stale || (row.kind === 'execute' && (task.status !== 'ready' || !dependenciesDone(task))) || (row.kind === 'review' && task.status !== 'reported')) throw new Error('action stale or blocked')
        if (intent.targetBotId !== row.actor || verifyAdmission(task, row, intent) !== true) throw new Error('admission intent unverified')
        db.prepare('INSERT INTO admission_intents(action_id,admission_id,message_id,target_bot_id,target_session_id,task_revision,action_revision,payload_hash,payload) VALUES(?,?,?,?,?,?,?,?,?)').run(id, intent.admissionId, intent.messageId, intent.targetBotId, intent.targetSessionId, task.revision, row.revision, payloadHash, payload)
        db.prepare("UPDATE actions SET state='claimed' WHERE id=? AND state='pending'").run(id)
        addHistory.run(`action:${id}:claimed`, actor, task.id, JSON.stringify(row), JSON.stringify({ ...row, state: 'claimed' }))
        return { ...row, targetId:row.actor, state:'claimed', claimedNow:true }
      })
    },
    markAction({ actionId: id, actor, expectedState, state, receipt }) {
      requireId(id, 'action id'); requireId(actor, 'actor')
      const transitions = { claimed: ['accepted', 'uncertain'], accepted: ['uncertain'] }
      if (!transitions[expectedState]?.includes(state)) throw new Error('invalid action transition')
      string(receipt, 'receipt')
      return tx(() => {
        const row = db.prepare('SELECT * FROM actions WHERE id=?').get(id)
        const intent = row && db.prepare('SELECT * FROM admission_intents WHERE action_id=?').get(id)
        if (!row || !intent || authorize({ type: 'receipt', actor, task: getTask(row.task_id), action: row }) !== true || verifyReceipt(row, state, receipt, intent) !== true) throw new Error('action receipt unverified')
        const changes = db.prepare('UPDATE actions SET state=?,receipt=? WHERE id=? AND state=?').run(state, receipt, id, expectedState).changes
        if (changes !== 1) throw new Error('action state conflict')
        addHistory.run(`action:${id}:${state}`, actor, row.task_id, JSON.stringify(row), JSON.stringify({ ...row, state, receipt }))
        return { id, state, receipt }
      })
    },
  }
}
