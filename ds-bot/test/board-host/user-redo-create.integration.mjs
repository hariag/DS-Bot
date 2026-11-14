// Manual integration against the matching isolated Harness WIP. No real user
// proof, admission journal, network, production files or model calls are used.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import { install as installRedo } from '../../src/host/user-redo-session.mjs'
import { userRedoConfirmation, userRedoIdentity } from '../../src/host/user-redo-journal.mjs'
import { createIsolatedRedoSessionFactory } from '../../src/host/user-redo-create.mjs'
import { createIsolatedRedoCreationFence } from '../../src/host/user-redo-create-fence.mjs'
import { createIsolatedRedoJournal, createOriginalRedoJournal } from '../../src/host/original-redo-journal.mjs'

test('reserved session creation materializes its actual writer and never retries an operation', async t => {
  const home = await mkdtemp(join(tmpdir(), 'isolated-redo-test-'))
  const ctx = new Context()
  t.after(async () => { await ctx.fiber.dispose(); await rm(home, { recursive:true, force:true }) })
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(Jsonl, { root:join(home, 'sessions'), compression:'none' })
  const operationId = 'bb5b1723-7063-4e3e-b27e-12f44dd0033d', identity = userRedoIdentity(operationId)
  const bot = { id:'b' }, room = { id:'r', members:['b'] }
  const row = { operationId, identity, original:{ botId:'b' }, scope:{ kind:'room', id:'r' },
    recoveryId:'a'.repeat(64), confirmationDigest:'b'.repeat(64), acknowledged:true }
  const rt = { ctx, state:{ userRedos:{ [operationId]:row } }, botOf:id => id === 'b' ? bot : undefined,
    roomOf:id => id === 'r' ? room : undefined, selfOf:() => undefined, agentOf:() => undefined,
    chatOwners:new Map(), groupOwners:new Map(), pastOwners:new Map() }
  installRedo(rt)
  await mountAgentLoopTestHarness(ctx)
  let claimed = 0, captured
  // This is a fake fence only. A real, durable fence and authenticated
  // caller are requirements for exposing any user-facing operation.
  const fence = { async begin(binding) { claimed++; captured = binding; return true },
    current(binding) { return Object.entries(captured).every(([key, value]) => binding[key] === value) } }
  const create = createIsolatedRedoSessionFactory(rt, fence)
  const params = { operationId, cwd:home, provider:'mock', model:'mock' }
  const [first, second] = await Promise.all([create(params), create(params)])
  assert.equal(first.state, 'ready')
  assert.equal(first.sessionId, identity.sessionId)
  assert.equal(second.state, 'unknown')
  assert.equal(claimed, 1)
  assert.equal((await create(params)).state, 'unknown')
  assert.equal(ctx.agents.get(identity.sessionId), first.handle.agent)
  assert.equal(ctx.sessions.get(identity.sessionId), first.handle.agent.session)
  await first.handle.dispose()
  // A new read after disposal must open the materialized persisted header.
  const reader = await ctx.sessionPersistence.open(identity.sessionId, 'read')
  assert.equal(reader.header.id, identity.sessionId)
  assert.equal(reader.header.cwd, home)
  await reader.close()
})

test('real dual-domain journal reserves one fixed isolated Session without admitting work', async t => {
  const home = await mkdtemp(join(tmpdir(), 'isolated-redo-journal-'))
  const ctx = new Context()
  t.after(async () => { await ctx.fiber.dispose(); await rm(home, { recursive:true, force:true }) })
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(Jsonl, { root:join(home, 'sessions'), compression:'none' })
  const operationId = 'bb5b1723-7063-4e3e-b27e-12f44dd0033d', recoveryId = 'a'.repeat(64)
  const identity = userRedoIdentity(operationId), principal = { kind:'user', id:'user' }, scope = { kind:'room', id:'r' }
  const bot = { id:'b' }, room = { id:'r', members:['b'] }, statePath = join(home, 'state.json'), state = { version:1 }
  await writeFile(statePath, JSON.stringify(state))
  const rt = { ctx, home, statePath, state, botOf:id => id === 'b' ? bot : undefined,
    roomOf:id => id === 'r' ? room : undefined, selfOf:() => undefined, agentOf:() => undefined,
    chatOwners:new Map(), groupOwners:new Map(), pastOwners:new Map(),
    requireHomeLock() {}, homeLockVersion:() => 1,
    async save() { await writeFile(statePath, JSON.stringify(state)) } }
  installRedo(rt)
  await mountAgentLoopTestHarness(ctx)
  // Both user authentication and original-event proof are explicit fixtures;
  // the actual dual-domain journal, file fsync and Session writer are real.
  const proof = { complete:true, durability:'target-writer-v1', recoveryId, botId:'b', sessionId:'original', messageSeq:3, turn:1,
    message:{ id:'source', role:'user', source:{ kind:'bot', role:'request' }, content:[{ type:'text', text:'not persisted in journal' }] },
    isCurrent:() => true }
  const target = { cwd:home, provider:'mock', model:'mock' }
  const dependencies = { authorize:(gotScope, gotRecovery, gotPrincipal) => isEqual(gotScope, scope) && gotRecovery === recoveryId && isEqual(gotPrincipal, principal),
    proveOriginal:async () => proof, validateBinding:row => isEqual(row.target, target) && room.members.includes(row.original.botId) }
  const journal = createIsolatedRedoJournal(rt, dependencies)
  const request = { operationId, recoveryId, scope, principal, target, acknowledged:true, confirmationDigest:userRedoConfirmation(scope, recoveryId, proof) }
  const prepared = await journal.prepare(request)
  assert.deepEqual(prepared.identity, identity)
  await assert.rejects(createOriginalRedoJournal(rt, dependencies).prepare({ ...request, target:undefined }), /unknown|already exists/)
  await assert.rejects(journal.prepare({ ...request, target:{ ...target, cwd:'/different' } }), /conflict/)
  const fence = createIsolatedRedoCreationFence(rt, journal, principal)
  const create = createIsolatedRedoSessionFactory(rt, fence)
  const first = await create({ operationId, ...target })
  assert.equal(first.state, 'ready')
  const privateText = await readFile(join(home, 'isolated-redo-v1', `${operationId}.json`), 'utf8')
  const record = JSON.parse(privateText)
  assert.equal(record.state, 'dispatching')
  assert.equal(record.identity.sessionId, identity.sessionId)
  assert.deepEqual(record.target, target)
  assert.doesNotMatch(privateText, /not persisted in journal/)
  assert.equal(first.handle.agent.session.seq, first.through)
  assert.deepEqual(await create({ operationId, ...target }), { state:'unknown' })
  await first.handle.dispose()
  rt.userRedoTransient.clear()
  assert.equal(rt.userRedoOwner(identity.sessionId), undefined)
  const restarted = createIsolatedRedoJournal(rt, dependencies)
  assert.deepEqual(await restarted.beginDispatch(operationId, principal), { operationId, state:'unknown' })
  const reader = await ctx.sessionPersistence.open(identity.sessionId, 'read')
  assert.equal(reader.header.id, identity.sessionId)
  await reader.close()
})

const isEqual = (left, right) => JSON.stringify(left) === JSON.stringify(right)
