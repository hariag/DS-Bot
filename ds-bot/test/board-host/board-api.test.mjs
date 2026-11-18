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
      assert.equal(actor, 'user'); const record = { ...task, status: task.draft === true ? 'draft' : 'proposed', revision: 1, attachments: [] }
      delete record.draft
      rows.push(record); operations.set(operationId, { taskId: task.id, result: record, input: JSON.stringify(task) }); return record
    },
    command: ({ operationId, taskId, expectedRevision, actor, type, value }) => {
      assert.equal(actor, 'user')
      const task = rows.find(row => row.id === taskId); assert.ok(task)
      const input = JSON.stringify({ taskId, expectedRevision, type, value }), found = operations.get(operationId)
      if (found) { if (found.input !== input) throw new Error('operation conflict'); return found.result }
      if (task.revision !== expectedRevision) throw new Error('revision conflict')
      if (type === 'edit' || type === 'card-details') Object.assign(task, value)
      else if (type === 'submit' || type === 'restore') task.status = 'proposed'
      else if (type === 'cancel') task.status = 'cancelled'
      else if (type === 'archive') task.archivedAt = 1
      else if (type === 'unarchive') delete task.archivedAt
      else if (type === 'release-assign') { task.releaseId = value.releaseId; task.releasePosition = value.releasePosition ?? null }
      else if (type === 'personal-progress') task.personalProgress = value.progress
      else if (type === 'reorder') task.position = value.afterId
      else if (type === 'card-comment') task.comments = [...(task.comments ?? []), { id:operationId, author:'user', text:value.text, at:1 }]
      else if (type === 'card-comment-edit') task.comments = (task.comments ?? []).map(comment => comment.id === value.commentId ? { ...comment, text:value.text } : comment)
      else if (type === 'card-comment-delete') task.comments = (task.comments ?? []).filter(comment => comment.id !== value.commentId)
      else if (type === 'attach') task.attachments.push(...value.images)
      else if (type === 'remove-image') task.attachments = task.attachments.filter(image => image.id !== value.imageId)
      task.revision += 1
      const result = structuredClone(task); operations.set(operationId, { taskId, result, input }); return result
    },
  }
  const api = createBoardApi({ store, roster: () => state, assertWritable: () => { if (!writable) throw new Error('locked') } })
  return { api, state, store, rows, setWritable: v => { writable = v }, setLimit: v => { limit = v } }
}
const room = { kind: 'room', id: 'room' }
const user = { kind: 'user' }
const proposal = { operationId: 'op1', taskId: 'task1', title: 'Build', acceptance: 'Independent check', owner: 'one', reviewer: 'two', dependencies: [] }

test('listing a board uses its task snapshot and only checks actions needed by the visible rows', () => {
  const f = fixture()
  const row = {scope:'room:room', title:'Work', owner:'one', reviewer:'two', actionRevision:2}
  for (const status of ['draft','proposed','waiting','ready','working','reported','done','cancelled']) {
    f.rows.push({...row, id:status, status})
  }
  f.rows.push({...row, id:'other', scope:'room:other', status:'working'})
  let lists = 0
  const actionReads = []
  f.store.list = () => { lists++; return f.rows }
  f.store.get = () => assert.fail('board view re-read an individual task')
  f.store.listActions = id => {
    actionReads.push(id)
    if (id === 'waiting') return [{revision:1, kind:'execute', state:'pending'}]
    if (id === 'reported') return [{revision:2, kind:'execute', state:'accepted'}, {revision:2, kind:'review', state:'uncertain'}]
    return [{revision:2, kind:'execute', state:'claimed'}]
  }
  f.store.listProposals = () => [{id:'p', taskId:'draft', status:'pending'}]
  const view = f.api.list(room, user)
  assert.equal(lists, 1)
  assert.deepEqual(actionReads.sort(), ['proposed','ready','reported','waiting','working'])
  assert.equal(view.proposals[0].taskTitle, row.title)
  assert.equal(view.tasks.find(task => task.id === 'reported').dispatchState, 'uncertain')
  assert.equal(view.tasks.find(task => task.id === 'ready').dispatchState, 'claimed')
  assert.equal(view.capabilities.commands.proposed.some(item => item.type === 'schedule'), false)
  assert.equal(view.capabilities.commands.waiting.some(item => item.type === 'schedule'), true)

  actionReads.length = 0
  f.setWritable(false)
  const locked = f.api.list(room, user)
  assert.deepEqual(actionReads.sort(), ['ready','reported','working'])
  assert.equal(locked.tasks.find(task => task.id === 'working').dispatchState, 'claimed')
  assert.deepEqual(locked.capabilities.commands.working, [])

  actionReads.length = 0
  const bot = f.api.list(room, {kind:'bot', id:'one'})
  assert.deepEqual(actionReads, [])
  assert.equal(bot.tasks.find(task => task.id === 'working').dispatchState, undefined)
})

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

