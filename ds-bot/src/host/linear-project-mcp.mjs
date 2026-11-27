import { createHash } from 'node:crypto'
import { LinearProjectReadError } from './linear-project-api.mjs'

const STATUS_TTL_MS = 5 * 60_000
const ISSUES_FIELDS = ['uuid', 'status', 'statusType', 'url', 'projectId', 'updatedAt', 'teamId', 'archivedAt']
const HISTORY_FIELDS = ['uuid', 'projectId', 'stateHistory', 'updatedAt']
const CONTENT_FIELDS = ['title', 'description', 'priority', 'labels']
const SNAPSHOT_FIELDS = ['uuid', 'id', 'status', 'statusType', 'url', 'projectId', 'teamId', 'updatedAt', 'archivedAt', 'stateHistory']
const nonempty = value => typeof value === 'string' && value.length > 0
const endOfPages = () => ({ hasNextPage: false, endCursor: null })

function readTimestamp(timestamp) {
  const time = nonempty(timestamp) ? Date.parse(timestamp) : NaN
  if (!Number.isFinite(time)) throw new LinearProjectReadError('Linear MCP returned an invalid timestamp')
  return time
}

function historyRows(issueId, spans) {
  if (!Array.isArray(spans)) throw new LinearProjectReadError('Linear MCP issue history unavailable')
  const ordered = spans.map(span => ({
    id: nonempty(span?.state?.id) ? span.state.id : null,
    start: readTimestamp(span?.startedAt),
    end: span?.endedAt == null ? null : readTimestamp(span.endedAt),
  })).sort((a, b) => a.start - b.start)
  const rows = []
  for (let index = 1; index < ordered.length; index++) {
    const previous = ordered[index - 1]
    const current = ordered[index]
    if (current.id === null || current.id === previous.id || current.start <= previous.start) continue
    const updatedAt = new Date(current.start).toISOString()
    const fromStateId = previous.end === current.start ? previous.id : null
    const id = createHash('sha256').update(JSON.stringify([issueId, updatedAt, current.id])).digest('hex')
    rows.push({ id, createdAt: updatedAt, updatedAt, actorId: null, fromStateId, toStateId: current.id })
  }
  return rows.reverse()
}

function latestStateStart(spans) {
  if (!Array.isArray(spans) || !spans.length) return null
  const ordered = spans
    .filter(span => nonempty(span?.startedAt))
    .map(span => readTimestamp(span.startedAt))
    .sort((a, b) => a - b)
  return ordered.length ? new Date(ordered.at(-1)).toISOString() : null
}

function extractContentMeta(issue) {
  const { title, description, priority, labels } = issue
  if (typeof title !== 'string' || (typeof description !== 'string' && description !== null)
    || (priority !== null && !Number.isFinite(priority) && !Number.isFinite(priority?.value)) || !Array.isArray(labels)) return
  const names = labels.map(entry => typeof entry === 'string' ? entry : entry?.name ?? entry?.id)
  if (!names.every(nonempty)) return
  return { title, description:description ?? '', priority, labels:names.sort() }
}

