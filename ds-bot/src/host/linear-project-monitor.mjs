import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

const nonempty = value => typeof value === 'string' && value.length > 0
const hash = parts => createHash('sha256').update(JSON.stringify(parts)).digest('hex')
const iso = milliseconds => new Date(milliseconds).toISOString()

function timestamp(value) {
  const time = nonempty(value) ? Date.parse(value) : NaN
  if (!Number.isFinite(time)) throw new Error('Invalid Linear timestamp')
  return time
}

async function pages(fetchPage, process) {
  const seen = new Set()
  let after = null
  for (;;) {
    const page = await fetchPage(after)
    if (!Array.isArray(page?.nodes) || typeof page.pageInfo?.hasNextPage !== 'boolean') throw new Error('Invalid Linear page')
    for (const node of page.nodes) if (process(node) === false) return
    if (!page.pageInfo.hasNextPage) return
    after = page.pageInfo.endCursor
    if (!nonempty(after) || seen.has(after)) throw new Error('Linear pagination did not advance')
    seen.add(after)
  }
}

function limit(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1000) throw new Error('Invalid monitor limit')
  return value
}

function historyEntry(row, time) {
  if (!nonempty(row?.id)) throw new Error('Invalid Linear history ID')
  const fromStateId = row.fromStateId ?? null
  const toStateId = row.toStateId ?? null
  if (fromStateId === toStateId) return null
  if ([fromStateId, toStateId, row.actorId ?? null].some(value => value !== null && !nonempty(value))) {
    throw new Error('Invalid Linear state history')
  }
  return { historyId:row.id, fromStateId, toStateId, actorId:row.actorId ?? null, time,
    createdAt:row.createdAt ? iso(timestamp(row.createdAt)) : null }
}

function stableHash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function contentDigests(meta) {
  if (!meta || typeof meta !== 'object') return null
  const fields = {}
  for (const key of ['title', 'description', 'priority', 'labels']) {
    if (Object.hasOwn(meta, key) && meta[key] !== undefined) {
      fields[key] = stableHash(meta[key])
    }
  }
  if (!Object.keys(fields).length) return null
  return { hash: stableHash(fields), fields }
}

