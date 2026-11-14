import { boardList } from './board-query.js'
import { legacyGoalCards } from './legacy-goal.js'

const has = (obj, key) => obj != null && Object.hasOwn(obj, key)
const nonempty = value => typeof value === 'string' && value.trim() !== '' && value.length <= 256
const string = (value, max) => typeof value === 'string' && value.trim() !== '' && value.length <= max
const fail = message => Object.assign(new Error(message), { code: 'bot/invalid' })

// `principal` comes from the authenticated route, never from a request body.
// The current browser principal represents the instance owner, not a Bot.
export function createBoardApi({ store, roster, assertWritable, images, goalImageReference, goalCardSnapshot, verifyShare = () => false, verifyDependency = () => false, shareTargets = () => [] }) {
  const current = () => {
    const value = roster()
    if (!value || !value.rooms || !value.bots) throw fail('Team is unavailable')
    return value
  }
  const view = (scope, principal) => {
    const state = current()
    const tasks = store.list().map(task => {
      const kind = task.status === 'reported' ? 'review' : 'execute'
      const action = ['ready','working','reported'].includes(task.status)
        ? (store.listActions?.(task.id) ?? []).find(item => item.kind === kind && item.revision === task.actionRevision) : undefined
      return action && ['pending','claimed','accepted','uncertain'].includes(action.state)
        ? { ...task, dispatchState:action.state } : task
    })
    const board = boardList({ scope, principal, rooms: state.rooms, bots: state.bots, tasks, revision: state.revision ?? null, verifyShare, verifyDependency })
    const addLegacy = () => {
      const ids = new Set(board.tasks.map(task => task.id))
      for(const task of legacyGoalCards({ scope, principal, rooms: state.rooms, bots: state.bots, pendingCard:goalCardSnapshot })) {
        if(!ids.has(task.id)){ids.add(task.id);board.tasks.push(task)}
      }
      return board
    }
    addLegacy()
    if (principal?.kind !== 'user') return board
    const isPublic = id => has(state.bots, id) && state.bots[id]?.private !== true
    const publicBots = Object.keys(state.bots).filter(isPublic)
    const ids = scope.kind === 'room'
      ? ['user', ...(state.rooms[scope.id].members ?? []).filter(isPublic)]
      : ['user', ...publicBots]
    const actors = [...new Set(ids)].map(id => ({ id, name: id === 'user' ? 'You' : (state.bots[id]?.name ?? id) }))
    let writable = false
    try { assertWritable(); writable = true } catch { /* read-only host still shows its board */ }
    const availableTargets = Object.create(null)
    const commands = Object.fromEntries(board.tasks.map(task => {
      if (!writable || task.shared) return [task.id, []]
      if (task.legacy) return [task.id, !task.legacy.ambiguous && !task.legacy.pending && Number.isSafeInteger(task.revision)
        ? [...(task.legacy.current?[{type:'goal-task-edit',label:'Edit goal task'}]:[]),
          ...(task.legacy.useOverlay?[{type:'goal-history-title',label:'Correct card title'}]:[]),
          {type:'goal-card-details',label:'Edit card details'},{type:'goal-card-comment',label:'Add comment'}, ...(images ? [{type:'upload',label:'Add images'},{type:'goal-image-remove',label:'Remove image'}] : [])] : []]
      const source = store.get(task.id), grants = source?.shares?.filter(grant => !grant.revoked) ?? []
      const targets = (source?.scope?.startsWith('room:') ? shareTargets(source) : []).filter(target => !grants.some(grant => grant.targetRoomId === target.id))
      if (targets.length) availableTargets[task.id] = targets
      const actions = source ? store.listActions?.(task.id) ?? [] : []
      const activeAction = actions.find(action => action.revision === source?.actionRevision && ['pending','claimed','accepted','uncertain'].includes(action.state))
      const canSchedule = !source?.change && ['proposed','waiting'].includes(source?.status) && source.owner !== 'user' && source.reviewer !== 'user'
        && !source.blocked && !source.stale && !activeAction && actors.some(actor => actor.id === source.owner) && actors.some(actor => actor.id === source.reviewer)
      return [task.id, [...(!source?.change ? [{ type: 'edit', label: 'Edit' }, { type:'card-details', label:'Edit card details' }] : []),
        ...(canSchedule ? [{type:'schedule',label:'Schedule Bot'}] : []), {type:'card-comment',label:'Add comment'}, ...(images ? [{ type: 'upload', label: 'Add images' }, { type: 'remove-image', label: 'Remove image' }] : []),
        ...(scope.kind === 'personal' && scope.id === 'user' && source?.scope === 'personal:user' && source.owner === 'user'
          && source.status === 'proposed' && source.actionRevision == null && !source.evidence && !source.blocked && !source.stale
          ? [{ type:'personal-progress', label:'Move personal task' }] : []),
        ...(targets.length ? [{ type:'share', label:'Share' }] : []), ...(grants.length ? [{ type:'unshare', label:'Unshare' }] : [])]]
    }))
    const taskLimit = store.limits?.().tasks
    const taskLimitReached = Number.isSafeInteger(taskLimit) && tasks.length >= taskLimit
    board.capabilities = { commands, create: writable && !taskLimitReached, upload: writable && !!images, actors, shareTargets:availableTargets,
      ...(Number.isSafeInteger(taskLimit) ? { taskCount:tasks.length, taskLimit, taskLimitReached } : {}) }
    return board
  }
  const visibleTask = (scope, principal, taskId) => {
    if (!nonempty(taskId)) throw fail('Invalid task ID')
    const board = view(scope, principal)
    const shown = board.tasks.find(task => task.id === taskId)
    if (!shown || shown.shared || shown.legacy) throw fail('Task is not available in this board')
    const task = store.get(taskId)
    if (!task) throw fail('Task is no longer available')
    return { board, task }
  }
  const taskScope = task => {
    const at = task.scope?.indexOf(':') ?? -1
    if (at < 1) throw fail('Task scope is unavailable')
    return { kind: task.scope.slice(0, at), id: task.scope.slice(at + 1) }
  }
  const bindingsFor = (scope, principal, candidate, dependencies) => {
    const bindings = []
    for (const id of dependencies) {
      const dependency = store.get(id)
      if (!dependency) throw fail('Dependency is unavailable in this board')
      if (dependency.scope === candidate.scope) continue
      if (scope.kind !== 'room') throw fail('Dependency grant is unavailable')
      const grants = (dependency.shares ?? []).filter(grant => !grant.revoked && grant.targetRoomId === scope.id && verifyShare(dependency, grant, scope, principal) === true && verifyDependency(candidate, dependency, grant) === true)
      if (grants.length !== 1) throw fail('Dependency grant is unavailable')
      bindings.push({ taskId:id, grantId:grants[0].id })
    }
    return bindings
  }
  return {
    list(scope, principal) {
      return view(scope, principal)
    },
    history(scope, principal, taskId) {
      if (principal?.kind !== 'user') throw fail('Task history is unavailable')
      visibleTask(scope, principal, taskId)
      return store.history(taskId)
    },
    operation(scope, principal, operationId) {
      if (!nonempty(operationId)) throw fail('Invalid operation ID')
      const board = view(scope, principal)
      const record = store.operation(operationId)
      if (!record || (principal?.kind !== 'user' && !board.tasks.some(task => task.id === record.taskId))) return { state: 'unknown' }
      if (record.status === 'rejected') return { state: 'rejected', message: record.message || 'Task change rejected' }
      if (record.status !== 'committed' && record.status !== undefined) return { state: 'unknown' }
      return { state: 'committed', result: record.result }
    },
    create(scope, principal, input) {
      if (principal?.kind !== 'user') throw fail('Only the instance user can create a proposal here')
      assertWritable()
      const board = view(scope, principal)
      const state = current()
      if (board.capabilities.taskLimitReached) throw fail('Task limit reached')
      if (board.capabilities.create !== true) throw fail('Board is read only')
      if (!input || !nonempty(input.operationId) || !nonempty(input.taskId) || input.taskId.startsWith('legacy-') || !string(input.title, 200) || !string(input.acceptance, 8192)
        || !nonempty(input.owner) || !nonempty(input.reviewer) || input.owner === input.reviewer) throw fail('Invalid task proposal')
      if (!Array.isArray(input.dependencies) || input.dependencies.length > 100 || input.dependencies.some(id => !nonempty(id))) throw fail('Invalid task dependencies')
      const visibleIds = new Set(board.tasks.filter(task => !task.legacy).map(task => task.id))
      if (input.dependencies.some(id => !visibleIds.has(id))) throw fail('Dependency is unavailable in this board')
      const actors = new Set(board.capabilities.actors.map(actor => actor.id))
      if (!actors.has(input.owner) || !actors.has(input.reviewer)) throw fail('Unknown task participant')
      if (scope.kind === 'room') {
        const room = state.rooms[scope.id]
        const allowed = id => id === 'user' || (room.members?.includes(id) && state.bots[id]?.private !== true)
        if (!allowed(input.owner) || !allowed(input.reviewer)) throw fail('Task participant is not available in this group')
      } else if (scope.kind === 'personal' && input.owner !== scope.id) {
        throw fail('Personal task must belong to this board owner')
      }
      if (input.personalProgress !== undefined && (scope.kind !== 'personal' || scope.id !== 'user' || input.owner !== 'user' || !['todo','doing','finished'].includes(input.personalProgress))) throw fail('Invalid personal progress')
      const candidate = { scope:`${scope.kind}:${scope.id}`, owner:input.owner, reviewer:input.reviewer }
      const dependencyGrants = bindingsFor(scope, principal, candidate, input.dependencies)
      return store.create({ operationId: input.operationId, actor: 'user', task: {
        id: input.taskId, title: input.title.trim(), owner: input.owner,
        reviewer: input.reviewer, scope: `${scope.kind}:${scope.id}`,
        acceptance: input.acceptance.trim(), dependencies: input.dependencies, dependencyGrants,
        ...(input.personalProgress !== undefined ? {personalProgress:input.personalProgress} : {}),
      } })
    },
    command(scope, principal, input) {
      if (principal?.kind !== 'user') throw fail('Only the instance user can change a task here')
      assertWritable()
      if (!input || !nonempty(input.operationId) || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) throw fail('Invalid task command')
      const { task } = visibleTask(scope, principal, input.taskId)
      let value = input.value
      if (input.type === 'edit') {
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('Invalid task edit')
        const original = view(taskScope(task), principal)
        const allowed = new Set(original.capabilities.actors.map(actor => actor.id))
        if (!allowed.has(value.owner) || !allowed.has(value.reviewer) || value.owner === value.reviewer) throw fail('Task participants are unavailable')
        if (task.scope.startsWith('personal:') && value.owner !== task.scope.slice(9)) throw fail('Personal task must belong to its board owner')
        if (!string(value.title, 200) || !string(value.acceptance, 8192) || !Array.isArray(value.dependencies)) throw fail('Invalid task edit')
        const visible = new Set(original.tasks.filter(item => !item.legacy).map(item => item.id))
        if (value.dependencies.length > 100 || value.dependencies.some(id => !nonempty(id) || !visible.has(id))) throw fail('Dependency is unavailable in this board')
        const hidden = (task.dependencies ?? []).filter(id => !visible.has(id))
        const dependencies = [...new Set([...value.dependencies, ...hidden])]
        const dependencyGrants = bindingsFor(taskScope(task), principal, { ...task, owner:value.owner, reviewer:value.reviewer }, dependencies)
        value = { title: value.title, owner: value.owner, reviewer: value.reviewer, acceptance: value.acceptance, dependencies, dependencyGrants }
        if (['working','reported','done'].includes(task.status)) return store.proposeChange({ operationId:input.operationId, taskId:task.id,
          expectedRevision:input.expectedRevision, actor:'user', value:{...value,description:task.description??''} })
      } else if (input.type === 'schedule') {
        if (task.owner === 'user' || task.reviewer === 'user') throw fail('Assign a Bot owner and independent Bot reviewer before scheduling')
        if (!['proposed','waiting'].includes(task.status) || task.blocked || task.stale || task.change) throw fail('Task is not ready to schedule')
        value = { kind:'personal', reference:`board:${task.id}:${task.revision}` }
      } else if (input.type === 'card-details' || input.type === 'card-comment') {
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('Invalid card details')
        if (input.type === 'card-details' && Object.hasOwn(value,'description') && value.description !== (task.description??'')
          && ['working','reported','done'].includes(task.status)) {
          const proposal=store.proposeChange({operationId:input.operationId,taskId:task.id,expectedRevision:input.expectedRevision,actor:'user',value:{
            title:task.title,owner:task.owner,reviewer:task.reviewer,acceptance:task.acceptance,dependencies:task.dependencies,
            dependencyGrants:task.dependencyGrants??[],description:value.description,
          }})
          const details=Object.fromEntries(Object.entries(value).filter(([key])=>key!=='description'))
          if(Object.keys(details).length)store.command({operationId:`${input.operationId}:details`,taskId:task.id,expectedRevision:input.expectedRevision,actor:'user',type:'card-details',value:details})
          return proposal
        }
      } else if (input.type === 'personal-progress') {
        if (scope.kind !== 'personal' || scope.id !== 'user' || task.scope !== 'personal:user' || task.owner !== 'user'
          || !value || !['todo', 'doing', 'finished'].includes(value.progress)) throw fail('Personal progress is unavailable')
        value = { progress:value.progress }
      } else if (input.type === 'share') {
        if (!value || !nonempty(value.targetRoomId) || !Array.isArray(value.fields)) throw fail('Invalid share request')
        value = { targetRoomId:value.targetRoomId, fields:value.fields }
      } else if (input.type === 'unshare') {
        if (!value || !nonempty(value.shareId)) throw fail('Invalid share request')
        value = { shareId:value.shareId }
      } else if (input.type === 'remove-image') {
        if (!images || !value || !nonempty(value.imageId)) throw fail('Invalid image command')
        value = { imageId: value.imageId }
      } else throw fail('Unsupported task command')
      return store.command({ operationId: input.operationId, taskId: task.id, expectedRevision: input.expectedRevision,
        actor: 'user', type: input.type, value })
    },
    upload(scope, principal, input) {
      if (principal?.kind !== 'user' || !images) throw fail('Image upload is unavailable')
      assertWritable()
      if (!input || !nonempty(input.operationId) || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) throw fail('Invalid image request')
      const { task } = visibleTask(scope, principal, input.taskId)
      // Reject a stale edit before writing any content; the journal checks again.
      if (!store.operation(input.operationId) && task.revision !== input.expectedRevision) throw fail('Task changed; refresh the board')
      const references = images.stage(task.id, input.images)
      return store.command({ operationId: input.operationId, taskId: task.id, expectedRevision: input.expectedRevision,
        actor: 'user', type: 'attach', value: { images: references } })
    },
    uploadPrepared(scope, principal, input, references) {
      if (principal?.kind !== 'user' || !images) throw fail('Image upload is unavailable')
      assertWritable()
      if (!input || !nonempty(input.operationId) || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1 || !Array.isArray(references)) throw fail('Invalid image request')
      const { task } = visibleTask(scope, principal, input.taskId)
      if (task.revision !== input.expectedRevision) throw fail('Task changed; refresh the board')
      return store.command({ operationId: input.operationId, taskId: task.id, expectedRevision: input.expectedRevision,
        actor: 'user', type: 'attach', value: { images: references } })
    },
    image(scope, principal, taskId, imageId) {
      if (!images || !nonempty(imageId)) throw fail('Image is unavailable')
      const shown=view(scope,principal).tasks.find(item=>item.id===taskId)
      if(shown?.legacy && typeof goalImageReference==='function') {
        const item=goalImageReference(scope,taskId,imageId)
        return images.read(item.taskId,item.reference)
      }
      const { task } = visibleTask(scope, principal, taskId)
      const reference = task.attachments?.find(item => item.id === imageId)
      if (!reference) throw fail('Image is unavailable')
      return images.read(task.id, reference)
    },
    imageReference(scope, principal, taskId, imageId) {
      if (!images || !nonempty(imageId)) throw fail('Image is unavailable')
      const shown=view(scope,principal).tasks.find(item=>item.id===taskId)
      if(shown?.legacy && typeof goalImageReference==='function')return goalImageReference(scope,taskId,imageId)
      const { task } = visibleTask(scope, principal, taskId)
      const reference = task.attachments?.find(item => item.id === imageId)
      if (!reference) throw fail('Image is unavailable')
      return { taskId:task.id, reference }
    },
  }
}
