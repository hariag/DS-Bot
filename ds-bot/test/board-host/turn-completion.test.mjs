import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync,rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openTaskStore } from '../../src/host/task-store.mjs'
import { createTaskActionContext } from '../../src/host/task-action-context.mjs'
import { createTaskTurnCompletion } from '../../src/host/task-turn-completion.mjs'
import { createTaskCooperativeGate } from '../../src/host/task-cooperative-gate.mjs'

function fixture(t,{confirm}={}) {
  const dir=mkdtempSync(join(tmpdir(),'dsbot-turn-end-'));let finisher,wakes=0,errors=[]
  const store=openTaskStore(join(dir,'db.sqlite'),{enableExplicitTasks:true,assertExclusiveUpgrade(){},assertWriteLock(){},
    authorize:input=>input.actor!=='host'||input.type==='guarded-recovery'||finisher?.authorize(input)===true,verifyUserTask:()=>true,verifyAdmission:()=>true,verifyEvidence:()=>true,
    verifyTurnCompletion:(task,action,proof,actor)=>finisher?.verify(task,action,proof,actor)===true})
  t.after(async()=>{await finisher?.close();store.close();rmSync(dir,{recursive:true,force:true})})
  store.createExplicit({operationId:'create',actor:'user',task:{id:'t',scope:'room:r',owner:'owner',reviewer:'reviewer',title:'work',acceptance:'proof',dependencies:[]},execution:{mode:'write',workspace:'ws',paths:['src']}})
  const action=store.listActions('t')[0],session={id:'session'},agent={id:'session',session,guardedClaimTurnVersion:1}
  const context=createTaskActionContext(store),position={turn:1,turnStartSeq:3}
  let disposed=0,seen
  finisher=createTaskTurnCompletion({store,actionContext:context,assertLease(){},wake(){wakes++},onError(error){errors.push(error)},
    beginReceipt(){return {async confirm(event){seen=event;await confirm?.()},dispose(){disposed++}}}})
  const payload={id:'msg',role:'user',content:[{type:'text',text:'work'}],source:{kind:'bot'}}
  const intent={admissionId:'admission',messageId:'msg',targetBotId:'owner',targetSessionId:'session',payload}
  store.claimAction({actionId:action.id,actor:'scheduler',intent})
  store.fencedGuardedClaim({sessionId:'session',inputs:[{admissionId:'admission',message:payload,target:'next-turn'}],actor:'scheduler',context:{sessionGeneration:context.generation(agent),...position}},()=>{})
  finisher.activate(agent,position)
  store.command({operationId:'start',taskId:'t',expectedRevision:1,actor:'owner',type:'start'})
  store.command({operationId:'report',taskId:'t',expectedRevision:2,actor:'owner',type:'report',value:{kind:'personal',evidence:'artifact',environment:'test'}})
  const event={type:'turn/end',seq:7,data:{turn:1,reason:{kind:'completed'}}}
  return {store,action,session,context,finisher,event,get wakes(){return wakes},get errors(){return errors},get disposed(){return disposed},get seen(){return seen}}
}

test('a report holds the writer until the exact turn-end receipt is durable',async t=>{
  let release;const wait=new Promise(resolve=>{release=resolve}),f=fixture(t,{confirm:()=>wait})
  f.finisher.observe(f.session,f.event);f.context.observe(f.session,f.event)
  await new Promise(resolve=>setImmediate(resolve))
  assert.equal(f.store.currentWriteLease()?.task.id,'t');assert.equal(f.store.listActions('t').some(a=>a.kind==='review'),false)
  assert.equal(f.seen,f.event);release()
  for(let i=0;i<20&&!f.wakes;i++)await new Promise(resolve=>setTimeout(resolve,5))
  assert.equal(f.wakes,1);assert.equal(f.store.currentWriteLease(),undefined)
  assert.equal(f.store.listActions('t').find(a=>a.kind==='review')?.actor,'reviewer');assert.equal(f.disposed,1)
})

test('a failed durable receipt never releases the lease or creates a review',async t=>{
  const f=fixture(t,{confirm:async()=>{throw Error('receipt unavailable')}})
  f.finisher.observe(f.session,f.event);f.context.observe(f.session,f.event)
  for(let i=0;i<20&&!f.errors.length;i++)await new Promise(resolve=>setTimeout(resolve,5))
  assert.equal(f.errors.length,1);assert.equal(f.store.currentWriteLease()?.task.id,'t')
  assert.equal(f.store.listActions('t').some(a=>a.kind==='review'),false);assert.equal(f.wakes,0)
})

