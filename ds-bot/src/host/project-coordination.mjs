import { createHash } from 'node:crypto'
import { closeSync, constants, lstatSync, openSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { isPrivateFile } from './private-storage.mjs'
import { syncDirectorySync } from './directory-sync.mjs'

const invalid = message => { throw Object.assign(new Error(message), { code:'bot/invalid' }) }
const validId = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 256 && !/[\x00-\x1f]/.test(value)
const text = (value, limit) => typeof value === 'string' && value.trim().length > 0 && value.length <= limit
const roomIds = value => Array.isArray(value) && value.length > 0 && value.length <= 64 && value.every(validId) && new Set(value).size === value.length
const PAGE = 20

export const projectRolesChanged = event => event.kind==='binding' || event.kind==='decision' && !!event.taskId
  || !!event.changedFields?.some(field=>['created','owner','reviewer','parentTaskId','archivedAt','status'].includes(field))
const tables = [
  'CREATE TABLE p.projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, coordinator TEXT NOT NULL, revision INTEGER NOT NULL)',
  'CREATE TABLE p.rooms (room TEXT PRIMARY KEY, project TEXT NOT NULL REFERENCES projects(id))',
  'CREATE TABLE p.events (project TEXT NOT NULL, revision INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(project,revision))',
  'CREATE TABLE p.audience (room TEXT NOT NULL, revision INTEGER NOT NULL, project TEXT NOT NULL, PRIMARY KEY(room,revision))',
  'CREATE TABLE p.policies (room TEXT NOT NULL, resource TEXT NOT NULL, revision INTEGER NOT NULL, PRIMARY KEY(room,resource))',
  'CREATE TABLE p.task_events (task TEXT NOT NULL, project TEXT NOT NULL, revision INTEGER NOT NULL, PRIMARY KEY(task,project,revision))',
  'CREATE TABLE p.activity (task TEXT PRIMARY KEY, project TEXT NOT NULL, revision INTEGER NOT NULL)',
  'CREATE TABLE p.claims (project TEXT NOT NULL, resource TEXT NOT NULL, task TEXT NOT NULL, PRIMARY KEY(project,resource))',
  'CREATE TABLE p.links (task TEXT PRIMARY KEY, project TEXT NOT NULL, revision INTEGER NOT NULL)',
  'CREATE TABLE p.acks (room TEXT NOT NULL, revision INTEGER NOT NULL, actor TEXT NOT NULL, context TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(room,revision,actor,context))',
  'CREATE TABLE p.receipts (operation TEXT PRIMARY KEY, room TEXT NOT NULL, actor TEXT NOT NULL, fingerprint TEXT NOT NULL, body TEXT NOT NULL)',
]

// A rollback-journal attachment participates in the same SQLite commit as the original card.
// Keeping project data out of the existing task schema also leaves the old journal readable.
export function projectJournal(db, taskPath, { tx, assertWriteLock, getTask, getRelease, conversationKind, onCommit }) {
  const path = join(dirname(taskPath), 'project-coordination.sqlite')
  let attached = false, identity
  let updates = [], taskParticipants
  const stat = () => lstatSync(path, {throwIfNoEntry:false})
  function open(create) {
    if (attached) return true
    const existing = stat()
    if (!existing && !create) return false
    let fresh = false
    if (!existing) {
      assertWriteLock()
      closeSync(openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600))
      fresh = true
    }
    identity = stat()
    if (!isPrivateFile(path, identity)) throw new Error('Project journal is not private')
    db.prepare('ATTACH DATABASE ? AS p').run(path)
    try {
      if (db.prepare('PRAGMA p.journal_mode').get().journal_mode !== 'delete') throw new Error('Invalid project journal mode')
      db.exec('PRAGMA p.synchronous=EXTRA')
      // A crash before the first schema transaction leaves a private empty file.
      const version = db.prepare('PRAGMA p.user_version').get().user_version
      if (version === 0 && !db.prepare('SELECT 1 FROM p.sqlite_master LIMIT 1').get()) {
        assertWriteLock()
        db.exec('BEGIN IMMEDIATE')
        try {
          for (const statement of tables) db.exec(statement)
          db.exec('PRAGMA p.application_id=1146307152; PRAGMA p.user_version=1')
          assertWriteLock(); db.exec('COMMIT')
        } catch (error) { db.exec('ROLLBACK'); throw error }
      }
      if (db.prepare('PRAGMA p.application_id').get().application_id !== 1146307152 || db.prepare('PRAGMA p.user_version').get().user_version !== 1) throw new Error('Unknown project journal')
      if (fresh) syncDirectorySync(dirname(path))
      attached = true
      return true
    } catch (error) { db.exec('DETACH DATABASE p'); throw error }
  }
  open(false)
  const byRoom = room => open(false) && db.prepare('SELECT projects.* FROM p.projects AS projects JOIN p.rooms AS rooms ON rooms.project=projects.id WHERE rooms.room=?').get(room)
  const members = project => db.prepare('SELECT room FROM p.rooms WHERE project=? ORDER BY room').all(project).map(row => row.room)
  const visible = (room, revision) => db.prepare('SELECT e.body FROM p.audience a JOIN p.events e ON e.project=a.project AND e.revision=a.revision WHERE a.room=? AND a.revision=?').get(room, revision)
  const receipt = (operationId, room, actor) => attached && validId(operationId) && db.prepare('SELECT body,fingerprint FROM p.receipts WHERE operation=? AND room=? AND actor=?').get(operationId,room,actor)
  const getLink = taskId => attached && validId(taskId) && db.prepare('SELECT e.body FROM p.links l JOIN p.events e ON e.project=l.project AND e.revision=l.revision WHERE l.task=?').get(taskId)
  const existingLink = taskId => { const row = getLink(taskId); return row && JSON.parse(row.body) }
  const approvals = (row, actor, room) => db.prepare('SELECT a.room AS roomId,a.actor,a.at FROM p.acks a JOIN p.audience u ON u.room=a.room AND u.revision=a.revision WHERE u.project=? AND u.revision=? AND a.context=? AND (? OR a.room=?) ORDER BY a.at DESC').all(row.projectId,row.revision,'group',actor==='user'?1:0,room)
  function append(projectId, input) {
    const revision = db.prepare('UPDATE p.projects SET revision=revision+1 WHERE id=? RETURNING revision').get(projectId).revision
    const event = { ...input, projectId, revision, createdAt:Date.now() }
    db.prepare('INSERT INTO p.events VALUES(?,?,?)').run(projectId, revision, JSON.stringify(event))
    for (const task of new Set([event.taskId,event.parentTaskId,event.sourceTaskId].filter(Boolean))) {
      db.prepare('INSERT INTO p.task_events VALUES(?,?,?)').run(task,projectId,revision)
    }
    for (const room of event.audience) db.prepare('INSERT INTO p.audience VALUES(?,?,?)').run(room,revision,projectId)
    updates.push(event)
    return event
  }
  function write(operationId, room, actor, payload, perform) {
    if (!validId(operationId)) invalid('A stable operation ID is required')
    const fingerprint=createHash('sha256').update(JSON.stringify(payload)).digest('hex')
    return tx(() => {
      const old = receipt(operationId, room, actor)
      if (old?.fingerprint === fingerprint) return JSON.parse(old.body)
      if (db.prepare('SELECT 1 FROM p.receipts WHERE operation=?').get(operationId)) invalid('Project operation ID conflict')
      const event=perform()
      const value={projectId:event.projectId,revision:event.revision,operationId}
      db.prepare('INSERT INTO p.receipts VALUES(?,?,?,?,?)').run(operationId,room,actor,fingerprint,JSON.stringify(value))
      return value
    })
  }
  function bind(room, input, roster) {
    const { projectId, name,coordinatorRoomId,expectedRevision,operationId }=input
    if (!validId(projectId) || !text(name,160) || !roomIds(input.roomIds) || room!==coordinatorRoomId || !input.roomIds.includes(room)
      || !input.roomIds.every(id=>roster(id) || byRoom(id)?.id===projectId) || !Number.isSafeInteger(expectedRevision) || expectedRevision<0) invalid('Invalid project or coordinator group')
    const audience=[...input.roomIds].sort()
    open(true)
    return write(operationId,room,'user',['bind',projectId,name,room,audience,expectedRevision],()=>{
      const old = db.prepare('SELECT * FROM p.projects WHERE id=?').get(projectId)
      if ((old?.revision ?? 0)!==expectedRevision) invalid('Project revision changed; refresh the project board')
      if ((old && old.coordinator!==room) || members(projectId).some(id=>!audience.includes(id)) || audience.some(id=>{const p=byRoom(id); return p && p.id!==projectId})) invalid('A group already belongs to a different project or would lose its membership')
      if (old) db.prepare('UPDATE p.projects SET name=? WHERE id=?').run(name.trim(),projectId)
      else db.prepare('INSERT INTO p.projects VALUES(?,?,?,0)').run(projectId,name.trim(),room)
      for (const id of audience) db.prepare('INSERT OR IGNORE INTO p.rooms VALUES(?,?)').run(id,projectId)
      return append(projectId,{kind:'binding',actor:'user',originRoomId:room,summary:name.trim(),audience,operationId})
    })
  }
  function decide(room,actor,input,canShareTask) {
    const project=byRoom(room)
    if (!project || (actor!=='user' && project.coordinator!==room)) invalid('Project decision is unavailable in this group')
    const {expectedRevision,summary,resource,taskId,operationId}=input
    if (!roomIds(input.roomIds) || !text(summary,2000) || !text(resource,256) || !Number.isSafeInteger(expectedRevision)
      || (taskId!==undefined && !validId(taskId))) invalid('Invalid project decision')
    const audience=[...input.roomIds].sort()
    return write(operationId,room,actor,['decide',expectedRevision,summary,resource,taskId??null,audience],()=>{
      if (byRoom(room).revision!==expectedRevision) invalid('Project revision changed; refresh the project board')
      if (!audience.includes(room) || !audience.every(id=>byRoom(id)?.id===project.id)) invalid('Decision audience must include the submitting group and belong to this project')
      const task=taskId ? getTask(taskId) : undefined
      const origin=task?.scope?.startsWith('room:') ? task.scope.slice(5) : room
      const previous=taskId && existingLink(taskId)
      if (taskId && (!task || !audience.includes(origin) || !canShareTask(task,origin) || (previous && previous.projectId!==project.id)
        || (previous && !previous.audience.every(id=>audience.includes(id)))
        || (actor!=='user' && (!previous || !audience.every(id=>previous.audience.includes(id)))))) invalid('Only explicitly shared project tasks may be coordinated across groups')
      if (task && previous && previous.resource!==resource.trim()) invalid('Use the original project resource for this task')
      if (task) {
        const prior = db.prepare('SELECT task FROM p.claims WHERE project=? AND resource=?').get(project.id,resource.trim())
        if (prior && prior.task!==task.id) {
          const claimed=getTask(prior.task), source=existingLink(prior.task)
          if (claimed && !claimed.archivedAt && !['cancelled','done'].includes(claimed.status)) {
            const detail=source?.audience.includes(room) ? ' '+prior.task+' in group '+source.originRoomId : ''
            invalid('Resource already has an active task'+detail+'. Complete or cancel the original task before assigning another.')
          }
        }
        db.prepare('INSERT OR REPLACE INTO p.claims VALUES(?,?,?)').run(project.id,resource.trim(),task.id)
      }
      const event=append(project.id,{kind:'decision',actor,originRoomId:origin,summary:summary.trim(),resource:resource.trim(),audience,operationId,
        ...(task ? taskFields(task):{})})
      for (const id of audience) db.prepare('INSERT OR REPLACE INTO p.policies VALUES(?,?,?)').run(id,event.resource,event.revision)
      if (task) db.prepare('INSERT OR REPLACE INTO p.links VALUES(?,?,?)').run(taskId,project.id,event.revision)
      return event
    })
  }
  function taskFields(task) {
    const releaseId=task.releaseId ?? (task.parentTaskId && getTask(task.parentTaskId)?.releaseId) ?? null
    const release=releaseId && getRelease(releaseId)
    return {taskId:task.id,...(task.parentTaskId?{parentTaskId:task.parentTaskId}:{}),taskRevision:task.revision,
      owner:task.owner,reviewer:task.reviewer,status:task.status,stage:task.stage??null,releaseId,
      ...(release?{releaseVersion:release.version??null,releaseStatus:release.status}:{}),blocked:!!task.blocked,stale:!!task.stale}
  }
  // Called from task-store.save inside the source edit's transaction. Share the
  // routing facts and names of changed fields; freeform card/private chat text stays in its room.
  function taskChanged(before,after,audit) {
    if (!attached) return
    if (before?.parentTaskId && before.parentTaskId!==after.parentTaskId) {
      const previous=existingLink(before.parentTaskId)
      if (previous) {
        append(previous.projectId,{kind:'task',actor:audit.actor,originRoomId:previous.originRoomId,resource:previous.resource,
          summary:'Item moved off the original card',changedFields:['parentTaskId'],audience:previous.audience,
          operationId:audit.operationId,taskId:after.id,parentTaskId:before.parentTaskId,taskRevision:after.revision})
        db.prepare('DELETE FROM p.activity WHERE task=?').run(after.id)
      }
    }
    const original=existingLink(after.id)
    const link=original || existingLink(after.parentTaskId) || existingLink(after.change?.sourceTaskId)
    if (!link) return
    const fields=['title','description','owner','reviewer','acceptance','status','scope','stage','releaseId','progress','blocked','stale','archivedAt','dependencies','checklist','labels','dueDate','boardActivity']
    const changed=before ? [...fields,'parentTaskId'].filter(key=>!isDeepStrictEqual(before[key],after[key])) : ['created']
    if (!changed.length) return
    const origin=after.scope.startsWith('room:') ? after.scope.slice(5) : null
    if (original && !after.archivedAt && !['cancelled','done'].includes(after.status)) {
      const claim=db.prepare('SELECT task FROM p.claims WHERE project=? AND resource=?').get(link.projectId,link.resource)
      if (claim && claim.task!==after.id) invalid('The project resource has a different task claim; coordinate the transfer before reopening this task')
    }
    if (origin!==link.originRoomId) invalid('Moving a shared card requires a project decision')
    const event=append(link.projectId,{kind:'task',actor:audit.actor,originRoomId:origin,resource:link.resource,summary:'Original card updated: '+changed.join(', '),
      audience:link.audience,operationId:audit.operationId,changedFields:changed,...taskFields(after),
      ...(after.change?.sourceTaskId ? {sourceTaskId:after.change.sourceTaskId} : {})})
    db.prepare('INSERT OR REPLACE INTO p.activity VALUES(?,?,?)').run(after.id,link.projectId,event.revision)
    if (after.change?.sourceTaskId && !before) db.prepare('INSERT OR REPLACE INTO p.activity VALUES(?,?,?)').run(after.change.sourceTaskId,link.projectId,event.revision)
    if (original) db.prepare('UPDATE p.links SET revision=? WHERE task=?').run(event.revision,after.id)
    if (!['scheduler','user'].includes(audit.actor)) acknowledge(origin,audit.actor,event.revision,conversationKind(audit.actor))
  }
  function releaseChanged(before,after,audit) {
    if (!attached || !before) return
    const fields=['version','name','status'].filter(k=>!isDeepStrictEqual(before[k],after[k])).map(k=>'release.'+k)
    if (!fields.length) return
    const linked=db.prepare(`SELECT t.body FROM main.tasks t JOIN p.links l ON l.task=t.id
      WHERE json_extract(t.body,'$.releaseId')=? OR json_extract(t.body,'$.parentTaskId') IN
      (SELECT id FROM main.tasks WHERE json_extract(body,'$.releaseId')=?)`).all(after.id,after.id)
    for (const row of linked) {
      const task=JSON.parse(row.body), link=existingLink(task.id)
      const event=append(link.projectId,{kind:'task',actor:audit?.actor??'scheduler',originRoomId:link.originRoomId,resource:link.resource,
        summary:'Original release updated: '+fields.join(', '),changedFields:fields,audience:link.audience,
        operationId:audit?.operationId??('release:'+after.id+':'+after.revision),...taskFields(task)})
      db.prepare('INSERT OR REPLACE INTO p.activity VALUES(?,?,?)').run(task.id,link.projectId,event.revision)
    }
  }
  function acknowledge(room,actor,revision,context='group') {
    if (!attached || !Number.isSafeInteger(revision) || !visible(room,revision)) invalid('Project change is unavailable in this group')
    return tx(()=>{
      db.prepare('INSERT OR IGNORE INTO p.acks VALUES(?,?,?,?,?)').run(room,revision,actor,context,Date.now())
      return {roomId:room,revision,actor,context}
    })
  }
  function view(room,actor,{beforeRevision,operationId}={}) {
    const project=byRoom(room)
    const saved=operationId===undefined ? undefined : receipt(operationId,room,actor)
    const response={project:null,events:[],...(operationId!==undefined?{receipt:saved ? JSON.parse(saved.body):null}:{})}
    if (!project) return response
    if (beforeRevision!==undefined && (!Number.isSafeInteger(beforeRevision) || beforeRevision<=0)) invalid('Invalid project history cursor')
    response.project={id:project.id,name:project.name,revision:project.revision,coordinatorRoomId:project.coordinator,roomIds:members(project.id)}
    const rows=db.prepare('SELECT e.body FROM p.audience a JOIN p.events e ON e.project=a.project AND e.revision=a.revision WHERE a.room=? AND a.revision<? ORDER BY a.revision DESC LIMIT ?').all(room,beforeRevision??Number.MAX_SAFE_INTEGER,PAGE+1)
    response.events=rows.slice(0,PAGE).map(r=>{const e=JSON.parse(r.body);return {...e,acknowledgements:approvals(e,actor,room)}})
    if(rows.length>PAGE) response.nextBeforeRevision=response.events.at(-1).revision
    return response
  }
  function pending(room, actor, administrator, limit=4) {
    const project=byRoom(room)
    if(!project) return null
    const rows=db.prepare(`SELECT e.body FROM p.audience a JOIN p.events e ON e.project=a.project AND e.revision=a.revision
      WHERE a.room=? AND NOT EXISTS (SELECT 1 FROM p.acks k WHERE k.room=a.room AND k.revision=a.revision AND k.actor=? AND k.context='group')
      AND (CASE json_extract(e.body,'$.kind')
        WHEN 'binding' THEN ? AND a.revision=(SELECT max(x.revision) FROM p.events x WHERE x.project=a.project AND json_extract(x.body,'$.kind')='binding')
        WHEN 'decision' THEN EXISTS (SELECT 1 FROM p.policies k WHERE k.room=a.room AND k.revision=a.revision)
          AND (? OR json_extract(e.body,'$.owner')=? OR json_extract(e.body,'$.reviewer')=?)
        ELSE EXISTS (SELECT 1 FROM p.activity t WHERE t.project=a.project AND t.revision=a.revision)
          AND (json_extract(e.body,'$.owner')=? OR json_extract(e.body,'$.reviewer')=? OR (? AND (json_extract(e.body,'$.blocked')=1 OR json_extract(e.body,'$.stale')=1)))
       END)
      ORDER BY a.revision LIMIT ?`).all(room,actor,+administrator,+administrator,actor,actor,actor,actor,+administrator,limit)
    const policies=db.prepare('SELECT e.body FROM p.policies k JOIN p.events e ON e.project=? AND e.revision=k.revision WHERE k.room=? ORDER BY k.revision DESC LIMIT 4').all(project.id,room)
    return {id:project.id,revision:project.revision,events:rows.map(r=>JSON.parse(r.body)),policies:policies.map(r=>JSON.parse(r.body))}
  }
  function taskHistory(room,taskId) {
    const project=byRoom(room)
    if (!project) return []
    const rows=db.prepare(`SELECT e.body FROM p.task_events t JOIN p.audience a ON a.project=t.project AND a.revision=t.revision
      JOIN p.events e ON e.project=t.project AND e.revision=t.revision WHERE t.task=? AND t.project=? AND a.room=?
      ORDER BY t.revision DESC LIMIT ?`).all(taskId,project.id,room,PAGE)
    return rows.map(r=>{const e=JSON.parse(r.body);return {...e,acknowledgements:approvals(e,'user',room)}})
  }
  function requireAcknowledged(task,actor) {
    if (!attached || !task?.scope?.startsWith('room:')) return
    const room=task.scope.slice(5)
    const revisions=new Set()
    const activity=db.prepare('SELECT revision FROM p.activity WHERE task=?').get(task.id)
    if (activity && visible(room,activity.revision)) revisions.add(activity.revision)
    for (const id of [task.id,task.parentTaskId,task.change?.sourceTaskId]) {
      const link=existingLink(id)
      if (!link) continue
      const policy=db.prepare('SELECT revision FROM p.policies WHERE room=? AND resource=?').get(room,link.resource)
      if (policy) revisions.add(policy.revision)
      revisions.add(link.revision)
    }
    for (const revision of revisions) {
        if (!db.prepare("SELECT 1 FROM p.acks WHERE room=? AND revision=? AND actor=? AND (context='group' OR context=?)").get(room,revision,actor,conversationKind(actor))) {
          invalid('Read and acknowledge project_coordination revision '+revision+' for the original task before changing it in room '+room)
        }
    }
  }
  // Tool scoping runs on every roster save and model assembly. Cache only the
  // board-side roster; live group membership is checked independently per session.
  function privateRooms() {
    if (taskParticipants) return taskParticipants
    const map=new Map()
    if (attached) {
      for (const row of db.prepare('SELECT room FROM p.rooms').all()) map.set(row.room,new Set())
      const rows=db.prepare(`SELECT t.body FROM main.tasks t WHERE
        EXISTS (SELECT 1 FROM p.links l WHERE l.task IN (t.id,json_extract(t.body,'$.parentTaskId'),json_extract(t.body,'$.change.sourceTaskId')))`).all()
      for (const row of rows) {
        const task=JSON.parse(row.body)
        if (task.archivedAt || ['done','cancelled'].includes(task.status) || !task.scope?.startsWith('room:')) continue
        const roles=map.get(task.scope.slice(5))
        if (roles) { roles.add(task.owner); roles.add(task.reviewer) }
      }
    }
    taskParticipants=map
    return map
  }
  function assertIdentity() {
    if (!attached && !open(false)) return
    const now=stat()
    if(!now || now.dev!==identity.dev || now.ino!==identity.ino || !isPrivateFile(path,now)) throw new Error('Project journal identity changed')
  }
  return {bind,decide,view,pending,privateRooms,taskHistory,acknowledge,requireAcknowledged,taskChanged,releaseChanged,existingLink,assertIdentity,
    begin(){updates=[]},committed(){
      const events=updates;updates=[]
      if (events.some(projectRolesChanged)) taskParticipants=undefined
      for(const event of events) onCommit?.(event)
    }}
}

