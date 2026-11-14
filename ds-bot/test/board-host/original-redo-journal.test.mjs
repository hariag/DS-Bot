import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, chmod, rename, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { createOriginalRedoJournal, createIsolatedRedoJournal, originalRedoIdentity } from '../../src/host/original-redo-journal.mjs'
import { isolatedRedoConfirmation, userRedoConfirmation } from '../../src/host/user-redo-journal.mjs'
import { install as installStore } from '../../src/host/store.js'

const operationId = '9d5b1723-7063-4e3e-b27e-12f44dd0033d', otherId = 'c2a7ed5e-3b37-4a48-bb72-3d82f9d8c454'
const recoveryId = 'a'.repeat(64), scope = { kind:'room', id:'room-1' }
async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'original-redo-'))
  t.after(() => rm(home, { recursive:true, force:true }))
  let generation = 1, allowed = true, bound = true, current = true, resultProof
  const message = { id:'input-1', role:'user', source:{ kind:'bot', role:'request', work:'old-work' }, content:[{ type:'text', text:'sensitive original task' }] }
  const proof = { complete:true, durability:'target-writer-v1', recoveryId, botId:'bot', sessionId:'original-session', turn:4, messageSeq:12,
    message, isCurrent:() => current }
  const statePath = join(home, 'state.json'), state = { version:1 }
  await writeFile(statePath, JSON.stringify(state))
  const rt = { home, statePath, state, requireHomeLock() {}, homeLockVersion:() => generation,
    async save() { await writeFile(statePath, JSON.stringify(state)) } }
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
  await assert.rejects(f.journal.beginDispatch(operationId, { kind:'bot', id:'user' }), /unavailable/)
  await assert.rejects(f.journal.beginDispatch(operationId), /unavailable/)
  const first = await f.journal.beginDispatch(operationId, f.request.principal)
  assert.equal(first.perform, true)
  assert.deepEqual(await f.journal.beginDispatch(operationId, f.request.principal), { operationId, state:'unknown' })
  const restarted = createOriginalRedoJournal(f.rt, f.dependencies)
  assert.deepEqual(await restarted.beginDispatch(operationId, f.request.principal), { operationId, state:'unknown' })
})

test('same operation ID is fenced across modes and different recoveries even concurrently', async t => {
  const f = await fixture(t), otherRecovery = 'c'.repeat(64), target = { cwd:'/work', provider:'p', model:'m' }
  const otherProof = { ...f.proof, recoveryId:otherRecovery }
  f.dependencies.proveOriginal = async (_scope, id) => id === recoveryId ? f.proof : otherProof
  const isolated = createIsolatedRedoJournal(f.rt, f.dependencies)
  const otherRequest = { ...f.request, recoveryId:otherRecovery, target,
    confirmationDigest:isolatedRedoConfirmation(scope, otherRecovery, otherProof,
      { principal:f.request.principal, operationId, target }) }
  const [first, concurrent] = await Promise.allSettled([f.journal.prepare(f.request), isolated.prepare(otherRequest)])
  assert.equal(first.status, 'fulfilled')
  assert.equal(concurrent.status, 'rejected')
  await assert.rejects(createIsolatedRedoJournal(f.rt, f.dependencies).prepare(otherRequest), /identity conflict/)
})

