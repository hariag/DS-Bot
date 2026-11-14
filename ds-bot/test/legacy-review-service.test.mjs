import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync,existsSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createHash} from 'node:crypto'
import {install} from '../src/host/legacy-review-service.js'
function fixture(){const home=mkdtempSync(join(tmpdir(),'owner-review-'));let own=true,origins=async()=>({ids:['session-old'],observed:{queue:'observed-present',held:'unknown',external:'unknown'}});const state={bots:{a:{},b:{}},rooms:{r:{members:['a','b']},other:{members:['a','b']}},works:{w:{from:'a',to:'b',room:'r',at:1}}};const rt={home,state,ctx:{effect(){}},readOnly:()=>own?undefined:'readonly',requireHomeLock(){if(!own)throw Error('lost')},onHomeDrain(){},load:async()=>{},recoveryWorkOrigins:id=>origins(id)};install(rt);return {rt,lose(){own=false},setOrigins(fn){origins=fn},close(){own=false;rmSync(home,{recursive:true,force:true})}}}
const room={kind:'room',id:'r'},wrong={kind:'room',id:'other'}
test('owner manual review creates once, is visible and does not complete work',async()=>{const f=fixture();try{assert.equal((await f.rt.legacyReviewCall('legacy-review-get',{workId:'w',scope:room})).state,'not-created');const first=await f.rt.legacyReviewCall('legacy-review-create',{workId:'w',scope:room});assert.equal(first.state,'needs-review');assert.equal(first.snapshot.sources[0].complete,false);const repeat=await f.rt.legacyReviewCall('legacy-review-create',{workId:'w',scope:room});assert.equal(repeat.revision,1);const note=await f.rt.legacyReviewCall('legacy-review-finding',{workId:'w',scope:room,expectedRevision:1,summary:'Check the original evidence',evidenceRefs:[],unfinished:[]});assert.equal(note.state,'evidence-needed');assert.equal(note.finding.sideEffects,'unknown');assert.ok(f.rt.state.works.w);assert.deepEqual(await f.rt.legacyReviewCall('legacy-review-finding',{workId:'w',scope:room,expectedRevision:1,summary:'Check the original evidence',evidenceRefs:[],unfinished:[]}),note)}finally{f.close()}})
test('wrong scope is rejected while changed or deleted work remains archived only',async()=>{const f=fixture();try{await assert.rejects(()=>f.rt.legacyReviewCall('legacy-review-create',{workId:'w',scope:wrong}),/unavailable/);await f.rt.legacyReviewCall('legacy-review-create',{workId:'w',scope:room});f.rt.state.works.w.to='a';assert.equal((await f.rt.legacyReviewCall('legacy-review-get',{workId:'w',scope:room})).archived,true);await assert.rejects(()=>f.rt.legacyReviewCall('legacy-review-get',{workId:'w',scope:wrong}),/unavailable/);await assert.rejects(()=>f.rt.legacyReviewCall('legacy-review-finding',{workId:'w',scope:room,expectedRevision:1,summary:'x',evidenceRefs:[],unfinished:[]}),/unavailable/);delete f.rt.state.works.w;assert.equal((await f.rt.legacyReviewCall('legacy-review-get',{workId:'w',scope:room})).archived,true)}finally{f.close()}})
test('lock loss or source unavailability before commit cannot create review',async()=>{const f=fixture();try{f.setOrigins(async()=>{f.lose();return {ids:['session-old'],observed:{queue:'unknown',held:'unknown',external:'unknown'}}});await assert.rejects(()=>f.rt.legacyReviewCall('legacy-review-create',{workId:'w',scope:room}),/unavailable|lost/)}finally{f.close()}})
test('owner change during awaited origin lookup is rejected',async()=>{const f=fixture();try{f.setOrigins(async()=>{f.rt.state.works.w.to='a';return {ids:['session-old'],observed:{queue:'unknown',held:'unknown',external:'unknown'}}});await assert.rejects(()=>f.rt.legacyReviewCall('legacy-review-create',{workId:'w',scope:room}),/changed/)}finally{f.close()}})
test('a missing source still permits an explicitly unknown manual review',async()=>{const f=fixture();try{f.setOrigins(async()=>undefined);const review=await f.rt.legacyReviewCall('legacy-review-create',{workId:'w',scope:room});assert.equal(review.state,'needs-review');assert.deepEqual(review.snapshot.sources,[]);assert.equal(review.snapshot.observations.queue,'unknown');assert.equal(review.snapshot.observations.held,'unknown');assert.equal(review.snapshot.observations.external,'unknown')}finally{f.close()}})
test('manual review notes may be appended with revision checks and prior notes remain visible',async()=>{const f=fixture();try{await f.rt.legacyReviewCall('legacy-review-create',{workId:'w',scope:room});const first={workId:'w',scope:room,expectedRevision:1,summary:'First note',evidenceRefs:['ref-1'],unfinished:[]};const one=await f.rt.legacyReviewCall('legacy-review-finding',first);assert.equal(one.revision,2);const two=await f.rt.legacyReviewCall('legacy-review-finding',{...first,expectedRevision:2,summary:'Correction',evidenceRefs:['ref-2']});assert.equal(two.revision,3);assert.deepEqual(two.history.map(x=>x.finding.summary),['First note','Correction']);assert.equal((await f.rt.legacyReviewCall('legacy-review-finding',first)).revision,3);await assert.rejects(()=>f.rt.legacyReviewCall('legacy-review-finding',{...first,summary:'Stale edit'}),/changed/)}finally{f.close()}})

