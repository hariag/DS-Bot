import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { install } from '../src/host/legacy-review-service.js'

function fixture(t) {
  const home=mkdtempSync(join(tmpdir(),'work-decisions-')),statePath=join(home,'state.json')
  const state={revision:0,bots:{a:{},b:{}},rooms:{r:{},other:{}},works:{w:{from:'a',to:'b',room:'r',at:123}}}
  let owns=true
  const rt={home,statePath,state,ctx:{effect(){}},readOnly:()=>owns?undefined:'readonly',requireHomeLock(){if(!owns)throw Error('lost')},homeLockVersion:()=>owns?1:2,onHomeDrain(){},load:async()=>{},recoveryWorkCandidates:async()=>({ids:['w'],incomplete:false}),save:async()=>writeFileSync(statePath,JSON.stringify(state))}
  writeFileSync(statePath,JSON.stringify(state));install(rt)
  t.after(()=>rmSync(home,{recursive:true,force:true}))
  return {rt,statePath,lose(){owns=false}}
}
const scope={kind:'room',id:'r'},wrong={kind:'room',id:'other'}
const list=rt=>rt.legacyReviewCall('legacy-review-list',{scope})
const choose=(rt,expectedRevision,choice,which=scope)=>rt.legacyReviewCall('legacy-review-decision',{scope:which,workId:'w',expectedRevision,choice})

test('work decisions preserve the work, scope, history and independent outcome',async t=>{
  const {rt,statePath}=fixture(t),original=structuredClone(rt.state.works.w)
  assert.deepEqual((await list(rt)).items.map(x=>[x.choice,x.revision,x.owner,x.sender]),[['open',0,'b','a']])
  await assert.rejects(choose(rt,0,'ignored',wrong))
  assert.deepEqual(await choose(rt,0,'ignored'),{choice:'ignored',revision:1})
  assert.deepEqual(await choose(rt,0,'ignored'),{choice:'ignored',revision:1})
  await assert.rejects(choose(rt,0,'user-accepted'))
  assert.deepEqual(await choose(rt,1,'open'),{choice:'open',revision:2})
  assert.deepEqual(await choose(rt,2,'user-accepted'),{choice:'user-accepted',revision:3})
  assert.deepEqual(rt.state.works.w,original)
  assert.equal((await list(rt)).items[0].choice,'user-accepted')
  rt.recoveryWorkCandidates=async()=>({ids:[],incomplete:false})
  assert.equal((await list(rt)).items[0].choice,'user-accepted','handled work remains accessible after it leaves the live candidates')
  const saved=JSON.parse(readFileSync(statePath,'utf8'))
  assert.deepEqual(Object.values(saved.legacyWorkDecisions)[0].history.map(x=>x.choice),['ignored','open','user-accepted'])
  assert.deepEqual(saved.works.w,original)
  rt.state.works.w.to='a'
  const changed=await list(rt)
  assert.equal(changed.incomplete,true)
  assert.equal(changed.items.length,0)
  await assert.rejects(choose(rt,3,'open'))
})

test('a lost response reconciles an already saved decision without another entry',async t=>{
  const {rt,statePath}=fixture(t)
  rt.save=async()=>{writeFileSync(statePath,JSON.stringify(rt.state));throw Error('response lost')}
  await assert.rejects(choose(rt,0,'ignored'))
  assert.equal((await list(rt)).items[0].choice,'ignored')
  assert.deepEqual(await choose(rt,0,'ignored'),{choice:'ignored',revision:1})
  assert.equal(Object.values(rt.state.legacyWorkDecisions)[0].history.length,1)
})

test('a failed write or lost lock never reports a decision as committed',async t=>{
  const {rt,lose}=fixture(t)
  rt.save=async()=>{throw Error('not written')}
  await assert.rejects(choose(rt,0,'user-accepted'))
  await assert.rejects(list(rt))
  lose()
  await assert.rejects(choose(rt,0,'user-accepted'))
})

test('a pending decision cannot be observed as durable or overwritten concurrently',async t=>{
  const {rt,statePath}=fixture(t)
  let enter,release
  const entered=new Promise(resolve=>{enter=resolve}), gate=new Promise(resolve=>{release=resolve})
  rt.save=async()=>{enter();await gate;writeFileSync(statePath,JSON.stringify(rt.state))}
  const pending=choose(rt,0,'ignored')
  await entered
  await assert.rejects(list(rt))
  await assert.rejects(choose(rt,0,'user-accepted'))
  release()
  assert.deepEqual(await pending,{choice:'ignored',revision:1})
  assert.equal((await list(rt)).items[0].choice,'ignored')
})