test('same operation ID is fenced when isolated mode claimed it first', async t => {
  const f = await fixture(t), otherRecovery = 'c'.repeat(64), target = { cwd:'/work', provider:'p', model:'m' }
  const otherProof = { ...f.proof, recoveryId:otherRecovery }
  f.dependencies.proveOriginal = async (_scope, id) => id === recoveryId ? f.proof : otherProof
  const isolatedRequest = { ...f.request, target, confirmationDigest:isolatedRedoConfirmation(scope, recoveryId, f.proof,
    { principal:f.request.principal, operationId, target }) }
  const originalRequest = { ...f.request, recoveryId:otherRecovery,
    confirmationDigest:userRedoConfirmation(scope, otherRecovery, otherProof) }
  const first = createIsolatedRedoJournal(f.rt, f.dependencies), second = createOriginalRedoJournal(f.rt, f.dependencies)
  const [prepared, concurrent] = await Promise.allSettled([first.prepare(isolatedRequest), second.prepare(originalRequest)])
  assert.equal(prepared.status, 'fulfilled')
  assert.equal(concurrent.status, 'rejected')
  await assert.rejects(createOriginalRedoJournal(f.rt, f.dependencies).prepare(originalRequest), /identity conflict/)
})

test('retries the parent directory durability barrier after a failed first creation', { skip:process.platform !== 'linux' }, async t => {
  const f = await fixture(t), original = fs.fsyncSync
  let count = 0, fail = true
  fs.fsyncSync = fd => {
    if (fs.readlinkSync(`/proc/self/fd/${fd}`) === f.home) { count++; if (fail) throw Error('injected parent fsync failure') }
    return original(fd)
  }
  syncBuiltinESMExports()
  try {
    await assert.rejects(f.journal.prepare(f.request), /injected parent fsync failure/)
    fail = false
    const row = await f.journal.prepare(f.request)
    assert.equal(row.state, 'prepared')
    assert.ok(count >= 2)
  } finally { fs.fsyncSync = original; syncBuiltinESMExports() }
})

test('sync claiming fence is durable before the caller may claim, and cannot be consumed twice', async t => {
  const f = await fixture(t); await f.journal.prepare(f.request)
  const { binding } = await f.journal.beginDispatch(operationId, f.request.principal), turn = { turn:9, turnStartSeq:72 }
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
  await assert.rejects(f.journal.beginDispatch(operationId, f.request.principal), /confirmation/)
  f.proof.message.content[0].text = 'sensitive original task'
  f.allowed(false); await assert.rejects(f.journal.beginDispatch(operationId, f.request.principal), /unavailable/)
  f.allowed(true); f.bound(false); await assert.rejects(f.journal.beginDispatch(operationId, f.request.principal), /binding/)
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
  const { binding } = await f.journal.beginDispatch(operationId, f.request.principal)
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
  await assert.rejects(f.journal.beginDispatch(operationId, f.request.principal), Error)
  assert.equal(JSON.parse(await readFile(join(dir, `${operationId}.json`), 'utf8')).state, 'prepared')
})

test('a permission change after the durable dispatch transition returns unknown and does not permit resend', async t => {
  const f = await fixture(t); await f.journal.prepare(f.request)
  let checks = 0
  f.dependencies.validateBinding = () => { if (++checks === 2) { f.allowed(false); return false }; return true }
  const journal = createOriginalRedoJournal(f.rt, f.dependencies)
  await assert.rejects(journal.beginDispatch(operationId, f.request.principal), /outcome unknown/)
  assert.equal(JSON.parse(await readFile(join(f.home, 'original-redo-v1', `${operationId}.json`), 'utf8')).state, 'dispatching')
  f.allowed(true)
  assert.deepEqual(await journal.beginDispatch(operationId, f.request.principal), { operationId, state:'unknown' })
})

test('a lost claim confirmation fences the durable claiming record after restart', async t => {
  const f = await fixture(t); await f.journal.prepare(f.request)
  const { binding } = await f.journal.beginDispatch(operationId, f.request.principal)
  let checks = 0
  f.dependencies.validateBinding = () => ++checks < 2
  const journal = createOriginalRedoJournal(f.rt, f.dependencies), turn = { turn:9, turnStartSeq:72 }
  assert.throws(() => journal.markClaimingSync(binding, turn, f.request.principal), /outcome unknown/)
  assert.equal(JSON.parse(await readFile(join(f.home, 'original-redo-v1', `${operationId}.json`), 'utf8')).state, 'claiming')
  f.dependencies.validateBinding = () => true
  assert.throws(() => createOriginalRedoJournal(f.rt, f.dependencies).markClaimingSync(binding, turn, f.request.principal), /unavailable/)
})

