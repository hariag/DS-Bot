import { test } from 'node:test'
import assert from 'node:assert/strict'
import { groupQueueView, earlierPrivateQueueView, roomPostQueueView } from '../src/host/channel.js'

test('group queue follows each member session and excludes private inboxes', () => {
  const rooms = { r: { id: 'r', name: 'Team', sessions: { a: 'ga', b: 'gb' }, segments: { a: [{ sessionId: 'old' }] } }, s: { id: 's', name: 'Design', sessions: { a: 'sa' } } }
  const bots = { b: { name: 'Writer' } }
  const row = (id, text, source = {}) => ({ id, source: { kind: 'bot', ...source }, content: [{ type: 'text', text }] })
  const queues = { ga: { nextStep: [], nextTurn: [row('1', 'decision', { askedBy: 'b' })] }, gb: { nextStep: [row('2', 'work')], nextTurn: [] }, sa: { nextStep: [], nextTurn: [row('3', 'x'.repeat(1100))] } }
  const ledger = { ga: [], old: [{ exchangeId: 'unconfirmed' }] }
  const view = () => groupQueueView(rooms, bots, id => queues[id] && { inbox: queues[id] }, id => ledger[id] ?? [])
  assert.deepEqual(view().a.map(item => item.id), ['1', 'unavailable', '3'])
  assert.equal(view().a[0].senderName, 'Writer')
  assert.equal(view().a[1].unavailable, true)
  assert.equal(view().a[2].text.length, 401)
  assert.deepEqual(view().b.map(item => item.id), ['2'])
  queues.ga.nextTurn.shift()
  assert.deepEqual(view().a.map(item => item.id), ['unavailable', '3'])
  delete queues.sa
  assert.equal(view().a.at(-1).unavailable, true)
  queues.old = { nextStep: [row('old-1', 'earlier')], nextTurn: [{ id: 'user', source: { kind: 'user' }, content: [] }] }
  ledger.old = []
  assert.equal(view().a[0].id, 'old-1')
  assert.equal(view().a[0].previous, true)
  assert.equal(view().a.filter(item => !item.unavailable).length, 1)
  queues.ga.nextTurn.push(row('current', 'forwarded', { exchangeId: 'same' }))
  queues.old.nextStep.push(row('older', 'forwarded', { exchangeId: 'same' }))
  assert.equal(view().a.filter(item => item.text === 'forwarded').length, 1)
})

test('earlier private mail uses inboxes, and marks an inaccessible noted session unknown', () => {
  const bots = { a: { id: 'a', sessionId: 'current', segments: [{ sessionId: 'old' }, { sessionId: 'old2' }, { sessionId: 'unknown' }] } }
  const agent = { inbox: { nextStep: [], nextTurn: [{ id: 'm', source: { kind: 'bot', senderName: 'Writer', exchangeId: 'e' }, content: [{ type: 'text', text: 'old message' }] }] } }
  const view = earlierPrivateQueueView(bots, id => ['old', 'old2'].includes(id) ? agent : undefined, id => id === 'unknown' ? [{}] : [])
  assert.equal(view.a[0].id, 'm')
  assert.equal(view.a[0].senderName, 'Writer')
  assert.equal(view.a[1].unavailable, true)
})

test('unloaded historical inboxes without delivery notes remain unknown', () => {
  const rooms = { r: { id: 'r', name: 'Team', sessions: { a: 'current' }, segments: { a: [{ sessionId: 'old' }] } } }
  const bots = { a: { id: 'a', segments: [{ sessionId: 'old-private' }] } }
  const getAgent = id => id === 'current' ? { inbox: { nextStep: [], nextTurn: [] } } : undefined
  assert.equal(groupQueueView(rooms, bots, getAgent, () => []).a[0].id, 'unavailable')
  assert.equal(earlierPrivateQueueView(bots, getAgent, () => []).a[0].id, 'unavailable')
})

test('recovery notes add evidence without treating a missing note as an empty inbox', () => {
  const rooms = { r: { id: 'r', name: 'Team', sessions: { a: 'current' }, segments: { a: [{ sessionId: 'old1' }, { sessionId: 'old2' }] } } }
  const bots = { a: { id: 'a', segments: [{ sessionId: 'old1' }, { sessionId: 'old2' }] } }
  const getAgent = id => id === 'current' ? { inbox: { nextStep: [], nextTurn: [] } } : undefined
  const unread = id => id === 'old2' ? [{ exchangeId: 'noted' }] : []
  const group = groupQueueView(rooms, bots, getAgent, unread).a
  const personal = earlierPrivateQueueView(bots, getAgent, unread).a
  assert.equal(group.length, 1)
  assert.equal(group[0].unavailable, true)
  assert.equal(group[0].noted, true)
  assert.equal(personal.length, 1)
  assert.equal(personal[0].noted, true)
  assert.equal(group.filter(item => !item.unavailable).length, 0)
  assert.equal(personal.filter(item => !item.unavailable).length, 0)
  assert.equal(groupQueueView(rooms, bots, getAgent, () => []).a[0].noted, undefined)
  assert.equal(earlierPrivateQueueView(bots, getAgent, () => { throw new Error('unread unavailable') }).a[0].unavailable, true)
})

test('a loaded inbox is read directly even when an old recovery note exists', () => {
  const rooms = { r: { id: 'r', name: 'Team', sessions: { a: 'current' }, segments: { a: [{ sessionId: 'old' }] } } }
  const bots = { a: { id: 'a', segments: [{ sessionId: 'old' }] } }
  const getAgent = () => ({ inbox: { nextStep: [], nextTurn: [] } })
  assert.deepEqual(groupQueueView(rooms, bots, getAgent, () => [{ exchangeId: 'stale' }]), {})
  assert.deepEqual(earlierPrivateQueueView(bots, getAgent, () => [{ exchangeId: 'stale' }]), {})
})


test('room own inbox includes historical posts and bounds unknowns', () => {
  const rooms = { r: { id: 'r', parts: [{ sessionId: 'old' }, { sessionId: 'missing' }, { sessionId: 'missing2' }] }, s: { id: 's', parts: [] } }
  const post = (id, exchangeId, text) => ({ id, source: { kind: 'bot', role: 'post', exchangeId }, content: [{ type: 'text', text }] })
  const queues = { current: { nextStep: [], nextTurn: [post('new', 'same', 'latest')] }, old: { nextStep: [post('dup', 'same', 'duplicate'), post('old', 'other', 'old')], nextTurn: [] }, other: { nextStep: [], nextTurn: [post('s', 'same', 'other room')] } }
  const result = roomPostQueueView(rooms, room => room.id === 'r' ? 'current' : 'other', id => queues[id] && { inbox: queues[id] })
  assert.deepEqual(result.r.rows.map(row => row.id), ['new', 'dup', 'old'])
  assert.equal(result.r.rows[0].messageId, 'new')
  assert.equal(result.r.unavailable, true)
  assert.equal(result.s.rows.length, 1)
  assert.equal(result.s.unavailable, false)
})

test('unknown bot inboxes are bounded per bot and group', () => {
  const rooms = { r: { id: 'r', name: 'Team', sessions: { a: 'now' }, segments: { a: [{ sessionId: 'old1' }, { sessionId: 'old2' }] } } }
  const bots = { a: { id: 'a', segments: [{ sessionId: 'one' }, { sessionId: 'two' }] } }
  assert.equal(groupQueueView(rooms, bots, () => undefined).a.length, 1)
  assert.equal(earlierPrivateQueueView(bots, () => undefined).a.length, 1)
})
