import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { openLinearProjectMonitor } from '../../src/host/linear-project-monitor.mjs'

const start = Date.parse('2026-11-26T10:00:00Z')
const time = offset => new Date(start + offset).toISOString()
const issue = (id, stateId, offset) => ({ id, identifier:`TEST-${id}`, url:`https://linear.app/test/issue/TEST-${id}`,
  state:{ id:stateId, name:stateId }, updatedAt:time(offset) })
const change = (id, fromStateId, toStateId, offset, actorId = 'member') => ({ id, fromStateId, toStateId, actorId, updatedAt:time(offset) })
const page = (nodes, endCursor = null) => ({ nodes, pageInfo:{ endCursor, hasNextPage:endCursor !== null } })

function fixture(t, options) {
  const dir = mkdtempSync(join(tmpdir(), 'linear-monitor-test-'))
  const path = join(dir, 'monitor.sqlite')
  let offset = 0
  const reads = []
  const linear = { listIssues: async () => page([]), listHistory:async () => page([]) }
  const monitors = []
  const open = overrides => {
    const monitor = openLinearProjectMonitor({ path, projectId:'test-project', now:() => start + offset, ...options, ...overrides,
      linear:{ listIssues:async args => { reads.push(args); return linear.listIssues(args) }, listHistory:args => linear.listHistory(args) } })
    monitors.push(monitor)
    return monitor
  }
  const monitor = open()
  t.after(async () => {
    for (const current of monitors) await current.close()
    rmSync(dir, { recursive:true, force:true })
  })
  return { open, monitor, path, reads, linear, setTime(value) { offset = value } }
}

test('baseline spans the entire project and later status changes on multiple issues become pending', async t => {
  const h = fixture(t)
  h.linear.listIssues = async ({ after }) => after ? page([issue('B', 'Todo', -2_000)]) : page([issue('A', 'Todo', -1_000)], 'next')
  h.linear.listHistory = async () => { throw new Error('baseline does not backfill past changes') }
  assert.deepEqual(await h.monitor.poll(), { baseline:true, scanned:2, queued:0, checkpoint:time(0) })
  assert.equal(h.reads.length, 2)
  assert.ok(h.reads.every(call => call.projectId === 'test-project' && call.from === null && call.until === time(0)))

  h.setTime(5_000)
  h.linear.listIssues = async ({ after }) => after ? page([issue('B', 'In Review', 2_000), issue('C', 'Backlog', 2_500)])
    : page([issue('A', 'In Progress', 1_000)], 'next')
  h.linear.listHistory = async ({ issueId }) => ({ A:page([change('a', 'Todo', 'In Progress', 950)]),
    B:page([change('b', 'Todo', 'In Review', 1_950, null)]), C:page([]) })[issueId]
  assert.deepEqual(await h.monitor.poll(), { baseline:false, scanned:3, queued:3, checkpoint:time(5_000) })
  assert.deepEqual(h.monitor.pending().map(event => [event.issueId, event.fromStateId, event.toStateId, event.actorId]), [
    ['A', 'Todo', 'In Progress', 'member'], ['B', 'Todo', 'In Review', null], ['C', null, 'Backlog', null],
  ])
})

test('intake hands off only non-archived issues in configured states on the initial baseline', async t => {
  const h = fixture(t, { intakeStateIds:['Todo'] })
  let archiveStateAvailable = false
  h.linear.listIssues = async () => page([
    { ...issue('A', 'Todo', -2_000), archivedAt:null },
    { ...issue('B', 'Todo', -1_500), archivedAt:time(-300) },
    { ...issue('C', 'Done', -1_000), archivedAt:null },
    { ...issue('D', 'Todo', -500), ...(archiveStateAvailable ? { archivedAt:time(-200) } : {}) },
  ])
  h.linear.listHistory = async () => { throw new Error('intake is not historical replay') }
  await assert.rejects(h.monitor.poll(), /archive state unavailable/)
  assert.equal(h.monitor.pending().length, 0)
  archiveStateAvailable = true
  assert.deepEqual(await h.monitor.poll(), { baseline:true, scanned:4, queued:1, checkpoint:time(0),
    intakeReconciled:true, intakeQueued:1 })
  const [event] = h.monitor.pending()
  assert.deepEqual([event.kind, event.issueId, event.fromStateId, event.toStateId,
    event.at, event.sourceUpdatedAt], ['intake', 'A', null, 'Todo', time(0), time(-2_000)])
})

