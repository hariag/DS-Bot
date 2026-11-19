import { test } from 'node:test'
import assert from 'node:assert/strict'
import { missedRoomTerminal } from '../src/host/missed-room-reply.mjs'

const room = 'room-a'
const member = 'bot-a'
const exchange = 'turn-a'
const source = { kind:'bot', form:'relay', role:'room', roomId:room, exchangeId:exchange, senderName:'You' }
const arrival = (id, source, text) => ({role:'user', id, source, content:[{type:'text', text}]})
const groupInput = arrival('group-input',source,'message for the member')
const previous = arrival('user-input',{kind:'user'},'older work')
const model = (turn,step,text) => ({turn,step,message:{role:'assistant',source:{kind:'model',provider:'deepseek-official',model:'deepseek-flash'},content:[{type:'text',text}]}})
const inbox = (target,inserted,removedCount) => ['agent/inbox/spliced',{target,start:0,inserted,...(removedCount?{removedCount}:{})}]
const since = 1800000010100
const sample = [
  inbox('next-turn',[previous]),
  ['turn/start',{turn:2}],
  inbox('next-turn',[],1),
  ['step/start',{turn:2,step:1}],
  ['user/message',previous],
  inbox('next-step',[groupInput]),
  ['assistant/message',model(2,1,'PASS')],
  ['step/end',{turn:2,step:1}],
  inbox('next-step',[],1),
  ['step/start',{turn:2,step:2}],
  ['user/message',groupInput],
  ['assistant/message',model(2,2,'a complete result')],
  ['step/end',{turn:2,step:2}],
  ['turn/end',{turn:2,reason:{kind:'completed'}}],
]
const events = () => sample.map(([type,data],i)=>({type,seq:i,time:since+(i-1)*100,data:structuredClone(data)}))
const record = () => ({botId:member,roomId:room,since,turn:2})
const at = (rows,type,last=false) => (last ? rows.findLast(e=>e.type===type) : rows.find(e=>e.type===type))
const input = rows => at(rows,'user/message',true)
const enqueue = rows => rows.find(e=>e.type==='agent/inbox/spliced'&&e.data.inserted[0]?.id===groupInput.id)
const beforeFinal = (rows,type,data) => {
  const at=rows.findLastIndex(e=>e.type==='assistant/message')
  rows.splice(at,0,{type,seq:0,time:rows[at].time,data})
  rows.forEach((e,i)=>e.seq=i)
}

test('a steered next-step group turn binds its original immutable admission and its successful terminal reply',()=>{
  const a=missedRoomTerminal(events(),record())
  assert.ok(a);assert.equal(a.exchangeId,exchange);assert.equal(a.inputId,groupInput.id)
  assert.equal(a.text,'a complete result');assert.ok(Number.isSafeInteger(a.terminalSeq))
  assert.deepEqual(missedRoomTerminal(events(),record()),a)
})

test('matched source text cannot substitute for matching queue identity and payload',()=>{
  const mutations=[
    rows=>{ input(rows).data.id='another-message' },
    rows=>{ input(rows).data.source.exchangeId='another-exchange' },
    rows=>{ input(rows).data.content[0].text='different content, same IDs' },
    rows=>{ input(rows).data.source.roomId='room-b' },
    rows=>{ enqueue(rows).data.inserted=[] },
    rows=>{ enqueue(rows).data.inserted.push(structuredClone(groupInput)) },
    rows=>{ beforeFinal(rows,'user/message',structuredClone(groupInput)) },
    rows=>{ const msg=structuredClone(groupInput);msg.id='other';msg.source.exchangeId='other';beforeFinal(rows,'user/message',msg) },
  ]
  for(const change of mutations){const rows=events();change(rows);assert.equal(missedRoomTerminal(rows,record()),undefined,change.toString())}
})

test('other turns, earlier replies, calls, extra actors and incomplete results cannot be posted as a member reply',()=>{
  const mutations=[
    rows=>{ at(rows,'assistant/message').data.message.content=[{type:'text',text:'prior unrelated work'}] },
    rows=>{ at(rows,'assistant/message',true).data.turn=3 },
    rows=>{ at(rows,'assistant/message',true).data.message.source.kind='plugin' },
    rows=>{ at(rows,'assistant/message',true).data.message.content.push({type:'tool-call',id:'call-1',name:'bash',arguments:{}}) },
    rows=>{ beforeFinal(rows,'tool/call',{turn:2,step:2,name:'read',callId:'read-1'}) },
    rows=>{ beforeFinal(rows,'unknown/source',{}) },
    rows=>{ beforeFinal(rows,'approval/request',{turn:2}) },
    rows=>{ at(rows,'assistant/message',true).data.message.content=[] },
    rows=>{ at(rows,'turn/end').data.reason={kind:'error'} },
    rows=>{ rows.splice(rows.findLastIndex(e=>e.type==='step/end'),1) },
    rows=>{ rows.pop() },
  ]
  for(const change of mutations){const rows=events();change(rows);assert.equal(missedRoomTerminal(rows,record()),undefined,change.toString())}
  for(const override of [{roomId:'room-b'},{turn:4},{since:since-5000}])assert.equal(missedRoomTerminal(events(),{...record(),...override}),undefined)
})

test('a prior native group post in the relay finalization gap prevents republication', async () => {
  const { relayRecorded } = await import('../src/host/missed-room-reply.mjs')
  const anchor = { id:'round', from:3 }
  const call = { seq:0, type:'tool/call', data:{ name:'group_relay', callId:'relay' } }
  const result = { seq:1, type:'tool/result', sourceEventSeqs:[0], data:{ message:{
    toolCallId:'relay', isError:false, content:[{type:'text',text:JSON.stringify({anchor:'round',from:3})}] } } }
  const proof = { roomId:room, botId:member }
  assert.equal(relayRecorded([call, result], anchor, proof), true)
  const post = arrival('legacy-post',{kind:'bot',role:'post',senderSessionId:member},'prior final')
  assert.equal(relayRecorded([call, {seq:1,type:'user/message',data:post}, {...result,seq:2}], anchor, proof), false)
  assert.equal(relayRecorded([{seq:0,type:'agent/inbox/spliced',data:{target:'next-turn',start:0,inserted:[post]}},
    {...call,seq:1},{...result,seq:2,sourceEventSeqs:[1]}], anchor, proof), false)
})
