import assert from 'node:assert/strict'
import test from 'node:test'
import { installRoomScheduleDelivery } from '../src/host/room-schedule-delivery.js'

const at = '2026-11-19T09:00:00.000Z'
const entry = (id='managed', prompt='Review the board') => ({schedule_id:id,occurrence_at:at,reminder_prompt:prompt})
const single = e => ({id:'message',source:{kind:'schedule'},content:[{type:'text',text:
  '[SCHEDULE REMINDER]\nschedule_id_json: '+JSON.stringify(e.schedule_id)+'\noccurrence_at: '+e.occurrence_at+'\nreminder_prompt_json: '+JSON.stringify(e.reminder_prompt)}]})
const batch = entries => ({id:'batch',source:{kind:'schedule'},content:[{type:'text',text:
  '[SCHEDULE REMINDER BATCH]\nreminders_json: '+JSON.stringify(entries)}]})
const context = {id:'ctx',source:{kind:'runtime-context',form:'snapshot'}}

function fixture() {
  const room={id:'room',admin:'pm',sessions:{pm:'pm-in-room'}},state={busy:false,result:'admitted'}
  const hooks=new Map(),calls=[],native=[],delivered=[]
  const agent={id:'root',session:{id:'root'},followup:m=>native.push(m),whenIdle:()=>Promise.resolve(1)}
  const rt={ctx:{on:(name,fn)=>hooks.set(name,fn)},load:async()=>{},roomOf:id=>['root','room'].includes(id)?room:undefined,
    sessionOfRoom:()=>agent.id,roomBusyForPatrol:()=>state.busy,isManagedRoomScheduleId:id=>id==='managed',
    managedRoomSchedule:(id,sid)=>id==='managed'&&sid==='root'?{roomId:room.id,adminId:room.admin,prompt:'Review the board'}:undefined,
    runScheduledRoomReview:async(...args)=>{calls.push(args);return state.result},
    ensureGroupTaskSession:async()=>{state.afterResolve?.();return 'pm-in-room'},
    deliver:async(args,guards)=>{guards.beforeAdmission();delivered.push(args)}}
  installRoomScheduleDelivery(rt)
  const target=id=>hooks.get('schedule/resolve-agent')(id,async()=>agent)
  const step=(messages,more=[],number=1)=>hooks.get('agent/pre-step')({agent,step:number,turn:5,messages},
    async()=>({kind:'enter',messages:[...messages,...more,context]}))
  return {room,state,rt,calls,native,delivered,agent,target,step}
}

test('a busy group consumes its managed schedule before wake without affecting other reminders',async()=>{
  const f=fixture();f.state.busy=true
  const agent=await f.target('root');agent.followup(single(entry()))
  assert.deepEqual(f.native,[]);assert.equal(await agent.whenIdle(),undefined)
  const custom=single(entry('custom','定时巡检'));agent.followup(custom)
  assert.equal(f.native[0],custom)
  agent.followup(batch([entry(),entry('custom','发版')]))
  assert.doesNotMatch(f.native[1].content[0].text,/"managed"/)
  assert.match(f.native[1].content[0].text,/"custom"/)
  const wrong=await f.target('private-pm');wrong.followup(single(entry()));assert.equal(f.native.length,2)
})

test('an idle occurrence goes once through the host and does not become an ordinary group broadcast',async()=>{
  const f=fixture(),m=single(entry());const agent=await f.target('root');agent.followup(m)
  assert.equal(f.native[0],m)
  const decision=await f.step([m],[{id:'skills',source:{kind:'skill-catalog',form:'catalog'}}]);assert.deepEqual(decision.messages,[])
  assert.deepEqual(f.calls,[[f.room,JSON.stringify(['managed',at]),f.agent,m.id,'Review the board',m]])
  assert.equal(f.rt.consumeSkippedPatrolTurn('root',5),true)
  assert.equal(f.rt.consumeSkippedPatrolTurn('root',5),false)
})

test('a competing user message, changed catalog text or busy group cancels only the scheduled occurrence',async()=>{
  const f=fixture(),m=single(entry()),user={id:'work',source:{kind:'user'}}
  assert.deepEqual((await f.step([m,user])).messages,[user,context])
  assert.deepEqual((await f.step([m],[user])).messages,[user,context])
  assert.deepEqual((await f.step([single(entry('managed','edited after admission'))])).messages,[])
  f.state.busy=true;assert.deepEqual((await f.step([m])).messages,[])
  assert.deepEqual(f.calls,[])
})

test('without a defined goal only the current group administrator receives the board check',async()=>{
  const f=fixture();f.state.result='no-goal'
  await f.step([single(entry())]);assert.equal(f.delivered.length,1)
  assert.equal(f.delivered[0].toId,'pm');assert.equal(f.delivered[0].sessionId,'pm-in-room');assert.equal(f.delivered[0].roomId,'room')
  assert.match(f.delivered[0].text,/Review the board/)
  f.state.afterResolve=()=>{f.room.admin='other'}
  await f.step([single(entry())]);assert.equal(f.delivered.length,1)
})

const change = id => ({id:'change',source:{kind:'schedule'},content:[{type:'text',text:
  '[SCHEDULE CHANGE]\nA scheduled task involving this session was changed outside this session. This notice is not a delivery of the task and needs no action.\nchange: created\nschedule_id_json: '+JSON.stringify(id)}]})

test('the native notice creating this timer cannot starve a new idle group',async()=>{
  const f=fixture(),m=single(entry())
  assert.deepEqual((await f.step([m,change('managed')])).messages,[])
  assert.equal(f.calls.length,1)
  const custom=change('custom')
  assert.deepEqual((await f.step([m,custom])).messages,[custom,context])
  assert.equal(f.calls.length,1)
})

test('the native opening turn itself executes an admitted root review',async()=>{
  const f=fixture(),relay={id:'trusted-relay',source:{kind:'ds-bot'}},m=single(entry())
  f.state.result={outcome:'admitted',message:relay}
  assert.deepEqual((await f.step([m])).messages,[relay,context])
  assert.equal(f.rt.consumeSkippedPatrolTurn('root',5),false)
})
