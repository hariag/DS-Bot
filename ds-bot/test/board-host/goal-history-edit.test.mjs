// Draft acceptance tests for history-card editing. Copy into the implementation
// worktree's ds-bot/test/board-host. Base fork main: 786857f770c2994a8e52de63e69dac735b51894d.
// This is real board-service + real image worker with a synthetic runtime/home;
// it is not a real DSH Agent, production storage, or a crash-durability proof.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import pngjs from 'pngjs'
import { install, BOARD_UPLOAD_PATH } from '../../src/host/board-service.js'
import { legacyGoalCardId } from '../../src/host/legacy-goal.js'
import { archiveGoal } from '../../src/host/goals.js'

const group={kind:'room',id:'group'}, own={kind:'personal',id:'one'}, other={kind:'personal',id:'two'}
const png=pngjs.PNG.sync.write({width:1,height:1,data:Buffer.from([1,2,3,255])}).toString('base64')
const image=(id)=>({uploadId:id,name:`${id}.png`,mediaType:'image/png',data:png})
const uploadRequest=payload=>new Request('http://localhost/api/bot-board-upload',{method:'POST',body:JSON.stringify({endpoint:'board-upload',payload}),duplex:'half'})

const task=(id,title,status)=>({id,botId:'one',task:title,status,statusVersion:1,note:'Original evidence note',noteStatus:status,noteAt:91})
const seeded=()=>({revision:1,bots:{one:{name:'One'},two:{name:'Two'}},rooms:{
  group:{id:'group',name:'Group',members:['one','two'],pastGoals:[{id:'closed',title:'Closed goal',status:'complete',revision:4,updatedAt:400,createdAt:200,endedAt:390,current:1,events:[],evidence:'Final evidence',summary:'Original summary',stages:[{id:'s1',title:'Closed stage',status:'passed',acceptance:'Closed criterion',evidence:'Closed review proof',passedAt:380,tasks:[task('t1','Archived original','done')]}]}],
    goal:{id:'active',title:'Active goal',status:'active',revision:10,updatedAt:1000,createdAt:100,current:1,events:[],stages:[
      {id:'s1',title:'Earlier stage',status:'passed',acceptance:'Prior criterion',evidence:'Prior review proof',passedAt:500,tasks:[task('t1','Earlier original','done')]},
      {id:'s2',title:'Current stage',status:'active',acceptance:'Current criterion',tasks:[task('t2','Current work','working')]},
      {id:'s3',title:'Future stage',status:'pending',acceptance:'Future criterion',tasks:[task('t3','Future work','pending')]},
    ]}},
  another:{id:'another',name:'Other room',members:['one','two'],goal:{id:'active',title:'Same identifiers',status:'active',revision:10,updatedAt:1000,createdAt:100,current:1,events:[],stages:[{id:'s1',title:'Other stage',status:'passed',acceptance:'Other criterion',tasks:[task('t1','Other room original','done')]},{id:'s2',title:'Other current',status:'active',acceptance:'Other current criterion',tasks:[]}]}}
}})
const ids={earlier:legacyGoalCardId('group','active','s1','t1'),future:legacyGoalCardId('group','active','s3','t3'),archived:legacyGoalCardId('group','closed','s1','t1'),another:legacyGoalCardId('another','active','s1','t1')}
const getGoal=(state,which)=>which==='archived'?state.rooms.group.pastGoals[0]:state.rooms.group.goal
const getOriginal=(state,which)=>getGoal(state,which).stages[which==='earlier'||which==='archived'?0:2].tasks[0]
const fact=goal=>({id:goal.id,status:goal.status,revision:goal.revision,createdAt:goal.createdAt,updatedAt:goal.updatedAt,endedAt:goal.endedAt,summary:goal.summary,evidence:goal.evidence,current:goal.current,events:structuredClone(goal.events),
  stages:goal.stages.map(stage=>({id:stage.id,title:stage.title,status:stage.status,acceptance:stage.acceptance,evidence:stage.evidence,passedAt:stage.passedAt,
    tasks:stage.tasks.map(({id,botId,task,status,statusVersion,note,noteStatus,noteAt})=>({id,botId,task,status,statusVersion,note,noteStatus,noteAt}))}))})
const facts=state=>({active:fact(state.rooms.group.goal),closed:fact(state.rooms.group.pastGoals[0]),other:fact(state.rooms.another.goal)})

