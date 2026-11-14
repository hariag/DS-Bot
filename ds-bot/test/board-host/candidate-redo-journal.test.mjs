import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createLegacyRedoCandidate } from '../../src/host/user-redo-legacy-candidate.mjs'
import { candidateRedoConfirmation } from '../../src/host/candidate-redo-confirmation.mjs'
import { createCandidateRedoJournal, createOriginalRedoJournal } from '../../src/host/original-redo-journal.mjs'
import { userRedoConfirmation, userRedoIdentity } from '../../src/host/user-redo-journal.mjs'
import { install as installStore } from '../../src/host/store.js'

const operationId = 'bb5b1723-7063-4e3e-b27e-12f44dd0033d', otherId = 'c2a7ed5e-3b37-4a48-bb72-3d82f9d8c454'
const recoveryId = 'a'.repeat(64), scope = { kind:'room', id:'room' }, principal = { kind:'user', id:'user' }
const entry = (seq, type, data, time) => ({ seq, type, data, ...(time === undefined ? {} : { time }) })

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'candidate-redo-journal-'))
  t.after(() => rm(home, { recursive:true, force:true }))
  let current = true, allowed = true, generation = 1
  const message = { id:'m', role:'user', source:{ kind:'bot', role:'request', exchangeId:'ex', senderSessionId:'sender', roomId:'room' },
    content:[{ type:'text', text:'sensitive candidate text' }] }
  const events = [entry(0, 'agent/inbox/spliced', { target:'next-turn', start:0, removedCount:0, inserted:[structuredClone(message)] }),
    entry(1, 'turn/start', { turn:5 }, 123456), entry(2, 'agent/inbox/spliced', { target:'next-turn', start:0, removedCount:1, inserted:[] }),
    entry(3, 'user/message', structuredClone(message)), entry(4, 'turn/end', { turn:5, reason:{ kind:'interrupted' } })]
  const session = { id:'source', seq:events.length, header:{ id:'source', version:4 }, inheritedEventCount:0, eventAt:index => events[index] }
  const reader = { id:'source', header:{ ...session.header, delegationDepth:0 }, inheritedEventCount:0,
    read:async () => ({ events:structuredClone(events) }), close:async () => {} }
  const writer = { flushLiveSession:async () => {}, open:async () => reader }
  const record = { botId:'bot', since:123456, roomId:'room', trigger:{ role:'request', exchangeId:'ex', senderSessionId:'sender', roomId:'room' } }
  const statePath = join(home, 'state.json'), state = { version:1 }
  await writeFile(statePath, JSON.stringify(state))
  const rt = { home, statePath, state, requireHomeLock() {}, homeLockVersion:() => generation,
    async save() { await writeFile(statePath, JSON.stringify(state)) },
    recoveryHeldOriginal:async () => ({ sessionId:'source', record, isCurrent:() => current }),
    ctx:{ sessions:{ get:() => session }, get:() => writer } }
  const readCandidate = createLegacyRedoCandidate(rt), target = { cwd:'/work', provider:'p', model:'m' }
  const proof = await readCandidate.inspectEvidence(scope, recoveryId)
  assert.ok(proof)
  const dependencies = { authorize:() => allowed, proveCandidate:(scope_, id_) => readCandidate.inspectEvidence(scope_, id_), validateBinding:() => true }
  const request = { operationId, recoveryId, scope, principal, target, acknowledged:true,
    confirmationDigest:candidateRedoConfirmation(scope, recoveryId, proof, { principal, operationId, target }) }
  return { home, rt, dependencies, request, proof, events, session, record, readCandidate,
    journal:createCandidateRedoJournal(rt, dependencies), current:value => { current = value },
    allowed:value => { allowed = value }, generation:value => { generation = value } }
}

test('records a candidate decision without plaintext, producer claims or dispatch capability', async t => {
  const f = await fixture(t), row = await f.journal.prepare(f.request)
  assert.deepEqual(row.identity, userRedoIdentity(operationId))
  assert.equal(row.original.kind, 'unverified-legacy-candidate')
  assert.equal(row.original.producerVerified, false)
  assert.equal(row.original.messageId, undefined)
  assert.equal(f.journal.beginDispatch, undefined)
  assert.equal(f.journal.markClaimingSync, undefined)
  const disk = await readFile(join(f.home, 'candidate-redo-v1', `${operationId}.json`), 'utf8')
  assert.doesNotMatch(disk, /sensitive candidate text/)
  assert.doesNotMatch(await readFile(f.rt.statePath, 'utf8'), /sensitive candidate text/)
  assert.deepEqual(await createCandidateRedoJournal(f.rt, f.dependencies).prepare(f.request), row)
  await assert.rejects(f.journal.prepare({ ...f.request, operationId:otherId,
    confirmationDigest:candidateRedoConfirmation(scope, recoveryId, f.proof, { principal, operationId:otherId, target:f.request.target }) }), /already exists/)
})

