import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createUserRedoJournal, userRedoIdentity } from '../../src/host/user-redo-journal.mjs'

const operationId = '9d5b1723-7063-4e3e-b27e-12f44dd0033d'
const recoveryId = 'a'.repeat(64)
const scope = { kind:'room', id:'room-1' }
const sourceMessage = { id:'message-1', role:'user', content:[{ type:'text', text:'Original task' }], source:{ kind:'bot', role:'request', work:'original-work' } }
const confirmedMessageHash = createHash('sha256').update(JSON.stringify(sourceMessage)).digest('hex')
const request = { operationId, recoveryId, scope, acknowledged:true, confirmedMessageHash }

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'dsbot-user-redo-'))
  t.after(() => rm(dir, { recursive:true, force:true }))
  const statePath = join(dir, 'state.json')
  const state = { works:{ 'original-work':{ state:'unknown' } } }
  await writeFile(statePath, JSON.stringify(state), { mode:0o600 })
  let allowed = true, current = true, failSave = false
  const rt = { state, statePath, requireHomeLock() {}, homeLockVersion:() => 1,
    async save() { if (failSave) throw Error('save failed'); await writeFile(statePath, JSON.stringify(state), { mode:0o600 }) } }
  const original = structuredClone(sourceMessage)
  const proof = { complete:true, durability:'target-writer-v1', recoveryId, sessionId:'original-session', messageSeq:12, turn:3,
    message:original, isCurrent:() => current }
  const journal = createUserRedoJournal(rt, { authorize:() => allowed, proveOriginal:async () => proof })
  return { state, statePath, journal, proof, original, setAllowed:x => { allowed = x }, setCurrent:x => { current = x }, setFailSave:x => { failSave = x } }
}

test('prepares a stable new identity and preserves original work', async t => {
  const f = await fixture(t), entry = await f.journal.prepare(request)
  assert.equal(entry.state, 'prepared')
  assert.deepEqual(entry.identity, userRedoIdentity(operationId))
  assert.deepEqual(f.state.works, { 'original-work':{ state:'unknown' } })
  assert.deepEqual(JSON.parse(await readFile(f.statePath, 'utf8')).userRedos[operationId], entry)
  assert.doesNotMatch(await readFile(f.statePath, 'utf8'), /Original task|senderSessionId/)
  assert.deepEqual(await f.journal.prepare(request), entry)
})

test('requires explicit acknowledgement, user authorization and a scoped identity', async t => {
  const f = await fixture(t)
  await assert.rejects(f.journal.prepare({ ...request, acknowledged:false }), /confirmation/)
  await assert.rejects(f.journal.prepare({ ...request, confirmedMessageHash:'b'.repeat(64) }), /confirmation/)
  f.setAllowed(false)
  await assert.rejects(f.journal.prepare(request), /unavailable/)
  f.setAllowed(true)
  await assert.rejects(f.journal.prepare({ ...request, operationId:'__proto__' }), /invalid/)
  assert.equal(f.state.userRedos, undefined)
})

test('rejects changed source, reused ID with different scope, and unsupported attachments', async t => {
  const f = await fixture(t)
  await f.journal.prepare(request)
  await assert.rejects(f.journal.prepare({ ...request, scope:{ kind:'room', id:'other' } }), /identity conflict/)
  f.original.content[0].text = 'Changed'
  await assert.rejects(f.journal.prepare(request), /proof changed/)
  f.original.content.push({ type:'image', data:'ignored' })
  await assert.rejects(f.journal.prepare(request), /cannot be verified/)
})

test('failed persistence remains unknown, never starts an Agent, and is not reissued under a new ID', async t => {
  const f = await fixture(t)
  f.setFailSave(true)
  await assert.rejects(f.journal.prepare(request), /outcome is unknown/)
  assert.equal(f.state.userRedos[operationId].state, 'prepared')
  assert.equal(JSON.parse(await readFile(f.statePath, 'utf8')).userRedos, undefined)
  await assert.rejects(f.journal.prepare(request), /snapshot unavailable/)
})

test('losing source proof cannot reuse a prepared operation', async t => {
  const f = await fixture(t)
  await f.journal.prepare(request)
  f.setCurrent(false)
  await assert.rejects(f.journal.prepare(request), /cannot be verified/)
})

test('concurrent calls for one operation are fenced', async t => {
  const f = await fixture(t)
  const [a, b] = await Promise.allSettled([f.journal.prepare(request), f.journal.prepare(request)])
  assert.equal([a, b].filter(x => x.status === 'fulfilled').length, 1)
  assert.match([a, b].find(x => x.status === 'rejected').reason.message, /unknown/)
})

test('a different operation cannot bypass an uncertain attempt', async t => {
  const f = await fixture(t)
  f.setFailSave(true)
  await assert.rejects(f.journal.prepare(request), /unknown/)
  await assert.rejects(f.journal.prepare({ ...request, operationId:'c2a7ed5e-3b37-4a48-bb72-3d82f9d8c454' }), /already exists/)
})

test('two operation IDs for the same recovery cannot both prepare', async t => {
  const f = await fixture(t)
  const results = await Promise.allSettled([f.journal.prepare(request),
    f.journal.prepare({ ...request, operationId:'c2a7ed5e-3b37-4a48-bb72-3d82f9d8c454' })])
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 1)
  assert.equal(Object.keys(f.state.userRedos).length, 1)
})
