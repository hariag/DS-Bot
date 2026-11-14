import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createOriginalRedoJournal, originalRedoIdentity } from '../../src/host/original-redo-journal.mjs'
import { userRedoConfirmation } from '../../src/host/user-redo-journal.mjs'

const operationId = '9d5b1723-7063-4e3e-b27e-12f44dd0033d', otherId = 'c2a7ed5e-3b37-4a48-bb72-3d82f9d8c454'
const recoveryId = 'a'.repeat(64), scope = { kind:'room', id:'room-1' }
async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'original-redo-'))
  t.after(() => rm(home, { recursive:true, force:true }))
  let generation = 1, allowed = true, bound = true, current = true, resultProof
  const message = { id:'input-1', role:'user', source:{ kind:'bot', role:'request', work:'old-work' }, content:[{ type:'text', text:'sensitive original task' }] }
  const proof = { complete:true, durability:'target-writer-v1', recoveryId, botId:'bot', sessionId:'original-session', turn:4, messageSeq:12,
    message, isCurrent:() => current }
  const rt = { home, requireHomeLock() {}, homeLockVersion:() => generation }
  const dependencies = { authorize:() => allowed, proveOriginal:async () => proof, validateBinding:() => bound, verifyResult:async () => resultProof }
  const request = { operationId, recoveryId, scope, principal:{ kind:'user', id:'user' }, acknowledged:true, confirmationDigest:userRedoConfirmation(scope, recoveryId, proof) }
  return { home, rt, dependencies, request, proof, journal:createOriginalRedoJournal(rt, dependencies),
    allowed:value => { allowed = value }, bound:value => { bound = value }, current:value => { current = value }, generation:value => { generation = value },
    resultProof:value => { resultProof = value } }
}

test('prepares only a fixed original session and keeps plaintext and original work out of the private journal', async t => {
  const f = await fixture(t), row = await f.journal.prepare(f.request)
  assert.equal(row.original.sessionId, 'original-session')
  assert.deepEqual(row.identity, originalRedoIdentity(operationId))
  assert.equal(row.identity.sessionId, undefined)
  const text = await readFile(join(f.home, 'original-redo-v1', `${operationId}.json`), 'utf8')
  assert.doesNotMatch(text, /sensitive original task|old-work/)
  assert.deepEqual(await f.journal.prepare(f.request), row)
})

test('dispatch permission is granted once and survives restart without automatic reissue', async t => {
  const f = await fixture(t); await f.journal.prepare(f.request)
  const first = await f.journal.beginDispatch(operationId)
  assert.equal(first.perform, true)
  assert.deepEqual(await f.journal.beginDispatch(operationId), { operationId, state:'unknown' })
  const restarted = createOriginalRedoJournal(f.rt, f.dependencies)
  assert.deepEqual(await restarted.beginDispatch(operationId), { operationId, state:'unknown' })
})

test('sync claiming fence is durable before the caller may claim, and cannot be consumed twice', async t => {
  const f = await fixture(t); await f.journal.prepare(f.request)
  const { binding } = await f.journal.beginDispatch(operationId), turn = { turn:9, turnStartSeq:72 }
  assert.deepEqual(f.journal.inspectDispatchSync(binding, f.request.principal), binding)
  const row = f.journal.markClaimingSync(binding, turn, f.request.principal)
  assert.equal(row.state, 'claiming'); assert.deepEqual(row.turn, turn)
  assert.equal(JSON.parse(await readFile(join(f.home, 'original-redo-v1', `${operationId}.json`), 'utf8')).state, 'claiming')
  assert.throws(() => f.journal.markClaimingSync(binding, turn, f.request.principal), /unavailable/)
  assert.throws(() => createOriginalRedoJournal(f.rt, f.dependencies).markClaimingSync(binding, turn, f.request.principal), /unavailable/)
})

test('source change, revoked authorization and changed target fail before dispatch', async t => {
  const f = await fixture(t); await f.journal.prepare(f.request)
  f.proof.message.content[0].text = 'different'
  await assert.rejects(f.journal.beginDispatch(operationId), /confirmation/)
  f.proof.message.content[0].text = 'sensitive original task'
  f.allowed(false); await assert.rejects(f.journal.beginDispatch(operationId), /unavailable/)
  f.allowed(true); f.bound(false); await assert.rejects(f.journal.beginDispatch(operationId), /binding/)
  assert.equal(JSON.parse(await readFile(join(f.home, 'original-redo-v1', `${operationId}.json`), 'utf8')).state, 'prepared')
})

test('rejects two operations for one recovery and conflicting reused identity', async t => {
  const f = await fixture(t)
  const results = await Promise.allSettled([f.journal.prepare(f.request), f.journal.prepare({ ...f.request, operationId:otherId })])
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
  assert.equal((await readdir(join(f.home, 'original-redo-v1'))).filter(name => name.endsWith('.json')).length, 1)
  await assert.rejects(f.journal.prepare({ ...f.request, scope:{ kind:'room', id:'another' } }), /confirmation|conflict/)
})

