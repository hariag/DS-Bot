// Synthetic real Agent/JSONL/journal integration. Authentication and original
// source are fixtures; no real user operation, tool execution or network.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { install as installRedo } from '../../src/host/user-redo-session.mjs'
import { isolatedRedoConfirmation, userRedoIdentity } from '../../src/host/user-redo-journal.mjs'
import { createIsolatedRedoSessionFactory } from '../../src/host/user-redo-create.mjs'
import { createIsolatedRedoCreationFence } from '../../src/host/user-redo-create-fence.mjs'
import { createIsolatedRedoJournal, createIsolatedCandidateRedoJournal } from '../../src/host/original-redo-journal.mjs'
import { createLegacyRedoCandidate } from '../../src/host/user-redo-legacy-candidate.mjs'
import { candidateRedoConfirmation } from '../../src/host/candidate-redo-confirmation.mjs'
import { createIsolatedRedoCoordinator } from '../../src/host/isolated-redo-coordinator.mjs'
import { captureGuardedRedoResult } from '../../src/host/guarded-redo-result.mjs'

class Adapter extends LlmAdapter {
  requests = []
  async resolveModel(provider, model) { return { provider, id:model, name:model } }
  async *stream(options) {
    this.requests.push(options)
    yield { type:'block-start', index:0, blockType:'text' }
    yield { type:'text-delta', index:0, text:'synthetic result' }
    yield { type:'block-end', index:0, block:{ type:'text', text:'synthetic result' } }
    yield { type:'finish', reason:{ kind:'stop' } }
  }
}
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b)

test('real journal, isolated Agent and writer fence one synthetic request and result', async t => {
  const home = await mkdtemp(join(tmpdir(), 'isolated-redo-coordinator-')), ctx = new Context(), adapter = new Adapter()
  t.after(async () => { await ctx.fiber.dispose(); await rm(home, { recursive:true, force:true }) })
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(Jsonl, { root:join(home, 'sessions'), compression:'none' })
  ctx.llm.registerAdapter(['redo-model'], adapter)
  const operationId = 'bb5b1723-7063-4e3e-b27e-12f44dd0033d', recoveryId = 'a'.repeat(64)
  const identity = userRedoIdentity(operationId), principal = { kind:'user', id:'user' }, scope = { kind:'room', id:'r' }
  const bot = { id:'b' }, room = { id:'r', members:['b'] }, statePath = join(home, 'state.json'), state = { version:1 }
  await writeFile(statePath, JSON.stringify(state))
  const rt = { ctx, home, statePath, state, botOf:id => id === 'b' ? bot : undefined,
    roomOf:id => id === 'r' ? room : undefined, selfOf:() => undefined, agentOf:() => undefined,
    chatOwners:new Map(), groupOwners:new Map(), pastOwners:new Map(), requireHomeLock() {}, homeLockVersion:() => 1,
    async save() { await writeFile(statePath, JSON.stringify(state)) } }
  installRedo(rt)
  const original = { id:'source', role:'user', source:{ kind:'bot', role:'request' }, content:[{ type:'text', text:'synthetic task' }] }
  const proof = { complete:true, durability:'target-writer-v1', recoveryId, botId:'b', sessionId:'original', messageSeq:3, turn:1,
    message:original, isCurrent:() => true }
  const target = { cwd:home, provider:'redo-model', model:'mock' }
  const input = { ...createUserMessage({ content:original.content, source:{ kind:'ds-bot-user-redo' } }), id:identity.messageId }
  let agent
  const dependencies = { authorize:(gotScope, id, who) => equal(gotScope, scope) && id === recoveryId && equal(who, principal) && room.members.includes('b'),
    proveOriginal:async () => proof, validateBinding:row => equal(row.target, target) && room.members.includes(row.original.botId),
    verifyResult:async row => captureGuardedRedoResult({ ctx, session:agent.session, input, admissionId:identity.admissionId,
      turn:row.turn, isCurrent:() => room.members.includes('b') }) }
  const journal = createIsolatedRedoJournal(rt, dependencies)
  const confirmationDigest = isolatedRedoConfirmation(scope, recoveryId, proof, { principal, operationId, target })
  await journal.prepare({ operationId, recoveryId, scope, principal, target, acknowledged:true, confirmationDigest })
  const provider = await ctx.agents.registerGuardedClaimProvider(current => {
    if (current.id !== identity.sessionId) return undefined
    const binding = rt.userRedoBinding(identity.sessionId)
    return createIsolatedRedoCoordinator(rt, { agent:current, journal, binding, principal, originalMessage:original, message:input })
  })
  await mountAgentLoopTestHarness(ctx)
  const create = createIsolatedRedoSessionFactory(rt, createIsolatedRedoCreationFence(rt, journal, principal))
  const made = await create({ operationId, ...target })
  assert.equal(made.state, 'ready')
  agent = made.handle.agent
  await agent.guardedSend(input, 'next-turn', identity.admissionId)
  await agent.whenIdle()
  assert.equal(adapter.requests.length, 1)
  assert.equal((adapter.requests[0].tools ?? []).length, 0)
  const result = await journal.recordResult(operationId, principal)
  assert.equal(result.state, 'completed')
  assert.equal((await journal.beginDispatch(operationId, principal)).state, 'unknown')
  assert.doesNotMatch(await readFile(join(home, 'isolated-redo-v1', `${operationId}.json`), 'utf8'), /synthetic task|synthetic result/)
  provider()
  await made.handle.dispose()
})