const cleanupByTest=new WeakMap()
function openHost(t,home,state) {
  const effects=[],routes=[],drains=[]
  let closed=false
  const rt={home,state,teamTools:[],statePath:join(home,'state.json'),
    ctx:{effect(fn){effects.push(fn())},connection:{fetch:{register(route){routes.push(route);return()=>{}}}}},
    onHomeDrain(fn){drains.push(fn)},async load(){},readOnly(){},requireHomeLock(){},homeLockVersion:()=>1,
    roomOf(id){return this.state.rooms[id]},warn(){},
    async save(){const next=join(home,'state.next');writeFileSync(next,JSON.stringify(this.state));renameSync(next,this.statePath)},
  }
  install(rt)
  async function close(){if(closed)return;closed=true;for(const dispose of effects.reverse())await dispose?.();for(const drain of drains)await drain()}
  let cleanups=cleanupByTest.get(t)
  if(!cleanups){cleanups=[];cleanupByTest.set(t,cleanups);t.after(async()=>{for(const fn of cleanups.reverse())await fn();rmSync(home,{recursive:true,force:true})})}
  cleanups.push(close)
  return {rt,route:routes.find(route=>route.path===BOARD_UPLOAD_PATH),close}
}
function setup(t){const home=mkdtempSync(join(tmpdir(),'dsbot-goal-history-'));const state=seeded();writeFileSync(join(home,'state.json'),JSON.stringify(state));return {home,...openHost(t,home,state)}}
async function board(rt,scope=group){return rt.boardCall('board-list',{scope})}
function currentCard(view,id){const item=view.tasks.find(card=>card.id===id);assert.ok(item,`missing original ${id}`);return item}
function boardRevision(card){return card.legacy?.boardRevision??0}
function command(card,scope,operationId,type,value){return {scope,taskId:card.id,expectedRevision:card.revision,expectedBoardRevision:boardRevision(card),expectedPosition:card.legacy?.position,operationId,type,value}}
function auditOf(goal,cardId){return goal.boardCards?.[cardId]?.audit ?? []}
async function rejected(run){try{const result=await run();assert.equal(result.state,'rejected');return result}catch(error){assert.match(String(error?.message),/stale|conflict|changed|invalid|unavailable|not available|authorized|permission|history|revision/i)}}

test('all original stage positions and archived goals support annotated metadata without changing accepted facts',async t=>{
  const {rt}=setup(t), before=facts(rt.state), initial=await board(rt)
  for(const which of ['earlier','future','archived']) {
    const card=currentCard(initial,ids[which]), original=structuredClone(getOriginal(rt.state,which))
    assert.equal(card.legacy.boardRevision,0)
    assert.equal(card.legacy.position,{earlier:'previous',future:'future',archived:'archived'}[which])
    assert.equal(card.legacy.useOverlay,true)
    assert.ok(initial.capabilities.commands[card.id].some(x=>x.type==='goal-card-details'))
    const input=command(card,group,`goal:details-${which}`,'goal-card-details',{description:`Correction ${which}`,dueDate:'2026-12-01',labels:['design'],checklist:[{id:'ci',text:'Review',checked:true}]})
    assert.equal((await rt.boardCall('board-command',input)).state,'committed')
    const next=currentCard(await board(rt),card.id)
    assert.equal(next.description,`Correction ${which}`)
    assert.equal(boardRevision(next),boardRevision(card)+1)
    assert.equal(next.revision,card.revision,'historical board metadata must not change goal execution revision')
    const source=getOriginal(rt.state,which)
    assert.deepEqual(source,original,'source task JSON stays unchanged, including review fingerprint inputs')
    assert.equal(JSON.stringify(source),JSON.stringify(original),'source task byte representation remains unchanged')
    assert.ok(auditOf(getGoal(rt.state,which),card.id).length>0,'audit cannot be only the truncated recent activity list')
    const audit=JSON.stringify(auditOf(getGoal(rt.state,which),card.id))
    assert.ok(audit.includes(input.operationId) && audit.includes(`Correction ${which}`),'audit binds operation and after value')
  }
  assert.deepEqual(facts(rt.state),before,'stage acceptance, status, source task, evidence, and execution timestamps remain unchanged')
})

