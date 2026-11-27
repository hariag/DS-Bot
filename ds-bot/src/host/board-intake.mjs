// The workflow supplies the caller and room after authenticating the Session.
// Only this narrow creation path can mark a card as tracked from chat.
export const isManualBoardTask = task => task?.intake?.kind === 'chat' && !task.authority
export const isFeatureCard = task => !task?.parentTaskId && ['feature', 'bugfix'].includes(task?.type)
export const registrationFields = ['title','owner','reviewer','acceptance','type','description','acceptor']

export const isUnassignedItemDraft = task => !!task.parentTaskId && (task.draft === true || task.status === 'draft')
  && task.owner === null && task.reviewer === null

export function prepareBoardIntake({ actor, scope, taskId, operationId, parentTaskId, releaseId, value }) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !registrationFields.includes(key))) {
    throw new Error(`invalid task fields. Put only ${registrationFields.join(', ')} in change.value.`)
  }
  if (!scope?.startsWith('room:') || scope.length <= 5 || !actor || actor === 'user' || actor === 'scheduler') throw new Error('invalid task intake')
  if (typeof value.title !== 'string' || !value.title.trim() || value.title.trim().length > 200) throw new Error('invalid title. Set change.value.title to a non-empty title of up to 200 characters.')
  if (typeof value.acceptance !== 'string' || !value.acceptance.trim()) throw new Error('invalid acceptance. Set change.value.acceptance to measurable acceptance criteria.')
  for (const field of ['acceptance', 'description']) {
    if (value[field] !== undefined && typeof value[field] !== 'string') throw new Error(`change.value.${field} must be text.`)
    if (value[field] !== undefined && Buffer.byteLength(value[field], 'utf8') > 8192) throw new Error(`change.value.${field} exceeds 8192 UTF-8 bytes. Keep a summary and link the remaining detail.`)
  }
  if (value.acceptor !== undefined && (typeof value.acceptor !== 'string' || !value.acceptor.trim() || ['user', 'scheduler', value.owner, value.reviewer].includes(value.acceptor))) {
    throw new Error('change.value.acceptor must identify a third, distinct Bot member of this room.')
  }
  const type = value.type ?? (parentTaskId === undefined ? 'feature' : 'development')
  if (parentTaskId === undefined && !isFeatureCard({type})) throw new Error('top-level card must be a feature or bugfix. Register a child with parent_task_id for other task types.')
  return {
    actor, operationId,
    task: { ...value, id:taskId, title:value.title.trim(), scope, type },
    intake: { ...(parentTaskId === undefined ? {} : { parentTaskId }), ...(releaseId === undefined ? {} : { releaseId }) },
  }
}