export function createLinearProjectMcpApi({ projectId, call, callWrite, hasWriteTool, ensureConnected, watchContentChanges = false, now = Date.now }) {
  const statuses = new Map()

  async function loadStatuses(teamId) {
    const rows = await call('list_issue_statuses', { team: teamId })
    if (!Array.isArray(rows) || rows.some(row => ![row?.id, row?.name, row?.type].every(nonempty))) {
      throw new LinearProjectReadError('Linear MCP team workflow unavailable')
    }
    const latest = { rows, expiresAt: now() + STATUS_TTL_MS }
    statuses.set(teamId, latest)
    return latest
  }

  async function issueState({ teamId, status, statusType }) {
    if (![teamId, status, statusType].every(nonempty)) throw new LinearProjectReadError('Linear MCP issue state unavailable')
    const find = ({ rows }) => rows.filter(row => row.name === status && row.type === statusType)
    const cached = statuses.get(teamId)
    const valid = cached && cached.expiresAt > now()
    let matches = find(valid ? cached : await loadStatuses(teamId))
    if (valid && matches.length !== 1) matches = find(await loadStatuses(teamId))
    if (matches.length !== 1) throw new LinearProjectReadError('Linear MCP issue state ambiguous')
    const { id, name } = matches[0]
    return { id, name }
  }

  async function resolveTargetStatus(teamId, targetStateName, targetStateTypes = []) {
    const findByName = ({ rows }) => rows.filter(row => row.name.toLowerCase() === targetStateName.toLowerCase())
    const findByType = ({ rows }) => rows.filter(row => targetStateTypes.includes(row.type))
    const resolveFrom = catalog => {
      const byName = findByName(catalog)
      if (byName.length === 1) return byName[0]
      if (byName.length === 0 && targetStateTypes.length) {
        const byType = findByType(catalog)
        if (byType.length === 1) return byType[0]
      }
      return null
    }
    const cached = statuses.get(teamId)
    const valid = cached && cached.expiresAt > now()
    let match = resolveFrom(valid ? cached : await loadStatuses(teamId))
    if (valid && !match) match = resolveFrom(await loadStatuses(teamId))
    if (!match) throw new LinearProjectReadError('Linear workflow state unavailable')
    return match
  }

  async function getIssueSnapshot({ issueId }) {
    const issue = await call('get_issue', { id: issueId, fields: SNAPSHOT_FIELDS })
    if (![issue?.uuid, issue?.id, issue?.updatedAt, issue?.teamId].every(nonempty)
      || (issue.uuid.toLowerCase() !== issueId.toLowerCase() && issue.id.toLowerCase() !== issueId.toLowerCase())) {
      throw new LinearProjectReadError('Linear MCP issue unavailable')
    }
    if (issue.projectId !== projectId) throw new LinearProjectReadError('Linear project scope mismatch')
    const state = await issueState(issue)
    return {
      id: issue.uuid,
      identifier: issue.id,
      teamId: issue.teamId,
      url: issue.url ?? null,
      updatedAt: issue.updatedAt,
      archivedAt: issue.archivedAt ?? null,
      state,
      latestStateStartedAt: latestStateStart(issue.stateHistory),
    }
  }

  return {
    watchContentChanges,
    async listIssues({ projectId: requestedProjectId, after, from }) {
      if (requestedProjectId !== projectId) throw new LinearProjectReadError('Linear project scope mismatch')
      const page = await call('list_issues', {
        project: projectId, includeArchived: true, orderBy: 'updatedAt', limit: 50,
        fields: watchContentChanges ? [...ISSUES_FIELDS, ...CONTENT_FIELDS] : ISSUES_FIELDS,
        ...(after ? { cursor: after } : {}), ...(from ? { updatedAt: from } : {}),
      })
      if (!Array.isArray(page?.issues) || typeof page.hasNextPage !== 'boolean') {
        throw new LinearProjectReadError('Linear MCP project listing unavailable')
      }
      const endCursor = page.hasNextPage ? page.cursor ?? page.nextCursor ?? page.endCursor : null
      if (page.hasNextPage && !nonempty(endCursor)) throw new LinearProjectReadError('Linear MCP project cursor unavailable')
      const nodes = []
      for (const issue of page.issues) {
        if (issue?.projectId !== projectId || ![issue.uuid, issue.id, issue.updatedAt].every(nonempty)) {
          throw new LinearProjectReadError('Linear MCP project issue scope unavailable')
        }
        const state = await issueState(issue)
        const contentMeta = watchContentChanges ? extractContentMeta(issue) : undefined
        nodes.push({ id: issue.uuid, identifier: issue.id, url: issue.url, updatedAt: issue.updatedAt, archivedAt: issue.archivedAt, state,
          ...(contentMeta ? { contentMeta } : {}) })
      }
      return { nodes, pageInfo: { hasNextPage: page.hasNextPage, endCursor } }
    },
    async listHistory({ issueId, includeContent = true }) {
      const fields = watchContentChanges && includeContent ? [...HISTORY_FIELDS, ...CONTENT_FIELDS] : HISTORY_FIELDS
      const issue = await call('get_issue', { id: issueId, fields })
      if (issue?.uuid !== issueId) throw new LinearProjectReadError('Linear MCP issue unavailable')
      if (issue.projectId !== projectId) return { nodes: [], pageInfo: endOfPages() }
      const contentMeta = watchContentChanges && includeContent ? extractContentMeta(issue) : undefined
      return {
        nodes: historyRows(issueId, issue.stateHistory),
        pageInfo: endOfPages(),
        ...(contentMeta ? { contentMeta, contentUpdatedAt:issue.updatedAt } : {}),
      }
    },
    getIssueSnapshot,
    async updateIssueState({ issueId, teamId, targetStateName, targetStateTypes = [] }) {
      if (typeof callWrite !== 'function') throw new LinearProjectReadError('Linear MCP write disabled')
      if (!nonempty(issueId) || !nonempty(targetStateName)) throw new LinearProjectReadError('Linear state update arguments invalid')
      const resolvedTeamId = nonempty(teamId) ? teamId : (await getIssueSnapshot({ issueId })).teamId
      const target = await resolveTargetStatus(resolvedTeamId, targetStateName, targetStateTypes)
      await callWrite('save_issue', { id: issueId, state: target.name })
      const confirmed = await getIssueSnapshot({ issueId })
      if (confirmed.state.id !== target.id && confirmed.state.name.toLowerCase() !== target.name.toLowerCase()) {
        throw new LinearProjectReadError('Linear state write could not be confirmed')
      }
      return {
        state: confirmed.state,
        updatedAt: confirmed.updatedAt,
        stateStartedAt: confirmed.latestStateStartedAt,
      }
    },
    async addIssueComment({ issueId, body }) {
      if (typeof callWrite !== 'function' || typeof hasWriteTool !== 'function') {
        return { posted: false, reason: 'write-disabled' }
      }
      if (!nonempty(issueId) || typeof body !== 'string' || !body.trim()) {
        return { posted: false, reason: 'invalid-comment' }
      }
      try {
        await ensureConnected?.()
        const toolName = ['create_comment', 'save_comment'].find(name => hasWriteTool(name))
        if (!toolName) return { posted: false, reason: 'comment-tool-unavailable' }
        await callWrite(toolName, { issueId, body: body.trim().slice(0, 1500) })
        return { posted: true, tool: toolName }
      } catch (error) {
        return { posted: false, reason: error?.message || 'comment-failed' }
      }
    },
  }
}
