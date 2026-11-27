const LINEAR_GRAPHQL = 'https://api.linear.app/graphql'
const PROJECT_ISSUES = `query MonitorProjectIssues($projectId: String!, $filter: IssueFilter!, $after: String) {
  project(id: $projectId) {
    id
    issues(filter: $filter, first: 50, after: $after, orderBy: updatedAt, includeArchived: true) {
      nodes { id identifier url updatedAt archivedAt state { id name } }
      pageInfo { hasNextPage endCursor }
    }
  }
}`
const ISSUE_HISTORY = `query MonitorIssueHistory($issueId: String!, $after: String) {
  issue(id: $issueId) {
    id
    project { id }
    history(first: 25, after: $after, orderBy: updatedAt) {
      nodes { id createdAt updatedAt actorId fromStateId toStateId }
      pageInfo { hasNextPage endCursor }
    }
  }
}`

export class LinearProjectReadError extends Error {
  constructor(reason, retryAfterMs = 0) {
    super(reason)
    this.retryAfterMs = retryAfterMs
  }
}

function retryDelay(headers, now) {
  const retryAfter = headers.get('retry-after')
  if (retryAfter !== null) {
    const seconds = Number(retryAfter)
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
    const retryAt = Date.parse(retryAfter)
    if (Number.isFinite(retryAt)) return Math.max(0, retryAt - now())
  }
  const reset = Number(headers.get('x-ratelimit-requests-reset'))
  return Number.isFinite(reset) ? Math.max(0, reset - now()) : 0
}

export function createLinearProjectApi({ projectId, authorize, request = fetch, now = Date.now, signal }) {
  let retryAt = 0
  async function query(queryText, variables) {
    const remainingWait = retryAt - now()
    if (remainingWait > 0) throw new LinearProjectReadError('rate limited', remainingWait)
    const authorization = await authorize()
    const timeout = AbortSignal.timeout(8_000)
    let response
    try {
      response = await request(LINEAR_GRAPHQL, {
        method: 'POST',
        redirect: 'error',
        signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
        headers: { authorization, 'content-type': 'application/json' },
        body: JSON.stringify({ query: queryText, variables }),
      })
    } catch {
      throw new LinearProjectReadError('Linear unavailable')
    }
    const rateLimited = () => {
      const delay = Math.max(5_000, retryDelay(response.headers, now))
      retryAt = now() + delay
      return new LinearProjectReadError('rate limited', delay)
    }
    if (response.status === 429) throw rateLimited()
    if (response.status === 401 || response.status === 403) throw new LinearProjectReadError('Linear authorization unavailable')
    if (!response.ok) throw new LinearProjectReadError('Linear unavailable')
    const body = await response.json().catch(() => null)
    if (body?.errors?.some?.(error => error?.extensions?.code === 'RATELIMITED')) throw rateLimited()
    if (!body?.data || body.errors?.length) throw new LinearProjectReadError('Linear read rejected')
    return body.data
  }

  return {
    async listIssues({ projectId: requestedProjectId, after, from, until }) {
      if (requestedProjectId !== projectId) throw new LinearProjectReadError('Linear project scope mismatch')
      const filter = { updatedAt: { ...(from ? { gte: from } : {}), lt: until } }
      const { project } = await query(PROJECT_ISSUES, { projectId, filter, after })
      if (project?.id !== projectId || !project.issues) throw new LinearProjectReadError('Linear project unavailable')
      return project.issues
    },
    async listHistory({ issueId, after }) {
      const { issue } = await query(ISSUE_HISTORY, { issueId, after })
      if (issue?.id !== issueId || !issue.history) throw new LinearProjectReadError('Linear issue unavailable')
      if (issue.project?.id !== projectId) return { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } }
      return issue.history
    },
  }
}
