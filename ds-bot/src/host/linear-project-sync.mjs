const nonempty = value => typeof value === 'string' && value.trim().length > 0
const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const DEFAULT_STATES = Object.freeze({
  todo: 'Todo',
  working: 'In Progress',
  reported: 'In Review',
  rework: 'In Progress',
  done: 'Done',
  cancelled: 'Canceled',
})

const FALLBACK_TYPES = Object.freeze({
  started: ['started'],
  reported: ['started'],
  rework: ['started'],
  done: ['completed'],
  cancelled: ['canceled'],
})

export function hasIndependentAcceptances(task) {
  if (!task || task.status !== 'done' || task.stale || task.blocked || task.review?.result !== 'pass') {
    return false
  }
  if (task.acceptor === undefined) return true
  const { reportOperationId, reportRevision, technical, business } = task.reviewReceipts ?? {}
  if (!nonempty(reportOperationId) || !Number.isSafeInteger(reportRevision)) return false
  if (technical?.actor !== task.reviewer || technical.result !== 'PASS' || !(technical.revision > reportRevision)) {
    return false
  }
  if (business?.actor !== task.acceptor || business.result !== 'PASS'
    || !(business.revision > technical.revision && business.revision <= task.revision)) {
    return false
  }
  const evidence = typeof task.review?.evidence === 'string' ? task.review.evidence : ''
  return evidence.split(/\r?\n/).some(line => line.trim() === `report_operation_id=${reportOperationId}`)
}

function buildCommentBody(task, kind, operationId) {
  const header = `[DS-Bot · ${task.id} rev${task.revision}]`
  switch (kind) {
    case 'started':
      return `${header} 开发流程已启动，状态变更为 \`working\`（op: ${operationId ?? 'board'}）。`
    case 'reported': {
      const env = nonempty(task.evidence?.environment) ? `｜环境：${task.evidence.environment.slice(0, 160)}` : ''
      return `${header} 开发已完成并提交验收报告，状态变更为 \`reported\`，等待独立审查/业务验收（op: ${operationId ?? 'board'}${env}）。`
    }
    case 'rework': {
      const gap = nonempty(task.review?.evidence) ? `｜原因：${task.review.evidence.slice(0, 240)}` : ''
      return `${header} 独立审查退回返工（\`rework\` -> \`working/waiting\`），请按缺陷补齐后重新汇报（op: ${operationId ?? 'board'}${gap}）。`
    }
    case 'done': {
      const receipts = task.reviewReceipts
      const extra = receipts?.reportOperationId
        ? `｜report=${receipts.reportOperationId}｜技术审查=${receipts.technical?.operationId ?? 'pass'}｜业务验收=${receipts.business?.operationId ?? 'pass'}`
        : ''
      return `${header} 独立审查与验收通过，状态已置 \`done\`（op: ${operationId ?? 'board'}${extra}）。`
    }
    case 'cancelled':
      return `${header} 原卡已取消（\`cancelled\`，op: ${operationId ?? 'board'}）。`
    case 'blocked': {
      const b = task.blocked ?? {}
      return `${header} 任务受阻：${String(b.reason ?? '').slice(0, 200)}｜解除条件：${String(b.condition ?? '').slice(0, 200)}｜责任人：${String(b.owner ?? '未指定')}。`
    }
    case 'unblocked':
      return `${header} 原卡阻塞已解除，继续推进（当前状态：\`${task.status}\`）。`
    default:
      return null
  }
}

export function mapBoardTransitionToLinear(before, after, options = {}) {
  if (!after || typeof after !== 'object') return null
  const states = { ...DEFAULT_STATES, ...(options.stateMap ?? {}) }
  const syncCancelled = options.syncCancelled !== false
  const prevStatus = before?.status ?? null
  const nextStatus = after.status

  if (prevStatus !== nextStatus) {
    if (nextStatus === 'working') {
      return {
        toStatus: 'working',
        targetState: states.working,
        fallbackTypes: FALLBACK_TYPES.started,
        commentKind: 'started',
      }
    }
    if (nextStatus === 'reported') {
      return {
        toStatus: 'reported',
        targetState: states.reported,
        fallbackTypes: FALLBACK_TYPES.reported,
        commentKind: 'reported',
      }
    }
    if (nextStatus === 'waiting' && prevStatus === 'reported' && after.review?.result === 'rework') {
      return {
        toStatus: 'rework',
        targetState: states.rework,
        fallbackTypes: FALLBACK_TYPES.rework,
        commentKind: 'rework',
      }
    }
    if (nextStatus === 'done') {
      if (!hasIndependentAcceptances(after)) {
        return { skippedReason: 'waiting-independent-acceptance' }
      }
      return {
        toStatus: 'done',
        targetState: states.done,
        fallbackTypes: FALLBACK_TYPES.done,
        commentKind: 'done',
      }
    }
    if (nextStatus === 'cancelled') {
      if (!syncCancelled) return null
      return {
        toStatus: 'cancelled',
        targetState: states.cancelled,
        fallbackTypes: FALLBACK_TYPES.cancelled,
        commentKind: 'cancelled',
      }
    }
  }

  const wasBlocked = Boolean(before?.blocked)
  const isBlocked = Boolean(after.blocked)
  if (!wasBlocked && isBlocked) {
    return { toStatus: 'blocked', targetState: null, fallbackTypes: [], commentKind: 'blocked' }
  }
  if (wasBlocked && !isBlocked) {
    return { toStatus: 'unblocked', targetState: null, fallbackTypes: [], commentKind: 'unblocked' }
  }
  return null
}

