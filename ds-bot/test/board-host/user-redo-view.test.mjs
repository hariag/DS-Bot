import { test } from 'node:test'
import assert from 'node:assert/strict'
import { userRedoIdentity } from '../../src/host/user-redo-journal.mjs'
import { userRedoView } from '../../src/host/user-redo-view.mjs'

const operationId = '9d5b1723-7063-4e3e-b27e-12f44dd0033d'
const recoveryId = 'a'.repeat(64)
const scope = { kind:'room', id:'g1' }
const principal = { kind:'user', id:'user' }
const record = () => ({ operationId, recoveryId, identity:userRedoIdentity(operationId), scope, acknowledged:true,
  original:{ botId:'bot', sessionId:'source', turn:4, messageSeq:9, messageId:'m1', messageHash:'b'.repeat(64) },
  state:'completed', result:'SECRET-UNVERIFIED', source:'SECRET-ORIGINAL' })
const held = () => ({ available:true, incomplete:false, items:[{ recoveryId, botId:'bot', roomId:'g1', sessionId:'source' }] })
const state = () => ({ rooms:{ g1:{ members:['bot'] }, g2:{ members:['bot'] } }, bots:{ bot:{ name:'Bot' } }, userRedos:{ [operationId]:record() } })
const project = (overrides = {}) => userRedoView({ principal, scope, state:state(), recovery:held(), ...overrides })

test('only exposes an unresolved new attempt, never unverified result or original text', () => {
  const view = project()
  assert.deepEqual(view.items[0].redo, { operationId, status:'unknown' })
  assert.doesNotMatch(JSON.stringify(view), /SECRET|completed/)
})

test('a redo value injected into the held projection is not accepted as result evidence', () => {
  const recovery = held(); recovery.items[0].redo = { status:'completed', result:'SECRET-UNVERIFIED' }
  const snapshot = state(); delete snapshot.userRedos
  const view = project({ state:snapshot, recovery })
  assert.equal(view.items[0].redo, undefined)
  assert.doesNotMatch(JSON.stringify(view), /SECRET|completed/)
})

test('requires an authenticated owner and the exact original scope', () => {
  assert.deepEqual(project({ principal:{ kind:'bot', id:'bot' } }), { available:false, incomplete:true, items:[] })
  assert.deepEqual(project({ principal:{ kind:'user', id:'other' } }), { available:false, incomplete:true, items:[] })
  assert.equal(project({ scope:{ kind:'room', id:'g2' } }).items[0].redo, undefined)
  assert.equal(project({ scope:{ kind:'personal', id:'user' } }).items[0].redo, undefined)
})

test('requires the original Bot, Session, current group membership and a coherent stable identity', () => {
  for (const alter of [
    s => { s.rooms.g1.members = [] },
    s => { s.userRedos[operationId].original.botId = 'other' },
    s => { s.userRedos[operationId].original.sessionId = 'other' },
    s => { s.userRedos[operationId].identity.messageId = 'forged' },
    s => { s.userRedos[operationId].original.messageHash = 'bad' },
  ]) {
    const snapshot = state(); alter(snapshot)
    const view = project({ state:snapshot })
    assert.equal(view.items[0].redo, undefined)
    assert.equal(view.incomplete, true)
  }
})

test('two operations for the same held item stay unknown instead of picking a winner', () => {
  const snapshot = state(), secondId = 'c2a7ed5e-3b37-4a48-bb72-3d82f9d8c454'
  snapshot.userRedos[secondId] = { ...record(), operationId:secondId, identity:userRedoIdentity(secondId) }
  const view = project({ state:snapshot })
  assert.equal(view.items[0].redo, undefined)
  assert.equal(view.incomplete, true)
})

test('a group-origin record cannot be relabeled as a personal record', () => {
  const snapshot = state()
  snapshot.userRedos[operationId].scope = { kind:'personal', id:'user' }
  assert.equal(project({ state:snapshot, scope:{ kind:'personal', id:'user' } }).items[0].redo, undefined)
})
