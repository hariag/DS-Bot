// Experimental intake ledger only: it has no dispatch or acknowledgement API.
// It does not prove input coverage, atomically fence state.lock, or commit a DSH inbox.
import { createHash } from 'node:crypto'
import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'

const VERSION = 1
const APPLICATION_ID = 1146307143
const SCHEMA = `CREATE TABLE candidates (
  ordinal INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  room TEXT NOT NULL,
  origin_session TEXT NOT NULL,
  origin_message TEXT NOT NULL,
  insertion_seq INTEGER NOT NULL,
  insertion_index INTEGER NOT NULL,
  payload TEXT NOT NULL,
  recipients TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(origin_session, origin_message),
  UNIQUE(origin_session, insertion_seq, insertion_index)
)`
const digest = value => createHash('sha256').update(value).digest('hex')
const failure = (code, message) => Object.assign(new Error(message), { code })

function text(value, name) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${name} must be a nonempty string`)
  return value
}

// Canonical JSON lets the same source event be retried without depending on key order.
function canonical(value, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0)) return JSON.stringify(value)
  if (typeof value !== 'object' || ancestors.has(value)) throw new TypeError('payload must be acyclic JSON')
  const proto = Object.getPrototypeOf(value)
  if (!Array.isArray(value) && proto !== Object.prototype && proto !== null) throw new TypeError('payload must contain plain JSON objects')
  const keys = Reflect.ownKeys(value)
  if (keys.some(key => typeof key !== 'string')) throw new TypeError('payload must not have symbol keys')
  const descriptors = Object.getOwnPropertyDescriptors(value)
  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      if (keys.length !== value.length + 1) throw new TypeError('payload arrays must contain only indexed values')
      const entries = []
      for (let i = 0; i < value.length; i += 1) {
        const descriptor = descriptors[i]
        if (descriptor === undefined || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw new TypeError('payload arrays must contain only indexed JSON values')
        entries.push(canonical(descriptor.value, ancestors))
      }
      return `[${entries.join(',')}]`
    }
    return `{${keys.sort().map(key => {
      const descriptor = descriptors[key]
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw new TypeError('payload properties must be enumerable data')
      return `${JSON.stringify(key)}:${canonical(descriptor.value, ancestors)}`
    }).join(',')}}`
  } finally { ancestors.delete(value) }
}

export async function openGroupOutbox(path, { requireWritable } = {}) {
  text(path, 'path')
  if (!isAbsolute(path)) throw new TypeError('outbox path must be an absolute on-disk path')
  if (typeof requireWritable !== 'function') throw new TypeError('requireWritable must be supplied')
  const check = () => {
    if (requireWritable() !== true) throw failure('OUTBOX_READ_ONLY', 'The candidate ledger writer is not authorized')
  }
  check()
  // No memory fallback: inability to open durable storage refuses admission.
  const { DatabaseSync } = await import('node:sqlite')
  check()
  const markerPath = `${path}.identity`
  const markerOf = stat => JSON.stringify({ kind: 'ds-bot-group-candidate-v1', device: String(stat.dev), inode: String(stat.ino) })
  let created = false
  try {
    const fd = openSync(path, 'wx', 0o600)
    closeSync(fd)
    created = true
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
  }
  const original = lstatSync(path, { bigint: true })
  if (!original.isFile()) throw failure('OUTBOX_SCHEMA', 'Candidate ledger path must be a regular file')
  const inspect = (handle, allowEmpty) => {
    const version = handle.prepare('PRAGMA user_version').get().user_version
    const applicationId = handle.prepare('PRAGMA application_id').get().application_id
    const objects = handle.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all()
    if (allowEmpty && version === 0 && applicationId === 0 && objects.length === 0) return 'empty'
    if (applicationId !== APPLICATION_ID) throw failure('OUTBOX_SCHEMA', 'Refusing a database owned by another application')
    if (version !== VERSION) throw failure('OUTBOX_VERSION', `Unsupported candidate ledger schema ${version}`)
    const normalized = sql => sql?.replace(/\s+/g, ' ').trim()
    if (objects.length !== 1 || objects[0].type !== 'table' || objects[0].name !== 'candidates' || normalized(objects[0].sql) !== normalized(SCHEMA)) {
      throw failure('OUTBOX_SCHEMA', 'Candidate ledger schema does not match its version')
    }
    const journal = handle.prepare('PRAGMA journal_mode').get().journal_mode
    if (!['delete', 'truncate', 'persist', 'wal'].includes(journal)) throw failure('OUTBOX_SCHEMA', `Unsafe journal mode: ${journal}`)
    return 'ready'
  }
  // Check existing files with a read-only handle before opening a writer. A replaced
  // path between the two opens still requires an external fencing protocol.
  if (!created) {
    let marker
    try {
      if (!lstatSync(markerPath).isFile()) throw new Error('not a regular marker file')
      marker = readFileSync(markerPath, 'utf8')
    } catch {
      throw failure('OUTBOX_SCHEMA', 'Existing database lacks its candidate ledger identity')
    }
    if (marker !== markerOf(original)) throw failure('OUTBOX_SCHEMA', 'Candidate ledger identity does not match the file')
    const reader = new DatabaseSync(path, { readOnly: true })
    try { reader.exec('PRAGMA busy_timeout=50'); inspect(reader, false) } finally { reader.close() }
    const afterRead = lstatSync(path, { bigint: true })
    if (!afterRead.isFile() || markerOf(afterRead) !== marker) throw failure('OUTBOX_SCHEMA', 'Candidate ledger file changed during inspection')
  }
  check()
  const db = new DatabaseSync(path)
  const transaction = run => {
    check()
    db.exec('BEGIN IMMEDIATE')
    try {
      check()
      const result = run()
      check()
      db.exec('COMMIT')
      return result
    } catch (error) {
      try { db.exec('ROLLBACK') } catch { /* preserve the original failure */ }
      throw error
    }
  }
  try {
    // Synchronous contention is kept short; a caller may retry without blocking
    // the event loop for seconds. Do not change another database's journal mode.
    db.exec('PRAGMA busy_timeout=50; PRAGMA synchronous=FULL;')
    transaction(() => {
      if (inspect(db, created) === 'empty') {
        db.exec(`${SCHEMA}; PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=${VERSION};`)
      }
      inspect(db, false)
    })
    if (created) {
      check()
      const afterCreate = lstatSync(path, { bigint: true })
      if (!afterCreate.isFile() || markerOf(afterCreate) !== markerOf(original)) throw failure('OUTBOX_SCHEMA', 'Candidate ledger file changed during initialization')
      const fd = openSync(markerPath, 'wx', 0o600)
      try { writeFileSync(fd, markerOf(original), 'utf8'); fsyncSync(fd) } finally { closeSync(fd) }
    }
  } catch (error) { db.close(); throw error }
  const prepare = sql => {
    try { return db.prepare(sql) } catch (error) { db.close(); throw error }
  }
  const get = prepare('SELECT * FROM candidates WHERE origin_session=? AND origin_message=?')
  const slot = prepare('SELECT id FROM candidates WHERE origin_session=? AND insertion_seq=? AND insertion_index=?')
  const insert = prepare('INSERT INTO candidates(id,room,origin_session,origin_message,insertion_seq,insertion_index,payload,recipients,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
  const byRoom = prepare('SELECT * FROM candidates WHERE room=? ORDER BY ordinal')
  return {
    // Only candidates with an already-established original splice position belong here.
    // This API does not establish completeness or ordering and must not trigger delivery.
    stage({ room, originSession, originMessage, insertionSeq, insertionIndex, payload, recipients }) {
      text(room, 'room'); text(originSession, 'originSession'); text(originMessage, 'originMessage')
      if (!Number.isSafeInteger(insertionSeq) || insertionSeq < 0) throw new TypeError('insertionSeq must be a nonnegative safe integer')
      if (!Number.isSafeInteger(insertionIndex) || insertionIndex < 0) throw new TypeError('insertionIndex must be a nonnegative safe integer')
      if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) throw new TypeError('payload must be a JSON object')
      if (!Array.isArray(recipients)) throw new TypeError('recipients must be an array')
      const body = canonical(payload)
      const targets = canonical(recipients)
      const parsedTargets = JSON.parse(targets)
      for (const recipient of parsedTargets) text(recipient, 'recipient')
      if (new Set(parsedTargets).size !== parsedTargets.length) throw new TypeError('recipients must be unique')
      const candidateId = digest(canonical([originSession, originMessage]))
      return transaction(() => {
        const found = get.get(originSession, originMessage)
        if (found !== undefined) {
          if (found.room !== room || found.insertion_seq !== insertionSeq || found.insertion_index !== insertionIndex || found.payload !== body || found.recipients !== targets) {
            throw failure('OUTBOX_CONFLICT', 'Original message already staged with different origin or content')
          }
          return { candidateId, created: false }
        }
        if (slot.get(originSession, insertionSeq, insertionIndex) !== undefined) throw failure('OUTBOX_CONFLICT', 'Original splice position belongs to another message')
        insert.run(candidateId, room, originSession, originMessage, insertionSeq, insertionIndex, body, targets, Date.now())
        return { candidateId, created: true }
      })
    },
    // Ingest order is for diagnostics only; it is not a dispatch order or watermark.
    list(room) {
      text(room, 'room')
      return byRoom.all(room).map(item => ({
        candidateId: item.id, ingestOrdinal: item.ordinal, originSession: item.origin_session,
        originMessage: item.origin_message, insertionSeq: item.insertion_seq, insertionIndex: item.insertion_index,
        payload: JSON.parse(item.payload), recipients: JSON.parse(item.recipients), createdAt: item.created_at,
      }))
    },
    close() { db.close() },
  }
}
