import test from 'node:test'
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openTaskStore } from '../../src/host/task-store.mjs'
import { createBotWorkflow } from '../../src/host/workflow.mjs'
import { privateTempDir } from '../private-temp.mjs'

function fixture(t) {
  const home = privateTempDir(join(tmpdir(), 'dsbot-board-proposal-'))
  const store = openTaskStore(join(home, 'tasks.sqlite'), {
    assertWriteLock() {},
    authorize(input) { return input.actor === 'user' || input.actor === 'scheduler' || workflow.authorize(input) },
    verifyRegistration() { return true }, verifyEvidence() { return true }, verifyReceipt() { return true },
    verifyInvalidation() { return true }, verifyAttachment() { return true }, verifyAdmission() { return true },
    verifyShare() { return true }, verifyDependency() { return true },
  })
  const rt = {
    selfOf: sessionId => sessionId === 'chat-one' ? 'one' : sessionId === 'chat-two' ? 'two' : undefined,
    botOf: id => ['one', 'two'].includes(id) ? { id, name:id } : undefined,
    chatOf: id => `chat-${id}`,
    roomOf: () => undefined,
    groupOwners: new Map(),
    goalDispatchBlocked: () => false,
  }
  const workflow = createBotWorkflow({ rt, store, verifyBinding:() => true, verifyShare:() => true })
  t.after(() => { try { store.close() } catch {} ; rmSync(home, { recursive:true, force:true }) })
  return { store, workflow, home }
}

const task = { id:'t1', title:'Proposal target', scope:'personal:one', owner:'one', reviewer:'two', acceptance:'review', dependencies:[] }
const command = (store, type, value, operationId) => store.command({ operationId, taskId:'t1', expectedRevision:store.get('t1').revision, actor:'user', type, ...(value === undefined ? {} : { value }) })

test('a Bot can propose content changes, query the proposal and cannot apply it itself', async t => {
  const { store, workflow } = fixture(t)
  store.create({ operationId:'create-t1', actor:'user', task })
  command(store, 'register', { kind:'personal', reference:'owner approval' }, 'register-t1')
  const exec = { agent:{ id:'chat-one' } }
  const proposed = await workflow.invoke(exec, { action:'propose', taskId:'t1', expectedRevision:store.get('t1').revision,
    change:{ kind:'update', value:{ description:'Bot drafted the requirement' } }, note:'Please confirm' })
  assert.equal(proposed.proposal.status, 'pending')
  assert.equal(store.get('t1').description, undefined)
  assert.equal(store.listProposals('personal:one').length, 1)
  const queried = await workflow.invoke(exec, { action:'proposal', taskId:'t1', proposalId:proposed.proposal.id })
  assert.equal(queried.proposal.id, proposed.proposal.id)
  assert.equal(queried.proposal.after.description, 'Bot drafted the requirement')
  assert.throws(() => store.command({ operationId:'bot-apply', taskId:'t1', expectedRevision:1, actor:'one', type:'card-details', value:{ description:'direct' } }))
  const decided = store.decideProposal({ operationId:'confirm-1', actor:'user', proposalId:proposed.proposal.id, expectedRevision:1, decision:'confirm',
    apply: current => store.command({ operationId:'apply-1', taskId:current.taskId, expectedRevision:current.baseRevision, actor:'user', type:current.command.type, value:current.command.value }) })
  assert.equal(decided.proposal.status, 'confirmed')
  assert.equal(store.get('t1').description, 'Bot drafted the requirement')
})

test('a Bot proposal status update is applied only by the user and rejected proposals leave the card unchanged', async t => {
  const { store, workflow } = fixture(t)
  store.create({ operationId:'create-t2', actor:'user', task })
  command(store, 'register', { kind:'personal', reference:'owner approval' }, 'register-t2')
  const exec = { agent:{ id:'chat-one' } }
  const proposed = await workflow.invoke(exec, { action:'propose', taskId:'t1', expectedRevision:store.get('t1').revision,
    change:{ kind:'status', value:{ type:'cancel', reason:'superseded' } }, note:'Cancel this card' })
  assert.equal(store.get('t1').status, 'ready')
  store.decideProposal({ operationId:'reject-1', actor:'user', proposalId:proposed.proposal.id, expectedRevision:1, decision:'reject', apply:() => undefined })
  assert.equal(store.get('t1').status, 'ready')
  assert.equal(store.listProposals('personal:one')[0].status, 'rejected')
})

test('a Bot can propose a brand-new card without a task id and the user confirmation creates it', async t => {
  const { store, workflow } = fixture(t)
  const exec = { agent:{ id:'chat-one' } }
  const proposed = await workflow.invoke(exec, { action:'propose', operationId:'new-card-op',
    change:{ kind:'create', value:{ title:'Bot-created card', owner:'one', reviewer:'two', acceptance:'Show evidence', type:'feature', description:'Seeded by a Bot' } }, note:'Please create this' })
  assert.equal(proposed.proposal.kind, 'create')
  assert.equal(proposed.proposal.status, 'pending')
  assert.match(proposed.proposal.taskId, /^card-/)
  assert.equal(store.get(proposed.proposal.taskId), undefined)
  const queried = await workflow.invoke(exec, { action:'proposal', proposalId:proposed.proposal.id })
  assert.equal(queried.proposal.after.title, 'Bot-created card')
  store.decideProposal({ operationId:'confirm-new-card', actor:'user', proposalId:proposed.proposal.id, expectedRevision:1, decision:'confirm',
    apply: current => store.create({ operationId:'apply-new-card', actor:'user', task:{ id:current.taskId, scope:current.scope,
      title:current.command.value.title, owner:current.command.value.owner, reviewer:current.command.value.reviewer,
      acceptance:current.command.value.acceptance, description:current.command.value.description, dependencies:[], type:current.command.value.type } }) })
  assert.equal(store.get(proposed.proposal.taskId).title, 'Bot-created card')
})

