import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createUserRedoOriginalProof } from '../../src/host/user-redo-proof.mjs'

const recoveryId = 'b'.repeat(64), scope = { kind:'room', id:'room' }
const message = { id:'m1', role:'user', source:{ kind:'bot', role:'request', exchangeId:'ex', senderSessionId:'sender' }, content:[{ type:'text', text:'task' }] }
const entry = (seq, type, data) => ({ seq, type, data })
const original = () => [
  entry(0, 'agent/inbox/spliced', { target:'next-turn', start:0, removedCount:0, inserted:[message] }),
  entry(1, 'turn/start', { turn:5 }),
  entry(2, 'agent/inbox/spliced', { target:'next-turn', start:0, removedCount:1, inserted:[] }),
  entry(3, 'user/message', message),
  entry(4, 'turn/end', { turn:5, reason:{ kind:'interrupted' } }),
]

function fixture(events = original(), timeoutMs = 15_000) {
  let current = true, flush = async () => {}, disk = structuredClone(events)
  const session = { id:'source', seq:events.length, eventAt:index => events[index] }
  const writer = { flushLiveSession:async () => flush(), open:async () => ({ read:async () => ({ events:disk }), close:async () => {} }) }
  const record = { botId:'bot', turn:5, trigger:{ role:'request', exchangeId:'ex', senderSessionId:'sender' } }
  const rt = { recoveryHeldOriginal:async () => ({ sessionId:'source', record, isCurrent:() => current }),
    ctx:{ sessions:{ get:() => session }, get:() => writer } }
  return { proof:createUserRedoOriginalProof(rt, { timeoutMs }), writer, session, events, record, setCurrent:value => { current = value },
    setFlush:value => { flush = value }, setDisk:value => { disk = value } }
}

test('matches one stopped exchange through a fixed target-writer prefix', async () => {
  const f = fixture(), proof = await f.proof(scope, recoveryId)
  assert.equal(proof?.messageSeq, 3)
  assert.equal(proof?.turn, 5)
  assert.deepEqual(proof?.message, message)
  assert.equal(proof.isCurrent(), true)
  f.setCurrent(false)
  assert.equal(proof.isCurrent(), false)
})

test('missing barrier, a changing Session, or a different disk prefix are unavailable', async () => {
  const a = fixture(); delete a.writer.flushLiveSession
  assert.equal(await a.proof(scope, recoveryId), undefined)
  const b = fixture(); b.setFlush(async () => { b.session.seq += 1 })
  assert.equal(await b.proof(scope, recoveryId), undefined)
  const c = fixture(); c.setDisk([])
  assert.equal(await c.proof(scope, recoveryId), undefined)
})

test('a stuck flush times out and blocks another probe until the original settles', async () => {
  const f = fixture(original(), 10)
  let release
  f.setFlush(() => new Promise(resolve => { release = resolve }))
  assert.equal(await f.proof(scope, recoveryId), undefined)
  assert.equal(await f.proof(scope, recoveryId), undefined)
  release()
  await new Promise(resolve => setImmediate(resolve))
  f.setFlush(async () => {})
  assert.equal((await f.proof(scope, recoveryId))?.turn, 5)
})

test('completed or user-aborted turns do not become redo inputs', async () => {
  for (const kind of ['completed', 'aborted']) {
    const events = original(); events[4].data.reason.kind = kind
    assert.equal(await fixture(events).proof(scope, recoveryId), undefined)
  }
})

test('a disposed turn is supported but an explicitly user-aborted turn is not', async () => {
  const disposed = original(); disposed[4].data.reason = { kind:'aborted', reason:{ kind:'disposed' } }
  assert.equal((await fixture(disposed).proof(scope, recoveryId))?.turn, 5)
  const user = original(); user[4].data.reason = { kind:'aborted', reason:{ kind:'user' } }
  assert.equal(await fixture(user).proof(scope, recoveryId), undefined)
})

test('a missing or different held turn cannot reuse an earlier exchange', async () => {
  const a = fixture(); delete a.record.turn
  assert.equal(await a.proof(scope, recoveryId), undefined)
  const b = fixture(); b.record.turn = 7
  assert.equal(await b.proof(scope, recoveryId), undefined)
})

test('old holds require a unique persisted start time containing the same input', async () => {
  const events = original(); events[1].time = 123456
  const a = fixture(events); delete a.record.turn; a.record.since = 123456
  assert.equal((await a.proof(scope, recoveryId))?.turn, 5)
  const b = fixture(events); delete b.record.turn; b.record.since = 123457
  assert.equal(await b.proof(scope, recoveryId), undefined)
  const duplicate = structuredClone(events)
  duplicate.push({ seq:5, type:'turn/start', time:123456, data:{ turn:6 } })
  duplicate.push({ seq:6, type:'turn/end', data:{ turn:6, reason:{ kind:'interrupted' } } })
  const c = fixture(duplicate); delete c.record.turn; c.record.since = 123456
  assert.equal(await c.proof(scope, recoveryId), undefined)
  delete duplicate[5].time
  const d = fixture(duplicate); delete d.record.turn; d.record.since = 123456
  assert.equal(await d.proof(scope, recoveryId), undefined)
  const e = fixture(events); e.record.since = 123457
  assert.equal(await e.proof(scope, recoveryId), undefined)
})

test('inspection and kickoff controls cannot be downgraded into ordinary work', async () => {
  for (const flag of ['reviewInspect', 'groupKickoff', 'reviewId']) {
    const f = fixture(); f.record.trigger[flag] = flag === 'reviewId' ? 'review' : true
    assert.equal(await f.proof(scope, recoveryId), undefined)
  }
})

test('only known unqueued runtime snapshots may accompany the business input', async () => {
  for (const kind of ['runtime-context', 'ds-bot-time-context']) {
    const events = original()
    events.splice(4, 0, entry(4, 'user/message', { id:'context', role:'user', content:[{ type:'text', text:'context' }],
      source:{ kind, form:'snapshot', sections:[{ name:kind, text:'context' }] } }))
    events.forEach((event, index) => { event.seq = index })
    assert.equal((await fixture(events).proof(scope, recoveryId))?.turn, 5)
    events[4].data.source.kind = 'unknown-context'
    assert.equal(await fixture(events).proof(scope, recoveryId), undefined)
  }
})

test('untracked admission, altered sender, or duplicate exchange cannot prove the source', async () => {
  const a = original(); a[0].data.inserted[0] = { ...message, id:'other' }
  assert.equal(await fixture(a).proof(scope, recoveryId), undefined)
  const b = original(); b[3] = entry(3, 'user/message', { ...message, source:{ ...message.source, senderSessionId:'other' } })
  assert.equal(await fixture(b).proof(scope, recoveryId), undefined)
  const c = original(); c.push(entry(5, 'user/message', message))
  assert.equal(await fixture(c).proof(scope, recoveryId), undefined)
})
