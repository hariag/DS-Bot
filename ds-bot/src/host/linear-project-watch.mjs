import { closeSync, lstatSync, mkdirSync, openSync } from 'node:fs'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createLinearProjectApi, LinearProjectReadError } from './linear-project-api.mjs'
import { createLinearProjectHandoff } from './linear-project-handoff.mjs'
import { createLinearProjectMcpApi } from './linear-project-mcp.mjs'
import { createLinearProjectMcpSession } from './linear-project-mcp-session.mjs'
import { openLinearProjectMonitor } from './linear-project-monitor.mjs'
import { createLinearProjectSync } from './linear-project-sync.mjs'
import { isPrivateDirectory, isPrivateFile } from './private-storage.mjs'

const INTERVAL_MS = 5_000
const DEFAULT_DELIVER_GAP_MS = 5_000
const DELIVER_LEASE_MS = 5 * 60_000
const UUID = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i
const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,63}$/
const BOT_ID = /^[a-z\d:_-]{1,160}$/i

function configOf(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return
  const {
    projectId, managerId, boardRoomId, intakeStateIds = [], readSecret, credential = 'apiKey',
    outboundSync, watchContentChanges = true, postComments = true, syncCancelled = true,
    deliverGapMs = DEFAULT_DELIVER_GAP_MS, stateMap,
  } = value
  if (typeof projectId !== 'string' || !UUID.test(projectId) || typeof managerId !== 'string' || !BOT_ID.test(managerId) ||
    !Array.isArray(intakeStateIds) || intakeStateIds.length > 32 || intakeStateIds.some(id => typeof id !== 'string' || !UUID.test(id)) ||
    (boardRoomId !== undefined && (typeof boardRoomId !== 'string' || !BOT_ID.test(boardRoomId))) || (intakeStateIds.length > 0 && !boardRoomId) ||
    (readSecret !== undefined && (typeof readSecret !== 'string' || !SECRET_NAME.test(readSecret) || !['apiKey', 'oauth'].includes(credential))) ||
    !Number.isSafeInteger(deliverGapMs) || deliverGapMs < 0 ||
    (stateMap !== undefined && (!stateMap || typeof stateMap !== 'object' || Array.isArray(stateMap)))) return
  return {
    projectId: projectId.toLowerCase(),
    managerId,
    boardRoomId,
    intakeStateIds: [...new Set(intakeStateIds.map(id => id.toLowerCase()))],
    readSecret,
    credential,
    outboundSync: outboundSync ?? (readSecret === undefined && Boolean(boardRoomId)),
    watchContentChanges: watchContentChanges !== false,
    postComments: postComments !== false,
    syncCancelled: syncCancelled !== false,
    deliverGapMs,
    stateMap: stateMap ? { ...stateMap } : undefined,
  }
}

function configsOf(value) {
  if (value === undefined || value === false) return { specs: [], invalid: false }
  const rawList = Array.isArray(value)
    ? value
    : (value && typeof value === 'object' && Array.isArray(value.projects) ? value.projects : [value])
  const specs = []
  let invalid = false
  const seenProjects = new Set()
  for (const entry of rawList) {
    const spec = configOf(entry)
    if (!spec || seenProjects.has(spec.projectId)) {
      invalid = true
      continue
    }
    seenProjects.add(spec.projectId)
    specs.push(spec)
  }
  return { specs, invalid }
}

function storePath(home, projectId) {
  const directory = join(home, 'linear-project-watch-v1')
  try { mkdirSync(directory, { mode: 0o700 }) } catch (error) { if (error.code !== 'EEXIST') throw error }
  if (!isPrivateDirectory(directory, lstatSync(directory))) throw new Error('Private monitor storage unavailable')
  const path = join(directory, `${projectId}.sqlite`)
  try { closeSync(openSync(path, 'wx', 0o600)) } catch (error) { if (error.code !== 'EEXIST') throw error }
  if (!isPrivateFile(path, lstatSync(path))) throw new Error('Private monitor storage unavailable')
  return path
}

