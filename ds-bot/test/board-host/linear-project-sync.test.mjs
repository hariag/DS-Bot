import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { openTaskStore } from '../../src/host/task-store.mjs'
import { openLinearProjectMonitor } from '../../src/host/linear-project-monitor.mjs'
import { createLinearProjectMcpApi } from '../../src/host/linear-project-mcp.mjs'
import { createLinearProjectSync, mapBoardTransitionToLinear } from '../../src/host/linear-project-sync.mjs'
import { install as installWatch } from '../../src/host/linear-project-watch.mjs'
import { install as installRequests } from '../../src/host/requests.js'

const PROJECT_ID = '1f64eebc-a397-436e-8fdf-518f574cb0bb'
const PROJECT_2 = 'a2743c77-056b-46e9-8d14-11f057eb897f'
const TEAM_ID = 'b9b845a8-4a68-44e0-9ff0-829fd05a74db'
const ROOM_ID = 'room-dev'
const MANAGER_ID = 'pm-bot'

const STATES = [
  { id: 'st-backlog', name: 'Backlog', type: 'backlog' },
  { id: 'st-todo', name: 'Todo', type: 'unstarted' },
  { id: 'st-prog', name: 'In Progress', type: 'started' },
  { id: 'st-rev', name: 'In Review', type: 'started' },
  { id: 'st-done', name: 'Done', type: 'completed' },
  { id: 'st-cancel', name: 'Canceled', type: 'canceled' },
]

function createFakeLinearMcpServer({ projectId = PROJECT_ID, includeComments = true } = {}) {
  let clock = Date.parse('2026-11-27T01:00:00Z')
  const stateByName = new Map(STATES.map(s => [s.name.toLowerCase(), s]))
  const issues = new Map()
  const writeCalls = []
  const comments = []

  const addIssue = ({ uuid, id, stateName = 'Todo', title = 'Feature spec', description = 'v1', labels = ['spec'] }) => {
    const st = stateByName.get(stateName.toLowerCase())
    const startedAt = new Date(clock).toISOString()
    issues.set(uuid, {
      uuid,
      id,
      projectId,
      teamId: TEAM_ID,
      url: `https://linear.app/test/issue/${id}`,
      status: st.name,
      statusType: st.type,
      updatedAt: startedAt,
      archivedAt: null,
      title,
      description,
      priority: 2,
      labels,
      stateHistory: [{ state: st, startedAt, endedAt: null }],
    })
  }

  const call = async (name, args) => {
    if (name === 'list_issue_statuses') return STATES
    if (name === 'list_issues') {
      const list = [...issues.values()].filter(issue => {
        if (issue.projectId !== args.project) return false
        if (args.updatedAt && issue.updatedAt < args.updatedAt) return false
        return true
      })
      return { issues: list, hasNextPage: false }
    }
    if (name === 'get_issue') {
      const issue = issues.get(args.id) ?? [...issues.values()].find(row => row.id === args.id)
      if (!issue) throw new Error('issue not found')
      return structuredClone(issue)
    }
    throw new Error(`unexpected read tool ${name}`)
  }

  const callWrite = async (name, args) => {
    writeCalls.push([name, structuredClone(args)])
    if (name === 'save_issue') {
      const issue = issues.get(args.id)
      const nextState = stateByName.get(String(args.state).toLowerCase())
      if (!issue || !nextState) throw new Error('invalid state transition')
      clock += 1000
      const nowIso = new Date(clock).toISOString()
      const last = issue.stateHistory.at(-1)
      if (last) last.endedAt = nowIso
      issue.stateHistory.push({ state: nextState, startedAt: nowIso, endedAt: null })
      issue.status = nextState.name
      issue.statusType = nextState.type
      issue.updatedAt = nowIso
      return { success: true, uuid: issue.uuid }
    }
    if (name === 'create_comment' || name === 'save_comment') {
      comments.push(args)
      return { success: true }
    }
    throw new Error(`unexpected write tool ${name}`)
  }

  const api = createLinearProjectMcpApi({
    projectId,
    call,
    callWrite,
    hasWriteTool: name => includeComments && name === 'create_comment',
    watchContentChanges: true,
    now: () => clock,
  })

  return {
    api,
    issues,
    writeCalls,
    comments,
    addIssue,
    advanceClock(ms = 1000) { clock += ms; return clock },
    now: () => clock,
    setIssueContent(uuid, patch) {
      clock += 1000
      const issue = issues.get(uuid)
      Object.assign(issue, patch, { updatedAt: new Date(clock).toISOString() })
    },
    setIssueState(uuid, stateName) {
      const issue = issues.get(uuid)
      const next = stateByName.get(stateName.toLowerCase())
      clock += 1000
      const nowIso = new Date(clock).toISOString()
      const last = issue.stateHistory.at(-1)
      if (last) last.endedAt = nowIso
      issue.stateHistory.push({ state: next, startedAt: nowIso, endedAt: null })
      issue.status = next.name
      issue.statusType = next.type
      issue.updatedAt = nowIso
    },
  }
}