test('rejects fabricated evidence and candidate or target changes after preview', async t => {
  const f = await fixture(t)
  const forged = { ...f.proof, view:{ ...f.proof.view, producerVerified:true } }
  assert.throws(() => candidateRedoConfirmation(scope, recoveryId, forged, { principal, operationId, target:f.request.target }), /unavailable/)
  assert.throws(() => candidateRedoConfirmation(scope, recoveryId, { ...f.proof }, { principal, operationId, target:f.request.target }), /unavailable/)
  await assert.rejects(f.journal.prepare({ ...f.request, target:{ ...f.request.target, model:'changed' } }), /confirmation/)
  f.events[0].data.inserted[0].content[0].text = 'different candidate'
  f.events[3].data.content[0].text = 'different candidate'
  await assert.rejects(f.journal.prepare(f.request), /confirmation/)
})

test('stale writer or revoked scope cannot create a decision', async t => {
  const f = await fixture(t)
  f.current(false)
  await assert.rejects(f.journal.prepare(f.request), /unavailable|changed/)
  f.current(true); f.allowed(false)
  await assert.rejects(f.journal.prepare(f.request), /unavailable/)
  f.allowed(true); f.session.seq++
  await assert.rejects(f.journal.prepare(f.request), /unavailable|changed/)
})

test('cross-mode recovery witness and lease changes prevent duplicate decisions', async t => {
  const f = await fixture(t)
  await f.journal.prepare(f.request)
  const originalProof = { complete:true, durability:'target-writer-v1', recoveryId, botId:'bot', sessionId:'source', turn:5, messageSeq:3,
    message:{ id:'m', role:'user', source:{ kind:'bot', role:'request' }, content:[{ type:'text', text:'untrusted' }] }, isCurrent:() => true }
  const old = createOriginalRedoJournal(f.rt, { authorize:() => true, proveOriginal:async () => originalProof, validateBinding:() => true })
  await assert.rejects(old.prepare({ operationId, recoveryId, scope, principal, acknowledged:true,
    confirmationDigest:userRedoConfirmation(scope, recoveryId, originalProof) }), /unknown|already exists/)
  f.generation(2)
  // A fresh generation may inspect a complete decision but cannot invent a
  // second operation for this same recovery.
  await assert.rejects(createCandidateRedoJournal(f.rt, f.dependencies).prepare({ ...f.request, operationId:otherId,
    confirmationDigest:candidateRedoConfirmation(scope, recoveryId, f.proof, { principal, operationId:otherId, target:f.request.target }) }), /already exists/)
})

test('real team store retains the candidate witness through close and a new store instance', async t => {
  const f = await fixture(t), disposers = []
  const ctx = { logger:{ warn() {} }, effect(fn) { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose) } }
  const makeStore = () => ({ home:f.home, statePath:f.rt.statePath, ctx, autoRoomName:() => 'Room', retitleRoom:async () => {}, warn() {} })
  const first = makeStore()
  installStore(first)
  t.after(async () => { for (const dispose of disposers.splice(0)) await dispose() })
  await first.load(); await first.save({ required:true })
  const saved = await createCandidateRedoJournal(first, f.dependencies).prepare(f.request)
  const state = JSON.parse(await readFile(first.statePath, 'utf8'))
  assert.equal(state.originalRedoWitness[recoveryId].operationId, operationId)
  assert.doesNotMatch(JSON.stringify(state), /sensitive candidate text/)
  for (const dispose of disposers.splice(0)) await dispose()
  const restored = makeStore()
  installStore(restored); await restored.load()
  assert.deepEqual(restored.state.originalRedoWitness, state.originalRedoWitness)
  const journal = createCandidateRedoJournal(restored, f.dependencies)
  assert.deepEqual(await journal.prepare(f.request), saved)
  await assert.rejects(journal.prepare({ ...f.request, operationId:otherId,
    confirmationDigest:candidateRedoConfirmation(scope, recoveryId, f.proof, { principal, operationId:otherId, target:f.request.target }) }), /already exists/)
  assert.equal(journal.beginDispatch, undefined)
})
