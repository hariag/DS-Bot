import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { privateTempDir } from '../private-temp.mjs'
import { openTaskStore } from '../../src/host/task-store.mjs'
import { installProjectCoordination } from '../../src/host/project-coordination.mjs'
import { createBotWorkflow } from '../../src/host/workflow.mjs'

function fixture(t) {
  const dir=privateTempDir(join(tmpdir(),'dsbot-project-')),path=join(dir,'tasks.sqlite')
  const options={assertWriteLock(){},authorize:()=>true,verifyRegistration:()=>true}
  let store=openTaskStore(path,options)
  t.after(()=>{store.close(); rmSync(dir,{recursive:true,force:true})})
  const groups=Object.fromEntries(['A','B','C'].map(id=>[id,{id,name:id+' group',members:['pm','owner','reviewer'],admin:'pm',sessions:{pm:id+'-pm',owner:id+'-owner'}}]))
  const rt={state:{rooms:groups},teamTools:[],selfOf:sid=>sid?.split('-')[1],roomOf:id=>groups[id],
    botOf:id=>['pm','owner','reviewer'].includes(id)?{id}:undefined,isAdminOf:(r,id)=>r.admin===id,
    groupOwners:new Map([['A-pm',{roomId:'A',botId:'pm'}],['B-pm',{roomId:'B',botId:'pm'}],['A-owner',{roomId:'A',botId:'owner'}],['B-owner',{roomId:'B',botId:'owner'}]]),chatOf:id=>'private-'+id}
  const api=installProjectCoordination(rt,{defineTool:t=>t,run:fn=>fn(),store:()=>store})
  const bind={scope:{kind:'room',id:'A'},projectId:'P',name:'Project P',coordinatorRoomId:'A',roomIds:['B','A'],operationId:'bind',expectedRevision:0}
  const decide={scope:bind.scope,expectedRevision:1,resource:'repo/master/file',roomIds:['A','B'],operationId:'decision',summary:'Keep previous headings'}
  const show=(roomId,rest={})=>api.userCall('board-project',{scope:{kind:'room',id:roomId},...rest})
  const bot=(sid,args)=>JSON.parse(rt.teamTools[0].execute(args,{agent:{id:sid}}))
  return {dir,get store(){return store},rt,api,bind,decide,show,bot,reopen(){store.close();store=openTaskStore(path,options)}}
}

test('explicit project binding, durable CAS decisions, scoped receipts and group acknowledgement',t=>{
  const {dir,api,bind,decide,show,bot,rt,reopen}=fixture(t)
  assert.equal(show('A').project,null)
  assert.equal(existsSync(join(dir,'project-coordination.sqlite')),false)
  assert.throws(()=>api.userCall('board-project-bind',{...bind,scope:{kind:'room',id:'B'}}),/coordinator/)
  const receipt=api.userCall('board-project-bind',bind)
  assert.deepEqual(api.userCall('board-project-bind',bind),receipt)
  assert.throws(()=>api.userCall('board-project-bind',{...bind,expectedRevision:1}),/operation ID conflict/)
  assert.deepEqual(show('A',{operationId:'bind'}).receipt,receipt)
  assert.equal(show('B',{operationId:'bind'}).receipt,null)
  assert.deepEqual(show('B').project.rooms.map(r=>r.id),['A','B'])
  const d=api.userCall('board-project-decide',decide)
  assert.throws(()=>api.userCall('board-project-decide',{...decide,operationId:'concurrent'}),/revision changed/)
  assert.throws(()=>api.userCall('board-project-decide',{...decide,expectedRevision:2,operationId:'other',roomIds:['A','C']}),/audience/)
  assert.throws(()=>api.userCall('board-project-bind',{...bind,expectedRevision:2,operationId:'shrink',roomIds:['A']}),/lose its membership/)
  assert.equal(show('C').events.length,0)
  assert.equal(bot('B-pm',{action:'show',operation_id:'decision'}).receipt,null)
  assert.equal(bot('B-pm',{action:'show'}).availableRooms,undefined)
  assert.throws(()=>bot('B-pm',{action:'show',room_id:'A'}),/target group/)
  assert.throws(()=>bot('B-pm',{action:'decide'}),/audience|administrator|unavailable/)
  assert.throws(()=>bot('private-pm',{action:'decide',room_id:'A'}),/coordinating group/)
  assert.match(api.prompt(rt.roomOf('B'),{id:'owner'}),/Keep previous headings/)
  bot('B-pm',{action:'ack',revision:2})
  bot('B-pm',{action:'ack',revision:2})
  assert.deepEqual(show('A').events[0].acknowledgements.map(a=>[a.roomId,a.actor]),[['B','pm']])
  assert.throws(()=>bot('A-owner',{action:'ack',revision:22}),/unavailable/)
  reopen()
  assert.deepEqual(show('A',{operationId:'decision'}).receipt,d)
  assert.equal(show('A').events.length,2)
  assert.equal(show('B').events[0].acknowledgements.length,1)
  rt.roomOf('B').members=[]
  assert.throws(()=>bot('B-pm',{action:'show'}),/unavailable/)
  assert.equal(api.prompt(rt.roomOf('B'),{id:'pm'}),'')
})