test('full bidirectional lifecycle enforces dual acceptance gates, supports rework, and suppresses outbound echoes without hiding user edits', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'linear-bidir-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const remote = createFakeLinearMcpServer()
  const issueUuid = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaa1'
  remote.addIssue({ uuid: issueUuid, id: 'HAR-10', stateName: 'Backlog', description: 'Initial spec' })

  const monitor = openLinearProjectMonitor({
    path: join(dir, 'monitor.sqlite'),
    projectId: PROJECT_ID,
    linear: remote.api,
    now: remote.now,
    intakeStateIds: ['st-todo'],
  })
  t.after(() => monitor.close())

  // 1. Baseline poll captures Backlog
  assert.equal((await monitor.poll()).baseline, true)
  remote.advanceClock(5000)
  remote.setIssueState(issueUuid, 'Todo')
  remote.advanceClock(2000)
  const inbound = await monitor.poll()
  assert.equal(inbound.queued, 1)
  assert.equal(monitor.pending().at(-1).toStateId, 'st-todo')

  // 2. Wire openTaskStore.onTaskCommit -> sync engine
  let sync
  const store = openTaskStore(join(dir, 'tasks.sqlite'), {
    assertWriteLock: () => {},
    authorize: () => true,
    verifyEvidence: () => true,
    onTaskCommit: events => sync.handleBoardCommit(events),
  })
  t.after(() => store.close())

  sync = createLinearProjectSync({
    store: monitor,
    linear: remote.api,
    boardRoomId: ROOM_ID,
    getBoardTask: id => store.get(id),
    postComments: true,
    now: remote.now,
  })

  // Create top-level card mentioning HAR-10 -> auto-binds to Linear issue
  store.create({
    operationId: 'op-create-1',
    actor: MANAGER_ID,
    intake: {},
    task: {
      id: 'T-FEAT-0010',
      title: 'HAR-10 Bidirectional Feature',
      owner: 'dev-bot',
      reviewer: 'arch-bot',
      acceptor: 'cust-bot',
      scope: `room:${ROOM_ID}`,
      acceptance: 'Tests green and customer verified',
      description: 'Child tasks stay internal to DS-Bot',
      type: 'feature',
    },
  })
  assert.equal(monitor.bindingByTask('T-FEAT-0010')?.issueId, issueUuid)

  // Child task commits must NOT pollute Linear or bind independently
  store.create({
    operationId: 'op-child-1',
    actor: MANAGER_ID,
    intake: { parentTaskId: 'T-FEAT-0010' },
    task: {
      id: 'T-SUB-FEAT-0011',
      title: 'Implement HAR-10 handler',
      owner: 'dev-bot',
      reviewer: 'arch-bot',
      scope: `room:${ROOM_ID}`,
      acceptance: 'Unit tests pass',
      type: 'development',
    },
  })
  await sync.drain()
  assert.equal(remote.writeCalls.length, 0)

  // 3. Owner starts -> Linear updates to In Progress immediately
  let card = store.get('T-FEAT-0010')
  card = store.command({
    operationId: 'op-start-1',
    taskId: card.id,
    expectedRevision: card.revision,
    actor: 'dev-bot',
    type: 'start',
  })
  await sync.drain()
  assert.equal(remote.issues.get(issueUuid).status, 'In Progress')
  assert.equal(remote.comments.length, 1)

  // Next inbound poll MUST suppress our own outbound echo (0 new events!)
  remote.advanceClock(4000)
  const echoPoll = await monitor.poll()
  assert.equal(echoPoll.queued, 0)
  assert.equal(echoPoll.suppressedEchoes, 1)
  assert.equal(monitor.stats().suppressedEchoCount, 1)

  // Complete internal child item first; Linear stays at In Progress with 0 extra writes
  const writesBeforeChild = remote.writeCalls.length
  let child = store.get('T-SUB-FEAT-0011')
  child = store.command({ operationId: 'op-sub-start', taskId: child.id, expectedRevision: child.revision, actor: 'dev-bot', type: 'start' })
  child = store.command({
    operationId: 'op-sub-report',
    taskId: child.id,
    expectedRevision: child.revision,
    actor: 'dev-bot',
    type: 'report',
    value: { kind: 'personal', environment: 'isolated test', evidence: 'Child implemented' },
  })
  store.command({
    operationId: 'op-sub-review',
    taskId: child.id,
    expectedRevision: child.revision,
    actor: 'arch-bot',
    type: 'review',
    value: { result: 'pass', evidence: 'Child verified' },
  })
  await sync.drain()
  assert.equal(remote.writeCalls.length, writesBeforeChild)
  assert.equal(remote.issues.get(issueUuid).status, 'In Progress')

  // 4. Owner reports parent -> Linear updates to In Review
  card = store.command({
    operationId: 'op-report-1',
    taskId: card.id,
    expectedRevision: card.revision,
    actor: 'dev-bot',
    type: 'report',
    value: { kind: 'personal', environment: 'isolated test', evidence: 'Implemented & unit tested' },
  })
  await sync.drain()
  assert.equal(remote.issues.get(issueUuid).status, 'In Review')
  remote.advanceClock(3000)
  assert.equal((await monitor.poll()).queued, 0)

  // 5. Architect sends rework -> Linear transitions back to In Progress cleanly
  card = store.command({
    operationId: 'op-rework-1',
    taskId: card.id,
    expectedRevision: card.revision,
    actor: 'arch-bot',
    type: 'review',
    value: { result: 'rework', evidence: 'Missing edge case check' },
  })
  await sync.drain()
  assert.equal(remote.issues.get(issueUuid).status, 'In Progress')
  remote.advanceClock(3000)
  assert.equal((await monitor.poll()).queued, 0)

  // 6. Owner starts & reports second time -> dual-gate acceptance (tech -> business -> formal review)
  card = store.command({ operationId: 'op-start-2', taskId: card.id, expectedRevision: card.revision, actor: 'dev-bot', type: 'start' })
  card = store.command({
    operationId: 'op-report-2',
    taskId: card.id,
    expectedRevision: card.revision,
    actor: 'dev-bot',
    type: 'report',
    value: { kind: 'personal', environment: 'isolated test', evidence: 'Edge case fixed' },
  })
  await sync.drain()
  assert.equal(remote.issues.get(issueUuid).status, 'In Review')

  // Guard check: mapBoardTransitionToLinear refuses Done without both receipts
  assert.equal(
    mapBoardTransitionToLinear({ status: 'reported' }, { ...card, status: 'done', review: { result: 'pass', evidence: 'ok' } }).skippedReason,
    'waiting-independent-acceptance',
  )

  card = store.command({
    operationId: 'op-tech-pass',
    taskId: card.id,
    expectedRevision: card.revision,
    actor: 'arch-bot',
    type: 'card-comment',
    value: { text: 'TECH_REVIEW PASS report_operation_id=op-report-2' },
  })
  card = store.command({
    operationId: 'op-biz-pass',
    taskId: card.id,
    expectedRevision: card.revision,
    actor: 'cust-bot',
    type: 'card-comment',
    value: { text: 'BUSINESS_ACCEPTANCE PASS report_operation_id=op-report-2' },
  })
  card = store.command({
    operationId: 'op-final-pass',
    taskId: card.id,
    expectedRevision: card.revision,
    actor: 'arch-bot',
    type: 'review',
    value: { result: 'pass', evidence: 'Verified\nreport_operation_id=op-report-2' },
  })
  await sync.drain()
  assert.equal(remote.issues.get(issueUuid).status, 'Done')
  remote.advanceClock(3000)
  const doneEchoPoll = await monitor.poll()
  assert.equal(doneEchoPoll.queued, 0)

  // 7. Subsequent human change in Linear (Done -> Todo reopen) MUST NOT be suppressed!
  remote.advanceClock(3000)
  remote.setIssueState(issueUuid, 'Todo')
  remote.advanceClock(2000)
  const reopenPoll = await monitor.poll()
  assert.equal(reopenPoll.queued, 1)
  assert.equal(monitor.pending().at(-1).toStateId, 'st-todo')

  // 8. Requirement/design content change on Linear triggers content_changed without leaking body
  remote.advanceClock(3000)
  remote.setIssueContent(issueUuid, { description: 'Updated spec with SECRET_INJECTION_TEXT' })
  remote.advanceClock(2000)
  const contentPoll = await monitor.poll()
  assert.equal(contentPoll.queued, 1)
  const contentEvent = monitor.pending().at(-1)
  assert.equal(contentEvent.kind, 'content_changed')
  assert.deepEqual(contentEvent.changedFields, ['description'])
  assert.equal(JSON.stringify(contentEvent).includes('SECRET_INJECTION_TEXT'), false)
})