test('revoked group membership blocks a real Agent before model invocation', async t => {
  const home = await mkdtemp(join(tmpdir(), 'isolated-redo-coordinator-')), ctx = new Context(), adapter = new Adapter()
  t.after(async () => { await ctx.fiber.dispose(); await rm(home, { recursive:true, force:true }) })
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(Jsonl, { root:join(home, 'sessions'), compression:'none' })
  ctx.llm.registerAdapter(['redo-model'], adapter)
  const operationId = 'bb5b1723-7063-4e3e-b27e-12f44dd0033d', recoveryId = 'a'.repeat(64)
  const identity = userRedoIdentity(operationId), principal = { kind:'user', id:'user' }, scope = { kind:'room', id:'r' }
  const bot = { id:'b' }, room = { id:'r', members:['b'] }, statePath = join(home, 'state.json'), state = { version:1 }
  await writeFile(statePath, JSON.stringify(state))
  const rt = { ctx, home, statePath, state, botOf:id => id === 'b' ? bot : undefined,
    roomOf:id => id === 'r' ? room : undefined, selfOf:() => undefined, agentOf:() => undefined,
    chatOwners:new Map(), groupOwners:new Map(), pastOwners:new Map(), requireHomeLock() {}, homeLockVersion:() => 1,
    async save() { await writeFile(statePath, JSON.stringify(state)) } }
  installRedo(rt)
  const original = { id:'source', role:'user', source:{ kind:'bot', role:'request' }, content:[{ type:'text', text:'synthetic task' }] }
  const proof = { complete:true, durability:'target-writer-v1', recoveryId, botId:'b', sessionId:'original', messageSeq:3, turn:1,
    message:original, isCurrent:() => true }
  const target = { cwd:home, provider:'redo-model', model:'mock' }
  const input = { ...createUserMessage({ content:original.content, source:{ kind:'ds-bot-user-redo' } }), id:identity.messageId }
  let agent
  const dependencies = { authorize:(gotScope, id, who) => equal(gotScope, scope) && id === recoveryId && equal(who, principal) && room.members.includes('b'),
    proveOriginal:async () => proof, validateBinding:row => equal(row.target, target) && room.members.includes(row.original.botId),
    verifyResult:async row => captureGuardedRedoResult({ ctx, session:agent.session, input, admissionId:identity.admissionId,
      turn:row.turn, isCurrent:() => room.members.includes('b') }) }
  const journal = createIsolatedRedoJournal(rt, dependencies)
  const confirmationDigest = isolatedRedoConfirmation(scope, recoveryId, proof, { principal, operationId, target })
  await journal.prepare({ operationId, recoveryId, scope, principal, target, acknowledged:true, confirmationDigest })
  const provider = await ctx.agents.registerGuardedClaimProvider(current => {
    if (current.id !== identity.sessionId) return undefined
    const binding = rt.userRedoBinding(identity.sessionId)
    return createIsolatedRedoCoordinator(rt, { agent:current, journal, binding, principal, originalMessage:original, message:input })
  })
  await mountAgentLoopTestHarness(ctx)
  const create = createIsolatedRedoSessionFactory(rt, createIsolatedRedoCreationFence(rt, journal, principal))
  const made = await create({ operationId, ...target })
  assert.equal(made.state, 'ready')
  agent = made.handle.agent
  ctx.on('session/event', (subject, event) => { if (subject === agent.session && event.type === 'turn/start') room.members.length = 0 })
  await agent.guardedSend(input, 'next-turn', identity.admissionId)
  await agent.whenIdle()
  assert.equal(adapter.requests.length, 0)
  await assert.rejects(journal.beginDispatch(operationId, principal), /unavailable/)
  room.members.push('b')
  assert.equal((await journal.beginDispatch(operationId, principal)).state, 'unknown')
  provider()
  await made.handle.dispose()
})

