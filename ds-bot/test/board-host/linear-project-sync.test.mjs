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
  const readCalls = []
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
    readCalls.push([name, structuredClone(args)])
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
    readCalls,
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

test('board journal starts at cutover, preserves offline commits, and never replays an older state over a newer one', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'linear-journal-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const remote = createFakeLinearMcpServer()
  const issueId = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbb3'
  remote.addIssue({ uuid: issueId, id: 'HAR-12' })
  remote.advanceClock()
  const path = join(dir, 'monitor.sqlite')
  const watch = () => openLinearProjectMonitor({ path, projectId: PROJECT_ID, linear: remote.api, now: remote.now })
  let monitor = watch()
  t.after(() => monitor.close())
  await monitor.poll()
  const board = openTaskStore(join(dir, 'tasks.sqlite'), {
    assertWriteLock() {},
    authorize: () => true,
    verifyEvidence: () => true,
  })
  t.after(() => board.close())
  const card = board.create({ operationId: 'journal-register', actor: MANAGER_ID, intake: {},
    task: { id: 'T-HAR-0012', scope: `room:${ROOM_ID}`, type: 'feature', title: 'HAR-12',
      owner: 'dev', reviewer: 'reviewer', acceptance: 'Verify original change' } })
  const command = (id, operationId, type, value, actor = 'dev') => board.command({
    operationId, taskId: id, expectedRevision: board.get(id).revision, actor, type, value,
  })
  command(card.id, 'before-cutover', 'start')
  monitor.bindIssue({ taskId: card.id, issueId, identifier: 'HAR-12', roomId: ROOM_ID })
  let connected = false
  let failRead = true
  const sync = () => createLinearProjectSync({
    store: monitor, boardRoomId: ROOM_ID, getBoardTask: id => board.get(id), now: remote.now,
    readBoardChanges: (room, cursor) => board.roomTaskChanges(room, cursor),
    assertActive() { if (!connected) throw new Error('MCP offline') },
    linear: { ...remote.api, getIssueSnapshot(args) {
      if (failRead) { failRead = false; throw new Error('temporary MCP read failure') }
      return remote.api.getIssueSnapshot(args)
    } },
  })
  let worker = sync()
  assert.equal(worker.replayBoardChanges(), true)
  const baseline = monitor.boardCheckpoint(ROOM_ID)
  assert.ok(baseline.baselineSequence > 0)
  assert.deepEqual(monitor.listOutbound(), [])

  command(card.id, 'offline-report', 'report', { kind: 'personal', environment: 'test', evidence: 'Implementation' })
  const unrelated = board.create({ operationId: 'unrelated-register', actor: MANAGER_ID, intake: {},
    task: { id: 'T-OTHER-0012', scope: 'room:other', type: 'feature', title: 'HAR-12',
      owner: 'dev', reviewer: 'reviewer', acceptance: 'Different room' } })
  command(unrelated.id, 'other-start', 'start')
  assert.equal(worker.replayBoardChanges(), true)
  assert.equal(monitor.listOutbound().length, 1)
  const originalJob = monitor.listOutbound()[0]
  assert.match(originalJob.operation_id, /^outbound:offline-report:/)
  assert.equal(originalJob.to_status, 'reported')
  assert.ok(monitor.boardCheckpoint(ROOM_ID).sequence > baseline.sequence)
  await worker.drain()
  assert.equal(remote.writeCalls.length, 0)
  connected = true
  await worker.drain()
  assert.equal(monitor.getOutbound(originalJob.operation_id).status, 'retry')

  await monitor.close()
  command(card.id, 'down-cancel', 'cancel', { reason: 'Scope halted' }, 'user')
  monitor = watch()
  worker = sync()
  assert.equal(worker.replayBoardChanges(), true)
  assert.equal(monitor.boardCheckpoint(ROOM_ID).baselineSequence, baseline.baselineSequence)
  await worker.drain()
  assert.equal(remote.issues.get(issueId).status, 'Canceled')
  assert.match(monitor.listOutbound()[0].operation_id, /^outbound:down-cancel:/)
  remote.advanceClock(10_000)
  assert.equal(worker.replayBoardChanges(), true)
  await worker.drain()
  assert.deepEqual(remote.writeCalls.filter(([tool]) => tool === 'save_issue').map(([, { state }]) => state), ['Canceled'])
  assert.equal(monitor.listOutbound().length, 2)
  assert.equal(monitor.getOutbound(originalJob.operation_id).status, 'superseded')
})

