import { AsyncLocalStorage } from 'node:async_hooks'

const id = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x1f]/.test(value)
const refused = () => new Error('Task is unavailable or the action is not authorized')
const actions = new Set(['start', 'report', 'review', 'block', 'unblock'])

// This service is private to the host. The caller supplies a trusted runtime
// and store, never a Bot name or actor claimed by a model/tool argument.
export function createBotWorkflow({ rt, store, verifyBinding = () => false, verifyShare = () => false, verifyActionContext = () => false, wake = () => {}, onError = () => {} }) {
  if (!rt || !store || typeof verifyBinding !== 'function' || typeof verifyShare !== 'function' || typeof verifyActionContext !== 'function') throw new TypeError('Workflow dependencies required')
  const scope = new AsyncLocalStorage()

  const identity = exec => {
    const sid = exec?.agent?.id
    if (!id(sid)) throw refused()
    const actor = rt.selfOf?.(sid)
    const bot = rt.botOf?.(actor)
    if (!id(actor) || !bot) throw refused()
    const entry = rt.groupOwners?.get(sid)
    if (entry !== undefined) {
      const room = rt.roomOf?.(entry.roomId)
      if (!room || room.id !== entry.roomId || !Array.isArray(room.members) || !room.members.includes(actor) || bot.private === true) throw refused()
      return { actor, sid, roomId: room.id }
    }
    if (rt.chatOf?.(actor) !== sid && rt.chatOwners?.get(sid) !== actor) throw refused()
    return { actor, sid }
  }

  const sameIdentity = (left, right) => left.actor === right.actor && left.sid === right.sid && left.roomId === right.roomId
  const roomFor = task => {
    if (typeof task?.scope !== 'string' || !task.scope.startsWith('room:')) return undefined
    const roomId = task.scope.slice(5)
    return id(roomId) ? rt.roomOf?.(roomId) : undefined
  }
  const member = (room, actor) => !!room && Array.isArray(room.members) && room.members.includes(actor) && rt.botOf?.(actor)?.private !== true

  // Only a verified, durable user grant may expose an immutable, minimal
  // snapshot in a different room. A freeform task field is never authority.
  const sharedProjection = (task, caller) => {
    const origin = roomFor(task)
    if (!caller.roomId || !origin || origin.id === caller.roomId || rt.botOf?.(task.owner)?.private === true || !Array.isArray(task.shares)) return undefined
    const target = rt.roomOf?.(caller.roomId)
    if (!member(target, caller.actor)) return undefined
    for (const grant of task.shares) {
      if (!grant || grant.targetRoomId !== caller.roomId || grant.taskId !== task.id || grant.revoked !== false || grant.grantedBy !== 'user') continue
      if (!Array.isArray(grant.fields) || !grant.fields.includes('status') || grant.fields.length > 2 || new Set(grant.fields).size !== grant.fields.length || grant.fields.some(field => !['status', 'title'].includes(field))) continue
      if (verifyShare(task, grant, target) !== true) continue
      const status = task.stale ? 'shared-stale' : task.blocked ? 'shared-blocked' : task.status
      const result = { id: task.id, status, shared: true }
      if (grant.fields.includes('title') && typeof grant.titleSnapshot === 'string' && grant.titleSnapshot.length <= 200) result.title = grant.titleSnapshot
      return result
    }
    return undefined
  }

  const direct = (task, caller) => {
    if (!task || !id(task.id) || typeof task.scope !== 'string') return false
    if (task.scope.startsWith('personal:')) return caller.roomId === undefined && (task.scope.slice(9) === caller.actor
      || (task.authority?.kind === 'user-created' && task.reviewer === caller.actor))
    const origin = roomFor(task)
    if (!member(origin, caller.actor)) return false
    return caller.roomId === undefined || caller.roomId === origin.id
  }

  const canMutate = (task, caller, action, exec) => {
    if (!direct(task, caller) || !actions.has(action)) return false
    if (!task.authority || task.stale === true) return false
    // A Bot can have other concurrent conversations. Its identity alone does
    // not prove that this tool call belongs to the accepted task action.
    if (task.authority.kind === 'user-created' && verifyActionContext(task,caller,action,exec) !== true) return false
    if (task.scope.startsWith('room:')) {
      const room = roomFor(task)
      // User-created board tasks have their own durable authority; they need
      // not pretend to be imported group-goal tasks. Older goal-bound tasks
      // still require the original binding proof. Both honor an actual stop.
      if ((task.authority.kind !== 'user-created' && verifyBinding(task, room) !== true)
        || rt.goalDispatchBlocked?.(room, caller.actor) !== false) return false
    }
    if (action === 'start' || action === 'report') return caller.actor === task.owner
    if (action === 'review') return caller.actor === task.reviewer && caller.actor !== task.owner
    if (action === 'block') return caller.actor === task.owner || caller.actor === task.reviewer
    if (action === 'unblock') return task.blocked?.owner === caller.actor
    return false
  }

  const projectDirect = (task, caller) => {
    const dependencies = (Array.isArray(task.dependencies) ? task.dependencies : []).filter(depId => {
      const dependency = store.get(depId)
      return dependency && (direct(dependency, caller) || sharedProjection(dependency, caller))
    })
    return {
      id: task.id, revision: task.revision, title: task.title, status: task.status,
      owner: task.owner, reviewer: task.reviewer, acceptance: task.acceptance, dependencies,
      ...(task.authority ? { authority: task.authority } : {}),
      ...(task.execution ? { execution: task.execution } : {}),
      ...(task.blocked ? { blocked: task.blocked } : {}),
      ...(task.evidence ? { evidence: task.evidence } : {}),
      ...(task.stale ? { stale: true } : {}),
    }
  }

  // Install this as one branch of the store's authorization callback. The
  // asynchronous local context cannot be selected from tool arguments; the
  // session and task permissions are re-read inside the write transaction.
  function authorize(input) {
    const pending = scope.getStore()
    if (!pending || input?.actor !== pending.caller.actor || input?.type !== pending.action || input?.task?.id !== pending.taskId) return false
    let caller
    try { caller = identity(pending.exec) } catch { return false }
    if (!sameIdentity(caller, pending.caller)) return false
    const current = store.get(pending.taskId)
    return current?.revision === pending.revision && canMutate(current, caller, pending.action, pending.exec)
  }

  async function invoke(exec, args) {
    const caller = identity(exec)
    if (!args || !id(args.taskId) || typeof args.action !== 'string') throw refused()
    const task = store.get(args.taskId)
    if (!task) throw refused()
    if (args.action === 'show') {
      if (direct(task, caller)) return { task: projectDirect(task, caller) }
      const projection = sharedProjection(task, caller)
      if (!projection) throw refused()
      return { task: projection }
    }
    if (args.action === 'operation') {
      if (!direct(task, caller) || !id(args.operationId)) throw refused()
      const record = store.operation(args.operationId)
      if (!record || record.taskId !== task.id) return { state: 'unknown' }
      if (!['committed', 'rejected'].includes(record.status)) return { state: 'unknown' }
      return { state: record.status, ...(record.status === 'rejected' ? { message: record.message } : {}) }
    }
    if (!actions.has(args.action) || !id(args.operationId) || !Number.isSafeInteger(args.expectedRevision) || args.expectedRevision < 1 || !canMutate(task, caller, args.action, exec)) throw refused()
    const context = { exec, caller, taskId: task.id, revision: args.expectedRevision, action: args.action }
    const command = { operationId: args.operationId, taskId: task.id, expectedRevision: args.expectedRevision,
      actor: caller.actor, type: args.action, ...(args.value === undefined ? {} : { value: args.value }) }
    const result = scope.run(context, () => store.command(command))
    // The transaction creates the durable next action. A lost notification
    // is recovered by scanning that journal; never replay a claimed input.
    try { await wake() } catch (error) { onError(error) }
    // The command already committed: if its caller or access changed while
    // waking the driver, return only the receipt rather than stale task data.
    const acknowledgement = { committed:true, operationId:args.operationId }
    let currentCaller
    try { currentCaller = identity(exec) } catch { return acknowledgement }
    const current = store.get(args.taskId)
    if (!sameIdentity(currentCaller, caller) || !direct(current, currentCaller)) return acknowledgement
    return { task: projectDirect(current, currentCaller) }
  }

  return { invoke, authorize }
}
