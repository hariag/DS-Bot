import { isManualBoardTask } from './board-intake.mjs'
import { legacyGoalCards } from './legacy-goal.js'
import { mkdirSync, lstatSync, readFileSync, writeFileSync } from 'node:fs'
import { link, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { boardRegistrationReference, openTaskStore } from './task-store.mjs'
import { createBoardApi } from './board-api.js'
import { readBoardImage } from './board-images.js'
import { buildReleaseReport, lifecyclePlan, resolveReleaseTeam } from './release-team.mjs'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { isDeepStrictEqual } from 'node:util'
import { installHostWorkflow } from './host-workflow.mjs'
import { createTaskDriver } from './task-driver.mjs'
import { createGoalBoardEditor } from './goal-board-editor.js'
import { userRedoView } from './user-redo-view.mjs'
import { createUserRedoPreparation } from './user-redo-preparation.mjs'
import { isPrivateDirectory, isPrivateFile } from './private-storage.mjs'
import { syncDirectory } from './directory-sync.mjs'

export const BOARD_UPLOAD_PATH = '/api/bot-board-upload'
export const BOARD_UPLOAD_MAX_BYTES = Math.ceil(20 * 1024 * 1024 / 3) * 4 + 1024 * 1024
const principal = Object.freeze({ kind: 'user', id: 'user' })
const fail = (message, code = 'bot/invalid') => ({ ok: false, error: { code, message, details: {} } })
const ok = value => ({ ok: true, value })
const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } })
const rejectedMessages = new Set(['revision conflict', 'operation id conflict', 'task id exists', 'task limit reached', 'unknown task', 'unknown dependency', 'dependency cycle', 'dependency graph too large', 'reviewer must be independent', 'invalid fields', 'invalid card details', 'invalid card comment', 'unknown card comment', 'card comment limit reached', 'invalid reorder', 'reorder target unavailable', 'cards must be in the same lane', 'invalid position', 'invalid position order', 'invalid dependencies', 'invalid dependency grants', 'dependency grant unavailable', 'invalid attachments', 'invalid attachment reference', 'attachment unverified', 'attachment id conflict', 'too many attachments', 'unknown attachment', 'empty edit', 'responsibility or acceptance change requires separate reconciliation', 'share not authorized', 'share unavailable', 'share already exists or limit reached', 'personal progress unavailable', 'invalid personal progress', 'authority evidence unverified', 'task authority unavailable', 'task is not schedulable', 'task is not scheduled', 'finish or cancel active work before archiving', 'remove the card from its release before archiving', 'task action unavailable', 'invalid state', 'invalid draft state', 'invalid cancellation reason', 'task action unresolved', 'invalid release', 'release id exists', 'invalid release position', 'invalid release update', 'empty release update', 'release revision conflict', 'release is not editable', 'release is not startable', 'release is not queueable', 'release is not cancellable', 'release has active work', 'invalid release queue', 'release has no items', 'release unavailable', 'release task unavailable', 'another release is running in this scope', 'invalid release assignment', 'invalid release removal', 'invalid proposal', 'invalid proposal kind', 'invalid proposal status', 'proposal id exists', 'proposal limit reached', 'proposal revision conflict', 'proposal decision is not authorized', 'Proposal is unavailable', 'Task changed after this proposal was made', 'Invalid proposal decision'])
const rejected = error => error?.code === 'bot/invalid' || (!error?.code && typeof error?.message === 'string' && (rejectedMessages.has(error.message) || ['change proposal unavailable','change proposal already exists','change proposal is immutable'].includes(error.message) || /^invalid (task id|operation id|actor|owner|reviewer|scope|title|acceptance|attachment id|image id|revision)$/.test(error.message)))
const requestKey = (endpoint, payload) => {
  if (endpoint !== 'board-upload' || !Array.isArray(payload?.images)) return { endpoint, payload }
  return { endpoint, payload: { ...payload, images: payload.images.map(image => image && typeof image === 'object' && typeof image.data === 'string'
    ? { ...image, data: { sha256: createHash('sha256').update(image.data).digest('hex') } } : image) } }
}

function privateDirectory(path, assertWritable) {
  try { lstatSync(path) } catch (error) {
    if (error.code !== 'ENOENT') throw error
    assertWritable()
    try { mkdirSync(path, { mode: 0o700 }) } catch (e) { if (e.code !== 'EEXIST') throw e }
  }
  const stat = lstatSync(path)
  if (!isPrivateDirectory(path, stat)) throw new Error('Board directory is not private')
}