test('upgrade reconciles existing Todo once without replay, even when no source data changed', async t => {
  const h = fixture(t)
  const current = { ...issue('A', 'Todo', -3_600_000), archivedAt:null }
  h.linear.listIssues = async () => page([current])
  assert.equal((await h.monitor.poll()).queued, 0)
  h.setTime(20_000)
  assert.equal((await h.monitor.poll()).queued, 0)
  await h.monitor.close()
  const oldDb = new DatabaseSync(h.path)
  // Recreate the deployed schema before intake reconciliation was added.
  oldDb.exec('DROP TABLE monitor_intake_reconciliation')
  oldDb.close()

  h.setTime(25_000)
  let incomplete = true
  h.linear.listIssues = async ({ from, after }) => {
    if (from) return page([])
    if (after && incomplete) throw new Error('Incomplete reconciliation page')
    return after ? page([]) : page([current], 'next')
  }
  h.linear.listHistory = async () => { throw new Error('does not seek old timeline') }
  const upgraded = h.open({ intakeStateIds:['Todo'] })
  await assert.rejects(upgraded.poll(), /Incomplete reconciliation page/)
  assert.equal(upgraded.pending().length, 0)
  incomplete = false
  assert.deepEqual(await upgraded.poll(), { baseline:false, scanned:1, queued:1, checkpoint:time(25_000),
    intakeReconciled:true, intakeQueued:1 })
  const [event] = upgraded.pending()
  assert.equal(event.sourceUpdatedAt, current.updatedAt)
  assert.equal(event.kind, 'intake')
  const db = new DatabaseSync(h.path, { readOnly:true })
  assert.equal(db.prepare('SELECT started_ms FROM monitor_checkpoint WHERE id = 1').get().started_ms, start)
  db.close()

  await upgraded.close()
  h.setTime(30_000)
  const restarted = h.open({ intakeStateIds:['Todo'] })
  assert.deepEqual(await restarted.poll(), { baseline:false, scanned:0, queued:0, checkpoint:time(30_000) })
  assert.equal(h.reads.at(-1).from, time(10_000))
  assert.equal(restarted.pending()[0].id, event.id)
})

test('an intake reconciliation only reads incremental history and does not duplicate a matching transition', async t => {
  const h = fixture(t)
  h.linear.listIssues = async () => page([issue('B', 'Backlog', -3_600_000)])
  await h.monitor.poll()
  h.setTime(25_000)
  await h.monitor.poll()
  await h.monitor.close()
  h.setTime(30_000)
  h.linear.listIssues = async () => page([
    { ...issue('A', 'Todo', -3_600_000), archivedAt:null },
    { ...issue('B', 'Todo', 27_000), archivedAt:null },
  ])
  h.linear.listHistory = async ({ issueId, from }) => {
    assert.equal(issueId, 'B')
    assert.equal(from, time(10_000))
    return page([change('ready', 'Backlog', 'Todo', 26_950)])
  }
  const upgraded = h.open({ intakeStateIds:['Todo'] })
  assert.deepEqual(await upgraded.poll(), { baseline:false, scanned:2, queued:2, checkpoint:time(30_000),
    intakeReconciled:true, intakeQueued:1 })
  assert.deepEqual(upgraded.pending().map(event => [event.issueId, event.kind]), [['B', 'history'], ['A', 'intake']])
})

test('overlap captures round trips, revised history and delayed entries without replaying baseline history', async t => {
  const h = fixture(t)
  h.linear.listIssues = async () => page([issue('A', 'Todo', -1_000)])
  await h.monitor.poll()

  h.setTime(5_000)
  h.linear.listIssues = async () => page([issue('A', 'Todo', 4_000)])
  h.linear.listHistory = async ({ after }) => after ? page([change('forward', 'Todo', 'In Progress', 3_500),
    change('pre-existing', 'Backlog', 'Todo', -2_000)], 'unused') : page([change('back', 'In Progress', 'Todo', 4_000)], 'next')
  const completeHistory = h.linear.listHistory
  h.linear.listHistory = async args => {
    assert.notEqual(args.after, 'unused', 'does not inspect older pages outside the window')
    return completeHistory(args)
  }
  assert.equal((await h.monitor.poll()).queued, 2)
  h.setTime(10_000)
  assert.equal((await h.monitor.poll()).queued, 0)

  h.setTime(15_000)
  h.linear.listIssues = async () => page([issue('A', 'Done', 12_000)])
  h.linear.listHistory = async () => page([change('back', 'In Progress', 'Done', 12_000), change('forward', 'Todo', 'In Progress', 3_500)])
  await h.monitor.close()
  const monitor = h.open()
  assert.equal((await monitor.poll()).queued, 1)
  assert.deepEqual(monitor.pending().map(event => event.toStateId), ['In Progress', 'Todo', 'Done'])
})