test('historical title corrections preserve the actual accepted title and include complete provenance',async t=>{
  const {rt}=setup(t), before=facts(rt.state), card=currentCard(await board(rt),ids.archived)
  const input=command(card,group,'goal:title-correction','goal-history-title',{title:'Display correction',reason:'Typographic correction with reference'})
  assert.equal((await rt.boardCall('board-command',input)).state,'committed')
  const shown=currentCard(await board(rt),card.id), source=getOriginal(rt.state,'archived')
  assert.equal(shown.title,'Display correction');assert.equal(source.task,'Archived original')
  const history=JSON.stringify(auditOf(getGoal(rt.state,'archived'),card.id))
  for(const value of ['goal:title-correction','Archived original','Display correction','Typographic correction with reference'])assert.ok(history.includes(value),`audit is missing ${value}`)
  assert.deepEqual(facts(rt.state),before)
  assert.equal((await rt.boardCall('board-command',input)).state,'committed')
  assert.equal(JSON.stringify(auditOf(getGoal(rt.state,'archived'),card.id)).split('goal:title-correction').length-1,1,'same operation must not append twice')
})

test('dual revision CAS, operation identity and record identity prevent stale or misdirected writes',async t=>{
  const {rt}=setup(t), board0=await board(rt), original=currentCard(board0,ids.earlier), sameDifferentRoom=currentCard(await board(rt,{kind:'room',id:'another'}),ids.another)
  assert.notEqual(original.id,sameDifferentRoom.id)
  const first=command(original,group,'goal:cas-first','goal-card-details',{description:'First'})
  assert.equal((await rt.boardCall('board-command',first)).state,'committed')
  await rejected(()=>rt.boardCall('board-command',{...first,operationId:'goal:stale-board',value:{description:'Stale'}}))
  await assert.rejects(rt.boardCall('board-command',{...first,value:{description:'Different'}}),/operation id|already used|conflict/i)
  const refreshed=currentCard(await board(rt),ids.earlier)
  await rejected(()=>rt.boardCall('board-command',{...command(refreshed,group,'goal:no-board-rev','goal-card-details',{description:'No revision'}),expectedBoardRevision:undefined}))
  rt.state.rooms.group.goal.revision++
  await rejected(()=>rt.boardCall('board-command',command(refreshed,group,'goal:stale-goal','goal-card-details',{description:'Goal changed'})))
  assert.equal(currentCard(await board(rt),ids.earlier).description,'First')
  assert.equal(rt.state.rooms.another.goal.stages[0].tasks[0].task,'Other room original')
})

test('concurrent revisions and same operation ID cannot duplicate or lose a historical update',async t=>{
  const {rt}=setup(t), card=currentCard(await board(rt),ids.archived)
  const one=command(card,group,'goal:concurrent-one','goal-card-comment',{text:'One comment'})
  const two=command(card,group,'goal:concurrent-two','goal-card-comment',{text:'Other comment'})
  const results=await Promise.all([rt.boardCall('board-command',one),rt.boardCall('board-command',two)])
  assert.equal(results.filter(result=>result.state==='committed').length,1)
  assert.equal(results.filter(result=>result.state==='rejected').length,1)
  const shown=currentCard(await board(rt),card.id)
  assert.equal(shown.comments.length,1);assert.equal(boardRevision(shown),1)
  const again=command(shown,group,'goal:concurrent-same','goal-card-comment',{text:'Same logical request'})
  const duplicate=await Promise.all([rt.boardCall('board-command',again),rt.boardCall('board-command',again)])
  assert.ok(duplicate.some(result=>result.state==='committed'))
  assert.ok(duplicate.every(result=>['committed','unknown'].includes(result.state)))
  assert.equal((await rt.boardCall('board-operation',{scope:group,operationId:again.operationId})).state,'committed')
  assert.equal((await rt.boardCall('board-command',again)).state,'committed')
  const final=currentCard(await board(rt),card.id)
  assert.equal(final.comments.filter(comment=>comment.text==='Same logical request').length,1)
})

test('audit is append-only beyond the recent activity window',async t=>{
  const {rt}=setup(t)
  for(let i=0;i<55;i++) {
    const card=currentCard(await board(rt),ids.archived)
    const input=command(card,group,`goal:audit-${i}`,'goal-card-details',{description:`Revision ${i}`})
    assert.equal((await rt.boardCall('board-command',input)).state,'committed')
  }
  const audit=auditOf(getGoal(rt.state,'archived'),ids.archived)
  assert.equal(audit.length,55)
  assert.equal(audit[0].operationId,'goal:audit-0')
  assert.equal(audit[54].operationId,'goal:audit-54')
  for(let i=0;i<audit.length;i++) {
    assert.equal(audit[i].actor,'user')
    assert.ok(audit[i].before!==undefined && audit[i].after!==undefined)
  }
})