export function installProjectCoordination(rt, {defineTool, store, run, availableStore=store}) {
  const registry = () => store().projectCoordination
  const rooms = () => Object.values(rt.state.rooms ?? {})
  const roomInfo = id => ({id,name:rt.roomOf(id)?.name || id})
  const isMember = (room,actor) => !!room && room.members?.includes(actor) && !!rt.botOf(actor) && rt.botOf(actor).private !== true
  function available(sid, roomId) {
    const actor=rt.selfOf(sid)
    if (!actor) return false
    const binding=rt.groupOwners?.get(sid)
    const scope=availableStore()?.projectCoordination.privateRooms()
    if (!scope?.size) return false
    if (binding) {
      const room=rt.roomOf(binding.roomId)
      return binding.botId===actor && isMember(room,actor) && room.sessions?.[actor]===sid
        && scope.has(room.id) && (roomId===undefined || room.id===roomId)
    }
    if (rt.chatOf?.(actor)!==sid && rt.chatOwners?.get(sid)!==actor) return false
    for (const [id,roles] of scope) {
      if (roomId!==undefined && roomId!==id) continue
      const room=rt.roomOf(id)
      if (isMember(room,actor) && (rt.isAdminOf?.(room,actor) || roles.has(actor))) return true
    }
    return false
  }
  rt.projectToolAvailable=available
  function view(room,actor,args) {
    const response=registry().view(room.id,actor,args)
    if (response.project) {
      response.project.rooms=response.project.roomIds.map(roomInfo)
      delete response.project.roomIds
    }
    if (actor==='user') response.availableRooms=rooms().map(r=>roomInfo(r.id))
    return response
  }
  const shareAllowed = (actor,sourceRoom,task,origin) => {
    const source=rt.roomOf(origin)
    return source && [task.owner,task.reviewer].every(id=>id==='user' || isMember(source,id))
      && (actor==='user' || (sourceRoom.id===source.id && isMember(source,actor)))
  }
  function decide(room,actor,input) {
    if(actor!=='user' && !rt.isAdminOf?.(room,actor)) invalid('Only the coordinating group administrator can publish a project decision')
    if(!roomIds(input.roomIds) || !input.roomIds.every(id=>rt.roomOf(id))) invalid('Decision audience contains an unavailable group')
    return registry().decide(room.id,actor,input,(task,origin)=>shareAllowed(actor,room,task,origin))
  }
  function userCall(endpoint,input) {
    const room=input.scope?.kind==='room' && rt.roomOf(input.scope.id)
    if(!room) invalid('Select an existing group board')
    if(endpoint==='board-project') return view(room,'user',input)
    if(endpoint==='board-project-bind') return registry().bind(room.id,input,id=>!!rt.roomOf(id))
    return decide(room,'user',input)
  }
  function prompt(room,member) {
    if(!isMember(room,member.id)) return ''
    const state=availableStore()?.projectCoordination.pending(room.id,member.id,!!rt.isAdminOf?.(room,member.id))
    if(!state) return ''
    let header='Shared project '+JSON.stringify(state.id)+', current revision '+state.revision+'. This group owns its own release. Check the original task and project decision before shared work; keep one task ID and return progress, blockers and receipts on that task.'
    if (state.policies.length) header+=' Current decisions: '+state.policies.map(e=>JSON.stringify({revision:e.revision,resource:e.resource,summary:e.summary.slice(0,240)})).join(' ')
    if (!state.events.length) return header
    const pending=state.events.map(({revision,kind,resource,taskId,summary})=>JSON.stringify({revision,kind,resource,taskId,summary:summary.slice(0,380)}))
    return header+' Read the pending changes with project_coordination show, adjust the affected work, then acknowledge each exact revision. Shared decisions do not authorize unrelated work.\n'+pending.join('\n')
  }
  rt.teamTools.push(defineTool({
    name:'project_coordination',
    description:'Read this project’s shared decisions and source task receipts. Acknowledge an exact change after reading it and adjusting affected work. Only the coordinating group administrator publishes decisions. The user explicitly binds groups and links original tasks on the board; do not copy tasks or dispatch new work here.',
    parameters:{
      action:{type:'string',required:true,enum:['show','ack','decide']},
      room_id:{type:'string',description:'Original group ID in an assigned private chat. Group sessions operate within their own group.'},
      revision:{type:'integer',description:'Exact event to read or acknowledge'},
      before_revision:{type:'integer',description:'Next history page cursor from show'},
      expected_revision:{type:'integer',description:'Current project revision from show, required to publish'},
      operation_id:{type:'string',description:'Stable ID for a decision or its receipt lookup'},
      room_ids:{type:'array',items:{type:'string'},description:'Affected project groups, including the coordinating group'},
      resource:{type:'string',description:'Shared project resource, for example repository, ref and file'},
      summary:{type:'string',description:'Decision, version, responsible group, and when work may proceed'},
      task_id:{type:'string',description:'Original task explicitly linked by the user'},
    },
    output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:String(value)}]},
    execute(args,exec) { return run(()=>{
      const sid=exec?.agent?.id, actor=rt.selfOf(sid)
      const binding=rt.groupOwners?.get(sid)
      const source=binding?.roomId
      if (source && (binding.botId!==actor || rt.roomOf(source)?.sessions?.[actor]!==sid)) invalid('Project coordination requires the current group member session')
      if (!source && (!actor || (rt.chatOf?.(actor)!==sid && rt.chatOwners?.get(sid)!==actor))) invalid('Project coordination requires an identified session')
      if (source && args.room_id!==undefined && args.room_id!==source) invalid('Open the target group to coordinate its work')
      const room=rt.roomOf(source ?? args.room_id)
      if (!isMember(room,actor) || !available(sid,room.id)) invalid('Project coordination is unavailable in this group')
      if (args.action==='show') {
        const data=view(room,actor,{operationId:args.operation_id,beforeRevision:args.revision===undefined?args.before_revision:args.revision+1})
        if(args.revision!==undefined) data.events=data.events.filter(e=>e.revision===args.revision)
        return JSON.stringify(data)
      }
      if (args.action==='ack') return JSON.stringify(registry().acknowledge(room.id,actor,args.revision,source?'group':'private'))
      if (args.action!=='decide' || source!==room.id) invalid('Publish project decisions in the coordinating group')
      return JSON.stringify(decide(room,actor,{operationId:args.operation_id,expectedRevision:args.expected_revision,roomIds:args.room_ids,summary:args.summary,resource:args.resource,taskId:args.task_id}))
    })},
  }))
  return {userCall,prompt}
}