test('reentrant binding validation cannot grant dispatch or claim after lease or access changes', async t => {
  const f = await fixture(t); await f.journal.prepare(f.request)
  f.dependencies.validateBinding = () => { f.generation(2); return true }
  const journal = createOriginalRedoJournal(f.rt, f.dependencies)
  await assert.rejects(journal.beginDispatch(operationId, f.request.principal), /lease changed/)
  f.dependencies.validateBinding = () => true
  const { binding } = await journal.beginDispatch(operationId, f.request.principal)
  f.dependencies.validateBinding = () => { f.allowed(false); return true }
  const changed = createOriginalRedoJournal(f.rt, f.dependencies)
  assert.throws(() => changed.markClaimingSync(binding, { turn:9, turnStartSeq:72 }, f.request.principal), /unavailable/)
})

test('replacement or loss of a previously initialized journal directory fails closed after restart', async t => {
  const f = await fixture(t); await f.journal.prepare(f.request)
  const root = join(f.home, 'original-redo-v1')
  await rename(root, `${root}.moved`)
  await mkdir(root, { mode:0o700 })
  const restarted = createOriginalRedoJournal(f.rt, f.dependencies)
  await assert.rejects(restarted.prepare({ ...f.request, operationId:otherId }), /identity unavailable|directory changed/)
  await assert.rejects(f.journal.beginDispatch(operationId, f.request.principal), /directory changed/)
})

test('removing one operation record cannot make its recovery eligible for another operation', async t => {
  const f = await fixture(t); await f.journal.prepare(f.request)
  await rm(join(f.home, 'original-redo-v1', `${operationId}.json`))
  const restarted = createOriginalRedoJournal(f.rt, f.dependencies)
  await assert.rejects(restarted.prepare({ ...f.request, operationId:otherId }), Error)
  await assert.rejects(restarted.prepare(f.request), Error)
})

test('missing or altered journal and recovery markers fail closed', async t => {
  const f = await fixture(t); await f.journal.prepare(f.request)
  const root = join(f.home, 'original-redo-v1')
  await rm(join(root, '.identity'))
  await assert.rejects(f.journal.beginDispatch(operationId, f.request.principal))
  const restarted = createOriginalRedoJournal(f.rt, f.dependencies)
  await assert.rejects(restarted.prepare({ ...f.request, operationId:otherId }))
})

test('a callback that widens the journal directory is fenced before dispatch', async t => {
  const f = await fixture(t); await f.journal.prepare(f.request)
  const root = join(f.home, 'original-redo-v1')
  t.after(() => chmod(root, 0o700).catch(() => {}))
  f.dependencies.validateBinding = () => { fs.chmodSync(root, 0o755); return true }
  const journal = createOriginalRedoJournal(f.rt, f.dependencies)
  await assert.rejects(journal.beginDispatch(operationId, f.request.principal), /directory changed/)
})

test('claim boundary is fixed before invoking callbacks', async t => {
  const f = await fixture(t); await f.journal.prepare(f.request)
  const { binding } = await f.journal.beginDispatch(operationId, f.request.principal)
  f.dependencies.validateBinding = (_row, turn) => { if (turn) { assert.equal(Object.isFrozen(turn), true); assert.throws(() => { turn.turn = 88 }, TypeError) }; return true }
  const journal = createOriginalRedoJournal(f.rt, f.dependencies)
  const result = journal.markClaimingSync(binding, { turn:9, turnStartSeq:72 }, f.request.principal)
  assert.deepEqual(result.turn, { turn:9, turnStartSeq:72 })
})

