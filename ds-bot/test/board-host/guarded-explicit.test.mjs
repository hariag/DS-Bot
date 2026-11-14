import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openTaskStore } from '../../src/host/task-store.mjs'
import { createTaskActionContext } from '../../src/host/task-action-context.mjs'

function setup(t) {
  const dir=mkdtempSync(join(tmpdir(),'explicit-guarded-'))
  let writable=true
  const policy={enableExplicitTasks:true,assertExclusiveUpgrade(){},assertWriteLock(){if(!writable)throw Error('lease lost')},
    authorize:()=>true,verifyUserTask:()=>true,verifyTurnCompletion:()=>true,verifyAdmission:()=>true,verifyEvidence:()=>true,verifyReceipt:()=>true}
  const store=openTaskStore(join(dir,'board.sqlite'),policy)
  t.after(()=>{try{store.close()}catch{};rmSync(dir,{recursive:true,force:true})})
  store.createExplicit({operationId:'create',actor:'user',task:{id:'t',scope:'room:r',owner:'owner',reviewer:'reviewer',title:'test',acceptance:'proof',dependencies:[]},execution:{mode:'write',workspace:'ws',paths:['src']}})
  const action=store.listActions('t')[0]
  const payload={id:'message',role:'user',content:[{type:'text',text:'do work'}],source:{kind:'bot'}}
  const intent={admissionId:'admission',messageId:payload.id,targetBotId:'owner',targetSessionId:'session',payload}
  store.claimAction({actionId:action.id,actor:'scheduler',intent})
  const input={admissionId:intent.admissionId,message:payload,target:'next-turn'}
  return {store,action,input,lose(){writable=false},dir,policy}
}

test('explicit action cannot be consumed without trustworthy turn identity and consumes once with it', t=>{
  const {store,action,input}=setup(t)
  let calls=0
  assert.throws(()=>store.fencedGuardedClaim({sessionId:'session',inputs:[input],actor:'scheduler'},()=>{calls++}),/turn identity unavailable/)
  assert.equal(store.admission(action.id).state,'claimed');assert.equal(calls,0)
  const context={sessionGeneration:'generation-1',turn:3,turnStartSeq:15}
  assert.equal(store.fencedGuardedClaim({sessionId:'session',inputs:[input],actor:'scheduler',context},()=>{calls++}),'committed')
  assert.equal(calls,1);assert.deepEqual(store.guardedContext(action.id),{sessionId:'session',...context})
  assert.throws(()=>store.fencedGuardedClaim({sessionId:'session',inputs:[input],actor:'scheduler',context},()=>{calls++}))
  assert.equal(calls,1)
})

test('task tools bind to exact session object and turn, and end or replacement revokes access', t=>{
  const {store,action,input}=setup(t)
  let events=[{type:'turn/start',seq:15,data:{turn:3}},{type:'step/start',seq:16,data:{}}]
  const session={id:'session',snapshotEvents:()=>events}, agent={id:'session',session,guardedClaimTurnVersion:1}
  const authority=createTaskActionContext(store), caller={actor:'owner',sid:'session'},task=store.get('t')
  const context={sessionGeneration:authority.generation(agent),turn:3,turnStartSeq:15}
  store.fencedGuardedClaim({sessionId:'session',inputs:[input],actor:'scheduler',context},()=>{})
  authority.activate(agent,context)
  assert.equal(authority.verify(task,caller,'start',{agent}),true)
  const other={...agent,session:{id:'session',snapshotEvents:()=>events}}
  assert.equal(authority.verify(task,caller,'start',{agent:other}),false)
  events=[...events,{type:'turn/end',seq:17,data:{turn:3}}]
  authority.observe(session,events.at(-1))
  assert.equal(authority.verify(task,caller,'start',{agent}),false)
  events=[...events,{type:'turn/start',seq:18,data:{turn:4}}]
  assert.equal(authority.verify(task,caller,'start',{agent}),false)
  assert.equal(authority.verify(task,{...caller,actor:'reviewer'},'review',{agent}),false)
})

test('failed guarded claim stays uncertain and old generation cannot authorize after recovery', t=>{
  const {store,action,input}=setup(t)
  assert.throws(()=>store.fencedGuardedClaim({sessionId:'session',inputs:[input],actor:'scheduler',context:{sessionGeneration:'generation-1',turn:3,turnStartSeq:15}},()=>{throw Error('interrupted')}))
  assert.equal(store.admission(action.id).state,'uncertain')
  assert.equal(store.guardedContext(action.id),undefined)
  assert.throws(()=>store.fencedGuardedClaim({sessionId:'session',inputs:[input],actor:'scheduler',context:{sessionGeneration:'generation-2',turn:3,turnStartSeq:15}},()=>{}))
})