export function install(rt) {
  const configured = rt.config?.linearProjectWatch
  if (configured === undefined || configured === false) return
  const { specs, invalid } = configsOf(configured)
  if (invalid || !specs.length) rt.warn?.('ds-bot: invalid Linear project watch configuration')
  if (!specs.length) return

  const watchers = specs.map(spec => createProjectWatcher(rt, spec))

  rt.linearProjectWatchStatus = () => {
    if (watchers.length === 1) return { enabled: true, ...watchers[0].status() }
    return {
      enabled: true,
      ...watchers[0].status(),
      projects: watchers.map(watcher => watcher.status()),
    }
  }

  const unsubscribeCommit = rt.onBoardTaskCommit?.(events => {
    for (const watcher of watchers) {
      watcher.onBoardCommit(events)
    }
  })

  rt.teamTools.push(defineTool({
    name: 'linear_project_changes',
    description: 'Read, resolve, or bind inbox entries between a configured Linear project and DS-Bot top-level cards. Only the assigned project manager can use it in their own chat. Resolving records the handling decision; binding links a Linear issue to a DS-Bot feature/bugfix card for live bidirectional state sync.',
    parameters: {
      action: { type: 'string', enum: ['list', 'resolve', 'bind', 'bindings', 'retry_outbound'], required: true, description: 'Read unresolved changes, record how changes were resolved, bind a Linear issue to a DS-Bot card, inspect bindings, or retry a conflicted outbound sync.' },
      project_id: { type: 'string', description: 'Optional Linear project UUID when managing multiple watched projects.' },
      after: { type: 'string', description: 'On list, a previous nextCursor to read the next page.' },
      event_ids: { type: 'array', items: { type: 'string' }, description: 'Event IDs returned by list, up to 20.' },
      note: { type: 'string', description: 'For resolve, the decision and where the result can be verified, up to 500 characters.' },
      issue_id: { type: 'string', description: 'For bind, the Linear issue UUID or identifier (e.g. HAR-8).' },
      identifier: { type: 'string', description: 'Optional Linear issue identifier when binding by UUID.' },
      task_id: { type: 'string', description: 'For bind, the DS-Bot top-level card ID (e.g. T-HAR-0001).' },
      operation_id: { type: 'string', description: 'For retry_outbound, the conflicted outbound sync operation ID.' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) {
      await rt.load()
      const sessionId = exec.agent?.id
      const isPrivateSession = !rt.groupOwners.has(sessionId) && !rt.taskOwners?.has(sessionId)
      const ownerId = rt.chatOwners.get(sessionId)
      const owned = isPrivateSession ? watchers.filter(watcher => watcher.managerId === ownerId) : []
      if (!owned.length) {
        return 'This inbox is available to the assigned project manager in their own chat.'
      }
      const requestedProject = typeof args.project_id === 'string' && args.project_id.trim()
        ? args.project_id.trim().toLowerCase()
        : undefined
      const watcher = requestedProject
        ? owned.find(item => item.projectId === requestedProject)
        : (owned.length === 1 ? owned[0] : undefined)
      if (!watcher) {
        return requestedProject
          ? `Unknown or unauthorized Linear project ${requestedProject}.`
          : `Specify project_id (${owned.map(item => item.projectId).join(', ')}).`
      }
      return watcher.executeTool(args)
    },
  }))

  rt.ctx.effect(() => {
    const offInbox = rt.addInboxSource?.(() => watchers.flatMap(watcher => watcher.inboxItems()))
    for (const watcher of watchers) watcher.start()
    return async () => {
      unsubscribeCommit?.()
      offInbox?.()
      await Promise.all(watchers.map(watcher => watcher.stop()))
    }
  }, 'ds-bot: Linear project watch')
}

function createProjectWatcher(rt, spec) {
  const {
    projectId, managerId, boardRoomId, intakeStateIds, readSecret, credential,
    outboundSync, watchContentChanges, postComments, syncCancelled, deliverGapMs, stateMap,
  } = spec
  const stop = new AbortController()
  let store, sync, timer, running, lastPoll, readReason, handoffState, boardReplayError
  let readAfter = 0, failures = 0
  let readFailedAt = 0, conflictAt = 0, uncertainAt = 0, boardReplayFailedAt = 0, lastInboxSig = ''

  function inboxItems() {
    const items = []
    const conflict = store?.stats?.().outbound?.conflict ?? 0
    if (conflict > 0) {
      conflictAt ||= Date.now()
      items.push({
        kind: 'linear-sync', group: 'fix', ref: `${projectId}:outbound-conflict`, at: conflictAt,
        botId: managerId, ...(boardRoomId ? { roomId: boardRoomId } : {}),
        text: `Linear outbound sync conflict (${conflict}) for project ${projectId.slice(0, 8)}`,
      })
    } else conflictAt = 0

    const uncertain = store?.uncertainBatches?.(1)?.length ?? 0
    if (uncertain > 0) {
      uncertainAt ||= Date.now()
      items.push({
        kind: 'linear-sync', group: 'fix', ref: `${projectId}:uncertain-batch`, at: uncertainAt,
        botId: managerId, ...(boardRoomId ? { roomId: boardRoomId } : {}),
        text: `Linear handoff delivery uncertain for project ${projectId.slice(0, 8)}`,
      })
    } else uncertainAt = 0

    const pending = store?.pendingSummary()
    const oldestWaitingAt = Date.parse(pending?.oldestObservedAt)
    if (pending?.count > 0 && Number.isFinite(oldestWaitingAt) && Date.now() - oldestWaitingAt >= DELIVER_LEASE_MS) {
      items.push({
        kind: 'linear-pending', group: 'fix', ref: `${projectId}:unhandled-events`, at: oldestWaitingAt,
        botId: managerId, sessionId: rt.chatOf(managerId),
        text: `Linear 有 ${pending.count} 条变更仍待项目经理处理（项目 ${projectId.slice(0, 8)}）`,
      })
    }

    if (readReason && failures >= 3) {
      readFailedAt ||= Date.now()
      items.push({
        kind: 'linear-watch', group: 'fix', ref: `${projectId}:watch-error`, at: readFailedAt,
        botId: managerId, ...(boardRoomId ? { roomId: boardRoomId } : {}),
        text: `Linear watch degraded: ${readReason}`,
      })
    } else readFailedAt = 0

    if (boardReplayError) {
      boardReplayFailedAt ||= Date.now()
      items.push({
        kind: 'linear-sync', group: 'fix', ref: `${projectId}:board-history`, at: boardReplayFailedAt,
        botId: managerId, roomId: boardRoomId, text: 'Linear 同步暂时无法读取任务看板变更记录',
      })
    } else boardReplayFailedAt = 0

    return items
  }

  function notifyInbox() {
    const sig = JSON.stringify(inboxItems().map(({ kind, ref, text }) => [kind, ref, text]))
    if (sig !== lastInboxSig) {
      lastInboxSig = sig
      rt.inboxChanged?.()
    }
  }

  function assertLocal() {
    if (stop.signal.aborted || rt.stopping || !rt.botOf(managerId)) {
      throw new LinearProjectReadError('Linear authorization unavailable')
    }
    if (boardRoomId && !rt.roomOf(boardRoomId)?.members?.includes(managerId)) {
      throw new LinearProjectReadError('Configured Linear project board is unavailable to its project manager')
    }
    rt.requireHomeLock()
  }

  function assertActive() {
    assertLocal()
    if (readSecret === undefined ? rt.linearProjectMcpAvailable(managerId) !== true : rt.canUseSecret(readSecret, managerId) !== true) {
      throw new LinearProjectReadError('Linear authorization unavailable')
    }
  }

  async function loadAccess() {
    await rt.load()
    await rt.loadSecrets()
    assertActive()
  }

  async function authorize() {
    await loadAccess()
    const token = rt.secretValue(readSecret)
    if (typeof token !== 'string' || !token.trim()) throw new LinearProjectReadError('Linear authorization unavailable')
    return credential === 'oauth' ? `Bearer ${token}` : token
  }

  const mcp = readSecret === undefined ? createLinearProjectMcpSession({
    getGateway: () => rt.linearProjectMcpGateway(managerId),
    assertActive,
    signal: stop.signal,
    allowWrite: outboundSync,
  }) : undefined

  const linear = mcp ? createLinearProjectMcpApi({
    projectId,
    call: mcp.call,
    callWrite: mcp.callWrite,
    hasWriteTool: mcp.hasWriteTool,
    ensureConnected: mcp.ensureConnected,
    watchContentChanges,
  }) : createLinearProjectApi({ projectId, authorize, signal: stop.signal })

  const handoff = createLinearProjectHandoff(rt, { projectId, managerId, boardRoomId, assertActive })

  const ensureSync = openedStore => {
    if (!outboundSync || !boardRoomId || !openedStore) return undefined
    sync ??= createLinearProjectSync({
      store: openedStore,
      linear,
      boardRoomId,
      getBoardTask: id => rt.getBoardTask?.(id),
      readBoardChanges: rt.readRoomBoardTaskChanges,
      assertActive,
      postComments,
      syncCancelled,
      stateMap,
      onWarn: msg => rt.warn?.(msg),
    })
    return sync
  }

  const open = () => {
    assertLocal()
    store ??= openLinearProjectMonitor({ path: storePath(rt.home, projectId), projectId, intakeStateIds, linear, assertActive: assertLocal })
    ensureSync(store)
    return store
  }

  function status() {
    const stats = store?.stats?.()
    return {
      projectId,
      boardRoomId: boardRoomId ?? null,
      intakeStateIds,
      source: mcp ? 'mcp' : 'graphql',
      lastPoll: lastPoll ?? null,
      readReason: readReason ?? null,
      handoffState: handoffState ?? null,
      pendingChanges: store?.pendingSummary() ?? { count: 0, oldestObservedAt: null },
      bindingsCount: stats?.bindingsCount ?? 0,
      suppressedEchoCount: stats?.suppressedEchoCount ?? 0,
      outbound: {
        enabled: outboundSync && Boolean(boardRoomId),
        boardCheckpoint: boardRoomId ? store?.boardCheckpoint(boardRoomId) ?? null : null,
        boardReplayError: boardReplayError ?? null,
        pending: stats?.outbound?.pending ?? 0,
        verified: stats?.outbound?.verified ?? 0,
        conflict: stats?.outbound?.conflict ?? 0,
        superseded: stats?.outbound?.superseded ?? 0,
        lastSync: stats?.outbound?.lastSync ?? null,
      },
    }
  }

  async function executeTool(args) {
    if (!store) return 'The Linear project inbox is not open yet.'
    assertActive()
    if (args.action === 'list') {
      const page = store.pending(21, args.after)
      const changes = page.slice(0, 20)
      const nextCursor = page.length > changes.length ? changes.at(-1).id : undefined
      const stats = store.stats()
      return JSON.stringify({
        projectId, lastPoll, readReason, handoffState, changes, nextCursor,
        uncertainBatches: store.uncertainBatches(5),
        bindingsCount: stats.bindingsCount,
        outbound: stats.outbound,
      })
    }
    if (args.action === 'resolve') {
      const ids = args.event_ids
      const note = args.note?.trim()
      if (!Array.isArray(ids) || ids.length === 0 || ids.length > 20 || !note || note.length > 500) {
        return 'Supply 1 to 20 event IDs and a short handling note.'
      }
      const recorded = store.ack(ids, { actorId: managerId, note })
      notifyInbox()
      return `Handling recorded for ${recorded} events. Read the inbox again for remaining changes.`
    }
    if (args.action === 'bind') {
      const taskId = typeof args.task_id === 'string' ? args.task_id.trim() : ''
      const query = typeof args.issue_id === 'string' && args.issue_id.trim()
        ? args.issue_id.trim()
        : (typeof args.identifier === 'string' ? args.identifier.trim() : '')
      if (!taskId || !query) return 'Supply task_id and issue_id (UUID or identifier) to bind.'
      let task
      if (typeof rt.getBoardTask === 'function') {
        task = rt.getBoardTask(taskId)
        if (!task) return `Board task ${taskId} was not found.`
        if (task.parentTaskId) return `Only top-level feature/bugfix cards may bind to Linear; ${taskId} is a child item.`
        if (task.archivedAt || task.status === 'cancelled') return `Board task ${taskId} is retired or cancelled.`
        if (boardRoomId && task.scope !== `room:${boardRoomId}`) return `Board task ${taskId} belongs to ${task.scope}, outside configured room:${boardRoomId}.`
      }
      let known = store.findKnownIssue(query)
      if (!known && typeof linear.getIssueSnapshot === 'function') {
        const snapshot = await linear.getIssueSnapshot({ issueId: query })
        known = { id: snapshot.id, identifier: snapshot.identifier }
      }
      if (!known?.id) return `Linear issue ${query} was not found in project ${projectId}.`
      const identifier = (typeof args.identifier === 'string' && args.identifier.trim()) || known.identifier || known.id
      const roomId = boardRoomId ?? (task?.scope?.startsWith('room:') ? task.scope.slice(5) : 'unknown')
      const binding = store.bindIssue({ issueId: known.id, identifier, taskId, roomId, source: 'manual' })
      if (task) ensureSync(store)?.syncTaskNow(task)
      notifyInbox()
      return JSON.stringify({ bound: binding })
    }
    if (args.action === 'bindings') {
      return JSON.stringify({
        projectId,
        bindings: store.listBindings(),
        outbound: store.listOutbound(20),
      })
    }
    if (args.action === 'retry_outbound') {
      const opId = typeof args.operation_id === 'string' ? args.operation_id.trim() : ''
      if (!opId) return 'Supply operation_id to retry.'
      const retried = store.retryOutbound(opId)
      if (retried) queueMicrotask(() => { void ensureSync(store)?.drain() })
      notifyInbox()
      return retried ? `Outbound sync ${opId} queued for retry.` : `No conflicted or retryable outbound job found for ${opId}.`
    }
    return 'Unsupported action.'
  }

  function replayBoard() {
    if (!outboundSync || !boardRoomId || !rt.readRoomBoardTaskChanges) return true
    try {
      if (!ensureSync(open())?.replayBoardChanges()) throw new Error('Board task history unavailable')
      boardReplayError = undefined
      return true
    } catch {
      if (!stop.signal.aborted && !boardReplayError) rt.warn?.('ds-bot: Linear board history replay unavailable')
      boardReplayError = 'Board task history unavailable'
      return false
    }
  }

  async function tick() {
    try {
      if (outboundSync && boardRoomId) {
        await rt.load()
        replayBoard()
      }
      if (Date.now() >= readAfter) {
        try {
          await loadAccess()
          lastPoll = await open().poll()
          failures = 0
          readReason = undefined
        } catch (error) {
          const reason = error instanceof LinearProjectReadError ? error.message : 'monitor storage or response unavailable'
          if (!stop.signal.aborted && reason !== readReason) rt.warn?.('ds-bot: Linear project watch %s', reason)
          readReason = reason
          failures++
          readAfter = Date.now() + Math.max(Math.min(5 * 60_000, INTERVAL_MS * 2 ** Math.min(failures, 6)), error?.retryAfterMs ?? 0)
        }
      }

      if (!store || stop.signal.aborted) return
      assertActive()
      const activeSync = ensureSync(store)
      if (activeSync && replayBoard()) {
        await activeSync.drain().catch(() => {})
      }
      const batch = store.getBatch(12, { minDeliveryGapMs: deliverGapMs, unresolvedDeliveryLeaseMs: DELIVER_LEASE_MS })
      if (!batch) return
      const receipt = await handoff(batch)
      if (stop.signal.aborted) return
      handoffState = receipt.status
      if (receipt.status !== 'retry') store.recordDelivery(batch.id, receipt.status, receipt)
    } catch {
      if (!stop.signal.aborted && handoffState !== 'unavailable') rt.warn?.('ds-bot: Linear project handoff unavailable')
      handoffState = 'unavailable'
    } finally {
      notifyInbox()
    }
  }

  function schedule(delay) {
    timer = setTimeout(() => {
      const started = Date.now()
      running = tick().finally(() => {
        running = undefined
        if (!stop.signal.aborted) schedule(Math.max(250, INTERVAL_MS - (Date.now() - started)))
      })
    }, delay)
    timer.unref?.()
  }

  return {
    projectId,
    managerId,
    status,
    inboxItems,
    executeTool,
    onBoardCommit(events) {
      if (stop.signal.aborted) return
      if (rt.readRoomBoardTaskChanges) {
        if (replayBoard()) void sync?.drain().catch(() => {})
        return
      }
      try {
        const opened = open()
        ensureSync(opened)?.handleBoardCommit(events)
      } catch { /* Compatibility for hosts lacking the board history interface. */ }
    },
    start() { schedule(0) },
    async stop() {
      stop.abort()
      clearTimeout(timer)
      await running
      await mcp?.close()
      await store?.close()
    },
  }
}