test('a personal Bot board offers public Bots as independent reviewers and permits scheduling', () => {
  const f=fixture(),scope={kind:'personal',id:'one'}
  f.api.create(scope,user,{...proposal,operationId:'personal-bot',taskId:'personal-bot-task'})
  const board=f.api.list(scope,user)
  assert.ok(board.capabilities.actors.some(actor=>actor.id==='two'))
  assert.ok(board.capabilities.commands['personal-bot-task'].some(command=>command.type==='schedule'))
})

test('private or nonmember Bots cannot be put in a group proposal', () => {
  const f = fixture()
  assert.throws(() => f.api.create(room, user, { ...proposal, owner: 'private' }))
  assert.equal(f.rows.length, 0)
})

test('a user can create a personal card in a progress column but cannot assign that marker to a group', () => {
  const f = fixture(), mine = {...proposal, owner:'user', reviewer:'one', personalProgress:'doing'}
  const card = f.api.create({kind:'personal', id:'user'}, user, mine)
  assert.equal(card.personalProgress, 'doing'); assert.equal(card.status, 'proposed')
  assert.throws(() => f.api.create(room, user, {...mine, operationId:'group', taskId:'group'}), /personal progress/i)
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

test('card fields, ordering and comment commands cross the API while a Bot stays unauthorized', () => {
  const f = fixture()
  const card = f.api.create(room, user, { ...proposal, description:'Copy', dueDate:'2028-02-29T09:30', dueComplete:true, labels:['Urgent'], checklist:[{ id:'check', text:'Inspect', checked:false }] })
  assert.equal(card.description, 'Copy'); assert.equal(card.dueDate, '2028-02-29T09:30'); assert.equal(card.dueComplete, true)
  const board = f.api.list(room, user)
  assert.ok(board.capabilities.commands.task1.some(command => command.type === 'reorder'))
  const ordered = f.api.command(room, user, { operationId:'reorder-1', taskId:'task1', expectedRevision:1, type:'reorder', value:{ afterId:null } })
  assert.equal(ordered.revision, 2)
  assert.throws(() => f.api.command(room, user, { operationId:'reorder-bad', taskId:'task1', expectedRevision:2, type:'reorder', value:{} }), /Invalid reorder/)
  const commented = f.api.command(room, user, { operationId:'comment-1', taskId:'task1', expectedRevision:2, type:'card-comment', value:{ text:'Note' } })
  assert.equal(commented.comments.length, 1)
  assert.ok(f.api.list(room, user).capabilities.commands.task1.some(command => command.type === 'card-comment-edit'))
  const edited = f.api.command(room, user, { operationId:'comment-edit', taskId:'task1', expectedRevision:3, type:'card-comment-edit', value:{ commentId:'comment-1', text:'Edited' } })
  assert.equal(edited.comments[0].text, 'Edited')
  const deleted = f.api.command(room, user, { operationId:'comment-delete', taskId:'task1', expectedRevision:4, type:'card-comment-delete', value:{ commentId:'comment-1' } })
  assert.deepEqual(deleted.comments, [])
  assert.throws(() => f.api.command(room, { kind:'bot', id:'one' }, { operationId:'bot-reorder', taskId:'task1', expectedRevision:5, type:'reorder', value:{ afterId:null } }), /Only the instance user/)
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

test('a card cover crosses the card-details command and appears in the board list', () => {
  const f = fixture(); f.api.create(room, user, proposal)
  f.rows[0].attachments = [{ id:'image-1', name:'cover.png', mediaType:'image/png' }]
  assert.equal(f.api.list(room, user).tasks[0].coverImageId, null)
  const covered = f.api.command(room, user, { operationId:'cover-set', taskId:'task1', expectedRevision:1, type:'card-details', value:{ coverImageId:'image-1' } })
  assert.equal(covered.coverImageId, 'image-1')
  assert.equal(f.api.list(room, user).tasks[0].coverImageId, 'image-1')
  const cleared = f.api.command(room, user, { operationId:'cover-clear', taskId:'task1', expectedRevision:2, type:'card-details', value:{ coverImageId:null } })
  assert.equal(cleared.coverImageId, null)
  assert.equal(f.api.list(room, user).tasks[0].coverImageId, null)
})

test('the board view exposes task types, draft/cancel commands and release summaries', () => {
  const f = fixture(), scope = room
  f.api.create(scope, user, { ...proposal, operationId:'typed', taskId:'typed', type:'requirement', draft:true })
  const board = f.api.list(scope, user)
  const typed = board.tasks.find(task => task.id === 'typed')
  assert.equal(typed.type, 'requirement')
  assert.equal(typed.status, 'draft')
  assert.ok(board.capabilities.commands.typed.some(command => command.type === 'submit'))
  assert.ok(board.capabilities.commands.typed.some(command => command.type === 'cancel'))
  const submitted = f.api.command(scope, user, { operationId:'submit-typed', taskId:'typed', expectedRevision:1, type:'submit' })
  assert.equal(submitted.status, 'proposed')
  const cancelled = f.api.command(scope, user, { operationId:'cancel-typed', taskId:'typed', expectedRevision:2, type:'cancel' })
  assert.equal(cancelled.status, 'cancelled')
  const restored = f.api.command(scope, user, { operationId:'restore-typed', taskId:'typed', expectedRevision:3, type:'restore' })
  assert.equal(restored.status, 'proposed')
})

test('a title-only draft gets safe defaults and remains a draft', () => {
  const f = fixture()
  const created = f.api.create(room, user, { operationId:'quick-draft', taskId:'quick-draft-task', title:'Remember this', draft:true, dependencies:[] })
  assert.equal(created.status, 'draft')
  assert.equal(created.owner, 'one')
  assert.equal(created.reviewer, 'two')
  assert.equal(created.acceptance, 'To be defined.')
  assert.equal(created.type, 'feature')
  const board = f.api.list(room, user)
  assert.equal(board.summary.total, 1)
  assert.equal(board.summary.statuses.draft, 1)
  assert.ok(Array.isArray(board.releaseCandidates.projectManager))
})

test('archive hides a card from the active summary and offers restore', () => {
  const f = fixture()
  f.api.create(room, user, proposal)
  const archived = f.api.command(room, user, { operationId:'archive-task', taskId:'task1', expectedRevision:1, type:'archive' })
  assert.ok(archived.archivedAt)
  let board = f.api.list(room, user)
  assert.equal(board.tasks[0].archivedAt, archived.archivedAt)
  assert.equal(board.summary.total, 0)
  assert.equal(board.summary.archived, 1)
  assert.ok(board.capabilities.commands.task1.some(command => command.type === 'unarchive'))
  const restored = f.api.command(room, user, { operationId:'unarchive-task', taskId:'task1', expectedRevision:archived.revision, type:'unarchive' })
  assert.equal(restored.archivedAt, undefined)
  board = f.api.list(room, user)
  assert.equal(board.summary.total, 1)
  assert.equal(board.summary.archived, 0)
})
