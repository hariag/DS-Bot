import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { userRedoIdentity } from '../../src/host/user-redo-journal.mjs'
import { createIsolatedRedoCoordinator } from '../../src/host/isolated-redo-coordinator.mjs'

const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) } return value }
function fixture() {
  const identity = userRedoIdentity('bb5b1723-7063-4e3e-b27e-12f44dd0033d'), actor = { kind:'user', id:'user' }
  const original = { id:'original', role:'user', source:{ kind:'bot' }, content:[{ type:'text', text:'original task' }] }
  const message = { id:identity.messageId, role:'user', source:{ kind:'ds-bot-user-redo' }, content:structuredClone(original.content) }
  const row = { operationId:identity.operationId, identity, principal:actor, state:'dispatching',
    original:{ botId:'bot', messageHash:createHash('sha256').update(JSON.stringify(original)).digest('hex') }, target:{ provider:'p', model:'m' } }
  const session = { id:identity.sessionId, eventAt:seq => seq === 7 ? { type:'turn/start', data:{ turn:2 } } : undefined }
  const agent = { id:identity.sessionId, session, guardedRequestBoundaryVersion:1, guardedSend() {} }
  const bot = { id:'bot' }, transient = new Map([[row.operationId, structuredClone(row)]])
  const rt = { ctx:{ agents:new Map([[agent.id, agent]]), sessions:new Map([[session.id, session]]) }, userRedoTransient:transient,
    userRedoOwner:() => bot, userRedoBinding:() => transient.get(row.operationId), requireHomeLock() {}, homeLockVersion:() => 1 }
  let durable = structuredClone(row), valid = true
  const journal = { markClaimingSync(binding, turn, principal) {
    if (!valid || JSON.stringify(binding) !== JSON.stringify(durable) || JSON.stringify(principal) !== JSON.stringify(actor)) throw Error('unavailable')
    durable = { ...durable, state:'claiming', turn:structuredClone(turn) }; return structuredClone(durable)
  }, inspectClaimingSync(binding, principal) {
    if (!valid || JSON.stringify(binding) !== JSON.stringify(durable) || JSON.stringify(principal) !== JSON.stringify(actor)) throw Error('unavailable')
    return structuredClone(durable)
  } }
  const coordinator = createIsolatedRedoCoordinator(rt, { agent, journal, binding:row, principal:actor, originalMessage:original, message })
  const inputs = [{ message, admissionId:identity.admissionId, target:'next-turn' }], turn = { turn:2, turnStartSeq:7 }
  const request = () => freeze({ sessionId:session.id, provider:'p', model:'m', messages:[structuredClone(message)], toolHistory:{ tools:[], updates:[] } })
  return { rt, agent, session, row, actor, original, message, identity, inputs, turn, journal, coordinator, request, revoke:() => { valid = false } }
}

test('durable claim precedes a single exact model request', () => {
  const f = fixture(); let claims = 0
  assert.equal(f.coordinator(f.session.id, f.inputs, () => { claims++ }, f.turn), 'committed')
  assert.equal(claims, 1)
  assert.equal(f.coordinator.beforeModelRequest(f.session, f.request(), { turn:2, step:1 }), true)
  assert.equal(f.coordinator.beforeModelRequest(f.session, f.request(), { turn:2, step:1 }), false)
  assert.throws(() => f.coordinator(f.session.id, f.inputs, () => {}, f.turn), /unavailable/)
})

test('refuses unconfirmed content, mixed input and revoked claim', () => {
  const f = fixture()
  assert.throws(() => createIsolatedRedoCoordinator(f.rt, { agent:f.agent, journal:f.journal, binding:f.row,
    principal:f.actor, originalMessage:f.original, message:{ ...f.message, content:[{ type:'text', text:'changed' }] } }), /unavailable/)
  assert.throws(() => f.coordinator(f.session.id, [...f.inputs, f.inputs[0]], () => {}, f.turn), /unavailable/)
  f.revoke()
  assert.throws(() => f.coordinator(f.session.id, f.inputs, () => {}, f.turn), /unavailable/)
})

test('rechecks durable authority and the current Session before a model call', () => {
  for (const changed of ['session', 'authority']) {
    const f = fixture(); f.coordinator(f.session.id, f.inputs, () => {}, f.turn)
    if (changed === 'session') f.rt.ctx.sessions.set(f.session.id, { id:f.session.id })
    else f.revoke()
    assert.equal(f.coordinator.beforeModelRequest(f.session, f.request(), { turn:2, step:1 }), false)
  }
})
