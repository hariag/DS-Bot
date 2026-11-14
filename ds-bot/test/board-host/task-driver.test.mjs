import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openTaskStore } from '../../src/host/task-store.mjs'
import { createTaskDriver } from '../../src/host/task-driver.mjs'

const opts = {assertWriteLock() {}, authorize() {return true}, verifyRegistration() {return true}, verifyAdmission() {return true}, verifyReceipt() {return true}}
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'board-driver-'))
  const store = openTaskStore(join(dir, 'tasks.sqlite'), opts)
  t.after(() => { store.close(); rmSync(dir, {recursive:true, force:true}) })
  store.create({operationId:'create', actor:'user', task:{id:'task',title:'Task',owner:'owner',reviewer:'reviewer',scope:'personal:owner',acceptance:'Review',dependencies:[]}})
  store.command({operationId:'register',taskId:'task',expectedRevision:1,actor:'user',type:'register',value:{kind:'personal',reference:'user'}})
  const prepare = async action => ({admissionId:`admission-${action.id}`,messageId:`message-${action.id}`,targetBotId:action.actor,targetSessionId:'session',
    payload:{id:`message-${action.id}`,role:'user',source:{kind:'test'},content:[{type:'text',text:'Task'}]}})
  return {store, prepare, path:join(dir, 'tasks.sqlite')}
}

test('the driver leaves ready work untouched without a production admission capability', async t => {
  const {store} = fixture(t), driver = createTaskDriver({store})
  await driver.wake(); await driver.close()
  assert.equal(store.listActions('task')[0].state, 'pending')
})

test('concurrent wakes admit one claimed message and never repeat an accepted action', async t => {
  const {store, prepare} = fixture(t); let sent = 0
  const admission = {available:async()=>true, prepare, admit:async({revalidate})=>{assert.equal(await revalidate(),true); sent++; return 'receipt'}}
  const driver = createTaskDriver({store, admission, authorized:()=>true})
  await Promise.all([driver.wake(), driver.wake(), driver.wake()]); await driver.wake(); await driver.close()
  assert.equal(sent, 1); assert.equal(store.listActions('task')[0].state, 'accepted')
})

test('the durable receipt is committed before admission can start the recipient turn', async t => {
  const {store, prepare} = fixture(t), order = []
  const admission = {available:async()=>true, prepare, admit:async({action,commitReceipt})=>{
    commitReceipt('session-message-receipt')
    assert.equal(store.admission(action.id).state,'accepted')
    order.push('receipt'); order.push('recipient-start')
    return 'session-message-receipt'
  }}
  const driver=createTaskDriver({store,admission,authorized:()=>true})
  await driver.wake(); await driver.close()
  assert.deepEqual(order,['receipt','recipient-start'])
  assert.equal(store.listActions('task')[0].state,'accepted')
})

test('a lost admission outcome is held and never sent again on another wake', async t => {
  const {store, prepare, path} = fixture(t); let attempts = 0
  const admission = {available:async()=>true, prepare, admit:async()=>{attempts++; throw new Error('lost response')}}
  const driver = createTaskDriver({store, admission, authorized:()=>true})
  await driver.wake(); await driver.wake(); await driver.close()
  assert.equal(attempts, 1); assert.equal(store.listActions('task')[0].state, 'uncertain')
  const restarted = openTaskStore(path, opts); t.after(() => restarted.close())
  const afterRestart = createTaskDriver({store:restarted, admission, authorized:()=>true})
  await afterRestart.wake(); await afterRestart.close()
  assert.equal(attempts, 1); assert.equal(restarted.listActions('task')[0].state, 'uncertain')
})

test('revocation during admission prevents release and preserves uncertainty', async t => {
  const {store, prepare} = fixture(t); let allowed = true, sent = 0
  const admission = {available:async()=>true, prepare, admit:async({revalidate})=>{allowed=false; if (!await revalidate()) throw new Error('revoked'); sent++; return 'receipt'}}
  const driver = createTaskDriver({store, admission, authorized:()=>allowed})
  await driver.wake(); await driver.wake(); await driver.close()
  assert.equal(sent, 0); assert.equal(store.listActions('task')[0].state, 'uncertain')
})
