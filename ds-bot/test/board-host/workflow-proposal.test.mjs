import test from 'node:test'
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openTaskStore } from '../../src/host/task-store.mjs'
import { createBotWorkflow } from '../../src/host/workflow.mjs'
import { installTaskTool } from '../../src/host/task-tool.mjs'
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
  return { store, workflow, home, rt }
}

const task = { id:'t1', title:'Proposal target', scope:'personal:one', owner:'one', reviewer:'two', acceptance:'review', dependencies:[] }
const command = (store, type, value, operationId) => store.command({ operationId, taskId:'t1', expectedRevision:store.get('t1').revision, actor:'user', type, ...(value === undefined ? {} : { value }) })

test('Bot discovery scopes minor releases and filters the authorized rows before pagination', async t => {
  const {store, rt, workflow} = fixture(t)
  const rooms = {g:{id:'g',members:['one','two']}, other:{id:'other',members:['one','two']}}
  rt.state = {rooms,bots:{one:{},two:{}}}
  rt.roomOf = id => rooms[id]
  rt.groupOwners.set('g-one', {roomId:'g'})
  rt.selfOf = id => id === 'g-one' || id === 'chat-one' ? 'one' : undefined
  rt.teamTools = []
  const tool = installTaskTool(rt, workflow, value => value)
  const call = async (args, sid = 'g-one') => JSON.parse(await tool.execute(args, {agent:{id:sid}}))
  const list = async args => (await call({action:'list', ...args})).items
  const create = (id, scope, fields = {}) => store.create({actor:'user',operationId:'new-'+id,task:{...task,id,scope,...fields}})
  for (const room of Object.keys(rooms)) {
    store.createRelease({actor:'user',operationId:'release-'+room,release:{id:'r-'+room,scope:'room:'+room,name:'Minor '+room,version:'1.2'}})
  }
  const parent = create('feat', 'room:g', {type:'feature'})
  store.assignRelease({actor:'user',operationId:'assign',releaseId:'r-g',expectedReleaseRevision:1,taskId:parent.id,expectedTaskRevision:1})
  for (let i = 0; i < 22; i++) {
    create('item-'+i, 'room:g', {parentTaskId:parent.id, owner:i%2 ? 'one' : 'two', reviewer:i%2 ? 'two' : 'one'})
  }
  create('other-work', 'room:g', {parentTaskId:parent.id, owner:'two', reviewer:'user'})
  const shared = create('shared', 'room:other')
  store.command({actor:'user',operationId:'share',taskId:shared.id,expectedRevision:1,type:'share',value:{targetRoomId:'g',fields:['status']}})

  const reads = t.mock.method(store, 'list')
  const [release] = await list({kind:'release',query:'1.2'})
  assert.equal(reads.mock.callCount(), 0)
  assert.deepEqual(release, {kind:'release',id:'r-g',title:'Minor g',version:'1.2',status:'draft'})
  assert.deepEqual(await list({kind:'release',query:'minor g'}), [release])
  assert.deepEqual(await list({kind:'release',release_id:'r-other'}), [])
  assert.deepEqual(await list({release_id:'r-other'}), await list({release_id:'unknown'}))
  assert.deepEqual((await call({action:'list',kind:'release'},'chat-one')).items, [])
  await assert.rejects(call({action:'list',kind:'release',room_id:'other'}), /authorized/)
  assert.deepEqual((await list({kind:'shared'})).map(row => row.id), [shared.id])
  assert.deepEqual(await list({kind:'shared',mine:true}), [])
  assert.deepEqual(await list({kind:'shared',release_id:'r-g'}), [])
  const previousReads = reads.mock.callCount()
  assert.equal((await list({})).some(row => row.kind === 'release'), false)
  assert.equal(reads.mock.callCount() - previousReads, 1)
  const page = {action:'list',kind:'item',release_id:'r-g',mine:true}
  const first = await call(page), last = await call({...page,cursor:first.nextCursor})
  const found = [...first.items, ...last.items]
  assert.equal(first.items.length, 20)
  assert.equal(last.nextCursor, undefined)
  assert.deepEqual(found.map(row => row.id).sort(), Array.from({length:22}, (_,i) => 'item-'+i).sort())
  assert.ok(found.every(row => row.releaseId === release.id))
  for (const taskId of [parent.id, found[0].id]) {
    const [row] = await list({release_id:'r-g',query:taskId,kind:taskId === parent.id ? 'card' : 'item'})
    assert.equal((await call({action:'show',task_id:row.id})).task.releaseId, row.releaseId)
  }
})

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


