import { test } from 'node:test'
import assert from 'node:assert/strict'
import { groupQueueView, earlierPrivateQueueView } from '../src/host/channel.js'

test('group queue follows each member session and excludes private inboxes', () => {
  const rooms = { r: { id: 'r', name: 'Team', sessions: { a: 'ga', b: 'gb' }, segments: { a: [{ sessionId: 'old' }] } }, s: { id: 's', name: 'Design', sessions: { a: 'sa' } } }
  const bots = { b: { name: 'Writer' } }
  const row = (id, text, source = {}) => ({ id, source: { kind: 'bot', ...source }, content: [{ type: 'text', text }] })
  const queues = { ga: { nextStep: [], nextTurn: [row('1', 'decision', { askedBy: 'b' })] }, gb: { nextStep: [row('2', 'work')], nextTurn: [] }, sa: { nextStep: [], nextTurn: [row('3', 'x'.repeat(1100))] } }
  const ledger = { ga: [], old: [{ exchangeId: 'unconfirmed' }] }
  const view = () => groupQueueView(rooms, bots, id => queues[id] && { inbox: queues[id] }, id => ledger[id] ?? [])
  assert.deepEqual(view().a.map(item => item.id), ['1', 'unavailable:old', '3'])
  assert.equal(view().a[0].senderName, 'Writer')
  assert.equal(view().a[1].unavailable, true)
  assert.equal(view().a[2].text.length, 401)
  assert.deepEqual(view().b.map(item => item.id), ['2'])
  queues.ga.nextTurn.shift()
  assert.deepEqual(view().a.map(item => item.id), ['unavailable:old', '3'])
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
