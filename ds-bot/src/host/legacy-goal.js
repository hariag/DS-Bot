import { createHash } from 'node:crypto'

const own = (table, key) => table && Object.hasOwn(table, key) ? table[key] : undefined
const keyOf = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const statuses = new Map([['pending','legacy-pending'],['working','working'],['reported','reported'],['done','done']])

// This identifies the original goal task across edits; it is not a second
// task registration and cannot confer permission by itself.
export const legacyGoalCardId = (roomId, goalId, stageId, taskId) => `legacy-${keyOf([roomId,goalId,stageId,taskId])}`
export function legacyGoalCards({ scope, principal, rooms = {}, bots = {} }) {
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
      const ambiguous=stage.tasks.filter(item=>item?.id===task.id).length!==1
      const status = task.status==='pending' && stageIndex>goal.current ? 'waiting' : statuses.get(task.status) ?? 'legacy-unverified'
      cards.push({
        id: ambiguous ? `legacy-${keyOf([roomId,goal.id,stage.id,task.id,'ambiguous',taskIndex])}` : legacyGoalCardId(roomId,goal.id,stage.id,task.id),
        revision: goal.revision, title: task.task, owner: task.botId, status,
        originRoomId: roomId, dependencies: [], acceptance:stage.acceptance,
        ...(typeof task.note === 'string' ? { goalNote:task.note } : {}),
        ...(Array.isArray(task.boardImages) ? { images:task.boardImages.filter(image=>image && typeof image.id==='string').map(({ id,name,mediaType })=>({id,name,mediaType})) } : {}),
        legacy: { goalId: goal.id, stageId: stage.id, stageTitle: stage.title,
          taskId: task.id, originalStatus: task.status, goalStatus: goal.status, goalTitle:goal.title,
          archived:goal!==room.goal, current:goal===room.goal&&stageIndex===goal.current, ambiguous },
      })
        }
      }
    }
  }
  return cards
}
