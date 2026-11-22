import assert from 'node:assert/strict'
import test from 'node:test'
import { roomBusyForPatrol } from '../src/host/groups.js'

function fixture() {
  const agents = new Map()
  const room = { id: 'room', members: ['a', 'b'], sessions: { a: 'ga', b: 'gb' }, goal: { status: 'active' } }
  const rt = { ctx: { get: () => agents }, live: new Map(), roomInbox: new Map(), roomWaiters: new Map(), sessionOfRoom: () => 'relay',
    roomActive: () => false, roomLaterCount: () => 0, roomBatchPending: () => false,
    hasSubagents: () => false, waitsForApproval: () => false }
  return { rt, agents, busy: (...args) => roomBusyForPatrol(rt, room, ...args) }
}

test('a group with an active goal can be idle while its members work elsewhere', () => {
  const { rt, agents, busy } = fixture()
  rt.roomBatchPending = () => true
  rt.live.set('other-group-a', { turn: 1 }); agents.set('private-b', { status: 'running' })
  assert.equal(busy(), false)
  for (const id of ['relay', 'ga', 'gb']) {
    rt.live.set(id, { turn: 0 }); assert.equal(busy(), true); rt.live.delete(id)
    agents.set(id, { status: 'running' }); assert.equal(busy(), true); agents.delete(id)
  }
})

test('group round, pending handoff, child, approval and queued business each protect the group', () => {
  for (const which of ['roomActive', 'roomLaterCount', 'hasSubagents', 'waitsForApproval']) {
    const { rt, busy } = fixture(); rt[which] = () => true; assert.equal(busy(), true, which)
  }
  const { rt, agents, busy } = fixture(); rt.roomInbox.set('room', [{}]); assert.equal(busy(), true); rt.roomInbox.clear()
  rt.roomWaiters.set('handoff', { roomId: 'room' }); assert.equal(busy(), true); rt.roomWaiters.clear()
  for (const lane of ['nextStep', 'nextTurn']) {
    agents.set('ga', { inbox: { [lane]: [{ id: 'business' }] } }); assert.equal(busy(), true)
  }
})

test('ignoring a patrol’s own opening turn and message still sees other pending work', () => {
  const { rt, agents, busy } = fixture(); const queue = [{ id: 'patrol' }]
  rt.live.set('ga', { turn: 2 }); agents.set('ga', { status: 'running', inbox: { nextTurn: queue } })
  assert.equal(busy('patrol', 'ga'), false); assert.equal(busy('patrol'), true)
  queue.push({ id: 'human' }); assert.equal(busy('patrol', 'ga'), true); queue.pop()
  rt.waitsForApproval = id => id === 'ga'; assert.equal(busy('patrol', 'ga'), true)
})

test('passive native schedule changes in an idle group do not count as queued work', () => {
  const { agents, busy } = fixture()
  const change = {id:'notice', source:{kind:'schedule'}, content:[{type:'text',text:
    '[SCHEDULE CHANGE]\nThis notice is not a delivery of the task and needs no action.\nchange: updated\nschedule_id_json: "owned"'}]}
  const queued = [change]
  agents.set('relay', {inbox:{nextStep:queued}})
  assert.equal(busy(), false)
  queued.push({...change,source:{kind:'user'}})
  assert.equal(busy(), true)
})
