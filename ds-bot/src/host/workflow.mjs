import { boardReleaseId, discoverWork } from './board-discovery.mjs'
import { legacyGoalCards, linkGoalCards } from './legacy-goal.js'
import { prepareBoardIntake, isManualBoardTask } from './board-intake.mjs'
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'

const id = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x1f]/.test(value)
const refused = () => new Error('Task is unavailable or the action is not authorized')
const actions = new Set(['reply', 'start', 'progress', 'report', 'review', 'block', 'unblock'])
const proposalUpdateFields = ['description', 'type', 'stage', 'labels', 'dueDate', 'dueComplete', 'checklist']
const taskTypes = new Set(['requirement','design','feature','development','test','deployment','operations','bugfix','ui','ux','other'])

// This service is private to the host. The caller supplies a trusted runtime
// and store, never a Bot name or actor claimed by a model/tool argument.
export function createBotWorkflow({ rt, store, verifyBinding = () => false, verifyShare = () => false, goalReply, pendingGoalCard, wake = () => {}, onError = () => {} }) {
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

  const selectRoom = (caller, roomId) => {
    if (roomId === undefined) return caller
    if (!id(roomId) || (caller.roomId && caller.roomId !== roomId) || !member(rt.roomOf?.(roomId), caller.actor)) throw refused()
    return { ...caller, roomId }
  }
  const goalCards = (caller, tasks = store.list()) => linkGoalCards(legacyGoalCards({
    scope:caller.roomId ? {kind:'room', id:caller.roomId} : {kind:'personal', id:caller.actor},
    principal:{kind:'bot', id:caller.actor}, rooms:rt.state?.rooms, bots:rt.state?.bots, pendingCard:pendingGoalCard,
  }), tasks.filter(task => direct(task, caller)))
  const intakeAllowed = (caller, task) => {
    const room = rt.roomOf?.(caller.roomId)
    const participant = actor => actor === 'user' || (rt.botOf?.(actor) && member(room, actor))
    return room && task.scope === `room:${room.id}` && member(room, caller.actor)
      && participant(task.owner) && participant(task.reviewer)
  }

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
    if (action === 'propose') return task.stale !== true && !task.archivedAt && (caller.actor === task.owner || caller.actor === task.reviewer)
    if (action === 'reply') {
      const room = roomFor(task)
      return task.status === 'draft' && !task.authority && !task.stale && !task.archivedAt
        && !!room && member(room, caller.actor) && rt.goalDispatchBlocked?.(room, caller.actor) === false
        && (caller.actor === task.owner || caller.actor === task.reviewer)
    }
    if ((!task.authority && !isManualBoardTask(task)) || task.stale === true || task.archivedAt) return false
    if (task.scope.startsWith('room:')) {
      const room = roomFor(task)
      // A bound group task is eligible only when the durable binding has been
      // verified and its current goal still allows the affected work.
      if (verifyBinding(task, room) !== true || rt.goalDispatchBlocked?.(room, caller.actor) !== false) return false
    }
    if (action === 'start' || action === 'progress' || action === 'report') return caller.actor === task.owner
    if (action === 'review') return caller.actor === task.reviewer && caller.actor !== task.owner
    if (action === 'block') return caller.actor === task.owner || caller.actor === task.reviewer
    if (action === 'unblock') return task.blocked?.owner === caller.actor
    return false
  }

  const visibleDependency = (caller, id) => {
    const dependency = store.get(id)
    return !!dependency && (direct(dependency, caller) || !!sharedProjection(dependency, caller))
  }
  // A change task carries the before/after values the user asked to reconcile; Bots see
  // the same visible-dependency filter as the user projection.
  const changeView = (task, caller) => {
    if (!task.change) return undefined
    const filter = value => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return value
      const copy = { ...value }
      if (Array.isArray(copy.dependencies)) copy.dependencies = copy.dependencies.filter(id => visibleDependency(caller, id))
      return copy
    }
    return { sourceTaskId: task.change.sourceTaskId, sourceRevision: task.change.sourceRevision,
      before: filter(task.change.before), after: filter(task.change.after) }
  }
  const projectDirect = (task, caller) => {
    const parent = task.parentTaskId ? store.get(task.parentTaskId) : undefined
    const releaseId = boardReleaseId(task, parent, caller, direct)
    const dependencies = (Array.isArray(task.dependencies) ? task.dependencies : []).filter(depId => visibleDependency(caller, depId))
    const change = changeView(task, caller)
    const linked = store.projectCoordination?.existingLink(task.id) || store.projectCoordination?.existingLink(task.parentTaskId)
    return {
      ...(linked ? {projectRead:{action:'show',room_id:linked.originRoomId,revision:linked.revision}} : {}),
      id: task.id, scope:task.scope, revision: task.revision, title: task.title, status: task.status,
      owner: task.owner, reviewer: task.reviewer, acceptance: task.acceptance, dependencies,
      // Card content the owner works with, so a show after a handoff or a part switch
      // does not lose what the dispatch prompt carried once.
      description: typeof task.description === 'string' ? task.description : '',
      type: typeof task.type === 'string' ? task.type : 'other',
      labels: Array.isArray(task.labels) ? task.labels.filter(label => typeof label === 'string') : [],
      dueDate: typeof task.dueDate === 'string' ? task.dueDate : null,
      dueComplete: task.dueComplete === true,
      checklist: Array.isArray(task.checklist)
        ? task.checklist.filter(item => item && typeof item.text === 'string').map(item => ({ text:item.text, checked:item.checked === true }))
        : [],
      ...(task.authority ? { authority: task.authority } : {}),
      ...(task.intake ? { intake:task.intake } : {}),
      ...(task.parentTaskId ? { parentTaskId:task.parentTaskId } : {}),
      ...(releaseId ? { releaseId } : {}),
      ...(task.progress ? { progress:task.progress } : {}),
      ...(task.stage ? { stage:task.stage } : {}),
      ...(task.review ? { review:task.review } : {}),
      ...(task.nextAction ? { nextAction:task.nextAction } : {}),
      ...(task.comments?.length ? { replies:task.comments.slice(-12), moreReplies:task.comments.length > 12 } : {}),
      ...(task.blocked ? { blocked: task.blocked } : {}),
      ...(task.evidence ? { evidence: task.evidence } : {}),
      ...(task.stale ? { stale: true } : {}),
      ...(change ? { change } : {}),
    }
  }

  // Install this as one branch of the store's authorization callback. The
  // asynchronous local context cannot be selected from tool arguments; the
  // session and task permissions are re-read inside the write transaction.
  function authorize(input) {
    const pending = scope.getStore()
    if (input.type === 'intake-create' && pending?.action === 'intake-create') {
      const caller = selectRoom(identity(pending.exec), pending.roomId)
      return sameIdentity(caller, pending.caller) && input.actor === caller.actor
        && input.task?.id === pending.taskId && intakeAllowed(caller, input.task)
    }
    if (!pending || input?.actor !== pending.caller.actor || !(input?.type === pending.action || (pending.action === 'propose' && input?.type === 'proposal')) || input?.task?.id !== pending.taskId) return false
    let caller
    try { caller = selectRoom(identity(pending.exec), pending.roomId) } catch { return false }
    if (!sameIdentity(caller, pending.caller)) return false
    if (pending.create) {
      const target = input.task
      if (!target || target.id !== pending.taskId || target.scope !== pending.scope) return false
      if (pending.scope.startsWith('room:')) return caller.roomId === pending.scope.slice(5)
      return caller.roomId === undefined && pending.scope === `personal:${caller.actor}`
    }
    const current = store.get(pending.taskId)
    // store.command checks exact replays before the CAS for new writes. Proposals
    // instead carry the base revision in their separate journal entry.
    return canMutate(current, caller, pending.action) && (pending.action !== 'propose' || current.revision === pending.revision)
  }

  async function invoke(exec, args) {
    const caller = selectRoom(identity(exec), args?.roomId)
    if (args?.action === 'list') return discoverWork({
      caller, args, store, direct, sharedProjection, goalCards,
    })
    if (args?.action === 'register') {
      const required = []
      if (!caller.roomId) required.push('room_id for a private chat')
      if (!id(args.taskId)) required.push('a valid task_id')
      if (!id(args.operationId)) required.push('a stable operation_id')
      if (!args.change?.value) required.push('change.value with the card fields')
      if (required.length) throw new Error(`board_task register requires ${required.join(', ')}`)
      // Bots know each other by display name, not by session id. Resolve the two
      // people fields against this room's members before intake authorizes them;
      // otherwise a perfectly normal `owner: "前端开发"` is refused as unauthorized.
      const room = rt.roomOf?.(caller.roomId)
      const resolveMember = name => {
        if (typeof name !== 'string' || !name || rt.botOf?.(name)) return name
        const bot = (room?.members ?? []).map(id => rt.botOf?.(id)).find(candidate => candidate?.name === name)
        return bot?.id ?? name
      }
      const fields = { ...args.change.value }
      if (Object.hasOwn(fields, 'owner')) fields.owner = resolveMember(fields.owner)
      if (Object.hasOwn(fields, 'reviewer')) fields.reviewer = resolveMember(fields.reviewer)
      const request = prepareBoardIntake({actor:caller.actor, scope:`room:${caller.roomId}`, taskId:args.taskId,
        operationId:args.operationId, parentTaskId:args.parentTaskId, releaseId:args.releaseId, value:fields})
      if (!intakeAllowed(caller, request.task)) throw refused()
      const existing = store.get(args.taskId)
      if (existing && !direct(existing, caller)) {
        const link = store.projectCoordination?.existingLink(existing.id)
        if (!link?.audience.includes(caller.roomId)) throw refused()
        return {alreadyRegistered:true, task:{id:existing.id, roomId:link.originRoomId, revision:existing.revision, status:existing.status},
          next:'Use the original project task and its assigned owner. No new task or delivery was created.'}
      }
      const task = scope.run({exec, caller, roomId:args.roomId, taskId:args.taskId, action:'intake-create'}, () => store.create(request))
      return {task:projectDirect(task, caller)}
    }
    if (args?.action === 'plan') {
      if (!id(args.releaseId) || typeof args.requirement !== 'string' || typeof rt.boardPlanRelease !== 'function') throw refused()
      return { plan: await rt.boardPlanRelease({ caller, releaseId:args.releaseId, cardType:args.change?.value?.type, requirement:args.requirement, operationId:args.operationId }) }
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
      const proposal = {
        id: proposalId, scope:targetScope, taskId, kind:'create', baseRevision:0,
        command:{ type:'create', value:{ ...value, title:value.title.trim(), acceptance:value.acceptance.trim(), dependencies:value.dependencies ?? [] } },
        before:null, after:{ ...value, title:value.title.trim(), acceptance:value.acceptance.trim(), dependencies:value.dependencies ?? [] },
        ...(args.note ? { note:args.note } : {}),
      }
      const existing = store.listProposals(targetScope).find(item => item.id === proposalId)
      if (existing) {
        // One operation id means one exact logical request. An identical retry receives the
        // recorded proposal; a changed request must not silently receive it.
        const same = existing.proposer === caller.actor && existing.kind === 'create' && existing.scope === targetScope
          && isDeepStrictEqual(existing.command, proposal.command) && (existing.note ?? '') === (proposal.note ?? '')
        if (!same) throw Object.assign(new Error('operation id conflict'), { code: 'bot/invalid' })
        return { proposal: existing }
      }
      const context = { exec, caller, roomId:args.roomId, taskId, revision:0, action:'propose', create:true, scope:targetScope }
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
    if (!task && args.taskId.startsWith('legacy-')) {
      const goal = goalCards(caller).find(card => card.id === args.taskId)
      if (goal && ['reply','operation'].includes(args.action)) {
        if (!goalReply || goal.owner !== caller.actor || !id(args.operationId) || !member(rt.roomOf(goal.originRoomId), caller.actor)) throw refused()
        return goalReply({kind:'room',id:goal.originRoomId}, caller.actor, {taskId:goal.id, operationId:args.operationId,
          expectedRevision:args.expectedRevision, expectedBoardRevision:args.expectedBoardRevision, value:{text:args.note}}, args.action === 'operation')
      }
      if (goal && args.action === 'show') return {task:{id:goal.id, revision:goal.revision, title:goal.title, owner:goal.owner, status:goal.legacy.originalStatus,
        scope:`room:${goal.originRoomId}`, roomId:goal.originRoomId, acceptance:goal.acceptance, description:goal.description,
        labels:goal.labels.filter(label => typeof label === 'string'), dueDate:goal.dueDate,
        checklist:goal.checklist.filter(item => item && typeof item.text === 'string').map(item => ({text:item.text, checked:item.checked === true})),
        goalNote:goal.goalNote, goalEvents:goal.goalEvents, parentTaskId:goal.parentTaskId, releaseId:goal.releaseId, legacy:goal.legacy,
        replies:goal.comments.filter(comment=>comment.source!=='retained-goal-event').slice(-12)}}
    }
    if (!task) throw refused()
    if (args.action === 'show') {
      if (direct(task, caller)) {
        const openChanges = store.list().filter(other => other.change?.sourceTaskId === task.id && direct(other, caller)
          && !other.archivedAt && !['cancelled','done'].includes(other.status))
        const roomId = roomFor(task)?.id
        return {
          task:{...projectDirect(task, caller), ...(roomId ? {roomId} : {}),
            ...(openChanges.length ? {openChangeRequests:openChanges.map(({id, status}) => ({id, status}))} : {})},
          ...(roomId && !task.parentTaskId ? {itemsQuery:{action:'list', room_id:roomId, parent_task_id:task.id}} : {}),
        }
      }
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
      const before = Object.fromEntries(proposalUpdateFields.filter(field => Object.hasOwn(task, field)).map(field => [field, task[field]]))
      const proposal = {
        id: proposalId, scope: task.scope, taskId: task.id, kind: change.kind, baseRevision: task.revision,
        command, before, after: change.kind === 'update' ? { ...before, ...change.value } : change.value,
        ...(args.note ? { note:args.note } : {}),
      }
      const existing = store.listProposals(task.scope).find(item => item.id === proposalId)
      if (existing) {
        const same = existing.proposer === caller.actor && existing.kind === change.kind && existing.taskId === task.id && existing.scope === task.scope
          && isDeepStrictEqual(existing.command, command)
          && isDeepStrictEqual(existing.before, before) && isDeepStrictEqual(existing.after, proposal.after)
          && (existing.note ?? '') === (proposal.note ?? '')
        if (!same) throw Object.assign(new Error('operation id conflict'), { code: 'bot/invalid' })
        return { proposal: existing }
      }
      const context = { exec, caller, roomId:args.roomId, taskId: task.id, revision: task.revision, action: 'propose' }
      const saved = scope.run(context, () => store.createProposal({ operationId: args.operationId ? `proposal:${args.operationId}` : `proposal:${proposalId}`, actor: caller.actor, proposal }))
      return { proposal: saved }
    }
    if (!actions.has(args.action) || !canMutate(task, caller, args.action)) throw refused()
    if (!id(args.operationId)) throw new Error(`${args.action} requires a stable operation_id for this exact update`)
    if (!Number.isSafeInteger(args.expectedRevision) || args.expectedRevision < 1) throw new Error(`${args.action} requires expected_revision from the current card`)
    const context = { exec, caller, roomId:args.roomId, taskId: task.id, revision: args.expectedRevision, action: args.action }
    const command = { operationId: args.operationId, taskId: task.id, expectedRevision: args.expectedRevision,
      actor: caller.actor, type: args.action, ...(args.action === 'start' ? {sessionId:caller.sid} : {}),
      ...(args.action === 'reply' ? {value:{text:args.note}} : args.value === undefined ? {} : {value:args.value}) }
    const result = scope.run(context, () => store.command(command))
    // The transaction creates the durable next action. A lost notification
    // is recovered by scanning that journal; never replay a claimed input.
    if (!['progress','reply'].includes(args.action) && !isManualBoardTask(result)) {
      try { await wake() } catch (error) { onError(error) }
    }
    return { task: projectDirect(result, caller) }
  }

  function conversationKind(actor) {
    const caller=scope.getStore()?.caller, group=rt.groupOwners?.get(caller?.sid)
    return caller?.actor===actor && group?.botId===actor && rt.roomOf(group.roomId)?.sessions?.[actor]===caller.sid ? 'group' : 'private'
  }
  return { invoke, authorize, conversationKind }
}