test('stores only a matching writer-verified result reference and requires authorization on repeat reads', async t => {
  const f = await fixture(t); await f.journal.prepare(f.request)
  const { binding } = await f.journal.beginDispatch(operationId, f.request.principal), turn = { turn:9, turnStartSeq:72 }
  f.journal.markClaimingSync(binding, turn, f.request.principal)
  const result = { durability:'target-writer-v1', sessionId:'original-session', messageId:binding.identity.messageId,
    admissionId:binding.identity.admissionId, turn, throughSeq:80, resultDigest:'b'.repeat(64),
    resultRef:{ kind:'session-events', sessionId:'original-session', firstSeq:75, lastSeq:78 }, isCurrent:() => true }
  f.resultProof({ ...result, admissionId:'wrong' })
  await assert.rejects(f.journal.recordResult(operationId, f.request.principal), /unverified/)
  f.resultProof(result)
  const receipt = await f.journal.recordResult(operationId, f.request.principal)
  assert.equal(receipt.state, 'completed'); assert.equal(receipt.result.digest, 'b'.repeat(64))
  f.resultProof({ ...result, throughSeq:95 })
  assert.deepEqual(await f.journal.recordResult(operationId, f.request.principal), receipt)
  f.allowed(false)
  await assert.rejects(f.journal.recordResult(operationId, f.request.principal), /unavailable/)
})

test('snapshots the verified result before a reentrant authorization callback can mutate it', async t => {
  const f = await fixture(t); await f.journal.prepare(f.request)
  const { binding } = await f.journal.beginDispatch(operationId, f.request.principal), turn = { turn:9, turnStartSeq:72 }
  f.journal.markClaimingSync(binding, turn, f.request.principal)
  const proof = { durability:'target-writer-v1', sessionId:'original-session', messageId:binding.identity.messageId,
    admissionId:binding.identity.admissionId, turn, throughSeq:80, resultDigest:'b'.repeat(64),
    resultRef:{ kind:'session-events', sessionId:'original-session', firstSeq:75, lastSeq:78 }, isCurrent:() => true }
  let verified = false
  f.dependencies.verifyResult = async () => { verified = true; return proof }
  f.dependencies.authorize = () => { if (verified) { proof.resultDigest = 'bad'; proof.resultRef.lastSeq = 999 }; return true }
  const journal = createOriginalRedoJournal(f.rt, f.dependencies)
  const receipt = await journal.recordResult(operationId, f.request.principal)
  assert.equal(receipt.result.digest, 'b'.repeat(64)); assert.equal(receipt.result.ref.lastSeq, 78)
})

test('rejects a non-user principal before creating a record', async t => {
  const f = await fixture(t)
  await assert.rejects(f.journal.prepare({ ...f.request, principal:{ kind:'bot', id:'user' } }), /confirmation/)
  await assert.rejects(readdir(join(f.home, 'original-redo-v1')), { code:'ENOENT' })
})

test('authorization callbacks cannot mutate the requested or persisted scope and principal', async t => {
  const f = await fixture(t)
  f.dependencies.authorize = (inputScope, _id, principal) => { inputScope.id = 'mutated'; principal.id = 'mutated'; return true }
  const journal = createOriginalRedoJournal(f.rt, f.dependencies), row = await journal.prepare(f.request)
  assert.equal(row.scope.id, 'room-1'); assert.equal(row.principal.id, 'user')
  assert.equal(f.request.scope.id, 'room-1'); assert.equal(f.request.principal.id, 'user')
  const dispatched = await journal.beginDispatch(operationId, f.request.principal)
  assert.equal(dispatched.binding.scope.id, 'room-1'); assert.equal(dispatched.binding.principal.id, 'user')
})

test('independent state witness blocks a new operation when both private records are missing', async t => {
  const f = await fixture(t); await f.journal.prepare(f.request)
  const root = join(f.home, 'original-redo-v1')
  await rm(join(root, `${operationId}.json`)); await rm(join(root, `.recovery-${recoveryId}`))
  const restarted = createOriginalRedoJournal(f.rt, f.dependencies)
  await assert.rejects(restarted.prepare({ ...f.request, operationId:otherId }), Error)
  await assert.rejects(restarted.prepare(f.request), Error)
})

