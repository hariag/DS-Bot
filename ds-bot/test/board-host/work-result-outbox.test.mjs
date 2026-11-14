// Filesystem-backed journal with synthetic Session events. This does not test
// a real Agent, the guarded coordinator, or a physical power failure.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorkResultJournal, workResultIdentity } from '../../src/host/work-result-outbox.mjs'

const digest=value=>createHash('sha256').update(value).digest('hex')
const copy=value=>structuredClone(value)
function fixture(t) {
  const home=mkdtempSync(join(tmpdir(),'dsbot-work-result-')), statePath=join(home,'state.json')
  t.after(()=>rmSync(home,{recursive:true,force:true}))
  const source={kind:'bot',form:'relay',role:'request',exchangeId:'work-1',senderSessionId:'sender',senderName:'Sender'}
  const original={id:'original',role:'user',source,content:[{type:'text',text:'Original request'}]}
  const workerEvents=[{seq:0,type:'turn/start',data:{turn:1}},{seq:1,type:'user/message',data:copy(original)},
    {seq:2,type:'turn/end',data:{turn:1,reason:{kind:'error'}}}]
  const targetEvents=[]
  const session=(sessionId,events)=>({id:sessionId,get seq(){return events.length},eventAt(index){return events[index]}})
  const sessions=new Map([['worker-session',session('worker-session',workerEvents)],['requester-session',session('requester-session',targetEvents)]])
  let held=true,generation=1,mode='normal', saveCalls=0, saveHook
  const state={works:{'work-1':{from:'sender',to:'worker',fromSession:'requester-session',parent:'parent',open:[],results:[],at:1},
    parent:{from:'upstream',to:'sender',open:['work-1'],results:[],at:1}},bots:{worker:{name:'Worker'},sender:{name:'Sender'}}}
  writeFileSync(statePath,JSON.stringify(state))
  const persistence={async flushLiveSession(sessionId){if(!sessions.has(sessionId))throw Error('missing writer')},async open(sessionId){
    const events=sessionId==='worker-session'?workerEvents:targetEvents
    return {async read(start,length){return {events:copy(events.slice(start,start+length))}},async close(){}}
  }}
  const rt={state,statePath,ctx:{sessions:{get:id=>sessions.get(id)},get:name=>name==='sessionPersistence'?persistence:undefined},
    requireHomeLock(){if(!held)throw Error('lock lost')},homeLockVersion:()=>generation,
    selfOf:id=>({'worker-session':'worker','requester-session':'sender'})[id],chatOf:id=>id==='sender'?'requester-session':undefined,
    botOf:id=>state.bots[id],async save(){saveCalls+=1;if(saveHook){const hook=saveHook;saveHook=undefined;await hook()}if(mode==='before')throw Error('write failed')
      const tmp=join(home,'state.next');writeFileSync(tmp,JSON.stringify(state));renameSync(tmp,statePath)
      if(mode==='after')throw Error('response lost')},
  }
  const binding={recoveryId:'a'.repeat(64),workId:'work-1',sourceSessionId:'worker-session',requesterSessionId:'requester-session',originalInputId:'original',originalSeq:1,originalTurn:1}
  function finish(text='Verified result') {
    const token=digest(`ds-bot:redo:v1:${binding.recoveryId}`),mid=`redo-${token}`,aid=`redo:${token}`,message={...copy(original),id:mid}
    const push=(type,data)=>workerEvents.push({seq:workerEvents.length,type,data})
    push('agent/admission/hold',{messageId:mid,admissionId:aid})
    push('agent/inbox/spliced',{target:'next-turn',start:0,inserted:[message]})
    push('agent/admission/release',{messageId:mid,admissionId:aid})
    const startSeq=workerEvents.length;push('turn/start',{turn:2});push('user/message',message)
    push('assistant/message',{message:{content:[{type:'text',text}]}})
    const endSeq=workerEvents.length;push('turn/end',{turn:2,reason:{kind:'completed'}})
    return {turn:2,startSeq,endSeq,resultDigest:digest(text)}
  }
  return {rt,state,binding,workerEvents,targetEvents,sessions,finish,open:()=>createWorkResultJournal(rt),
    setMode(value){mode=value},onSave(hook){saveHook=hook},lose(){held=false},rotate(){generation++},get saveCalls(){return saveCalls},onDisk:()=>JSON.parse(readFileSync(statePath,'utf8'))}
}