test('remote changes are preserved on a queued conflict and a matching no-op does not swallow a user event', async t => {
  const remote = createFakeLinearMcpServer()
  const issueId = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbb4'
  remote.addIssue({ uuid: issueId, id: 'HAR-13' })
  remote.advanceClock()
  const monitor = openLinearProjectMonitor({ path: ':memory:', projectId: PROJECT_ID, linear: remote.api, now: remote.now })
  t.after(() => monitor.close())
  await monitor.poll()
  let card = { id: 'T-HAR-0013', revision: 2, status: 'working', scope: `room:${ROOM_ID}`, type: 'feature' }
  monitor.bindIssue({ taskId: card.id, issueId, identifier: 'HAR-13', roomId: ROOM_ID })
  const worker = createLinearProjectSync({ store: monitor, linear: remote.api, boardRoomId: ROOM_ID,
    getBoardTask: () => card, postComments: false, now: remote.now })
  remote.setIssueState(issueId, 'In Progress')
  worker.handleBoardCommit([{ before: { status: 'proposed' }, after: card, operationId: 'observed-start' }])
  await worker.drain()
  assert.deepEqual(remote.writeCalls, [])
  remote.advanceClock()
  assert.equal((await monitor.poll()).queued, 1)
  assert.equal(monitor.pending().at(-1).toStateId, 'st-prog')
  assert.equal(monitor.stats().suppressedEchoCount, 0)

  const before = card
  card = { ...card, status: 'reported', revision: 3 }
  worker.handleBoardCommit([{ before, after: card, operationId: 'conflicted-report' }])
  remote.setIssueState(issueId, 'Backlog')
  await worker.drain()
  assert.deepEqual(remote.writeCalls, [])
  assert.equal(remote.issues.get(issueId).status, 'Backlog')
  assert.match(monitor.listOutbound()[0].last_error, /changed independently/)
  assert.equal(monitor.stats().outbound.conflict, 1)
})

test('MCP builds and upgrades the content baseline without historical replay and preserves distinct repeated edits after a short outage', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'linear-content-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const remote = createFakeLinearMcpServer()
  const issueId = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbb5'
  remote.addIssue({ uuid: issueId, id: 'HAR-14', description: 'scope A' })
  remote.advanceClock()
  const options = { projectId: PROJECT_ID, now: remote.now, linear: remote.api }
  const fresh = openLinearProjectMonitor({ ...options, path: ':memory:' })
  t.after(() => fresh.close())
  assert.equal((await fresh.poll()).queued, 0)
  assert.equal(remote.readCalls.filter(([name]) => name === 'get_issue').length, 0)

  const path = join(dir, 'monitor.sqlite')
  const legacy = openLinearProjectMonitor({ ...options, path, linear: {
    async listIssues(args) {
      const page = await remote.api.listIssues(args)
      return { ...page, nodes: page.nodes.map(({ contentMeta: _legacyDidNotCaptureContent, ...issue }) => issue) }
    },
    listHistory() { assert.fail('The legacy baseline has no content and does not replay issue history') },
  } })
  await legacy.poll()
  await legacy.close()
  remote.advanceClock(30_000)
  let missingListField = true
  let unavailable = false
  const upgraded = openLinearProjectMonitor({ ...options, path, linear: {
    ...remote.api,
    async listIssues(args) {
      if (unavailable) throw new Error('Temporary MCP outage')
      const page = await remote.api.listIssues(args)
      if (!missingListField) return page
      return { ...page, nodes: page.nodes.map(({ contentMeta: _partialProjection, ...issue }) => issue) }
    },
  } })
  t.after(() => upgraded.close())
  assert.deepEqual({ ...(await upgraded.poll()), checkpoint: null }, { baseline: false, scanned: 1, queued: 0, checkpoint: null })
  const fallback = remote.readCalls.filter(([name]) => name === 'get_issue')
  assert.equal(fallback.length, 1)
  assert.ok(fallback[0][1].fields.includes('description'))
  missingListField = false

  unavailable = true
  remote.setIssueContent(issueId, { description: 'scope B' })
  remote.advanceClock()
  await assert.rejects(upgraded.poll(), /Temporary MCP outage/)
  unavailable = false
  assert.equal((await upgraded.poll()).queued, 1)
  assert.equal((await fresh.poll()).queued, 1)

  for (const description of ['scope A', 'scope B']) {
    remote.setIssueContent(issueId, { description })
    remote.advanceClock()
    assert.equal((await upgraded.poll()).queued, 1)
    remote.advanceClock()
    assert.equal((await upgraded.poll()).queued, 0)
  }
  const changes = upgraded.pending()
  assert.equal(changes.length, 3)
  assert.ok(changes.every(event => event.kind === 'content_changed' && event.changedFields.join() === 'description'))
  assert.deepEqual(changes[0].contentHash, changes[2].contentHash)
  assert.notEqual(changes[0].id, changes[2].id)
  assert.doesNotMatch(JSON.stringify(changes), /scope [AB]/)
  assert.deepEqual(remote.writeCalls, [])
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