test('state witness loss while private journal remains cannot authorize dispatch or prepare', async t => {
  const f = await fixture(t); await f.journal.prepare(f.request)
  delete f.rt.state.originalRedoWitness
  await f.rt.save()
  await assert.rejects(f.journal.prepare(f.request), Error)
  await assert.rejects(f.journal.beginDispatch(operationId, f.request.principal), Error)
})

test('failed state save before and after write remains unknown and never authorizes a new operation', async t => {
  for (const after of [false, true]) {
    const f = await fixture(t), save = f.rt.save
    f.rt.save = async () => { if (after) await save(); throw Error('injected state save failure') }
    await assert.rejects(f.journal.prepare(f.request), /unknown/)
    f.rt.save = save
    await assert.rejects(f.journal.prepare(f.request), Error)
    await assert.rejects(f.journal.prepare({ ...f.request, operationId:otherId }), Error)
  }
})

test('adoption or lease change during witness save leaves preparation unknown', async t => {
  const f = await fixture(t), save = f.rt.save
  f.rt.save = async () => { await save(); f.generation(2); delete f.rt.state.originalRedoWitness }
  await assert.rejects(f.journal.prepare(f.request), /unknown/)
  f.rt.save = save
  await assert.rejects(f.journal.prepare(f.request), Error)
})

test('the actual store preserves the witness through normalization, save and reload', async t => {
  const f = await fixture(t), disposers = []
  const ctx = { logger:{ warn() {} }, effect(fn) { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose) } }
  const rt = { home:f.home, statePath:f.rt.statePath, ctx, autoRoomName:() => 'Room', retitleRoom:async () => {}, warn() {} }
  installStore(rt)
  t.after(async () => { for (const dispose of disposers.splice(0)) await dispose() })
  await rt.load(); await rt.save({ required:true })
  const journal = createOriginalRedoJournal(rt, f.dependencies), saved = await journal.prepare(f.request)
  assert.equal(rt.state.originalRedoWitness[recoveryId].operationId, operationId)
  const savedState = JSON.parse(await readFile(rt.statePath, 'utf8'))
  assert.deepEqual(savedState.originalRedoWitness, rt.state.originalRedoWitness)
  for (const dispose of disposers.splice(0)) await dispose()
  const restored = { home:f.home, statePath:f.rt.statePath, ctx, autoRoomName:() => 'Room', retitleRoom:async () => {}, warn() {} }
  installStore(restored); await restored.load()
  assert.deepEqual(restored.state.originalRedoWitness, savedState.originalRedoWitness)
  assert.deepEqual(await createOriginalRedoJournal(restored, f.dependencies).prepare(f.request), saved)
  for (const dispose of disposers.splice(0)) await dispose()
})

test('different recoveries serialize their state witness saves rather than conflicting', async t => {
  const f = await fixture(t), secondRecovery = 'c'.repeat(64)
  const secondProof = { ...f.proof, recoveryId:secondRecovery }
  f.dependencies.proveOriginal = async (_scope, id) => id === recoveryId ? f.proof : secondProof
  const journal = createOriginalRedoJournal(f.rt, f.dependencies), entered = Promise.withResolvers(), release = Promise.withResolvers(), save = f.rt.save
  let calls = 0
  f.rt.save = async () => { if (++calls === 1) { entered.resolve(); await release.promise }; await save() }
  const first = journal.prepare(f.request)
  await entered.promise
  const second = journal.prepare({ ...f.request, operationId:otherId, recoveryId:secondRecovery,
    confirmationDigest:userRedoConfirmation(scope, secondRecovery, secondProof) })
  release.resolve()
  const rows = await Promise.all([first, second])
  assert.equal(rows.length, 2); assert.equal(Object.keys(f.rt.state.originalRedoWitness).length, 2)
})

