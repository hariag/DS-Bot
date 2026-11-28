import assert from 'node:assert/strict'
import test from 'node:test'
import { roomBusyForPatrol } from '../src/host/groups.js'

function fixture() {
  const agents = new Map()
  const room = { id: 'room', members: ['a', 'b'], sessions: { a: 'ga', b: 'gb' }, goal: { status: 'active' } }
  const rt = { ctx: { get: () => agents }, live: new Map(), roomInbox: new Map(), roomWaiters: new Map(), sessionOfRoom: () => 'relay',
    roomActive: () => false, roomLaterCount: () => 0, roomBatchPending: () => false,
    hasSubagents: () => false, waitsForApproval: () => false }
  return { rt, room, agents, busy: (...args) => roomBusyForPatrol(rt, room, ...args) }
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
  for (const [which, reason] of [['roomActive','round'], ['roomLaterCount','room-queue'], ['hasSubagents','subagent'], ['waitsForApproval','approval']]) {
    const { rt, busy } = fixture()
    const observed = []
    rt[which] = () => true
    assert.equal(busy(undefined, undefined, reason => observed.push(reason)), true, which)
    assert.deepEqual(observed, [reason], which)
  }
  const { rt, agents, busy } = fixture()
  const reasons = []
  const block = () => busy(undefined, undefined, reason => reasons.push(reason))
  rt.roomInbox.set('room', [{}]); assert.equal(block(), true); rt.roomInbox.clear()
  rt.roomWaiters.set('handoff', { roomId: 'room' }); assert.equal(block(), true); rt.roomWaiters.clear()
  for (const lane of ['nextStep', 'nextTurn']) {
    agents.set('ga', { inbox: { [lane]: [{ id: 'business' }] } }); assert.equal(block(), true)
  }
  assert.deepEqual(reasons, ['room-queue','waiter','session-queue','session-queue'])
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

test('only a verified deferred completion can stay queued without blocking the group patrol', () => {
  const { agents, busy, room, rt } = fixture()
  room.log = [{ seq:68290, kind:'done' }, { seq:68291, kind:'message' }]
  const source = {
    kind:'bot', form:'relay', role:'room', roomId:room.id, deferred:true, resultRef:'G68290',
    senderName:'You', exchangeId:'5dac0000-0000-4000-8000-000000000000', transferId:'b3ab0000-0000-4000-8000-000000000000',
  }
  const ready = { id:'receipt', source }
  const pending = [ready]
  agents.set('ga', { inbox:{ nextTurn:pending } })
  assert.equal(busy(), false)
  assert.deepEqual(pending, [ready])
  for (const extra of [
    { roomId:'another-room' }, { resultRef:'G68291' }, { resultRef:'G68289' }, { resultRef:'Gno' },
    { deferred:false }, { role:'request' }, { askedBy:'member' }, { batchKey:'batch' }, { resumedUpstream:true },
    { reviewId:'review' }, { reviewReceipt:true }, { workRef:'W1' }, { boardMention:true },
    { exchangeId:'unverified' }, { transferId:'unverified' },
  ]) {
    pending[0] = { ...ready, source:{ ...source, ...extra } }
    assert.equal(busy(), true, Object.keys(extra)[0])
  }
  pending[0] = ready
  room.log.splice(0, 1)
  rt.ledger = { record: (book, seq) => {
    assert.equal(book, 'group-room')
    return { seq, kind:'done' }
  } }
  assert.equal(busy(), false, 'the indexed ledger still proves a completion outside the hot window')
  rt.ledger.record = () => { throw Error('shard unavailable') }
  assert.equal(busy(), true)
  rt.ledger.record = (_book, seq) => ({ seq, kind:'done' })
  rt.live.set('ga', { turn:1 })
  assert.equal(busy(), true)
  rt.live.clear()
  rt.waitsForApproval = id => id === 'ga'
  assert.equal(busy(), true)
  rt.waitsForApproval = () => false
  agents.set('relay', { inbox:{ nextTurn:pending } })
  assert.equal(busy(), true, 'the group root inbox remains protected')
  assert.deepEqual(pending, [ready])
})
