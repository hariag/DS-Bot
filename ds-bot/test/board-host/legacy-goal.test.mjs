import { test } from 'node:test'
import assert from 'node:assert/strict'
import { legacyGoalCards } from '../../src/host/legacy-goal.js'
import { archiveGoal, reviseGoal } from '../../src/host/goals.js'

const goal = { id: 'goal1', status: 'active', current: 0, revision: 3, stages: [{ id: 's1', title: 'Repair', acceptance: 'Evidence required', tasks: [
  { id: 't1', botId: 'one', status: 'reported', task: 'Review' },
  { id: 't2', botId: 'two', status: 'done', task: 'Verify' },
] }] }
const rooms = { first: { members: ['one', 'two'], goal }, private: { members: ['two'], goal: { ...goal, id: 'goal2' } } }
const bots = { one: {}, two: {} }, user = { kind: 'user' }

test('group goal task cards distinguish reported and goal-marked completion', () => {
  const cards = legacyGoalCards({ scope: { kind: 'room', id: 'first' }, principal: user, rooms, bots })
  assert.equal(cards.length, 2); assert.equal(cards[0].status, 'reported'); assert.equal(cards[1].status, 'legacy-done')
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

test('the original task ID survives text edits but changes with goal, stage or task identity', () => {
  const before = legacyGoalCards({ scope: { kind: 'room', id: 'first' }, principal: user, rooms, bots })[0]
  const afterGoal = structuredClone(goal); afterGoal.stages[0].tasks[0].task = 'Different work'
  const after = legacyGoalCards({ scope: { kind: 'room', id: 'first' }, principal: user, rooms: { first: { members: ['one'], goal: afterGoal } }, bots })[0]
  assert.equal(after.id, before.id)
  for(const mutate of [g=>{g.id='other'},g=>{g.stages[0].id='other'},g=>{g.stages[0].tasks[0].id='other'}]) {
    const copy=structuredClone(goal);mutate(copy)
    const changed=legacyGoalCards({scope:{kind:'room',id:'first'},principal:user,rooms:{first:{members:['one'],goal:copy}},bots})[0]
    assert.notEqual(changed.id,before.id)
  }
})

test('stage rebuild cannot silently discard card details or comments', () => {
  for(const boardData of [{boardDetails:{description:'Retain context'}},{boardComments:[{id:'c1',text:'Retain comment'}]}]) {
    const prior=structuredClone(goal)
    prior.status='active'; Object.assign(prior.stages[0].tasks[0],boardData)
    const room={name:'Group',members:['one'],goal:prior}, before=structuredClone(prior)
    const result=reviseGoal(room,{reason:'Change scope',stages:[]},'user',()=>undefined,[])
    assert.match(result.error,/board details or comments/)
    assert.deepEqual(room.goal,before)
  }
})

test('goal history retains comments beyond the ordinary five-goal window', () => {
  const old=structuredClone(goal)
  old.id='retained';old.stages[0].tasks[0].boardComments=[{id:'c1',text:'Keep'}]
  const room={pastGoals:[old,...Array.from({length:4},(_,i)=>({id:`earlier-${i}`,stages:[]}))],goal:{id:'last',stages:[]}}
  archiveGoal(room)
  assert.equal(room.pastGoals.length,6)
  assert.equal(room.pastGoals[0].stages[0].tasks[0].boardComments[0].text,'Keep')
})