test('phase witness refuses an operation record rolled back to prepared after dispatch', async t => {
  const f = await fixture(t); await f.journal.prepare(f.request)
  const path = join(f.home, 'original-redo-v1', `${operationId}.json`), before = await readFile(path)
  await f.journal.beginDispatch(operationId, f.request.principal)
  await writeFile(path, before)
  const restarted = createOriginalRedoJournal(f.rt, f.dependencies)
  await assert.rejects(restarted.beginDispatch(operationId, f.request.principal), Error)
})

test('phase witness refuses a claiming operation rolled back to dispatching', async t => {
  const f = await fixture(t); await f.journal.prepare(f.request)
  const { binding } = await f.journal.beginDispatch(operationId, f.request.principal), path = join(f.home, 'original-redo-v1', `${operationId}.json`)
  const before = await readFile(path), turn = { turn:9, turnStartSeq:72 }
  f.journal.markClaimingSync(binding, turn, f.request.principal)
  await writeFile(path, before)
  assert.throws(() => f.journal.markClaimingSync(binding, turn, f.request.principal), Error)
})

test('altered phase identity cannot authorize a claim', async t => {
  const f = await fixture(t); await f.journal.prepare(f.request)
  const { binding } = await f.journal.beginDispatch(operationId, f.request.principal)
  const marker = join(f.home, `.original-redo-${operationId}-dispatching`)
  const data = JSON.parse(await readFile(marker, 'utf8')); data.bindingHash = 'd'.repeat(64)
  await writeFile(marker, JSON.stringify(data))
  assert.throws(() => f.journal.markClaimingSync(binding, { turn:9, turnStartSeq:72 }, f.request.principal), Error)
})

test('phase witness refuses a completed record rolled back to claiming', async t => {
  const f = await fixture(t); await f.journal.prepare(f.request)
  const { binding } = await f.journal.beginDispatch(operationId, f.request.principal), turn = { turn:9, turnStartSeq:72 }
  f.journal.markClaimingSync(binding, turn, f.request.principal)
  const path = join(f.home, 'original-redo-v1', `${operationId}.json`), before = await readFile(path)
  f.resultProof({ durability:'target-writer-v1', sessionId:'original-session', messageId:binding.identity.messageId,
    admissionId:binding.identity.admissionId, turn, throughSeq:80, resultDigest:'b'.repeat(64),
    resultRef:{ kind:'session-events', sessionId:'original-session', firstSeq:75, lastSeq:78 }, isCurrent:() => true })
  await f.journal.recordResult(operationId, f.request.principal)
  await writeFile(path, before)
  await assert.rejects(f.journal.recordResult(operationId, f.request.principal), Error)
})

test('phase directory fsync failure fences a retry', { skip:process.platform !== 'linux' }, async t => {
  const f = await fixture(t); await f.journal.prepare(f.request)
  const original = fs.fsyncSync, marker = join(f.home, `.original-redo-${operationId}-dispatching`)
  fs.fsyncSync = fd => {
    if (fs.readlinkSync(`/proc/self/fd/${fd}`) === f.home && fs.existsSync(marker)) throw Error('injected phase fsync failure')
    return original(fd)
  }
  syncBuiltinESMExports()
  try { await assert.rejects(f.journal.beginDispatch(operationId, f.request.principal), /unknown/) }
  finally { fs.fsyncSync = original; syncBuiltinESMExports() }
  await assert.rejects(f.journal.beginDispatch(operationId, f.request.principal), Error)
})

