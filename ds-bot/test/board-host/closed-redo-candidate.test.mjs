import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createClosedRedoCandidatePreview } from '../../src/host/closed-redo-candidate.mjs'

function fixture() {
  const message = { id:'m1', role:'user', source:{ kind:'bot', role:'request', exchangeId:'ex', senderSessionId:'sender', roomId:'room' }, content:[{ type:'text', text:'candidate' }] }
  const event = (seq,type,data,time) => ({ seq,type,data,...(time === undefined ? {} : { time }) })
  const events = [event(0,'agent/inbox/spliced',{ target:'next-turn', start:0, removedCount:0, inserted:[message] }),
    event(1,'turn/start',{ turn:5 },123456), event(2,'agent/inbox/spliced',{ target:'next-turn', start:0, removedCount:1, inserted:[] }),
    event(3,'user/message',message), event(4,'turn/end',{ turn:5, reason:{ kind:'interrupted' } })]
  const header = { id:'source', version:4 }, snapshot = { header, formatStatus:'current', revision:'v1', sizeBytes:1000 }
  const record = { botId:'bot', since:123456, roomId:'room', trigger:{ role:'request', exchangeId:'ex', senderSessionId:'sender', roomId:'room' } }
  let active, current = true
  const reader = { id:'source', header, read:async () => ({ events:structuredClone(events) }), close:async () => {} }
  const writer = { stat:async () => structuredClone(snapshot), open:async (_id, mode) => { assert.equal(mode,'read'); return reader },
    flushLiveSession:() => { throw Error('cold preview must not start a writer') } }
  const sessions = { get:() => active }, rt = { ctx:{ sessions, get:() => writer }, recoveryHeldOriginal:async () => ({ sessionId:'source', record, isCurrent:() => current }) }
  return { rt, writer, reader, snapshot, events, message, record, sessions, setActive:v => { active=v }, setCurrent:v => { current=v }, preview:createClosedRedoCandidatePreview(rt) }
}
const scope = { kind:'room', id:'room' }, recovery = 'a'.repeat(64)

test('returns a read-only unverified snapshot and never upgrades it to execution evidence', async () => {
  const f=fixture(), result=await f.preview(scope,recovery)
  assert.equal(result?.snapshotOnly,true); assert.equal(result?.executeAllowed,false); assert.equal(result?.producerVerified,false)
  assert.deepEqual(result?.textSegments,['candidate'])
  assert.equal(Object.hasOwn(result,'isCurrent'),false)
})

test('rejects loaded sessions, unstable snapshots, oversized logs and stale scope', async () => {
  const a=fixture(); a.setActive({ id:'source' }); assert.equal(await a.preview(scope,recovery),undefined)
  const b=fixture(); let reads=0; b.writer.stat=async () => ({ ...b.snapshot, revision:++reads===1 ? 'v1' : 'v2' }); assert.equal(await b.preview(scope,recovery),undefined)
  const c=fixture(); c.snapshot.sizeBytes=33*1024*1024; assert.equal(await c.preview(scope,recovery),undefined)
  const d=fixture(); d.setCurrent(false); assert.equal(await d.preview(scope,recovery),undefined)
})

test('rejects ambiguous timestamps, extra inputs, attachments, control and cross-group sources', async () => {
  const a=fixture(); a.events.push({ seq:5,type:'turn/start',time:123456,data:{turn:6} }); assert.equal(await a.preview(scope,recovery),undefined)
  const b=fixture(); b.events[3].data.content.push({ type:'image',url:'file' }); assert.equal(await b.preview(scope,recovery),undefined)
  const c=fixture(); c.record.trigger.groupKickoff=true; assert.equal(await c.preview(scope,recovery),undefined)
  const d=fixture(); d.message.source.senderRoomId='other'; assert.equal(await d.preview(scope,recovery),undefined)
  const e=fixture(); e.events.splice(4,0,{seq:4,type:'user/message',data:{...e.message,id:'extra'}}); e.events[5].seq=5; assert.equal(await e.preview(scope,recovery),undefined)
})

test('a timed-out snapshot blocks concurrent reads until its original probe settles', async () => {
  const f=fixture(), started=Promise.withResolvers(), release=Promise.withResolvers()
  f.writer.stat=async () => { started.resolve(); await release.promise; return f.snapshot }
  const probe=createClosedRedoCandidatePreview(f.rt,{ timeoutMs:10 }), first=probe(scope,recovery)
  await started.promise
  assert.equal(await first,undefined)
  assert.equal(await probe(scope,recovery),undefined)
  release.resolve(); await new Promise(resolve => setImmediate(resolve))
  f.writer.stat=async () => structuredClone(f.snapshot)
  assert.equal((await probe(scope,recovery))?.snapshotOnly,true)
})


test('a unique exchange can be inspected in a completed or multi-input snapshot without becoming execution evidence', async () => {
  const a=fixture(); a.events[4].data.reason.kind='completed'
  assert.equal((await a.preview(scope,recovery))?.snapshotOnly,true)
  const b=fixture(), other={ ...structuredClone(b.message), id:'other', source:{ ...b.message.source, exchangeId:'other' } }
  b.events.splice(4,0,{seq:4,type:'user/message',data:other}); b.events[5].seq=5
  const view=await b.preview(scope,recovery)
  assert.deepEqual(view?.textSegments,['candidate']); assert.equal(view?.executeAllowed,false)
})
