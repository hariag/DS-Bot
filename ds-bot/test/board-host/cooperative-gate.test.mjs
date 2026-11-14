import test from 'node:test'
import assert from 'node:assert/strict'
import { createTaskCooperativeGate } from '../../src/host/task-cooperative-gate.mjs'

const exec=(id,name='shell')=>({agent:{id},name})
function fixture(){
  let lease, locked=true
  const store={currentWriteLease:()=>lease}
  const gate=createTaskCooperativeGate({store,resolveBot:sid=>({s1:'owner',s2:'other'})[sid],
    actionContext:{verify:(_task,caller,_operation,call)=>caller.sid==='s1'&&call.bound===true},assertLease(){if(!locked)throw Error('lost')}})
  return {gate,set(value){lease=value},lose(){locked=false}}
}
test('a running earlier Bot tool holds up a new claim until the body ends',async()=>{
  const {gate}=fixture();let release,entered
  const inBody=new Promise(r=>{entered=r}),continueBody=new Promise(r=>{release=r})
  const pending=gate.execute(exec('s2'),async()=>{entered();await continueBody;return 'done'})
  await inBody;assert.equal(gate.mayClaim(),false);assert.equal(gate.activeCount(),1)
  release();assert.equal(await pending,'done');assert.equal(gate.mayClaim(),true)
})
test('a lease acquired after early approval prevents another Bot body starting',async()=>{
  const {gate,set}=fixture(),call=exec('s2')
  assert.equal(gate.guard(call),undefined)
  set({actor:'owner',state:'claimed',task:{id:'t'}})
  let called=false
  await assert.rejects(()=>gate.execute(call,async()=>{called=true}),/lease changed/)
  assert.equal(called,false);assert.match(gate.guard(call),/write lease/)
  assert.equal(gate.guard(exec('s2','read')),undefined)
})
test('only exact accepted owner turn may write; uncertain, ambiguous and lost lock deny Bots',async()=>{
  const {gate,set,lose}=fixture(),owner={...exec('s1'),bound:true},wrong=exec('s1')
  set({actor:'owner',state:'accepted',task:{id:'t'}})
  assert.equal(gate.guard(owner),undefined);assert.match(gate.guard(wrong),/write lease/)
  assert.match(gate.guard(exec('s2')),/write lease/)
  assert.equal(await gate.execute(owner,async()=>42),42)
  set({actor:'owner',state:'uncertain',task:{id:'t'}});assert.match(gate.guard(owner),/write lease/)
  set({ambiguous:true});assert.match(gate.guard(owner),/write lease/)
  set(undefined);lose();assert.match(gate.guard(owner),/write lease/);assert.equal(gate.mayClaim(),false)
  // Direct user or other non-Bot activity remains outside this cooperation fence.
  assert.equal(gate.guard(exec('user-session')),undefined)
})
