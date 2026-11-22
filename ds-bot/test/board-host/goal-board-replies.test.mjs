import test from 'node:test'
import assert from 'node:assert/strict'
import { startGoal, taskGoal, reviseGoal, archiveGoal } from '../../src/host/goals.js'
import { legacyGoalCards, linkGoalCards } from '../../src/host/legacy-goal.js'

const names = ['Writer','Reviewer']
const member = name => names.includes(name) ? {id:name} : undefined
const stage = (tasks, acceptance='Proof') => ({title:'Implement', acceptance, tasks})
const write = task => ({bot:'Writer',task})
const review = task => ({bot:'Reviewer',task})
const view = room => legacyGoalCards({scope:{kind:'room',id:'r'},principal:{kind:'user'},rooms:{r:room},bots:{Writer:{},Reviewer:{}}})
const begin = () => {
  const room={id:'r',name:'Group',members:names}
  assert.ok(startGoal(room,{objective:'Deliver',acceptance:'Reviewed',stages:[stage([write('A'),review('B')])]},'Writer',member,names,100).goal)
  return room
}
const update = (room, input, now) => taskGoal(room,{bot:'Writer',...input},'Writer',member,names,now)
const revise = (room, tasks, acceptance='Proof') => reviseGoal(room,{reason:'Plan revision',stages:[stage(tasks,acceptance)]},'Writer',member,names,500)

test('goal notes remain attributable, ordered and idempotent when shown on the original card', () => {
  const room=begin(), [original]=view(room)
  update(room,{status:'working',note:'Started'},200)
  const revision=room.goal.revision
  assert.equal(update(room,{status:'working',note:'Started'},200).unchanged,true)
  assert.equal(room.goal.revision,revision)
  update(room,{status:'reported',note:'Evidence ready'},300)
  const card=view(room).find(card=>card.id===original.id)
  assert.deepEqual(card.comments.map(({author,at,text})=>({author,at,text})),[
    {author:'Writer',at:200,text:'[group_goal working] Started'},
    {author:'Writer',at:300,text:'[group_goal reported] Evidence ready'},
  ])
  assert.ok(card.comments.every(comment=>comment.workflowAction==='goal-update'))
})

test('revising retains unchanged task identities and archives changed tasks at their original IDs', () => {
  const room=begin(), before=view(room), first=before.find(c=>c.owner==='Writer'), second=before.find(c=>c.owner==='Reviewer')
  update(room,{status:'working',note:'Investigation'},200)
  assert.ok(revise(room,[write('A'),review('B revised')]).goal)
  let cards=view(room)
  let same=cards.find(c=>c.id===first.id), prior=cards.find(c=>c.id===second.id)
  assert.equal(same.legacy.current,true)
  assert.equal(same.legacy.originalStatus,'working')
  assert.equal(same.comments[0].text,'[group_goal working] Investigation')
  assert.equal(prior.legacy.retired,true)
  assert.equal(prior.legacy.ambiguous,false)
  const linked=linkGoalCards(cards,[{id:'feature',scope:'room:r',goalItemIds:[first.id,second.id]}])
  assert.deepEqual(linked.filter(c=>c.parentTaskId==='feature').map(c=>c.id).sort(),[first.id,second.id].sort())
  assert.ok(revise(room,[write('A changed'),review('B revised')]).goal)
  cards=view(room); prior=cards.find(c=>c.id===first.id)
  assert.equal(prior.legacy.retired,true)
  assert.equal(prior.comments[0].text,'[group_goal working] Investigation')
  assert.equal(cards.filter(c=>c.id===first.id).length,1)
  archiveGoal(room)
  for(let i=0;i<7;i++) {room.goal={id:`later-${i}`,current:0,stages:[]};archiveGoal(room)}
  assert.ok(room.pastGoals.some(goal=>goal.id===before[0].legacy.goalId))
  assert.ok(view(room).some(c=>c.id===first.id && c.legacy.retired))
})

test('ambiguous duplicate same-owner tasks do not reuse an identity', () => {
  const room=begin();update(room,{status:'working',note:'Started'},200)
  const old=view(room).find(c=>c.owner==='Writer')
  const result=revise(room,[write('A'),write('A')])
  if (result.error) {assert.ok(result.error);return}
  const cards=view(room)
  assert.equal(cards.filter(c=>c.id===old.id).length,1)
  assert.equal(cards.find(c=>c.id===old.id).legacy.retired,true)
})

test('pre-upgrade tasks without any replies preserve their identity and association through revisions', () => {
  const room=begin(), initial=view(room), writer=initial.find(c=>c.owner==='Writer'), reviewer=initial.find(c=>c.owner==='Reviewer')
  const parents=[{id:'feature',scope:'room:r',goalItemIds:[writer.id,reviewer.id]}]
  assert.ok(revise(room,[write('A'),review('B changed')]).goal)
  let cards=linkGoalCards(view(room),parents)
  assert.equal(cards.find(c=>c.id===writer.id).legacy.current,true)
  assert.equal(cards.find(c=>c.id===reviewer.id).legacy.retired,true)
  assert.equal(cards.filter(c=>c.parentTaskId==='feature').length,2)
  assert.ok(revise(room,[write('A'),review('B again')]).goal)
  cards=linkGoalCards(view(room),parents)
  assert.equal(cards.filter(c=>c.id===reviewer.id).length,1)
  assert.equal(cards.find(c=>c.id===reviewer.id).legacy.retired,true)
  assert.equal(cards.find(c=>c.id===reviewer.id).parentTaskId,'feature')
  assert.equal(cards.find(c=>c.id===writer.id).legacy.current,true)
})

test('a changed stage acceptance retires the old task rather than carrying its result forward', () => {
  const room=begin(), original=view(room).find(c=>c.owner==='Writer')
  update(room,{status:'done',note:'Previous acceptance met'},200)
  assert.ok(revise(room,[write('A'),review('B')],'Different acceptance').goal)
  const cards=view(room), prior=cards.find(c=>c.id===original.id)
  assert.equal(prior.legacy.retired,true)
  assert.equal(prior.legacy.originalStatus,'done')
  const replacement=cards.find(c=>c.owner==='Writer' && c.legacy.current)
  assert.notEqual(replacement.id,original.id)
  assert.equal(replacement.legacy.originalStatus,'pending')
  assert.notEqual(replacement.acceptance,prior.acceptance)
})

test('same owner and task in another stage keeps each historical identity distinct', () => {
  const room={id:'r',name:'Group',members:names}
  const stages=[stage([write('A')]),{title:'Verify',acceptance:'Separate evidence',tasks:[write('A')]}]
  assert.ok(startGoal(room,{objective:'Deliver',acceptance:'Reviewed',stages},'Writer',member,names,100).goal)
  const before=view(room), ids=before.map(card=>card.id)
  assert.equal(new Set(ids).size,2)
  assert.ok(revise(room,[write('A')]).goal)
  const after=view(room)
  assert.equal(after.find(card=>card.id===ids[0]).legacy.current,true)
  assert.equal(after.find(card=>card.id===ids[1]).legacy.retired,true)
  assert.equal(new Set(after.map(card=>card.id)).size,after.length)
})
