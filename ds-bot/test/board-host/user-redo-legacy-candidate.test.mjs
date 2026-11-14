import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createLegacyRedoCandidate, LEGACY_CANDIDATE_WARNING } from '../../src/host/user-redo-legacy-candidate.mjs'
import { isolatedRedoConfirmation } from '../../src/host/user-redo-journal.mjs'

const recoveryId = 'b'.repeat(64), scope = { kind:'room', id:'room' }, timestamp = 123456
const message = { id:'m1', role:'user', source:{ kind:'bot', form:'relay', role:'request', exchangeId:'ex', senderSessionId:'sender', roomId:'room' }, content:[{ type:'text', text:'candidate task' }] }
const entry = (seq, type, data, time) => ({ seq, type, data, ...(time === undefined ? {} : { time }) })
const original = () => [
  entry(0, 'agent/inbox/spliced', { target:'next-turn', start:0, removedCount:0, inserted:[structuredClone(message)] }),
  entry(1, 'turn/start', { turn:5 }, timestamp),
  entry(2, 'agent/inbox/spliced', { target:'next-turn', start:0, removedCount:1, inserted:[] }),
  entry(3, 'user/message', structuredClone(message)),
  entry(4, 'turn/end', { turn:5, reason:{ kind:'interrupted' } }),
]
function fixture(events = original(), timeoutMs = 15_000) {
  let current = true, flush = async () => {}, disk = structuredClone(events)
  const session = { id:'source', seq:events.length, header:{ id:'source', version:4 }, inheritedEventCount:0, eventAt:index => events[index] }
  const reader = { id:'source', header:{ ...session.header, delegationDepth:0 }, inheritedEventCount:0,
    read:async () => ({ events:disk }), close:async () => {} }
  const writer = { flushLiveSession:async () => flush(), open:async () => reader }
  const record = { botId:'bot', since:timestamp, roomId:'room', trigger:{ role:'request', exchangeId:'ex', senderSessionId:'sender', roomId:'room' } }
  const rt = { recoveryHeldOriginal:async () => ({ sessionId:'source', record, isCurrent:() => current }),
    ctx:{ sessions:{ get:() => session }, get:() => writer } }
  return { candidate:createLegacyRedoCandidate(rt, { timeoutMs }), rt, reader, writer, session, events, record,
    setCurrent:value => { current = value }, setFlush:value => { flush = value }, setDisk:value => { disk = value } }
}

test('returns a single physical candidate without claiming authenticated authorship or execution', async () => {
  const f = fixture(), candidate = await f.candidate(scope, recoveryId)
  assert.deepEqual(candidate, { kind:'unverified-legacy-candidate', producerVerified:false, executeAllowed:false,
    warning:LEGACY_CANDIDATE_WARNING, recoveryId, botId:'bot', sessionId:'source', roomId:'room', turn:5, turnStartSeq:1, messageSeq:3, matchedTime:timestamp,
    textSegments:['candidate task'] })
  assert.throws(() => isolatedRedoConfirmation(scope, recoveryId, candidate, { principal:{ kind:'user', id:'user' },
    operationId:'bb5b1723-7063-4e3e-b27e-12f44dd0033d', target:{ cwd:'/work', provider:'p', model:'m' } }), /cannot be verified/)
})

test('no timestamp, two matching starts, missing turn end or non-interrupted outcomes are unavailable', async () => {
  const absent = fixture(); delete absent.record.since
  assert.equal(await absent.candidate(scope, recoveryId), undefined)
  const future = fixture(); future.record.turn = 5
  assert.equal(await future.candidate(scope, recoveryId), undefined)
  const dup = original(); dup.push(entry(5, 'turn/start', { turn:6 }, timestamp), entry(6, 'turn/end', { turn:6, reason:{ kind:'interrupted' } }))
  assert.equal(await fixture(dup).candidate(scope, recoveryId), undefined)
  const mismatch = original(); mismatch[1].time++
  assert.equal(await fixture(mismatch).candidate(scope, recoveryId), undefined)
  const incomplete = original().slice(0, 4)
  assert.equal(await fixture(incomplete).candidate(scope, recoveryId), undefined)
  for (const reason of [{ kind:'completed' }, { kind:'aborted', reason:{ kind:'user' } }, { kind:'aborted', reason:{ kind:'hook' } }]) {
    const events = original(); events[4].data.reason = reason
    assert.equal(await fixture(events).candidate(scope, recoveryId), undefined)
  }
})

test('control records, attachments, multiple inputs and other group identities are refused', async () => {
  for (const flag of ['reviewInspect', 'groupKickoff', 'reviewId']) {
    const f = fixture(); f.record.trigger[flag] = flag === 'reviewId' ? 'review' : true
    assert.equal(await f.candidate(scope, recoveryId), undefined)
  }
  const otherRoom = fixture(); otherRoom.record.roomId = 'other'
  assert.equal(await otherRoom.candidate(scope, recoveryId), undefined)
  const wrongScope = fixture()
  assert.equal(await wrongScope.candidate({ kind:'room', id:'other' }, recoveryId), undefined)
  const attachment = original(); attachment[0].data.inserted[0].content.push({ type:'image', attachment:{ id:'image' } })
  attachment[3].data.content.push({ type:'image', attachment:{ id:'image' } })
  assert.equal(await fixture(attachment).candidate(scope, recoveryId), undefined)
  const extra = original(); extra.splice(4, 0, entry(4, 'user/message', { id:'other', role:'user', source:{ kind:'runtime-context' }, content:[{ type:'text', text:'more' }] }))
  extra.forEach((event, index) => { event.seq = index })
  assert.equal(await fixture(extra).candidate(scope, recoveryId), undefined)
  const wrongSender = original(); wrongSender[3].data.source.senderSessionId = 'other'
  assert.equal(await fixture(wrongSender).candidate(scope, recoveryId), undefined)
  const control = original(); control[0].data.inserted[0].source.kind = 'schedule'; control[3].data.source.kind = 'schedule'
  assert.equal(await fixture(control).candidate(scope, recoveryId), undefined)
})

test('partial or changed writer prefixes and stale scope never produce a candidate', async () => {
  const missing = fixture(); delete missing.writer.flushLiveSession
  assert.equal(await missing.candidate(scope, recoveryId), undefined)
  const moving = fixture(); moving.setFlush(async () => { moving.session.seq++ })
  assert.equal(await moving.candidate(scope, recoveryId), undefined)
  const stale = fixture(); stale.setCurrent(false)
  assert.equal(await stale.candidate(scope, recoveryId), undefined)
  const different = fixture(); different.setDisk([])
  assert.equal(await different.candidate(scope, recoveryId), undefined)
  const header = fixture(); header.reader.header.delegationDepth = 1
  assert.equal(await header.candidate(scope, recoveryId), undefined)
  const mutated = original(); mutated[0].data.inserted[0].content[0].text = 'different'
  assert.equal(await fixture(mutated).candidate(scope, recoveryId), undefined)
})

test('a stuck barrier times out and does not start another read while it is pending', async () => {
  const f = fixture(original(), 10)
  let release
  f.setFlush(() => new Promise(resolve => { release = resolve }))
  assert.equal(await f.candidate(scope, recoveryId), undefined)
  assert.equal(await f.candidate(scope, recoveryId), undefined)
  assert.equal(await f.candidate(scope, 'c'.repeat(64)), undefined)
  release()
  await new Promise(resolve => setImmediate(resolve))
  f.setFlush(async () => {})
  assert.equal((await f.candidate(scope, recoveryId))?.kind, 'unverified-legacy-candidate')
})
