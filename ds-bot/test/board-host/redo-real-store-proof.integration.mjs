// Isolated slice: real store/lease, held-view, SessionStore and JSONL; owner
// authentication is intentionally not modeled by this test.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { install as installStore } from '../../src/host/store.js'
import { install as installResume } from '../../src/host/resume.js'
import { boardList } from '../../src/host/board-query.js'
import { createUserRedoOriginalProof } from '../../src/host/user-redo-proof.mjs'
import { createOriginalRedoJournal } from '../../src/host/original-redo-journal.mjs'
import { userRedoConfirmation } from '../../src/host/user-redo-journal.mjs'
import { createUserRedoPreparation } from '../../src/host/user-redo-preparation.mjs'

test('real store and writer require a current scoped owner and held input before a redo record', async t => {
  const home = await mkdtemp(join(tmpdir(), 'ds-bot-redo-real-host-')), statePath = join(home, 'state.json')
  const ctx = new Context(), bot = { id:'bot', name:'Bot' }
  t.after(async () => { await ctx.fiber.dispose(); await rm(home, { recursive:true, force:true }) })
  await writeFile(statePath, JSON.stringify({ version:1, bots:{ bot }, rooms:{}, agents:{} }))
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(Jsonl, { root:join(home, 'sessions'), compression:'none' })
  const session = ctx.sessions.create(SessionId('bot'))
  await ctx.sessionPersistence.create(session.header, { inheritedEventCount:session.inheritedEventCount })
  const message = createUserMessage({ content:[{ type:'text', text:'synthetic original input' }],
    source:{ kind:'bot', role:'request', exchangeId:'exchange', senderSessionId:'sender' } })
  session.append('agent/inbox/spliced', { target:'next-turn', start:0, inserted:[message] })
  session.append('turn/start', { turn:1 })
  session.append('agent/inbox/spliced', { target:'next-turn', start:0, removedCount:1, inserted:[] })
  session.append('user/message', message, { surfaceOp:'append' })
  session.append('turn/end', { turn:1, reason:{ kind:'interrupted' } })
  const record = { botId:'bot', turn:1, trigger:{ role:'request', exchangeId:'exchange', senderSessionId:'sender' } }
  const recoveryId = createHash('sha256').update(JSON.stringify(['bot', record])).digest('hex')
  await writeFile(join(home, 'inflight.json'), JSON.stringify({ turns:{}, queued:{}, heldTurns:{
    [recoveryId]:{ sessionId:'bot', record, reason:'interrupted outcome unknown' },
  } }), { mode:0o600 })
  const rt = { ctx, home, statePath, autoRoomName:() => 'Room', retitleRoom:async () => {}, warn() {} }
  installStore(rt); await rt.load(); await rt.save({ required:true })
  installResume(rt)
  const principal = { kind:'user', id:'user' }, scope = { kind:'personal', id:'bot' }
  const proof = createUserRedoOriginalProof(rt), source = await proof(scope, recoveryId)
  assert.equal(source?.message.id, message.id)
  const authorize = (requested, requestedRecovery, actor) => {
    if (actor?.kind !== 'user' || actor.id !== 'user' || requestedRecovery !== recoveryId) return false
    try {
      boardList({ scope:requested, principal:actor, rooms:rt.state.rooms, bots:rt.state.bots })
      return requested.kind === 'personal' && requested.id === 'bot' && rt.botOf('bot') !== undefined && rt.chatOwners.get('bot') === 'bot'
    } catch { return false }
  }
  // A bare Session has no Agent authority. This validates real roster and
  // SessionStore checks without claiming a production coordinator is bound.
  const journal = createOriginalRedoJournal(rt, { authorize, proveOriginal:proof,
    validateBinding:row => ctx.sessions.get(row.original.sessionId) === session && ctx.agents.get(row.original.sessionId)?.session === session })
  const operationId = '9d5b1723-7063-4e3e-b27e-12f44dd0033d', preparation = createUserRedoPreparation(rt)
  const preview = await preparation.preview({ scope, recoveryId })
  assert.deepEqual(preview.content, message.content)
  assert.match(preview.warning, /sender is not authenticated/)
  assert.equal(preview.execution, 'disabled')
  await assert.rejects(preparation.preview({ scope:{ kind:'personal', id:'missing' }, recoveryId }), Error)
  const request = { operationId, recoveryId, scope, acknowledged:true, confirmationDigest:preview.confirmationDigest }
  await assert.rejects(preparation.confirm({ ...request, confirmationDigest:'b'.repeat(64) }), Error)
  await assert.rejects(preparation.confirm({ ...request, acknowledged:false }), Error)
  assert.equal((await preparation.confirm(request)).execution, 'disabled')
  await assert.rejects(journal.beginDispatch(operationId, principal), Error)
  const permissiveBinding = createOriginalRedoJournal(rt, { authorize, proveOriginal:proof, validateBinding:() => true })
  await assert.rejects(permissiveBinding.beginDispatch(operationId, principal), /execution was not authorized/)
  await assert.rejects(journal.prepare({ ...request, confirmationDigest:userRedoConfirmation(scope, recoveryId, source), operationId:'c2a7ed5e-3b37-4a48-bb72-3d82f9d8c454', principal:{ kind:'bot', id:'bot' } }), Error)
  assert.equal(JSON.parse(await (await import('node:fs/promises')).readFile(statePath, 'utf8')).originalRedoWitness[recoveryId].operationId, request.operationId)
})
