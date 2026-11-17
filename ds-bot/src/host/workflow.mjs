import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'

const own = (value, key) => value != null && Object.hasOwn(value, key) ? value[key] : undefined
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x1f]/.test(value)
const refused = () => new Error('Task is unavailable or the action is not authorized')
const actions = new Set(['start', 'report', 'review', 'block', 'unblock'])
const proposalUpdateFields = ['description', 'type', 'labels', 'dueDate', 'dueComplete', 'checklist']
const taskTypes = new Set(['requirement','design','feature','development','test','deployment','operations','bugfix','ui','ux','other'])

// This service is private to the host. The caller supplies a trusted runtime
// and store, never a Bot name or actor claimed by a model/tool argument.
export function createBotWorkflow({ rt, store, verifyBinding = () => false, verifyShare = () => false, wake = () => {}, onError = () => {} }) {
  if (!rt || !store || typeof verifyBinding !== 'function' || typeof verifyShare !== 'function') throw new TypeError('Workflow dependencies required')
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
    if (task.scope.startsWith('personal:')) return caller.roomId === undefined
      && (task.scope.slice(9) === caller.actor || task.reviewer === caller.actor)
    const origin = roomFor(task)
    if (!member(origin, caller.actor)) return false
    return caller.roomId === undefined || caller.roomId === origin.id
  }

  const canMutate = (task, caller, action) => {
    if (!direct(task, caller) || (!actions.has(action) && action !== 'propose')) return false
    if (action === 'propose') return task.stale !== true && (caller.actor === task.owner || caller.actor === task.reviewer)
    if (!task.authority || task.stale === true) return false
    if (task.scope.startsWith('room:')) {
      const room = roomFor(task)
      // A bound group task is eligible only when the durable binding has been
      // verified and its current goal still allows the affected work.
      if (verifyBinding(task, room) !== true || rt.goalDispatchBlocked?.(room, caller.actor) !== false) return false
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
    if (!pending || input?.actor !== pending.caller.actor || !(input?.type === pending.action || (pending.action === 'propose' && input?.type === 'proposal')) || input?.task?.id !== pending.taskId) return false
    let caller
    try { caller = identity(pending.exec) } catch { return false }
    if (!sameIdentity(caller, pending.caller)) return false
    if (pending.create) {
      const target = input.task
      if (!target || target.id !== pending.taskId || target.scope !== pending.scope) return false
      if (pending.scope.startsWith('room:')) return caller.roomId === pending.scope.slice(5)
      return caller.roomId === undefined && pending.scope === `personal:${caller.actor}`
    }
    const current = store.get(pending.taskId)
    return current?.revision === pending.revision && canMutate(current, caller, pending.action)
  }

  async function invoke(exec, args) {
    const caller = identity(exec)
    if (args?.action === 'plan') {
      if (!id(args.releaseId) || typeof args.requirement !== 'string' || typeof rt.boardPlanRelease !== 'function') throw refused()
      return { plan: await rt.boardPlanRelease({ caller, releaseId:args.releaseId, requirement:args.requirement, operationId:args.operationId }) }
    }
    if (args?.action === 'propose' && args.change?.kind === 'create') {
      const value = args.change.value
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw refused()
      const fields = ['title','owner','reviewer','acceptance','type','description','dependencies','labels','dueDate','dueComplete','checklist','draft']
      if (Object.keys(value).some(field => !fields.includes(field))) throw refused()
      if (typeof value.title !== 'string' || !value.title.trim() || value.title.length > 200) throw refused()
      if (!id(value.owner) || !id(value.reviewer) || value.owner === value.reviewer) throw refused()
      if (typeof value.acceptance !== 'string' || value.acceptance.length > 8192) throw refused()
      if (value.description !== undefined && (typeof value.description !== 'string' || Buffer.byteLength(value.description) > 8192)) throw refused()
      if (value.type !== undefined && !taskTypes.has(value.type)) throw refused()
      if (value.dependencies !== undefined && (!Array.isArray(value.dependencies) || value.dependencies.length > 100 || value.dependencies.some(item => !id(item)))) throw refused()
      if (value.draft !== undefined && typeof value.draft !== 'boolean') throw refused()
      if (args.note !== undefined && (typeof args.note !== 'string' || args.note.length > 2000)) throw refused()
      const targetScope = caller.roomId ? `room:${caller.roomId}` : `personal:${caller.actor}`
      const taskId = `card-${randomUUID()}`
      const proposalId = args.operationId ? `proposal:${args.operationId}` : `proposal:${randomUUID()}`
      const existing = store.listProposals(targetScope).find(item => item.id === proposalId)
      if (existing) return { proposal: existing }
      const proposal = {
        id: proposalId, scope:targetScope, taskId, kind:'create', baseRevision:0,
        command:{ type:'create', value:{ ...value, title:value.title.trim(), acceptance:value.acceptance.trim(), dependencies:value.dependencies ?? [] } },
        before:null, after:{ ...value, title:value.title.trim(), acceptance:value.acceptance.trim(), dependencies:value.dependencies ?? [] },
        ...(args.note ? { note:args.note } : {}),
      }
      const context = { exec, caller, taskId, revision:0, action:'propose', create:true, scope:targetScope }
      const saved = scope.run(context, () => store.createProposal({ operationId: args.operationId ? `proposal:${args.operationId}` : `proposal:${proposalId}`, actor:caller.actor, proposal }))
      return { proposal: saved }
    }
    if (args?.action === 'proposal' && !args.taskId && id(args.proposalId)) {
      const targetScope = caller.roomId ? `room:${caller.roomId}` : `personal:${caller.actor}`
      const proposal = store.listProposals(targetScope).find(item => item.id === args.proposalId)
      if (!proposal || proposal.proposer !== caller.actor) throw refused()
      return { proposal }
    }
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
    if (args.action === 'proposal') {
      if (!direct(task, caller) || !id(args.proposalId)) throw refused()
      const proposal = store.listProposals(task.scope).find(item => item.id === args.proposalId)
      if (!proposal || proposal.proposer !== caller.actor) throw refused()
      return { proposal }
    }
    if (args.action === 'propose') {
      if (!canMutate(task, caller, 'propose') || args.expectedRevision !== undefined && args.expectedRevision !== task.revision) throw refused()
      const change = args.change
      if (!change || typeof change !== 'object' || Array.isArray(change) || !['update','status','release'].includes(change.kind)) throw refused()
      let command
      if (change.kind === 'update') {
        if (!change.value || typeof change.value !== 'object' || Array.isArray(change.value)) throw refused()
        const fields = Object.keys(change.value)
        if (!fields.length || fields.some(field => !proposalUpdateFields.includes(field))) throw refused()
        command = { type:'card-details', value:change.value }
      } else if (change.kind === 'status') {
        if (!change.value || !['submit','cancel','restore'].includes(change.value.type)) throw refused()
        if (change.value.type === 'cancel' && change.value.reason !== undefined && (typeof change.value.reason !== 'string' || change.value.reason.length > 500)) throw refused()
        command = { type:change.value.type, ...(change.value.type === 'cancel' && change.value.reason ? { value:{ reason:change.value.reason } } : {}) }
      } else {
        if (!change.value || !id(change.value.releaseId)) throw refused()
        command = { type:'release-assign', value:{ releaseId:change.value.releaseId } }
      }
      if (args.note !== undefined && (typeof args.note !== 'string' || args.note.length > 2000)) throw refused()
      const proposalId = args.operationId ? `proposal:${args.operationId}` : `proposal:${randomUUID()}`
      const existing = store.listProposals(task.scope).find(item => item.id === proposalId)
      if (existing) return { proposal: existing }
      const before = Object.fromEntries(proposalUpdateFields.filter(field => Object.hasOwn(task, field)).map(field => [field, task[field]]))
      const proposal = {
        id: proposalId, scope: task.scope, taskId: task.id, kind: change.kind, baseRevision: task.revision,
        command, before, after: change.kind === 'update' ? { ...before, ...change.value } : change.value,
        ...(args.note ? { note:args.note } : {}),
      }
      const context = { exec, caller, taskId: task.id, revision: task.revision, action: 'propose' }
      const saved = scope.run(context, () => store.createProposal({ operationId: args.operationId ? `proposal:${args.operationId}` : `proposal:${proposalId}`, actor: caller.actor, proposal }))
      return { proposal: saved }
    }
    if (!actions.has(args.action) || !id(args.operationId) || !Number.isSafeInteger(args.expectedRevision) || args.expectedRevision < 1 || !canMutate(task, caller, args.action)) throw refused()
    const context = { exec, caller, taskId: task.id, revision: args.expectedRevision, action: args.action }
    const command = { operationId: args.operationId, taskId: task.id, expectedRevision: args.expectedRevision,
      actor: caller.actor, type: args.action, ...(args.value === undefined ? {} : { value: args.value }) }
    const result = scope.run(context, () => store.command(command))
    // The transaction creates the durable next action. A lost notification
    // is recovered by scanning that journal; never replay a claimed input.
    try { await wake() } catch (error) { onError(error) }
    return { task: projectDirect(result, caller) }
  }

  return { invoke, authorize }
}