test('a failed page does not advance the checkpoint, and concurrent calls share one poll', async t => {
  const h = fixture(t)
  h.linear.listIssues = async () => page([issue('A', 'Todo', -1_000)])
  await h.monitor.poll()

  h.setTime(20_000)
  h.linear.listIssues = async ({ after }) => {
    if (after) throw new Error('Upstream timed out')
    return page([issue('A', 'Done', 10_000)], 'next')
  }
  const first = h.monitor.poll()
  assert.equal(h.monitor.poll(), first)
  await assert.rejects(first, /Upstream timed out/)
  assert.equal(h.monitor.pending().length, 0)

  h.linear.listIssues = async () => page([issue('A', 'Done', 10_000)])
  h.setTime(25_000)
  assert.equal((await h.monitor.poll()).queued, 1)
  assert.equal(h.reads.at(-1).from, time(-15_000))
  assert.deepEqual(h.monitor.pending().map(event => [event.kind, event.actorId, event.fromStateId, event.toStateId]), [['observed', null, 'Todo', 'Done']])
})

test('notification bursts are batched, uncertain receipts survive reopen, and PM handling is a separate decision', async t => {
  const h = fixture(t)
  await h.monitor.poll()
  h.setTime(5_000)
  h.linear.listIssues = async () => page([issue('A', 'Done', 2_000), issue('B', 'Done', 3_000)])
  assert.equal((await h.monitor.poll()).queued, 2)
  const first = h.monitor.getBatch(1)
  assert.equal(h.monitor.pending().length, 2)
  await h.monitor.close()
  const monitor = h.open()
  assert.deepEqual(monitor.getBatch(10), first)
  assert.equal(monitor.recordDelivery(first.id, 'uncertain', { messageId:'dsn-message', reason:'Awaiting readback' }), true)
  assert.equal(monitor.getBatch(10, { minDeliveryGapMs:30_000 }), null)
  assert.equal(monitor.uncertainBatches()[0].receipt.messageId, 'dsn-message')

  h.setTime(35_000)
  const second = monitor.getBatch(10, { minDeliveryGapMs:30_000 })
  assert.notEqual(second.id, first.id)
  assert.equal(second.events[0].issueId, 'B')
  assert.equal(monitor.recordDelivery(second.id, 'delivered', { messageId:'dsn-message-2' }), true)
  assert.equal(monitor.pending().length, 2)
  await assert.rejects(async () => monitor.ack([first.events[0].id]), /requires/)
  assert.equal(monitor.ack([first.events[0].id], { actorId:'pm', note:'已核对原卡' }), 1)
  assert.equal(monitor.ack([first.events[0].id], { actorId:'pm', note:'重复提交' }), 0)
  assert.equal(monitor.pending().length, 1)
  const db = new DatabaseSync(h.path, { readOnly:true })
  assert.deepEqual({ ...db.prepare('SELECT handled_by, note FROM monitor_events WHERE id = ?').get(first.events[0].id) },
    { handled_by:'pm', note:'已核对原卡' })
  db.close()
})

test('permission invalidated while fetching cannot commit a scan or PM decision', async t => {
  let enabled = true
  const h = fixture(t, { assertActive() { if (!enabled) throw new Error('Project monitor inactive') } })
  await h.monitor.poll()
  h.setTime(5_000)
  h.linear.listIssues = async () => page([issue('A', 'In Review', 4_000)])
  h.linear.listHistory = async () => {
    enabled = false
    return page([change('review', 'Todo', 'In Review', 4_000)])
  }
  await assert.rejects(h.monitor.poll(), /inactive/)
  assert.equal(h.monitor.pending().length, 0)
  enabled = true
  h.linear.listHistory = async () => page([change('review', 'Todo', 'In Review', 4_000)])
  assert.equal((await h.monitor.poll()).queued, 1)
  const [event] = h.monitor.pending()
  enabled = false
  assert.throws(() => h.monitor.ack([event.id], { actorId:'pm', note:'approved' }), /inactive/)
  assert.equal(h.monitor.pending().length, 1)
})

