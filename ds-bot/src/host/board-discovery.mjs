// Results are summaries of already-authorized projections. A shared card keeps
// exactly its granted fields, including when searching by text.
export function discoverWork({ caller, args, store, direct, sharedProjection, goals }) {
  const query = args.query ?? ''
  if (typeof query !== 'string' || query.length > 200 || (args.cursor !== undefined && (typeof args.cursor !== 'string' || args.cursor.length > 300))) {
    throw new Error('Invalid board search')
  }
  const needle = query.trim().toLowerCase()
  const entries = []
  const add = (kind, row, search = []) => {
    if (needle && ![row.id, row.title, ...search].some(value => typeof value === 'string' && value.toLowerCase().includes(needle))) return
    if (args.parentTaskId !== undefined && row.parentTaskId !== args.parentTaskId) return
    entries.push({ kind, ...row })
  }
  const tasks = store.list()
  const byId = new Map(tasks.map(task => [task.id, task]))
  for (const task of tasks) {
    if (!direct(task, caller)) {
      const shared = sharedProjection(task, caller)
      if (shared) add('shared', shared)
      continue
    }
    if (!caller.roomId && task.owner !== caller.actor && task.reviewer !== caller.actor) continue
    if (!needle && !args.parentTaskId && (task.archivedAt || ['done', 'cancelled'].includes(task.status))) continue
    const parent = byId.get(task.parentTaskId)
    const releaseId = task.releaseId ?? (parent?.scope === task.scope ? parent.releaseId : undefined)
    add(task.parentTaskId ? 'item' : 'card', {
      id:task.id, title:task.title, revision:task.revision, status:task.status, scope:task.scope,
      owner:task.owner, reviewer:task.reviewer,
      ...(task.parentTaskId ? {parentTaskId:task.parentTaskId} : {}),
      ...(releaseId ? {releaseId} : {}),
      ...(task.progress ? {progress:task.progress} : {}),
      ...(task.stage ? {stage:task.stage} : {}),
      ...(task.blocked ? {blocked:task.blocked} : {}),
      ...(task.stale ? {stale:true} : {}),
    }, [task.parentTaskId, task.description])
  }
  for (const task of goals) {
    const goal = task.legacy
    if (!needle && !args.parentTaskId && (goal.archived || !goal.current || goal.originalStatus === 'done')) continue
    add('group_goal', {
      id:task.id, title:task.title, status:goal.originalStatus, owner:task.owner, roomId:task.originRoomId,
      goalId:goal.goalId, stageId:goal.stageId, goalTaskId:goal.taskId, position:goal.position,
      goalStatus:goal.goalStatus, ...(task.parentTaskId ? {parentTaskId:task.parentTaskId} : {}),
      ...(task.releaseId ? {releaseId:task.releaseId} : {}),
    }, [goal.taskId, task.goalNote, goal.stageTitle, goal.originalTitle])
  }
  const scope = caller.roomId ? `room:${caller.roomId}` : `personal:${caller.actor}`
  for (const proposal of store.listProposals(scope)) {
    if (proposal.proposer !== caller.actor || proposal.status !== 'pending') continue
    const title = proposal.after?.title ?? store.get(proposal.taskId)?.title
    add('proposal', {id:proposal.id, taskId:proposal.taskId, title, status:'pending', decisionBy:'user'}, [proposal.taskId])
  }
  const key = entry => entry.kind + '/' + entry.id
  entries.sort((a, b) => key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0)
  const remaining = args.cursor ? entries.filter(entry => key(entry) > args.cursor) : entries
  const items = remaining.slice(0, 20)
  return { scope, items, ...(items.length < remaining.length ? {nextCursor:key(items.at(-1))} : {}) }
}
