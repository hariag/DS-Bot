import assert from 'node:assert/strict'
import { test } from 'node:test'
import { proposalPlacement } from '../src/client/learning-card-model.js'

const turns = new Map([
  [1, { turn: 1, end: { time: 100 }, status: 'closed' }],
  [2, { turn: 2, end: { time: 200 }, status: 'closed' }],
  [3, { turn: 3, status: 'open' }],
])

test('a proposal belongs to the latest closed turn ending before its timestamp', () => {
  assert.deepEqual(proposalPlacement({ at: 150 }, turns), { kind: 'turn', turn: 1 })
  assert.deepEqual(proposalPlacement({ at: 200 }, turns), { kind: 'turn', turn: 2 })
})

test('a proposal without an earlier closed turn falls back to the latest closed turn', () => {
  assert.deepEqual(proposalPlacement({ at: 50 }, turns), { kind: 'turn', turn: 2 })
})

test('a proposal uses the dock when there are no closed turns', () => {
  assert.deepEqual(proposalPlacement({ at: 150 }, new Map()), { kind: 'dock' })
  assert.deepEqual(proposalPlacement({ at: 150 }, new Map([[3, { turn: 3, status: 'open' }]])), { kind: 'dock' })
})
