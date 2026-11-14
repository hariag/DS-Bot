import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import { createLegacyRedoCandidate } from '../../src/host/user-redo-legacy-candidate.mjs'
import { candidateRedoConfirmation } from '../../src/host/candidate-redo-confirmation.mjs'
import { createCandidateRedoPreparation } from '../../src/host/candidate-redo-preparation.mjs'
import { createIsolatedCandidateRedoJournal, createIsolatedRedoJournal } from '../../src/host/original-redo-journal.mjs'
import { isolatedRedoConfirmation } from '../../src/host/user-redo-journal.mjs'

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'candidate-redo-journal-')); t.after(() => rm(home, { recursive:true, force:true }))
  const recoveryId = 'a'.repeat(64), operationId = 'bb5b1723-7063-4e3e-b27e-12f44dd0033d', scope = { kind:'room', id:'room' }
  const principal = { kind:'user', id:'user' }, target = { cwd:home, provider:'p', model:'m' }
  const msg = { id:'msg', role:'user', source:{ kind:'bot', role:'request', exchangeId:'ex', senderSessionId:'sender', roomId:'room' }, content:[{ type:'text', text:'private candidate' }] }
  const event = (seq, type, data, time) => ({ seq, type, data, ...(time === undefined ? {} : { time }) })
  const events = [event(0,'agent/inbox/spliced',{ target:'next-turn', start:0, removedCount:0, inserted:[msg] }),
    event(1,'turn/start',{ turn:5 },123456), event(2,'agent/inbox/spliced',{ target:'next-turn', start:0, removedCount:1, inserted:[] }),
    event(3,'user/message',msg), event(4,'turn/end',{ turn:5, reason:{ kind:'interrupted' } })]
  const session = { id:'source', seq:events.length, header:{ id:'source', version:4, cwd:home }, inheritedEventCount:0, eventAt:i => events[i] }
  const reader = { id:'source', header:{ ...session.header, delegationDepth:0 }, inheritedEventCount:0,
    read:async () => ({ events:structuredClone(events) }), close:async () => {} }
  const writer = { flushLiveSession:async () => {}, open:async () => reader }
  const record = { botId:'bot', since:123456, roomId:'room', trigger:{ role:'request', exchangeId:'ex', senderSessionId:'sender', roomId:'room' } }
  const statePath = join(home,'state.json'), state = { version:1, bots:{ bot:{ id:'bot' } }, rooms:{ room:{ id:'room', members:['bot'] } } }
  const agent = { id:'source', session, model:{ current:() => ({ provider:'p', model:'m' }) } }
  await writeFile(statePath, JSON.stringify(state))
  let current = true, allowed = true
  const rt = { home, statePath, state, ctx:{ sessions:{ get:id => id === 'source' ? session : undefined }, agents:{ get:id => id === 'source' ? agent : undefined }, get:() => writer },
    requireHomeLock() {}, homeLockVersion:() => 1, async save() { await writeFile(statePath, JSON.stringify(state)) },
    recoveryHeldOriginal:async () => ({ sessionId:'source', record, isCurrent:() => current }) }
  const candidateReader = createLegacyRedoCandidate(rt), evidence = await candidateReader.inspectEvidence(scope,recoveryId)
  const dependencies = { candidateReader, authorize:() => allowed, validateBinding:() => true }
  const journal = createIsolatedCandidateRedoJournal(rt, dependencies)
  const confirmationDigest = candidateRedoConfirmation(scope, recoveryId, evidence, { principal, operationId, target })
  const request = { operationId, recoveryId, scope, principal, target, confirmationDigest, acknowledged:true }
  return { home, rt, record, session, agent, writer, msg, scope, principal, target, recoveryId, operationId, candidateReader, evidence, journal, request,
    setCurrent:v => { current=v }, setAllowed:v => { allowed=v } }
}

test('only the confirmed, explicitly unverified candidate creates one private operation', async t => {
  const f = await fixture(t), row = await f.journal.prepare(f.request)
  assert.equal(row.original.kind, 'unverified-legacy-candidate')
  assert.equal(row.original.producerVerified, false)
  assert.equal(row.original.messageId, 'msg')
  assert.doesNotMatch(await readFile(join(f.home,'candidate-isolated-redo-v1',`${f.operationId}.json`),'utf8'), /private candidate/)
  const dispatch = await f.journal.beginDispatch(f.operationId, f.principal)
  assert.equal(dispatch.perform,true)
  assert.equal((await f.journal.beginDispatch(f.operationId, f.principal)).state,'unknown')
})

test('rejects forged reader, changed authorization, stale evidence and changed confirmation', async t => {
  const f = await fixture(t)
  assert.throws(() => createIsolatedCandidateRedoJournal(f.rt, { candidateReader:Object.assign(async () => f.evidence,{ inspectEvidence:async () => f.evidence }), authorize:() => true, validateBinding:() => true }), /reader/)
  await assert.rejects(f.journal.prepare({ ...f.request, confirmationDigest:'b'.repeat(64) }), /confirmation/)
  f.setAllowed(false); await assert.rejects(f.journal.prepare(f.request), /unavailable/)
  f.setAllowed(true); f.setCurrent(false); await assert.rejects(f.journal.prepare(f.request), /unavailable|candidate/)
})


