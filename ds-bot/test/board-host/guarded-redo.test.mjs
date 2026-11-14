import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { openGuardedRedoJournal, redoIdentity, redoSnapshot } from '../../src/host/guarded-redo-journal.mjs'
import { createGuardedRedoBridge, sharedGuardedCoordinator } from '../../src/host/guarded-redo-bridge.mjs'
import { createTargetWriterRedoProof } from '../../src/host/guarded-redo-proof.mjs'

const stable = value => JSON.stringify(value,function(_key,current){return current&&typeof current==='object'&&!Array.isArray(current)?Object.fromEntries(Object.entries(current).sort(([a],[b])=>a<b?-1:a>b?1:0)):current})
const hash = value => createHash('sha256').update(stable(value)).digest('hex')
function fixture(t){
  const home=mkdtempSync(join(tmpdir(),'guarded-redo-')), path=join(home,'redo.sqlite')
  const source={kind:'bot',role:'request',exchangeId:'work-1',senderSessionId:'sender',roomId:'room'}
  const content=[{type:'text',text:'Original requested work'}]
  const binding={recoveryId:'a'.repeat(64),scope:{kind:'room',id:'room'},sessionId:'session',turn:7,messageSeq:3,throughSeq:9,originalMessageId:'original-message',exchangeId:'work-1',workId:'work-1',senderId:'sender',recipientId:'receiver',roomId:'room',sourceHash:hash({source,content})}
  const identity=redoIdentity(binding),original={role:'user',id:'original-message',source,content}
  const message={...original,id:identity.messageId}
  let owns=true, allowed=true, settled=true, journal
  const opts={assertLease:()=>owns,authorizeIntent:()=>allowed,authorizeClaim:()=>allowed}
  const reopen=()=>{journal?.close();journal=openGuardedRedoJournal(path,opts);return journal}
  reopen()
  const agent={id:'session',session:{id:'session'},durableAdmissionVersion:1,guardedClaimTurnVersion:1}
  const proof={complete:true,durability:'target-writer-v1',originalOutcome:'failed',sessionId:'session',throughSeq:9,messageSeq:3,turn:7,message:original,isCurrent:()=>true}
  const bridge=()=>createGuardedRedoBridge({enabled:true,journal,verifyOriginal:async()=>proof,resolveAgent:async()=>agent,isCurrent:()=>owns&&allowed,resultAuthority:()=>settled?{version:'durable-original-result-v1',claimOriginalResult(){},readResultReceipt(){},isCurrent:()=>true}:undefined,isResultRouterBound:()=>true,makeMessage:(m,id)=>({...m,id}),leaseVersion:()=>owns?1:2,coordinatorReady:()=>true})
  t.after(()=>{journal?.close();rmSync(home,{recursive:true,force:true})})
  return {binding,identity,message,proof,agent,bridge,reopen,path,get journal(){return journal},lose(){owns=false},revoke(){allowed=false},noSettlement(){settled=false}}
}

test('redo uses one guarded message and duplicate requests cannot enqueue again',async t=>{
  const f=fixture(t), queue=[];let claimed=0
  const coordinator=sharedGuardedCoordinator({sessionId:'session',agent:f.agent,redoJournal:f.journal,otherCoordinator:()=>{throw Error('not board')},isCurrent:()=>true})
  f.agent.guardedSend=async(message,target,admissionId)=>{queue.push(message);assert.equal(target,'next-turn');assert.equal(coordinator('session',[{message,target,admissionId}],()=>{claimed+=1},{turn:8,turnStartSeq:20}),'committed')}
  const bridge=f.bridge()
  assert.equal((await bridge.request({binding:f.binding,confirmed:true})).state,'submitted')
  assert.equal(claimed,1);assert.equal(queue.length,1)
  assert.equal((await bridge.request({binding:f.binding,confirmed:true})).state,'unknown')
  assert.equal(queue.length,1)
  assert.deepEqual(queue[0].content,f.message.content)
  assert.deepEqual(queue[0].source,f.message.source)
  assert.equal(f.journal.inspect({binding:f.binding,message:f.message}).state,'unknown')
})

