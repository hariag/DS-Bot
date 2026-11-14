// Manual integration against the matching isolated Harness WIP. No real user
// proof, admission journal, network, production files or model calls are used.
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import { install as installRedo } from '../../src/host/user-redo-session.mjs'
import { userRedoIdentity } from '../../src/host/user-redo-journal.mjs'
import { createIsolatedRedoSessionFactory } from '../../src/host/user-redo-create.mjs'

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
    current(binding) { return JSON.stringify(binding) === JSON.stringify(captured) } }
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