test('candidate discovery filters out wrong group and marks incomplete',async()=>{const f=fixture();try{f.rt.recoveryWorkCandidates=async()=>({ids:['w','absent'],incomplete:true});assert.deepEqual(await f.rt.legacyReviewCall('legacy-review-list',{scope:room}),{items:[{workId:'w',owner:'b',sender:'a',canDecide:true,choice:'open',revision:0}],incomplete:true});assert.deepEqual(await f.rt.legacyReviewCall('legacy-review-list',{scope:wrong}),{items:[],incomplete:true})}finally{f.close()}})
test('checking a review samples current recovery origins without mutating frozen notes',async()=>{const f=fixture();try{await f.rt.legacyReviewCall('legacy-review-create',{workId:'w',scope:room});f.setOrigins(async()=>({ids:['session-new'],sampledAt:42,observed:{queue:'unknown',held:'observed-present',external:'unknown'}}));const view=await f.rt.legacyReviewCall('legacy-review-get',{workId:'w',scope:room});assert.deepEqual(view.snapshot.sources.map(x=>x.sessionId),['session-old']);assert.deepEqual(view.liveRecovery.ids,['session-new']);assert.equal(view.liveRecovery.observed.held,'observed-present');assert.equal(view.liveRecovery.observed.external,'unknown')}finally{f.close()}})

test('the same work review can be read and updated in group and personal owner scopes',async()=>{const f=fixture();try{const personal={kind:'personal',id:'user'};await f.rt.legacyReviewCall('legacy-review-create',{workId:'w',scope:room});assert.equal((await f.rt.legacyReviewCall('legacy-review-get',{workId:'w',scope:personal})).revision,1);const note=await f.rt.legacyReviewCall('legacy-review-finding',{workId:'w',scope:personal,expectedRevision:1,summary:'Same work',evidenceRefs:[],unfinished:[]});assert.equal(note.revision,2);assert.equal((await f.rt.legacyReviewCall('legacy-review-get',{workId:'w',scope:room})).history.length,1)}finally{f.close()}})
test('frozen linked scopes retain read-only history without granting another group',async()=>{for(const firstScope of [room,{kind:'personal',id:'user'}]){const f=fixture();try{await f.rt.legacyReviewCall('legacy-review-create',{workId:'w',scope:firstScope});const group=await f.rt.legacyReviewCall('legacy-review-get',{workId:'w',scope:room});const personal=await f.rt.legacyReviewCall('legacy-review-get',{workId:'w',scope:{kind:'personal',id:'b'}});assert.equal(group.workId,personal.workId);delete f.rt.state.works.w;assert.equal((await f.rt.legacyReviewCall('legacy-review-get',{workId:'w',scope:room})).archived,true);assert.equal((await f.rt.legacyReviewCall('legacy-review-get',{workId:'w',scope:{kind:'personal',id:'b'}})).archived,true);await assert.rejects(()=>f.rt.legacyReviewCall('legacy-review-get',{workId:'w',scope:wrong}),/unavailable/);await assert.rejects(()=>f.rt.legacyReviewCall('legacy-review-finding',{workId:'w',scope:room,expectedRevision:1,summary:'no',evidenceRefs:[],unfinished:[]}),/unavailable/)}finally{f.close()}}})

