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
  let room={id:'room',admin:'pm',sessions:{pm:'pm-in-room'}},agent
  const state={busy:false,result:'admitted',replaceOnLoad:false}
  const hooks=new Map(),calls=[],native=[],delivered=[],cleanups=[]
  agent={id:'root',session:{id:'root'},followup:m=>native.push(m),whenIdle:()=>Promise.resolve(1)}
  const replaceRoom=()=>{room={...room,sessions:{...room.sessions}};agent={...agent,session:{...agent.session}}}
  const rt={ctx:{on:(name,fn)=>hooks.set(name,fn),effect:fn=>{const cleanup=fn();if(typeof cleanup==='function')cleanups.push(cleanup)}},load:async()=>{if(state.replaceOnLoad){state.replaceOnLoad=false;replaceRoom()}},roomOf:id=>['root','room'].includes(id)?room:undefined,
    sessionOfRoom:()=>agent.id,resolveAgent:async id=>id===agent.id?agent:undefined,roomBusyForPatrol:()=>state.busy,isManagedRoomScheduleId:id=>id==='managed',
    managedRoomSchedule:(id,sid)=>id==='managed'&&sid===agent.id?{roomId:room.id,adminId:room.admin,prompt:'Review the board'}:undefined,
    runScheduledRoomReview:async(...args)=>{
      if(args[0]!==room||args[2]!==agent)return 'invalid'
      calls.push(args)
      if(state.result==='no-goal')room.scheduledReviewOccurrence={key:args[1],outcome:'no-goal'}
      return state.result
    },
    ensureGroupTaskSession:async()=>{state.afterResolve?.();return 'pm-in-room'},
    deliver:async(args,guards)=>{guards.beforeAdmission();delivered.push(args)}}
  installRoomScheduleDelivery(rt)
  const target=id=>hooks.get('schedule/resolve-agent')(id,async()=>agent)
  const step=(messages,more=[],number=1)=>hooks.get('agent/pre-step')({agent,step:number,turn:5,messages},
    async()=>({kind:'enter',messages:[...messages,...more,context]}))
  return {get room(){return room},get agent(){return agent},state,rt,calls,native,delivered,target,step,
    replaceRoom,
    dispose:()=>{for(const cleanup of cleanups)cleanup()}}
}

async function captureTimers(run) {
  const original=setTimeout,timers=[]
  globalThis.setTimeout=(callback,delay)=>{const timer={callback,delay,unref(){}};timers.push(timer);return timer}
  try { await run() } finally { globalThis.setTimeout=original }
  return timers
}

test('a busy group consumes its managed schedule before wake without affecting other reminders',async t=>{
  const f=fixture();t.after(()=>f.dispose());f.state.busy=true
  const agent=await f.target('root'),timers=await captureTimers(async()=>agent.followup(single(entry())))
  assert.deepEqual(f.native,[]);assert.equal(await agent.whenIdle(),undefined)
  assert.equal(timers.length,1)
  const custom=single(entry('custom','定时巡检'));agent.followup(custom)
  assert.equal(f.native[0],custom)
  agent.followup(batch([entry(),entry('custom','发版')]))
  assert.doesNotMatch(f.native[1].content[0].text,/"managed"/)
  assert.match(f.native[1].content[0].text,/"custom"/)
  const wrong=await f.target('private-pm');wrong.followup(single(entry()));assert.equal(f.native.length,2)
})

test('a reminder filtered because the group is busy retries when the room quiets',async t=>{
  const f=fixture();t.after(()=>f.dispose());f.state.busy=true
  const agent=await f.target('root')
  const timers=await captureTimers(async()=>agent.followup(single(entry())))
  assert.deepEqual(f.native,[]);assert.equal(timers.length,1);assert.equal(timers[0].delay,15000)
  f.state.replaceOnLoad=true
  f.state.busy=false;timers[0].callback();await new Promise(resolve=>setImmediate(resolve))
  assert.equal(f.calls.length,1)
  assert.strictEqual(f.calls[0][0],f.room)
  assert.equal(f.calls[0][1],JSON.stringify(['managed',at]))
  assert.strictEqual(f.calls[0][2],f.agent)
  assert.deepEqual(f.calls[0].slice(3),[undefined,'Review the board',undefined])
})

test('a busy group without a goal checks its board once when the room quiets', async t => {
  const f=fixture();t.after(()=>f.dispose())
  f.state.busy=true
  f.state.result='no-goal'
  const agent=await f.target('root'), message=single(entry())
  const timers=await captureTimers(async()=>{
    agent.followup(message)
    agent.followup(message)
  })
  assert.equal(timers.length,1)
  assert.deepEqual(f.native,[])
  f.state.busy=false
  timers[0].callback()
  await new Promise(resolve=>setImmediate(resolve))
  assert.equal(f.delivered.length,1)
  assert.equal(f.delivered[0].toId,'pm')
  assert.equal(f.delivered[0].sessionId,'pm-in-room')
  assert.equal(f.delivered[0].role,'room')
  assert.match(f.delivered[0].text,/Review the board/)
})

