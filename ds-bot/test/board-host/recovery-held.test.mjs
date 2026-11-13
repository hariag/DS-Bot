import test from 'node:test'
import assert from 'node:assert/strict'
import { heldTurnsView } from '../../src/host/recovery-held.js'
import { boundedRecoveryView } from '../../src/host/resume.js'

const key = n => String(n).padStart(64, '0')
const held = {
  [key(1)]: { sessionId:'session-private', reason:'SECRET REASON', record:{ botId:'one', since:1700000000000,
    trigger:{ exchangeId:'exchange-1', role:'request', text:'SECRET MESSAGE' }, note:'SECRET NOTE' } },
  [key(2)]: { sessionId:'session-room', record:{ botId:'one', roomId:'group', turn:7, trigger:{ exchangeId:'exchange-2' } } },
  [key(3)]: { sessionId:'session-other', record:{ botId:'two', roomId:'other' } },
}
const bots = { one:{ name:'One' }, two:{ name:'Two' } }

test('a stalled recovery read times out without falsely reporting success', async () => {
  const waiting = new Promise(() => {})
  assert.deepEqual(await boundedRecoveryView(waiting, 20), { available:false, incomplete:true, items:[] })
  assert.deepEqual(await boundedRecoveryView(Promise.reject(new Error('read failed')), 20), { available:false, incomplete:true, items:[] })
  assert.deepEqual(await boundedRecoveryView(Promise.resolve({ available:true, items:[] }), 20), { available:true, items:[] })
})

test('project only bounded metadata, preserving unknown turn without exposing a message', () => {
  const view = heldTurnsView(held, { kind:'personal', id:'one' }, bots)
  assert.equal(view.available, true)
  assert.equal(view.incomplete, false)
  assert.equal(view.items.length, 2)
  assert.equal(view.items.find(item => item.sessionId === 'session-private').turn, undefined)
  assert.equal(view.items.find(item => item.sessionId === 'session-room').turn, 7)
  assert.equal(view.items[0].status, 'uncertain')
  assert.equal(view.items[0].evidence, 'inflight.json')
  assert.doesNotMatch(JSON.stringify(view), /SECRET|senderSessionId|args|trigger|reason/)
  assert.deepEqual(heldTurnsView(held, { kind:'room', id:'group' }, bots).items.map(item => item.sessionId), ['session-room'])
  assert.equal(heldTurnsView(held, { kind:'personal', id:'user' }, bots).items.length, 3)
  assert.equal(heldTurnsView(held, { kind:'personal', id:'two' }, bots).items.length, 1)
})

test('invalid or excessive records are signalled as incomplete without leaking data', () => {
  assert.deepEqual(heldTurnsView(null, { kind:'personal', id:'user' }), { available:false, incomplete:true, items:[] })
  assert.deepEqual(heldTurnsView(held, { kind:'other', id:'user' }), { available:false, incomplete:true, items:[] })
  const malformed = { ...held, 'not-a-valid-key': { sessionId:'secret', record:{ botId:'one' } },
    [key(4)]:{ sessionId:'<private>', record:{ botId:'one' } } }
  const result = heldTurnsView(malformed, { kind:'personal', id:'one' }, bots)
  assert.equal(result.incomplete, true)
  assert.equal(result.items.length, 2)
  assert.doesNotMatch(JSON.stringify(result), /<private>|not-a-valid-key/)
  const many = Object.fromEntries(Array.from({ length:501 }, (_, i) => [key(i), { sessionId:`session-${i}`, record:{botId:'one'} }]))
  const limited = heldTurnsView(many, { kind:'personal', id:'one' }, bots)
  assert.equal(limited.items.length, 500)
  assert.equal(limited.incomplete, true)
  const unrelated = Object.fromEntries(Array.from({ length:20_001 }, (_, i) => [key(i), { sessionId:`session-${i}`, record:{botId:'one', roomId:'other'} }]))
  const bounded = heldTurnsView(unrelated, { kind:'room', id:'group' }, bots)
  assert.equal(bounded.items.length, 0)
  assert.equal(bounded.incomplete, true, 'large unrelated sets must not look completely scanned')
})
