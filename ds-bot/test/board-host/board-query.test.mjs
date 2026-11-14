import { test } from 'node:test'
import assert from 'node:assert/strict'
import { boardList } from '../../src/host/board-query.js'

const rooms = { a: { members: ['one', 'two'] }, b: { members: ['two'] } }
const bots = { one: {}, two: {}, secret: { private: true } }
const tasks = [
  { id: 'a1', revision: 1, title: 'Group A', status: 'working', owner: 'one', reviewer: 'two', scope: 'room:a', dependencies: ['a2', 'b1', 'private'] },
  { id: 'a2', revision: 1, title: 'Review', status: 'reported', owner: 'two', reviewer: 'one', scope: 'room:a', dependencies: [] },
  { id: 'b1', revision: 1, title: 'Group B', status: 'waiting', owner: 'two', reviewer: 'two', scope: 'room:b', dependencies: [] },
  { id: 'private', revision: 1, title: 'Secret', status: 'ready', owner: 'secret', reviewer: 'user', scope: 'personal:secret', dependencies: [] },
  { id: 'mine', revision: 1, title: 'Personal', status: 'ready', owner: 'one', reviewer: 'user', scope: 'personal:one', dependencies: [] },
]
const list = (scope, principal, roster = rooms) => boardList({ scope, principal, rooms: roster, bots, tasks, revision: 7 })

test('a Bot sees its own personal items and both execution and review tasks from its rooms', () => {
  const view = list({ kind: 'personal', id: 'one' }, { kind: 'bot', id: 'one' })
  assert.deepEqual(view.tasks.map(t => t.id), ['a1', 'a2', 'mine'])
  assert.deepEqual(view.tasks[0].dependencies, ['a2'])
  assert.deepEqual(view.capabilities.commands, {})
})

test('a group member cannot query another Bot or a group they do not belong to', () => {
  assert.throws(() => list({ kind: 'personal', id: 'secret' }, { kind: 'bot', id: 'one' }), /not available/)
  assert.throws(() => list({ kind: 'room', id: 'b' }, { kind: 'bot', id: 'one' }), /not available/)
})

test('membership is checked on every query and immediately removes group work', () => {
  const view = list({ kind: 'personal', id: 'one' }, { kind: 'bot', id: 'one' }, { a: { members: ['two'] }, b: rooms.b })
  assert.deepEqual(view.tasks.map(t => t.id), ['mine'])
})

test('the authenticated instance user can view a room or a Bot, never by changing Bot identity', () => {
  const view = list({ kind: 'room', id: 'a' }, { kind: 'user' })
  assert.deepEqual(view.tasks.map(t => t.id), ['a1', 'a2'])
  assert.deepEqual(view.tasks[0].dependencies, ['a2'])
  assert.equal(list({ kind: 'personal', id: 'one' }, { kind: 'user' }).tasks.length, 3)
})

test('object prototype keys are not valid roster identities', () => {
  assert.throws(() => list({ kind: 'room', id: '__proto__' }, { kind: 'user' }), /not available/)
  assert.throws(() => list({ kind: 'personal', id: '__proto__' }, { kind: 'user' }), /not available/)
})

test('a status-only share never reveals card description, due date, labels or checklist', () => {
  const source={...tasks[0],description:'private details',dueDate:'2028-02-29',labels:['private'],checklist:[{id:'x',text:'private',checked:false}],shares:[{id:'grant',taskId:'a1',targetRoomId:'b',fields:['status'],revoked:false}]}
  const view=boardList({scope:{kind:'room',id:'b'},principal:{kind:'user'},rooms,bots,tasks:[source],verifyShare:()=>true})
  assert.equal(view.tasks.length,1)
  assert.deepEqual(view.tasks[0],{id:'a1',title:'Shared task',status:'working',shared:true})
})