test('assigned participants can leave idempotent replies on a draft without authorizing work', async t => {
  const {store,workflow,rt} = fixture(t)
  const group = {id:'g',members:['one','two','three'],sessions:{one:'g-one',two:'g-two',three:'g-three'}}
  rt.state = {rooms:{g:group},bots:{one:{},two:{},three:{}}}
  rt.botOf = id => ['one','two','three'].includes(id) ? {id,name:id} : undefined
  rt.roomOf = id => id === 'g' ? group : undefined
  rt.selfOf = id => ({'g-one':'one','g-two':'two','g-three':'three','other-one':'one'})[id]
  rt.groupOwners.set('g-one',{roomId:'g'})
  rt.groupOwners.set('g-two',{roomId:'g'})
  rt.groupOwners.set('g-three',{roomId:'g'})
  rt.groupOwners.set('other-one',{roomId:'other'})
  const user = 'user'
  const parent = store.create({operationId:'parent',actor:user,task:{id:'f',title:'Feature',scope:'room:g',owner:'one',reviewer:'two',acceptance:'proof',dependencies:[],type:'feature',draft:true}})
  const release = store.createRelease({operationId:'release',actor:user,release:{id:'r',scope:'room:g',name:'Draft release',version:'pending'}})
  store.assignRelease({operationId:'assign',actor:user,releaseId:release.id,expectedReleaseRevision:release.revision,taskId:parent.id,expectedTaskRevision:parent.revision})
  const item = store.create({operationId:'item',actor:user,task:{id:'i',title:'Imported',scope:'room:g',owner:'one',reviewer:'two',acceptance:'proof',dependencies:[],parentTaskId:'f',draft:true}})
  const exec = {agent:{id:'g-one'}}
  const req = {action:'reply',taskId:'i',operationId:'reply-1',expectedRevision:item.revision,note:'Reviewing the evidence.'}
  const result = await workflow.invoke(exec,req)
  assert.equal(result.task.status,'draft')
  assert.equal(result.task.replies[0].text,'Reviewing the evidence.')
  assert.deepEqual(await workflow.invoke(exec,req),result)
  assert.equal((await workflow.invoke(exec,{action:'operation',taskId:'i',operationId:'reply-1'})).state,'committed')
  await assert.rejects(workflow.invoke(exec,{...req,note:'A different reply'}), /operation id conflict/)
  await assert.rejects(workflow.invoke({agent:{id:'other-one'}},{...req,operationId:'cross'}), /authorized/)
  await assert.rejects(workflow.invoke({agent:{id:'g-three'}},{...req,operationId:'unassigned-member',expectedRevision:result.task.revision}), /authorized/)
  await assert.rejects(workflow.invoke(exec,{...req,operationId:'stale'}), /revision conflict/)
  rt.goalDispatchBlocked = () => true
  await assert.rejects(workflow.invoke(exec,{...req,operationId:'paused',expectedRevision:result.task.revision}), /authorized/)
  rt.goalDispatchBlocked = () => false
  const reviewer = await workflow.invoke({agent:{id:'g-two'}},{...req,operationId:'reviewer',expectedRevision:result.task.revision,note:'Review queued.'})
  assert.equal(reviewer.task.replies.at(-1).author,'two')
  assert.equal(store.get('i').authority,null)
  assert.equal(store.get('i').status,'draft')
  assert.deepEqual(store.listActions('i'),[])
})
