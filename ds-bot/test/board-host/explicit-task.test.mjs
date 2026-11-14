import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openTaskStore } from '../../src/host/task-store.mjs'

const policy = { enableExplicitTasks:true, assertExclusiveUpgrade(){}, assertWriteLock(){}, authorize:()=>true, verifyUserTask:()=>true, verifyTurnCompletion:()=>true,
  verifyAdmission:()=>true, verifyReceipt:()=>true, verifyRegistration:()=>true, verifyEvidence:()=>true }
const proposal = (id,dependencies=[]) => ({id,title:`work ${id}`,owner:'writer',reviewer:'tester',scope:'room:r',acceptance:'verified delivery',dependencies})
const execution = {mode:'write',workspace:'ws',paths:['src/feature']}
const create = (store,id,dependencies=[]) => store.createExplicit({operationId:`create-${id}`,actor:'user',task:proposal(id,dependencies),execution})
const intent = action => ({admissionId:`admit-${action.id}`,messageId:`message-${action.id}`,targetBotId:action.actor,targetSessionId:`session-${action.actor}`,payload:{id:`message-${action.id}`,role:'user',content:[{type:'text',text:'work'}],source:{kind:'bot'}}})
function fixture(t, options=policy){const dir=mkdtempSync(join(tmpdir(),'explicit-task-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const path=join(dir,'tasks.sqlite');const store=openTaskStore(path,options);t.after(()=>{try{store.close()}catch{}});return {path,store}}

test('explicit creation atomically records one task and one action and excludes older writers', t=>{
  const {store,path}=fixture(t)
  const first=create(store,'one');assert.equal(first.status,'ready');assert.equal(first.execution.mode,'write')
  assert.deepEqual(create(store,'one'),first);assert.equal(store.listActions('one').length,1)
  assert.throws(()=>store.createExplicit({operationId:'create-one',actor:'user',task:{...proposal('one'),title:'different'},execution}),/operation id conflict/)
  store.close()
  assert.throws(()=>openTaskStore(path,{...policy,enableExplicitTasks:false}),/unknown or damaged/)
  const reopened=openTaskStore(path,policy);t.after(()=>reopened.close())
  assert.equal(reopened.listActions('one').length,1)
})

test('guarded v5 upgrade preserves existing proposed tasks and blocks older hosts', t=>{
  const {store,path}=fixture(t,{...policy,enableExplicitTasks:false})
  const prior=store.create({operationId:'old-create',actor:'user',task:proposal('legacy')})
  store.close()
  assert.throws(()=>openTaskStore(path,{...policy,assertExclusiveUpgrade(){throw Error('old writer present')}}),/old writer present/)
  const unchanged=openTaskStore(path,{...policy,enableExplicitTasks:false});assert.deepEqual(unchanged.get('legacy'),prior);unchanged.close()
  const migrated=openTaskStore(path,policy);t.after(()=>migrated.close())
  assert.deepEqual(migrated.get('legacy'),prior)
  assert.equal(create(migrated,'new').status,'ready')
  assert.equal(migrated.get('legacy').status,'proposed')
  assert.throws(()=>openTaskStore(path,{...policy,enableExplicitTasks:false}),/unknown or damaged/)
})

test('waiting dependency retains its action and report holds the write lease through turn completion', t=>{
  const {store}=fixture(t);create(store,'first');const waiting=create(store,'second',['first']);create(store,'parallel')
  assert.equal(waiting.status,'waiting');const next=store.listActions('second')[0]
  const execute=store.listActions('first')[0];store.claimAction({actionId:execute.id,actor:'scheduler',intent:intent(execute)})
  assert.equal(store.currentWriteLease()?.task.id,'first')
  store.markAction({actionId:execute.id,actor:'host',expectedState:'claimed',state:'accepted',receipt:'verified'})
  const cmd=(id,type,actor,value)=>store.command({operationId:`${type}-${id}`,taskId:id,expectedRevision:store.get(id).revision,actor,type,...(value?{value}:{})})
  cmd('first','start','writer');cmd('first','report','writer',{kind:'personal',evidence:'artifact',environment:'isolated'})
  assert.equal(store.currentWriteLease()?.task.id,'first')
  assert.equal(store.listActions('first').some(item=>item.kind==='review'),false)
  const parallel=store.listActions('parallel')[0]
  assert.throws(()=>store.claimAction({actionId:parallel.id,actor:'scheduler',intent:intent(parallel)}),/write lease unavailable/)
  store.finishExplicitTurn({operationId:'finish-first',actor:'host',taskId:'first',expectedRevision:store.get('first').revision,proof:{turn:1}})
  assert.equal(store.currentWriteLease(),undefined)
  const review=store.listActions('first').find(item=>item.kind==='review');assert.equal(review.actor,'tester')
  store.claimAction({actionId:review.id,actor:'scheduler',intent:intent(review)})
  store.markAction({actionId:review.id,actor:'host',expectedState:'claimed',state:'accepted',receipt:'verified'})
  cmd('first','review','tester',{evidence:'independent',result:'pass'})
  assert.equal(store.get('second').status,'ready');assert.equal(store.listActions('second').length,1);assert.equal(store.listActions('second')[0].id,next.id)
})

test('an explicitly cancelled pending action gets a new identity on unblock', t=>{
  const {store}=fixture(t);create(store,'first')
  const before=store.listActions('first')[0]
  store.command({operationId:'block',taskId:'first',expectedRevision:store.get('first').revision,actor:'writer',type:'block',value:{reason:'wait',condition:'ready',owner:'writer'}})
  store.command({operationId:'unblock',taskId:'first',expectedRevision:store.get('first').revision,actor:'writer',type:'unblock'})
  const actions=store.listActions('first')
  assert.equal(store.get('first').status,'ready');assert.equal(actions.find(item=>item.id===before.id).state,'cancelled')
  assert.equal(actions.filter(item=>item.state==='pending').length,1);assert.notEqual(actions.find(item=>item.state==='pending').id,before.id)
})

test('unknown prior write retains cooperative lease without blocking task creation', t=>{
  const {store}=fixture(t);create(store,'a');create(store,'b')
  const a=store.listActions('a')[0],b=store.listActions('b')[0]
  store.claimAction({actionId:a.id,actor:'scheduler',intent:intent(a)})
  store.markAction({actionId:a.id,actor:'host',expectedState:'claimed',state:'uncertain',receipt:'unknown'})
  assert.equal(store.currentWriteLease()?.state,'uncertain')
  assert.throws(()=>store.claimAction({actionId:b.id,actor:'scheduler',intent:intent(b)}),/write lease unavailable/)
  assert.equal(store.listActions('b')[0].state,'pending')
})

test('denied or lock-lost creation commits neither task nor action', t=>{
  let failing=false
  const opts={...policy,verifyUserTask(){failing=true;return true},assertWriteLock(){if(failing)throw Error('lease lost')}}
  const {store}=fixture(t,opts)
  assert.throws(()=>create(store,'blocked'),/lease lost/);failing=false
  assert.equal(store.get('blocked'),undefined);assert.deepEqual(store.listActions('blocked'),[])
  assert.throws(()=>store.createExplicit({operationId:'user-card',actor:'user',task:{...proposal('user'),owner:'user'},execution}),/Bot owner/)
})
