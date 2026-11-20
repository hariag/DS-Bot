import { test } from 'node:test'
import assert from 'node:assert/strict'
import { archiveGoal, reviseGoal } from '../../src/host/goals.js'

const goal={id:'goal1',status:'active',current:0,revision:3,stages:[{id:'s1',title:'Repair',tasks:[{id:'t1',botId:'one',status:'reported',task:'Review'}]}]}

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

test('goal history retains a user inspection decision beyond the ordinary window', () => {
  const old=structuredClone(goal)
  old.id='retained-decision';old.reviewResolutions=[{id:'attempt',decision:'allow-future',by:'user',at:1,attempt:{id:'attempt',state:'uncertain'}}]
  const room={pastGoals:[old,...Array.from({length:4},(_,i)=>({id:`earlier-${i}`,stages:[]}))],goal:{id:'last',stages:[]}}
  archiveGoal(room)
  assert.equal(room.pastGoals[0].id,'retained-decision')
  assert.equal(room.pastGoals[0].reviewResolutions[0].attempt.state,'uncertain')
})
