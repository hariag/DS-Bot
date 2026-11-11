import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { openGroupOutbox } from '../src/host/group-outbox.js'

const writable = () => true
function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'ds-bot-outbox-'))
  const handles = []
  t.after(() => {
    for (const handle of handles.reverse()) {
      try { handle.close() } catch (error) { if (error.code !== 'ERR_INVALID_STATE') throw error }
    }
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })
  return { file: join(dir, 'outbox.sqlite'), track: handle => { handles.push(handle); return handle } }
}
const post = (seq, overrides = {}) => ({ room: 'r1', originSession: 'group-session', originMessage: `msg-${seq}`, insertionSeq: seq, insertionIndex: 0, payload: { sender: 'user', text: `task ${seq}`, files: [{ id: 'f1' }] }, recipients: ['writer', 'tester'], ...overrides })
const childResult = (program, ...args) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ['--input-type=module', '-e', program, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''; let stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  child.once('error', reject)
  child.once('close', (code, signal) => code === 0 ? resolve(stdout) : reject(new Error(`child ${code ?? signal}: ${stderr}`)))
})

test('message identity is idempotent, while edited or moved messages fail closed', async (t) => {
  const { file, track } = scratch(t)
  const box = track(await openGroupOutbox(file, { requireWritable: writable }))
  const staged = box.stage(post(0))
  assert.equal(staged.created, true)
  assert.deepEqual(box.stage(post(0, { payload: { files: [{ id: 'f1' }], text: 'task 0', sender: 'user' } })), { ...staged, created: false })
  assert.throws(() => box.stage(post(0, { payload: { text: 'edited' } })), { code: 'OUTBOX_CONFLICT' })
  assert.throws(() => box.stage(post(0, { insertionSeq: 1 })), { code: 'OUTBOX_CONFLICT' })
  assert.throws(() => box.stage(post(0, { recipients: ['tester', 'writer'] })), { code: 'OUTBOX_CONFLICT' })
  assert.throws(() => box.stage(post(1, { recipients: ['writer', 'writer'] })), /unique/)
  assert.equal(box.list('r1').length, 1)
  const before = box.list('r1')[0]
  box.close()
  const reopened = track(await openGroupOutbox(file, { requireWritable: writable }))
  assert.deepEqual(reopened.list('r1'), [before])
})

test('messages in one splice have distinct identities and positions cannot be reused', async (t) => {
  const { file, track } = scratch(t)
  const box = track(await openGroupOutbox(file, { requireWritable: writable }))
  const first = box.stage(post(7, { originMessage: 'one', insertionIndex: 0 }))
  const second = box.stage(post(7, { originMessage: 'two', insertionIndex: 1 }))
  assert.notEqual(first.candidateId, second.candidateId)
  assert.throws(() => box.stage(post(7, { originMessage: 'three', insertionIndex: 1 })), { code: 'OUTBOX_CONFLICT' })
  assert.equal(box.list('r1').length, 2)
})

test('ingest order is not treated as verified source order and no dispatch API exists', async (t) => {
  const { file, track } = scratch(t)
  const box = track(await openGroupOutbox(file, { requireWritable: writable }))
  box.stage(post(10)); box.stage(post(9))
  assert.deepEqual(box.list('r1').map(item => item.insertionSeq), [10, 9])
  assert.equal(box.begin, undefined)
  assert.equal(box.accept, undefined)
  assert.equal(box.complete, undefined)
})

test('committed candidate survives process exit and retains sender and attachments', async (t) => {
  const { file, track } = scratch(t)
  const moduleUrl = new URL('../src/host/group-outbox.js', import.meta.url).href
  const program = `import { openGroupOutbox } from ${JSON.stringify(moduleUrl)};
    const box=await openGroupOutbox(process.argv[1],{requireWritable:()=>true});
    box.stage({room:'r1',originSession:'s1',originMessage:'m1',insertionSeq:4,insertionIndex:0,payload:{sender:'user',text:'task',files:[{id:'f1'}]},recipients:['writer']});
    process.exit(0);`
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', program, file], { encoding: 'utf8' })
  assert.equal(child.status, 0, child.stderr)
  const box = track(await openGroupOutbox(file, { requireWritable: writable }))
  assert.deepEqual(box.list('r1')[0].payload, { files: [{ id: 'f1' }], sender: 'user', text: 'task' })
  assert.deepEqual(box.list('r1')[0].recipients, ['writer'])
})

