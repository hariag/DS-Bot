import { createHash } from 'node:crypto'

const own = (table, key) => table && Object.hasOwn(table, key) ? table[key] : undefined
const keyOf = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const statuses = new Map([['pending','legacy-pending'],['working','working'],['reported','reported'],['done','legacy-done']])

// This identifies the original goal task across edits; it is not a second
// task registration and cannot confer permission by itself.
export const legacyGoalCardId = (roomId, goalId, stageId, taskId) => `legacy-${keyOf([roomId,goalId,stageId,taskId])}`
export function legacyGoalCards({ scope, principal, rooms = {}, bots = {}, pendingCard }) {
  if (!scope || !principal) return []
  if (principal.kind === 'bot' && scope.kind === 'personal' && scope.id !== principal.id) return []
  const selected = scope.kind === 'room' ? [[scope.id, own(rooms, scope.id)]]
    : scope.kind === 'personal' && scope.id !== 'user' && own(bots, scope.id)
      ? Object.entries(rooms).filter(([, room]) => room.members?.includes(scope.id)) : []
  const cards = []
  for (const [roomId, room] of selected) {
    if (!room || (principal.kind === 'bot' && !room.members?.includes(principal.id))) continue
    if (principal.kind !== 'user' && principal.kind !== 'bot') continue
    const goals=[...(Array.isArray(room.pastGoals)?room.pastGoals:[]),room.goal].filter(Boolean)
    for (const goal of goals) {
      if(typeof goal.id!=='string'||!Number.isSafeInteger(goal.current)||!Array.isArray(goal.stages))continue
      const liveStages = goal.stages.map((stage,index) => ({stage,index,retired:false}))
      const retiredStages = (Array.isArray(goal.retiredGoalTasks) ? goal.retiredGoalTasks : [])
        .filter(row => row?.stage && row?.task).map(row => ({stage:{...row.stage,tasks:[row.task]},index:-1,retired:true}))
      for (const {stage,index:stageIndex,retired} of [...liveStages,...retiredStages]) {
        if (!stage || typeof stage.id !== 'string' || !Array.isArray(stage.tasks)) continue
        for (const [taskIndex,task] of stage.tasks.entries()) {
      if (!task || typeof task.id !== 'string' || typeof task.botId !== 'string' || typeof task.task !== 'string') continue
      if (scope.kind === 'personal' && task.botId !== scope.id) continue
      const stableId=legacyGoalCardId(roomId,goal.id,stage.id,task.id)
      const pending=pendingCard?.(stableId)
      const saved=pending ? pending.previous : own(goal.boardCards,stableId)
      const validSaved=saved===undefined || (saved && typeof saved==='object' && !Array.isArray(saved)
        && saved.roomId===roomId && saved.goalId===goal.id && saved.stageId===stage.id && saved.taskId===task.id
        && Number.isSafeInteger(saved.revision) && saved.revision>=1 && Array.isArray(saved.audit)
        && (saved.details===undefined || (saved.details && typeof saved.details==='object' && !Array.isArray(saved.details)))
        && ['comments','images','hiddenImages'].every(key=>saved[key]===undefined || Array.isArray(saved[key])))
      const ambiguous=stage.tasks.filter(item=>item?.id===task.id).length!==1
        || (!retired && goal.stages.filter(item=>item?.id===stage.id).length!==1)
        || (retired && (goal.stages.some(item=>item?.id===stage.id && item.tasks?.some(t=>t?.id===task.id))
          || retiredStages.filter(item=>item.stage.id===stage.id && item.stage.tasks[0]?.id===task.id).length!==1))
        || goals.filter(item=>item?.id===goal.id).length!==1 || !validSaved
      const overlay=validSaved && saved ? saved : undefined
      const isCurrent=!retired && goal===room.goal && stageIndex===goal.current && ['active','paused'].includes(goal.status)
      const position=retired || goal!==room.goal?'archived':stageIndex<goal.current?'previous':stageIndex>goal.current?'future':isCurrent?'current':'closed'
      const details={...(task.boardDetails??{}),...(overlay?.details??{})}
      const hidden=Array.isArray(overlay?.hiddenImages)?overlay.hiddenImages:[]
      const images=[...(Array.isArray(task.boardImages)?task.boardImages:[]),...(Array.isArray(overlay?.images)?overlay.images:[])]
        .filter(image=>image && typeof image.id==='string' && !hidden.includes(image.id))
      const status = task.status==='pending' && stageIndex>goal.current ? 'waiting' : statuses.get(task.status) ?? 'legacy-unverified'
      // The retained goal event buffer predates goalBoardReplies. Project only
      // events bound to this unambiguous original identity; it is not an audit
      // ledger and may already have evicted older events.
      const events = ambiguous ? [] : (Array.isArray(goal.events) ? goal.events : []).filter(event =>
        event?.kind === 'task' && event.stage === stage.id && event.taskId === task.id && event.botId === task.botId
        && Number.isFinite(event.at) && typeof event.by === 'string' && typeof event.text === 'string'
        && statuses.has(event.fromStatus) && statuses.has(event.toStatus))
      const replies=Array.isArray(task.goalBoardReplies)?task.goalBoardReplies:[]
      const usedReplies=new Set(), counts=new Map()
      const historical=events.flatMap(event=>{
        const prefix=`[group_goal ${event.toStatus}] `
        const match=replies.findIndex((reply,index)=>!usedReplies.has(index) && reply?.workflowAction==='goal-update'
          && reply.at===event.at && reply.author===event.by && (reply.text===prefix+event.text
            || (event.text===event.toStatus && reply.text===prefix+'Status updated')
            || (event.text==='' && reply.text===prefix+'Note cleared')))
        if(match!==-1){usedReplies.add(match);return []}
        const hash=keyOf([goal.id,stage.id,task.id,event]), n=counts.get(hash)??0
        counts.set(hash,n+1)
        return [{id:`goal-event:${hash}:${n}`,author:event.by,at:event.at,workflowAction:'goal-update',source:'retained-goal-event',
          text:`[retained group_goal event ${event.fromStatus} → ${event.toStatus}] ${event.text}`}]
      })
      cards.push({
        id: ambiguous ? `legacy-${keyOf([roomId,goal.id,stage.id,task.id,'ambiguous',taskIndex])}` : stableId,
        revision: goal.revision, title: typeof overlay?.title==='string'?overlay.title:task.task, owner: task.botId, status,
        originRoomId: roomId, dependencies: [], acceptance:stage.acceptance,
        description:typeof details.description==='string'?details.description:'',
        dueDate:typeof details.dueDate==='string'?details.dueDate:null,
        labels:Array.isArray(details.labels)?details.labels:[],
        checklist:Array.isArray(details.checklist)?details.checklist:[],
        comments:[...(Array.isArray(task.boardComments)?task.boardComments:[]),...replies,...historical,...(Array.isArray(overlay?.comments)?overlay.comments:[])].sort((a,b)=>(a.at??0)-(b.at??0)),
        goalEvents:historical,
        boardActivity:Array.isArray(task.boardActivity)?task.boardActivity:[],
        boardHistory:Array.isArray(overlay?.audit)?overlay.audit:[],
        ...(typeof task.note === 'string' ? { goalNote:task.note } : {}),
        ...(images.length ? {images:images.map(({ id,name,mediaType })=>({id,name,mediaType}))} : {}),
        legacy: { goalId: goal.id, stageId: stage.id, stageTitle: stage.title,
          taskId: task.id, originalStatus: task.status, goalStatus: goal.status, goalTitle:goal.title,
          originalTitle:task.task, titleStale:typeof overlay?.title==='string' && overlay.titleSource!==task.task,
          position, boardRevision:overlay?.revision??0, useOverlay:true, pending:!!pending,
          archived:retired || goal!==room.goal, current:isCurrent, ambiguous, ...(retired ? {retired:true} : {}) },
      })
        }
      }
    }
  }
  return cards
}

// A group goal remains the source of its items. Organizing them under a feature
// stores only their stable IDs; edits, evidence and status keep their original owner.
export function linkGoalCards(goals, parents) {
  const links = new Map()
  for (const parent of parents) {
    for (const id of parent.goalItemIds ?? []) links.set(id, parent)
  }
  return goals.map(goal => {
    const parent = links.get(goal.id)
    return parent?.scope === `room:${goal.originRoomId}`
      ? { ...goal, parentTaskId:parent.id, ...(parent.releaseId ? {releaseId:parent.releaseId} : {}) } : goal
  })
}