test('a lost durable claim response remains unknown after journal reconstruction', async t => {
  const home = await mkdtemp(join(tmpdir(), 'isolated-redo-coordinator-')), ctx = new Context(), adapter = new Adapter()
  t.after(async () => { await ctx.fiber.dispose(); await rm(home, { recursive:true, force:true }) })
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(Jsonl, { root:join(home, 'sessions'), compression:'none' })
  ctx.llm.registerAdapter(['redo-model'], adapter)
  const operationId = 'bb5b1723-7063-4e3e-b27e-12f44dd0033d', recoveryId = 'a'.repeat(64)
  const identity = userRedoIdentity(operationId), principal = { kind:'user', id:'user' }, scope = { kind:'room', id:'r' }
  const bot = { id:'b' }, room = { id:'r', members:['b'] }, statePath = join(home, 'state.json'), state = { version:1 }
  await writeFile(statePath, JSON.stringify(state))
  const rt = { ctx, home, statePath, state, botOf:id => id === 'b' ? bot : undefined,
    roomOf:id => id === 'r' ? room : undefined, selfOf:() => undefined, agentOf:() => undefined,
    chatOwners:new Map(), groupOwners:new Map(), pastOwners:new Map(), requireHomeLock() {}, homeLockVersion:() => 1,
    async save() { await writeFile(statePath, JSON.stringify(state)) } }
  installRedo(rt)
  const original = { id:'source', role:'user', source:{ kind:'bot', role:'request' }, content:[{ type:'text', text:'synthetic task' }] }
  const proof = { complete:true, durability:'target-writer-v1', recoveryId, botId:'b', sessionId:'original', messageSeq:3, turn:1,
    message:original, isCurrent:() => true }
  const target = { cwd:home, provider:'redo-model', model:'mock' }
  const input = { ...createUserMessage({ content:original.content, source:{ kind:'ds-bot-user-redo' } }), id:identity.messageId }
  let agent
  const dependencies = { authorize:(gotScope, id, who) => equal(gotScope, scope) && id === recoveryId && equal(who, principal) && room.members.includes('b'),
    proveOriginal:async () => proof, validateBinding:row => equal(row.target, target) && room.members.includes(row.original.botId),
    verifyResult:async row => captureGuardedRedoResult({ ctx, session:agent.session, input, admissionId:identity.admissionId,
      turn:row.turn, isCurrent:() => room.members.includes('b') }) }
  const journal = createIsolatedRedoJournal(rt, dependencies)
  const confirmationDigest = isolatedRedoConfirmation(scope, recoveryId, proof, { principal, operationId, target })
  await journal.prepare({ operationId, recoveryId, scope, principal, target, acknowledged:true, confirmationDigest })
  const failingJournal = { ...journal, markClaimingSync(...args) { journal.markClaimingSync(...args); throw Error('simulated lost claim response') } }
  const provider = await ctx.agents.registerGuardedClaimProvider(current => {
    if (current.id !== identity.sessionId) return undefined
    const binding = rt.userRedoBinding(identity.sessionId)
    return createIsolatedRedoCoordinator(rt, { agent:current, journal:failingJournal, binding, principal, originalMessage:original, message:input })
  })
  await mountAgentLoopTestHarness(ctx)
  const create = createIsolatedRedoSessionFactory(rt, createIsolatedRedoCreationFence(rt, journal, principal))
  const made = await create({ operationId, ...target })
  assert.equal(made.state, 'ready')
  agent = made.handle.agent
  await agent.guardedSend(input, 'next-turn', identity.admissionId)
  await agent.whenIdle()
  assert.equal(adapter.requests.length, 0)
  const afterRestart = { ...rt, state:JSON.parse(await readFile(statePath, 'utf8')) }
  const restored = createIsolatedRedoJournal(afterRestart, dependencies)
  assert.equal((await restored.beginDispatch(operationId, principal)).state, 'unknown')
  provider()
  await made.handle.dispose()
})

