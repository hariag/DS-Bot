import assert from 'node:assert/strict'
import { test } from 'node:test'
import { goalNoteContext } from '../src/shared/goal-note.js'

test('status version and host times are checked conservatively with an explicit clock', () => {
  const base = { status: 'working', noteStatus: 'pending', statusVersion: 3, noteStatusVersion: 2, noteAt: 2_000, statusUpdatedAt: 1_000 }
  const classify = task => goalNoteContext(task, 3_000)
  assert.equal(classify(base).kind, 'conflict')
  assert.equal(classify({ ...base, noteAt: 1_000 }).kind, 'historical') // equal milliseconds are allowed
  assert.equal(classify({ ...base, noteAt: 500 }).kind, 'historical')
  assert.equal(classify({ ...base, noteStatus: 'working', noteStatusVersion: 3, noteAt: 500 }).kind, 'conflict')
  assert.equal(classify({ ...base, noteStatus: 'working', noteStatusVersion: 3, noteAt: 1_000 }).kind, 'current')
  assert.deepEqual(classify({ ...base, statusUpdatedAt: undefined }), { kind: 'historical', noteTimeKnown: true, statusTime: 'missing' })
  assert.deepEqual(classify({ ...base, statusUpdatedAt: 4_000 }), { kind: 'unknown', noteTimeKnown: true, statusTime: 'invalid' })
  assert.equal(classify({ ...base, noteAt: 4_000 }).kind, 'unknown')
  assert.equal(classify({ ...base, status: 'unexpected', noteStatus: 'unexpected' }).kind, 'unknown')
  assert.equal(classify({ ...base, statusVersion: 2, noteStatusVersion: 2 }).kind, 'unknown')
})
