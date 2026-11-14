import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createBoardApi } from '../../src/host/board-api.js'

function fixture() {
  const rows = []; const operations = new Map()
  const state = { revision: 2, rooms: { room: { members: ['one', 'two'] } }, bots: { one: { name: 'One' }, two: { name: 'Two' }, private: { private: true, name: 'Secret' } } }
  let writable = true, limit = 1000
  const store = {
    limits: () => ({ tasks:limit, dependencies:100 }),
    list: () => rows,
    get: id => rows.find(row => row.id === id),
    operation: id => operations.get(id),
    history: id => ({ entries:[{ after:{ revision:1, title:id } }], truncated:false }),
    proposeChange: input => ({ id:'change', source:input.taskId, value:input.value }),
    create: ({ operationId, actor, task }) => {
      const found = operations.get(operationId)
      if (found) { if (found.input !== JSON.stringify(task)) throw new Error('operation conflict'); return found.result }
      assert.equal(actor, 'user'); const record = { ...task, status: 'proposed', revision: 1, attachments: [] }
      rows.push(record); operations.set(operationId, { taskId: task.id, result: record, input: JSON.stringify(task) }); return record
    },
    command: ({ operationId, taskId, expectedRevision, actor, type, value }) => {
      assert.equal(actor, 'user')
      const task = rows.find(row => row.id === taskId); assert.ok(task)
      const input = JSON.stringify({ taskId, expectedRevision, type, value }), found = operations.get(operationId)
      if (found) { if (found.input !== input) throw new Error('operation conflict'); return found.result }
      if (task.revision !== expectedRevision) throw new Error('revision conflict')
      if (type === 'edit' || type === 'card-details') Object.assign(task, value)
      else if (type === 'personal-progress') task.personalProgress = value.progress
      else if (type === 'attach') task.attachments.push(...value.images)
      else if (type === 'remove-image') task.attachments = task.attachments.filter(image => image.id !== value.imageId)
      task.revision += 1
      const result = structuredClone(task); operations.set(operationId, { taskId, result, input }); return result
    },
  }
  const api = createBoardApi({ store, roster: () => state, assertWritable: () => { if (!writable) throw new Error('locked') } })
  return { api, state, rows, setWritable: v => { writable = v }, setLimit: v => { limit = v } }
}
const room = { kind: 'room', id: 'room' }
const user = { kind: 'user' }
const proposal = { operationId: 'op1', taskId: 'task1', title: 'Build', acceptance: 'Independent check', owner: 'one', reviewer: 'two', dependencies: [] }

test('task history requires the owner principal and the same board scope', () => {
  const f = fixture(); f.api.create(room, user, proposal)
  assert.equal(f.api.history(room, user, 'task1').entries[0].after.title, 'task1')
  assert.throws(() => f.api.history(room, {kind:'bot', id:'one'}, 'task1'))
  f.state.rooms.other = {members:['one','two']}
  assert.throws(() => f.api.history({kind:'room',id:'other'}, user, 'task1'))
})

test('a group proposal is durable under the same operation ID and visible from the owner board', () => {
  const f = fixture(); const created = f.api.create(room, user, proposal)
  assert.deepEqual(f.api.create(room, user, proposal), created)
  assert.equal(f.rows.length, 1)
  assert.equal(f.api.operation(room, user, 'op1').state, 'committed')
  assert.equal(f.api.list({ kind: 'personal', id: 'one' }, user).tasks[0].id, 'task1')
  assert.throws(() => f.api.create(room, user, { ...proposal, title: 'Different' }), /operation conflict/)
})

test('private or nonmember Bots cannot be put in a group proposal', () => {
  const f = fixture()
  assert.throws(() => f.api.create(room, user, { ...proposal, owner: 'private' }))
  assert.equal(f.rows.length, 0)
})

test('a Bot cannot impersonate the instance user or view another personal board', () => {
  const f = fixture()
  assert.throws(() => f.api.create(room, { kind: 'bot', id: 'one' }, proposal))
  assert.throws(() => f.api.list({ kind: 'personal', id: 'two' }, { kind: 'bot', id: 'one' }))
})

test('read-only lock preserves inspection but rejects creation', () => {
  const f = fixture(); f.setWritable(false)
  assert.equal(f.api.list(room, user).capabilities.create, false)
  assert.throws(() => f.api.create(room, user, proposal))
  assert.equal(f.rows.length, 0)
})

test('the instance user sees the task cap and why creation is disabled', () => {
  const f = fixture(); f.setLimit(1); f.api.create(room, user, proposal)
  const view = f.api.list(room, user)
  assert.equal(view.capabilities.taskCount, 1); assert.equal(view.capabilities.taskLimit, 1); assert.equal(view.capabilities.taskLimitReached, true); assert.equal(view.capabilities.create, false)
  assert.throws(() => f.api.create(room, user, { ...proposal, taskId:'other', operationId:'other' }), /limit reached/i)
  assert.equal(f.api.list(room, { kind:'bot', id:'one' }).capabilities.taskCount, undefined)
})

