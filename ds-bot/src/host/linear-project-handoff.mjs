import { createHash } from 'node:crypto'
import { chineseRolePrompt } from './prompt-language.mjs'

const MAX_EVENTS = 20
const SOURCE = 'Linear project watcher'
const identifierPattern = /^[A-Z][A-Z0-9_-]{0,23}-[0-9]{1,12}$/i
const ALLOWED_CONTENT_FIELDS = new Set(['title', 'description', 'priority', 'labels'])

const ref = value => typeof value === 'string' && /^[a-z0-9:_-]{1,160}$/i.test(value)
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value))
  ? new Date(value).toISOString() : undefined

function issueLink(event) {
  if (typeof event.identifier !== 'string' || !identifierPattern.test(event.identifier)) return event.issueId
  try {
    const url = new URL(event.url)
    const match = /^\/([a-z0-9-]+)\/issue\/([^/]+)/i.exec(url.pathname)
    if (url.origin === 'https://linear.app' && !url.username && !url.password && match?.[2] === event.identifier) {
      return `[${event.identifier}](https://linear.app/${match[1]}/issue/${event.identifier})`
    }
  } catch { /* A missing or invalid link does not prevent the project manager from using the issue identifier. */ }
  return event.identifier
}

function safeChangedFields(event) {
  const fields = Array.isArray(event.changedFields)
    ? event.changedFields.filter(field => typeof field === 'string' && ALLOWED_CONTENT_FIELDS.has(field))
    : []
  return fields.length ? fields.join(', ') : 'metadata'
}

function eventLine(event, chinese = false) {
  if (!ref(event?.id) || !ref(event.issueId)) throw new TypeError('Invalid Linear event reference')
  const before = ref(event.fromStateId) ? event.fromStateId : 'unknown'
  const after = ref(event.toStateId) ? event.toStateId : 'unknown'
  const sourceTime = event.historyId ? timestamp(event.sourceUpdatedAt ?? event.at) : undefined
  const observed = timestamp(event.observedAt)
  const time = chinese
    ? (sourceTime ? `历史变更于 ${sourceTime}` : observed ? `检出于 ${observed}` : '时间未知')
    : (sourceTime ? `history updated at ${sourceTime}` : observed ? `observed at ${observed}` : 'time unavailable')
  const actor = ref(event.actorId) ? (chinese ? ` | 操作者 ${event.actorId}` : ` | actor ${event.actorId}`) : ''
  if (event.kind === 'intake') {
    return chinese
      ? `- ${issueLink(event)} | 存量可开工候选项（当前状态 ${after}）| ${time} | 事件 ${event.id}`
      : `- ${issueLink(event)} | existing intake candidate in state ${after} | ${time} | event ${event.id}`
  }
  if (event.kind === 'content_changed') {
    const fields = safeChangedFields(event)
    return chinese
      ? `- ${issueLink(event)} | 需求/设计字段已更新（${fields}）| ${time} | 事件 ${event.id}`
      : `- ${issueLink(event)} | requirement/design updated (${fields}) | ${time} | event ${event.id}`
  }
  return chinese
    ? `- ${issueLink(event)} | ${before} → ${after} | ${time}${actor} | 事件 ${event.id}`
    : `- ${issueLink(event)} | ${before} → ${after} | ${time}${actor} | event ${event.id}`
}

