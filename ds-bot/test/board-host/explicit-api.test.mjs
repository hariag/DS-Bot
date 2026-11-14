import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createBoardApi } from '../../src/host/board-api.js'

const room={kind:'room',id:'r'}, user={kind:'user'}, scope={mode:'write',workspace:'ws',paths:['src']}
const proposal={operationId:'op',taskId:'t1',title:'Build',acceptance:'Independent review',owner:'owner',reviewer:'reviewer',dependencies:[],execution:scope}
function fixture(enabled){
  const state={revision:1,rooms:{r:{members:['owner','reviewer']}},bots:{owner:{name:'Owner'},reviewer:{name:'Reviewer'}}}
  const store={list:()=>[],limits:()=>({tasks:1000}),createExplicit(input){return input},create(input){return input}}
  const api=createBoardApi({store,roster:()=>state,assertWritable(){},explicitRequired:()=>enabled,explicitAvailable:()=>enabled,defaultExecution:()=>scope,workspaces:()=>[{id:'ws',name:'Workspace'}]})
  return {api,state}
}
test('explicit work is opt-in and requires authenticated owner plus listed workspace',()=>{
  const off=fixture(false);assert.equal(off.api.list(room,user).capabilities.explicitCreate,false)
  assert.throws(()=>off.api.create(room,user,proposal),/unavailable/)
  const on=fixture(true);assert.equal(on.api.list(room,user).capabilities.explicitCreate,true)
  assert.deepEqual(on.api.create(room,user,proposal).execution,scope)
  const {execution:_,...withoutExecution}=proposal
  assert.deepEqual(on.api.create(room,user,withoutExecution).execution,scope)
  assert.throws(()=>on.api.create(room,{kind:'bot',id:'owner'},proposal),/instance user/)
  assert.throws(()=>on.api.create(room,user,{...proposal,owner:'user'}),/unavailable/)
  assert.throws(()=>on.api.create(room,user,{...proposal,execution:{...scope,workspace:'other'}}),/unavailable/)
})
