// Manual isolated integration: run against the matching Harness guarded-start
// WIP, never against the user's active DSH_HOME. This does not enable redo.
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { install as installTurns } from '../../src/host/turns.js'
import { install as installResume } from '../../src/host/resume.js'
import { createGuardedRedoTurnRoute } from '../../src/host/guarded-redo-turn-route.mjs'
import { captureGuardedRedoResult } from '../../src/host/guarded-redo-result.mjs'
import { createOriginalRedoJournal, originalRedoIdentity } from '../../src/host/original-redo-journal.mjs'
import { userRedoConfirmation } from '../../src/host/user-redo-journal.mjs'

class ScriptedAdapter extends LlmAdapter {
  requests = []
  async resolveModel(provider, model) { return { provider, id:model, name:model } }
  async *stream(options) {
    this.requests.push(options)
    const text = this.requests.length === 1 ? 'redo output' : 'ordinary output'
    yield { type:'block-start', index:0, blockType:'text' }
    yield { type:'text-delta', index:0, text }
    yield { type:'block-end', index:0, block:{ type:'text', text } }
    yield { type:'usage', usage:{ inputTokens:10, outputTokens:text.length } }
    yield { type:'finish', reason:{ kind:'stop' } }
  }
}

test('real guarded Agent and journal isolate redo while retaining a later ordinary input', async t => {
  const home = await mkdtemp(join(tmpdir(), 'ds-bot-redo-agent-'))
  const ctx = new Context(), adapter = new ScriptedAdapter()
  t.after(async () => { await ctx.fiber.dispose(); await rm(home, { recursive:true, force:true }) })
  await writeFile(join(home, 'inflight.json'), JSON.stringify({ turns:{}, queued:{} }))
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(Jsonl, { root:join(home, 'sessions'), compression:'none' })
  ctx.llm.registerAdapter(['redo-fixture'], adapter)
  const rt = {
    ctx, home, state:{ bots:{ bot:{ id:'bot', name:'Bot' } }, exchangeTurns:{}, questions:{}, pendingInputs:{ bot:[{ id:'old-input', seq:0, ownerId:'bot' }] } },
    groupOwners:new Map(), chatOwners:new Map(), isBotSession:id => id === 'bot', roomOf:() => undefined,
    selfOf:id => id, botOf:id => id === 'bot' ? { id, name:'Bot' } : undefined,
    deliver:async () => {}, save:async () => {}, warn:() => {}, noteFailure:() => {}, userWrote:() => {},
    switchJobs:() => [], readOnly:() => 'test read-only', load:async () => {}, requireHomeLock:() => {}, homeLockVersion:() => 'test-lease', onHomeDrain:() => {},
  }
  installTurns(rt)
  installResume(rt)
  const operationId = '726e9a9d-73e4-496e-a662-8c4a5fdc1661', recoveryId = 'b'.repeat(64)
  const principal = { kind:'user', id:'user' }, scope = { kind:'personal', id:'bot' }
  const identity = originalRedoIdentity(operationId)
  const redo = { ...createUserMessage({ content:[{ type:'text', text:'chosen redo input' }], source:{ kind:'ds-bot-user-redo' } }), id:identity.messageId }
  const ordinary = createUserMessage({ content:[{ type:'text', text:'later ordinary input' }], source:{ kind:'user' } })
  // Original-input proof and authentication are synthetic; Agent, writer,
  // coordinator, journal file, and result receipt use their real implementations.
  const original = { complete:true, durability:'target-writer-v1', recoveryId, botId:'bot', sessionId:'bot', messageSeq:0, turn:0,
    message:{ id:'original', role:'user', source:{ kind:'bot', role:'request', exchangeId:'ex' }, content:[{ type:'text', text:'chosen redo input' }] },
    isCurrent:() => true }
  let dispatch, agent, resultObservation
  const journal = createOriginalRedoJournal(rt, { authorize:() => true, proveOriginal:async () => original,
    validateBinding:row => row.original.sessionId === agent?.session.id,
    verifyResult:async row => captureGuardedRedoResult({ ctx, session:agent.session, input:redo, admissionId:identity.admissionId,
      turn:row.turn, isCurrent:() => true }) })
  const confirmationDigest = userRedoConfirmation(scope, recoveryId, original)
  await journal.prepare({ operationId, recoveryId, scope, principal, acknowledged:true, confirmationDigest })
  const route = createGuardedRedoTurnRoute({ sessions:ctx.sessions, resolveIntent:(agent, input) => {
    if (input.message.id !== redo.id) return null
    const binding = journal.inspectDispatchSync(dispatch.binding, principal)
    assert.equal(binding.identity.messageId, redo.id)
    return { operationId, session:agent.session, messageId:redo.id, admissionId:identity.admissionId, isCurrent:() => true }
  } })
  rt.redoTurnRoute = route
  const seen = Promise.withResolvers()
  let selectedAgent, pending, carry, observedEnd = false
  const provider = await ctx.agents.registerGuardedClaimProvider(agent => {
    selectedAgent = agent
    const base = Object.assign((id, inputs, claim, turn) => {
      assert.equal(id, agent.id); assert.equal(inputs.length, 1)
      assert.equal(inputs[0].message.id, redo.id); assert.equal(inputs[0].admissionId, identity.admissionId)
      journal.markClaimingSync(dispatch.binding, turn, principal)
      // The real Host must additionally recheck its live authority without a
      // reentrant callback; this fixture models a stable authorized target.
      assert.equal(id, agent.session.id)
      claim(); return 'committed'
    }, {
      beforeTurnStart:() => { queueMicrotask(() => agent.followup(ordinary)) },
      cancelTurnStart:() => {},
    })
    return route.wrap(agent, base)
  })
  await mountAgentLoopTestHarness(ctx)
  const handle = await ctx.agents.create({ sessionId:SessionId('bot'), agentOptions:{ provider:'redo-fixture', model:'mock' } })
  agent = handle.agent
  assert.equal(agent, selectedAgent)
  const entry = rt.liveOf('bot')
  pending = { role:'continue', exchangeId:'existing' }
  carry = { info:pending, texts:['prior work'], shown:0, answers:false, joined:[], later:[], toolCount:0 }
  entry.pending = pending; entry.pendingText = 'prior work'; entry.carry = carry
  ctx.on('session/event', (session, event) => {
    if (session !== agent.session || event.type !== 'turn/end' || event.data.turn !== 1) return
    observedEnd = true
    try {
      assert.equal(entry.pending, pending); assert.equal(entry.carry, carry)
      assert.deepEqual(rt.state.pendingInputs.bot, [{ id:'old-input', seq:0, ownerId:'bot' }])
      seen.resolve()
    } catch (error) { seen.reject(error) }
  })
  dispatch = await journal.beginDispatch(operationId, principal)
  assert.equal(dispatch.perform, true)
  await agent.guardedSend(redo, 'next-turn', identity.admissionId)
  await seen.promise
  await agent.whenIdle()
  assert.equal(observedEnd, true)
  assert.equal(adapter.requests.length, 2)
  assert.match(JSON.stringify(adapter.requests[0].messages), /chosen redo input/)
  assert.doesNotMatch(JSON.stringify(adapter.requests[0].messages), /later ordinary input|Some earlier messages in this conversation/)
  assert.match(JSON.stringify(adapter.requests[1].messages), /later ordinary input/)
  assert.equal(agent.inbox.nextTurn.length, 0)
  const recordedStart = agent.session.snapshotEvents().find(event => event.type === 'turn/start' && event.data.turn === 1)
  const captured = await captureGuardedRedoResult({ ctx, session:agent.session, input:redo, admissionId:identity.admissionId,
    turn:{ turn:1, turnStartSeq:recordedStart.seq }, isCurrent:() => true })
  if (captured === undefined) console.error('redo-prefix-diagnostic', JSON.stringify(agent.session.snapshotEvents().map(event => ({
    seq:event.seq, type:event.type, turn:event.data?.turn, target:event.data?.target, start:event.data?.start,
    removedCount:event.data?.removedCount, inserted:event.data?.inserted?.map(item => ({ id:item.id, source:item.source })),
    messageId:event.data?.messageId, admissionId:event.data?.admissionId,
    userId:event.type === 'user/message' ? event.data?.id : undefined,
    userSource:event.type === 'user/message' ? event.data?.source : undefined,
    assistantContent:event.type === 'assistant/message' ? event.data?.message?.content?.map(part => part.type) : undefined,
    reason:event.type === 'turn/end' ? event.data?.reason?.kind : undefined,
  }))))
  assert.equal(captured?.text, 'redo output')
  resultObservation = await journal.recordResult(operationId, principal)
  assert.equal(resultObservation.state, 'completed')
  assert.equal(resultObservation.result.digest, captured.resultDigest)
  assert.deepEqual(resultObservation.result.ref, captured.resultRef)
  assert.equal((await journal.beginDispatch(operationId, principal)).state, 'unknown')
  await ctx.sessionPersistence.flushLiveSession(agent.id)
  const reader = await ctx.sessionPersistence.open(agent.id, 'read')
  try {
    const { events } = await reader.read()
    assert.equal(events.filter(event => event.type === 'turn/start').length, 2)
    assert.equal(events.filter(event => event.type === 'user/message' && event.data.id === redo.id).length, 1)
    assert.equal(events.filter(event => event.type === 'user/message' && event.data.id === ordinary.id).length, 1)
  } finally { await reader.close() }
  provider()
  await handle.dispose()
})
