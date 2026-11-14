import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'

// Host-owned authority over user-created tasks. A binding captures the actual
// workspace directory at creation; a renamed, replaced, or removed workspace
// cannot silently inherit that grant. The cooperative gate remains necessary.
export function createTaskHostAuthority({rt,assertLease}) {
  if (!rt?.ctx?.workspaceRegistry || typeof assertLease !== 'function') throw Error('workspace authority unavailable')
  const roster=(task,actor)=>{
    if (actor !== task.owner && actor !== task.reviewer) return false
    if (actor === 'user') return actor===task.reviewer
    const bot=rt.botOf?.(actor)
    if (!bot) return false
    if (task.scope?.startsWith('room:')) {
      const room=rt.roomOf?.(task.scope.slice(5))
      return !!room && Array.isArray(room.members) && room.members.includes(actor) && bot.private!==true
        && rt.goalDispatchBlocked?.(room,actor)===false
    }
    return task.scope===`personal:${task.owner}`
  }
  const workspace=execution=>{
    assertLease()
    const item=rt.ctx.workspaceRegistry.get(execution?.workspace)
    if (!item || item.id!==execution.workspace || typeof item.path!=='string' || !isAbsolute(item.path)) throw Error('workspace unavailable')
    const path=realpathSync(item.path), s=statSync(path)
    if (path!==item.path || !s.isDirectory()) throw Error('workspace changed')
    return {workspaceId:item.id,path,dev:String(s.dev),ino:String(s.ino)}
  }
  const capture=(task,execution,actor)=>{
    if(actor!=='user'||task.owner==='user'||!roster(task,task.owner)||!roster(task,task.reviewer)) throw Error('task participants unavailable')
    return workspace(execution)
  }
  const verify=task=>{
    try {
      if(task?.authority?.kind!=='user-created'||!task.authority.binding||!roster(task,task.owner)||!roster(task,task.reviewer))return false
      const now=workspace(task.execution),before=task.authority.binding
      return now.workspaceId===before.workspaceId&&now.path===before.path&&now.dev===before.dev&&now.ino===before.ino
    }catch{return false}
  }
  const target=(action,task)=>{
    try {
      if(!verify(task)||action?.actor==='user'||!roster(task,action.actor))return undefined
      const sid=task.scope.startsWith('room:') ? rt.roomOf(task.scope.slice(5))?.sessions?.[action.actor] : rt.chatOf?.(action.actor)
      if(typeof sid!=='string'||!sid)return undefined
      const membership=task.scope.startsWith('room:') ? rt.groupOwners?.get(sid) : rt.chatOwners?.get(sid)
      if(task.scope.startsWith('room:') ? membership?.botId!==action.actor||membership?.roomId!==task.scope.slice(5) : membership!==action.actor)return undefined
      const ws=rt.ctx.workspaceRegistry.get(task.execution.workspace)
      if(!Array.isArray(ws?.sessionIds)||!ws.sessionIds.includes(sid))return undefined
      return {botId:action.actor,sessionId:sid}
    }catch{return undefined}
  }
  const within=(candidate,base)=>{
    const suffix=relative(base,candidate)
    return suffix==='' || (!isAbsolute(suffix) && suffix!=='..' && !suffix.startsWith(`..${sep}`))
  }
  const evidenceFile=(task,description)=>{
    const match=typeof description==='string'&&/^sha256:([0-9a-f]{64}):(.+)$/.exec(description)
    if(!match)return false
    const path=match[2]
    if(isAbsolute(path)||path.split('/').some(part=>!part||part==='.'||part==='..'))return false
    const root=task.authority.binding.path,full=resolve(root,path),actual=realpathSync(full)
    if(!within(actual,root)||!task.execution.paths.some(scope=>scope==='.'||within(actual,resolve(root,scope))))return false
    const fd=openSync(actual,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK)
    try {
      const before=fstatSync(fd)
      if(!before.isFile()||before.size>1024*1024)return false
      const bytes=readFileSync(fd),after=fstatSync(fd)
      return before.dev===after.dev&&before.ino===after.ino&&before.size===after.size&&before.mtimeMs===after.mtimeMs
        && createHash('sha256').update(bytes).digest('hex')===match[1]
    }finally{closeSync(fd)}
  }
  // The host proves that evidence names the expected bytes. Acceptance of
  // their meaning remains the responsibility of the independent reviewer.
  const verifyEvidence=(task,value,actor,phase)=>{
    try {
      if(!verify(task)||!roster(task,actor))return false
      if(phase==='report')return value?.kind==='personal'&&evidenceFile(task,value.evidence)
      return phase==='review'&&actor===task.reviewer&&task.evidence?.kind==='personal'
        && evidenceFile(task,task.evidence.evidence)&&evidenceFile(task,value?.evidence)
    }catch{return false}
  }
  return {capture,verify,target,verifyEvidence}
}