test('outbound sync degrades gracefully without comment tools, syncs block/cancel, and recovers pending jobs across restart', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'linear-recover-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const remote = createFakeLinearMcpServer({ includeComments: false })
  const issueUuid = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbb2'
  remote.addIssue({ uuid: issueUuid, id: 'HAR-11', stateName: 'Todo' })

  let monitor = openLinearProjectMonitor({
    path: join(dir, 'monitor.sqlite'),
    projectId: PROJECT_ID,
    linear: remote.api,
    now: remote.now,
  })
  await monitor.poll()

  const store = openTaskStore(join(dir, 'tasks.sqlite'), {
    assertWriteLock: () => {},
    authorize: () => true,
    verifyEvidence: () => true,
  })
  t.after(() => store.close())

  store.create({
    operationId: 'op-c',
    actor: MANAGER_ID,
    intake: {},
    task: {
      id: 'T-BUG-0011',
      title: 'HAR-11 Bugfix',
      owner: 'dev-bot',
      reviewer: 'arch-bot',
      scope: `room:${ROOM_ID}`,
      acceptance: 'Fixed',
      type: 'bugfix',
    },
  })
  monitor.bindIssue({ issueId: issueUuid, identifier: 'HAR-11', taskId: 'T-BUG-0011', roomId: ROOM_ID })

  // Simulate crash after enqueue before drain completes (network fails once)
  let failOnce = true
  const flakyLinear = {
    ...remote.api,
    async getIssueSnapshot(args) {
      if (failOnce) { failOnce = false; throw new Error('temporary network glitch') }
      return remote.api.getIssueSnapshot(args)
    },
  }
  const sync1 = createLinearProjectSync({
    store: monitor,
    linear: flakyLinear,
    boardRoomId: ROOM_ID,
    getBoardTask: id => store.get(id),
    now: remote.now,
  })
  const before = store.get('T-BUG-0011')
  const working = store.command({ operationId: 'op-w', taskId: 'T-BUG-0011', expectedRevision: before.revision, actor: 'dev-bot', type: 'start' })
  sync1.handleBoardCommit([{ before, after: working, operationId: 'op-w', actor: 'dev-bot' }])
  await sync1.drain()
  assert.equal(monitor.stats().outbound.pending, 1)
  assert.equal(remote.issues.get(issueUuid).status, 'Todo')

  // Simulate host restart by closing and reopening monitor & fast-forwarding clock past retry backoff
  await monitor.close()
  remote.advanceClock(10_000)
  monitor = openLinearProjectMonitor({
    path: join(dir, 'monitor.sqlite'),
    projectId: PROJECT_ID,
    linear: remote.api,
    now: remote.now,
  })
  t.after(() => monitor.close())
  const sync2 = createLinearProjectSync({
    store: monitor,
    linear: remote.api,
    boardRoomId: ROOM_ID,
    getBoardTask: id => store.get(id),
    now: remote.now,
  })
  await sync2.drain()
  assert.equal(remote.issues.get(issueUuid).status, 'In Progress')
  assert.equal(monitor.stats().outbound.verified, 1)
  assert.equal(monitor.stats().outbound.pending, 0)
  assert.equal(remote.comments.length, 0)

  // Cancel syncs to Canceled
  const prev = store.get('T-BUG-0011')
  const cancelled = store.command({ operationId: 'op-cancel', taskId: prev.id, expectedRevision: prev.revision, actor: 'user', type: 'cancel', value: { reason: 'superseded' } })
  sync2.handleBoardCommit([{ before: prev, after: cancelled, operationId: 'op-cancel', actor: 'user' }])
  await sync2.drain()
  assert.equal(remote.issues.get(issueUuid).status, 'Canceled')
})

