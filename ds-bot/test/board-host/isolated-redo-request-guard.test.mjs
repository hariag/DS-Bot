import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createIsolatedRedoRequestGuard } from '../../src/host/isolated-redo-request-guard.mjs'

const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) } return value }

function fixture() {
  const session = { id:'redo' }, agents = new Map(), sessions = new Map(), lease = { value:1 }
  const agent = { id:'redo', session, guardedRequestBoundaryVersion:1, guardedSend() {} }
  agents.set('redo', agent); sessions.set('redo', session)
  const rt = { ctx:{ agents, sessions }, homeLockVersion:() => lease.value, requireHomeLock() {} }
  const expectedMessage = { id:'msg', role:'user', source:{ kind:'ds-bot-user-redo' }, content:[{ type:'text', text:'do this' }] }
  const target = { provider:'p', model:'m' }
  const make = (current = () => true) => createIsolatedRedoRequestGuard(rt, { agent, expectedMessage, target, isCurrent:current })
  const request = () => freeze({ sessionId:'redo', provider:'p', model:'m',
    messages:[structuredClone(expectedMessage)], toolHistory:{ tools:[], updates:[] } })
  return { session, agents, sessions, agent, lease, rt, expectedMessage, make, request }
}

test('accepts one exact model input once and refuses a second attempt', () => {
  const f = fixture(), guard = f.make(), request = f.request()
  assert.equal(guard(f.session, request, { turn:1, step:1 }), true)
  assert.equal(guard(f.session, request, { turn:1, step:1 }), false)
})

test('fails closed on extra input, tools, route changes, mutable requests and later steps', () => {
  const f = fixture(), base = f.request()
  for (const request of [
    { ...base, messages:Object.freeze([...base.messages, Object.freeze({ role:'user', content:[] })]) },
    { ...base, tools:[{ name:'bash' }] }, { ...base, model:'other' },
    { ...base, toolHistory:{ tools:[{ name:'write' }], updates:[] } },
    { ...base, messages:base.messages.map(x => x) },
  ]) assert.equal(f.make()(f.session, Object.freeze(request), { turn:1, step:1 }), false)
  assert.equal(f.make()(f.session, base, { turn:1, step:2 }), false)
})

test('rechecks session, authority and lease after the host callback', () => {
  for (const change of ['session', 'lease', 'authority']) {
    const f = fixture(); let calls = 0
    const guard = f.make(() => {
      if (++calls === 2) {
        if (change === 'session') f.sessions.set('redo', { id:'redo' })
        if (change === 'lease') f.lease.value++
        if (change === 'authority') return false
      }
      return true
    })
    assert.equal(guard(f.session, f.request(), { turn:1, step:1 }), false)
  }
})

test('rejects old agents and prevents a callback from consuming a second attempt', () => {
  const f = fixture(); f.agent.guardedRequestBoundaryVersion = undefined
  assert.throws(() => f.make(), /unavailable/)
  f.agent.guardedRequestBoundaryVersion = 1
  let guard, nested
  guard = f.make(() => { nested = guard(f.session, f.request(), { turn:1, step:1 }); return true })
  assert.equal(guard(f.session, f.request(), { turn:1, step:1 }), true)
  assert.equal(nested, false)
})