// User requests and scoped Bot tools share one journal and transaction authority.
export function install(rt) {
  const { ctx } = rt
  const active = new Set(), readers = new Set(), workers = new Set(), imageWaiters = [], uploadWaiters = []
  let imageReads = 0, uploads = 0
  let closing = false, closePromise, instance, releaseTimer
  const writable = () => {
    if (closing || rt.stopping) throw new Error('Board service is closing')
    if (rt.readOnly() !== undefined) throw new Error('Board is read-only')
    rt.requireHomeLock()
  }
  const run = fn => {
    if (closing || rt.stopping) return Promise.reject(new Error('Board service is closing'))
    const pending = (async () => { await rt.load(); if (closing || rt.stopping) throw new Error('Board service is closing'); return fn() })()
    active.add(pending); return pending.finally(() => active.delete(pending))
  }
  const releaseReport = release => {
    const tasks = service().store.list().filter(task => task.scope === release.scope)
    const cards = new Set(tasks.filter(task => task.releaseId === release.id).map(task => task.id))
    const items = tasks.filter(task => cards.has(task.id) || cards.has(task.parentTaskId))
    const { markdown, html } = buildReleaseReport(release, items, rt.state?.bots ?? {})
    const directory = join(service().root, 'release-reports', release.id)
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const markdownPath = join(directory, 'summary.md'), htmlPath = join(directory, 'summary.html')
    writeFileSync(markdownPath, markdown, { mode: 0o600 })
    writeFileSync(htmlPath, html, { mode: 0o600 })
    return { markdownPath, htmlPath, generatedAt: Date.now() }
  }
  const applyReleasePlan = (scope, release, requirement, principal, cardType = 'feature', operationId) => {
    const text = typeof requirement === 'string' ? requirement.trim() : ''
    if (!text || text.length > 2000) throw new Error('Describe the requirement in 1 to 2000 characters before planning')
    if (!['feature','bugfix'].includes(cardType)) throw new Error('The release card must be a feature or bugfix')
    if (!release.roles || !release.projectManagerId) throw new Error('Release team is not configured')
    const { store, api } = service()
    const payload = { type:'release-plan', scope:release.scope, releaseId:release.id, requirement:text, cardType }
    const key = 'plan-' + createHash('sha256').update(JSON.stringify([release.scope, release.id, text])).digest('hex')
    const description = `Release requirement: ${text}`
    const persist = (id, fn) => {
      const result = store.request({ operationId:id, actor:'user', taskId:release.id, payload, isRejection:() => false }, fn)
      if (result.state !== 'committed') throw new Error(result.message || 'Release plan is unavailable')
      return result.value
    }
    const materialize = () => {
      // Old releases stored each step as a release card. Reuse its original creation
      // receipt even if someone later edited the visible title or description.
      const legacySteps = ['requirement','design','test-plan','ui','backend','frontend','test-run','review','deploy','operations','summary']
      const existing = store.list().filter(task => task.scope === release.scope)
      for (const task of existing) {
        const step = legacySteps.find(key => task.id.endsWith(`-${release.id}-${key}`))
        if (!step) continue
        const suffix = `-${release.id}-${step}`
        const prefix = task.id.slice(0, -suffix.length)
        const original = store.operation(`${prefix}:${release.id}:${step}`)?.result
        if (original?.id !== task.id || original.description !== description) continue
        const tasks = legacySteps.flatMap(key => {
          const id = `${prefix}-${release.id}-${key}`
          const receipt = store.operation(`${prefix}:${release.id}:${key}`)?.result
          if (receipt?.id !== id || receipt.description !== description) return []
          const current = store.get(id)
          return current?.scope === release.scope && current.releaseId === release.id ? [{ key, taskId:id, title:current.title }] : []
        })
        if (!tasks.some(item => item.key === 'summary')) throw new Error('Existing release plan is incomplete. Reconcile its original cards before replanning.')
        return { releaseId:release.id, tasks }
      }
      if (!['draft','queued'].includes(release.status)) throw new Error('Release is not editable')
      const taskId = step => `${key}-${step}`
      const plan = lifecyclePlan({ release, requirement:text, roles:release.roles, cardType })
      const parent = plan.find(item => item.key === 'summary')
      const create = (item, parentTaskId, dependencies) => api.create(scope, principal, {
        operationId:`${key}:create:${item.key}`, taskId:taskId(item.key), ...(parentTaskId ? { parentTaskId } : {}),
        title:item.title, owner:item.owner, reviewer:item.reviewer, acceptance:item.acceptance,
        type:item.type, description, dependencies:dependencies.map(taskId),
      })
      const card = create(parent, undefined, [])
      const assigned = store.assignRelease({ operationId:`${key}:assign`, actor:'user', releaseId:release.id,
        expectedReleaseRevision:release.revision, taskId:card.id, expectedTaskRevision:card.revision })
      for (const item of plan) if (item !== parent) create(item, card.id, item.dependencies)
      store.command({ operationId:`${key}:dependencies`, taskId:card.id, expectedRevision:assigned.revision,
        actor:'user', type:'edit', value:{ dependencies:parent.dependencies.map(taskId), dependencyGrants:[] } })
      return { releaseId:release.id, cardId:card.id, tasks:plan.map(item => ({ key:item.key, taskId:taskId(item.key), title:item.title })) }
    }
    const apply = () => persist(key, materialize)
    return operationId !== undefined && operationId !== key ? persist(operationId, apply) : apply()
  }
  const notifyRelease = async (release, text, note = 'release status') => {
    if (!release?.groupId) return
    const room = rt.roomOf?.(release.groupId), pm = rt.botOf?.(release.projectManagerId)
    if (!room || !pm || pm.private === true || !room.members?.includes(pm.id)) return
    if (release.scope.startsWith('room:') && !rt.roomOf?.(release.scope.slice(5))?.members?.includes(pm.id)) return
    try {
      if (typeof rt.postToRoom === 'function') await rt.postToRoom(room, pm, text, { quiet:true })
      if (typeof rt.deliver === 'function' && typeof rt.chatOf === 'function') {
        await rt.deliver({ toId:pm.id, fromName:'You', sessionId:rt.chatOf(pm.id), role:'request', note, text })
      }
    } catch (error) { rt.warn?.('ds-bot: release status not delivered: %s', error) }
  }
  // A Bot's proposal may only be confirmed while the proposing Bot still holds the
  // owner/reviewer role it proposed from. The task revision check catches a reassigned
  // card, but not a Bot deleted or made private, or a member removed from its group.
  const proposerStillAuthorized = proposal => {
    const proposer = proposal?.proposer
    if (typeof proposer !== 'string' || !proposer || proposer === 'user') return true
    const bot = rt.botOf?.(proposer)
    if (!bot || bot.private === true) return false
    const scope = typeof proposal.scope === 'string' ? proposal.scope : ''
    if (proposal.kind === 'create') {
      if (scope.startsWith('room:')) {
        const room = rt.roomOf?.(scope.slice(5))
        return !!room && Array.isArray(room.members) && room.members.includes(proposer)
      }
      return scope === `personal:${proposer}`
    }
    const task = proposal.taskId ? service().store.get(proposal.taskId) : undefined
    if (!task || (proposer !== task.owner && proposer !== task.reviewer)) return false
    const taskScope = typeof task.scope === 'string' ? task.scope : ''
    if (taskScope.startsWith('room:')) {
      const room = rt.roomOf?.(taskScope.slice(5))
      return !!room && Array.isArray(room.members) && room.members.includes(proposer)
    }
    return taskScope.startsWith('personal:')
  }
  // Content, status, responsibility and release membership all belong to the item a
  // release is delivering, so the release group and project manager hear about them.
  const releaseSyncTypes = new Set(['edit','card-details','card-comment','card-comment-edit','card-comment-delete','attach','remove-image','submit','cancel','restore','archive','unarchive','release-assign','schedule','unschedule'])
  const notifyBoardChange = async (taskId, change, releaseId) => {
    if (!taskId) return
    const task = service().store.get(taskId)
    if (!task) return
    const id = releaseId ?? task.releaseId ?? (task.parentTaskId && service().store.get(task.parentTaskId)?.releaseId)
    if (!id) return
    const release = service().store.getRelease(id)
    if (!release) return
    const value = change?.value
    const summary = value && typeof value === 'object' && !Array.isArray(value)
      ? Object.keys(value).map(key => `${key}=${JSON.stringify(value[key]).slice(0, 300)}`).join(', ')
      : ''
    await notifyRelease(release, `Board change on "${task.title}" (${task.id}): ${change?.type ?? 'update'}${summary ? ' · ' + summary : ''}. Current task revision ${task.revision}, status ${task.status}. Inspect the card and adjust the affected work or reassign it.`, 'board change')
  }
  // A release can be published from the task journal itself when its last review passes
  // (task-store auto-advance). That path bypasses checkRelease, so generate the report and
  // tell the release group for every published release that is still missing one.
  const reporting = new Set()
  const ensureReleaseReport = async releaseId => {
    if (reporting.has(releaseId)) return undefined
    reporting.add(releaseId)
    try {
      const release = service().store.getRelease(releaseId)
      if (!release || release.status !== 'published' || release.report) return undefined
      const report = releaseReport(release)
      const saved = service().store.setReleaseReport({ releaseId, report })
      await notifyRelease(saved, `Release ${saved.name} ${saved.version ?? ''} 已完成全部发布项和门禁检查，版本已发布。总结报告已生成：${report.markdownPath}`)
      return service().store.getRelease(releaseId)
    } finally { reporting.delete(releaseId) }
  }
  const sweepReleaseReports = async () => {
    let reported = false
    for (const release of service().store.listPublishedWithoutReport?.() ?? []) {
      try { if (await ensureReleaseReport(release.id)) reported = true }
      catch (error) { rt.warn?.('ds-bot: release report for %s: %s', release.id, error?.message || error) }
    }
    if (reported) notifyDriver()
  }
  const checkAndReportRelease = async (releaseId, operationId) => {
    const release = service().store.getRelease(releaseId)
    if (!release || release.status !== 'running') return release
    const result = service().store.checkRelease({ operationId, actor:'user', releaseId, expectedRevision:release.revision })
    if (result.status === 'published') {
      await ensureReleaseReport(releaseId)
      // Publishing starts the next queued release; its items need the scheduler now.
      notifyDriver()
      return service().store.getRelease(releaseId)
    }
    if (result.status === 'failed') await notifyRelease(result, `Release ${result.name} 失败：${result.failure ?? '发布条件无法满足'}`)
    return result
  }
  const monitorReleases = async () => {
    if (closing || rt.stopping) return
    for (const release of service().store.listRunningReleases()) {
      try { await checkAndReportRelease(release.id, `release-monitor:${release.id}:${release.revision}`) }
      catch (error) { rt.warn?.('ds-bot: release monitor %s: %s', release.id, error?.message || error) }
    }
    await sweepReleaseReports()
  }
  const validBoardAuthority = task => {
    const reference = task?.authority?.reference
    const prefix = `board:${task?.id}:`
    if (task?.authority?.kind !== 'personal' || typeof task.id !== 'string' || typeof reference !== 'string' || !reference.startsWith(prefix)) return false
    const revision = Number(reference.slice(prefix.length))
    return Number.isSafeInteger(revision) && revision > 0 && revision <= task.revision && reference === boardRegistrationReference({ id:task.id, revision })
  }
  const currentBinding = task => {
    if ((!validBoardAuthority(task) && !isManualBoardTask(task)) || !task.scope || typeof task.scope !== 'string') return false
    const participants = [task.owner, task.reviewer]
    if (task.scope.startsWith('room:')) {
      const room = rt.roomOf(task.scope.slice(5))
      return !!room && Array.isArray(room.members) && participants.every(id => id === 'user'
        || (Object.hasOwn(rt.state.bots, id) && rt.state.bots[id]?.private !== true && room.members.includes(id)))
    }
    if (!task.scope.startsWith('personal:') || task.scope.slice(9) !== task.owner) return false
    return participants.every(id => id === 'user' || (Object.hasOwn(rt.state.bots, id) && rt.state.bots[id]?.private !== true))
  }
  const taskParticipant = (task, actor) => {
    if (!currentBinding(task) || actor === 'user' || ![task.owner, task.reviewer].includes(actor)) return false
    const bot = rt.botOf(actor)
    if (!bot || bot.private === true) return false
    if (task.scope.startsWith('room:')) return rt.roomOf(task.scope.slice(5))?.members?.includes(actor) === true
    return task.scope.slice(9) === task.owner
  }
  const goalAllows = (task, actor) => {
    if (!task.scope.startsWith('room:')) return true
    const room = rt.roomOf(task.scope.slice(5))
    return !!room && typeof rt.goalDispatchBlocked === 'function' && rt.goalDispatchBlocked(room, actor) === false
  }
  const dependenciesReady = task => (task.dependencies ?? []).every(id => {
    const dependency = instance?.store.get(id)
    if (!dependency || dependency.status !== 'done' || dependency.stale === true) return false
    if (dependency.scope === task.scope) return true
    const binding = (task.dependencyGrants ?? []).find(item => item.taskId === id)
    const grant = dependency.shares?.find(item => item.id === binding?.grantId && !item.revoked)
    return !!grant && instance.shareAllowed(dependency, task.scope.slice(5))
      && instance?.store && instance.dependencyAllowed?.(task, dependency, grant) === true
  })
  const allowedAction = (task, action) => {
    if (!validBoardAuthority(task) || !action || action.actor === 'user' || !taskParticipant(task, action.actor) || !goalAllows(task, action.actor)
      || task.blocked || task.stale || !dependenciesReady(task)) return false
    return action.kind === 'execute'
      ? task.owner === action.actor && task.status === 'ready' && task.actionRevision === action.revision
      : action.kind === 'review' && task.reviewer === action.actor && task.reviewer !== task.owner && task.status === 'reported' && task.actionRevision === action.revision
  }
  const taskPrompt = (task, action) => {
    const detail = [
      `Task ID: ${task.id} (revision ${task.revision})`,
      `Title: ${task.title}`,
      `Acceptance criteria: ${task.acceptance}`,
      ...(task.description ? [`Description: ${task.description}`] : []),
      ...(task.dependencies?.length ? [`Dependencies: ${task.dependencies.join(', ')}`] : []),
    ]
    if (task.change) detail.push(`Requirement change from ${task.change.sourceTaskId} revision ${task.change.sourceRevision}. The original task remains unchanged.`,
      `Before: ${JSON.stringify(task.change.before)}`, `After: ${JSON.stringify(task.change.after)}`,
      'Compare the two revisions, inspect the current implementation and any queued or in-flight work, adjust what is needed or explicitly reassign it, then report evidence with board_task report. Do not silently rewrite the source task.')
    if (action.kind === 'review') detail.push(`Owner report: ${JSON.stringify(task.evidence)}`,
      'Independently compare the report with the acceptance criteria. Do not repeat the owner’s work. Use board_task review with evidence and pass or rework.')
    else detail.push('Use board_task show first. As the assigned owner, use board_task start, do only this task and its stated dependencies, then report evidence with board_task report. Respect this task’s scope, all authorization limits and the 30-step turn budget.')
    return detail.join('\n')
  }
  const botWorkflowEvidence = (task, value, actor, phase) => currentBinding(task) && goalAllows(task, actor)
    && (phase === 'report' ? actor === task.owner && taskParticipant(task, actor) && value?.kind === 'personal'
      : (phase === 'review' || phase === 'revalidate') && actor === task.reviewer && actor !== task.owner
        && (actor === 'user' || taskParticipant(task, actor)) && value?.kind !== 'git')
  const botWorkflow = installHostWorkflow(rt, {
    defineTool, run, getStore: () => service().store, pendingGoalCard:id => instance?.goalEditor.pendingCard(id),
    goalReply:(...args) => service().goalEditor.botReply(...args),
    // A Bot command may be the review that publishes a release inside the journal
    // transaction; sweep its report before handing the scheduler the next action.
    wake: () => { void sweepReleaseReports().catch(error => rt.warn?.('ds-bot: release report sweep: %s', error?.message || error)); return instance?.driver.wake() },
    verifyBinding: (task, room) => {
      const current = instance?.store.get(task.id)
      return !!current && current.revision === task.revision && currentBinding(current) && current.scope === `room:${room?.id}`
    },
    verifyEvidence: botWorkflowEvidence,
    verifyShare: (task, grant, target) => {
      const current = instance?.store.get(task.id)
      const saved = current?.shares?.find(item => item.id === grant?.id)
      return !!saved && current.revision === task.revision && isDeepStrictEqual(saved, grant)
        && instance.shareAllowed(current, target?.id)
    },
  })
  const service = () => {
    if (instance) return instance
    const root = join(rt.home, 'board-v1'), imageDir = join(root, 'images')
    privateDirectory(root, writable); privateDirectory(imageDir, writable)
    const shareAllowed = (task, target) => {
      if (!task || !task.scope.startsWith('room:') || typeof target !== 'string') return false
      const source = task.scope.slice(5), rooms = rt.state.rooms, bots = rt.state.bots
      if (source === target || !Object.hasOwn(rooms, source) || !Object.hasOwn(rooms, target) || !Array.isArray(rooms[source].members) || !Array.isArray(rooms[target].members)) return false
      const member = id => id === 'user' || (Object.hasOwn(bots, id) && bots[id]?.private !== true && rooms[source].members?.includes(id))
      return member(task.owner) && member(task.reviewer)
    }
    const dependencyAllowed = (task, dependency, grant) => {
      if (!task?.scope.startsWith('room:') || !grant || grant.revoked || grant.taskId !== dependency?.id || grant.grantedBy !== 'user') return false
      const target = task.scope.slice(5), room = rt.state.rooms[target], bots = rt.state.bots
      if (grant.targetRoomId !== target || !shareAllowed(dependency, target) || !Array.isArray(room?.members)) return false
      const member = id => id === 'user' || (Object.hasOwn(bots, id) && bots[id]?.private !== true && room.members.includes(id))
      return member(task.owner) && member(task.reviewer)
    }
    const proofs = new Map(), admissionProofs = new Map()
    const store = openTaskStore(join(root, 'tasks.sqlite'), {
      assertWriteLock: writable,
      authorize: input => (input.actor === 'user' && ['create', 'link-goal-items', 'edit', 'card-details', 'card-comment', 'card-comment-edit', 'card-comment-delete', 'reorder', 'attach', 'remove-image', 'cancel', 'submit', 'restore', 'archive', 'unarchive', 'release-assign', 'release', 'proposal', 'share', 'unshare', 'personal-progress', 'schedule', 'unschedule'].includes(input.type))
        || (input.actor === 'scheduler' && (input.type === 'claim' ? allowedAction(input.task, input.action) : input.type === 'receipt'))
        || (input.actor !== 'user' && input.type === 'proposal' && botWorkflow.authorize(input))
        || botWorkflow.authorize(input),
      verifyGoalItems: task => {
        const goals = legacyGoalCards({scope:{kind:'room', id:task.scope.slice(5)}, principal, rooms:rt.state.rooms,
          bots:rt.state.bots, pendingCard:id => instance?.goalEditor.pendingCard(id)})
        const done = new Set(goals.filter(row => row.legacy.originalStatus === 'done' && !row.legacy.ambiguous && !row.legacy.pending).map(row => row.id))
        return task.goalItemIds.every(id => done.has(id))
      },
      verifyRegistration: (task, value, actor) => {
        if (actor !== 'user' || value?.kind !== 'personal' || !task || !currentBinding({ ...task, authority:value })) return false
        const prefix = `board:${task.id}:`
        if (typeof value.reference !== 'string' || !value.reference.startsWith(prefix)) return false
        const revision = Number(value.reference.slice(prefix.length))
        return Number.isSafeInteger(revision) && revision > 0 && revision <= task.revision
          && value.reference === boardRegistrationReference({ id:task.id, revision })
      },
      verifyEvidence: (task, value, actor, phase) => botWorkflowEvidence(task, value, actor, phase),
      verifyShare: (task, value, actor) => actor === 'user' && shareAllowed(task, value.targetRoomId),
      verifyDependency: dependencyAllowed,
      verifyAttachment: (task, item, actor) => {
        if (actor !== 'user') return false
        const proof = proofs.get(item.id)
        if (!proof || proof.taskId !== task.id || JSON.stringify(proof.reference) !== JSON.stringify(item)) return false
        try {
          const s = lstatSync(join(imageDir, proof.name))
          return isPrivateFile(join(imageDir, proof.name), s)
            && s.dev === proof.stat.dev && s.ino === proof.stat.ino && s.size === proof.stat.size && s.mtimeMs === proof.stat.mtimeMs
        } catch { return false }
      },
      verifyAdmission: (task, action, intent) => {
        if (!allowedAction(task, action) || typeof rt.prepareBoardTaskMessage !== 'function') return false
        try {
          const source = intent?.payload?.source
          const expected = rt.prepareBoardTaskMessage({ toId:action.actor, sessionId:intent.targetSessionId,
            text:taskPrompt(task, action), messageId:intent.messageId, exchangeId:source?.exchangeId,
            actionId:action.id, taskRevision:task.revision, actionRevision:action.revision })
          return intent.targetBotId === action.actor && isDeepStrictEqual(expected, intent.payload)
        } catch { return false }
      },
      verifyReceipt: (action, state, receipt, intent) => {
        const saved = store.admission(action.id), proof = admissionProofs.get(action.id)
        const sameIntent = saved && saved.admissionId === intent?.admission_id && saved.messageId === intent?.message_id
          && saved.targetSessionId === intent?.target_session_id && saved.targetBotId === intent?.target_bot_id
        if (!sameIntent) return false
        if (state === 'uncertain' && action.state === 'claimed' && receipt === 'admission outcome unknown') return true
        return !!proof && proof.receipt === receipt && proof.messageId === intent.message_id
          && proof.targetSessionId === intent.target_session_id && proof.actionId === action.id
          && (state === 'accepted' && action.state === 'claimed' || state === 'uncertain' && action.state === 'accepted')
      },
    })
    const interrupted = store.holdInterruptedAdmissions()
    if (interrupted) rt.warn?.('ds-bot: board scheduler: held %s interrupted admission(s) for review', interrupted)
    const busySession = (sessionId, actionId) => store.list().some(task => store.listActions(task.id).some(action => {
      if (action.id === actionId || !['claimed','accepted','uncertain'].includes(action.state)) return false
      return store.admission(action.id)?.targetSessionId === sessionId
    }))
    const admission = {
      available: async () => {
        if (closing || rt.stopping || typeof rt.deliver !== 'function' || typeof rt.prepareBoardTaskMessage !== 'function') return false
        try { writable(); return true } catch { return false }
      },
      prepare: async (action, task) => {
        if (!allowedAction(task, action)) return undefined
        const sessionId = rt.chatOf(action.actor)
        if (typeof sessionId !== 'string' || !sessionId || busySession(sessionId, action.id)) return undefined
        if (!allowedAction(store.get(task.id), action)) return undefined
        const messageId = randomUUID(), exchangeId = randomUUID()
        const payload = rt.prepareBoardTaskMessage({ toId:action.actor, sessionId, text:taskPrompt(task, action),
          messageId, exchangeId, actionId:action.id, taskRevision:task.revision, actionRevision:action.revision })
        return { admissionId:`board:${action.id}:${randomUUID()}`, messageId, targetBotId:action.actor, targetSessionId:sessionId, payload }
      },
      admit: async ({ action, task, intent, revalidateNow, commitReceipt }) => {
        const source = intent.payload.source
        const receipt = `dsh-message:${intent.messageId}`
        let committed = false
        const sameMessage = (agent, message) => agent?.id === intent.targetSessionId && isDeepStrictEqual(message, intent.payload)
        const result = await rt.deliver({ toId:action.actor, fromName:'You', sessionId:intent.targetSessionId,
          role:'request', note:'task from Trello', text:taskPrompt(task, action),
          exchangeId:source.exchangeId, taskAction:source.taskAction }, {
          preparedMessage:intent.payload,
          beforeAdmission: (agent, message) => {
            if (!sameMessage(agent, message) || !revalidateNow()) throw new Error('Task authorization changed before DSH admission')
          },
          afterAdmission: (agent, message) => {
            if (!sameMessage(agent, message)) throw new Error('DSH admitted a different task message')
            admissionProofs.set(action.id, { receipt, messageId:intent.messageId, targetSessionId:intent.targetSessionId, actionId:action.id })
            commitReceipt(receipt); committed = true
          },
        })
        if (!committed || result !== source.exchangeId) throw new Error('Task delivery receipt is incomplete')
        return receipt
      },
    }
    const images = {
      read: (taskId, reference) => readBoardImage({ directory: imageDir, taskId, reference }),
    }
    const goalEditor=createGoalBoardEditor(rt)
    const api = createBoardApi({ store, images, assertWritable: writable, roster: () => rt.state, verifyDependency: dependencyAllowed,
      goalImageReference:(scope,taskId,imageId)=>goalEditor.imageReference(scope,taskId,imageId),
      goalCardSnapshot:taskId=>goalEditor.pendingCard(taskId),
      shareTargets: task => Object.entries(rt.state.rooms).filter(([id]) => shareAllowed(task, id)).map(([id, room]) => ({ id, name:typeof room.name === 'string' && room.name ? room.name : id })),
      verifyShare: (task, grant, scope, viewer) => grant?.taskId === task.id && grant.grantedBy === 'user' && !grant.revoked && grant.targetRoomId === scope.id
        && Array.isArray(grant.fields) && grant.fields.includes('status') && grant.fields.every(field => ['status','title'].includes(field))
        && shareAllowed(task, scope.id) && (viewer.kind === 'user' || (viewer.kind === 'bot' && rt.state.rooms[scope.id].members?.includes(viewer.id))) })
    try {
      botWorkflow.bind(store)
      const driver = createTaskDriver({ store, admission,
        authorized: (action, task) => allowedAction(store.get(task.id), action),
        authorizedNow: (action, task) => allowedAction(store.get(task.id), action),
        onError: error => rt.warn?.('ds-bot: board scheduler: %s%s', error?.message || 'unknown error',
          process.env.DSBOT_BOARD_DEBUG === '1' && error?.stack ? '\n' + error.stack : '') })
      instance = { store, api, root, imageDir, proofs, admissionProofs, shareAllowed, dependencyAllowed, driver, goalEditor }
      if (!releaseTimer) {
        releaseTimer = setInterval(() => { void monitorReleases().catch(error => rt.warn?.('ds-bot: release monitor: %s', error?.message || error)) }, Math.max(1000, Number(process.env.DS_BOT_RELEASE_MONITOR_MS ?? 30_000)))
        releaseTimer.unref?.()
      }
      queueMicrotask(notifyDriver)
      return instance
    } catch (error) { store.close(); throw error }
  }
  const notifyDriver = () => {
    if (!instance || closing || rt.stopping) return
    void run(() => instance?.driver.wake()).catch(error => rt.warn?.('ds-bot: board scheduler: %s', error?.message || 'unknown error'))
  }
  // A human edit can arrive between two working steps. Notify the current owner
  // in the original session; the card and its revision remain the durable record.
  // A card already holds the durable update. Only steer a turn that was actually
  // running for this owner, including after async Session resolution.
  const activeBoardRecipient = (owner, roomId, sessionId, groupOnly = false) => {
    if (!sessionId || typeof rt.deliver !== 'function' || rt.selfOf?.(sessionId) !== owner) return
    const bot = rt.botOf(owner)
    if (!bot || bot.private === true) return
    const room = roomId && rt.roomOf(roomId)
    if (roomId && (!room?.members?.includes(owner) || rt.goalDispatchBlocked?.(room, owner) !== false)) return
    const entry = rt.groupOwners?.get(sessionId)
    if (entry) {
      if (entry.roomId !== roomId || entry.botId !== owner || room?.sessions?.[owner] !== sessionId) return
    } else if (groupOnly || rt.chatOf(owner) !== sessionId) return
    const turn = rt.live?.get(sessionId)?.turn
    if (turn !== undefined) return { owner, roomId, sessionId, turn, groupOnly, group:!!entry }
  }
  const steerBoardUpdate = async (recipient, text, operationId) => {
    if (!recipient) return
    const {owner, roomId, sessionId, turn, groupOnly, group} = recipient
    const current = () => {
      const active = activeBoardRecipient(owner, roomId, sessionId, groupOnly)
      return active?.turn === turn && active.group === group
    }
    if (!current()) return
    // A room invocation or a request expects another answer. This relay supplies
    // context to the existing turn and carries no downstream work or reply route.
    let changedTurn = false
    try {
      await rt.deliver({toId:owner, sessionId, ...(group ? {roomId} : {}), role:'board-update', fromName:'You',
        text, steer:true, note:'board update', exchangeId:`board-edit:${operationId}`},
        {beforeAdmission() {
          if (current()) return
          changedTurn = true
          throw new Error('Board update recipient turn changed')
        }})
    } catch (error) { if (!changedTurn) throw error }
  }
  const notifyWorkingBot = async (taskId, change, operationId) => {
    const task = service().store.get(taskId)
    if (!task || !['working','reported','cancelled'].includes(task.status)) return
    const roomId = task.scope.startsWith('room:') ? task.scope.slice(5) : undefined
    const recipient = activeBoardRecipient(task.owner, roomId, task.workSessionId)
    const text = `Human board update for existing task ${task.id} (${change.type}, status ${task.status}, revision ${task.revision}). `
      + (change.value?.changeTaskId ? `Read change request ${change.value.changeTaskId} as well. ` : '')
      + 'Read this card with board_task show before the next work step. Reconcile the new scope, stage or user reply; stop work if cancelled. Do not create or dispatch a second task.'
    await steerBoardUpdate(recipient, text, operationId)
  }
  const mutate = (endpoint, payload) => {
    const { api, store } = service(), scope = payload.scope
    let committedHere = false
    const outcome = store.request({ operationId: payload.operationId, actor: 'user', taskId: payload.taskId, payload: requestKey(endpoint, payload), isRejection: rejected }, () => {
      committedHere = true
      if (payload.type === 'create') {
        if (!payload.value || typeof payload.value !== 'object' || Array.isArray(payload.value)) throw Object.assign(new Error('Invalid task proposal'), { code: 'bot/invalid' })
        const { schedule, ...value } = payload.value
        const created = api.create(scope, principal, { ...value, operationId: payload.operationId, taskId: payload.taskId })
        if (schedule !== true) return created
        return api.command(scope, principal, { operationId:`${payload.operationId}:schedule`, taskId:created.id,
          expectedRevision:created.revision, type:'schedule' })
      }
      return api.command(scope, principal, payload)
    })
    if (outcome.state === 'rejected') throw Object.assign(new Error(outcome.message), { code: 'bot/invalid' })
    const result = outcome.value
    // An edit of active work creates a change-request task instead of rewriting the card;
    // tell the release group that, rather than claiming the source card changed.
    const change = result?.change
      ? { type:'change-request', value:{ changeTaskId: result.id, sourceTaskId: result.change.sourceTaskId, fields: Object.keys(result.change.after ?? {}) } }
      : payload
    if (committedHere && ['edit','card-details','card-comment','card-comment-edit','card-comment-delete','cancel','unschedule'].includes(payload.type)) {
      void notifyWorkingBot(payload.taskId, change, payload.operationId).catch(error => rt.warn?.('ds-bot: board update delivery: %s', error))
    }
    if (committedHere && releaseSyncTypes.has(payload.type)) void notifyBoardChange(payload.taskId, change).catch(error => rt.warn?.('ds-bot: board change not synced to release group: %s', error))
    return result
  }
  let redoPreparation
  const boardCall = (endpoint, payload = {}) => endpoint === 'board-image' ? imageCall(payload) : run(async () => {
    const { api, store, goalEditor } = service(), scope = payload.scope
    switch (endpoint) {
      case 'board-redo-preview':
      case 'board-redo-confirm':
        api.list(scope, principal)
        redoPreparation ??= createUserRedoPreparation(rt)
        return endpoint === 'board-redo-preview' ? redoPreparation.preview(payload) : redoPreparation.confirm(payload)
      case 'board-list': {
        // A concurrent DB writer may commit between projection and version
        // reads; never label an older list as the current snapshot. The task
        // scheduler can settle a dispatch in the same moment, so retry long
        // enough for a stable window instead of failing the board refresh that
        // follows a committed command.
        for (let i = 0; i < 10; i += 1) {
          const before = store.version(), rosterRevision = rt.state.revision
          const view = api.list(scope, principal)
          const held = await rt.recoveryHeldView?.(scope) ?? { available: false, incomplete: true, items: [], deliveries: [], deliveriesIncomplete:true }
          const recovery = userRedoView({ principal, scope, state:rt.state, recovery:held })
          if (before === store.version() && rosterRevision === rt.state.revision) return { ...view,
            recovery, ...(scope?.kind==='personal' && scope.id==='user' && rt.remoteChangeView ? { remoteChanges:rt.remoteChangeView() } : {}),
            revision: `${rosterRevision}:${before}` }
          await new Promise(resolve => setTimeout(resolve, 20))
        }
        throw new Error('Board changed; refresh the board')
      }
      case 'board-operation':
        if(typeof payload.operationId==='string'&&payload.operationId.startsWith('goal:')) {api.list(scope,principal);return goalEditor.operation(scope,payload.operationId)}
        {
          const result = api.operation(scope, principal, payload.operationId)
          if (result.state !== 'unknown') return result
          const record = store.operation(payload.operationId)
          if (!record) return result
          const boardScope = `${scope.kind}:${scope.id}`
          const release = store.listReleases(boardScope).find(item => item.id === record.taskId)
          const proposal = store.listProposals(boardScope).find(item => item.id === record.taskId)
          if (!release && !proposal) return result
          return record.status === 'rejected' ? { state:'rejected', message:record.message || 'Release action rejected' }
            : { state:'committed', result:record.result }
        }
      case 'board-release-list':
        api.list(scope, principal)
        return store.listReleases(`${scope.kind}:${scope.id}`)
      case 'board-release-create': {
        api.list(scope, principal)
        if (!payload.operationId || !payload.release) throw new Error('Invalid release request')
        if (['groupId','roles','projectManagerId'].some(key => Object.hasOwn(payload.release, key))) throw new Error('Choose release roles from this group')
        const release = { ...payload.release, scope:`${scope.kind}:${scope.id}` }
        // Replays of old releases retain the original coordination room from their receipt.
        const original = store.operation(payload.operationId)?.result
        if (scope.kind === 'room') {
          const groupId = original?.scope === release.scope && original.id === release.id ? original.groupId : scope.id
          if (groupId) release.groupId = groupId
        }
        if (payload.team !== undefined) {
          if (scope.kind !== 'room') throw new Error('A release group needs a group board')
          const members = rt.roomOf(scope.id)?.members ?? []
          const bots = Object.fromEntries(members.map(id => [id, rt.botOf(id)]).filter(([, bot]) => bot))
          const team = resolveReleaseTeam({ bots, projectManagerId:payload.team.projectManagerId, roles:payload.team.roles ?? {} })
          release.projectManagerId = team.projectManagerId
          release.roles = team.roles
        }
        return store.createRelease({ operationId: payload.operationId, actor: 'user', release })
      }
      case 'board-release-plan': {
        api.list(scope, principal)
        if (scope.kind !== 'room') throw new Error('A release lifecycle plan needs a group board')
        const release = store.getRelease(payload.releaseId)
        if (!release || release.scope !== `${scope.kind}:${scope.id}`) throw new Error('Release is unavailable')
        return applyReleasePlan(scope, release, payload.requirement, principal, payload.cardType, payload.operationId)
      }
      case 'board-release-update': {
        api.list(scope, principal)
        const release = store.getRelease(payload.releaseId)
        if (!release || release.scope !== `${scope.kind}:${scope.id}`) throw new Error('Release is unavailable')
        return store.updateRelease({ operationId: payload.operationId, actor: 'user', releaseId: payload.releaseId, expectedRevision: payload.expectedRevision, value: payload.value })
      }
      case 'board-release-assign': {
        api.list(scope, principal)
        const result = store.assignRelease({ operationId: payload.operationId, actor: 'user', releaseId: payload.releaseId, expectedReleaseRevision: payload.expectedReleaseRevision,
          taskId: payload.taskId, expectedTaskRevision: payload.expectedTaskRevision, afterId: payload.afterId ?? null })
        void notifyBoardChange(payload.taskId, { type:'release-assign', value:{ releaseId: payload.releaseId } }, payload.releaseId).catch(error => rt.warn?.('ds-bot: board change not synced to release group: %s', error))
        return result
      }
      case 'board-release-remove': {
        api.list(scope, principal)
        const result = store.removeFromRelease({ operationId: payload.operationId, actor: 'user', releaseId: payload.releaseId, expectedReleaseRevision: payload.expectedReleaseRevision,
          taskId: payload.taskId, expectedTaskRevision: payload.expectedTaskRevision })
        // The task left this release, so name it explicitly instead of reading the task's
        // current (now empty) membership.
        void notifyBoardChange(payload.taskId, { type:'release-remove', value:{ releaseId: payload.releaseId } }, payload.releaseId).catch(error => rt.warn?.('ds-bot: board change not synced to release group: %s', error))
        return result
      }
      case 'board-release-start': {
        api.list(scope, principal)
        const release = store.getRelease(payload.releaseId)
        if (!release || release.scope !== `${scope.kind}:${scope.id}`) throw new Error('Release is unavailable')
        const result = store.startRelease({ operationId: payload.operationId, actor: 'user', releaseId: payload.releaseId, expectedRevision: payload.expectedRevision })
        notifyDriver()
        return result
      }
      case 'board-release-queue': {
        api.list(scope, principal)
        const release = store.getRelease(payload.releaseId)
        if (!release || release.scope !== `${scope.kind}:${scope.id}`) throw new Error('Release is unavailable')
        return store.queueRelease({ operationId: payload.operationId, actor: 'user', releaseId: payload.releaseId, expectedRevision: payload.expectedRevision })
      }
      case 'board-release-cancel': {
        api.list(scope, principal)
        const release = store.getRelease(payload.releaseId)
        if (!release || release.scope !== `${scope.kind}:${scope.id}`) throw new Error('Release is unavailable')
        return store.cancelRelease({ operationId: payload.operationId, actor: 'user', releaseId: payload.releaseId, expectedRevision: payload.expectedRevision })
      }
      case 'board-release-gate': {
        api.list(scope, principal)
        const release = store.getRelease(payload.releaseId)
        if (!release || release.scope !== `${scope.kind}:${scope.id}`) throw new Error('Release is unavailable')
        return store.setReleaseGate({ operationId: payload.operationId, actor:'user', releaseId:payload.releaseId, expectedRevision:payload.expectedRevision, gate:payload.gate, status:payload.status, evidence:payload.evidence })
      }
      case 'board-release-check': {
        api.list(scope, principal)
        const release = store.getRelease(payload.releaseId)
        if (!release || release.scope !== `${scope.kind}:${scope.id}`) throw new Error('Release is unavailable')
        return checkAndReportRelease(payload.releaseId, payload.operationId ?? randomUUID())
      }
      case 'board-release-report': {
        api.list(scope, principal)
        const release = store.getRelease(payload.releaseId)
        if (!release || release.scope !== `${scope.kind}:${scope.id}` || !release.report) throw new Error('Release report is unavailable')
        return { markdown: readFileSync(release.report.markdownPath, 'utf8'), html: readFileSync(release.report.htmlPath, 'utf8'), generatedAt: release.report.generatedAt }
      }
      case 'board-history':
        return api.history(scope, principal, payload.taskId)
      case 'board-held-decision':
        api.list(scope,principal)
        if (typeof rt.setHeldDecision !== 'function') throw new Error('Interrupted turn decisions are unavailable')
        return rt.setHeldDecision(scope,payload.recoveryId,payload.expectedRevision,payload.choice)
      case 'board-queued-delivery-decision':
        api.list(scope,principal)
        if (typeof rt.setQueuedDeliveryDecision !== 'function') throw new Error('Queued delivery decisions are unavailable')
        return rt.setQueuedDeliveryDecision(scope,payload.recoveryId,payload.expectedRevision,payload.choice)
      case 'board-operation-cancel': {
        api.list(scope, principal)
        if(typeof payload.operationId==='string'&&payload.operationId.startsWith('goal:'))return goalEditor.cancel(scope,payload.operationId)
        return store.cancelRequest({ operationId: payload.operationId, actor: 'user' })
      }
      case 'board-proposal-list':
        api.list(scope, principal)
        return store.listProposals(`${scope.kind}:${scope.id}`).map(proposal => ({
          ...proposal,
          taskTitle: proposal.taskId ? store.get(proposal.taskId)?.title ?? proposal.after?.title : proposal.after?.title,
        }))
      case 'board-proposal-decide': {
        api.list(scope, principal)
        const proposal = store.listProposals(`${scope.kind}:${scope.id}`).find(item => item.id === payload.proposalId)
        if (!proposal) throw new Error('Proposal is unavailable')
        if (!payload.operationId || !Number.isSafeInteger(payload.expectedRevision) || !['confirm','reject'].includes(payload.decision)) throw new Error('Invalid proposal decision')
        // Rechecked before the decision transaction: a deleted, private or removed
        // proposing Bot must not gain a change through the user's confirmation.
        if (payload.decision === 'confirm' && !proposerStillAuthorized(proposal)) throw new Error('The proposing Bot is no longer authorized to change this task')
        const result = store.decideProposal({ operationId: payload.operationId, actor:'user', proposalId:payload.proposalId, expectedRevision:payload.expectedRevision,
          decision:payload.decision, note:payload.note, apply: current => {
            if (current.kind === 'create') {
              const value = current.command?.value
              if (!value || typeof value !== 'object') throw new Error('Proposal target is unavailable')
              return api.create(scope, { kind:'user' }, { operationId:`${payload.operationId}:apply`, taskId:current.taskId, ...value })
            }
            if (current.taskId) {
              const task = store.get(current.taskId)
              if (!task || task.revision !== current.baseRevision) throw new Error('Task changed after this proposal was made')
              return api.command(scope, principal, { operationId:`${payload.operationId}:apply`, taskId:current.taskId,
                expectedRevision:current.baseRevision, type:current.command.type, ...(current.command.value === undefined ? {} : { value:current.command.value }) })
            }
            throw new Error('Proposal target is unavailable')
          } })
        if (payload.decision === 'confirm' && proposal.taskId) {
          const applied = result?.applied
          const change = applied?.change
            ? { type:'change-request', value:{ changeTaskId: applied.id, sourceTaskId: applied.change.sourceTaskId, fields: Object.keys(applied.change.after ?? {}) } }
            : { type:'proposal-confirm', value:{ proposalId: proposal.id, change: proposal.command?.type ?? proposal.kind } }
          void notifyBoardChange(proposal.taskId, change)
            .catch(error => rt.warn?.('ds-bot: board change not synced to release group: %s', error))
        }
        if (payload.decision === 'confirm') notifyDriver()
        return result
      }
      case 'board-command': {
        if(['goal-task-edit','goal-history-title','goal-card-details','goal-card-comment','goal-image-remove'].includes(payload.type)) {
          const card = api.list(scope,principal).tasks.find(item => item.id === payload.taskId)
          const kind=payload.type==='goal-task-edit'?'edit':payload.type==='goal-history-title'?'title':payload.type==='goal-card-details'?'details':payload.type==='goal-card-comment'?'comment':'remove-image'
          let recipient
          const outcome = await goalEditor.execute(scope,payload.operationId,{endpoint,payload},() => {
            if (card?.legacy?.current && !card.legacy.ambiguous && card.legacy.originalStatus === 'working') {
              const room = rt.roomOf(card.originRoomId)
              recipient = activeBoardRecipient(card.owner, card.originRoomId, room?.sessions?.[card.owner], true)
            }
            return goalEditor.mutate(scope,payload,kind)
          })
          if (recipient && outcome.state === 'committed') {
            const text = `Human board update for existing goal item ${card.id} (goal ${card.legacy.goalId}, stage ${card.legacy.stageId}, task ${card.legacy.taskId}). `
              + 'Read this original item with board_task list or group_goal show before your next step. Use its latest instructions and status; stop if it no longer calls for work. Do not create or dispatch another task.'
            void steerBoardUpdate(recipient, text, payload.operationId).catch(error => rt.warn?.('ds-bot: goal board update delivery: %s',error))
          }
          return outcome
        }
        if(typeof payload.operationId==='string'&&payload.operationId.startsWith('goal:'))throw new Error('Goal operation ID requires a goal task action')
        const result = mutate(endpoint, payload); notifyDriver(); return result
      }
      default: throw new Error('Unknown board endpoint')
    }
  })
  async function readBody(request) {
    if (!request.body) throw new Error('Missing upload body')
    const reader = request.body.getReader(); readers.add(reader)
    const chunks = []; let length = 0, timedOut = false
    const timeout = setTimeout(() => { timedOut = true; void reader.cancel().catch(() => {}) }, 60_000)
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (timedOut) throw Object.assign(new Error('Image request timed out'), { status:408 })
        if (done) break
        length += value.byteLength
        if (length > BOARD_UPLOAD_MAX_BYTES) { void reader.cancel(); throw Object.assign(new Error('Image request exceeds the allowed size'), { status: 413 }) }
        chunks.push(value)
      }
      const bytes = new Uint8Array(length); let offset = 0
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
      return bytes
    } finally { clearTimeout(timeout); readers.delete(reader); reader.releaseLock() }
  }
  const workerJob = (path, data, transferList = []) => new Promise((resolve, reject) => {
    const worker = new Worker(new URL(path, import.meta.url), {
      workerData: data, transferList, resourceLimits: { maxOldGenerationSizeMb:128 },
    })
    workers.add(worker); let settled = false
    const timer = setTimeout(() => { void worker.terminate(); finish(new Error('Image preparation timed out')) }, 30_000)
    const finish = (error, value) => {
      if (settled) return
      settled = true; clearTimeout(timer); workers.delete(worker)
      if (error) reject(error); else resolve(value)
    }
    worker.once('message', value => {
      if (value?.ok || value?.rejected) return finish(null, value)
      const error = new Error(value?.message || 'Invalid image request')
      if (value?.stack) error.stack = value.stack
      finish(error)
    })
    worker.once('error', error => finish(error))
    worker.once('exit', () => { if (!settled) finish(new Error('Image operation stopped')) })
  })
  const prepare = (bytes, stagingDir, imageDir) => workerJob('./board-image-worker.mjs', { bytes, stagingDir, imageDir }, [bytes.buffer])
  const enterImageRead = () => {
    if (closing || rt.stopping) return Promise.reject(new Error('Board service is closing'))
    if (imageReads < 2) { imageReads += 1; return Promise.resolve() }
    if (imageWaiters.length >= 20) return Promise.reject(new Error('Too many image requests'))
    return new Promise((resolve, reject) => imageWaiters.push({ resolve, reject }))
  }
  const leaveImageRead = () => {
    const next = imageWaiters.shift()
    if (next) next.resolve(); else imageReads -= 1
  }
  const imageCall = payload => run(async () => {
    const inst = service(), before = inst.api.imageReference(payload.scope, principal, payload.taskId, payload.imageId)
    await enterImageRead()
    try {
      const result = await workerJob('./board-image-read-worker.mjs', { directory:inst.imageDir, taskId:before.taskId, reference:before.reference })
      const after = inst.api.imageReference(payload.scope, principal, payload.taskId, payload.imageId)
      if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('Image permission or reference changed')
      return result.value
    } finally { leaveImageRead() }
  })
  const enterUpload = signal => {
    if (closing || rt.stopping || signal?.aborted) return Promise.reject(new Error('Board service is closing'))
    if (uploads < 2) { uploads += 1; return Promise.resolve() }
    if (uploadWaiters.length >= 4) return Promise.reject(Object.assign(new Error('Too many image uploads'), { status:429 }))
    return new Promise((resolve, reject) => {
      const item = { resolve:() => { signal?.removeEventListener('abort', aborted); resolve() }, reject:error => { signal?.removeEventListener('abort', aborted); reject(error) } }
      const aborted = () => { const at = uploadWaiters.indexOf(item); if (at !== -1) uploadWaiters.splice(at, 1); item.reject(new Error('Image upload cancelled')) }
      uploadWaiters.push(item); signal?.addEventListener('abort', aborted, { once:true })
      if (signal?.aborted) aborted()
    })
  }
  const leaveUpload = () => {
    const next = uploadWaiters.shift()
    if (next) next.resolve(); else uploads -= 1
  }
  const sameStat = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs
  async function publishImages(prepared, stagingDir, inst) {
    const { meta, references, files } = prepared, proofs = new Map()
    for (let i = 0; i < references.length; i += 1) {
      writable()
      const entry = files[i], source = join(stagingDir, entry.name), destination = join(inst.imageDir, entry.name)
      const staged = lstatSync(source)
      if (!staged.isFile() || staged.isSymbolicLink() || !sameStat(staged, entry.staged)) throw new Error('Prepared image changed')
      if (entry.existing) {
        const found = lstatSync(destination)
        if (!found.isFile() || found.isSymbolicLink() || !sameStat(found, entry.existing)) throw new Error('Existing image changed')
      } else {
        await link(source, destination)
      }
      writable()
      const final = lstatSync(destination)
      if (!final.isFile() || final.isSymbolicLink() || (entry.existing ? !sameStat(final, entry.existing) : !sameStat(final, entry.staged))) throw new Error('Image identity changed')
      proofs.set(references[i].id, { taskId:meta.taskId, reference:references[i], name:entry.name, stat:{ dev:final.dev, ino:final.ino, size:final.size, mtimeMs:final.mtimeMs } })
    }
    await syncDirectory(inst.imageDir)
    return proofs
  }
  const upload = request => run(async () => {
    let stagingDir, inst, admitted = false
    try {
      await enterUpload(request.signal); admitted = true
      const bytes = await readBody(request)
      if (closing || rt.stopping) return response(fail('Board service is closing'))
      inst = service(); writable()
      stagingDir = join(inst.root, `.staging-${randomUUID()}`); mkdirSync(stagingDir, { mode:0o700 })
      const prepared = await prepare(bytes, stagingDir, inst.imageDir)
      if (closing || rt.stopping) throw new Error('Board service is closing')
      const { meta, identity, references } = prepared
      const options = { operationId:meta.operationId, actor:'user', taskId:meta.taskId, payload:identity, isRejection:rejected }
      if(typeof meta.operationId==='string'&&meta.operationId.startsWith('goal:')) {
        inst.api.list(meta.scope,principal)
        const prior=await inst.goalEditor.prior(meta.scope,meta.operationId,identity)
        if(prior)return response(prior.state==='committed'?ok(prior.result):fail(prior.message||'Image upload outcome is unknown'))
        if(prepared.rejected) {
          const outcome=await inst.goalEditor.execute(meta.scope,meta.operationId,identity,()=>{throw Object.assign(new Error(prepared.message),{code:'bot/invalid'})})
          return response(outcome.state==='committed'?ok(outcome.result):fail(outcome.message||'Image upload outcome is unknown'))
        }
        // Both the visible scope and the exact goal revision are checked
        // before and after the worker and immutable-file publication.
        try {inst.goalEditor.lookup(meta.scope,meta.taskId,meta.expectedRevision,meta.expectedBoardRevision,meta.expectedPosition)} catch(error) {
          const outcome=await inst.goalEditor.execute(meta.scope,meta.operationId,identity,()=>{throw error})
          return response(fail(outcome.message||'Image upload outcome is unknown'))
        }
        const verified=await publishImages(prepared,stagingDir,inst)
        const outcome=await inst.goalEditor.execute(meta.scope,meta.operationId,identity,()=>{
          for(const item of references) {
            const proof=verified.get(item.id)
            if(!proof||proof.taskId!==meta.taskId||JSON.stringify(proof.reference)!==JSON.stringify(item))throw Object.assign(new Error('Image proof unavailable'),{code:'bot/invalid'})
            const actual=lstatSync(join(inst.imageDir,proof.name))
            if(!actual.isFile()||actual.isSymbolicLink()||!sameStat(actual,proof.stat))throw Object.assign(new Error('Image identity changed'),{code:'bot/invalid'})
          }
          return inst.goalEditor.mutate(meta.scope,meta,'attach',references)
        })
        return response(outcome.state==='committed'?ok(outcome.result):fail(outcome.message||'Image upload outcome is unknown'))
      }
      if (prepared.rejected) {
        const outcome = inst.store.request(options, () => {
          inst.api.list(meta.scope, principal)
          throw Object.assign(new Error(prepared.message), { code:'bot/invalid' })
        })
        return response(outcome.state === 'committed' ? ok(outcome.value) : fail(outcome.message))
      }
      const existing = inst.store.operation(meta.operationId)
      if (existing) {
        const outcome = inst.store.request(options, () => { throw new Error('Unexpected duplicate execution') })
        return response(outcome.state === 'committed' ? ok(outcome.value) : fail(outcome.message))
      }
      // Check visibility and revision before linking; the journal checks again
      // after the asynchronous file operations and before metadata commit.
      const board = inst.api.list(meta.scope, principal), task = inst.store.get(meta.taskId)
      if (!task || !board.tasks.some(item => item.id === meta.taskId) || task.revision !== meta.expectedRevision) {
        const outcome = inst.store.request(options, () => { throw Object.assign(new Error('Task changed; refresh the board'), { code:'bot/invalid' }) })
        return response(fail(outcome.message))
      }
      const proofs = await publishImages(prepared, stagingDir, inst)
      writable()
      inst.proofs.clear(); for (const [key, value] of proofs) inst.proofs.set(key, value)
      let outcome
      try { outcome = inst.store.request(options, () => inst.api.uploadPrepared(meta.scope, principal, meta, references)) }
      finally { inst.proofs.clear() }
      if (outcome.state === 'committed') void notifyBoardChange(meta.taskId, { type:'attach', value:{ images: references.map(reference => reference.id) } })
        .catch(error => rt.warn?.('ds-bot: board change not synced to release group: %s', error))
      return response(outcome.state === 'committed' ? ok(outcome.value) : fail(outcome.message))
    } catch (error) {
      const frames = typeof error?.stack === 'string' ? error.stack.split('\n').slice(1, 9).join('\n') : ''
      rt.warn?.('ds-bot: board image upload failed: %s', frames || error?.name || 'unknown error')
      const status = [408, 413, 429].includes(error?.status) ? error.status : 200
      const message = status === 413 ? 'Image request exceeds the allowed size' : status === 429 ? 'Too many image uploads; try again' : status === 408 ? 'Image request timed out' : 'Could not upload image'
      return response(fail(message, status === 429 ? 'bot/busy' : 'bot/invalid'), status)
    } finally {
      if (stagingDir) await rm(stagingDir, { recursive:true, force:true }).catch(() => {})
      if (admitted) leaveUpload()
    }
  })
  const stop = () => closePromise ??= (async () => {
    closing = true
    if (releaseTimer) { clearInterval(releaseTimer); releaseTimer = undefined }
    for (const waiter of imageWaiters.splice(0)) waiter.reject(new Error('Board service is closing'))
    for (const waiter of uploadWaiters.splice(0)) waiter.reject(new Error('Board service is closing'))
    for (const reader of readers) void reader.cancel().catch(() => {})
    for (const worker of workers) void worker.terminate()
    await Promise.allSettled([...active])
    await instance?.driver.close()
    botWorkflow.close(); instance?.store.close(); instance = undefined
  })()
  rt.boardCall = boardCall
  rt.boardPlanRelease = async ({ caller, releaseId, requirement, operationId, cardType } = {}) => run(async () => {
    if (!caller?.actor || !releaseId) throw new Error('Invalid release plan request')
    const release = service().store.getRelease(releaseId)
    if (!release || !release.scope.startsWith('room:')) throw new Error('Release is unavailable')
    const roomId = release.scope.slice(5), room = rt.roomOf(roomId)
    const actor = rt.botOf(caller.actor)
    if (!actor || actor.private === true || !room?.members?.includes(caller.actor) || (caller.roomId && caller.roomId !== roomId)) throw new Error('Release is unavailable in this group')
    if (caller.actor !== release.projectManagerId && !rt.isAdminOf?.(room, caller.actor)) throw new Error('Only the release project manager can plan this release')
    return applyReleasePlan({ kind:'room', id:roomId }, release, requirement, { kind:'user' }, cardType, operationId)
  })
  rt.onHomeDrain(stop)
  ctx.effect(() => ctx.connection.fetch.register({ path: BOARD_UPLOAD_PATH, methods: ['POST'], requestBody: 'streaming', fetch: upload }), 'ds-bot: board streaming upload')
  ctx.effect(() => stop, 'ds-bot: board service')
}