test('guard failure before commit rolls back candidate and does not fall back to memory', async (t) => {
  const { file, track } = scratch(t)
  let checks = 0; let failAt = Infinity
  const box = track(await openGroupOutbox(file, { requireWritable: () => ++checks !== failAt }))
  checks = 0; failAt = 3
  assert.throws(() => box.stage(post(1)), { code: 'OUTBOX_READ_ONLY' })
  failAt = Infinity
  assert.deepEqual(box.list('r1'), [])
  box.close()
  const reopened = track(await openGroupOutbox(file, { requireWritable: writable }))
  assert.deepEqual(reopened.list('r1'), [])
})

test('invalid or lossy inputs and an unauthorized writer fail closed', async (t) => {
  const { file, track } = scratch(t)
  await assert.rejects(openGroupOutbox(file, { requireWritable: () => false }), { code: 'OUTBOX_READ_ONLY' })
  assert.equal(existsSync(file), false)
  await assert.rejects(openGroupOutbox(':memory:', { requireWritable: writable }), /on-disk/)
  const box = track(await openGroupOutbox(file, { requireWritable: writable }))
  assert.throws(() => box.stage(post(-1)), /insertionSeq/)
  assert.throws(() => box.stage(post(Number.MAX_SAFE_INTEGER + 1)), /insertionSeq/)
  assert.throws(() => box.stage(post(1, { originMessage: '' })), /originMessage/)
  assert.throws(() => box.stage(post(1, { payload: { text: undefined } })), /JSON/)
  assert.throws(() => box.stage(post(1, { payload: { number: -0 } })), /JSON/)
  assert.throws(() => box.stage(post(1, { payload: { [Symbol('x')]: 1 } })), /symbol/)
  let called = false
  const getter = {}; Object.defineProperty(getter, 'text', { enumerable: true, get() { called = true; return 'x' } })
  assert.throws(() => box.stage(post(1, { payload: getter })), /enumerable data/)
  assert.equal(called, false)
  const recipientGetter = []
  Object.defineProperty(recipientGetter, 0, { enumerable: true, get() { called = true; return 'writer' } })
  assert.throws(() => box.stage(post(1, { recipients: recipientGetter })), /indexed JSON values/)
  assert.equal(called, false)
  const cyclic = {}; cyclic.self = cyclic
  assert.throws(() => box.stage(post(1, { payload: cyclic })), /acyclic/)
  assert.deepEqual(box.list('r1'), [])
})

test('SQLite writer contention fails admission without partial data', async (t) => {
  const { file, track } = scratch(t)
  const box = track(await openGroupOutbox(file, { requireWritable: writable }))
  const { DatabaseSync } = await import('node:sqlite')
  const other = track(new DatabaseSync(file))
  try { other.exec('BEGIN EXCLUSIVE'); assert.throws(() => box.stage(post(1)), /locked/i) } finally { other.exec('ROLLBACK'); other.close() }
  assert.deepEqual(box.list('r1'), [])
  assert.equal(box.stage(post(1)).created, true)
})

test('opening an existing database reports BUSY while it is exclusively locked and works after release', async (t) => {
  const { file, track } = scratch(t)
  const box = track(await openGroupOutbox(file, { requireWritable: writable }))
  box.close()
  const { DatabaseSync } = await import('node:sqlite')
  const other = track(new DatabaseSync(file))
  try {
    other.exec('BEGIN EXCLUSIVE')
    await assert.rejects(openGroupOutbox(file, { requireWritable: writable }), error => (error.errcode & 0xff) === 5)
  } finally { other.exec('ROLLBACK'); other.close() }
  const reopened = track(await openGroupOutbox(file, { requireWritable: writable }))
  assert.deepEqual(reopened.list('r1'), [])
  assert.equal(reopened.stage(post(1)).created, true)
})