test('unverified time-matched candidate starts one isolated synthetic operation', async t => {
  const home = await mkdtemp(join(tmpdir(), 'isolated-redo-coordinator-')), ctx = new Context(), adapter = new Adapter()
  t.after(async () => { await ctx.fiber.dispose(); await rm(home, { recursive:true, force:true }) })
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(Jsonl, { root:join(home, 'sessions'), compression:'none' })
  ctx.llm.registerAdapter(['redo-model'], adapter)
  const operationId = 'bb5b1723-7063-4e3e-b27e-12f44dd0033d', recoveryId = 'a'.repeat(64)
  const identity = userRedoIdentity(operationId), principal = { kind:'user', id:'user' }, scope = { kind:'room', id:'r' }
  const bot = { id:'b' }, room = { id:'r', members:['b'] }, statePath = join(home, 'state.json'), state = { version:1 }
  await writeFile(statePath, JSON.stringify(state))
  const rt = { ctx, home, statePath, state, botOf:id => id === 'b' ? bot : undefined,
    roomOf:id => id === 'r' ? room : undefined, selfOf:() => undefined, agentOf:() => undefined,
    chatOwners:new Map(), groupOwners:new Map(), pastOwners:new Map(), requireHomeLock() {}, homeLockVersion:() => 1,
    async save() { await writeFile(statePath, JSON.stringify(state)) } }
  installRedo(rt)
  const source = ctx.sessions.create(SessionId('original'))
  await ctx.sessionPersistence.create(source.header, { inheritedEventCount:source.inheritedEventCount })
  const original = createUserMessage({ content:[{ type:'text', text:'synthetic task' }],
    source:{ kind:'bot', role:'request', exchangeId:'exchange', senderSessionId:'sender', roomId:'r' } })
  source.append('agent/inbox/spliced', { target:'next-turn', start:0, inserted:[original] })
  source.append('turn/start', { turn:1 })
  source.append('agent/inbox/spliced', { target:'next-turn', start:0, removedCount:1, inserted:[] })
  source.append('user/message', original, { surfaceOp:'append' })
  source.append('turn/end', { turn:1, reason:{ kind:'interrupted' } })
  const held = { botId:'b', since:source.eventAt(1).time, roomId:'r',
    trigger:{ role:'request', exchangeId:'exchange', senderSessionId:'sender', roomId:'r' } }
  rt.recoveryHeldOriginal = async () => ({ sessionId:'original', record:held, isCurrent:() => ctx.sessions.get('original') === source })
  const candidateReader = createLegacyRedoCandidate(rt), evidence = await candidateReader.inspectEvidence(scope, recoveryId)
  assert.equal(evidence.view.producerVerified, false)
  const target = { cwd:home, provider:'redo-model', model:'mock' }
  const input = { ...createUserMessage({ content:original.content, source:{ kind:'ds-bot-user-redo' } }), id:identity.messageId }
  let agent
  const dependencies = { authorize:(gotScope, id, who) => equal(gotScope, scope) && id === recoveryId && equal(who, principal) && room.members.includes('b'),
    validateBinding:row => equal(row.target, target) && room.members.includes(row.original.botId),
    verifyResult:async row => captureGuardedRedoResult({ ctx, session:agent.session, input, admissionId:identity.admissionId,
      turn:row.turn, isCurrent:() => room.members.includes('b') }) }
  const journal = createIsolatedCandidateRedoJournal(rt, { ...dependencies, candidateReader })
  const confirmationDigest = candidateRedoConfirmation(scope, recoveryId, evidence, { principal, operationId, target })
  await journal.prepare({ operationId, recoveryId, scope, principal, target, acknowledged:true, confirmationDigest })
  const provider = await ctx.agents.registerGuardedClaimProvider(current => {
    if (current.id !== identity.sessionId) return undefined
    const binding = rt.userRedoBinding(identity.sessionId)
    return createIsolatedRedoCoordinator(rt, { agent:current, journal, binding, principal, originalMessage:original, message:input })
  })
  await mountAgentLoopTestHarness(ctx)
  const create = createIsolatedRedoSessionFactory(rt, createIsolatedRedoCreationFence(rt, journal, principal))
  const made = await create({ operationId, ...target })
  assert.equal(made.state, 'ready')
  agent = made.handle.agent
  await agent.guardedSend(input, 'next-turn', identity.admissionId)
  await agent.whenIdle()
  assert.equal(adapter.requests.length, 1)
  assert.equal((adapter.requests[0].tools ?? []).length, 0)
  const result = await journal.recordResult(operationId, principal)
  assert.equal(result.state, 'completed')
  assert.equal(JSON.parse(await readFile(join(home, 'candidate-isolated-redo-v1', `${operationId}.json`), 'utf8')).original.producerVerified, false)
  assert.equal((await journal.beginDispatch(operationId, principal)).state, 'unknown')
  assert.doesNotMatch(await readFile(join(home, 'candidate-isolated-redo-v1', `${operationId}.json`), 'utf8'), /synthetic task|synthetic result/)
  provider()
  await made.handle.dispose()
})