export function openLinearProjectMonitor({ path, projectId, linear, now = Date.now, overlapMs = 15_000,
  intakeStateIds = [], assertActive = () => {},
}) {
  if (!nonempty(path) || !nonempty(projectId) || typeof linear?.listIssues !== 'function'
    || typeof linear.listHistory !== 'function' || !Number.isSafeInteger(overlapMs) || overlapMs < 0
    || !Array.isArray(intakeStateIds) || !intakeStateIds.every(nonempty) || typeof assertActive !== 'function') {
    throw new Error('Invalid Linear project monitor configuration')
  }
  const intakeStates = new Set(intakeStateIds)

  assertActive()
  const db = new DatabaseSync(path)
  db.exec(`
    PRAGMA busy_timeout = 2000;
    CREATE TABLE IF NOT EXISTS monitor_checkpoint (
      id INTEGER PRIMARY KEY CHECK(id = 1), project_id TEXT NOT NULL, started_ms INTEGER, until_ms INTEGER
    );
    CREATE TABLE IF NOT EXISTS monitor_issues (
      id TEXT PRIMARY KEY, state_id TEXT NOT NULL, updated_ms INTEGER NOT NULL,
      identifier TEXT, content_hash TEXT, content_meta TEXT
    );
    CREATE TABLE IF NOT EXISTS monitor_batches (
      seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, status TEXT NOT NULL, updated_at TEXT NOT NULL, receipt TEXT
    );
    CREATE TABLE IF NOT EXISTS monitor_events (
      seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, payload TEXT NOT NULL, batch_id TEXT,
      handled_at TEXT, handled_by TEXT, note TEXT
    );
    CREATE TABLE IF NOT EXISTS monitor_intake_reconciliation (
      state_id TEXT PRIMARY KEY, reconciled_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS linear_issue_bindings (
      project_id TEXT NOT NULL, issue_id TEXT PRIMARY KEY, identifier TEXT NOT NULL,
      task_id TEXT NOT NULL UNIQUE, room_id TEXT NOT NULL, source TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS linear_outbound_sync (
      operation_id TEXT PRIMARY KEY, issue_id TEXT NOT NULL, identifier TEXT NOT NULL,
      task_id TEXT NOT NULL, task_revision INTEGER NOT NULL, from_status TEXT, to_status TEXT NOT NULL,
      target_linear_state TEXT, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
      next_retry_ms INTEGER NOT NULL DEFAULT 0, attempted_at TEXT, verified_at TEXT,
      remote_before_at TEXT, remote_after_at TEXT, state_started_at TEXT,
      last_error TEXT, comment_body TEXT, comment_posted INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS linear_outbound_echo (
      id INTEGER PRIMARY KEY AUTOINCREMENT, issue_id TEXT NOT NULL, to_state_id TEXT NOT NULL,
      to_state_name TEXT, operation_id TEXT NOT NULL UNIQUE, attempted_ms INTEGER NOT NULL,
      verified_ms INTEGER NOT NULL, remote_updated_ms INTEGER, state_started_ms INTEGER, consumed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS monitor_suppressed_echoes (
      seq INTEGER PRIMARY KEY, event_id TEXT NOT NULL UNIQUE, issue_id TEXT NOT NULL,
      to_state_id TEXT NOT NULL, matched_operation_id TEXT NOT NULL, suppressed_at TEXT NOT NULL, payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS monitor_events_by_batch ON monitor_events(batch_id, handled_at);
    CREATE INDEX IF NOT EXISTS linear_outbound_status_idx ON linear_outbound_sync(status, next_retry_ms);
    CREATE INDEX IF NOT EXISTS linear_echo_lookup_idx ON linear_outbound_echo(issue_id, to_state_id, consumed_at);
  `)
  const issueCols = new Set(db.prepare('PRAGMA table_info(monitor_issues)').all().map(row => row.name))
  if (!issueCols.has('identifier')) db.exec('ALTER TABLE monitor_issues ADD COLUMN identifier TEXT')
  if (!issueCols.has('content_hash')) db.exec('ALTER TABLE monitor_issues ADD COLUMN content_hash TEXT')
  if (!issueCols.has('content_meta')) db.exec('ALTER TABLE monitor_issues ADD COLUMN content_meta TEXT')

  db.prepare('INSERT OR IGNORE INTO monitor_checkpoint(id, project_id) VALUES (1, ?)').run(projectId)
  const readCheckpoint = db.prepare('SELECT project_id, started_ms, until_ms FROM monitor_checkpoint WHERE id = 1')
  if (readCheckpoint.get().project_id !== projectId) {
    db.close()
    throw new Error('Database belongs to a different Linear project')
  }

  function transaction(action) {
    assertActive()
    db.exec('BEGIN IMMEDIATE')
    try {
      const value = action()
      db.exec('COMMIT')
      return value
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }

  const readIssue = db.prepare('SELECT id, identifier, state_id, updated_ms, content_hash, content_meta FROM monitor_issues WHERE id = ?')
  const saveIssue = db.prepare(`INSERT INTO monitor_issues(id, state_id, updated_ms, identifier, content_hash, content_meta) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      state_id = CASE WHEN excluded.updated_ms >= monitor_issues.updated_ms THEN excluded.state_id ELSE monitor_issues.state_id END,
      updated_ms = MAX(monitor_issues.updated_ms, excluded.updated_ms),
      identifier = COALESCE(excluded.identifier, monitor_issues.identifier),
      content_hash = COALESCE(excluded.content_hash, monitor_issues.content_hash),
      content_meta = COALESCE(excluded.content_meta, monitor_issues.content_meta)`)
  const saveEvent = db.prepare('INSERT OR IGNORE INTO monitor_events(id, payload) VALUES (?, ?)')
  const updateCheckpoint = db.prepare('UPDATE monitor_checkpoint SET started_ms = COALESCE(started_ms, ?), until_ms = ? WHERE id = 1')
  const reconciledIntake = db.prepare('SELECT state_id FROM monitor_intake_reconciliation')
  const recordIntake = db.prepare('INSERT OR IGNORE INTO monitor_intake_reconciliation(state_id, reconciled_at) VALUES (?, ?)')
  const selectEchoCandidates = db.prepare('SELECT id, operation_id, attempted_ms, verified_ms, state_started_ms FROM linear_outbound_echo WHERE consumed_at IS NULL AND issue_id = ? AND to_state_id = ? ORDER BY id ASC')
  const consumeEcho = db.prepare('UPDATE linear_outbound_echo SET consumed_at = ? WHERE id = ?')
  const hasSuppressedEvent = db.prepare('SELECT 1 FROM monitor_suppressed_echoes WHERE event_id = ? LIMIT 1')
  const insertSuppressedEcho = db.prepare('INSERT OR IGNORE INTO monitor_suppressed_echoes(event_id, issue_id, to_state_id, matched_operation_id, suppressed_at, payload) VALUES (?, ?, ?, ?, ?, ?)')

  function statusEvent(issue, change) {
    const { historyId, fromStateId, toStateId, actorId, time, createdAt } = change
    const parts = [projectId, issue.id, historyId, fromStateId, toStateId, actorId]
    if (!historyId) parts.push(time)
    const at = iso(time)
    return { id:hash(parts), projectId, issueId:issue.id, identifier:issue.identifier, url:issue.url ?? null,
      kind:historyId ? 'history' : 'observed', historyId, actorId, fromStateId, toStateId,
      at, sourceCreatedAt:createdAt ?? null, sourceUpdatedAt:at, observedAt:iso(now()),
      stateName:toStateId === issue.state.id ? issue.state.name ?? null : null }
  }

  function intakeEvent(issue) {
    const observedAt = iso(now())
    return { id:hash([projectId, issue.id, 'intake']), projectId, issueId:issue.id,
      identifier:issue.identifier, url:issue.url ?? null, kind:'intake', historyId:null, actorId:null,
      fromStateId:null, toStateId:issue.state.id, at:observedAt, observedAt,
      sourceCreatedAt:null, sourceUpdatedAt:issue.updatedAt, stateName:issue.state.name ?? null }
  }

  function contentChangedEvent(issue, changedFields, previousHash, nextHash) {
    const observedAt = iso(now())
    return {
      id: hash([projectId, issue.id, 'content_changed', previousHash, nextHash]),
      projectId, issueId: issue.id, identifier: issue.identifier, url: issue.url ?? null,
      kind: 'content_changed', historyId: null, actorId: null,
      fromStateId: issue.state.id, toStateId: issue.state.id,
      changedFields, previousHash, contentHash: nextHash,
      at: issue.updatedAt, sourceCreatedAt: null, sourceUpdatedAt: issue.updatedAt, observedAt,
      stateName: issue.state.name ?? null,
    }
  }

  function matchingEcho(event) {
    if (event.kind !== 'history' && event.kind !== 'observed') return null
    if (!nonempty(event.toStateId)) return null
    const eventMs = Date.parse(event.at)
    if (!Number.isFinite(eventMs)) return null
    const rows = selectEchoCandidates.all(event.issueId, event.toStateId)
    for (const row of rows) {
      if (row.state_started_ms !== null && Math.abs(eventMs - row.state_started_ms) <= 2_000) return row
      if (eventMs >= row.attempted_ms - 5_000 && eventMs <= row.verified_ms + 15_000) return row
    }
    return null
  }

  async function scan() {
    assertActive()
    const { started_ms:started, until_ms:previous } = readCheckpoint.get()
    const until = now()
    if (!Number.isSafeInteger(until) || until < 0) throw new Error('Invalid monitor clock')
    const initial = previous === null
    if (!initial && until <= previous) return { baseline:false, scanned:0, queued:0, checkpoint:iso(previous) }
    const previouslyReconciled = new Set(reconciledIntake.all().map(row => row.state_id))
    const pendingIntake = new Set([...intakeStates].filter(state => !previouslyReconciled.has(state)))
    const reconcile = pendingIntake.size > 0
    const from = initial ? null : Math.max(0, previous - overlapMs)
    const window = { from:from === null ? null : iso(from), until:iso(until) }
    // An existing monitor may have recorded these issues before intake was enabled.
    // Fetch their current snapshots once without widening the status-history window.
    const snapshotWindow = reconcile ? { ...window, from:null } : window
    const snapshots = new Map()
    await pages(after => {
      assertActive()
      return linear.listIssues({ projectId, after, ...snapshotWindow })
    }, issue => {
      if (![issue?.id, issue?.identifier, issue?.state?.id].every(nonempty)) throw new Error('Invalid Linear issue status')
      const time = timestamp(issue.updatedAt)
      if (time >= until || (!reconcile && from !== null && time < from)) return
      if (time >= (snapshots.get(issue.id)?.time ?? 0)) snapshots.set(issue.id, { issue, time })
    })

    const events = []
    const contentUpdates = new Map()
    if (!initial) {
      for (const { issue, time } of snapshots.values()) {
        if (time < from) continue
        const persisted = readIssue.get(issue.id)
        if (persisted?.updated_ms > time) continue
        const history = []
        let contentMeta
        // The adapter orders history by most recently updated first.
        await pages(async after => {
          assertActive()
          const page = await linear.listHistory({ issueId:issue.id, after, ...window })
          if (after == null && page?.contentMeta && typeof page.contentMeta === 'object') contentMeta = page.contentMeta
          return page
        }, row => {
          const historyTime = timestamp(row?.updatedAt ?? row?.createdAt)
          if (historyTime < Math.max(started, from)) return false
          const change = historyEntry(row, historyTime)
          if (change && historyTime < until) history.push(change)
        })
        for (const change of history) events.push(statusEvent(issue, change))
        const previousStatus = persisted?.state_id ?? null
        if (previousStatus !== issue.state.id && !history.some(change => change.toStateId === issue.state.id
          && change.time >= (persisted?.updated_ms ?? 0))) {
          events.push(statusEvent(issue, { historyId:null, actorId:null, fromStateId:previousStatus, toStateId:issue.state.id, time }))
        }
        const digest = contentDigests(contentMeta)
        if (digest) {
          contentUpdates.set(issue.id, { hash: digest.hash, meta: JSON.stringify(digest.fields) })
          if (persisted?.content_hash && persisted.content_hash !== digest.hash) {
            let oldFields = {}
            try { oldFields = JSON.parse(persisted.content_meta || '{}') } catch {}
            const changedFields = Object.keys({ ...oldFields, ...digest.fields })
              .filter(key => oldFields[key] !== digest.fields[key])
            if (changedFields.length) {
              events.push(contentChangedEvent(issue, changedFields, persisted.content_hash, digest.hash))
            }
          }
        }
      }
    }
    if (reconcile) {
      const notified = new Set(events.filter(event => snapshots.get(event.issueId)?.issue.state.id === event.toStateId)
        .map(event => event.issueId))
      for (const { issue, time } of snapshots.values()) {
        if (!pendingIntake.has(issue.state.id) || notified.has(issue.id) || (readIssue.get(issue.id)?.updated_ms ?? 0) > time) continue
        if (issue.archivedAt === undefined) throw new Error('Linear issue archive state unavailable')
        if (issue.archivedAt === null) events.push(intakeEvent(issue))
      }
    }

    events.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id))
    const { queued, intakeQueued, suppressedEchoes } = transaction(() => {
      if (readCheckpoint.get().until_ms !== previous) throw new Error('Another monitor advanced this project')
      for (const { issue, time } of snapshots.values()) {
        const content = contentUpdates.get(issue.id)
        saveIssue.run(issue.id, issue.state.id, time, issue.identifier ?? null, content?.hash ?? null, content?.meta ?? null)
      }
      let queued = 0
      let intakeQueued = 0
      let suppressedEchoes = 0
      const suppressedAt = iso(now())
      for (const event of events) {
        if (hasSuppressedEvent.get(event.id)) continue
        const echo = matchingEcho(event)
        if (echo) {
          consumeEcho.run(suppressedAt, echo.id)
          suppressedEchoes += insertSuppressedEcho.run(event.id, event.issueId, event.toStateId, echo.operation_id, suppressedAt, JSON.stringify(event)).changes
          continue
        }
        const inserted = saveEvent.run(event.id, JSON.stringify(event)).changes
        queued += inserted
        if (event.kind === 'intake') intakeQueued += inserted
      }
      for (const stateId of pendingIntake) recordIntake.run(stateId, window.until)
      updateCheckpoint.run(until, until)
      return { queued, intakeQueued, suppressedEchoes }
    })
    return { baseline:initial, scanned:snapshots.size, queued, checkpoint:window.until,
      ...(suppressedEchoes ? { suppressedEchoes } : {}),
      ...(reconcile ? { intakeReconciled:true, intakeQueued } : {}) }
  }

  const selectPending = db.prepare('SELECT payload FROM monitor_events WHERE handled_at IS NULL AND seq > ? ORDER BY seq LIMIT ?')
  const selectPosition = db.prepare('SELECT seq FROM monitor_events WHERE id = ?')
  const selectBatch = db.prepare("SELECT id, status FROM monitor_batches WHERE status = 'queued' ORDER BY seq LIMIT 1")
  const deliveredPending = db.prepare(`SELECT b.updated_at FROM monitor_batches b WHERE b.status = 'delivered'
    AND EXISTS (SELECT 1 FROM monitor_events e WHERE e.batch_id = b.id AND e.handled_at IS NULL)
    ORDER BY b.updated_at DESC LIMIT 1`)
  const selectUncertain = db.prepare("SELECT id, status, receipt FROM monitor_batches WHERE status = 'uncertain' ORDER BY seq LIMIT ?")
  const selectLastDelivery = db.prepare("SELECT updated_at FROM monitor_batches WHERE status IN ('delivered', 'uncertain') ORDER BY updated_at DESC LIMIT 1")
  const selectBatchEvents = db.prepare('SELECT payload FROM monitor_events WHERE batch_id = ? ORDER BY seq')
  const selectUnassigned = db.prepare('SELECT id, payload FROM monitor_events WHERE handled_at IS NULL AND batch_id IS NULL ORDER BY seq LIMIT ?')
  const saveBatch = db.prepare("INSERT INTO monitor_batches(id, status, updated_at) VALUES (?, 'queued', ?)")
  const assignEvent = db.prepare('UPDATE monitor_events SET batch_id = ? WHERE id = ?')
  const updateDelivery = db.prepare("UPDATE monitor_batches SET status = ?, updated_at = ?, receipt = ? WHERE id = ? AND status IN ('queued', 'uncertain')")
  const completeEvent = db.prepare('UPDATE monitor_events SET handled_at = ?, handled_by = ?, note = ? WHERE id = ? AND handled_at IS NULL')
  const readBindingByTask = db.prepare('SELECT project_id AS projectId, issue_id AS issueId, identifier, task_id AS taskId, room_id AS roomId, source, created_at AS createdAt, updated_at AS updatedAt FROM linear_issue_bindings WHERE task_id = ?')
  const readBindingByIssue = db.prepare('SELECT project_id AS projectId, issue_id AS issueId, identifier, task_id AS taskId, room_id AS roomId, source, created_at AS createdAt, updated_at AS updatedAt FROM linear_issue_bindings WHERE issue_id = ?')
  const selectBindings = db.prepare('SELECT project_id AS projectId, issue_id AS issueId, identifier, task_id AS taskId, room_id AS roomId, source, created_at AS createdAt, updated_at AS updatedAt FROM linear_issue_bindings ORDER BY created_at ASC, rowid ASC')
  const upsertBinding = db.prepare('INSERT INTO linear_issue_bindings(project_id, issue_id, identifier, task_id, room_id, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(issue_id) DO UPDATE SET identifier = excluded.identifier, room_id = excluded.room_id, updated_at = excluded.updated_at WHERE linear_issue_bindings.task_id = excluded.task_id')
  const deleteBindingByTask = db.prepare('DELETE FROM linear_issue_bindings WHERE task_id = ?')
  const selectKnownIssues = db.prepare('SELECT id, identifier, state_id AS stateId, updated_ms AS updatedMs FROM monitor_issues ORDER BY updated_ms DESC')
  const selectKnownIssueByQuery = db.prepare('SELECT id, identifier, state_id AS stateId, updated_ms AS updatedMs FROM monitor_issues WHERE lower(id) = lower(?) OR lower(identifier) = lower(?) LIMIT 1')
  const insertEcho = db.prepare('INSERT OR IGNORE INTO linear_outbound_echo(issue_id, to_state_id, to_state_name, operation_id, attempted_ms, verified_ms, remote_updated_ms, state_started_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
  const insertOutbound = db.prepare("INSERT OR IGNORE INTO linear_outbound_sync(operation_id, issue_id, identifier, task_id, task_revision, from_status, to_status, target_linear_state, status, attempts, next_retry_ms, comment_body, comment_posted, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, 0, ?, 0, ?, ?)")
  const selectOutboundById = db.prepare('SELECT * FROM linear_outbound_sync WHERE operation_id = ?')
  const selectNextOutbound = db.prepare("SELECT * FROM linear_outbound_sync WHERE status IN ('pending', 'retry', 'attempted') AND next_retry_ms <= ? ORDER BY created_at ASC, rowid ASC LIMIT 1")
  const selectOutboundList = db.prepare('SELECT * FROM linear_outbound_sync ORDER BY rowid DESC LIMIT ?')
  const updateOutboundAttempt = db.prepare("UPDATE linear_outbound_sync SET status = 'attempted', attempts = attempts + 1, attempted_at = ?, remote_before_at = COALESCE(remote_before_at, ?), updated_at = ? WHERE operation_id = ?")
  const updateOutboundVerified = db.prepare("UPDATE linear_outbound_sync SET status = 'verified', verified_at = ?, remote_after_at = ?, state_started_at = ?, target_linear_state = COALESCE(?, target_linear_state), comment_posted = CASE WHEN ? THEN 1 ELSE comment_posted END, last_error = NULL, updated_at = ? WHERE operation_id = ?")
  const updateOutboundComment = db.prepare('UPDATE linear_outbound_sync SET comment_posted = ?, updated_at = ? WHERE operation_id = ?')
  const updateOutboundRetry = db.prepare("UPDATE linear_outbound_sync SET status = 'retry', next_retry_ms = ?, last_error = ?, updated_at = ? WHERE operation_id = ?")
  const updateOutboundConflict = db.prepare("UPDATE linear_outbound_sync SET status = 'conflict', last_error = ?, updated_at = ? WHERE operation_id = ?")
  const reactivateOutbound = db.prepare("UPDATE linear_outbound_sync SET status = 'pending', next_retry_ms = 0, last_error = NULL, updated_at = ? WHERE operation_id = ? AND status IN ('conflict', 'retry')")
  const countBindings = db.prepare('SELECT count(*) AS n FROM linear_issue_bindings')
  const countSuppressed = db.prepare('SELECT count(*) AS n FROM monitor_suppressed_echoes')
  const countOutboundByStatus = db.prepare('SELECT status, count(*) AS n FROM linear_outbound_sync GROUP BY status')
  const lastVerifiedOutbound = db.prepare("SELECT operation_id AS operationId, task_id AS taskId, identifier, to_status AS toStatus, target_linear_state AS targetLinearState, verified_at AS verifiedAt, remote_after_at AS remoteAfterAt FROM linear_outbound_sync WHERE status = 'verified' ORDER BY rowid DESC LIMIT 1")
  const load = row => JSON.parse(row.payload)
  const loadBatch = ({ id, status, receipt }) => ({ id, status, projectId, events:selectBatchEvents.all(id).map(load),
    ...(receipt ? { receipt:JSON.parse(receipt) } : {}) })

  let inFlight
  let closePromise
  return {
    poll() {
      if (closePromise) throw new Error('Linear project monitor is closing')
      inFlight ??= scan().finally(() => { inFlight = undefined })
      return inFlight
    },
    pending(count = 100, after) {
      const position = after === undefined ? 0 : selectPosition.get(after)?.seq
      if (position === undefined) throw new Error('Unknown inbox cursor')
      return selectPending.all(position, limit(count)).map(load)
    },
    getBatch(count = 20, { minDeliveryGapMs = 0, unresolvedDeliveryLeaseMs = Infinity } = {}) {
      if (!Number.isSafeInteger(minDeliveryGapMs) || minDeliveryGapMs < 0) throw new Error('Invalid delivery gap')
      if (unresolvedDeliveryLeaseMs !== Infinity
        && (!Number.isSafeInteger(unresolvedDeliveryLeaseMs) || unresolvedDeliveryLeaseMs < 0)) {
        throw new Error('Invalid unresolved delivery lease')
      }
      return transaction(() => {
        const at = now()
        const unresolved = deliveredPending.get()
        if (unresolved && at - timestamp(unresolved.updated_at) < unresolvedDeliveryLeaseMs) return null
        const existing = selectBatch.get()
        if (existing) return loadBatch(existing)
        const lastDelivery = selectLastDelivery.get()
        if (lastDelivery && at - timestamp(lastDelivery.updated_at) < minDeliveryGapMs) return null
        const rows = selectUnassigned.all(limit(count))
        if (!rows.length) return null
        const id = `linear-project:${hash([projectId, rows.map(row => row.id)])}`
        saveBatch.run(id, iso(at))
        for (const row of rows) assignEvent.run(id, row.id)
        return { id, status:'queued', projectId, events:rows.map(load) }
      })
    },
    recordDelivery(batchId, status, receipt) {
      if (!nonempty(batchId) || !['delivered', 'uncertain'].includes(status)) throw new Error('Invalid delivery outcome')
      const fields = ['sessionId', 'exchangeId', 'messageId', 'admittedAt', 'reason'].filter(key => nonempty(receipt?.[key]))
      const saved = fields.length ? JSON.stringify(Object.fromEntries(fields.map(key => [key, receipt[key].slice(0, 400)]))) : null
      return transaction(() => updateDelivery.run(status, iso(now()), saved, batchId).changes > 0)
    },
    uncertainBatches(count = 100) { return selectUncertain.all(limit(count)).map(loadBatch) },
    ack(ids, { actorId, note } = {}) {
      if (!Array.isArray(ids) || !ids.length || !ids.every(nonempty) || !nonempty(actorId) || !nonempty(note)) {
        throw new Error('A monitor decision requires event IDs, an actor and a note')
      }
      const at = iso(now())
      return transaction(() => ids.reduce((count, id) => count + completeEvent.run(at, actorId, note, id).changes, 0))
    },
    bindIssue({ issueId, identifier, taskId, roomId, source = 'manual' }) {
      if (![issueId, identifier, taskId, roomId, source].every(nonempty)) throw new Error('Invalid Linear issue binding')
      const at = iso(now())
      return transaction(() => {
        const byTask = readBindingByTask.get(taskId)
        if (byTask && byTask.issueId !== issueId) throw new Error('Board task is already bound to another Linear issue')
        const byIssue = readBindingByIssue.get(issueId)
        if (byIssue && byIssue.taskId !== taskId) throw new Error('Linear issue is already bound to another board task')
        upsertBinding.run(projectId, issueId, identifier, taskId, roomId, source, at, at)
        return readBindingByIssue.get(issueId)
      })
    },
    unbindTask(taskId) {
      if (!nonempty(taskId)) return false
      return transaction(() => deleteBindingByTask.run(taskId).changes > 0)
    },
    bindingByTask: taskId => nonempty(taskId) ? readBindingByTask.get(taskId) : undefined,
    bindingByIssue: issueId => nonempty(issueId) ? readBindingByIssue.get(issueId) : undefined,
    listBindings: () => selectBindings.all(),
    listKnownIssues: () => selectKnownIssues.all(),
    findKnownIssue: query => nonempty(query) ? selectKnownIssueByQuery.get(query.trim(), query.trim()) : undefined,
    recordOutboundEcho({ issueId, toStateId, toStateName = null, operationId, attemptedMs, verifiedMs, remoteUpdatedMs = null, stateStartedMs = null }) {
      if (![issueId, toStateId, operationId].every(nonempty)) throw new Error('Invalid outbound echo record')
      return transaction(() => insertEcho.run(issueId, toStateId, toStateName, operationId, attemptedMs, verifiedMs, remoteUpdatedMs, stateStartedMs).changes > 0)
    },
    enqueueOutbound({ operationId, issueId, identifier, taskId, taskRevision, fromStatus = null, toStatus, targetLinearState = null, commentBody = null }) {
      if (![operationId, issueId, identifier, taskId, toStatus].every(nonempty) || !Number.isSafeInteger(taskRevision)) {
        throw new Error('Invalid Linear outbound sync job')
      }
      const at = iso(now())
      return transaction(() => {
        const inserted = insertOutbound.run(operationId, issueId, identifier, taskId, taskRevision, fromStatus, toStatus, targetLinearState, commentBody, at, at).changes > 0
        return { inserted, job: selectOutboundById.get(operationId) }
      })
    },
    nextOutbound: (atMs = now()) => selectNextOutbound.get(atMs),
    getOutbound: operationId => nonempty(operationId) ? selectOutboundById.get(operationId) : undefined,
    listOutbound: (count = 25) => selectOutboundList.all(limit(count)),
    markOutboundAttempt(operationId, attemptedAt = iso(now()), remoteBeforeAt = null) {
      return transaction(() => updateOutboundAttempt.run(attemptedAt, remoteBeforeAt, iso(now()), operationId).changes > 0)
    },
    markOutboundVerified(operationId, { verifiedAt = iso(now()), remoteAfterAt = null, stateStartedAt = null, targetLinearState = null, commentPosted = false } = {}) {
      return transaction(() => updateOutboundVerified.run(verifiedAt, remoteAfterAt, stateStartedAt, targetLinearState, commentPosted ? 1 : 0, iso(now()), operationId).changes > 0)
    },
    markOutboundCommentPosted: (operationId, posted = true) => transaction(() => updateOutboundComment.run(posted ? 1 : 0, iso(now()), operationId).changes > 0),
    markOutboundRetry: (operationId, nextRetryMs, reason) => transaction(() => updateOutboundRetry.run(nextRetryMs, String(reason || 'retry').slice(0, 400), iso(now()), operationId).changes > 0),
    markOutboundConflict: (operationId, reason) => transaction(() => updateOutboundConflict.run(String(reason || 'conflict').slice(0, 400), iso(now()), operationId).changes > 0),
    retryOutbound: operationId => transaction(() => reactivateOutbound.run(iso(now()), operationId).changes > 0),
    stats() {
      const counts = Object.fromEntries(countOutboundByStatus.all().map(row => [row.status, row.n]))
      const pending = (counts.pending ?? 0) + (counts.retry ?? 0) + (counts.attempted ?? 0)
      return {
        bindingsCount: countBindings.get().n,
        suppressedEchoCount: countSuppressed.get().n,
        outbound: {
          pending,
          verified: counts.verified ?? 0,
          conflict: counts.conflict ?? 0,
          lastSync: lastVerifiedOutbound.get() ?? null,
        },
      }
    },
    close() {
      closePromise ??= Promise.resolve(inFlight).catch(() => {}).then(() => db.close())
      return closePromise
    },
  }
}