test('does not claim with changed admission binding, invalid turn or revoked scope', async t => {
  const f = await fixture(t); await f.journal.prepare(f.request)
  const { binding } = await f.journal.beginDispatch(operationId)
  assert.throws(() => f.journal.markClaimingSync({ ...binding, identity:{ ...binding.identity, admissionId:'other' } }, { turn:9, turnStartSeq:72 }, f.request.principal), /unavailable/)
  assert.throws(() => f.journal.markClaimingSync(binding, { turn:9, turnStartSeq:-1 }, f.request.principal), /unavailable/)
  assert.throws(() => f.journal.inspectDispatchSync(binding, { kind:'bot', id:'bot' }), /unavailable/)
  f.allowed(false); assert.throws(() => f.journal.markClaimingSync(binding, { turn:9, turnStartSeq:72 }, f.request.principal), /unavailable/)
  f.allowed(true); f.bound(false); assert.throws(() => f.journal.markClaimingSync(binding, { turn:9, turnStartSeq:72 }, f.request.principal), /unavailable/)
  assert.equal(JSON.parse(await readFile(join(f.home, 'original-redo-v1', `${operationId}.json`), 'utf8')).state, 'dispatching')
})

test('rejects a private directory whose permissions were widened', async t => {
  const f = await fixture(t); await f.journal.prepare(f.request)
  const dir = join(f.home, 'original-redo-v1'); await chmod(dir, 0o755)
  t.after(() => chmod(dir, 0o700).catch(() => {}))
  await assert.rejects(f.journal.beginDispatch(operationId), /directory unavailable/)
})

test('a permission change after the durable dispatch transition returns unknown and does not permit resend', async t => {
  const f = await fixture(t); await f.journal.prepare(f.request)
  let checks = 0
  f.dependencies.validateBinding = () => { if (++checks === 2) { f.allowed(false); return false }; return true }
  const journal = createOriginalRedoJournal(f.rt, f.dependencies)
  await assert.rejects(journal.beginDispatch(operationId), /outcome unknown/)
  assert.equal(JSON.parse(await readFile(join(f.home, 'original-redo-v1', `${operationId}.json`), 'utf8')).state, 'dispatching')
  f.allowed(true)
  assert.deepEqual(await journal.beginDispatch(operationId), { operationId, state:'unknown' })
})

test('a lost claim confirmation fences the durable claiming record after restart', async t => {
  const f = await fixture(t); await f.journal.prepare(f.request)
  const { binding } = await f.journal.beginDispatch(operationId)
  let checks = 0
  f.dependencies.validateBinding = () => ++checks < 2
  const journal = createOriginalRedoJournal(f.rt, f.dependencies), turn = { turn:9, turnStartSeq:72 }
  assert.throws(() => journal.markClaimingSync(binding, turn, f.request.principal), /outcome unknown/)
  assert.equal(JSON.parse(await readFile(join(f.home, 'original-redo-v1', `${operationId}.json`), 'utf8')).state, 'claiming')
  f.dependencies.validateBinding = () => true
  assert.throws(() => createOriginalRedoJournal(f.rt, f.dependencies).markClaimingSync(binding, turn, f.request.principal), /unavailable/)
})

test('stores only a matching writer-verified result reference and requires authorization on repeat reads', async t => {
  const f = await fixture(t); await f.journal.prepare(f.request)
  const { binding } = await f.journal.beginDispatch(operationId), turn = { turn:9, turnStartSeq:72 }
  f.journal.markClaimingSync(binding, turn, f.request.principal)
  const result = { durability:'target-writer-v1', sessionId:'original-session', messageId:binding.identity.messageId,
    admissionId:binding.identity.admissionId, turn, throughSeq:80, resultDigest:'b'.repeat(64),
    resultRef:{ kind:'session-events', sessionId:'original-session', firstSeq:75, lastSeq:78 }, isCurrent:() => true }
  f.resultProof({ ...result, admissionId:'wrong' })
  await assert.rejects(f.journal.recordResult(operationId, f.request.principal), /unverified/)
  f.resultProof(result)
  const receipt = await f.journal.recordResult(operationId, f.request.principal)
  assert.equal(receipt.state, 'completed'); assert.equal(receipt.result.digest, 'b'.repeat(64))
  assert.deepEqual(await f.journal.recordResult(operationId, f.request.principal), receipt)
  f.allowed(false)
  await assert.rejects(f.journal.recordResult(operationId, f.request.principal), /unavailable/)
})

test('rejects a non-user principal before creating a record', async t => {
  const f = await fixture(t)
  await assert.rejects(f.journal.prepare({ ...f.request, principal:{ kind:'bot', id:'user' } }), /confirmation/)
  await assert.rejects(readdir(join(f.home, 'original-redo-v1')), { code:'ENOENT' })
})