test('board_task show returns the card content and the change before/after a Bot must reconcile', async t => {
  const { store, workflow } = fixture(t)
  store.create({ operationId:'show-create', actor:'user', task })
  command(store, 'register', { kind:'personal', reference:'owner approval' }, 'show-register')
  store.command({ operationId:'show-details', taskId:'t1', expectedRevision:store.get('t1').revision, actor:'user', type:'card-details',
    value:{ description:'Card description', type:'design', labels:['ui'], dueDate:'2026-11-20', dueComplete:true, checklist:[{ id:'item-1', text:'first step', checked:true }] } })
  const exec = { agent:{ id:'chat-one' } }
  let shown = await workflow.invoke(exec, { action:'show', taskId:'t1' })
  assert.equal(shown.task.description, 'Card description')
  assert.equal(shown.task.type, 'design')
  assert.deepEqual(shown.task.labels, ['ui'])
  assert.equal(shown.task.dueDate, '2026-11-20')
  assert.equal(shown.task.dueComplete, true)
  assert.deepEqual(shown.task.checklist, [{ text:'first step', checked:true }])
  assert.equal(shown.task.change, undefined)
  // A user edit of active work becomes its own change-request task; its before/after
  // must survive beyond the original dispatch prompt so show can recover it.
  const action = store.listActions('t1').find(item => item.state === 'pending')
  const messageId = 'show-msg', intent = { admissionId:'show-admission', messageId, targetBotId:'one', targetSessionId:'show-session',
    payload:{ id:messageId, role:'user', content:[{ type:'text', text:'go' }], source:{ kind:'bot' } } }
  store.claimAction({ operationId:'show-claim', actor:'scheduler', actionId:action.id, intent })
  store.markAction({ actionId:action.id, actor:'scheduler', expectedState:'claimed', state:'accepted', receipt:'ok' })
  await workflow.invoke(exec, { action:'start', taskId:'t1', operationId:'show-start', expectedRevision:store.get('t1').revision })
  const change = store.proposeChange({ operationId:'show-change', taskId:'t1', expectedRevision:store.get('t1').revision, actor:'user',
    value:{ title:'Proposal target', owner:'one', reviewer:'two', acceptance:'review', dependencies:[], dependencyGrants:[],
      description:'Updated card description', type:'design' } })
  assert.match(change.id, /^change-/)
  shown = await workflow.invoke(exec, { action:'show', taskId:change.id })
  assert.equal(shown.task.description, 'Updated card description')
  assert.equal(shown.task.change.sourceTaskId, 't1')
  assert.equal(shown.task.change.before.description, 'Card description')
  assert.equal(shown.task.change.after.description, 'Updated card description')
})

test('a reused proposal operation id with different content is refused', async t => {
  const { store, workflow } = fixture(t)
  store.create({ operationId:'conflict-create', actor:'user', task })
  const exec = { agent:{ id:'chat-one' } }
  const request = description => ({ action:'propose', taskId:'t1', expectedRevision:store.get('t1').revision, operationId:'conflict-op',
    change:{ kind:'update', value:{ description } }, note:'same note' })
  const first = await workflow.invoke(exec, request('First description'))
  const retried = await workflow.invoke(exec, request('First description'))
  assert.equal(retried.proposal.id, first.proposal.id)
  await assert.rejects(workflow.invoke(exec, request('Different description')), /operation id conflict/)
  assert.equal(store.listProposals('personal:one').length, 1)
  const card = await workflow.invoke(exec, { action:'propose', operationId:'conflict-card',
    change:{ kind:'create', value:{ title:'Card one', owner:'one', reviewer:'two', acceptance:'Proof' } } })
  const cardRetry = await workflow.invoke(exec, { action:'propose', operationId:'conflict-card',
    change:{ kind:'create', value:{ title:'Card one', owner:'one', reviewer:'two', acceptance:'Proof' } } })
  assert.equal(cardRetry.proposal.id, card.proposal.id)
  await assert.rejects(workflow.invoke(exec, { action:'propose', operationId:'conflict-card',
    change:{ kind:'create', value:{ title:'Card two', owner:'one', reviewer:'two', acceptance:'Proof' } } }), /operation id conflict/)
})

test('an archived card cannot receive a Bot proposal', async t => {
  const { store, workflow } = fixture(t)
  store.create({ operationId:'archived-propose', actor:'user', task })
  store.command({ operationId:'archived-propose-archive', taskId:'t1', expectedRevision:1, actor:'user', type:'archive' })
  assert.ok(store.get('t1').archivedAt, 'the card is archived')
  const exec = { agent:{ id:'chat-one' } }
  await assert.rejects(workflow.invoke(exec, { action:'propose', taskId:'t1', operationId:'archived-propose-op',
    change:{ kind:'update', value:{ description:'Late proposal' } } }), /unavailable or the action is not authorized/)
})