export function tryAutoBindTask(store, task, boardRoomId) {
  if (!task || task.parentTaskId || task.archivedAt || task.status === 'cancelled') return null
  if (boardRoomId && task.scope !== `room:${boardRoomId}`) return null
  const existing = store.bindingByTask(task.id)
  if (existing) return existing
  const text = `${task.title ?? ''}\n${task.description ?? ''}`
  if (!text.trim()) return null

  const known = store.listKnownIssues()
  const matches = []
  for (const issue of known) {
    if (store.bindingByIssue(issue.id)) continue
    const uuidHit = nonempty(issue.id) && text.toLowerCase().includes(issue.id.toLowerCase())
    const idHit = nonempty(issue.identifier)
      && new RegExp(`(?<![A-Za-z0-9-])${escapeRegExp(issue.identifier)}(?![A-Za-z0-9-])`, 'i').test(text)
    if (uuidHit || idHit) matches.push(issue)
  }
  if (matches.length !== 1) return null
  const target = matches[0]
  const roomId = boardRoomId ?? (typeof task.scope === 'string' && task.scope.startsWith('room:') ? task.scope.slice(5) : 'unknown')
  return store.bindIssue({
    issueId: target.id,
    identifier: target.identifier || target.id,
    taskId: task.id,
    roomId,
    source: 'auto',
  })
}

function isPermanentConflict(error) {
  const msg = String(error?.message ?? '')
  return /scope mismatch|workflow state unavailable|outside allowed fields|issue unavailable|belongs to a different/i.test(msg)
}

