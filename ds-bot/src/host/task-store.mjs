import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { lstatSync, openSync, closeSync, fsyncSync, constants } from 'node:fs'
import { dirname, isAbsolute } from 'node:path'

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
  { type:'table', name:'task_dependencies', tbl_name:'task_dependencies', sql:'CREATE TABLE task_dependencies (task_id TEXT NOT NULL, dependency_id TEXT NOT NULL, grant_id TEXT, PRIMARY KEY(task_id,dependency_id), FOREIGN KEY(task_id) REFERENCES tasks(id), FOREIGN KEY(dependency_id) REFERENCES tasks(id))' },
  { type:'table', name:'tasks', tbl_name:'tasks', sql:'CREATE TABLE tasks (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, body TEXT NOT NULL)' },
]
const keysOnly = (value, allowed) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !allowed.includes(k))) throw new Error('invalid fields')
}

/** Open a private task journal. The containing directory must be private. */
export function openTaskStore(path, { authorize = () => false, verifyRegistration = () => false, verifyEvidence = () => false, verifyReceipt = () => false, verifyInvalidation = () => false, verifyAttachment = () => false, verifyShare = () => false, verifyDependency = () => false, verifyAdmission = () => false, assertWriteLock = () => { throw new Error('write lock required') } } = {}) {
  if (!isAbsolute(path)) throw new Error('database path must be absolute')
  const dir = lstatSync(dirname(path))
  if (!dir.isDirectory() || dir.isSymbolicLink() || (dir.mode & 0o077) || dir.uid !== process.getuid()) throw new Error('database directory must be private')
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
  if (!file.isFile() || file.isSymbolicLink() || (file.mode & 0o077) || file.uid !== process.getuid()) throw new Error('database must be a private file')
  const db = new DatabaseSync(path)
  db.exec('PRAGMA busy_timeout=0; PRAGMA synchronous=EXTRA; PRAGMA foreign_keys=ON')
  if (created) db.exec('PRAGMA journal_mode=DELETE')
  if (db.prepare('PRAGMA journal_mode').get().journal_mode !== 'delete') { db.close(); throw new Error('invalid task journal mode') }
  if (!created && (db.prepare('PRAGMA application_id').get().application_id !== 0x44534254 || db.prepare('PRAGMA user_version').get().user_version !== 5 || db.prepare('PRAGMA quick_check').get().quick_check !== 'ok')) { db.close(); throw new Error('unknown or damaged task database') }
  if (created) {
    db.exec('BEGIN IMMEDIATE')
    for (const item of schema.filter(item => item.type === 'table')) db.exec(item.sql)
    for (const item of schema.filter(item => item.type === 'index')) db.exec(item.sql)
    db.exec('PRAGMA application_id=1146307156; PRAGMA user_version=5')
    try { assertWriteLock(); db.exec('COMMIT') } catch (e) { try { db.exec('ROLLBACK') } finally { db.close() }; throw e }
    const dirFd = openSync(dirname(path), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try { fsyncSync(dirFd) } finally { closeSync(dirFd) }
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
  }
  const addAction = db.prepare("INSERT OR IGNORE INTO actions(id,task_id,revision,kind,actor,state) VALUES(?,?,?,?,?,'pending')")
  const action = (task, kind, actor) => addAction.run(actionId(task.id, task.actionRevision, kind), task.id, task.actionRevision, kind, actor)
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
  const ready = task => {
    if (task.status !== 'waiting' || task.blocked || task.stale || !dependenciesDone(task)) return task
    const next = { ...task, revision: task.revision + 1, actionRevision: task.revision + 1, status: 'ready' }; save(task, next); action(next, 'execute', next.owner); return next
  }
  const unresolved = id => db.prepare("SELECT 1 FROM actions WHERE task_id=? AND state IN ('claimed','accepted','uncertain') LIMIT 1").get(id)
  const finishAction = (id, kind) => {
    const changes = db.prepare("UPDATE actions SET state='done' WHERE task_id=? AND kind=? AND state='accepted'").run(id, kind).changes
    if (changes !== 1) throw new Error('verified action receipt required')
  }
  return {
    close() { db.close() },
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
    create({ operationId, actor, task }) {
      if (!task || typeof task !== 'object') throw new Error('invalid task')
      requireId(actor, 'actor'); stable(task); keysOnly(task, ['id','title','owner','reviewer','scope','acceptance','dependencies','dependencyGrants'])
      const payload = { type: 'create', actor, task }
      return transact(operationId, actor, payload, () => ({ type: 'create', actor, task }), () => {
        const id = requireId(task.id, 'task id'), owner = requireId(task.owner, 'owner'), reviewer = requireId(task.reviewer, 'reviewer')
        if (owner === reviewer) throw new Error('reviewer must be independent')
        string(task.title, 'title'); string(task.acceptance, 'acceptance'); requireId(task.scope, 'scope')
        if (getTask(id)) throw new Error('task id exists')
        if (db.prepare('SELECT count(*) AS n FROM tasks').get().n >= MAX_TASKS) throw new Error('task limit reached')
        const dependencies = task.dependencies ?? [], dependencyGrants = task.dependencyGrants ?? []; checkGraph(id, dependencies)
        checkBindings({ scope:task.scope, owner, reviewer }, dependencies, dependencyGrants)
        const record = { id, title: task.title, owner, reviewer, scope: task.scope, acceptance: task.acceptance, dependencies, dependencyGrants, attachments: [], shares: [], revision: 1, actionRevision: null, status: 'proposed', authority: null, evidence: null, blocked: null, stale: false }
        db.prepare('INSERT INTO tasks(id,revision,body) VALUES(?,?,?)').run(id, 1, JSON.stringify(record)); insertEdges(record)
        addHistory.run(operationId, actor, id, null, JSON.stringify(record)); return record
      })
    },
    command({ operationId, taskId, expectedRevision, actor, type, value }) {
      requireId(taskId, 'task id'); requireId(actor, 'actor')
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new Error('invalid revision')
      const payload = { type, taskId, expectedRevision, actor, ...(value !== undefined ? { value } : {}) }; stable(payload)
      return transact(operationId, actor, payload, () => ({ type, actor, task: getTask(taskId) }), () => {
        const old = getTask(taskId); if (!old) throw new Error('unknown task')
        if (old.revision !== expectedRevision) throw new Error('revision conflict')
        let next = { ...old, revision: old.revision + 1 }
        switch (type) {
          case 'personal-progress':
            // A personal reminder is separate from the verified workflow and
            // cannot complete a dependency or grant an Agent an action.
            if (actor !== 'user' || old.owner !== 'user' || old.scope !== 'personal:user'
              || old.status !== 'proposed' || old.actionRevision != null || old.evidence || old.blocked || old.stale) throw new Error('personal progress unavailable')
            keysOnly(value, ['progress'])
            if (!['todo', 'doing', 'finished'].includes(value.progress)) throw new Error('invalid personal progress')
            next.personalProgress = value.progress; break
          case 'register':
            if (old.status !== 'proposed') throw new Error('invalid state')
            keysOnly(value, ['kind','commit','blob','reference'])
            if (value.kind === 'git') {
              if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value.commit) || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value.blob)) throw new Error('invalid authority evidence')
            } else if (value.kind === 'personal') { string(value.reference, 'personal authority') } else throw new Error('invalid authority kind')
            if (verifyRegistration(old, value, actor) !== true) throw new Error('authority evidence unverified')
            next.authority = JSON.parse(JSON.stringify(value)); next.status = 'waiting'; break
          case 'start':
            if (old.status !== 'ready' || old.stale || old.blocked || actor !== old.owner || !dependenciesDone(old)) throw new Error('cannot start')
            if (!db.prepare("SELECT 1 FROM actions WHERE task_id=? AND revision=? AND kind='execute' AND state='accepted'").get(old.id, old.actionRevision)) throw new Error('verified action receipt required')
            next.status = 'working'; break
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
            finishAction(old.id, 'execute'); next.status = 'reported'; next.actionRevision = next.revision; break
          case 'review':
            if (old.status !== 'reported' || old.stale || old.blocked || actor !== old.reviewer || actor === old.owner || !dependenciesDone(old)) throw new Error('cannot review')
            keysOnly(value, ['evidence','result']); string(value.evidence, 'review evidence'); if (!['pass', 'rework'].includes(value.result)) throw new Error('invalid review')
            if (verifyEvidence(old, value, actor, 'review') !== true) throw new Error('review evidence unverified')
            finishAction(old.id, 'review')
            next.review = { result: value.result, evidence: value.evidence, actor }; next.status = value.result === 'pass' ? 'done' : 'waiting'; break
          case 'block':
            if (['done', 'proposed'].includes(old.status)) throw new Error('cannot block')
            if (unresolved(old.id)) throw new Error('action outcome unresolved')
            keysOnly(value, ['reason','condition','owner'])
            db.prepare("UPDATE actions SET state='cancelled' WHERE task_id=? AND state='pending'").run(old.id)
            if (old.status === 'ready') next.status = 'waiting'
            next.blocked = { reason: string(value?.reason, 'reason'), condition: string(value?.condition, 'condition'), owner: requireId(value?.owner, 'block owner') }; break
          case 'unblock':
            if (!old.blocked || old.stale) throw new Error('not blocked or evidence stale'); next.blocked = null; if (old.status === 'reported') next.actionRevision = next.revision; break
          case 'dependencies':
            if (!['proposed', 'waiting'].includes(old.status)) throw new Error('cannot change dependencies in active task')
            checkGraph(taskId, value); checkBindings(old, value, []); next.dependencies = value; next.dependencyGrants = []; break
          case 'invalidate':
            keysOnly(value, ['reason','evidence']); string(value.reason, 'reason'); string(value.evidence, 'invalidation evidence')
            if (old.stale || !old.evidence || verifyInvalidation(old, value, actor) !== true) throw new Error('invalidation unverified')
            next.stale = true; next.blocked = { reason: value.reason, condition: 'independent evidence revalidation', owner: old.reviewer }; break
          case 'revalidate':
            keysOnly(value, ['evidence']); string(value.evidence, 'revalidation evidence')
            if (!old.stale || actor !== old.reviewer || unresolved(old.id) || !dependenciesDone(old) || verifyEvidence(old, value, actor, 'revalidate') !== true) throw new Error('cannot revalidate')
            next.stale = false; next.blocked = null; if (old.status === 'reported') next.actionRevision = next.revision; break
          case 'edit': {
            keysOnly(value, ['title','owner','reviewer','acceptance','dependencies','dependencyGrants'])
            const fields = Object.keys(value)
            if (!fields.length) throw new Error('empty edit')
            const significant = fields.some(k => k !== 'title' && stable(value[k]) !== stable(old[k]))
            if (significant && (!['proposed','waiting','ready'].includes(old.status) || old.evidence || (old.stale && old.status !== 'waiting') || unresolved(old.id))) throw new Error('responsibility or acceptance change requires separate reconciliation')
            if (Object.hasOwn(value, 'title')) next.title = string(value.title, 'title')
            if (Object.hasOwn(value, 'owner')) next.owner = requireId(value.owner, 'owner')
            if (Object.hasOwn(value, 'reviewer')) next.reviewer = requireId(value.reviewer, 'reviewer')
            if (next.owner === next.reviewer) throw new Error('reviewer must be independent')
            if (Object.hasOwn(value, 'acceptance')) next.acceptance = string(value.acceptance, 'acceptance')
            if (Object.hasOwn(value, 'dependencies') || Object.hasOwn(value, 'dependencyGrants')) {
              const dependencies = value.dependencies ?? old.dependencies, grants = value.dependencyGrants ?? old.dependencyGrants ?? []
              checkGraph(taskId, dependencies); checkBindings(next, dependencies, grants); next.dependencies = dependencies; next.dependencyGrants = grants
            }
            if (significant && old.status !== 'proposed') {
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
              if (!/^[0-9a-f]{64}$/.test(item.sha256) || !['image/png','image/jpeg','image/webp','image/gif'].includes(item.mediaType) || !Number.isSafeInteger(item.size) || item.size < 1 || item.size > 20 * 1024 * 1024 || typeof item.name !== 'string' || !item.name.trim() || Buffer.byteLength(item.name) > 255 || /[\\/\x00-\x1f]/.test(item.name)) throw new Error('invalid attachment reference')
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
            next.attachments = old.attachments.filter(item => !value.ids.includes(item.id)); break
          }
          case 'remove-image': {
            keysOnly(value, ['imageId']); requireId(value.imageId, 'image id')
            if (!old.attachments.some(item => item.id === value.imageId)) throw new Error('unknown attachment')
            next.attachments = old.attachments.filter(item => item.id !== value.imageId); break
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
        save(old, next)
        if (type === 'report') action(next, 'review', next.reviewer)
        if (type === 'register' || type === 'review' && value.result === 'rework' || type === 'unblock' || type === 'dependencies') next = ready(next)
        if (type === 'unblock' && next.status === 'reported') action(next, 'review', next.reviewer)
        if (type === 'review' && value.result === 'pass') for (const id of dependents(taskId)) { const task = getTask(id); if (task) ready(task) }
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
        if (task.actionRevision !== row.revision || task.blocked || task.stale || (row.kind === 'execute' && (task.status !== 'ready' || !dependenciesDone(task))) || (row.kind === 'review' && task.status !== 'reported')) throw new Error('action stale or blocked')
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
