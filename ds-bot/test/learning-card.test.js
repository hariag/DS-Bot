import assert from 'node:assert/strict'
import { test } from 'node:test'
import { proposalTurn } from '../src/client/learning-card-model.js'

const turns = new Map([
  [1, { turn: 1, end: { time: 100 }, status: 'closed' }],
  [2, { turn: 2, end: { time: 200 }, status: 'closed' }],
  [3, { turn: 3, status: 'open' }],
])

test('a proposal belongs to the latest closed turn ending before its timestamp', () => {
  assert.equal(proposalTurn({ at: 150 }, turns), 1)
  assert.equal(proposalTurn({ at: 200 }, turns), 2)
})

test('a proposal without an earlier closed turn falls back to the latest closed turn', () => {
  assert.equal(proposalTurn({ at: 50 }, turns), 2)
})
