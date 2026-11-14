import test from 'node:test'
import assert from 'node:assert/strict'
import { createBotWorkflow } from '../../src/host/workflow.mjs'

function fixture(wake=async()=>{},verifyActionContext=()=>true) {
  const bots={owner:{id:'owner'},reviewer:{id:'reviewer'},other:{id:'other'}}
  const tasks={one:{id:'one',scope:'personal:owner',owner:'owner',reviewer:'reviewer',revision:1,status:'reported',acceptance:'check',authority:{kind:'user-created'},execution:{mode:'write',workspace:'ws',paths:['src']}},
    two:{id:'two',scope:'personal:owner',owner:'owner',reviewer:'other',revision:1,status:'reported',acceptance:'private',authority:{kind:'user-created'}}}
  const sessions=new Map([['s-owner','owner'],['s-reviewer','reviewer'],['s-other','other']])
  const rt={selfOf:id=>sessions.get(id),botOf:id=>bots[id],groupOwners:new Map(),chatOwners:sessions,chatOf:id=>`s-${id}`}
  const store={get:id=>tasks[id],command(args){const previous=tasks[args.taskId];return tasks[args.taskId]={...previous,revision:previous.revision+1,status:'done'}}}
  return {rt,tasks,workflow:createBotWorkflow({rt,store,wake,verifyActionContext})}
}

test('a selected personal reviewer can see only the assigned card',async()=>{
  const f=fixture(),exec={agent:{id:'s-reviewer'}}
  const visible=await f.workflow.invoke(exec,{action:'show',taskId:'one'})
  assert.deepEqual(visible.task.execution,{mode:'write',workspace:'ws',paths:['src']})
  await assert.rejects(()=>f.workflow.invoke(exec,{action:'show',taskId:'two'}),/not authorized/)
})

test('a Bot in an unrelated turn cannot mutate an accepted task',async()=>{
  const f=fixture(async()=>{},()=>false),exec={agent:{id:'s-reviewer'}}
  await assert.rejects(()=>f.workflow.invoke(exec,{action:'review',taskId:'one',operationId:'review-op',expectedRevision:1,value:{result:'pass',evidence:'reviewed'}}),/not authorized/)
})

test('a reviewer removed while wake is pending receives only the committed receipt',async()=>{
  let start,release;const entered=new Promise(resolve=>{start=resolve}), gate=new Promise(resolve=>{release=resolve})
  const f=fixture(async()=>{start();await gate}),exec={agent:{id:'s-reviewer'}}
  const pending=f.workflow.invoke(exec,{action:'review',taskId:'one',operationId:'review-op',expectedRevision:1,value:{result:'pass',evidence:'reviewed'}})
  await entered;f.tasks.one={...f.tasks.one,reviewer:'other'};release()
  assert.deepEqual(await pending,{committed:true,operationId:'review-op'})
})

test('a user-created group card uses its own authority while honoring the group stop',async()=>{
  let blocked=false
  let task={id:'group-task',scope:'room:r',owner:'owner',reviewer:'reviewer',revision:1,status:'ready',acceptance:'check',authority:{kind:'user-created'}}
  const bots={owner:{id:'owner'},reviewer:{id:'reviewer'}}
  const room={id:'r',members:['owner','reviewer']}
  const rt={selfOf:()=> 'owner',botOf:id=>bots[id],groupOwners:new Map([['session',{roomId:'r'}]]),roomOf:id=>id==='r'?room:undefined,goalDispatchBlocked:()=>blocked}
  const store={get:()=>task,command:()=>{task={...task,revision:2,status:'working'};return task}}
  const workflow=createBotWorkflow({rt,store,verifyActionContext:()=>true})
  const exec={agent:{id:'session'}}
  const input={action:'start',taskId:task.id,operationId:'start-op',expectedRevision:1}
  assert.equal((await workflow.invoke(exec,input)).task.status,'working')
  blocked=true
  await assert.rejects(()=>workflow.invoke(exec,{...input,expectedRevision:2}),/not authorized/)
})
