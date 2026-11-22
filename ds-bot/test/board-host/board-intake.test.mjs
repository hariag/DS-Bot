import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { openTaskStore } from '../../src/host/task-store.mjs'
import { isManualBoardTask, prepareBoardIntake } from '../../src/host/board-intake.mjs'
import { privateTempDir } from '../private-temp.mjs'

function board(t) {
  const dir = privateTempDir(join(tmpdir(), 'dsbot-intake-'))
  const auth = []
  const store = openTaskStore(join(dir, 'tasks.sqlite'), {
    assertWriteLock() {}, authorize(input) { auth.push(input); return true },
    verifyEvidence:() => true, verifyRegistration:() => true, verifyInvalidation:() => true,
  })
  t.after(() => { store.close(); rmSync(dir, { recursive:true, force:true }) })
  let seq = 0
  const update = (taskId, type, actor, value) => store.command({ taskId, type, actor, value, operationId:'op-' + ++seq, expectedRevision:store.get(taskId).revision })
  return { store, update, auth }
}

const scope = 'room:release-group'
const fields = { title:'Deliver a feature', owner:'engineer', reviewer:'qa', acceptance:'Visible to the user' }
const request = (taskId, options = {}) => prepareBoardIntake({ actor:'pm', scope, taskId, operationId:'register-' + taskId, value:fields, ...options })
const evidence = { kind:'personal', evidence:'Observed the expected behavior', environment:'QA bench' }
const pass = { result:'pass', evidence:'Independent QA observed both cases' }

test('authenticated chat cards have a stable journal entry and genuine actor, and cannot forge workflow authority', t => {
  const { store, auth } = board(t)
  const req = request('feat')
  const card = store.create(req)
  assert.equal(card.type, 'feature')
  assert.equal(card.intake.actor, 'pm')
  assert.equal(card.intake.kind, 'chat')
  assert.deepEqual(store.create(req), card)
  assert.equal(auth.at(-1).type, 'intake-create')
  assert.equal(store.history('feat').entries.length, 1)
  assert.throws(() => store.create(request('feat', {value:{...fields, title:'Different'}})), /operation id conflict/)
  assert.throws(() => request('forged', {value:{...fields, authority:{kind:'personal'}}}), /invalid task fields/)
  assert.throws(() => store.create({...req, actor:'user'}), /invalid task intake/)
  assert.throws(() => store.create({actor:'user', operationId:'forged', task:{...req.task, intake:{kind:'chat'}}}), /invalid fields/)
  assert.throws(() => request('legacy', {value:{...fields, type:'design'}}), /feature or bugfix/)
  assert.deepEqual(store.listActions('feat'), [])
})

test('chat work uses the same card through blocked, rework and independent acceptance; parent waits for all items', t => {
  const { store, update } = board(t)
  store.create(request('feature'))
  const item = store.create(request('item', {parentTaskId:'feature'}))
  assert.equal(item.parentTaskId, 'feature')
  assert.equal(item.type, 'development')
  assert.throws(() => store.create(request('grandchild', {parentTaskId:'item'})), /parent card unavailable/)
  assert.throws(() => store.create(request('cross', {scope:'room:other', parentTaskId:'feature'})), /parent card unavailable/)
  update('item', 'block', 'engineer', {owner:'pm', reason:'Need input', condition:'Choose variant'})
  assert.throws(() => update('item', 'start', 'engineer'), /cannot start/)
  update('item', 'unblock', 'pm')
  update('feature', 'start', 'engineer')
  assert.throws(() => update('feature', 'report', 'engineer', evidence), /finish and review all items/)
  assert.throws(() => update('item', 'start', 'qa'), /cannot start/)
  update('item', 'start', 'engineer')
  update('item', 'report', 'engineer', evidence)
  assert.throws(() => update('item', 'review', 'engineer', pass), /cannot review/)
  assert.equal(update('item', 'review', 'qa', {...pass, result:'rework'}).status, 'waiting')
  update('item', 'start', 'engineer')
  update('item', 'report', 'engineer', evidence)
  update('item', 'review', 'qa', pass)
  update('feature', 'report', 'engineer', evidence)
  assert.throws(() => store.create(request('late', {parentTaskId:'feature'})), /parent card unavailable/)
  assert.equal(update('feature', 'review', 'qa', pass).status, 'done')
  assert.deepEqual(store.listActions('item'), [])
  assert.deepEqual(store.listActions('feature'), [])
  assert.equal(store.get('item').actionRevision, null)
  update('item', 'invalidate', 'user', {reason:'Acceptance changed', evidence:'New result'})
  assert.equal(store.get('feature').stale, true)
  assert.throws(() => update('feature', 'revalidate', 'qa', {evidence:'Old results'}), /cannot revalidate/)
  update('item', 'revalidate', 'qa', {evidence:'Updated item proof'})
  const reopened = store.get('feature')
  assert.equal(reopened.stale, false)
  assert.equal(reopened.blocked, null)
  assert.equal(reopened.status, 'reported')
  assert.equal(update('feature', 'review', 'qa', pass).status, 'done')
})

test('minor releases stay in their group, keep cards as the release members and grant normal dispatch only on launch', t => {
  const { store, update } = board(t)
  const release = store.createRelease({ actor:'user', operationId:'release', release:{ id:'r1', scope, name:'Beta', version:'1.1' } })
  store.create(request('f', {releaseId:'r1'}))
  const item = store.create(request('item', {parentTaskId:'f', releaseId:'r1'}))
  assert.equal(item.releaseId, undefined)
  const planned = store.create({ actor:'user', operationId:'planned', task:{...fields, scope, id:'planned', type:'test', parentTaskId:'f'} })
  assert.equal(isManualBoardTask(planned), false)
  assert.equal(store.get('f').releaseId, 'r1')
  assert.throws(() => store.create(request('elsewhere', {scope:'room:other', releaseId:'r1'})), /release unavailable/)
  assert.throws(() => store.create(request('misplaced', {parentTaskId:'f', releaseId:'r2'})), /inherits its parent release/)
  assert.throws(() => update('item', 'start', 'engineer'), /parent card or release unavailable/)
  assert.throws(() => update('f', 'start', 'engineer'), /release is not running/)
  assert.deepEqual(store.listActions('f'), [])
  store.startRelease({ actor:'user', operationId:'launch', releaseId:'r1', expectedRevision:release.revision })
  assert.equal(isManualBoardTask(store.get('f')), false)
  assert.equal(store.listActions('f').length, 1)
  assert.equal(store.listActions('planned').length, 1)
  assert.equal(store.listActions('item').length, 0)
  assert.throws(() => update('f', 'start', 'engineer'), /verified action receipt required/)
  assert.throws(() => update('planned', 'start', 'engineer'), /verified action receipt required/)
  assert.equal(update('item', 'start', 'engineer').status, 'working')
})