test('reserves one exact work and fences competing recovery identities',async t=>{
  const f=fixture(t),j=f.open(), first=await j.reserve(f.binding)
  assert.equal(first.state,'reserved');assert.deepEqual(f.onDisk().works['work-1'],f.state.works['work-1'])
  assert.deepEqual(await j.reserve(f.binding),first)
  await assert.rejects(j.reserve({...f.binding,recoveryId:'b'.repeat(64)}),/already reserved/)
  await assert.rejects(j.reserve({...f.binding,requesterSessionId:'other-session'}),/already reserved|route|conflict/)
  assert.deepEqual(workResultIdentity(f.binding),workResultIdentity(copy(f.binding)))
})

test('commits verified result and original work settlement together, then fences one send',async t=>{
  const f=fixture(t),j=f.open();await j.reserve(f.binding)
  const result=await j.stageResult(f.binding,f.finish())
  assert.equal(result.state,'prepared');assert.equal(f.state.works['work-1'],undefined)
  assert.equal(f.state.works.parent.open.includes('work-1'),true)
  assert.equal(f.state.works.parent.results[0].text,'Verified result')
  assert.deepEqual(f.onDisk().workResultOutbox[result.outboxId],result)
  assert.equal(f.onDisk().works['work-1'],undefined)
  const send=await j.beginSend(f.binding)
  assert.equal(send.state,'ready');assert.equal(send.message.source.replyTo,'work-1');assert.equal(send.message.source.work,'parent')
  assert.equal(send.message.source.exchangeId,result.replyExchangeId);assert.equal(send.message.id,result.messageId)
  assert.equal(j.authorizeClaim('requester-session',send.message,send.outboxId),true)
  assert.equal(j.authorizeClaim('worker-session',send.message,send.outboxId),false)
  assert.equal(j.authorizeClaim('requester-session',{...send.message,content:[]},send.outboxId),false)
  assert.deepEqual(await j.beginSend(f.binding),{state:'unknown'})
  assert.equal((await j.inspect(f.binding)).state,'unknown','sending is never inferred as delivered')
  f.rotate();assert.equal(j.authorizeClaim('requester-session',send.message,send.outboxId),false)
})

test('missing original requester Session and duplicate original replies refuse binding',async t=>{
  const f=fixture(t),j=f.open();delete f.state.works['work-1'].fromSession
  await assert.rejects(j.reserve(f.binding),/route unavailable/)
  f.state.works['work-1'].fromSession='requester-session'
  f.targetEvents.push({seq:0,type:'user/message',data:{source:{replyTo:'work-1'}}})
  await assert.rejects(j.reserve(f.binding),/uncertain/)
  assert.equal(f.state.workResultOutbox,undefined)
})

test('wrong result, incomplete turn, mixed input or changed work cannot close original',async t=>{
  const f=fixture(t),j=f.open();await j.reserve(f.binding);const ref=f.finish()
  await assert.rejects(j.stageResult(f.binding,{...ref,resultDigest:digest('wrong')}),/result unavailable/)
  f.workerEvents[ref.endSeq].data.reason={kind:'max-tokens'}
  await assert.rejects(j.stageResult(f.binding,ref),/cannot be verified/)
  f.workerEvents[ref.endSeq].data.reason={kind:'completed'}
  f.workerEvents.splice(ref.endSeq,0,{seq:ref.endSeq,type:'user/message',data:{id:'other'}})
  f.workerEvents[ref.endSeq+1].seq=ref.endSeq+1
  await assert.rejects(j.stageResult(f.binding,{...ref,endSeq:ref.endSeq+1}),/cannot be verified/)
  assert.ok(f.state.works['work-1']);assert.deepEqual(f.state.works.parent.results,[])
})

test('failed save retains unknown rather than reusing a sending identity',async t=>{
  const f=fixture(t),j=f.open();await j.reserve(f.binding);await j.stageResult(f.binding,f.finish())
  f.setMode('after')
  assert.deepEqual(await j.beginSend(f.binding),{state:'unknown'})
  f.setMode('normal')
  assert.equal((await j.inspect(f.binding)).state,'unknown')
  assert.deepEqual(await j.beginSend(f.binding),{state:'unknown'})
  const next=f.open();assert.deepEqual(await next.beginSend(f.binding),{state:'unknown'})
  assert.equal(f.onDisk().workResultOutbox[workResultIdentity(f.binding).outboxId].state,'sending')
})

test('a changed lease and mismatched persisted prefix refuse the result',async t=>{
  const f=fixture(t),j=f.open();await j.reserve(f.binding);const ref=f.finish()
  f.workerEvents[ref.startSeq].seq=99
  await assert.rejects(j.stageResult(f.binding,ref),/prefix changed/)
  f.workerEvents[ref.startSeq].seq=ref.startSeq
  f.lose();await assert.rejects(j.stageResult(f.binding,ref),/lock lost/)
  assert.ok(f.state.works['work-1'])
})