test('candidate operation fails closed if group access is revoked before claim', async t => {
  const home = await mkdtemp(join(tmpdir(), 'isolated-redo-coordinator-')), ctx = new Context(), adapter = new Adapter()
  t.after(async () => { await ctx.fiber.dispose(); await rm(home, { recursive:true, force:true }) })
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(Jsonl, { root:join(home, 'sessions'), compression:'none' })
  ctx.llm.registerAdapter(['redo-model'], adapter)
  const operationId = 'bb5b1723-7063-4e3e-b27e-12f44dd0033d', recoveryId = 'a'.repeat(64)
  const identity = userRedoIdentity(operationId), principal = { kind:'user', id:'user' }, scope = { kind:'room', id:'r' }
  const bot = { id:'b' }, room = { id:'r', members:['b'] }, statePath = join(home, 'state.json'), state = { version:1 }
  await writeFile(statePath, JSON.stringify(state))
  const rt = { ctx, home, statePath, state, botOf:id => id === 'b' ? bot : undefined,
    roomOf:id => id === 'r' ? room : undefined, selfOf:() => undefined, agentOf:() => undefined,
    chatOwners:new Map(), groupOwners:new Map(), pastOwners:new Map(), requireHomeLock() {}, homeLockVersion:() => 1,
    async save() { await writeFile(statePath, JSON.stringify(state)) } }
  installRedo(rt)
  const source = ctx.sessions.create(SessionId('original'))
  await ctx.sessionPersistence.create(source.header, { inheritedEventCount:source.inheritedEventCount })
  const original = createUserMessage({ content:[{ type:'text', text:'synthetic task' }],
    source:{ kind:'bot', role:'request', exchangeId:'exchange', senderSessionId:'sender', roomId:'r' } })
  source.append('agent/inbox/spliced', { target:'next-turn', start:0, inserted:[original] })
  source.append('turn/start', { turn:1 })
  source.append('agent/inbox/spliced', { target:'next-turn', start:0, removedCount:1, inserted:[] })
  source.append('user/message', original, { surfaceOp:'append' })
  source.append('turn/end', { turn:1, reason:{ kind:'interrupted' } })
  const held = { botId:'b', since:source.eventAt(1).time, roomId:'r',
    trigger:{ role:'request', exchangeId:'exchange', senderSessionId:'sender', roomId:'r' } }
  rt.recoveryHeldOriginal = async () => ({ sessionId:'original', record:held, isCurrent:() => ctx.sessions.get('original') === source })
  const candidateReader = createLegacyRedoCandidate(rt), evidence = await candidateReader.inspectEvidence(scope, recoveryId)
  assert.equal(evidence.view.producerVerified, false)
  const target = { cwd:home, provider:'redo-model', model:'mock' }
  const input = { ...createUserMessage({ content:original.content, source:{ kind:'ds-bot-user-redo' } }), id:identity.messageId }
  let agent
  const dependencies = { authorize:(gotScope, id, who) => equal(gotScope, scope) && id === recoveryId && equal(who, principal) && room.members.includes('b'),
    validateBinding:row => equal(row.target, target) && room.members.includes(row.original.botId),
    verifyResult:async row => captureGuardedRedoResult({ ctx, session:agent.session, input, admissionId:identity.admissionId,
      turn:row.turn, isCurrent:() => room.members.includes('b') }) }
  const journal = createIsolatedCandidateRedoJournal(rt, { ...dependencies, candidateReader })
  const confirmationDigest = candidateRedoConfirmation(scope, recoveryId, evidence, { principal, operationId, target })
  await journal.prepare({ operationId, recoveryId, scope, principal, target, acknowledged:true, confirmationDigest })
  const provider = await ctx.agents.registerGuardedClaimProvider(current => {
    if (current.id !== identity.sessionId) return undefined
    const binding = rt.userRedoBinding(identity.sessionId)
    return createIsolatedRedoCoordinator(rt, { agent:current, journal, binding, principal, originalMessage:original, message:input })
  })
  await mountAgentLoopTestHarness(ctx)
  const create = createIsolatedRedoSessionFactory(rt, createIsolatedRedoCreationFence(rt, journal, principal))
  const made = await create({ operationId, ...target })
  assert.equal(made.state, 'ready')
  agent = made.handle.agent
  ctx.on('session/event', (subject, event) => { if (subject === agent.session && event.type === 'turn/start') room.members.length = 0 })
  await agent.guardedSend(input, 'next-turn', identity.admissionId)
  await agent.whenIdle()
  assert.equal(adapter.requests.length, 0)
  await assert.rejects(journal.beginDispatch(operationId, principal), /unavailable/)
  room.members.push('b')
  assert.equal((await journal.beginDispatch(operationId, principal)).state, 'unknown')
  provider()
  await made.handle.dispose()
})
