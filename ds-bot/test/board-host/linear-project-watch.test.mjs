import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createLinearProjectApi } from '../../src/host/linear-project-api.mjs'
import { install as installWatch } from '../../src/host/linear-project-watch.mjs'
import { install as installRequests } from '../../src/host/requests.js'

const projectId = 'a2743c77-056b-46e9-8d14-11f057eb897f'
const managerId = 'manager-1'
const initial = Date.parse('2026-11-26T08:00:00Z')
const time = offset => new Date(initial + offset).toISOString()
const connection = (nodes, endCursor = null) => ({ nodes, pageInfo: { hasNextPage: endCursor !== null, endCursor } })
const issue = (id, number, stateId, offset) => ({ id, identifier: `TEST-${number}`, url: `https://linear.app/test/issue/TEST-${number}`,
  updatedAt: time(offset), state: { id: stateId, name: stateId } })

test('an invalid manager binding leaves the plugin operational with the watcher disabled', () => {
  const warnings = []
  const rt = { config: { linearProjectWatch: { projectId, managerId: 'Project Manager', readSecret: 'LINEAR_TEST' } },
    teamTools: [], warn: message => warnings.push(message) }
  installWatch(rt)
  assert.equal(warnings.length, 1)
  assert.equal(rt.teamTools.length, 0)
})

test('project worker scans all pages, hands multiple issue changes to the manager, and records a disposition separately', async t => {
  const home = await mkdtemp(join(tmpdir(), 'linear-project-watch-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: initial })
  let issues = [issue('issue-1', 1, 'todo', -2000), issue('issue-2', 2, 'todo', -1000)]
  const calls = []
  t.mock.method(globalThis, 'fetch', async (target, request) => {
    assert.equal(target, 'https://api.linear.app/graphql')
    assert.equal(request.headers.authorization, 'test-read-credential')
    const { query, variables } = JSON.parse(request.body)
    calls.push(variables)
    if (query.includes('MonitorProjectIssues')) {
      assert.equal(variables.projectId, projectId)
      const window = variables.filter.updatedAt
      const matching = issues.filter(row => row.updatedAt < window.lt && (!window.gte || row.updatedAt >= window.gte))
      const page = variables.after ? connection(matching.slice(1))
        : connection(matching.slice(0, 1), matching.length > 1 ? 'next' : null)
      return Response.json({ data: { project: { id: projectId, issues: page } } })
    }
    const changed = issues.find(row => row.id === variables.issueId)
    const nodes = changed.state.id === 'todo' ? [] : [{ id: `history-${changed.id}`, actorId: 'linear-actor',
      fromStateId: 'todo', toStateId: changed.state.id, createdAt: changed.updatedAt, updatedAt: changed.updatedAt }]
    return Response.json({ data: { issue: { id: changed.id, project: { id: projectId }, history: connection(nodes) } } })
  })
  let cleanup
  const messages = []
  const rt = {
    config: { linearProjectWatch: { projectId, managerId, readSecret: 'LINEAR_TEST' } }, home, state: {}, teamTools: [],
    ctx: { effect: start => { cleanup = start() } },
    own: (record, key) => Object.hasOwn(record, key) ? record[key] : undefined,
    botOf: id => id === managerId ? { id } : undefined,
    chatOf: () => 'manager-chat', chatOwners: new Map([['manager-chat', managerId]]), groupOwners: new Map(),
    load: async () => {}, save: async () => {}, loadSecrets: async () => {}, requireHomeLock() {},
    readOnly: () => undefined, canUseSecret: () => true, secretValue: () => 'test-read-credential', warn() {},
    async deliver(args, observer) {
      const agent = { id: args.sessionId }
      observer.beforeAdmission(agent)
      messages.push(args)
      observer.afterAdmission(agent, { id: `message-${messages.length}` })
      return args.exchangeId
    },
  }
  installRequests(rt)
  installWatch(rt)
  const tool = rt.teamTools.find(item => item.name === 'linear_project_changes')
  const inbox = agent => tool.execute({ action: 'list' }, { agent: { id: agent } })
  async function until(check) {
    for (let turns = 0; turns < 50; turns++) {
      if (await check()) return
      await new Promise(resolve => setImmediate(resolve))
    }
    assert.fail('worker did not finish the expected step')
  }
  try {
    t.mock.timers.tick(0)
    await until(async () => (await inbox('manager-chat')).includes('"baseline":true'))
    assert.equal(calls.filter(call => call.projectId && call.after === 'next').length, 1)
    assert.equal(messages.length, 0)
    assert.equal(JSON.parse(await inbox('manager-chat')).changes.length, 0)
    assert.match(await inbox('other-chat'), /assigned project manager/)

    issues = [issue('issue-1', 1, 'working', 1000), issue('issue-2', 2, 'review', 2000)]
    t.mock.timers.tick(5_000)
    await until(async () => messages.length === 1 && JSON.parse(await inbox('manager-chat')).handoffState === 'delivered')
    const items = JSON.parse(await inbox('manager-chat')).changes
    assert.deepEqual(items.map(row => [row.identifier, row.fromStateId, row.toStateId]), [
      ['TEST-1', 'todo', 'working'], ['TEST-2', 'todo', 'review'],
    ])
    assert.equal(messages[0].toId, managerId)
    assert.match(messages[0].text, /TEST-1/)
    assert.match(messages[0].text, /TEST-2/)
    assert.match(await tool.execute({ action: 'resolve', event_ids: [items[0].id], note: 'Filed the original task update.' },
      { agent: { id: 'manager-chat' } }), /1 events/)
    assert.deepEqual(JSON.parse(await inbox('manager-chat')).changes.map(row => row.id), [items[1].id])
    const afterHandled = await tool.execute({ action: 'list', after: items[0].id }, { agent: { id: 'manager-chat' } })
    assert.deepEqual(JSON.parse(afterHandled).changes.map(row => row.id), [items[1].id])
  } finally {
    await cleanup()
  }
})

test('rate-limit response holds future Linear requests and never reflects external errors', async () => {
  let now = initial
  let requests = 0
  const api = createLinearProjectApi({ projectId, now: () => now, authorize: async () => 'test-read-credential',
    request: async () => {
      requests++
      if (requests === 1) return Response.json({ errors: [{ message: 'external text', extensions: { code: 'RATELIMITED' } }] },
        { headers: { 'Retry-After': '20' } })
      return Response.json({ data: { project: { id: projectId, issues: connection([]) } } })
    },
  })
  const query = { projectId, until: time(0) }
  await assert.rejects(api.listIssues(query), { message: 'rate limited', retryAfterMs: 20_000 })
  now += 5_000
  await assert.rejects(api.listIssues(query), { message: 'rate limited', retryAfterMs: 15_000 })
  assert.equal(requests, 1)
  now += 15_000
  assert.deepEqual(await api.listIssues(query), connection([]))
})