test('unknown or inaccessible operations stay unknown', () => {
  const f = fixture()
  assert.deepEqual(f.api.operation(room, user, 'missing'), { state: 'unknown' })
})

test('an authorized user edits a card without impersonating its Bot owner', () => {
  const f = fixture(); f.api.create(room, user, proposal)
  const value = { title: 'New title', owner: 'one', reviewer: 'two', acceptance: proposal.acceptance, dependencies: [] }
  const edited = f.api.command(room, user, { operationId: 'edit-1', taskId: 'task1', expectedRevision: 1, type: 'edit', value })
  assert.equal(edited.title, 'New title'); assert.equal(edited.owner, 'one'); assert.equal(edited.revision, 2)
  assert.deepEqual(f.api.command(room, user, { operationId: 'edit-1', taskId: 'task1', expectedRevision: 1, type: 'edit', value }), edited)
})

test('editing an active task creates a change request without overwriting the original', () => {
  const f = fixture(); f.api.create(room, user, proposal)
  f.rows[0].status = 'working'
  const value = {title:'New title', owner:'one', reviewer:'two', acceptance:'New acceptance', dependencies:[]}
  const changed = f.api.command(room, user, {operationId:'change', taskId:'task1', expectedRevision:1, type:'edit', value})
  assert.equal(changed.source, 'task1'); assert.equal(changed.value.acceptance, 'New acceptance')
  assert.equal(f.rows[0].title, 'Build'); assert.equal(f.rows[0].status, 'working')
  f.state.rooms.other = {members:['one','two']}
  assert.throws(() => f.api.command({kind:'room',id:'other'}, user, {operationId:'bad',taskId:'task1',expectedRevision:1,type:'edit',value}))
})

test('card details are scoped, explicit capabilities and do not leak into shared projections', () => {
  const f = fixture(); f.api.create(room, user, proposal)
  const before=f.api.list(room,user)
  assert.deepEqual({ description:before.tasks[0].description, dueDate:before.tasks[0].dueDate, labels:before.tasks[0].labels, checklist:before.tasks[0].checklist },
    { description:'', dueDate:null, labels:[], checklist:[] })
  assert.ok(before.capabilities.commands.task1.some(item => item.type === 'card-details'))
  const request={operationId:'details',taskId:'task1',expectedRevision:1,type:'card-details',value:{description:'Context',labels:['urgent'],checklist:[{id:'one',text:'Check',checked:false}],dueDate:'2028-02-29'}}
  assert.equal(f.api.command(room,user,request).description, 'Context')
  assert.equal(f.api.list(room,user).tasks[0].description, 'Context')
  f.state.rooms.other={members:['one','two']}
  assert.throws(()=>f.api.command({kind:'room',id:'other'},user,{...request,operationId:'bad',expectedRevision:2}),/not available/)
  assert.throws(()=>f.api.command(room,{kind:'bot',id:'one'},{...request,operationId:'bot',expectedRevision:2}),/Only the instance user/)
  f.setWritable(false)
  assert.equal(f.api.list(room,user).capabilities.commands.task1.length,0)
  assert.throws(()=>f.api.command(room,user,{...request,operationId:'locked',expectedRevision:2}),/locked/)
})

test('a task on another group board cannot be edited from the wrong scope', () => {
  const f = fixture(); f.api.create(room, user, proposal)
  f.state.rooms.other = { members: ['one', 'two'] }
  assert.throws(() => f.api.command({ kind: 'room', id: 'other' }, user, { operationId: 'edit', taskId: 'task1', expectedRevision: 1, type: 'edit', value: {} }), /not available/)
})

test('personal progress is offered only for the user’s own unregistered card', () => {
  const f = fixture(), scope={kind:'personal',id:'user'}
  f.api.create(scope,user,{...proposal,operationId:'mine',taskId:'mine',owner:'user',reviewer:'one'})
  const initial=f.api.list(scope,user)
  assert.equal(initial.tasks[0].personalProgress,'todo')
  assert.ok(initial.capabilities.commands.mine.some(command=>command.type==='personal-progress'))
  const result=f.api.command(scope,user,{operationId:'move',taskId:'mine',expectedRevision:1,type:'personal-progress',value:{progress:'doing'}})
  assert.equal(result.personalProgress,'doing'); assert.equal(result.status,'proposed')
  f.api.create(room,user,{...proposal,operationId:'group',taskId:'group',owner:'user',reviewer:'one'})
  assert.throws(()=>f.api.command(scope,user,{operationId:'bad',taskId:'group',expectedRevision:1,type:'personal-progress',value:{progress:'finished'}}),/unavailable/)
  f.rows.find(task=>task.id==='mine').status='reported'
  assert.ok(!f.api.list(scope,user).capabilities.commands.mine.some(command=>command.type==='personal-progress'))
})
