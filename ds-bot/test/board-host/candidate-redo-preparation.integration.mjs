// Synthetic data with actual owner store, held-view, live Agent and JSONL writer.
// The principal is supplied by this test, not by a real HTTP session.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
import { boardList } from '../../src/host/board-query.js'
import { createLegacyRedoCandidate } from '../../src/host/user-redo-legacy-candidate.mjs'
import { createIsolatedCandidateRedoJournal } from '../../src/host/original-redo-journal.mjs'
import { createCandidateRedoPreparation } from '../../src/host/candidate-redo-preparation.mjs'

test('real owner state and live original writer bind a legacy candidate preparation', async t => {
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
  const rt = { ctx, home, statePath, autoRoomName:() => 'Room', retitleRoom:async () => {}, warn() {} }
  installStore(rt); await rt.load(); await rt.save({ required:true }); installResume(rt)
  const principal = { kind:'user', id:'user' }, scope = { kind:'personal', id:'bot' }, operationId = 'bb5b1723-7063-4e3e-b27e-12f44dd0033d'
  const candidateReader = createLegacyRedoCandidate(rt)
  const authorize = (requested, id, actor) => {
    if (actor?.kind !== 'user' || actor.id !== 'user' || id !== recoveryId) return false
    try { boardList({ scope:requested, principal:actor, rooms:rt.state.rooms, bots:rt.state.bots }); return requested.kind === 'personal' && requested.id === 'bot' }
    catch { return false }
  }
  const journal = createIsolatedCandidateRedoJournal(rt, { candidateReader, authorize, validateBinding:() => true })
  const authority = createCandidateRedoPreparation(rt, { candidateReader, journal })
  const request = { principal, scope, recoveryId, operationId }
  await assert.rejects(authority.preview({ ...request, principal:{ kind:'bot', id:'bot' } }), /unavailable/)
  await assert.rejects(authority.preview({ ...request, scope:{ kind:'personal', id:'missing' } }), /unavailable/)
  const preview = await authority.preview(request)
  assert.deepEqual(preview.candidate.textSegments, ['synthetic private candidate'])
  assert.equal(preview.candidate.producerVerified, false)
  assert.equal(preview.target.cwd, home)
  assert.equal(preview.execution, 'disabled')
  await assert.rejects(authority.prepare({ ...request, acknowledged:true, confirmationDigest:'b'.repeat(64) }), /confirmation changed/)
  handle.agent.model.select({ provider:'test-provider', model:'different' })
  await assert.rejects(authority.prepare({ ...request, acknowledged:true, confirmationDigest:preview.confirmationDigest }), /confirmation changed/)
  handle.agent.model.select({ provider:'test-provider', model:'test-model' })
  assert.equal((await authority.prepare({ ...request, acknowledged:true, confirmationDigest:preview.confirmationDigest })).state, 'prepared')
  assert.doesNotMatch(await readFile(statePath, 'utf8'), /synthetic private candidate/)
  await handle.dispose()
})