test('candidate and verified domains cannot dispatch the same recovery twice', async t => {
  const f = await fixture(t); await f.journal.prepare(f.request)
  const proof = { complete:true, durability:'target-writer-v1', recoveryId:f.recoveryId, botId:'bot', sessionId:'source', turn:5, messageSeq:3,
    message:{ id:'msg', role:'user', source:{ kind:'bot' }, content:[{ type:'text', text:'private candidate' }] }, isCurrent:() => true }
  const original = createIsolatedRedoJournal(f.rt, { authorize:() => true, proveOriginal:async () => proof, validateBinding:() => true })
  const operationId = 'c2a7ed5e-3b37-4a48-bb72-3d82f9d8c454'
  const confirmationDigest = isolatedRedoConfirmation(f.scope, f.recoveryId, proof, { principal:f.principal, operationId, target:f.target })
  await assert.rejects(original.prepare({ ...f.request, operationId, confirmationDigest }), /unknown|already exists/)
})


test('changed candidate text cannot be dispatched under the old confirmation', async t => {
  const f = await fixture(t); await f.journal.prepare(f.request)
  f.msg.content[0].text = 'changed task'
  await assert.rejects(f.journal.beginDispatch(f.operationId, f.principal), /confirmation|changed|unavailable/)
})

test('verified and candidate domains cannot reuse an existing recovery in either order', async t => {
  const f = await fixture(t)
  const proof = { complete:true, durability:'target-writer-v1', recoveryId:f.recoveryId, botId:'bot', sessionId:'source', turn:5, messageSeq:3,
    message:{ id:'msg', role:'user', source:{ kind:'bot' }, content:[{ type:'text', text:'private candidate' }] }, isCurrent:() => true }
  const verified = createIsolatedRedoJournal(f.rt, { authorize:() => true, proveOriginal:async () => proof, validateBinding:() => true })
  const otherId = 'c2a7ed5e-3b37-4a48-bb72-3d82f9d8c454'
  const digest = isolatedRedoConfirmation(f.scope, f.recoveryId, proof, { principal:f.principal, operationId:otherId, target:f.target })
  await verified.prepare({ ...f.request, operationId:otherId, confirmationDigest:digest })
  await assert.rejects(f.journal.prepare(f.request), /unknown|already exists/)
})


test('owner sees a bound candidate and must confirm the unchanged target', async t => {
  const f = await fixture(t), authority = createCandidateRedoPreparation(f.rt, { candidateReader:f.candidateReader, journal:f.journal })
  const input = { scope:f.scope, recoveryId:f.recoveryId, operationId:f.operationId, principal:f.principal }
  await assert.rejects(authority.preview({ ...input, principal:{ kind:'bot', id:'bot' } }), /unavailable/)
  const preview = await authority.preview(input)
  assert.equal(preview.candidate.producerVerified, false)
  assert.deepEqual(preview.candidate.textSegments, ['private candidate'])
  assert.equal(preview.execution, 'disabled')
  assert.equal(f.rt.state.originalRedoWitness, undefined)
  await assert.rejects(authority.prepare({ ...input, acknowledged:false, confirmationDigest:preview.confirmationDigest }), /required/)
  f.agent.model.current = () => ({ provider:'p', model:'changed' })
  await assert.rejects(authority.prepare({ ...input, acknowledged:true, confirmationDigest:preview.confirmationDigest }), /confirmation changed/)
  assert.equal(f.rt.state.originalRedoWitness, undefined)
  f.agent.model.current = () => ({ provider:'p', model:'m' })
  f.rt.state.rooms.room.members.length = 0
  await assert.rejects(authority.prepare({ ...input, acknowledged:true, confirmationDigest:preview.confirmationDigest }), /unavailable/)
  assert.equal(f.rt.state.originalRedoWitness, undefined)
  f.rt.state.rooms.room.members.push('bot')
  assert.deepEqual(await authority.prepare({ ...input, acknowledged:true, confirmationDigest:preview.confirmationDigest }),
    { operationId:f.operationId, state:'prepared', execution:'disabled' })
  assert.doesNotMatch(await readFile(f.rt.statePath, 'utf8'), /private candidate/)
})


test('preview snapshots user scope and principal before awaiting the writer', async t => {
  const f = await fixture(t), authority = createCandidateRedoPreparation(f.rt, { candidateReader:f.candidateReader, journal:f.journal })
  const started = Promise.withResolvers(), resume = Promise.withResolvers()
  f.writer.flushLiveSession = async () => { started.resolve(); await resume.promise }
  const input = { scope:{ ...f.scope }, recoveryId:f.recoveryId, operationId:f.operationId, principal:{ ...f.principal } }
  const pending = authority.preview(input); await started.promise
  input.scope.id = 'other'; input.principal.kind = 'bot'; input.operationId = 'invalid'
  resume.resolve()
  const preview = await pending
  assert.deepEqual(preview.scope, f.scope)
  assert.equal(preview.operationId, f.operationId)
  assert.equal(preview.candidate.producerVerified, false)
  assert.equal(f.rt.state.originalRedoWitness, undefined)
})


test('preview fails if evidence callback replaces the current Agent', async t => {
  const f = await fixture(t); let hijack = false
  f.agent.model.current = () => { hijack = true; return { provider:'p', model:'m' } }
  f.rt.recoveryHeldOriginal = async () => ({ sessionId:'source', record:f.record, isCurrent:() => {
    if (hijack) f.rt.ctx.agents.get = () => ({ id:'source', session:f.session })
    return true
  } })
  const authority = createCandidateRedoPreparation(f.rt, { candidateReader:f.candidateReader, journal:f.journal })
  await assert.rejects(authority.preview({ scope:f.scope, recoveryId:f.recoveryId, operationId:f.operationId, principal:f.principal }), /unavailable|changed/)
  assert.equal(f.rt.state.originalRedoWitness, undefined)
})
