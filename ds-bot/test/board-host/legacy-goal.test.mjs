import { test } from 'node:test'
import assert from 'node:assert/strict'
import { legacyGoalCards } from '../../src/host/legacy-goal.js'

const goal = { id: 'goal1', status: 'active', current: 0, revision: 3, stages: [{ id: 's1', title: 'Repair', acceptance: 'Evidence required', tasks: [
  { id: 't1', botId: 'one', status: 'reported', task: 'Review' },
  { id: 't2', botId: 'two', status: 'done', task: 'Verify' },
] }] }
const rooms = { first: { members: ['one', 'two'], goal }, private: { members: ['two'], goal: { ...goal, id: 'goal2' } } }
const bots = { one: {}, two: {} }, user = { kind: 'user' }

test('legacy group items remain read-only snapshots and do not claim verified completion', () => {
  const cards = legacyGoalCards({ scope: { kind: 'room', id: 'first' }, principal: user, rooms, bots })
  assert.equal(cards.length, 2); assert.equal(cards[0].status, 'reported'); assert.equal(cards[1].status, 'legacy-unverified')
  assert.equal(cards[0].legacy.taskId, 't1'); assert.equal(cards[0].legacy.goalId, 'goal1')
})

test('personal Bot board only projects its own current-stage legacy work', () => {
  const cards = legacyGoalCards({ scope: { kind: 'personal', id: 'one' }, principal: user, rooms, bots })
  assert.equal(cards.length, 1); assert.equal(cards[0].owner, 'one'); assert.equal(cards[0].originRoomId, 'first')
})

test('a Bot cannot read a legacy group it is not a member of', () => {
  const cards = legacyGoalCards({ scope: { kind: 'room', id: 'private' }, principal: { kind: 'bot', id: 'one' }, rooms, bots })
  assert.deepEqual(cards, [])
})

test('a Bot cannot inspect another Bot personal board even if they share a group', () => {
  const cards = legacyGoalCards({ scope: { kind: 'personal', id: 'one' }, principal: { kind: 'bot', id: 'two' }, rooms, bots })
  assert.deepEqual(cards, [])
})

test('goal changes cannot silently reuse a different aggregate reference', () => {
  const before = legacyGoalCards({ scope: { kind: 'room', id: 'first' }, principal: user, rooms, bots })[0]
  const afterGoal = structuredClone(goal); afterGoal.stages[0].tasks[0].task = 'Different work'
  const after = legacyGoalCards({ scope: { kind: 'room', id: 'first' }, principal: user, rooms: { first: { members: ['one'], goal: afterGoal } }, bots })[0]
  assert.notEqual(after.id, before.id)
})
