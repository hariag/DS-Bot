import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { createGoalBoardEditor } from '../../src/host/goal-board-editor.js'
import { legacyGoalCardId } from '../../src/host/legacy-goal.js'

const base='/data2t/codex-quarantine/dsbot-card-metadata-evidence-20261114'
const image={id:'image-1',name:'file.png',mediaType:'image/png',size:1,sha256:'a'.repeat(64)}
const scope={kind:'room',id:'room'}
function fixture() {
  const dir=mkdtempSync(join(base,'goal-fault-')), statePath=join(dir,'state.json')
  const task={id:'t1',botId:'owner',task:'Original',status:'pending'}
  const goal={id:'goal-1',revision:1,current:0,status:'active',stages:[{id:'s1',title:'Stage',tasks:[task]}],events:[]}
  const room={id:'room',name:'Room',members:['owner'],goal}
  const state={version:1,rooms:{room},bots:{owner:{name:'Owner'}}}
  writeFileSync(statePath,JSON.stringify(state),{mode:0o600})
  let failure='none',locked=true,writing=Promise.resolve()
  const rt={state,statePath,roomOf:id=>state.rooms[id],requireHomeLock(){if(!locked)throw new Error('lock lost')},homeLockVersion(){if(!locked)throw new Error('lock lost');return 'lease-1'},warn(){},save(){
    const op=writing.then(async()=>{if(failure==='before')throw new Error('before save');await writeFile(`${statePath}.tmp`,JSON.stringify(state),{mode:0o600});await rename(`${statePath}.tmp`,statePath);if(failure==='after')throw new Error('after save')})
    writing=op.catch(()=>{});return op
  }}
  const cardId=legacyGoalCardId('room','goal-1','s1','t1')
  return {state,room,goal,task,rt,cardId,setFailure:x=>{failure=x},setLocked:x=>{locked=x}}
}

test('same upload identity is applied once and remains addressable after title change',async()=>{
  const f=fixture(),editor=createGoalBoardEditor(f.rt)
  const input={taskId:f.cardId,expectedRevision:1}, request={kind:'attach',id:'image-1',digest:image.sha256}
  const first=await editor.execute(scope,'goal:upload',request,()=>editor.mutate(scope,input,'attach',[image]))
  assert.equal(first.state,'committed')
  assert.deepEqual(await editor.execute(scope,'goal:upload',request,()=>{throw Error('must not repeat')}),first)
  await assert.rejects(editor.execute(scope,'goal:upload',{...request,digest:'different'},()=>{}),/used/)
  const edit={taskId:f.cardId,expectedRevision:2,value:{title:'Renamed'}}
  assert.equal((await editor.execute(scope,'goal:rename',edit,()=>editor.mutate(scope,edit,'edit'))).state,'committed')
  assert.equal(editor.imageReference(scope,f.cardId,image.id).reference.sha256,image.sha256)
  assert.equal(f.task.boardImages.length,1)
})

test('two different updates to one version serialize: one commits and one is rejected',async()=>{
  const f=fixture(),editor=createGoalBoardEditor(f.rt)
  const a={taskId:f.cardId,expectedRevision:1,value:{title:'A'}},b={taskId:f.cardId,expectedRevision:1,value:{title:'B'}}
  const results=await Promise.all([editor.execute(scope,'goal:a',a,()=>editor.mutate(scope,a,'edit')),editor.execute(scope,'goal:b',b,()=>editor.mutate(scope,b,'edit'))])
  const settled=await Promise.all(results.map((result,index)=>result.state==='unknown'?editor.operation(scope,index===0?'goal:a':'goal:b'):result))
  assert.deepEqual(settled.map(x=>x.state).sort(),['committed','rejected'])
  assert.equal(f.task.task,'A');assert.equal(f.goal.revision,2)
})

