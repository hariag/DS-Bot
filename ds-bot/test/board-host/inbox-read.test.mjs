import assert from 'node:assert/strict'
import test from 'node:test'
import { readSessionInbox } from '../../src/host/inbox-read.mjs'

const id = 'archived-part'
const item = { id:'message', source:{ kind:'bot' } }
const snapshot = (nextStep = [], nextTurn = []) => ({ asOfSeq:4, values:{ inbox:{ 'next-step':nextStep, 'next-turn':nextTurn } } })

test('warm inbox reads retain both queues without activating or removing messages', async () => {
  const nextStep = [item], nextTurn = [item]
  const ctx = { agents:{ get:key => key === id ? { id, inbox:{ nextStep, nextTurn } } : undefined } }
  const result = await readSessionInbox(ctx, id)
  assert.deepEqual(result, { status:'ready', nextStep:[item], nextTurn:[item] })
  result.nextStep.length = 0
  assert.deepEqual(nextStep, [item])
  assert.deepEqual(nextTurn, [item])
})

test('inspect a loaded or cold Session using only the inbox projection', async () => {
  const session = { id }
  let loaded = false, stats = 0, inspections = 0
  const ctx = {
    sessions:{ get:() => loaded ? session : undefined },
    sessionPersistence:{ stat:async key => { stats++; return { header:{ id:key }, formatStatus:'current' } } },
    sessionQuery:{ inspectSession:async (key, read, signal) => {
      assert.equal(key, id)
      assert.equal(signal.aborted, false)
      inspections++
      return read(session)
    } },
    sessionProjections:{ snapshot:(source, keys) => {
      assert.equal(source, session)
      assert.deepEqual(keys, ['inbox'])
      return snapshot([], [item])
    } },
  }
  assert.deepEqual(await readSessionInbox(ctx, id), { status:'ready', nextStep:[], nextTurn:[item] })
  loaded = true
  assert.deepEqual(await readSessionInbox(ctx, id), { status:'ready', nextStep:[], nextTurn:[item] })
  assert.equal(stats, 1)
  assert.equal(inspections, 1)
})

test('an exact older-host baseline establishes empty; absent, migration and partial views stay distinct', async () => {
  const values = [
    [{ kind:'sequenced', ...snapshot(), asOfSeq:-1 }, { status:'ready', nextStep:[], nextTurn:[] }],
    [null, { status:'missing' }],
    [{ kind:'migration-required', ...snapshot() }, { status:'migration' }],
    [undefined, { status:'unavailable' }],
    [{ kind:'cached', ...snapshot() }, { status:'unavailable' }],
    [{ kind:'sequenced', ...snapshot(), asOfSeq:undefined }, { status:'unavailable' }],
    [{ kind:'sequenced', asOfSeq:4, values:{ inbox:{ 'next-turn':[] } } }, { status:'unavailable' }],
  ]
  for (const [value, expected] of values) {
    const ctx = { sessionController:{ projections:async ({ sessionId }, signal) => {
      assert.equal(sessionId, id)
      assert.equal(signal.aborted, false)
      return value
    } } }
    assert.deepEqual(await readSessionInbox(ctx, id), expected)
  }
  assert.deepEqual(await readSessionInbox({}, id), { status:'unavailable' })
})

test('cold metadata and exact identity are checked before exposing a queue', async () => {
  for (const [stored, status] of [
    [undefined, 'missing'],
    [{ header:{ id }, formatStatus:'migration-required' }, 'migration'],
    [{ header:{ id:'another-scope' } }, 'unavailable'],
  ]) {
    let inspected = false
    const ctx = { sessionPersistence:{ stat:async () => stored },
      sessionProjections:{ snapshot:() => snapshot([item]) }, sessionQuery:{ inspectSession:() => { inspected = true } } }
    assert.deepEqual(await readSessionInbox(ctx, id), { status })
    assert.equal(inspected, false)
  }
  const other = { id:'another-scope', inbox:{ nextStep:[item], nextTurn:[] } }
  assert.deepEqual(await readSessionInbox({ agents:{ get:() => other } }, id), { status:'unavailable' })
  assert.deepEqual(await readSessionInbox({ sessions:{ get:() => other }, sessionProjections:{ snapshot:() => snapshot([item]) } }, id),
    { status:'unavailable' })
})

test('a Session attached during stat takes precedence and a cancelled read never reports an empty queue', async () => {
  let attached
  const ctx = { sessions:{ get:() => attached },
    sessionPersistence:{ stat:async () => { attached = { id }; return undefined } },
    sessionProjections:{ snapshot:() => snapshot([item]) },
    sessionQuery:{ inspectSession:assert.fail } }
  assert.deepEqual(await readSessionInbox(ctx, id), { status:'ready', nextStep:[item], nextTurn:[] })
  const cancel = new AbortController()
  const old = { sessionController:{ projections:async (_request, signal) => {
    cancel.abort()
    assert.equal(signal.aborted, true)
    return { kind:'sequenced', ...snapshot() }
  } } }
  assert.deepEqual(await readSessionInbox(old, id, cancel.signal), { status:'unavailable' })
  assert.deepEqual(await readSessionInbox(ctx, id, cancel.signal), { status:'unavailable' })
})