test('multi-project watcher config, Chinese role handoff, manual bind tool and extended status endpoint', async t => {
  const home = mkdtempSync(join(tmpdir(), 'linear-multi-watch-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.parse('2026-11-27T02:00:00Z') })

  t.mock.method(globalThis, 'fetch', async () => Response.json({
    data: { project: { id: PROJECT_ID, issues: { nodes: [{ id: 'i1', identifier: 'HAR-20', url: 'https://linear.app/t/issue/HAR-20', updatedAt: '2026-11-27T01:59:00Z', state: { id: 'st-todo', name: 'Todo' } }], pageInfo: { hasNextPage: false, endCursor: null } } } },
  }))

  let cleanup
  const messages = []
  const rt = {
    home,
    state: {
      bots: { [MANAGER_ID]: { id: MANAGER_ID, instructions: '## 团队章程 v1.2\n全员遵守规则。' } },
      rooms: { [ROOM_ID]: { id: ROOM_ID, members: [MANAGER_ID] } },
    },
    config: {
      linearProjectWatch: [
        { projectId: PROJECT_ID, managerId: MANAGER_ID, boardRoomId: ROOM_ID, readSecret: 'LINEAR_1', outboundSync: false },
        { projectId: PROJECT_2, managerId: MANAGER_ID, boardRoomId: ROOM_ID, readSecret: 'LINEAR_2', outboundSync: false },
      ],
    },
    teamTools: [],
    chatOwners: new Map([['pm-chat', MANAGER_ID]]),
    groupOwners: new Map(),
    own: (record, key) => Object.hasOwn(record, key) ? record[key] : undefined,
    botOf: id => rt.state.bots[id],
    roomOf: id => rt.state.rooms[id],
    chatOf: () => 'pm-chat',
    getBoardTask: id => id === 'T-HAR-0020' ? { id, scope: `room:${ROOM_ID}`, status: 'working', revision: 2 } : undefined,
    load: async () => {},
    save: async () => {},
    loadSecrets: async () => {},
    requireHomeLock() {},
    readOnly: () => undefined,
    canUseSecret: () => true,
    secretValue: () => 'token',
    ctx: { effect: start => { cleanup = start() } },
    warn() {},
    async deliver(args, observer) {
      const agent = { id: args.sessionId }
      observer.beforeAdmission(agent)
      messages.push(args)
      observer.afterAdmission(agent, { id: `m-${messages.length}` })
      return args.exchangeId
    },
  }
  installRequests(rt)
  installWatch(rt)

  const tool = rt.teamTools.find(entry => entry.name === 'linear_project_changes')
  try {
    t.mock.timers.tick(0)
    for (let i = 0; i < 40 && !rt.linearProjectWatchStatus().projects[0].lastPoll; i++) {
      await new Promise(resolve => setImmediate(resolve))
    }
    const status = rt.linearProjectWatchStatus()
    assert.equal(status.enabled, true)
    assert.equal(status.projects.length, 2)
    assert.equal(status.bindingsCount, 0)

    const bindRes = JSON.parse(await tool.execute({ action: 'bind', project_id: PROJECT_ID, task_id: 'T-HAR-0020', issue_id: 'HAR-20' }, { agent: { id: 'pm-chat' } }))
    assert.equal(bindRes.bound.identifier, 'HAR-20')
    assert.equal(bindRes.bound.taskId, 'T-HAR-0020')
    const listBindings = JSON.parse(await tool.execute({ action: 'bindings', project_id: PROJECT_ID }, { agent: { id: 'pm-chat' } }))
    assert.equal(listBindings.bindings.length, 1)
  } finally {
    await cleanup()
  }
})