test('recreated work with a different creation time or lineage leaves old review read-only',async()=>{const f=fixture();try{await f.rt.legacyReviewCall('legacy-review-create',{workId:'w',scope:room});f.rt.state.works.w={from:'a',to:'b',room:'r',at:2};assert.equal((await f.rt.legacyReviewCall('legacy-review-get',{workId:'w',scope:room})).archived,true);await assert.rejects(()=>f.rt.legacyReviewCall('legacy-review-create',{workId:'w',scope:room}),/unavailable/);f.rt.state.works.w={from:'a',to:'b',room:'r',at:1,parent:'new-parent'};assert.equal((await f.rt.legacyReviewCall('legacy-review-get',{workId:'w',scope:room})).archived,true)}finally{f.close()}})
test('work without a trustworthy creation time is visible as unverified and cannot create notes',async()=>{const f=fixture();try{delete f.rt.state.works.w.at;const shown=await f.rt.legacyReviewCall('legacy-review-get',{workId:'w',scope:room});assert.equal(shown.state,'identity-unverified');assert.equal(shown.archived,true);assert.equal(shown.liveRecovery.available,true);await assert.rejects(()=>f.rt.legacyReviewCall('legacy-review-create',{workId:'w',scope:room}),/identity unavailable/)}finally{f.close()}})

