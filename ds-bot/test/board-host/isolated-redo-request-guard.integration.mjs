// Synthetic isolated run. This does not install a production provider or send a user task.
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createIsolatedRedoRequestGuard } from '../../src/host/isolated-redo-request-guard.mjs'

class Adapter extends LlmAdapter {
  requests = []
  async resolveModel(provider, model) { return { provider, id:model, name:model } }
  async *stream(options) {
    this.requests.push(options)
    yield { type:'block-start', index:0, blockType:'text' }
    yield { type:'text-delta', index:0, text:'done' }
    yield { type:'block-end', index:0, block:{ type:'text', text:'done' } }
    yield { type:'finish', reason:{ kind:'stop' } }
  }
}

test('real guarded Agent checks isolated request before invoking the mock model', async t => {
  const home = await mkdtemp(join(tmpdir(), 'ds-bot-request-boundary-'))
  const ctx = new Context(), adapter = new Adapter()
  t.after(async () => { await ctx.fiber.dispose(); await rm(home, { recursive:true, force:true }) })
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(Jsonl, { root:join(home, 'sessions'), compression:'none' })
  ctx.llm.registerAdapter(['boundary-test'], adapter)
  const expected = createUserMessage({ content:[{ type:'text', text:'synthetic task' }], source:{ kind:'ds-bot-user-redo' } })
  const rt = { ctx, requireHomeLock() {}, homeLockVersion:() => 1 }
  let checked = 0
  const release = await ctx.agents.registerGuardedClaimProvider(agent => {
    const guard = createIsolatedRedoRequestGuard(rt, { agent, expectedMessage:expected,
      target:{ provider:'boundary-test', model:'mock' }, isCurrent:() => true })
    return Object.assign((_id, _inputs, claim) => { claim(); return 'committed' }, {
      beforeModelRequest(session, request, position) { checked++; return guard(session, request, position) },
    })
  })
  await mountAgentLoopTestHarness(ctx)
  const handle = await ctx.agents.create({ sessionId:SessionId('isolated-boundary-test'), agentOptions:{ provider:'boundary-test', model:'mock' } })
  assert.equal(handle.agent.guardedRequestBoundaryVersion, 1)
  await handle.agent.guardedSend(expected, 'next-turn', 'synthetic-boundary')
  await handle.agent.whenIdle()
  assert.equal(checked, 1)
  assert.equal(adapter.requests.length, 1)
  release()
  await handle.dispose()
})

test('real guarded Agent blocks a changed model before the mock model', async t => {
  const home = await mkdtemp(join(tmpdir(), 'ds-bot-request-boundary-'))
  const ctx = new Context(), adapter = new Adapter()
  t.after(async () => { await ctx.fiber.dispose(); await rm(home, { recursive:true, force:true }) })
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(Jsonl, { root:join(home, 'sessions'), compression:'none' })
  ctx.llm.registerAdapter(['boundary-test'], adapter)
  const expected = createUserMessage({ content:[{ type:'text', text:'synthetic task' }], source:{ kind:'ds-bot-user-redo' } })
  const rt = { ctx, requireHomeLock() {}, homeLockVersion:() => 1 }
  let checked = 0
  const release = await ctx.agents.registerGuardedClaimProvider(agent => {
    const guard = createIsolatedRedoRequestGuard(rt, { agent, expectedMessage:expected,
      target:{ provider:'boundary-test', model:'different' }, isCurrent:() => true })
    return Object.assign((_id, _inputs, claim) => { claim(); return 'committed' }, {
      beforeModelRequest(session, request, position) { checked++; return guard(session, request, position) },
    })
  })
  await mountAgentLoopTestHarness(ctx)
  const handle = await ctx.agents.create({ sessionId:SessionId('isolated-boundary-denied'), agentOptions:{ provider:'boundary-test', model:'mock' } })
  assert.equal(handle.agent.guardedRequestBoundaryVersion, 1)
  await handle.agent.guardedSend(expected, 'next-turn', 'synthetic-boundary')
  await handle.agent.whenIdle()
  assert.equal(checked, 1)
  assert.equal(adapter.requests.length, 0)
  assert.equal(handle.agent.session.snapshotEvents().some(event => event.type === 'turn/end' && event.data.reason.kind === 'error'), true)
  release()
  await handle.dispose()
})

test('guard catches a message injected after claim but before model invocation', async t => {
  const home = await mkdtemp(join(tmpdir(), 'ds-bot-request-boundary-'))
  const ctx = new Context(), adapter = new Adapter()
  t.after(async () => { await ctx.fiber.dispose(); await rm(home, { recursive:true, force:true }) })
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(Jsonl, { root:join(home, 'sessions'), compression:'none' })
  ctx.llm.registerAdapter(['boundary-test'], adapter)
  const expected = createUserMessage({ content:[{ type:'text', text:'synthetic task' }], source:{ kind:'ds-bot-user-redo' } })
  const rt = { ctx, requireHomeLock() {}, homeLockVersion:() => 1 }
  let checked = 0
  const release = await ctx.agents.registerGuardedClaimProvider(agent => {
    const guard = createIsolatedRedoRequestGuard(rt, { agent, expectedMessage:expected,
      target:{ provider:'boundary-test', model:'mock' }, isCurrent:() => true })
    return Object.assign((_id, _inputs, claim) => { claim(); return 'committed' }, {
      beforeModelRequest(session, request, position) { checked++; return guard(session, request, position) },
    })
  })
  await mountAgentLoopTestHarness(ctx)
  const handle = await ctx.agents.create({ sessionId:SessionId('isolated-boundary-injected'), agentOptions:{ provider:'boundary-test', model:'mock' } })
  assert.equal(handle.agent.guardedRequestBoundaryVersion, 1)
  ctx.on('agent/request', async (_event, next) => {
    handle.agent.session.append('user/message', createUserMessage({ content:[{ type:'text', text:'injected' }], source:{ kind:'user' } }), { surfaceOp:'append' })
    return next()
  })
  await handle.agent.guardedSend(expected, 'next-turn', 'synthetic-boundary')
  await handle.agent.whenIdle()
  assert.equal(checked, 1)
  assert.equal(adapter.requests.length, 0)
  assert.equal(handle.agent.session.snapshotEvents().some(event => event.type === 'turn/end' && event.data.reason.kind === 'error'), true)
  release()
  await handle.dispose()
})
