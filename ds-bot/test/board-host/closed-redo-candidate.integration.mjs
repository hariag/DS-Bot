// Synthetic data with actual owner store, held-view, live Agent and JSONL writer.
// The principal is supplied by this test, not by a real HTTP session.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { install as installStore } from '../../src/host/store.js'
import { install as installResume } from '../../src/host/resume.js'
import { createClosedRedoCandidatePreview } from '../../src/host/closed-redo-candidate.mjs'

test('unloaded original session supports only a read-only unverified snapshot', async t => {
  const home = await mkdtemp(join(tmpdir(), 'candidate-preparation-')), statePath = join(home, 'state.json')
  const ctx = new Context(), bot = { id:'bot', name:'Bot' }
  t.after(async () => { await ctx.fiber.dispose(); await rm(home, { recursive:true, force:true }) })
  await writeFile(statePath, JSON.stringify({ version:1, bots:{ bot }, rooms:{}, agents:{} }))
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(Jsonl, { root:join(home, 'sessions'), compression:'none' })
  await mountAgentLoopTestHarness(ctx)
  const handle = await ctx.agents.create({ sessionId:SessionId('bot'), meta:{ cwd:home }, agentOptions:{ provider:'test-provider', model:'test-model' } })
  const session = handle.agent.session
  const message = createUserMessage({ content:[{ type:'text', text:'synthetic private candidate' }],
    source:{ kind:'bot', role:'request', exchangeId:'exchange', senderSessionId:'sender' } })
  session.append('agent/inbox/spliced', { target:'next-turn', start:0, inserted:[message] })
  session.append('turn/start', { turn:1 })
  session.append('agent/inbox/spliced', { target:'next-turn', start:0, removedCount:1, inserted:[] })
  session.append('user/message', message, { surfaceOp:'append' })
  session.append('turn/end', { turn:1, reason:{ kind:'interrupted' } })
  const record = { botId:'bot', since:session.eventAt(1).time, trigger:{ role:'request', exchangeId:'exchange', senderSessionId:'sender' } }
  const recoveryId = createHash('sha256').update(JSON.stringify(['bot', record])).digest('hex')
  await writeFile(join(home, 'inflight.json'), JSON.stringify({ turns:{}, queued:{}, heldTurns:{
    [recoveryId]:{ sessionId:'bot', record, reason:'interrupted outcome unknown' },
  } }), { mode:0o600 })
  await ctx.sessionPersistence.flushLiveSession('bot')
  await handle.dispose()
  assert.equal(ctx.sessions.get('bot'), undefined)
  const rt = { ctx, home, statePath, autoRoomName:() => 'Room', retitleRoom:async () => {}, warn() {} }
  installStore(rt); await rt.load(); await rt.save({ required:true }); installResume(rt)
  const scope = { kind:'personal', id:'bot' }
  const before = await ctx.sessionPersistence.stat('bot')
  const preview = createClosedRedoCandidatePreview(rt)
  const value = await preview(scope, recoveryId)
  assert.deepEqual(value?.textSegments, ['synthetic private candidate'])
  assert.equal(value?.snapshotOnly, true)
  assert.equal(value?.producerVerified, false)
  assert.equal(value?.executeAllowed, false)
  assert.equal(ctx.sessions.get('bot'), undefined)
  assert.deepEqual(await ctx.sessionPersistence.stat('bot'), before)
  assert.equal(rt.state.originalRedoWitness, undefined)
})