test('an unconfirmed result snapshot is not promoted to a send after an error or restart',async t=>{
  const f=fixture(t),j=f.open();await j.reserve(f.binding);const ref=f.finish()
  f.setMode('after');await assert.rejects(j.stageResult(f.binding,ref),/unknown/);f.setMode('normal')
  assert.deepEqual(await j.beginSend(f.binding),{state:'unknown'})
  assert.deepEqual(await j.inspect(f.binding),{state:'unknown'})
  const restarted=f.open();assert.deepEqual(await restarted.beginSend(f.binding),{state:'unknown'})
  assert.deepEqual(await restarted.inspect(f.binding),{state:'unknown'})
})

test('a competing reply after reservation fences guarded send and claim',async t=>{
  const f=fixture(t),j=f.open();await j.reserve(f.binding);await j.stageResult(f.binding,f.finish())
  f.targetEvents.push({seq:0,type:'user/message',data:{id:'different-reply',source:{replyTo:'work-1'}}})
  assert.deepEqual(await j.beginSend(f.binding),{state:'unknown'})
})

test('a competing reply arriving after preparation fences the guarded claim',async t=>{
  const f=fixture(t),j=f.open();await j.reserve(f.binding);await j.stageResult(f.binding,f.finish())
  const send=await j.beginSend(f.binding);assert.equal(send.state,'ready')
  f.targetEvents.push({seq:0,type:'user/message',data:{id:'different-reply',source:{replyTo:'work-1'}}})
  assert.equal(j.authorizeClaim('requester-session',send.message,send.outboxId),false)
})

test('concurrent reservations admit one writer for the same original work',async t=>{
  const f=fixture(t),j=f.open(),other={...f.binding,recoveryId:'b'.repeat(64)}
  const outcomes=await Promise.allSettled([j.reserve(f.binding),j.reserve(other)])
  assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1)
  assert.equal(outcomes.filter(x=>x.status==='rejected').length,1)
  assert.equal(Object.keys(f.state.workResultOutbox).length,1)
})

test('original Session changes while reservation is saved do not confirm the route',async t=>{
  const f=fixture(t),j=f.open()
  f.onSave(async()=>{f.targetEvents.push({seq:0,type:'user/message',data:{id:'late-reply',source:{replyTo:'work-1'}}})})
  await assert.rejects(j.reserve(f.binding),/outcome is unknown/)
  assert.deepEqual(await j.inspect(f.binding),{state:'unknown'})
})

test('target Session changes while send intent is saved cannot authorize a claim',async t=>{
  const f=fixture(t),j=f.open();await j.reserve(f.binding);await j.stageResult(f.binding,f.finish())
  f.onSave(async()=>{f.targetEvents.push({seq:0,type:'user/message',data:{id:'late-reply',source:{replyTo:'work-1'}}})})
  assert.deepEqual(await j.beginSend(f.binding),{state:'unknown'})
  const outboxId=workResultIdentity(f.binding).outboxId, entry=f.state.workResultOutbox[outboxId]
  assert.equal(j.authorizeClaim('requester-session',entry.message,outboxId),false)
})

test('work changes while target prefix is read fence the send',async t=>{
  const f=fixture(t),j=f.open();await j.reserve(f.binding);await j.stageResult(f.binding,f.finish())
  const old=f.rt.ctx.get('sessionPersistence').flushLiveSession
  f.rt.ctx.get('sessionPersistence').flushLiveSession=async id=>{await old(id);f.state.works.parent.open=[]}
  assert.deepEqual(await j.beginSend(f.binding),{state:'unknown'})
})

test('a replaced target Session or already consumed reply cannot claim',async t=>{
  const f=fixture(t),j=f.open();await j.reserve(f.binding);await j.stageResult(f.binding,f.finish())
  const send=await j.beginSend(f.binding);assert.equal(send.state,'ready')
  const old=f.sessions.get('requester-session')
  f.sessions.set('requester-session',{...old,eventAt:index=>f.targetEvents[index]})
  assert.equal(j.authorizeClaim('requester-session',send.message,send.outboxId),false)
  f.sessions.set('requester-session',old)
  f.targetEvents.push({seq:0,type:'user/message',data:copy(send.message)})
  assert.equal(j.authorizeClaim('requester-session',send.message,send.outboxId),false)
})