test('a delivered batch stays the only notification in flight until PM handles all of it', async t => {
  const h = fixture(t)
  await h.monitor.poll()
  h.setTime(5_000)
  h.linear.listIssues = async () => page([issue('A', 'Done', 1_000), issue('B', 'Done', 2_000), issue('C', 'Done', 3_000)])
  assert.equal((await h.monitor.poll()).queued, 3)
  const first = h.monitor.getBatch(2)
  assert.equal(h.monitor.recordDelivery(first.id, 'delivered'), true)
  assert.equal(h.monitor.getBatch(), null)
  assert.equal(h.monitor.pending().length, 3)
  const decision = { actorId:'pm', note:'已按原卡登记处理' }
  h.monitor.ack([first.events[0].id], decision)
  assert.equal(h.monitor.getBatch(), null)
  await h.monitor.close()
  const monitor = h.open()
  assert.equal(monitor.getBatch(), null)
  monitor.ack([first.events[1].id], decision)
  assert.equal(monitor.getBatch().events[0].issueId, 'C')
})

test('an expired unresolved delivery allows a new batch without removing or resending the old one', async t => {
  const h = fixture(t)
  await h.monitor.poll()
  h.setTime(5_000)
  h.linear.listIssues = async () => page([issue('A', 'Done', 1_000), issue('B', 'Done', 2_000), issue('C', 'Done', 3_000)])
  assert.equal((await h.monitor.poll()).queued, 3)
  const first = h.monitor.getBatch(2)
  const receipt = { messageId:'first-message' }
  assert.equal(h.monitor.recordDelivery(first.id, 'delivered', receipt), true)
  const options = { minDeliveryGapMs:30_000, unresolvedDeliveryLeaseMs:60_000 }
  await h.monitor.close()
  const monitor = h.open()
  h.setTime(64_999)
  assert.equal(monitor.getBatch(2, options), null)
  h.setTime(65_000)
  const second = monitor.getBatch(2, options)
  assert.notEqual(second.id, first.id)
  assert.deepEqual(second.events.map(event => event.issueId), ['C'])
  assert.deepEqual(monitor.pending().map(event => event.issueId), ['A', 'B', 'C'])
  assert.equal(monitor.recordDelivery(second.id, 'delivered', { messageId:'second-message' }), true)
  const db = new DatabaseSync(h.path, { readOnly:true })
  const original = db.prepare('SELECT status, receipt FROM monitor_batches WHERE id = ?').get(first.id)
  assert.equal(original.status, 'delivered')
  assert.deepEqual(JSON.parse(original.receipt), receipt)
  db.close()
})

test('checkpoints retain their query bound and observations retain the actual collection time', async t => {
  const h = fixture(t)
  h.linear.listIssues = async () => page([issue('A', 'Todo', -1_000)])
  await h.monitor.poll()
  h.setTime(5_000)
  h.linear.listIssues = async () => page([issue('A', 'Done', 4_000)])
  h.linear.listHistory = async () => {
    h.setTime(6_700)
    return page([{ ...change('a', 'Todo', 'Done', 3_900), createdAt:time(3_500) }])
  }
  const result = await h.monitor.poll()
  const [event] = h.monitor.pending()
  assert.equal(result.checkpoint, time(5_000))
  assert.equal(event.observedAt, time(6_700))
  assert.equal(event.sourceCreatedAt, time(3_500))
  assert.equal(event.sourceUpdatedAt, time(3_900))
})