test('an interrupted or wrong turn never releases the write lease',async t=>{
  const f=fixture(t)
  f.finisher.observe(f.session,{...f.event,data:{turn:1,reason:{kind:'interrupted'}}})
  await new Promise(resolve=>setImmediate(resolve))
  assert.equal(f.store.currentWriteLease()?.task.id,'t');assert.equal(f.wakes,0);assert.equal(f.disposed,1)
})

async function startReview(f) {
  f.store.createExplicit({operationId:'dependent',actor:'user',task:{id:'child',scope:'room:r',owner:'next',reviewer:'other',title:'next',acceptance:'proof',dependencies:['t']},execution:{mode:'write',workspace:'ws',paths:['src']}})
  f.finisher.observe(f.session,f.event);f.context.observe(f.session,f.event)
  for(let i=0;i<50&&!f.store.listActions('t').some(a=>a.kind==='review');i++)await new Promise(resolve=>setTimeout(resolve,5))
  const review=f.store.listActions('t').find(a=>a.kind==='review')
  assert.ok(review)
  const session={id:'review-session'},agent={id:'review-session',session,guardedClaimTurnVersion:1},position={turn:2,turnStartSeq:20}
  const payload={id:'review-msg',role:'user',content:[{type:'text',text:'review'}],source:{kind:'bot'}}
  f.store.claimAction({actionId:review.id,actor:'scheduler',intent:{admissionId:'review-admission',messageId:payload.id,targetBotId:'reviewer',targetSessionId:session.id,payload}})
  f.store.fencedGuardedClaim({sessionId:session.id,inputs:[{admissionId:'review-admission',message:payload,target:'next-turn'}],actor:'scheduler',context:{sessionGeneration:f.context.generation(agent),...position}},()=>{})
  f.finisher.activate(agent,position)
  f.store.command({operationId:'review',taskId:'t',expectedRevision:3,actor:'reviewer',type:'review',value:{result:'pass',evidence:'independent'}})
  return {session,agent,event:{type:'turn/end',seq:25,data:{turn:2,reason:{kind:'completed'}}}}
}

test('review stays read-only and dependents wait for the durable review turn end',async t=>{
  let calls=0,release;const hold=new Promise(resolve=>{release=resolve})
  const f=fixture(t,{confirm:()=>++calls===2?hold:undefined}),review=await startReview(f)
  const gate=createTaskCooperativeGate({store:f.store,actionContext:f.context,resolveBot:sid=>sid==='review-session'?'reviewer':'other',assertLease(){}})
  const attempt={name:'shell',agent:review.agent}
  assert.ok(gate.guard(attempt));await assert.rejects(()=>gate.execute(attempt,()=>Promise.resolve()),/lease changed/)
  assert.equal(f.store.get('t').status,'reported');assert.equal(f.store.get('child').status,'waiting')
  f.finisher.observe(review.session,review.event);f.context.observe(review.session,review.event)
  await new Promise(resolve=>setImmediate(resolve))
  assert.equal(f.store.get('child').status,'waiting');release()
  for(let i=0;i<50&&f.store.get('t').status!=='done';i++)await new Promise(resolve=>setTimeout(resolve,5))
  assert.equal(f.store.get('t').status,'done');assert.equal(f.store.get('child').status,'ready')
})

test('an interrupted review never completes or unlocks a dependent',async t=>{
  const f=fixture(t),review=await startReview(f)
  f.finisher.observe(review.session,{...review.event,data:{turn:2,reason:{kind:'interrupted'}}})
  f.context.observe(review.session,review.event)
  await new Promise(resolve=>setImmediate(resolve))
  assert.equal(f.store.get('t').status,'reported');assert.equal(f.store.get('child').status,'waiting')
  assert.equal(f.store.currentReviewLease()?.state,'accepted')
  f.store.holdGuardedAfterRestart({actor:'host'})
  assert.equal(f.store.get('t').status,'reported');assert.equal(f.store.get('child').status,'waiting')
  assert.equal(f.store.currentReviewLease()?.state,'uncertain')
})