test('a reentrant callback cannot overwrite a changed private operation record', async t => {
  const f = await fixture(t); await f.journal.prepare(f.request)
  const path = join(f.home, 'original-redo-v1', `${operationId}.json`)
  f.dependencies.validateBinding = row => { fs.writeFileSync(path, JSON.stringify({ ...row, state:'claiming', turn:{ turn:99, turnStartSeq:99 } })); return true }
  const journal = createOriginalRedoJournal(f.rt, f.dependencies)
  await assert.rejects(journal.beginDispatch(operationId, f.request.principal), /unknown/)
  assert.equal(JSON.parse(await readFile(path, 'utf8')).state, 'claiming')
})

test('a callback that restores the old row and deletes the phase cannot return dispatch permission', async t => {
  const f = await fixture(t); await f.journal.prepare(f.request)
  const path = join(f.home, 'original-redo-v1', `${operationId}.json`), old = await readFile(path)
  f.dependencies.validateBinding = row => {
    if (row.state === 'dispatching') { fs.writeFileSync(path, old); fs.unlinkSync(join(f.home, `.original-redo-${operationId}-dispatching`)) }
    return true
  }
  const journal = createOriginalRedoJournal(f.rt, f.dependencies)
  await assert.rejects(journal.beginDispatch(operationId, f.request.principal), /unknown/)
})

test('a callback that restores the dispatch row and deletes claim phase cannot return claim permission', async t => {
  const f = await fixture(t); await f.journal.prepare(f.request)
  const { binding } = await f.journal.beginDispatch(operationId, f.request.principal)
  const path = join(f.home, 'original-redo-v1', `${operationId}.json`), old = await readFile(path)
  f.dependencies.validateBinding = row => {
    if (row.state === 'claiming') { fs.writeFileSync(path, old); fs.unlinkSync(join(f.home, `.original-redo-${operationId}-claiming`)) }
    return true
  }
  const journal = createOriginalRedoJournal(f.rt, f.dependencies)
  assert.throws(() => journal.markClaimingSync(binding, { turn:9, turnStartSeq:72 }, f.request.principal), /unknown/)
})

test('claim inspection binds the exact durable row, principal and current authority', async t => {
  const f = await fixture(t); await f.journal.prepare(f.request)
  const dispatch = await f.journal.beginDispatch(operationId, f.request.principal)
  const claimed = f.journal.markClaimingSync(dispatch.binding, { turn:7, turnStartSeq:9 }, f.request.principal)
  assert.deepEqual(f.journal.inspectClaimingSync(claimed, f.request.principal), claimed)
  assert.throws(() => f.journal.inspectClaimingSync({ ...claimed, turn:{ turn:8, turnStartSeq:9 } }, f.request.principal), /unavailable/)
  assert.throws(() => f.journal.inspectClaimingSync(claimed, { kind:'bot', id:'user' }), /unavailable/)
  f.allowed(false)
  assert.throws(() => f.journal.inspectClaimingSync(claimed, f.request.principal), /unavailable/)
  f.allowed(true); f.bound(false)
  assert.throws(() => f.journal.inspectClaimingSync(claimed, f.request.principal), /unavailable/)
})

test('claim inspection refuses a reentrant rollback before a model request', async t => {
  const f = await fixture(t); await f.journal.prepare(f.request)
  const dispatch = await f.journal.beginDispatch(operationId, f.request.principal)
  const claimed = f.journal.markClaimingSync(dispatch.binding, { turn:7, turnStartSeq:9 }, f.request.principal)
  const path = join(f.home, 'original-redo-v1', `${operationId}.json`)
  let called = false
  const restarted = createOriginalRedoJournal(f.rt, { ...f.dependencies, validateBinding:() => {
    if (!called) { called = true; fs.writeFileSync(path, JSON.stringify(dispatch.binding), { mode:0o600 }) }
    return true
  } })
  assert.throws(() => restarted.inspectClaimingSync(claimed, f.request.principal), /unavailable|snapshot|changed|unknown/)
  assert.equal(called, true)
})


