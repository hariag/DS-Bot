// The workflow supplies the caller and room after authenticating the Session.
// Only this narrow creation path can mark a card as tracked from chat.
export const isManualBoardTask = task => task?.intake?.kind === 'chat' && !task.authority
export const isFeatureCard = task => !task?.parentTaskId && ['feature', 'bugfix'].includes(task?.type)

export const isUnassignedItemDraft = task => !!task.parentTaskId && (task.draft === true || task.status === 'draft')
  && task.owner === null && task.reviewer === null

export function prepareBoardIntake({ actor, scope, taskId, operationId, parentTaskId, releaseId, value }) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['title','owner','reviewer','acceptance','type','description'].includes(key))) {
    throw new Error('invalid task fields')
  }
  if (!scope?.startsWith('room:') || scope.length <= 5 || !actor || actor === 'user' || actor === 'scheduler') throw new Error('invalid task intake')
  if (typeof value.title !== 'string' || !value.title.trim() || value.title.trim().length > 200) throw new Error('invalid title')
  const type = value.type ?? (parentTaskId === undefined ? 'feature' : 'development')
  if (parentTaskId === undefined && !isFeatureCard({type})) throw new Error('top-level card must be a feature or bugfix')
  return {
    actor, operationId,
    task: { ...value, id:taskId, title:value.title.trim(), scope, type },
    intake: { ...(parentTaskId === undefined ? {} : { parentTaskId }), ...(releaseId === undefined ? {} : { releaseId }) },
  }
}
