// No active DSH_HOME or network: synthetic data with actual SessionStore,
// JSONL writer and held-record scope lookup. Authentication is a fixture.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { install as installResume } from '../../src/host/resume.js'
import { createLegacyRedoCandidate } from '../../src/host/user-redo-legacy-candidate.mjs'
import { createUserRedoOriginalProof } from '../../src/host/user-redo-proof.mjs'

test('legacy time-only candidate reads a real durable writer without becoming a producer proof', async t => {
  const home = await mkdtemp(join(tmpdir(), 'legacy-candidate-'))
  const ctx = new Context()
  t.after(async () => { await ctx.fiber.dispose(); await rm(home, { recursive:true, force:true }) })
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(Jsonl, { root:join(home, 'sessions'), compression:'none' })
  const session = ctx.sessions.create(SessionId('bot'))
  await ctx.sessionPersistence.create(session.header, { inheritedEventCount:session.inheritedEventCount })
  const input = createUserMessage({ content:[{ type:'text', text:'synthetic candidate' }],
    source:{ kind:'bot', role:'request', exchangeId:'exchange', senderSessionId:'sender' } })
  session.append('agent/inbox/spliced', { target:'next-turn', start:0, inserted:[input] })
  const start = session.append('turn/start', { turn:1 })
  session.append('agent/inbox/spliced', { target:'next-turn', start:0, removedCount:1, inserted:[] })
  session.append('user/message', input, { surfaceOp:'append' })
  session.append('turn/end', { turn:1, reason:{ kind:'interrupted' } })
  assert.ok(Number.isSafeInteger(start.time), 'physical event timestamp required')
  const record = { botId:'bot', since:start.time, trigger:{ role:'request', exchangeId:'exchange', senderSessionId:'sender' } }
  const recoveryId = createHash('sha256').update(JSON.stringify(['bot', record])).digest('hex')
  await writeFile(join(home, 'inflight.json'), JSON.stringify({ turns:{}, queued:{}, heldTurns:{
    [recoveryId]:{ sessionId:'bot', record, reason:'interrupted outcome unknown' },
  } }), { mode:0o600 })
  const inflightBefore = await readFile(join(home, 'inflight.json'), 'utf8')
  const bot = { id:'bot', name:'Bot' }, scope = { kind:'personal', id:'bot' }
  const rt = { ctx, home, state:{ bots:{ bot }, rooms:{}, agents:{} }, chatOwners:new Map([['bot','bot']]),
    groupOwners:new Map(), pastOwners:new Map(), botOf:id => id === 'bot' ? bot : undefined,
    roomOf:() => undefined, chatOf:id => id, sessionOfRoom:() => undefined, readOnly:() => undefined,
    requireHomeLock:() => {}, homeLockVersion:() => 'test-lease', isBotSession:id => id === 'bot',
    warn:() => {}, load:async () => {}, onHomeDrain:() => {} }
  installResume(rt)
  assert.ok(await rt.recoveryHeldOriginal(scope, recoveryId))
  const candidate = createLegacyRedoCandidate(rt)
  const result = await candidate(scope, recoveryId)
  assert.equal(result?.kind, 'unverified-legacy-candidate')
  assert.equal(result?.producerVerified, false)
  assert.equal(result?.executeAllowed, false)
  assert.deepEqual(result?.textSegments, ['synthetic candidate'])
  assert.equal(result?.messageSeq, 3)
  assert.equal(await createUserRedoOriginalProof(rt)(scope, recoveryId), undefined)
  assert.equal(await candidate({ kind:'room', id:'other' }, recoveryId), undefined)
  assert.equal(await readFile(join(home, 'inflight.json'), 'utf8'), inflightBefore)
  assert.deepEqual((await readdir(home)).sort(), ['inflight.json', 'sessions'])
})