test('missing authority, confirmation, exact prefix or settlement capability fails before admission',async t=>{
  const f=fixture(t);let calls=0;f.agent.guardedSend=async()=>{calls+=1}
  assert.equal((await f.bridge().request({binding:f.binding,confirmed:false})).state,'unavailable')
  f.proof.durability='unverified'
  assert.equal((await f.bridge().request({binding:f.binding,confirmed:true})).state,'unavailable')
  f.proof.durability='target-writer-v1';f.noSettlement()
  assert.equal((await f.bridge().request({binding:f.binding,confirmed:true})).state,'unavailable')
  assert.equal(calls,0)
})

test('a mixed board/redo batch is rejected before claiming anything',t=>{
  const f=fixture(t);let claimed=0,other=0
  const route=sharedGuardedCoordinator({sessionId:'session',agent:f.agent,redoJournal:f.journal,otherCoordinator:()=>{other+=1;return 'committed'},isCurrent:()=>true})
  const redo={admissionId:f.identity.admissionId,target:'next-turn',message:f.message}
  assert.throws(()=>route('session',[redo,{admissionId:'board:1',message:{id:'other'}}],()=>{claimed+=1},{turn:8,turnStartSeq:20}),/mixed/)
  assert.equal(claimed,0);assert.equal(other,0)
  assert.equal(route('session',[{admissionId:'board:1',message:{id:'other'}}],()=>{claimed+=1},{turn:8,turnStartSeq:20}),'committed')
  assert.equal(other,1)
})

test('lost guarded-send result remains unknown across journal restart',async t=>{
  const f=fixture(t);let sends=0
  f.agent.guardedSend=async()=>{sends+=1;throw Error('outcome lost after enqueue')}
  assert.equal((await f.bridge().request({binding:f.binding,confirmed:true})).state,'unknown')
  f.reopen()
  assert.equal((await f.bridge().request({binding:f.binding,confirmed:true})).state,'unknown')
  assert.equal(sends,1)
})

test('a failed claim after the callback stays fenced and cannot be claimed twice',t=>{
  const f=fixture(t), input={admissionId:f.identity.admissionId,target:'next-turn',message:f.message}, turn={turn:8,turnStartSeq:20}
  f.journal.reserve({binding:f.binding,message:f.message,confirmed:true});f.journal.beginSend({binding:f.binding,message:f.message})
  let called=0
  assert.throws(()=>f.journal.claim('session',input,turn,()=>{called+=1;throw Error('failed after claim')}),/failed after claim/)
  assert.throws(()=>f.journal.claim('session',input,turn,()=>{called+=1}),/already reserved/)
  assert.equal(called,1)
  f.reopen()
  assert.equal(f.journal.inspect({binding:f.binding,message:f.message}).state,'unknown')
  assert.throws(()=>f.journal.claim('session',input,turn,()=>{called+=1}),/already reserved/)
  assert.equal(called,1)
})

test('scope changes, incomplete content and changed source cannot reuse an identity',t=>{
  const f=fixture(t)
  f.journal.reserve({binding:f.binding,message:f.message,confirmed:true})
  assert.throws(()=>f.journal.reserve({binding:{...f.binding,scope:{kind:'personal',id:'receiver'}},message:f.message,confirmed:true}),/conflict/)
  assert.throws(()=>f.journal.beginSend({binding:f.binding,message:{...f.message,content:[{type:'text',text:'different'}]}}),/changed/)
  assert.throws(()=>f.journal.beginSend({binding:f.binding,message:{...f.message,content:[{type:'image',attachment:'private'}]}}),/unsupported/)
  f.revoke();assert.throws(()=>f.journal.beginSend({binding:f.binding,message:f.message}),/unauthorized|unavailable/)
})

