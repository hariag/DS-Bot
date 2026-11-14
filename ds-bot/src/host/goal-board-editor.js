import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { dirname } from 'node:path'
import { legacyGoalCards } from './legacy-goal.js'
import { taskGoal, touchGoal } from './goals.js'

const invalid = message => Object.assign(new Error(message), { code:'bot/invalid' })
const scopeKey = scope => JSON.stringify([scope?.kind,scope?.id])
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const validId = value => typeof value==='string' && value.length>0 && value.length<=256 && !/[\x00-\x1f]/.test(value)
const own = (value,key) => value && Object.hasOwn(value,key)
const MAX_OPERATIONS = 10000

// Goal edits and their operation receipts live in the same state.json snapshot.
// The client must never treat an in-flight or failed save as a rejection.
export function createGoalBoardEditor(rt) {
  const inflight=new Map()
  const records=()=>{
    const state=rt.state
    if(state.goalBoardOperations===undefined)state.goalBoardOperations={}
    if(!state.goalBoardOperations || typeof state.goalBoardOperations!=='object' || Array.isArray(state.goalBoardOperations))throw invalid('Goal edit history is unavailable')
    return state.goalBoardOperations
  }
  const durable=async(id,record)=>{
    const lease=rt.homeLockVersion()
    const file=await open(rt.statePath,constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      const before=await file.stat()
      if(!before.isFile())throw new Error('Goal state is unavailable')
      const saved=JSON.parse(await file.readFile('utf8'))?.goalBoardOperations?.[id]
      if(JSON.stringify(saved)!==JSON.stringify(record))throw new Error('Goal operation is not in the current state')
      await file.sync()
      const directory=await open(dirname(rt.statePath),constants.O_RDONLY)
      try {await directory.sync()} finally {await directory.close()}
      const afterFile=await file.stat()
      const after=await lstat(rt.statePath)
      if(!after.isFile()||after.isSymbolicLink()||before.dev!==after.dev||before.ino!==after.ino
        ||before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.size!==afterFile.size||before.mtimeMs!==afterFile.mtimeMs
        ||rt.homeLockVersion()!==lease)throw new Error('Goal state changed during confirmation')
    } finally {await file.close()}
  }
  const operation=async(scope,id)=>{
    if(!validId(id)||!id.startsWith('goal:'))return {state:'unknown'}
    const pending=inflight.get(id)
    if(pending?.working)return {state:'unknown'}
    const record=records()[id]
    if(!record || record.scope!==scopeKey(scope))return {state:'unknown'}
    try {await durable(id,record)} catch {return {state:'unknown'}}
    if(records()[id]!==record)return {state:'unknown'}
    inflight.delete(id)
    return record.state==='committed' ? {state:'committed',result:record.result} : {state:'rejected',message:record.message}
  }
  const execute=async(scope,id,request,apply)=>{
    if(!validId(id)||!id.startsWith('goal:'))throw invalid('Invalid goal edit operation')
    rt.requireHomeLock()
    const key=scopeKey(scope),fingerprint=request===null?'!cancelled':hash(request),history=records(),previous=history[id]
    const pending=inflight.get(id)
    if(pending)return {state:'unknown'}
    if(previous) {
      if(previous.scope!==key || (previous.fingerprint!=='!cancelled' && previous.fingerprint!==fingerprint))throw invalid('Operation ID was already used')
      return operation(scope,id)
    }
    if(Object.keys(history).length>=MAX_OPERATIONS)throw invalid('Goal edit history is full')
    let record
    try {record={scope:key,fingerprint,state:'committed',result:apply()}}
    catch(error) {
      if(error?.code!=='bot/invalid')throw error
      record={scope:key,fingerprint,state:'rejected',message:String(error.message).slice(0,500)}
    }
    history[id]=record
    inflight.set(id,{scope:key,working:true})
    try {
      await rt.save({required:true})
      await durable(id,record)
      if(records()[id]!==record)throw new Error('Goal edit outcome is uncertain')
      inflight.delete(id)
      return record.state==='committed'?{state:'committed',result:record.result}:{state:'rejected',message:record.message}
    } catch(error) {
      // Keep this ID fenced in memory until restart or explicit investigation.
      inflight.set(id,{scope:key,working:false})
      rt.warn?.('ds-bot: goal board edit outcome uncertain: %s',error?.message||'unknown error')
      return {state:'unknown'}
    }
  }
  const cancel=async(scope,id)=>{
    const prior=await operation(scope,id)
    if(prior.state!=='unknown'||inflight.has(id))return prior
    return execute(scope,id,null,()=>{throw invalid('The pending goal edit was safely cancelled')})
  }
  const prior=async(scope,id,request)=>{
    if(!validId(id)||!id.startsWith('goal:'))throw invalid('Invalid goal edit operation')
    const record=records()[id]
    if(!record&&!inflight.has(id))return undefined
    if(record && (record.scope!==scopeKey(scope) || (record.fingerprint!=='!cancelled'&&record.fingerprint!==hash(request))))throw invalid('Operation ID was already used')
    return operation(scope,id)
  }
  const lookup=(scope,taskId,revision)=>{
    if(!validId(taskId)||!Number.isSafeInteger(revision)||revision<0)throw invalid('Invalid goal task revision')
    const cards=legacyGoalCards({scope,principal:{kind:'user'},rooms:rt.state.rooms,bots:rt.state.bots}).filter(card=>card.id===taskId)
    if(cards.length!==1)throw invalid('Goal task changed or is unavailable; refresh the board')
    const card=cards[0],room=rt.roomOf(card.originRoomId),goal=room?.goal,stage=goal?.stages?.[goal.current]
    const tasks=stage?.tasks?.filter(task=>task.id===card.legacy.taskId) ?? []
    if(!room||!goal||goal.id!==card.legacy.goalId||stage?.id!==card.legacy.stageId||goal.revision!==revision||tasks.length!==1)throw invalid('Goal task changed; refresh the board')
    return {card,room,goal,stage,task:tasks[0]}
  }
  // Validate and stage on a clone, then update the original task and goal
  // synchronously so other Goal users keep their existing object identities.
  const mutate=(scope,payload,kind,images)=>{
    const {card,room,goal,stage,task}=lookup(scope,payload.taskId,payload.expectedRevision)
    const clone=structuredClone(goal),shadow={...room,goal:clone},nextStage=clone.stages[clone.current]
    const next=nextStage.tasks.find(item=>item.id===task.id),now=Date.now()
    if(kind==='edit') {
      const value=payload.value
      if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!['title','note','status'].includes(k)))throw invalid('Invalid goal task edit')
      const title=own(value,'title')?value.title:task.task,note=own(value,'note')?value.note:undefined,status=own(value,'status')?value.status:undefined
      if(typeof title!=='string'||!title.trim()||title.trim().length>500)throw invalid('Task description must be 1–500 characters')
      if(note!==undefined&&(typeof note!=='string'||note.length>300))throw invalid('Note must be at most 300 characters')
      const changedTitle=title.trim()!==task.task
      if(changedTitle&&['reported','done'].includes(task.status))throw invalid('This task was reported or completed. Reconcile or reopen it before changing its description.')
      if(status!==undefined&&status!==task.status) {
        if(goal.status!=='active'||!({pending:'working',working:'reported'})[task.status]||({pending:'working',working:'reported'})[task.status]!==status)throw invalid('This status change requires the group goal rework or review workflow.')
        if(typeof note!=='string'||!note.trim())throw invalid('Add a note explaining the status change')
      }
      if(changedTitle&&typeof next.note==='string'&&next.note) {
        const prior={text:next.note,...(typeof next.noteStatus==='string'?{status:next.noteStatus}:{}),...(Number.isSafeInteger(next.noteStatusVersion)?{statusVersion:next.noteStatusVersion}:{}),...(Number.isFinite(next.noteAt)?{at:next.noteAt}:{}),supersededAt:now}
        next.noteHistory=[...(Array.isArray(next.noteHistory)?next.noteHistory.slice(-4):[]),prior]
        for(const field of ['note','noteStatus','noteStatusVersion','noteAt'])delete next[field]
      }
      next.task=title.trim()
      const taskChanged=status!==undefined&&status!==task.status
      const noteChanged=note!==undefined&&(note!==(task.note??'')||taskChanged||changedTitle)
      if(!changedTitle&&!taskChanged&&!noteChanged)throw invalid('No changes to save')
      if(taskChanged||noteChanged) {
        if(goal.status!=='active')throw invalid('A paused goal cannot change task progress or notes')
        if(nextStage.tasks.filter(item=>item.botId===task.botId).length!==1)throw invalid('This owner has multiple tasks; change them in the group goal')
        if(noteChanged&&note===''&&typeof next.note==='string'&&next.note) {
          const prior={text:next.note,...(typeof next.noteStatus==='string'?{status:next.noteStatus}:{}),...(Number.isSafeInteger(next.noteStatusVersion)?{statusVersion:next.noteStatusVersion}:{}),...(Number.isFinite(next.noteAt)?{at:next.noteAt}:{}),supersededAt:now}
          next.noteHistory=[...(Array.isArray(next.noteHistory)?next.noteHistory.slice(-4):[]),prior]
          for(const field of ['note','noteStatus','noteStatusVersion','noteAt'])delete next[field]
        }
        const result=taskChanged || (noteChanged&&note!=='')
          ? taskGoal(shadow,{stage:clone.current+1,bot:task.botId,...(taskChanged?{status}:{}),...(noteChanged&&note!==''?{note}: {})},'user',id=>id===task.botId&&room.members?.includes(id)?{id}:undefined,[],now)
          : (touchGoal(clone,{kind:'board-task-edit',by:'user',stage:stage.id,taskId:task.id,botId:task.botId},now,{keepNudges:true}),{})
        if(result.error)throw invalid(result.error)
      } else touchGoal(clone,{kind:'board-task-edit',by:'user',stage:stage.id,taskId:task.id,botId:task.botId},now,{keepNudges:true})
      if(changedTitle&&(taskChanged||noteChanged))clone.events=[...(clone.events??[]),{at:now,kind:'board-task-edit',by:'user',stage:stage.id,taskId:task.id,botId:task.botId}].slice(-50)
    } else if(kind==='attach') {
      if(!Array.isArray(images)||!images.length||images.length>10)throw invalid('Choose 1 to 10 images')
      const existing=Array.isArray(next.boardImages)?next.boardImages:[]
      if(existing.length+images.length>20||new Set([...existing,...images].map(image=>image.id)).size!==existing.length+images.length)throw invalid('Too many images or duplicate upload ID')
      next.boardImages=[...existing,...images]
      touchGoal(clone,{kind:'board-task-image',by:'user',stage:stage.id,taskId:task.id,botId:task.botId,text:'images added'},now,{keepNudges:true})
    } else if(kind==='remove-image') {
      const id=payload.value?.imageId,existing=Array.isArray(next.boardImages)?next.boardImages:[]
      if(!validId(id)||!existing.some(image=>image.id===id))throw invalid('Image is unavailable')
      next.boardImages=existing.filter(image=>image.id!==id)
      touchGoal(clone,{kind:'board-task-image',by:'user',stage:stage.id,taskId:task.id,botId:task.botId,text:'image removed'},now,{keepNudges:true})
    } else throw invalid('Unsupported goal task action')
    if(rt.roomOf(card.originRoomId)!==room||room.goal!==goal||goal.revision!==payload.expectedRevision)throw invalid('Goal task changed; refresh the board')
    for(const key of Object.keys(task))delete task[key]
    Object.assign(task,next)
    goal.revision=clone.revision;goal.updatedAt=clone.updatedAt;goal.events=clone.events
    if(own(clone,'idleRevision'))goal.idleRevision=clone.idleRevision
    return {taskId:card.id,revision:goal.revision}
  }
  const imageReference=(scope,taskId,imageId)=>{
    const cards=legacyGoalCards({scope,principal:{kind:'user'},rooms:rt.state.rooms,bots:rt.state.bots}).filter(card=>card.id===taskId)
    if(cards.length!==1||!validId(imageId))throw invalid('Image is unavailable')
    const card=cards[0],room=rt.roomOf(card.originRoomId)
    const goals=[...(Array.isArray(room?.pastGoals)?room.pastGoals:[]),room?.goal].filter(goal=>goal?.id===card.legacy.goalId)
    if(goals.length!==1)throw invalid('Image is unavailable')
    const stages=(goals[0].stages??[]).filter(stage=>stage?.id===card.legacy.stageId)
    const tasks=stages.length===1?(stages[0].tasks??[]).filter(task=>task?.id===card.legacy.taskId):[]
    const reference=tasks.length===1?tasks[0].boardImages?.find(item=>item?.id===imageId):undefined
    if(!reference)throw invalid('Image is unavailable')
    return {taskId,reference}
  }
  return {operation,execute,cancel,prior,mutate,lookup,imageReference}
}