test('result reads revalidate text, writer, scope and principal without redispatch', async t => {
  const f = await fixture(t); await f.journal.prepare(f.request)
  const { binding } = await f.journal.beginDispatch(operationId, f.request.principal), turn = { turn:9, turnStartSeq:72 }
  f.journal.markClaimingSync(binding, turn, f.request.principal)
  let current = true
  const result = { durability:'target-writer-v1', sessionId:'original-session', messageId:binding.identity.messageId,
    admissionId:binding.identity.admissionId, turn, throughSeq:80, text:'synthetic result',
    resultDigest:createHash('sha256').update('synthetic result').digest('hex'),
    resultRef:{ kind:'session-events', sessionId:'original-session', firstSeq:75, lastSeq:78 }, isCurrent:() => current }
  f.resultProof(result); await f.journal.recordResult(operationId, f.request.principal)
  assert.deepEqual(await f.journal.readResult(operationId, f.request.principal), { operationId, state:'completed', text:'synthetic result' })
  await assert.rejects(f.journal.readResult(operationId, { kind:'bot', id:'user' }), /unavailable/)
  f.resultProof({ ...result, text:'changed' }); await assert.rejects(f.journal.readResult(operationId, f.request.principal), /unverified/)
  f.resultProof(result); current = false; await assert.rejects(f.journal.readResult(operationId, f.request.principal), /unverified/)
  current = true; f.allowed(false); await assert.rejects(f.journal.readResult(operationId, f.request.principal), /unavailable/)
  f.allowed(true); assert.equal((await f.journal.beginDispatch(operationId, f.request.principal)).state,'unknown')
})


test('result reads pin the proof callback against reentrant replacement', async t => {
  const f = await fixture(t); await f.journal.prepare(f.request)
  const { binding } = await f.journal.beginDispatch(operationId, f.request.principal), turn = { turn:9, turnStartSeq:72 }
  f.journal.markClaimingSync(binding, turn, f.request.principal)
  let current = true, verified = false
  const proof = { durability:'target-writer-v1', sessionId:'original-session', messageId:binding.identity.messageId,
    admissionId:binding.identity.admissionId, turn, throughSeq:80, text:'synthetic result',
    resultDigest:createHash('sha256').update('synthetic result').digest('hex'),
    resultRef:{ kind:'session-events', sessionId:'original-session', firstSeq:75, lastSeq:78 }, isCurrent:() => current }
  f.resultProof(proof); await f.journal.recordResult(operationId, f.request.principal)
  const journal = createOriginalRedoJournal(f.rt, { ...f.dependencies,
    verifyResult:async () => { verified = true; return proof },
    authorize:() => { if (verified) { current = false; proof.isCurrent = () => true }; return true } })
  await assert.rejects(journal.readResult(operationId, f.request.principal), /changed|unverified/)
})


test('private result artifacts allow bounded text that expands in JSON', async t => {
  const f = await fixture(t), target = { cwd:f.home, provider:'p', model:'m' }
  const journal = createIsolatedRedoJournal(f.rt, f.dependencies)
  const confirmationDigest = isolatedRedoConfirmation(scope, recoveryId, f.proof,
    { principal:f.request.principal, operationId, target })
  await journal.prepare({ ...f.request, target, confirmationDigest })
  const { binding } = await journal.beginDispatch(operationId, f.request.principal), turn = { turn:1, turnStartSeq:9 }
  journal.markClaimingSync(binding, turn, f.request.principal)
  const text = '\u0000'.repeat(64_000), identity = binding.identity
  f.resultProof({ durability:'target-writer-v1', sessionId:identity.sessionId, messageId:identity.messageId,
    admissionId:identity.admissionId, turn, throughSeq:20, text, resultDigest:createHash('sha256').update(text).digest('hex'),
    resultRef:{ kind:'session-events', sessionId:identity.sessionId, firstSeq:12, lastSeq:12 }, isCurrent:() => true })
  await journal.recordResult(operationId, f.request.principal)
  assert.equal((await journal.readResult(operationId, f.request.principal)).text, text)
})
