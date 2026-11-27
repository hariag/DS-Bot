import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createLinearProjectMcpApi } from '../../src/host/linear-project-mcp.mjs'

const projectId = 'project-uuid'
const teamId = 'team-uuid'
const updatedAt = '2026-11-26T08:15:33.050Z'
const todo = { id: 'todo-uuid', name: 'Todo', type: 'unstarted' }
const done = { id: 'done-uuid', name: 'Done', type: 'completed' }
const issue = (id, uuid, status = done) => ({
  id, uuid, url: 'https://linear.app/test/issue/' + id, projectId, teamId,
  status: status.name, statusType: status.type, updatedAt, archivedAt: null,
})

test('use the project, archived scope, cursor and updatedAt supported by Linear MCP', async () => {
  const calls = []
  const api = createLinearProjectMcpApi({ projectId, async call(name, args) {
    calls.push([name, args])
    if (name === 'list_issue_statuses') return [todo, done]
    if (args.cursor) return { issues: [issue('HAR-5', 'issue-5', todo)], hasNextPage: false }
    return { issues: [{ ...issue('HAR-6', 'issue-6'), archivedAt: updatedAt }], hasNextPage: true, cursor: 'cursor-2' }
  } })
  const first = await api.listIssues({ projectId })
  assert.deepEqual(first.nodes[0], {
    id: 'issue-6', identifier: 'HAR-6', url: 'https://linear.app/test/issue/HAR-6', updatedAt, archivedAt: updatedAt,
    state: { id: done.id, name: done.name },
  })
  assert.deepEqual(first.pageInfo, { hasNextPage: true, endCursor: 'cursor-2' })
  const second = await api.listIssues({ projectId, after: first.pageInfo.endCursor, from: updatedAt })
  assert.equal(second.nodes[0].identifier, 'HAR-5')
  assert.equal(second.nodes[0].state.id, todo.id)
  assert.equal(second.nodes[0].archivedAt, null)
  assert.deepEqual(second.pageInfo, { hasNextPage: false, endCursor: null })
  assert.deepEqual(calls, [
    ['list_issues', { project: projectId, includeArchived: true, orderBy: 'updatedAt', limit: 50,
      fields: ['uuid', 'status', 'statusType', 'url', 'projectId', 'updatedAt', 'teamId', 'archivedAt'] }],
    ['list_issue_statuses', { team: teamId }],
    ['list_issues', { project: projectId, includeArchived: true, orderBy: 'updatedAt', limit: 50,
      fields: ['uuid', 'status', 'statusType', 'url', 'projectId', 'updatedAt', 'teamId', 'archivedAt'], cursor: 'cursor-2', updatedAt }],
  ])
})

test('scope and incomplete pagination fail closed before querying a workflow', async () => {
  const calls = []
  let response = { issues: [], hasNextPage: true }
  const api = createLinearProjectMcpApi({ projectId, async call(name) { calls.push(name); return response } })
  await assert.rejects(api.listIssues({ projectId: 'other' }), /scope mismatch/)
  assert.deepEqual(calls, [])
  await assert.rejects(api.listIssues({ projectId }), /cursor unavailable/)
  response = { issues: [{ ...issue('HAR-8', 'outside'), projectId: 'other' }], hasNextPage: false }
  await assert.rejects(api.listIssues({ projectId }), /issue scope unavailable/)
  assert.deepEqual(calls, ['list_issues', 'list_issues'])
})

test('map unique workflow states by name and type, and refresh a cached workflow for new states', async () => {
  let selection = todo
  let statusReads = 0
  const started = { ...todo, id: 'started-uuid', type: 'started' }
  const api = createLinearProjectMcpApi({ projectId, async call(name) {
    if (name === 'list_issues') return { issues: [issue('HAR-5', 'issue-5', selection)], hasNextPage: false }
    statusReads++
    return statusReads === 1 ? [todo] : [todo, started]
  } })
  assert.equal((await api.listIssues({ projectId })).nodes[0].state.id, todo.id)
  selection = started
  assert.equal((await api.listIssues({ projectId })).nodes[0].state.id, started.id)
  assert.equal(statusReads, 2)
})

test('derive newest-first history from known spans without fabricating a first transition or actor', async () => {
  const first = '2026-11-26T08:00:00.000Z'
  const second = '2026-11-26T08:10:00.000Z'
  const third = '2026-11-26T08:30:00.000Z'
  const middleEnd = '2026-11-26T08:25:00.000Z'
  const spans = [
    { state: todo, startedAt: third, endedAt: null },
    { state: todo, startedAt: first, endedAt: second },
    { state: done, startedAt: second, endedAt: middleEnd },
  ]
  let membership = projectId
  const api = createLinearProjectMcpApi({ projectId, async call(name, args) {
    assert.equal(name, 'get_issue')
    assert.deepEqual(args, { id: 'issue-6', fields: ['uuid', 'projectId', 'stateHistory', 'updatedAt'] })
    return { ...issue('HAR-6', 'issue-6'), projectId: membership, stateHistory: spans }
  } })
  const read = await api.listHistory({ issueId: 'issue-6' })
  assert.deepEqual(read.nodes.map(({ createdAt, updatedAt, actorId, fromStateId, toStateId }) => ({ createdAt, updatedAt, actorId, fromStateId, toStateId })), [
    { createdAt: third, updatedAt: third, actorId: null, fromStateId: null, toStateId: todo.id },
    { createdAt: second, updatedAt: second, actorId: null, fromStateId: todo.id, toStateId: done.id },
  ])
  assert.deepEqual(read, await api.listHistory({ issueId: 'issue-6' }))
  membership = 'other'
  assert.deepEqual(await api.listHistory({ issueId: 'issue-6' }), { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } })
})
