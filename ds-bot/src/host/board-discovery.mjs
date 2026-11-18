// Results are summaries of already-authorized projections. A shared card keeps
// exactly its granted fields, including when searching by text.
const kinds = ['card','item','group_goal','proposal','shared','release']

export function boardReleaseId(task, parent, caller, direct) {
  if (!task.parentTaskId) return task.releaseId
  return parent?.scope === task.scope && direct(parent, caller) ? parent.releaseId : undefined
}

export function discoverWork({ caller, args, store, direct, sharedProjection, goalCards }) {
  const query = args.query ?? ''
  if (typeof query !== 'string' || query.length > 200 || (args.cursor !== undefined && (typeof args.cursor !== 'string' || args.cursor.length > 300))
    || (args.kind !== undefined && !kinds.includes(args.kind)) || (args.mine !== undefined && typeof args.mine !== 'boolean')
    || (args.releaseId !== undefined && (typeof args.releaseId !== 'string' || !args.releaseId.length || args.releaseId.length > 256))) {
    throw new Error('Invalid board search')
  }
  const needle = query.trim().toLowerCase()
  const scope = caller.roomId ? `room:${caller.roomId}` : `personal:${caller.actor}`
  const entries = []
  const add = (kind, row, search = []) => {
    if (args.kind && kind !== args.kind) return
    if (args.mine && row.owner !== caller.actor && row.reviewer !== caller.actor) return
    if (args.releaseId && (kind === 'release' ? row.id : row.releaseId) !== args.releaseId) return
    if (needle && ![row.id, row.title, ...search].some(value => typeof value === 'string' && value.toLowerCase().includes(needle))) return
    if (args.parentTaskId !== undefined && row.parentTaskId !== args.parentTaskId) return
    entries.push({ kind, ...row })
  }
  if (args.releaseId && (!caller.roomId || store.getRelease(args.releaseId)?.scope !== scope)) return {scope, items:[]}
  if (args.kind === 'release') {
    if (caller.roomId) {
      for (const release of store.listReleases(scope, {summary:true})) {
        add('release', {id:release.id, title:release.name, version:release.version, status:release.status}, [release.version])
      }
    }
    return page(scope, entries, args.cursor)
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
    if (!needle && !args.parentTaskId && !args.releaseId && (task.archivedAt || ['done', 'cancelled'].includes(task.status))) continue
    const parent = byId.get(task.parentTaskId)
    const releaseId = boardReleaseId(task, parent, caller, direct)
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
  for (const task of (!args.kind || args.kind === 'group_goal' ? goalCards(caller, tasks) : [])) {
    const goal = task.legacy
    if (!needle && !args.parentTaskId && !args.releaseId && (goal.archived || !goal.current || goal.originalStatus === 'done')) continue
    add('group_goal', {
      id:task.id, title:task.title, status:goal.originalStatus, owner:task.owner, roomId:task.originRoomId,
      goalId:goal.goalId, stageId:goal.stageId, goalTaskId:goal.taskId, position:goal.position,
      goalStatus:goal.goalStatus, ...(task.parentTaskId ? {parentTaskId:task.parentTaskId} : {}),
      ...(task.releaseId ? {releaseId:task.releaseId} : {}),
    }, [goal.taskId, task.goalNote, goal.stageTitle, goal.originalTitle])
  }
  for (const proposal of (!args.mine && !args.releaseId && (!args.kind || args.kind === 'proposal') ? store.listProposals(scope) : [])) {
    if (proposal.proposer !== caller.actor || proposal.status !== 'pending') continue
    const title = proposal.after?.title ?? byId.get(proposal.taskId)?.title
    add('proposal', {id:proposal.id, taskId:proposal.taskId, title, status:'pending', decisionBy:'user'}, [proposal.taskId])
  }
  return page(scope, entries, args.cursor)
}

function page(scope, entries, cursor) {
  const key = entry => entry.kind + '/' + entry.id
  entries.sort((a, b) => key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0)
  const remaining = cursor ? entries.filter(entry => key(entry) > cursor) : entries
  const items = remaining.slice(0, 20)
  return { scope, items, ...(items.length < remaining.length ? {nextCursor:key(items.at(-1))} : {}) }
}
