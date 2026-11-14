import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { createGuardedRedoTurnRoute } from '../../src/host/guarded-redo-turn-route.mjs'
import { install as installTurns } from '../../src/host/turns.js'
import { install as installResume } from '../../src/host/resume.js'

const message = createUserMessage({ content:[{ type:'text', text:'original input' }], source:{ kind:'ds-bot-user-redo' } })
const input = { message, admissionId:'redo-admission', target:'next-turn' }
const boundary = (session, turn = 1) => ({ turn, turnStartSeq:session.seq })
const authority = Object.assign((_id, _inputs, claim) => { claim(); return 'committed' }, {})

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'ds-bot-redo-route-'))
  const notes = JSON.stringify({ turns:{ bot:{ botId:'bot', since:1, trigger:{ role:'request', exchangeId:'existing' } } }, queued:{} })
  await writeFile(join(home, 'inflight.json'), notes)
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  const session = ctx.sessions.create(SessionId('bot'))
  const agent = { id:session.id, session }
  const rt = {
    ctx, home, state:{ bots:{ bot:{ id:'bot', name:'Bot' } }, exchangeTurns:{}, questions:{}, pendingInputs:{ bot:[{ id:'old-input', seq:0, ownerId:'bot' }] } },
    groupOwners:new Map(), chatOwners:new Map(), isBotSession:id => id === 'bot', roomOf:() => undefined,
    selfOf:id => id, botOf:id => id === 'bot' ? { id, name:'Bot' } : undefined,
    deliver:async () => {}, save:async () => {}, warn:() => {}, noteFailure:() => {}, userWrote:() => {},
    switchJobs:() => [], readOnly:() => 'test read-only', load:async () => {}, requireHomeLock:() => {}, onHomeDrain:() => {},
    resolveAgent:async id => id === session.id ? agent : undefined,
    eventsBackwards:async function* (id) { if (id === session.id) yield* [...session.snapshotEvents()].reverse() },
  }
  installTurns(rt)
  installResume(rt)
  const route = createGuardedRedoTurnRoute({ sessions:ctx.sessions, resolveIntent:(_agent, selected) => ({
    operationId:'operation', session, messageId:selected.message.id, admissionId:selected.admissionId, isCurrent:() => true,
  }) })
  rt.redoTurnRoute = route
  t.after(async () => { await ctx.fiber.dispose(); await rm(home, { recursive:true, force:true }) })
  return { ctx, rt, route, session, agent, notes, home }
}

test('real Host turn and recovery listeners preserve pending/carry across the isolated redo', async t => {
  const { ctx, rt, route, session, agent, notes, home } = await fixture(t)
  const entry = rt.liveOf(session.id)
  const pending = { kind:'ds-bot', role:'request', exchangeId:'existing', senderSessionId:'sender' }
  const carry = { info:pending, texts:['existing work'], shown:0, answers:false, joined:[], later:[], toolCount:0 }
  entry.pending = pending; entry.pendingText = 'existing work'; entry.carry = carry
  const wrapped = route.wrap(agent, authority), turn = boundary(session)
  wrapped.beforeTurnStart(session, input, turn)
  const fake = { type:'turn/start', seq:turn.turnStartSeq, time:1, data:{ turn:turn.turn } }
  // The notification is forged but is delivered through the real Host listeners.
  ctx.emit('session/event', session, fake)
  assert.equal(route.isolate(session, fake), true)
  assert.equal(route.status(session).state, 'planned')
  const start = session.append('turn/start', { turn:turn.turn })
  ctx.emit('session/event', session, start)
  assert.equal(route.isolate(session, start), true)
  assert.equal(entry.pending, pending); assert.equal(entry.carry, carry)
  const selected = session.append('user/message', message, { surfaceOp:'append' })
  assert.equal(route.isolate(session, selected), true)
  const output = session.append('assistant/message', { turn:1, step:1, stream:[], message:createMessage({ role:'assistant', content:[{ type:'text', text:'redo result' }], source:{ kind:'model', provider:'mock', model:'mock' } }) }, { surfaceOp:'append' })
  assert.equal(route.isolate(session, output), true)
  const end = session.append('turn/end', { turn:turn.turn, reason:{ kind:'completed' } })
  assert.equal(route.isolate(session, end), true)
  assert.equal(entry.pending, pending); assert.equal(entry.carry, carry)
  assert.deepEqual(rt.state.pendingInputs.bot, [{ id:'old-input', seq:0, ownerId:'bot' }])
  assert.equal(await readFile(join(home, 'inflight.json'), 'utf8'), notes)
  session.append('turn/start', { turn:2 })
  assert.equal(entry.pending, undefined); assert.equal(entry.carry, undefined)
  assert.equal(entry.info, pending)
})

test('a stale cancellation and a forged replacement cannot erase or claim a route', async t => {
  const { ctx, route, session, agent } = await fixture(t)
  const wrapped = route.wrap(agent, authority), turn = boundary(session)
  wrapped.beforeTurnStart(session, input, turn)
  wrapped.cancelTurnStart(session, { ...input, admissionId:'other' }, turn)
  assert.equal(route.status(session).state, 'planned')
  assert.equal(route.isolate({ id:session.id }, { type:'turn/start', seq:turn.turnStartSeq, data:{ turn:turn.turn } }), true)
  assert.equal(route.status(session).state, 'planned')
  assert.equal(ctx.sessions.get(session.id), session)
  wrapped.cancelTurnStart(session, input, turn)
  assert.equal(route.status(session), undefined)
})


test('a failed redo is not reclassified as an ordinary pending input after router restart', async t => {
  const { ctx, rt, route, session, agent } = await fixture(t)
  const wrapped = route.wrap(agent, authority), turn = boundary(session)
  wrapped.beforeTurnStart(session, input, turn)
  session.append('turn/start', { turn:turn.turn })
  session.append('user/message', message, { surfaceOp:'append' })
  session.append('turn/end', { turn:turn.turn, reason:{ kind:'error', error:{ message:'failed', code:'UNKNOWN' } } })
  // Simulate losing the in-memory routing table on plugin reload.
  rt.redoTurnRoute = createGuardedRedoTurnRoute({ sessions:ctx.sessions, resolveIntent:() => null })
  session.append('turn/start', { turn:2 })
  const decision = { kind:'enter', messages:[] }
  const result = await ctx.waterfall('agent/pre-step', { agent, signal:AbortSignal.timeout(5000), step:1 }, async () => decision)
  assert.deepEqual(rt.state.pendingInputs.bot, [{ id:'old-input', seq:0, ownerId:'bot' }])
  assert.equal(result.messages.length, 1)
  assert.deepEqual(result.messages[0].source.recoveryIds, ['old-input'])
})

test('redo admission rejects metadata that can settle unrelated recovery or work', async t => {
  const { route, session, agent } = await fixture(t)
  const wrapped = route.wrap(agent, authority)
  for (const extra of [{ recoveryIds:['old-input'] }, { recoveryKey:'k' }, { work:'old-work' }, { role:'request' }]) {
    const unsafe = { ...input, message:{ ...message, source:{ kind:'ds-bot-user-redo', ...extra } } }
    assert.throws(() => wrapped.beforeTurnStart(session, unsafe, boundary(session)), /unavailable/)
    assert.equal(route.status(session), undefined)
  }
})