test('outbound echo suppression migrates existing monitor_issues schema and drops only matching outbound writes', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'linear-monitor-migrate-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const dbPath = join(dir, 'legacy.sqlite')
  const legacy = new DatabaseSync(dbPath)
  legacy.exec(`
    CREATE TABLE monitor_checkpoint (id INTEGER PRIMARY KEY CHECK(id = 1), project_id TEXT NOT NULL, started_ms INTEGER, until_ms INTEGER);
    CREATE TABLE monitor_issues (id TEXT PRIMARY KEY, state_id TEXT NOT NULL, updated_ms INTEGER NOT NULL);
    CREATE TABLE monitor_batches (seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, status TEXT NOT NULL, updated_at TEXT NOT NULL, receipt TEXT);
    CREATE TABLE monitor_events (seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, payload TEXT NOT NULL, batch_id TEXT, handled_at TEXT, handled_by TEXT, note TEXT);
    CREATE TABLE monitor_intake_reconciliation (state_id TEXT PRIMARY KEY, reconciled_at TEXT NOT NULL);
    INSERT INTO monitor_checkpoint VALUES (1, 'test-project', ${start}, ${start});
    INSERT INTO monitor_issues VALUES ('A', 'Todo', ${start - 1000});
  `)
  legacy.close()

  let nowOffset = 5000
  let issues = [issue('A', 'In Progress', 4_500)]
  let history = page([change('h1', 'Todo', 'In Progress', 4_200, null)])
  const monitor = openLinearProjectMonitor({
    path: dbPath,
    projectId: 'test-project',
    now: () => start + nowOffset,
    linear: { listIssues: async () => page(issues), listHistory: async () => history },
  })
  t.after(() => monitor.close())
  monitor.recordOutboundEcho({
    issueId: 'A',
    toStateId: 'In Progress',
    toStateName: 'In Progress',
    operationId: 'op-sync-1',
    attemptedMs: start + 4_000,
    verifiedMs: start + 4_500,
    stateStartedMs: start + 4_200,
  })
  const first = await monitor.poll()
  assert.equal(first.queued, 0)
  assert.equal(first.suppressedEchoes, 1)
  assert.equal(monitor.pending().length, 0)

  nowOffset = 10_000
  issues = [issue('A', 'In Review', 9_000)]
  history = page([change('h2', 'In Progress', 'In Review', 8_500, 'human-actor')])
  const second = await monitor.poll()
  assert.equal(second.queued, 1)
  assert.equal(monitor.pending().length, 1)
  assert.equal(monitor.pending()[0].toStateId, 'In Review')
})

test('incremental poll backfills missing identifier on pre-migration monitor_issues once without replaying history', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'linear-monitor-idbackfill-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const dbPath = join(dir, 'legacy.sqlite')
  const legacy = new DatabaseSync(dbPath)
  legacy.exec(`
    CREATE TABLE monitor_checkpoint (id INTEGER PRIMARY KEY CHECK(id = 1), project_id TEXT NOT NULL, started_ms INTEGER, until_ms INTEGER);
    CREATE TABLE monitor_issues (id TEXT PRIMARY KEY, state_id TEXT NOT NULL, updated_ms INTEGER NOT NULL);
    CREATE TABLE monitor_batches (seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, status TEXT NOT NULL, updated_at TEXT NOT NULL, receipt TEXT);
    CREATE TABLE monitor_events (seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, payload TEXT NOT NULL, batch_id TEXT, handled_at TEXT, handled_by TEXT, note TEXT);
    CREATE TABLE monitor_intake_reconciliation (state_id TEXT PRIMARY KEY, reconciled_at TEXT NOT NULL);
    INSERT INTO monitor_checkpoint VALUES (1, 'test-project', ${start}, ${start + 60_000});
    INSERT INTO monitor_issues VALUES ('issue-old', 'Todo', ${start - 1000});
    INSERT INTO monitor_issues VALUES ('issue-orphan', 'Done', ${start - 2000});
  `)
  legacy.close()

  let nowOffset = 70_000
  const reads = []
  let historyCalls = 0
  const monitor = openLinearProjectMonitor({
    path: dbPath,
    projectId: 'test-project',
    now: () => start + nowOffset,
    linear: {
      listIssues: async args => {
        reads.push(args)
        return page([{ id: 'issue-old', identifier: 'HAR-7', url: 'https://linear.app/test/issue/HAR-7', state: { id: 'Todo', name: 'Todo' }, updatedAt: time(-1000) }])
      },
      listHistory: async () => {
        historyCalls += 1
        return page([])
      },
    },
  })
  t.after(() => monitor.close())

  // First incremental poll sees NULL identifier -> widens listIssues once (from: null), backfills HAR-7,
  // emits no history replay or status events.
  const first = await monitor.poll()
  assert.equal(first.scanned, 1)
  assert.equal(first.queued, 0)
  assert.equal(reads.at(-1).from, null)
  assert.equal(historyCalls, 0)
  assert.equal(monitor.findKnownIssue('HAR-7')?.id, 'issue-old')

  // Next poll reverts to narrow window even though issue-orphan still has NULL identifier.
  // Default overlapMs is 15_000, so from = 70_000 - 15_000 = 55_000.
  nowOffset = 80_000
  await monitor.poll()
  assert.equal(reads.at(-1).from, time(55_000))
})