test('redo snapshots reject lossy JSON and use locale-independent key order',()=>{
  assert.throws(()=>redoSnapshot({number:-0}),/non-JSON/)
  const bad=['first'];bad['00']='silently ignored by JSON'
  assert.throws(()=>redoSnapshot(bad),/array/)
  assert.throws(()=>redoSnapshot({n:Number.MAX_SAFE_INTEGER+1}),/non-JSON/)
  assert.deepEqual(Object.keys(redoSnapshot({é:1,z:2,A:3})),['A','z','é'])
})

test('only the exact complete target-writer prefix proves an interrupted original input',async t=>{
  const f=fixture(t),original={...f.message,id:f.binding.originalMessageId}
  let events=[
    {seq:0,type:'agent/inbox/spliced',data:{target:'next-turn',start:0,removedCount:0,inserted:[original]}},
    {seq:1,type:'turn/start',data:{turn:7}},
    {seq:2,type:'agent/inbox/spliced',data:{target:'next-turn',start:0,removedCount:1,inserted:[]}},
    {seq:3,type:'user/message',data:original},
    {seq:4,type:'turn/end',data:{turn:7,reason:{kind:'error'}}},
    ...Array.from({length:4},(_,i)=>({seq:i+5,type:'fixture/event',data:{}})),
  ]
  let live=true,flushes=0
  const session={seq:9,eventAt:index=>events[index]}
  const writer={flushLiveSession:async id=>{assert.equal(id,'session');flushes+=1},open:async()=>({read:async()=>({events}),close:async()=>{}})}
  const ctx={sessions:{get:id=>id==='session'?session:undefined},get:name=>name==='sessionPersistence'?writer:undefined}
  const verify=createTargetWriterRedoProof({ctx,assertLease:()=>true,leaseVersion:()=>1,authorizeCurrent:()=>live})
  const proof=await verify(f.binding)
  assert.equal(proof?.originalOutcome,'failed');assert.equal(proof?.isCurrent(),true);assert.equal(flushes,1)
  live=false;assert.equal(proof.isCurrent(),false);assert.equal(await verify(f.binding),undefined);live=true
  const good=events
  events=good.slice(0,-1);assert.equal(await verify(f.binding),undefined)
  events=structuredClone(good);events[4].data.reason={kind:'completed'};assert.equal(await verify(f.binding),undefined)
  events=structuredClone(good);events[3].data.content=[{type:'text',text:'changed'}];assert.equal(await verify(f.binding),undefined)
  events=good;writer.flushLiveSession=async()=>{session.seq+=1};assert.equal(await verify(f.binding),undefined)
})

test('process death inside claim leaves a durable fence, not a replayable admission',t=>{
  const f=fixture(t),input={admissionId:f.identity.admissionId,target:'next-turn',message:f.message},turn={turn:8,turnStartSeq:20}
  f.journal.reserve({binding:f.binding,message:f.message,confirmed:true})
  f.journal.beginSend({binding:f.binding,message:f.message})
  const moduleUrl=pathToFileURL(new URL('../../src/host/guarded-redo-journal.mjs',import.meta.url).pathname).href
  const script=`import {openGuardedRedoJournal} from ${JSON.stringify(moduleUrl)};
    const journal=openGuardedRedoJournal(process.argv[1],{assertLease:()=>true,authorizeIntent:()=>true,authorizeClaim:()=>true});
    journal.claim('session',${JSON.stringify(input)},${JSON.stringify(turn)},()=>process.exit(42));`
  const child=spawnSync(process.execPath,['--input-type=module','-e',script,f.path],{encoding:'utf8',env:{PATH:process.env.PATH}})
  assert.equal(child.status,42,child.stderr)
  f.reopen()
  assert.equal(f.journal.inspect({binding:f.binding,message:f.message}).state,'unknown')
  assert.throws(()=>f.journal.claim('session',input,turn,()=>{}),/already reserved/)
})