const op=value=>'manual-review:'+createHash('sha256').update(JSON.stringify(value)).digest('hex')
const createOp=op({kind:'create',workId:'w'})
const findingOp=op({kind:'finding',workId:'w',expectedRevision:1,summary:'Check original evidence',evidenceRefs:[],unfinished:[]})
const otherOp=op({kind:'create',workId:'other'})
test('receipt lookup is read-only and missing does not mean uncommitted',async()=>{const f=fixture();try{
  const query={scope:room,workId:'w',operationId:createOp,kind:'create'}
  assert.deepEqual(await f.rt.legacyReviewCall('legacy-review-operation',query),{status:'unknown'})
  assert.equal(existsSync(join(f.rt.home,'legacy-reviews-v1')),false)
  await f.rt.legacyReviewCall('legacy-review-create',{scope:room,workId:'w',operationId:createOp})
  assert.deepEqual(await f.rt.legacyReviewCall('legacy-review-operation',query),{status:'committed'})
  assert.deepEqual(await f.rt.legacyReviewCall('legacy-review-operation',{...query,operationId:otherOp}),{status:'unknown'})
  assert.deepEqual(await f.rt.legacyReviewCall('legacy-review-operation',{...query,kind:'finding'}),{status:'unknown'})
  assert.deepEqual(await f.rt.legacyReviewCall('legacy-review-operation',{...query,scope:{kind:'personal',id:'user'}}),{status:'unknown'})
  f.rt.state.works.w2={from:'a',to:'b',room:'r',at:2}
  assert.deepEqual(await f.rt.legacyReviewCall('legacy-review-operation',{...query,workId:'w2'}),{status:'unknown'})
  await assert.rejects(()=>f.rt.legacyReviewCall('legacy-review-operation',{...query,scope:wrong}),/unavailable/)
  await assert.rejects(()=>f.rt.legacyReviewCall('legacy-review-operation',{...query,operationId:'review-create:forged'}),/invalid/)
  await assert.rejects(()=>f.rt.legacyReviewCall('legacy-review-operation',{...query,kind:'unknown'}),/invalid/)
}finally{f.close()}})
test('client operation ID replays one finding and rejects altered payload and scope',async()=>{const f=fixture();try{
  await f.rt.legacyReviewCall('legacy-review-create',{scope:room,workId:'w',operationId:createOp})
  const input={scope:room,workId:'w',operationId:findingOp,expectedRevision:1,summary:'Check original evidence',evidenceRefs:[],unfinished:[]}
  assert.equal((await f.rt.legacyReviewCall('legacy-review-finding',input)).revision,2)
  assert.equal((await f.rt.legacyReviewCall('legacy-review-finding',input)).history.length,1)
  assert.deepEqual(await f.rt.legacyReviewCall('legacy-review-operation',{scope:room,workId:'w',operationId:findingOp,kind:'finding'}),{status:'committed'})
  await assert.rejects(()=>f.rt.legacyReviewCall('legacy-review-finding',{...input,expectedRevision:2}),/invalid operation/)
  await assert.rejects(()=>f.rt.legacyReviewCall('legacy-review-finding',{...input,summary:'Other note'}),/invalid operation/)
  await assert.rejects(()=>f.rt.legacyReviewCall('legacy-review-finding',{...input,scope:{kind:'personal',id:'user'}}),/conflict/)
}finally{f.close()}})
test('existing legacy review does not fabricate a new create receipt',async()=>{const f=fixture();try{
  await f.rt.legacyReviewCall('legacy-review-create',{scope:room,workId:'w'})
  await assert.rejects(()=>f.rt.legacyReviewCall('legacy-review-create',{scope:room,workId:'w',operationId:createOp}),/already has/)
  assert.deepEqual(await f.rt.legacyReviewCall('legacy-review-operation',{scope:room,workId:'w',operationId:createOp,kind:'create'}),{status:'unknown'})
}finally{f.close()}})
test('operation preparation validates scope and creates no journal',async()=>{const f=fixture();try{
 const payload={scope:room,workId:'w',kind:'create'}
 const a=await f.rt.legacyReviewCall('legacy-review-prepare',payload),b=await f.rt.legacyReviewCall('legacy-review-prepare',payload)
 assert.equal(a.operationId,createOp)
 assert.equal(a.operationId,b.operationId)
 assert.equal((await f.rt.legacyReviewCall('legacy-review-prepare',{...payload,scope:{kind:'personal',id:'user'}})).operationId,createOp)
 const finding={...payload,kind:'finding',expectedRevision:1,summary:'Check original evidence',evidenceRefs:[],unfinished:[]}
 assert.equal((await f.rt.legacyReviewCall('legacy-review-prepare',finding)).operationId,findingOp)
 await assert.rejects(()=>f.rt.legacyReviewCall('legacy-review-prepare',{...finding,summary:''}),/invalid/)
 assert.equal(existsSync(join(f.rt.home,'legacy-reviews-v1')),false)
 await assert.rejects(()=>f.rt.legacyReviewCall('legacy-review-prepare',{...payload,scope:wrong}),/unavailable/)
}finally{f.close()}})
test('receipt for a replaced work identity cannot confirm the new work',async()=>{const f=fixture();try{
 await f.rt.legacyReviewCall('legacy-review-create',{scope:room,workId:'w',operationId:createOp})
 f.rt.state.works.w={from:'a',to:'b',room:'r',at:2}
 assert.deepEqual(await f.rt.legacyReviewCall('legacy-review-operation',{scope:room,workId:'w',operationId:createOp,kind:'create'}),{status:'unknown'})
}finally{f.close()}})
