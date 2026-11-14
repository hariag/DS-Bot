import { test } from 'node:test'
import assert from 'node:assert/strict'
import { install } from '../../src/host/user-redo-session.mjs'
import { userRedoIdentity } from '../../src/host/user-redo-journal.mjs'

test('reserved redo Sessions get identity without ordinary ownership and deny every tool', () => {
  const operationId = 'bb5b1723-7063-4e3e-b27e-12f44dd0033d', identity = userRedoIdentity(operationId)
  const row = { operationId, identity, original:{ botId:'b' }, scope:{ kind:'room', id:'r' } }
  const bot = { id:'b' }, room = { id:'r', members:['b'] }
  let guard
  const rt = { state:{ userRedos:{ [operationId]:row } }, botOf:id => id === 'b' ? bot : undefined,
    roomOf:id => id === 'r' ? room : undefined, ctx:{ tools:{ guard:fn => { guard = fn } } } }
  install(rt)
  assert.equal(rt.userRedoOwner(identity.sessionId), bot)
  assert.equal(rt.userRedoReserved(identity.sessionId), true)
  for (const name of ['bash', 'run_code', 'subagent', 'message_bot', 'write_file', 'read_file']) {
    assert.match(guard({ agent:{ id:identity.sessionId }, name }), /unavailable/)
  }
  assert.equal(guard({ agent:{ id:'ordinary-session' }, name:'bash' }), undefined)
  room.members = []
  assert.equal(rt.userRedoOwner(identity.sessionId), undefined)
  assert.match(guard({ agent:{ id:identity.sessionId }, name:'bash' }), /unavailable/)
  room.members = ['b']
  rt.state.userRedos.duplicate = { ...row }
  assert.equal(rt.userRedoOwner(identity.sessionId), undefined)
  assert.match(guard({ agent:{ id:identity.sessionId }, name:'bash' }), /unavailable/)
  // A stale or missing ownership table must not release an already-created
  // redo Session into the ordinary unrestricted tool policy.
  for (const lost of [undefined, null, [], {}]) {
    rt.state.userRedos = lost
    assert.equal(rt.userRedoOwner(identity.sessionId), undefined)
    assert.equal(rt.userRedoReserved(identity.sessionId), true)
    assert.match(guard({ agent:{ id:identity.sessionId }, name:'bash' }), /unavailable/)
    assert.match(guard({ agent:{ id:'ordinary-session', session:{ id:identity.sessionId } }, name:'bash' }), /unavailable/)
  }
  rt.state.userRedos = { wrongKey:row }
  assert.equal(rt.userRedoOwner(identity.sessionId), undefined)
  assert.match(guard({ agent:{ id:identity.sessionId }, name:'bash' }), /unavailable/)
})
