import test from 'node:test'
import assert from 'node:assert/strict'
import { install } from '../../src/host/delivery.js'

function fixture() {
  const sent = [], session = {}, agent = {session, followup:message => sent.push(message), steer:message => sent.push(message)}
  const rt = {
    ctx:{sessionController:{resolveAgent:async()=>({agent})}, sessions:{flush:async value=>assert.equal(value, session)}},
    state:{exchanges:[], works:{}}, ledger:{importer(){},records(){return []}},
    botOf:id=>id==='bot'?{id:'bot',name:'Bot'}:undefined, roomOf:()=>undefined, chatOf:()=> 'session',
    ensureCapabilities:async()=>{}, hideBotUnusedTools(){}, save:async()=>{},
  }
  install(rt)
  return {rt, agent, sent}
}

test('pre-admission observer sees the exact message and target agent', async () => {
  const {rt, agent, sent} = fixture(); let observed
  await rt.deliver({toId:'bot',role:'request',text:'Do the task',exchangeId:'exchange'}, {
    beforeAdmission:(target,message)=>{ assert.equal(target,agent); observed=message },
  })
  assert.equal(sent.length,1); assert.equal(sent[0],observed)
  assert.equal(observed.source.exchangeId,'exchange'); assert.equal(Object.isFrozen(observed),true)
})

test('a pre-admission rejection is reported before the agent receives anything', async () => {
  const {rt, sent} = fixture(); let refused = false
  await assert.rejects(rt.deliver({toId:'bot',role:'request',text:'Do the task'}, {
    beforeAdmission:()=>{throw new Error('authority changed')}, onNotAdmitted:()=>{refused=true},
  }), /authority changed/)
  assert.equal(refused,true); assert.equal(sent.length,0)
})

test('an async guard cannot be mistaken for a completed authorization', async () => {
  const {rt, sent} = fixture(); let refused = false
  await assert.rejects(rt.deliver({toId:'bot',role:'request',text:'Do the task'}, {
    beforeAdmission:async()=>{throw new Error('revoked')}, onNotAdmitted:()=>{refused=true},
  }), /must be synchronous/)
  assert.equal(refused,true); assert.equal(sent.length,0)
})

test('the admission receipt callback runs after queueing but before delivery flush', async () => {
  const {rt,sent}=fixture(),order=[]
  rt.ctx.sessions.flush=async()=>{order.push('flush')}
  await rt.deliver({toId:'bot',role:'request',text:'Do the task'}, {
    afterAdmission:(agent,message)=>{assert.equal(sent[0],message);order.push('receipt')},
  })
  assert.deepEqual(order,['receipt','flush'])
})
