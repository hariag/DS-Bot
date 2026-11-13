import { createHash } from 'node:crypto'

const own = (table, key) => table && Object.hasOwn(table, key) ? table[key] : undefined
const keyOf = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')

// Legacy aggregate IDs can be recreated by goal revision. They are only
// read-only references to the current goal snapshot, never task registrations.
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
    const goal = room.goal
    if (!goal || !['active', 'paused'].includes(goal.status) || !Number.isSafeInteger(goal.current)) continue
    const stage = goal.stages?.[goal.current]
    if (!stage || !Array.isArray(stage.tasks)) continue
    for (const task of stage.tasks) {
      if (!task || typeof task.id !== 'string' || typeof task.botId !== 'string' || typeof task.task !== 'string') continue
      if (scope.kind === 'personal' && task.botId !== scope.id) continue
      const status = task.status === 'working' ? 'working' : task.status === 'reported' ? 'reported' : 'legacy-unverified'
      cards.push({
        id: `legacy-${keyOf([roomId, goal.id, stage.id, stage.title, stage.acceptance, task.id, task.botId, task.task])}`,
        revision: goal.revision, title: task.task, owner: task.botId, status,
        originRoomId: roomId, dependencies: [],
        legacy: { goalId: goal.id, stageId: stage.id, stageTitle: stage.title,
          taskId: task.id, originalStatus: task.status, goalStatus: goal.status },
      })
    }
  }
  return cards
}