test('explicitly linked card changes commit with its history, invalidate stale work, and avoid a second intake',async t=>{
  const f=fixture(t),{api,bind,decide,show,bot,rt}=f
  api.userCall('board-project-bind',bind)
  const task={id:'card',scope:'room:A',owner:'owner',reviewer:'reviewer',title:'Original',acceptance:'Agreed scope',type:'feature'}
  f.store.create({operationId:'create',actor:'user',task})
  const d=api.userCall('board-project-decide',{...decide,taskId:'card'})
  const workflow=createBotWorkflow({rt,store:f.store,verifyBinding:()=>true})
  const reg=await workflow.invoke({agent:{id:'B-owner'}},{action:'register',taskId:'card',operationId:'incoming',change:{value:{title:'same task',owner:'owner',reviewer:'reviewer',acceptance:'agreed'}}})
  assert.equal(reg.alreadyRegistered,true)
  assert.equal(reg.task.roomId,'A')
  assert.equal(f.store.list().length,1)
  assert.equal(f.store.listActions('card').length,0)
  assert.throws(()=>f.store.projectCoordination.requireAcknowledged(f.store.get('card'),'owner'),/revision 2/)
  bot('A-owner',{action:'ack',revision:d.revision})
  const edit={operationId:'edit',actor:'user',taskId:'card',expectedRevision:1,type:'card-details',value:{stage:'QA',description:'private evidence stays on the original'}}
  f.store.command(edit)
  assert.equal(f.store.command(edit).revision,2)
  assert.throws(()=>f.store.projectCoordination.requireAcknowledged(f.store.get('card'),'owner'),/revision 3/)
  const latest=show('B').events[0]
  assert.equal(latest.kind,'task'); assert.equal(latest.taskId,'card');assert.equal(latest.stage,'QA')
  assert.equal(latest.operationId,'edit');assert.equal(latest.actor,'user');assert.equal(latest.taskRevision,2)
  assert.doesNotMatch(JSON.stringify(show('B')),/private evidence/)
  assert.equal(show('B').events.length,3)
  bot('A-owner',{action:'ack',revision:3})
  assert.doesNotThrow(()=>f.store.projectCoordination.requireAcknowledged(f.store.get('card'),'owner'))
  assert.throws(()=>f.store.command({...edit,operationId:'old-change'}),/revision conflict/)
  assert.equal(show('B').project.revision,3)
  f.reopen()
  assert.equal(show('B').events[0].operationId,'edit')
  assert.equal(f.store.get('card').revision,2)
})

test('scope conflicts and item changes preserve one claim and its original release history',t=>{
  const {store,api,bind,decide,bot,show}=fixture(t)
  api.userCall('board-project-bind',bind)
  const card={id:'first',scope:'room:A',owner:'owner',reviewer:'reviewer',title:'First',acceptance:'Reviewed',type:'feature'}
  store.create({operationId:'origin',actor:'user',task:card})
  store.create({operationId:'competing',actor:'user',task:{...card,id:'second',scope:'room:B'}})
  api.userCall('board-project-decide',{...decide,taskId:'first'})
  assert.throws(()=>api.userCall('board-project-decide',{...decide,taskId:'second',expectedRevision:2,operationId:'competing-claim'}),/first in group A/)
  api.userCall('board-project-decide',{...decide,resource:'repo/other',taskId:'second',expectedRevision:2,operationId:'independent'})
  const child={...card,id:'child',type:'development'}
  store.create({operationId:'child',actor:'user',task:{...child,parentTaskId:'first'}})
  let event=show('B').events[0]
  assert.equal(event.parentTaskId,'first')
  assert.deepEqual(event.changedFields,['created'])
  assert.equal(store.projectCoordination.existingLink('first').taskId,'first')
  store.command({operationId:'child-edit',actor:'user',taskId:'child',expectedRevision:1,type:'card-details',value:{stage:'Validation'}})
  event=show('B').events[0]
  assert.equal(event.parentTaskId,'first');assert.equal(event.stage,'Validation')
  assert.equal(store.projectCoordination.taskHistory('A','first')[0].taskId,'child')
  assert.equal(store.projectCoordination.taskHistory('C','first').length,0)
  const original=store.createRelease({operationId:'release',actor:'user',release:{id:'minor',scope:'room:A',name:'Minor',version:'1.0'}})
  store.assignRelease({operationId:'assign',actor:'user',releaseId:original.id,expectedReleaseRevision:original.revision,taskId:'first',expectedTaskRevision:1})
  store.updateRelease({operationId:'release-name',actor:'user',releaseId:original.id,expectedRevision:original.revision,value:{version:'1.1'}})
  event=show('B').events[0]
  assert.equal(event.taskId,'first'); assert.equal(event.releaseVersion,'1.1')
  assert.deepEqual(event.changedFields,['release.version'])
  assert.equal(store.get('second').releaseId,undefined)
  const privateRead=bot('private-owner',{action:'ack',room_id:'A',revision:event.revision})
  assert.equal(privateRead.context,'private')
  assert.equal(show('B').events[0].acknowledgements.length,0)
  assert.throws(()=>bot('unrelated-owner',{action:'ack',room_id:'A',revision:event.revision}),/identified session/)
  bot('A-owner',{action:'ack',revision:event.revision})
  assert.equal(show('B').events[0].acknowledgements.length,1)
})

test('ordinary members have current rules without a queue of unrelated status acknowledgements',t=>{
  const {rt,api,bind,decide}=fixture(t)
  rt.state.rooms.B.members.push('observer')
  rt.botOf=id=>({id})
  api.userCall('board-project-bind',bind)
  api.userCall('board-project-decide',decide)
  const text=api.prompt(rt.roomOf('B'),{id:'observer'})
  assert.match(text,/Keep previous headings/)
  assert.doesNotMatch(text,/pending changes/)
  assert.match(api.prompt(rt.roomOf('B'),{id:'pm'}),/pending changes/)
})