test('a lost acknowledgement after save remains unknown until durable receipt is checked',async()=>{
  const f=fixture(),editor=createGoalBoardEditor(f.rt),input={taskId:f.cardId,expectedRevision:1}
  f.setFailure('after')
  assert.equal((await editor.execute(scope,'goal:uncertain',input,()=>editor.mutate(scope,input,'attach',[image]))).state,'unknown')
  assert.equal(f.task.boardImages.length,1)
  assert.equal((await editor.operation(scope,'goal:uncertain')).state,'committed')
  assert.equal(f.task.boardImages.length,1)
})

test('saved receipt and original images survive reopening without replay',async()=>{
  const f=fixture(),editor=createGoalBoardEditor(f.rt),input={taskId:f.cardId,expectedRevision:1}
  const committed=await editor.execute(scope,'goal:restart',input,()=>editor.mutate(scope,input,'attach',[image]))
  assert.equal(committed.state,'committed')
  const state=JSON.parse(readFileSync(f.rt.statePath,'utf8'))
  const restarted=createGoalBoardEditor({...f.rt,state,roomOf:id=>state.rooms[id]})
  const replay=await restarted.execute(scope,'goal:restart',input,()=>{throw Error('must not replay')})
  assert.deepEqual(replay,committed)
  assert.equal(state.rooms.room.goal.stages[0].tasks[0].boardImages.length,1)
  assert.equal(restarted.imageReference(scope,f.cardId,image.id).reference.sha256,image.sha256)
})

test('a save failure before writing is not reported as committed',async()=>{
  const f=fixture(),editor=createGoalBoardEditor(f.rt),input={taskId:f.cardId,expectedRevision:1}
  f.setFailure('before')
  assert.equal((await editor.execute(scope,'goal:before',input,()=>editor.mutate(scope,input,'attach',[image]))).state,'unknown')
  assert.equal((await editor.operation(scope,'goal:before')).state,'unknown')
  assert.equal((await editor.execute(scope,'goal:before',input,()=>{})).state,'unknown')
})

test('images never move to a replacement goal with reused task IDs and vanish after source access is lost',async()=>{
  const f=fixture(),editor=createGoalBoardEditor(f.rt),input={taskId:f.cardId,expectedRevision:1}
  assert.equal((await editor.execute(scope,'goal:add',input,()=>editor.mutate(scope,input,'attach',[image]))).state,'committed')
  f.room.goal={id:'goal-2',revision:1,current:0,status:'active',stages:[{id:'s1',title:'Stage',tasks:[{id:'t1',botId:'owner',task:'New',status:'pending'}]}]}
  assert.throws(()=>editor.imageReference(scope,f.cardId,image.id),/unavailable|changed/i)
  const replacement=legacyGoalCardId('room','goal-2','s1','t1')
  assert.throws(()=>editor.imageReference(scope,replacement,image.id),/unavailable|changed/i)
  delete f.state.rooms.room
  assert.throws(()=>editor.imageReference(scope,f.cardId,image.id),/unavailable|changed/i)
})

test('archived goal images stay with the original goal and are hidden if a personal board loses membership',async()=>{
  const f=fixture(),editor=createGoalBoardEditor(f.rt),input={taskId:f.cardId,expectedRevision:1}
  assert.equal((await editor.execute(scope,'goal:archive-add',input,()=>editor.mutate(scope,input,'attach',[image]))).state,'committed')
  f.room.pastGoals=[f.room.goal]
  f.room.goal={id:'new-goal',revision:1,current:0,status:'active',stages:[{id:'s1',title:'Stage',tasks:[{id:'t1',botId:'owner',task:'New',status:'pending'}]}]}
  assert.equal(editor.imageReference(scope,f.cardId,image.id).reference.sha256,image.sha256)
  const personal={kind:'personal',id:'owner'}
  assert.equal(editor.imageReference(personal,f.cardId,image.id).reference.sha256,image.sha256)
  f.room.members=[]
  assert.throws(()=>editor.imageReference(personal,f.cardId,image.id),/unavailable|changed/i)
})
