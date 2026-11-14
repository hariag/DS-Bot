// Pure projections for the task journal. The caller supplies an authenticated
// principal and a current roster; request parameters never select the principal.
const text = value => typeof value === 'string' && value.length > 0
const own = (table, id) => Object.hasOwn(table, id) ? table[id] : undefined

const parseScope = scope => {
  if (!scope || !['room', 'personal'].includes(scope.kind) || !text(scope.id)) throw new Error('Invalid board scope')
  return `${scope.kind}:${scope.id}`
}

function canSeeTask(task, principal, rooms) {
  if (!task || !text(task.scope)) return false
  // A browser session is the instance owner, not an authenticated Bot identity.
  if (principal.kind === 'user') return true
  if (principal.kind !== 'bot' || !text(principal.id)) return false
  if (task.scope === `personal:${principal.id}`) return true
  if (!task.scope.startsWith('room:')) return false
  const room = own(rooms, task.scope.slice(5))
  return !!room && Array.isArray(room.members) && room.members.includes(principal.id)
}

function permitsBoard(scope, principal, rooms, bots) {
  if (principal.kind === 'user') return scope.kind === 'room' ? !!own(rooms, scope.id) : scope.id === 'user' || !!own(bots, scope.id)
  if (principal.kind !== 'bot' || !text(principal.id) || !own(bots, principal.id)) return false
  if (scope.kind === 'personal') return scope.id === principal.id
  const room = own(rooms, scope.id)
  return Array.isArray(room?.members) && room.members.includes(principal.id)
}

/** Return only tasks visible to the authenticated actor in the selected board. */
export function boardList({ scope, principal, rooms = {}, bots = {}, tasks = [], revision = null, verifyShare = () => false, verifyDependency = () => false }) {
  const key = parseScope(scope)
  if (!principal || !permitsBoard(scope, principal, rooms, bots)) throw new Error('Board is not available')
  const visible = tasks.filter(task => canSeeTask(task, principal, rooms))
  const selected = visible.filter(task => scope.kind === 'room'
    ? task.scope === key
    : scope.id === 'user'
      ? task.scope === key || task.owner === 'user' || task.reviewer === 'user'
      : task.scope === key || task.owner === scope.id || task.reviewer === scope.id)
  const shares = scope.kind !== 'room' ? [] : tasks.flatMap(task => (task.shares ?? [])
    .filter(grant => grant && !grant.revoked && grant.targetRoomId === scope.id && grant.taskId === task.id && verifyShare(task, grant, scope, principal) === true)
    .map(grant => ({ id:task.id, title:grant.fields.includes('title') ? grant.titleSnapshot : 'Shared task', status:task.stale ? 'shared-stale' : task.blocked ? 'shared-blocked' : task.status, shared:true })))
  const selectedIds = new Set(selected.map(task => task.id))
  // Group dependencies can name only same-room work or an active granted
  // share; a private or revoked dependency remains hidden.
  const visibleIds = new Set((scope.kind === 'room' ? [...selected, ...shares] : visible).map(task => task.id))
  const taskById = new Map(tasks.map(task => [task.id, task]))
  const unavailable = task => (task.dependencies ?? []).some(id => {
    const dep = taskById.get(id)
    if (!dep) return true
    if (dep.scope === task.scope) return false
    const binding = (task.dependencyGrants ?? []).find(item => item.taskId === id)
    const grant = dep.shares?.find(item => item.id === binding?.grantId && !item.revoked)
    return !grant || verifyDependency(task, dep, grant) !== true
  })
  return {
    scope: { kind: scope.kind, id: scope.id }, revision,
    tasks: [...selected.map(task => ({
      id: task.id, revision: task.revision, title: task.title, status: task.status,
      owner: task.owner, reviewer: task.reviewer,
      ...(principal.kind === 'user' && task.scope === 'personal:user' && task.owner === 'user' && task.status === 'proposed'
        && (task.personalProgress === undefined || ['todo', 'doing', 'finished'].includes(task.personalProgress))
        ? { personalProgress: task.personalProgress ?? 'todo' } : {}),
      dependencies: (task.dependencies ?? []).filter(id => visibleIds.has(id)),
      ...(task.acceptance ? { acceptance: task.acceptance } : {}),
      ...(task.nextAction ? { nextAction: task.nextAction } : {}),
      ...(Array.isArray(task.attachments) ? { images: task.attachments.map(({ id, name, mediaType }) => ({ id, name, mediaType })) } : {}),
      ...(task.blocked ? { blocked: task.blocked } : unavailable(task) ? { blocked: { reason:'Dependency grant unavailable', condition:'Restore an authorized dependency', owner:task.owner } } : {}),
      ...(task.evidence ? { evidence: task.evidence } : {}),
      ...(task.authority ? { authority: task.authority } : {}),
      ...(principal.kind === 'user' && Array.isArray(task.shares) ? { shares: task.shares.filter(share => !share.revoked).map(({ id, targetRoomId, fields }) => ({ id, targetRoomId, fields })) } : {}),
      ...(task.scope.startsWith('room:') ? { originRoomId: task.scope.slice(5) } : {}),
    })), ...shares.filter(task => !selectedIds.has(task.id))],
    // Command exposure is opt-in; a view alone never grants mutation authority.
    capabilities: { commands: {} },
  }
}