export function createLinearProjectSync({
  store,
  linear,
  boardRoomId,
  getBoardTask,
  assertActive = () => {},
  postComments = true,
  syncCancelled = true,
  stateMap = {},
  now = Date.now,
  onWarn = () => {},
}) {
  let draining
  const states = { ...DEFAULT_STATES, ...stateMap }
  const iso = ms => new Date(ms).toISOString()

  function fallbackTypesFor(job) {
    if (job.to_status === 'working') return FALLBACK_TYPES.started
    if (job.to_status === 'reported') return FALLBACK_TYPES.reported
    if (job.to_status === 'rework') return FALLBACK_TYPES.rework
    if (job.to_status === 'done') return FALLBACK_TYPES.done
    if (job.to_status === 'cancelled') return FALLBACK_TYPES.cancelled
    return []
  }

  function enqueueForTransition(before, after, operationId) {
    if (!after || after.parentTaskId) return null
    if (boardRoomId && after.scope !== `room:${boardRoomId}`) return null
    const binding = store.bindingByTask(after.id) ?? tryAutoBindTask(store, after, boardRoomId)
    if (!binding) return null
    const mapping = mapBoardTransitionToLinear(before, after, { stateMap: states, syncCancelled })
    if (!mapping || mapping.skippedReason) return null
    const opKey = nonempty(operationId)
      ? `outbound:${operationId}:${after.id}:rev${after.revision}:${mapping.toStatus}`
      : `outbound:${after.id}:rev${after.revision}:${mapping.toStatus}`
    const commentBody = postComments ? buildCommentBody(after, mapping.commentKind, operationId) : null
    return store.enqueueOutbound({
      operationId: opKey,
      issueId: binding.issueId,
      identifier: binding.identifier,
      taskId: after.id,
      taskRevision: after.revision,
      fromStatus: before?.status ?? null,
      toStatus: mapping.toStatus,
      targetLinearState: mapping.targetState,
      commentBody,
    })
  }

  async function processJob(job) {
    assertActive()
    if (typeof getBoardTask === 'function') {
      const liveTask = getBoardTask(job.task_id)
      if (!liveTask) {
        store.markOutboundConflict(job.operation_id, 'Bound board task no longer exists')
        return 'conflict'
      }
      if (job.to_status === 'done' && !hasIndependentAcceptances(liveTask)) {
        store.markOutboundConflict(job.operation_id, 'Independent acceptance gate no longer holds on board task')
        return 'conflict'
      }
    }

    if (job.target_linear_state) {
      if (typeof linear?.getIssueSnapshot !== 'function' || typeof linear?.updateIssueState !== 'function') {
        store.markOutboundConflict(job.operation_id, 'Linear write API unavailable')
        return 'conflict'
      }
      const snapshot = await linear.getIssueSnapshot({ issueId: job.issue_id })
      const attemptedMs = now()
      let finalState = snapshot.state
      let finalUpdatedAt = snapshot.updatedAt
      let finalStartedAt = snapshot.latestStateStartedAt

      if (snapshot.state.name.toLowerCase() !== job.target_linear_state.toLowerCase()) {
        store.markOutboundAttempt(job.operation_id, iso(attemptedMs), snapshot.updatedAt)
        const updated = await linear.updateIssueState({
          issueId: job.issue_id,
          teamId: snapshot.teamId,
          targetStateName: job.target_linear_state,
          targetStateTypes: fallbackTypesFor(job),
        })
        finalState = updated.state
        finalUpdatedAt = updated.updatedAt
        finalStartedAt = updated.stateStartedAt
      }
      const verifiedMs = now()
      store.recordOutboundEcho({
        issueId: job.issue_id,
        toStateId: finalState.id,
        toStateName: finalState.name,
        operationId: job.operation_id,
        attemptedMs,
        verifiedMs,
        remoteUpdatedMs: Date.parse(finalUpdatedAt) || null,
        stateStartedMs: finalStartedAt ? (Date.parse(finalStartedAt) || null) : null,
      })

      let commentPosted = Boolean(job.comment_posted)
      if (postComments && !commentPosted && nonempty(job.comment_body) && typeof linear.addIssueComment === 'function') {
        const commentOutcome = await linear.addIssueComment({ issueId: job.issue_id, body: job.comment_body })
        commentPosted = commentOutcome?.posted === true
      }

      store.markOutboundVerified(job.operation_id, {
        verifiedAt: iso(verifiedMs),
        remoteAfterAt: finalUpdatedAt,
        stateStartedAt: finalStartedAt,
        targetLinearState: finalState.name,
        commentPosted,
      })
      return 'verified'
    }

    let commentPosted = Boolean(job.comment_posted)
    if (postComments && !commentPosted && nonempty(job.comment_body) && typeof linear?.addIssueComment === 'function') {
      const commentOutcome = await linear.addIssueComment({ issueId: job.issue_id, body: job.comment_body })
      commentPosted = commentOutcome?.posted === true
    }
    store.markOutboundVerified(job.operation_id, { verifiedAt: iso(now()), commentPosted })
    return 'verified'
  }

  async function runDrain() {
    for (;;) {
      let job
      try {
        assertActive()
        job = store.nextOutbound(now())
      } catch {
        return
      }
      if (!job) return
      try {
        await processJob(job)
      } catch (error) {
        if (isPermanentConflict(error)) {
          store.markOutboundConflict(job.operation_id, error.message)
          onWarn(`ds-bot: Linear outbound conflict for ${job.identifier} (${job.task_id}): ${error.message}`)
          continue
        }
        const retryMs = Number.isFinite(error?.retryAfterMs) ? error.retryAfterMs : 0
        const backoff = Math.max(retryMs, Math.min(5 * 60_000, 5_000 * 2 ** Math.min(job.attempts ?? 0, 5)))
        store.markOutboundRetry(job.operation_id, now() + backoff, error?.message || 'outbound sync unavailable')
        return
      }
    }
  }

  function drain() {
    draining ??= runDrain().finally(() => { draining = undefined })
    return draining
  }

  function handleBoardCommit(events) {
    if (!Array.isArray(events) || !events.length) return []
    const queued = []
    for (const entry of events) {
      try {
        const res = enqueueForTransition(entry?.before ?? null, entry?.after ?? null, entry?.operationId)
        if (res?.inserted) queued.push(res.job)
      } catch (error) {
        onWarn(`ds-bot: Linear outbound enqueue failed: ${error?.message || error}`)
      }
    }
    if (queued.length) queueMicrotask(() => { void drain() })
    return queued
  }

  function syncTaskNow(task) {
    if (!task) return null
    const syntheticBefore = ['working', 'reported', 'done', 'cancelled'].includes(task.status)
      ? { status: 'proposed', blocked: null }
      : { status: task.status, blocked: null }
    const res = enqueueForTransition(syntheticBefore, task, `bind-sync-rev${task.revision}`)
    if (res?.inserted) queueMicrotask(() => { void drain() })
    return res?.job ?? null
  }

  return {
    handleBoardCommit,
    syncTaskNow,
    drain,
  }
}