test('a deferred board check waits out room work that starts while resolving the administrator', async t => {
  const f=fixture();t.after(()=>f.dispose())
  f.state.busy=true
  f.state.result='no-goal'
  const agent=await f.target('root')
  const timers=await captureTimers(async()=>agent.followup(single(entry())))
  let rootRunning=false
  f.rt.roomBusyForPatrol=(_room,_messageId,ignoredSession)=>rootRunning && ignoredSession!==f.agent.id
  f.state.afterResolve=()=>{rootRunning=true}
  const resumed=await captureTimers(async()=>{
    timers[0].callback()
    await new Promise(resolve=>setImmediate(resolve))
  })
  assert.equal(rootRunning,true)
  assert.deepEqual(f.delivered,[])
  assert.equal(resumed.length,1)
  assert.equal(resumed[0].delay,30000)
  f.state.afterResolve=undefined
  rootRunning=false
  resumed[0].callback()
  await new Promise(resolve=>setImmediate(resolve))
  assert.equal(f.delivered.length,1)
  assert.equal(f.calls.length,1)
})

test('a board check from the opening step retries if the room becomes busy before admission', async t => {
  const f=fixture();t.after(()=>f.dispose())
  f.state.result='no-goal'
  const deliver=f.rt.deliver, withdrawn=[]
  f.rt.forgetDelivery=id=>withdrawn.push(id)
  f.rt.deliver=async(args,guards)=>{
    f.state.busy=true
    return deliver(args,guards)
  }
  const timers=await captureTimers(async()=>f.step([single(entry())]))
  assert.equal(f.delivered.length,0)
  assert.equal(withdrawn.length,1)
  assert.equal(timers.length,1)
  f.rt.deliver=deliver
  f.state.busy=false
  timers[0].callback()
  await new Promise(resolve=>setImmediate(resolve))
  assert.equal(f.delivered.length,1)
  assert.equal(f.delivered[0].exchangeId,withdrawn[0])
  assert.equal(f.calls.length,1)
})

test('a deferred group check refreshes the binding before proceeding', async t => {
  const f=fixture();t.after(()=>f.dispose())
  f.state.busy=true
  f.state.result='no-goal'
  const agent=await f.target('root')
  const timers=await captureTimers(async()=>agent.followup(single(entry())))
  f.state.busy=false
  f.rt.refreshRoomScheduleBindings=async()=>{f.rt.managedRoomSchedule=()=>undefined}
  timers[0].callback()
  await new Promise(resolve=>setImmediate(resolve))
  assert.deepEqual(f.calls,[])
  assert.deepEqual(f.delivered,[])
})

test('an idle occurrence goes once through the host and does not become an ordinary group broadcast',async()=>{
  const f=fixture(),m=single(entry());const agent=await f.target('root');agent.followup(m)
  assert.equal(f.native[0],m)
  const decision=await f.step([m],[{id:'skills',source:{kind:'skill-catalog',form:'catalog'}}]);assert.deepEqual(decision.messages,[])
  assert.deepEqual(f.calls,[[f.room,JSON.stringify(['managed',at]),f.agent,m.id,'Review the board',m]])
  assert.equal(f.rt.consumeSkippedPatrolTurn('root',5),true)
  assert.equal(f.rt.consumeSkippedPatrolTurn('root',5),false)
})

test('a competing user message, changed catalog text or busy group cancels only the scheduled occurrence',async t=>{
  const f=fixture();t.after(()=>f.dispose())
  const m=single(entry()),user={id:'work',source:{kind:'user'}}
  assert.deepEqual((await f.step([m,user])).messages,[user,context])
  assert.deepEqual((await f.step([m],[user])).messages,[user,context])
  assert.deepEqual((await f.step([single(entry('managed','edited after admission'))])).messages,[])
  f.state.busy=true;assert.deepEqual((await f.step([m])).messages,[])
  assert.deepEqual(f.calls,[])
})

test('a group that becomes busy before its scheduled pre-step retries after quieting',async t=>{
  const f=fixture();t.after(()=>f.dispose())
  const m=single(entry()),agent=await f.target('root');agent.followup(m);f.state.busy=true
  const timers=await captureTimers(async()=>assert.deepEqual((await f.step([m])).messages,[]))
  assert.equal(timers.length,1);assert.equal(f.calls.length,0)
  f.state.busy=false;timers[0].callback();await new Promise(resolve=>setImmediate(resolve))
  assert.equal(f.calls.length,1)
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