test('a visible history card cannot cross scopes or survive membership removal, room deletion and ambiguous identities',async t=>{
  const {rt}=setup(t), roomCard=currentCard(await board(rt),ids.earlier), ownCard=currentCard(await board(rt,own),ids.earlier)
  assert.equal(ownCard.id,roomCard.id)
  await rejected(()=>rt.boardCall('board-command',command(roomCard,other,'goal:wrong-person','goal-card-details',{description:'Wrong person'})))
  await rejected(()=>rt.boardCall('board-command',command(roomCard,{kind:'room',id:'another'},'goal:wrong-room','goal-card-details',{description:'Wrong group'})))
  rt.state.rooms.group.members=['two']
  await rejected(()=>rt.boardCall('board-command',command(ownCard,own,'goal:removed-member','goal-card-details',{description:'Unauthorized'})))
  rt.state.rooms.group.members=['one','two']
  const before=structuredClone(rt.state.rooms.group.goal.stages[0].tasks[0])
  rt.state.rooms.group.goal.stages[0].tasks.push({...before,task:'Duplicate ID'})
  await rejected(()=>rt.boardCall('board-command',command(roomCard,group,'goal:duplicate','goal-card-details',{description:'Ambiguous'})))
  assert.equal(rt.state.rooms.group.goal.stages[0].tasks[0].boardDetails,undefined)
  assert.equal(rt.state.rooms.group.goal.boardCards?.[roomCard.id],undefined)
  rt.state.rooms.group.goal.stages[0].tasks.pop()
  rt.state.rooms.group.pastGoals.push(structuredClone(rt.state.rooms.group.goal))
  await rejected(()=>rt.boardCall('board-command',command(roomCard,group,'goal:duplicate-goal','goal-card-details',{description:'Ambiguous goal'})))
  rt.state.rooms.group.pastGoals.pop()
  delete rt.state.rooms.group
  await rejected(()=>rt.boardCall('board-command',command(roomCard,group,'goal:deleted-room','goal-card-details',{description:'Deleted'})))
})

test('replaced or rebuilt goal task and historical-to-current transition reject stale edits',async t=>{
  const {rt}=setup(t), card=currentCard(await board(rt),ids.earlier)
  const oldTask=rt.state.rooms.group.goal.stages[0].tasks[0]
  rt.state.rooms.group.goal.stages[0].tasks[0]={...oldTask,id:'replacement-id',task:'New task'}
  await rejected(()=>rt.boardCall('board-command',command(card,group,'goal:rebuilt','goal-card-details',{description:'Not for replacement'})))
  assert.equal(rt.state.rooms.group.goal.stages[0].tasks[0].boardDetails,undefined)
  rt.state.rooms.group.goal.stages[0].tasks[0]=oldTask
  rt.state.rooms.group.goal.current=0
  await rejected(()=>rt.boardCall('board-command',command(card,group,'goal:became-current','goal-card-details',{description:'Mode changed'})))
  assert.equal(oldTask.boardDetails,undefined)
})

test('archived image worker publishes two images once and preserves historical facts and attribution',async t=>{
  const {rt,route}=setup(t), before=facts(rt.state), card=currentCard(await board(rt),ids.archived)
  const input={scope:group,taskId:card.id,expectedRevision:card.revision,expectedBoardRevision:boardRevision(card),expectedPosition:card.legacy?.position,operationId:'goal:past-upload',images:[image('imga'),image('imgb')]}
  assert.equal((await (await route.fetch(uploadRequest(input))).json()).ok,true)
  assert.equal((await (await route.fetch(uploadRequest(input))).json()).ok,true)
  assert.equal((await (await route.fetch(uploadRequest({...input,images:[image('imga'),{...image('imgb'),name:'changed.png'}]}))).json()).ok,false)
  const next=currentCard(await board(rt),card.id);assert.equal(next.images.length,2);assert.equal(boardRevision(next),1)
  assert.equal((await rt.boardCall('board-image',{scope:group,taskId:card.id,imageId:'imga'})).data,png)
  assert.deepEqual(facts(rt.state),before)
  const audit=JSON.stringify(auditOf(getGoal(rt.state,'archived'),card.id))
  assert.ok(audit.includes(input.operationId)&&audit.includes('imga')&&audit.includes('imgb'))
  rt.state.rooms.group.members=['two']
  await assert.rejects(rt.boardCall('board-image',{scope:own,taskId:card.id,imageId:'imga'}),/unavailable|not available/i)
})

