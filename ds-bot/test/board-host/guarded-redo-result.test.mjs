import assert from 'node:assert/strict'
import { test } from 'node:test'
import { symbols } from '@deepseek-ai/cordis'
import { captureGuardedRedoResult } from '../../src/host/guarded-redo-result.mjs'

const input = Object.freeze({ id:'m1', role:'user', content:[{ type:'text', text:'chosen input' }], source:{ kind:'ds-bot-user-redo' } })
const turn = { turn:4, turnStartSeq:3 }
const event = (seq, type, data) => ({ seq, type, time:seq + 1, data })
function history() {
  return [
    event(0, 'agent/admission/hold', { messageId:input.id, admissionId:'a1' }),
    event(1, 'agent/inbox/spliced', { target:'next-turn', start:0, inserted:[input] }),
    event(2, 'agent/admission/release', { messageId:input.id, admissionId:'a1' }),
    event(3, 'turn/start', { turn:4 }),
    event(4, 'agent/inbox/spliced', { target:'next-turn', start:0, removedCount:1, inserted:[] }),
    event(5, 'user/message', input),
    event(6, 'assistant/message', { turn:4, message:{ role:'assistant', source:{ kind:'model' }, content:[{ type:'text', text:'final answer' }] } }),
    event(7, 'turn/end', { turn:4, reason:{ kind:'completed' } }),
  ]
}
function fixture(events = history()) {
  let closed = 0, flushed = 0, allowed = true
  const session = { id:'s1', seq:events.length, header:{ id:'s1', version:4 }, inheritedEventCount:0, eventAt:i => events[i] }
  const reader = { id:'s1', header:session.header, inheritedEventCount:0,
    read:async (_start, count) => ({ events:structuredClone(events.slice(0, count)) }), close:async () => { closed++ } }
  const persistence = { flushLiveSession:async id => { assert.equal(id, 's1'); flushed++ }, open:async () => reader }
  const ctx = { sessions:{ get:id => id === 's1' ? session : undefined }, sessionPersistence:persistence }
  const args = { ctx, session, input, admissionId:'a1', turn, isCurrent:() => allowed }
  return { args, ctx, session, reader, persistence, counts:() => ({ closed, flushed }), revoke:() => { allowed = false } }
}

test('captures only a complete verified target-writer prefix', async () => {
  const f = fixture(), result = await captureGuardedRedoResult(f.args)
  assert.equal(result?.text, 'final answer')
  assert.equal(result?.endSeq, 7); assert.equal(result?.throughSeq, 7)
  assert.equal(result?.messageId, input.id); assert.equal(result?.admissionId, 'a1')
  assert.match(result?.resultDigest, /^[a-f0-9]{64}$/)
  assert.deepEqual(result?.resultRef, { kind:'session-events', sessionId:'s1', firstSeq:6, lastSeq:6 })
  assert.deepEqual(result?.turn, turn)
  assert.equal(result?.isCurrent(), true)
  assert.deepEqual(f.counts(), { closed:1, flushed:1 })
})

test('fails closed for a changed Session, revoked scope, partial read, or flush failure', async () => {
  for (const variant of ['replacement', 'provider', 'revoked', 'partial', 'flush']) {
    const f = fixture()
    if (variant === 'replacement') f.persistence.flushLiveSession = async () => { f.ctx.sessions.get = () => ({ ...f.session }) }
    if (variant === 'provider') f.persistence.flushLiveSession = async () => { f.ctx.sessionPersistence = { ...f.persistence } }
    if (variant === 'revoked') f.persistence.flushLiveSession = async () => { f.revoke() }
    if (variant === 'partial') f.reader.read = async () => ({ events:history().slice(0, -1) })
    if (variant === 'flush') f.persistence.flushLiveSession = async () => { throw new Error('write failed') }
    assert.equal(await captureGuardedRedoResult(f.args), undefined, variant)
  }
})

test('accepts only the documented zero default for persisted delegation depth', async () => {
  const f = fixture()
  f.reader.header = { ...f.session.header, delegationDepth:0 }
  assert.equal((await captureGuardedRedoResult(f.args))?.text, 'final answer')
  f.reader.header.delegationDepth = 1
  assert.equal(await captureGuardedRedoResult(f.args), undefined)
  f.reader.header.delegationDepth = null
  assert.equal(await captureGuardedRedoResult(f.args), undefined)
  f.reader.header = { ...f.session.header, delegationDepth:0, agentPreset:'other' }
  assert.equal(await captureGuardedRedoResult(f.args), undefined)
})

test('rejects failed, mixed, reordered, conflicting and non-text results', async () => {
  const variants = []
  { const e = history(); e[7].data.reason = { kind:'error', error:{ code:'UNKNOWN', message:'failed' } }; variants.push(e) }
  { const e = history(); e.splice(6, 0, event(6, 'user/message', { ...input, id:'other' })); e.forEach((v, i) => { v.seq = i }); variants.push(e) }
  { const e = history(); e[4].data.start = 1; variants.push(e) }
  { const e = history(); e[1].data.removedCount = null; variants.push(e) }
  { const e = history(); e[2].data.admissionId = 'other'; variants.push(e) }
  { const e = history(); e[6].data.message.content = [{ type:'image', attachment:'x' }]; variants.push(e) }
  { const e = history(); e[6].data.interrupted = true; variants.push(e) }
  { const e = history(); e[6].data.message.source.kind = 'other'; variants.push(e) }
  for (const events of variants) assert.equal(await captureGuardedRedoResult(fixture(events).args), undefined)
})


test('accepts fresh Cordis-style proxies only while the provider object is unchanged', async () => {
  const f = fixture(), rawSessions = f.ctx.sessions, rawPersistence = f.persistence
  const proxy = target => new Proxy(target, { get(value, key) { return key === symbols.original ? value : Reflect.get(value, key) } })
  Object.defineProperty(f.ctx, 'sessions', { configurable:true, get:() => proxy(rawSessions) })
  Object.defineProperty(f.ctx, 'sessionPersistence', { configurable:true, get:() => proxy(rawPersistence) })
  assert.equal((await captureGuardedRedoResult(f.args))?.text, 'final answer')
  let provider = rawPersistence
  Object.defineProperty(f.ctx, 'sessionPersistence', { configurable:true, get:() => proxy(provider) })
  rawPersistence.flushLiveSession = async () => { provider = { ...rawPersistence } }
  assert.equal(await captureGuardedRedoResult(f.args), undefined)
})
