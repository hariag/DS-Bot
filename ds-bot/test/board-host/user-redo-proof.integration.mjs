// Isolated integration: a synthetic interrupted conversation is written by a
// real SessionStore/JSONL writer; the actual resume held-view and original
// input proof then inspect it. No active DSH_HOME, model or external network.
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
import { install as installResume } from '../../src/host/resume.js'
import { createUserRedoOriginalProof } from '../../src/host/user-redo-proof.mjs'

test('actual recovery held view and target writer prove a unique interrupted input', async t => {
  const home = await mkdtemp(join(tmpdir(), 'ds-bot-redo-proof-'))
  const ctx = new Context()
  t.after(async () => { await ctx.fiber.dispose(); await rm(home, { recursive:true, force:true }) })
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(Jsonl, { root:join(home, 'sessions'), compression:'none' })
  const session = ctx.sessions.create(SessionId('bot'))
  // SessionStore alone does not attach persistence. Hold the same writer the
  // live-Agent lifecycle would own before publishing any session events.
  await ctx.sessionPersistence.create(session.header, { inheritedEventCount:session.inheritedEventCount })
  const original = createUserMessage({ content:[{ type:'text', text:'synthetic original input' }],
    source:{ kind:'bot', role:'request', exchangeId:'exchange', senderSessionId:'sender' } })
  session.append('agent/inbox/spliced', { target:'next-turn', start:0, inserted:[original] })
  session.append('turn/start', { turn:1 })
  session.append('agent/inbox/spliced', { target:'next-turn', start:0, removedCount:1, inserted:[] })
  session.append('user/message', original, { surfaceOp:'append' })
  session.append('turn/end', { turn:1, reason:{ kind:'interrupted' } })
  const record = { botId:'bot', turn:1, trigger:{ role:'request', exchangeId:'exchange', senderSessionId:'sender' } }
  const recoveryId = createHash('sha256').update(JSON.stringify(['bot', record])).digest('hex')
  await writeFile(join(home, 'inflight.json'), JSON.stringify({ turns:{}, queued:{}, heldTurns:{
    [recoveryId]:{ sessionId:'bot', record, reason:'interrupted outcome unknown' },
  } }), { mode:0o600 })
  const bot = { id:'bot', name:'Bot' }
  const rt = { ctx, home, state:{ bots:{ bot }, rooms:{}, agents:{} }, chatOwners:new Map([['bot','bot']]),
    groupOwners:new Map(), pastOwners:new Map(), botOf:id => id === 'bot' ? bot : undefined,
    roomOf:() => undefined, chatOf:id => id, sessionOfRoom:() => undefined, readOnly:() => undefined,
    requireHomeLock:() => {}, homeLockVersion:() => 'test-lease', isBotSession:id => id === 'bot',
    warn:() => {}, load:async () => {}, onHomeDrain:() => {} }
  installResume(rt)
  const held = await rt.recoveryHeldOriginal({ kind:'personal', id:'bot' }, recoveryId)
  assert.ok(held, 'actual held record must be accessible to its original scope')
  const proof = createUserRedoOriginalProof(rt)
  const result = await proof({ kind:'personal', id:'bot' }, recoveryId)
  assert.equal(result?.sessionId, 'bot')
  assert.equal(result?.message.id, original.id)
  assert.equal(result?.turn, 1)
  assert.equal(result?.isCurrent(), true)
  assert.equal(await proof({ kind:'room', id:'other' }, recoveryId), undefined)
  session.append('agent/inbox/spliced', { target:'next-turn', start:0, inserted:[] })
  assert.equal(result.isCurrent(), false)
})