test('personal-scope permission is rechecked after the upload stream yields',async t=>{
  const {rt,route}=setup(t), card=currentCard(await board(rt,own),ids.archived)
  const input={scope:own,taskId:card.id,expectedRevision:card.revision,expectedBoardRevision:boardRevision(card),expectedPosition:card.legacy.position,operationId:'goal:permission-race',images:[image('late')]}
  const body=JSON.stringify({endpoint:'board-upload',payload:input})
  let streamController
  const stream=new ReadableStream({start(controller){streamController=controller}})
  const pending=route.fetch(new Request('http://localhost/api/bot-board-upload',{method:'POST',body:stream,duplex:'half'}))
  streamController.enqueue(new TextEncoder().encode(body.slice(0,20)))
  rt.state.rooms.group.members=['two']
  streamController.enqueue(new TextEncoder().encode(body.slice(20)));streamController.close()
  assert.equal((await (await pending).json()).ok,false)
  rt.state.rooms.group.members=['one','two']
  assert.equal(currentCard(await board(rt),card.id).images?.length??0,0)
})

test('published orphan stays inaccessible after save failure; confirmed written snapshot is reused exactly once',async t=>{
  const {rt,route,home,close}=setup(t), before=facts(rt.state), card=currentCard(await board(rt),ids.archived)
  const input={scope:group,taskId:card.id,expectedRevision:card.revision,expectedBoardRevision:boardRevision(card),expectedPosition:card.legacy?.position,operationId:'goal:past-orphan',images:[image('orphan')]}
  rt.save=async()=>{throw new Error('synthetic failure before snapshot')}
  assert.equal((await (await route.fetch(uploadRequest(input))).json()).ok,false)
  assert.equal(readdirSync(join(home,'board-v1','images')).length,1)
  assert.equal((await rt.boardCall('board-operation',{scope:group,operationId:input.operationId})).state,'unknown')
  await assert.rejects(rt.boardCall('board-image',{scope:group,taskId:card.id,imageId:'orphan'}),/unavailable/i)
  assert.equal((await (await route.fetch(uploadRequest(input))).json()).ok,false)
  await close()
  const saved=JSON.parse(readFileSync(join(home,'state.json'),'utf8')), restarted=openHost(t,home,saved)
  assert.deepEqual(facts(restarted.rt.state),before)
  await assert.rejects(restarted.rt.boardCall('board-image',{scope:group,taskId:card.id,imageId:'orphan'}),/unavailable|not available/i)
  const retry={...input,operationId:'goal:past-written',images:[image('written')]}, persist=restarted.rt.save
  restarted.rt.save=async()=>{await persist.call(restarted.rt);throw Error('synthetic lost save response')}
  assert.equal((await (await restarted.route.fetch(uploadRequest(retry))).json()).ok,false)
  assert.equal((await restarted.rt.boardCall('board-operation',{scope:group,operationId:retry.operationId})).state,'committed')
  assert.equal((await (await restarted.route.fetch(uploadRequest(retry))).json()).ok,true)
  const shown=currentCard(await board(restarted.rt),card.id)
  assert.equal(shown.images.length,1);assert.equal(shown.images[0].id,'written')
  assert.deepEqual(facts(restarted.rt.state),before)
  await restarted.close()
  const second=openHost(t,home,JSON.parse(readFileSync(join(home,'state.json'),'utf8')))
  assert.equal((await second.rt.boardCall('board-operation',{scope:group,operationId:retry.operationId})).state,'committed')
  assert.equal((await (await second.route.fetch(uploadRequest(retry))).json()).ok,true)
  assert.equal(currentCard(await board(second.rt),card.id).images.length,1,'restart plus same upload ID is not a second attachment')
})

test('archived audit survives history retention even if the final editable value is empty',async t=>{
  const {rt}=setup(t), card=currentCard(await board(rt),ids.earlier)
  assert.equal((await rt.boardCall('board-command',command(card,group,'goal:nonempty','goal-card-details',{description:'Transient context'}))).state,'committed')
  const updated=currentCard(await board(rt),card.id)
  assert.equal((await rt.boardCall('board-command',command(updated,group,'goal:cleared','goal-card-details',{description:''}))).state,'committed')
  const room=rt.state.rooms.group, saved=room.goal
  room.pastGoals=[saved,...Array.from({length:4},(_,i)=>({id:`past-${i}`,stages:[]}))]
  room.goal={id:'new',stages:[]};archiveGoal(room)
  const preserved=room.pastGoals.find(goal=>goal.id==='active')
  assert.ok(preserved,'historical audit must prevent retention eviction even when user-facing fields are empty')
  const serialized=JSON.stringify(auditOf(preserved,card.id))
  assert.ok(serialized.includes('Transient context')&&serialized.includes('goal:cleared'))
})