function formatBatch(batch, projectId, boardRoomId, chinese = false) {
  if (!ref(batch?.id) || batch.projectId !== projectId || !Array.isArray(batch.events)
    || batch.events.length < 1 || batch.events.length > MAX_EVENTS
    || batch.events.some(event => event?.projectId !== undefined && event.projectId !== projectId)) {
    throw new TypeError('Invalid Linear project batch')
  }
  const lines = batch.events.map(event => eventLine(event, chinese))
  if (chinese) {
    return [
      `Linear 项目 ${projectId} 有 ${batch.events.length} 条新进件、状态变更或需求更新。批次：${batch.id}。`,
      ...(boardRoomId ? [`本项目的研发执行、测试、运维与 Bug 修复一律使用已批准的 DS Bot 群 ${boardRoomId}。`] : []),
      ...lines,
      '分工边界：Linear 负责计划、需求、设计与 Bug 追踪；DS-Bot 负责开发实现、测试、运维与修复闭环。',
      '请先调用 `linear_project_changes`（`action: "list"`）查看完整变更，并回读对应 Linear 工单与 DS-Bot 原卡查重。',
      '若为已授权项目范围内的新增/可开工事项：明确 owner、独立 reviewer、acceptor、目标版本、写集与验收标准后，调用 `board_task register` 建唯一主卡（可在 DS-Bot 内继续拆分编码/测试/运维子任务），再用 `linear_project_changes`（`action: "bind"`）绑定工单与主卡并推动负责人直接开工，无需再逐单向用户申请批准。',
      '若为已有绑定的需求/设计正文变更（content_changed）：核对 Linear 最新内容后同步更新原卡或提交变更提案，确保下游开发与测试按最新口径执行。',
      'DS-Bot 主卡的开工、提测、返工与双门通过闭环后，宿主会自动实时回写对应 Linear 状态并核销回声；完成核对或跟进留痕后，请调用 `linear_project_changes`（`action: "resolve"`）登记处理意见与证据。',
    ].join('\n')
  }
  return [
    `Linear project ${projectId} has ${batch.events.length} intake candidates or status changes. Batch: ${batch.id}.`,
    ...(boardRoomId ? [`Use the approved DS Bot room ${boardRoomId} for this project's board work.`] : []),
    ...lines,
    'Use `linear_project_changes` with `action: list`. An intake candidate means the issue already has a configured workflow state. Verify the current Linear issue and look up its original DS Bot card before registering anything.',
    'For routine work within the approved project scope, check the owner, independent reviewer and acceptor, target version, write scope, dependencies, and acceptance criteria. When ready, record the start decision and have the owner start without asking the user for approval again.',
    'If registered on DS Bot, use `linear_project_changes` with `action: bind` to link the Linear issue to its top-level DS Bot card so execution, review, rework, and dual-gate completion sync back to Linear automatically.',
    'For an authorized manually tracked card, the owner can use `board_task start` from `proposed` or `waiting`. For a system-dispatched card, wait for its accepted admission and use its existing action. If the original is already working, continue it without dispatching again.',
    'Record missing prerequisites, a named person responsible, and the next check on the original card. Escalate decisions outside the approved scope or requiring new authority. Keep independent review and acceptance separate. Use `action: resolve` once the handling or follow-up is recorded with evidence.',
  ].join('\n')
}

export function createLinearProjectHandoff(rt, { managerId, projectId, boardRoomId, assertActive = () => {} }) {
  if (!ref(managerId) || !ref(projectId) || (boardRoomId !== undefined && !ref(boardRoomId))) throw new TypeError('Invalid Linear project handoff configuration')

  const availableSession = () => {
    const bot = rt.botOf(managerId)
    if (bot?.id === managerId && bot.private !== true && !rt.stopping && rt.readOnly() === undefined) return rt.chatOf(managerId)
  }

  return async batch => {
    const chinese = chineseRolePrompt(rt.botOf(managerId)?.instructions)
    const text = formatBatch(batch, projectId, boardRoomId, chinese)
    await rt.load()
    const request = rt.requestIdentity({
      caller: 'linear-project-watcher', context: projectId, name: batch.id, payload: { to: managerId, text },
    })
    const exchangeId = 'linear-project:' + createHash('sha256').update(request.key).digest('hex')
    const previous = await rt.knownRequest(request)
    if (previous !== undefined) return deliveryResult(previous, { exchangeId })

    const sessionId = availableSession()
    if (!sessionId) return { status: 'retry', reason: rt.readOnly() === undefined ? 'manager-unavailable' : 'host-read-only' }
    const receipt = { sessionId, exchangeId }

    try {
      const outcome = await rt.admitRequest(request, async () => {
        try {
          const delivered = await rt.deliver({
            toId: managerId, sessionId, role: 'connector', fromName: SOURCE, text, exchangeId, recordExchange: false,
          }, {
            beforeAdmission(agent) {
              assertActive()
              if (agent.id !== sessionId || availableSession() !== sessionId) throw new Error('Linear handoff target changed')
            },
            onNotAdmitted() { request.unsent = true },
            afterAdmission(_agent, message) {
              if (typeof message?.id === 'string' && message.id) receipt.messageId = message.id
              receipt.admittedAt = new Date().toISOString()
            },
          })
          if (delivered !== exchangeId || !receipt.messageId) throw new Error('Linear handoff admission could not be verified')
        } catch (error) {
          if (!request.unsent) throw error
          return { status: 'retry', reason: 'manager-unavailable' }
        }
        return { status: 'delivered', ...receipt }
      })
      return deliveryResult(outcome, receipt)
    } catch (error) {
      // A failed session flush can follow a successful admission. Keep that batch
      // for readback instead of trying another send after a restart or timeout.
      const outcome = await rt.knownRequest(request)
      if (outcome === undefined) throw error
      return deliveryResult(outcome, receipt)
    }
  }
}

function deliveryResult(outcome, receipt) {
  if (outcome.status === 'sent' || outcome.status === 'replay') return outcome.receipt
  if (outcome.status === 'readonly') return { status: 'retry', reason: 'host-read-only' }
  return { status: 'uncertain', reason: outcome.status, ...receipt }
}