test('process killed during an uncommitted transaction leaves no partial candidate', async (t) => {
  const { file, track } = scratch(t)
  const box = track(await openGroupOutbox(file, { requireWritable: writable })); box.close()
  const program = `const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(process.argv[1]);
    db.exec('PRAGMA synchronous=FULL; BEGIN IMMEDIATE');
    db.prepare('INSERT INTO candidates(id,room,origin_session,origin_message,insertion_seq,insertion_index,payload,recipients,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run('partial','r1','s1','m1',1,0,'{}','[]',1);
    process.kill(process.pid, 'SIGKILL');`
  const child = spawnSync(process.execPath, ['-e', program, file], { encoding: 'utf8' })
  assert.equal(child.signal, 'SIGKILL', child.stderr)
  const reopened = track(await openGroupOutbox(file, { requireWritable: writable }))
  assert.deepEqual(reopened.list('r1'), [])
})

test('an unrelated database is refused and left intact', async (t) => {
  const { file, track } = scratch(t)
  const { DatabaseSync } = await import('node:sqlite')
  const other = track(new DatabaseSync(file))
  other.exec("PRAGMA journal_mode=WAL; CREATE TABLE existing (value TEXT); INSERT INTO existing VALUES ('untouched'); PRAGMA user_version=1;")
  other.close()
  const hash = () => createHash('sha256').update(readFileSync(file)).digest('hex')
  const before = hash(); const filesBefore = readdirSync(dirname(file)).sort()
  await assert.rejects(openGroupOutbox(file, { requireWritable: writable }), { code: 'OUTBOX_SCHEMA' })
  assert.equal(hash(), before)
  assert.deepEqual(readdirSync(dirname(file)).sort(), filesBefore)
  const reopened = track(new DatabaseSync(file))
  assert.equal(reopened.prepare("SELECT name FROM sqlite_master WHERE name='existing'").get().name, 'existing')
  assert.equal(reopened.prepare('SELECT value FROM existing').get().value, 'untouched')
  assert.equal(reopened.prepare('PRAGMA journal_mode').get().journal_mode, 'wal')
  assert.equal(reopened.prepare('PRAGMA user_version').get().user_version, 1)
})

test('a wrong schema with the same application id and version is refused', async (t) => {
  const { file, track } = scratch(t)
  const { DatabaseSync } = await import('node:sqlite')
  const other = track(new DatabaseSync(file))
  other.exec('CREATE TABLE candidates (id TEXT); PRAGMA application_id=1146307143; PRAGMA user_version=1;')
  other.close()
  await assert.rejects(openGroupOutbox(file, { requireWritable: writable }), { code: 'OUTBOX_SCHEMA' })
  const reopened = track(new DatabaseSync(file))
  assert.equal(reopened.prepare('PRAGMA table_info(candidates)').all().length, 1)
})

test('a candidate database with an added trigger is refused', async (t) => {
  const { file, track } = scratch(t)
  const box = track(await openGroupOutbox(file, { requireWritable: writable })); box.close()
  const { DatabaseSync } = await import('node:sqlite')
  const other = track(new DatabaseSync(file))
  other.exec('CREATE TRIGGER surprising AFTER INSERT ON candidates BEGIN SELECT 1; END;')
  other.close()
  await assert.rejects(openGroupOutbox(file, { requireWritable: writable }), { code: 'OUTBOX_SCHEMA' })
})

test('concurrent processes stage one source message once', async (t) => {
  const { file, track } = scratch(t)
  const initial = track(await openGroupOutbox(file, { requireWritable: writable })); initial.close()
  const moduleUrl = new URL('../src/host/group-outbox.js', import.meta.url).href
  const stage = `import { openGroupOutbox } from ${JSON.stringify(moduleUrl)};
    const input={room:'r1',originSession:'s1',originMessage:'m1',insertionSeq:1,insertionIndex:0,payload:{text:'same'},recipients:['writer']};
    const deadline=Date.now()+5000;
    for (;;) {
      let db;
      try {
        db=await openGroupOutbox(process.argv[1],{requireWritable:()=>true});
        const result=db.stage(input);
        process.stdout.write(JSON.stringify(result));
        break;
      } catch (error) {
        if ((error.errcode & 0xff)!==5 || Date.now()>=deadline) throw error;
      } finally { db?.close(); }
      await new Promise(resolve=>setTimeout(resolve,20));
    }`
  const staged = (await Promise.all([childResult(stage, file), childResult(stage, file)])).map(JSON.parse)
  assert.deepEqual(staged.map(item => item.created).sort(), [false, true])
  assert.equal(staged[0].candidateId, staged[1].candidateId)
  const reopened = track(await openGroupOutbox(file, { requireWritable: writable }))
  assert.equal(reopened.list('r1').length, 1)
})
