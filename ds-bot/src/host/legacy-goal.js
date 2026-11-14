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
      for (const [stageIndex,stage] of goal.stages.entries()) {
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
        || goal.stages.filter(item=>item?.id===stage.id).length!==1 || goals.filter(item=>item?.id===goal.id).length!==1 || !validSaved
      const overlay=validSaved && saved ? saved : undefined
      const isCurrent=goal===room.goal && stageIndex===goal.current && ['active','paused'].includes(goal.status)
      const position=goal!==room.goal?'archived':stageIndex<goal.current?'previous':stageIndex>goal.current?'future':isCurrent?'current':'closed'
      const details={...(task.boardDetails??{}),...(overlay?.details??{})}
      const hidden=Array.isArray(overlay?.hiddenImages)?overlay.hiddenImages:[]
      const images=[...(Array.isArray(task.boardImages)?task.boardImages:[]),...(Array.isArray(overlay?.images)?overlay.images:[])]
        .filter(image=>image && typeof image.id==='string' && !hidden.includes(image.id))
      const status = task.status==='pending' && stageIndex>goal.current ? 'waiting' : statuses.get(task.status) ?? 'legacy-unverified'
      cards.push({
        id: ambiguous ? `legacy-${keyOf([roomId,goal.id,stage.id,task.id,'ambiguous',taskIndex])}` : stableId,
        revision: goal.revision, title: typeof overlay?.title==='string'?overlay.title:task.task, owner: task.botId, status,
        originRoomId: roomId, dependencies: [], acceptance:stage.acceptance,
        description:typeof details.description==='string'?details.description:'',
        dueDate:typeof details.dueDate==='string'?details.dueDate:null,
        labels:Array.isArray(details.labels)?details.labels:[],
        checklist:Array.isArray(details.checklist)?details.checklist:[],
        comments:[...(Array.isArray(task.boardComments)?task.boardComments:[]),...(Array.isArray(overlay?.comments)?overlay.comments:[])],
        boardActivity:Array.isArray(task.boardActivity)?task.boardActivity:[],
        boardHistory:Array.isArray(overlay?.audit)?overlay.audit:[],
        ...(typeof task.note === 'string' ? { goalNote:task.note } : {}),
        ...(images.length ? {images:images.map(({ id,name,mediaType })=>({id,name,mediaType}))} : {}),
        legacy: { goalId: goal.id, stageId: stage.id, stageTitle: stage.title,
          taskId: task.id, originalStatus: task.status, goalStatus: goal.status, goalTitle:goal.title,
          originalTitle:task.task, titleStale:typeof overlay?.title==='string' && overlay.titleSource!==task.task,
          position, boardRevision:overlay?.revision??0, useOverlay:true, pending:!!pending,
          archived:goal!==room.goal, current:isCurrent, ambiguous },
      })
        }
      }
    }
  }
  return cards
}
