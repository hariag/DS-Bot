import test from 'node:test'
import assert from 'node:assert/strict'
import { createRoomScheduleRegistry } from '../src/host/room-schedule-registry.mjs'

function setup(rooms, options = {}) {
  const rt = {
    state:{rooms:structuredClone(rooms)}, load:async()=>{}, readOnly:()=>undefined, homeLockVersion:()=>1,
    sessionOfRoom:r=>r.sessionId ?? r.id, botOf:id=>['pm','new-pm'].includes(id) ? {id} : undefined,
    save:async()=>{}, onSaved:()=>()=>{}, onHomeDrain(fn){this.close=fn}, warn(){},
  }
  let seq=0, revision=0
  const rows=new Map()
  const host={
    async create(request) {
      const id='schedule-'+ ++seq
      const row={id,title:request.title,prompt:request.prompt,target:request.target,kind:request.timing.kind,
        everySeconds:request.timing.every_seconds,status:'active',updatedAt:String(++revision)}
      rows.set(id,row)
      if (options.loseCreateResponse) {options.loseCreateResponse=false;throw Error('lost create response')}
      return structuredClone(row)
    },
    catalog:async()=>structuredClone(Array.from(rows.values())),
    async edit({id,action,expectedUpdatedAt,patch}) {
      const row=rows.get(id)
      if (row?.updatedAt!==expectedUpdatedAt)return {code:'schedule_conflict'}
      if(action==='delete'){rows.delete(id);return {id,deleted:true}}
      Object.assign(row,Object.fromEntries(Object.entries(patch).filter(([k])=>k!=='timing'&&k!=='active')))
      if(patch.timing)Object.assign(row,{kind:patch.timing.kind,everySeconds:patch.timing.every_seconds})
      if(patch.active !== undefined)row.status=patch.active ? 'active' : 'paused'
      row.updatedAt=String(++revision)
      return structuredClone(row)
    },
  }
  const start=()=>createRoomScheduleRegistry(rt,()=>host)
  return {rt,rows,host,start}
}

const room={id:'ui',name:'UI',members:['pm','new-pm'],admin:'pm',sessionId:'ui-part'}
test('native room schedules follow the actual room, preserve independent timing and business notes, and bind the current admin',async t=>{
  const {rt,rows,start}=setup({ui:room,dev:{...room,id:'dev',name:'Dev',sessionId:'dev-part'}})
  const mgr=start();t.after(()=>rt.close())
  await Promise.all(Array.from({length:6},()=>mgr.reconcile()))
  const [ui,dev]=[...rows.values()]
  assert.equal(rows.size,2);assert.equal(ui.everySeconds,1800);assert.equal(ui.target.sessionId,'ui-part')
  assert.equal(dev.target.sessionId,'dev-part');assert.equal(ui.status,'active')
  assert.equal(mgr.lookup(ui.id,'dev-part'),undefined);assert.equal(mgr.lookup(ui.id,'pm'),undefined)
  assert.equal(mgr.lookup(dev.id,'dev-part').adminId,'pm')
  assert.equal(mgr.ownerOf('unrelated'),undefined)
  ui.prompt+=' Follow the signed release milestones.';assert.equal(mgr.lookup(ui.id,'ui-part').prompt.includes('signed release'),false)
  await mgr.refresh();assert.ok(mgr.lookup(ui.id,'ui-part').prompt.includes('signed release'))
  rt.state.rooms.ui.name='New name';rt.state.rooms.ui.admin='new-pm'
  await mgr.reconcile()
  assert.equal(mgr.lookup(ui.id,'ui-part').adminId,'new-pm')
  rt.state.rooms.ui.sessionId='ui-part-2'
  assert.equal(mgr.lookup(ui.id,'ui-part'),undefined);assert.equal(mgr.ownerOf(ui.id),'ui')
  await mgr.reconcile();assert.equal(mgr.lookup(ui.id,'ui-part-2').adminId,'new-pm')
  assert.equal(ui.title,'DSBOT-GROUP/ui');assert.ok(ui.prompt.includes('signed release'))
  ui.status='paused';await mgr.refresh();assert.equal(mgr.lookup(ui.id,'ui-part-2'),undefined)
  await mgr.reconcile();assert.equal(ui.status,'paused')
  delete rt.state.rooms.dev;await mgr.reconcile();assert.equal(rows.has(dev.id),false);assert.equal(rows.size,1)
})

test('recover a lost create response on restart, leaving unrelated matching titles alone',async t=>{
  const {rt,rows,host,start}=setup({ui:room},{loseCreateResponse:true})
  const first=start()
  let durable
  rt.save=async()=>{durable=structuredClone(rt.state)}
  await assert.rejects(first.reconcile(),/lost create/);assert.equal(rows.size,1)
  const [actual]=rows.values()
  assert.ok(durable.roomSchedules.ui.token);assert.equal(durable.roomSchedules.ui.id,undefined)
  await rt.close()
  rt.state=durable
  const other=await host.create({title:actual.title,prompt:'A normal reminder with the same name',timing:{kind:'every',every_seconds:1800},target:{kind:'session',sessionId:'ui-part'}})
  const restarted=start();t.after(()=>rt.close())
  await restarted.refresh()
  assert.equal(restarted.known(actual.id),true);assert.equal(restarted.known(other.id),false)
  assert.equal(restarted.lookup(actual.id,'ui-part'),undefined)
  await restarted.reconcile();assert.equal(rows.size,2);assert.equal(restarted.ownerOf(other.id),undefined)
  assert.equal(restarted.lookup(actual.id,'ui-part').roomId,'ui')
  rows.delete(actual.id);await restarted.reconcile()
  assert.equal(rows.size,2);assert.ok(rows.has(other.id))
  assert.equal(restarted.ownerOf(actual.id),undefined);assert.equal(restarted.known(actual.id),true);assert.notEqual(rt.state.roomSchedules.ui.id,actual.id)
})

test('never create with an unpersisted marker or mutate native schedules while the roster is read-only', async t=>{
  const {rt,rows,start}=setup({ui:room});const mgr=start();t.after(()=>rt.close())
  let canWrite=false, durable
  rt.save=async()=>{if(!canWrite)throw Error('disk full');durable=structuredClone(rt.state)}
  await assert.rejects(mgr.reconcile(),/disk full/);assert.equal(rows.size,0)
  await assert.rejects(mgr.reconcile(),/disk full/);assert.equal(rows.size,0)
  canWrite=true;rt.readOnly=()=>'another writer';await mgr.reconcile();assert.equal(rows.size,0)
  rt.readOnly=()=>undefined;await mgr.reconcile();assert.equal(rows.size,1);assert.ok(durable.roomSchedules.ui.id)
})

test('an unavailable native room does not block another room owned by the same administrator', async t=>{
  const {rt,rows,host,start}=setup({ui:room,dev:{...room,id:'dev',sessionId:'dev-root'}})
  const create=host.create.bind(host)
  host.create=async request=>{if(request.target.sessionId==='ui-part')throw Error('Unavailable root');return create(request)}
  const mgr=start();t.after(()=>rt.close())
  await assert.rejects(mgr.reconcile(),/Unavailable root/)
  const [registered]=rows.values()
  assert.equal(rows.size,1);assert.equal(mgr.lookup(registered.id,'dev-root').roomId,'dev')
  host.create=create
  await mgr.reconcile()
  assert.equal(rows.size,2);assert.equal(mgr.lookup(registered.id,'dev-root').roomId,'dev')
})

test('a moved unconfirmed native record keeps its one identity and never follows an unverified copied marker', async t=>{
  const {rt,rows,start}=setup({ui:room},{loseCreateResponse:true});const mgr=start();t.after(()=>rt.close())
  await assert.rejects(mgr.reconcile(),/lost create/)
  const [first]=rows.values()
  first.target={kind:'session',sessionId:'wrong-room'}
  await assert.rejects(mgr.reconcile(),/Ambiguous/)
  assert.equal(rows.size,1);assert.equal(first.target.sessionId,'wrong-room');assert.equal(mgr.known(first.id),false)
  first.involvedSessionIds=['ui-part','wrong-room'];first.title='Human edit'
  await mgr.reconcile()
  assert.equal(rows.size,1);assert.equal(first.target.sessionId,'ui-part')
  assert.equal(mgr.lookup(first.id,'wrong-room'),undefined);assert.equal(mgr.lookup(first.id,'ui-part').roomId,'ui')
})

test('replacing a deleted paused managed schedule preserves the pause and human business requirements',async t=>{
  const {rt,rows,start}=setup({ui:room});const mgr=start();t.after(()=>rt.close())
  await mgr.reconcile()
  const [old]=rows.values()
  old.status='paused';old.prompt='Review the release backlog in the original group.'
  await mgr.reconcile();rows.delete(old.id)
  await mgr.reconcile()
  const [replacement]=rows.values()
  assert.notEqual(old.id,replacement.id);assert.equal(replacement.prompt,old.prompt)
  assert.equal(replacement.status,'paused');assert.equal(mgr.lookup(replacement.id,'ui-part'),undefined)
  replacement.status='active';await mgr.reconcile();assert.equal(mgr.lookup(replacement.id,'ui-part').prompt,old.prompt)
})

test('a lost creation receipt followed by an edited-away marker cannot duplicate or adopt a same-name task', async t=>{
  const {rt,rows,start}=setup({ui:room},{loseCreateResponse:true});const mgr=start();t.after(()=>rt.close())
  await assert.rejects(mgr.reconcile(),/lost create/)
  const [row]=rows.values()
  row.prompt='An externally edited request';row.title='A new title'
  await assert.rejects(mgr.reconcile(),/identify native room schedule/)
  assert.equal(rows.size,1);assert.equal(row.prompt,'An externally edited request')
  assert.equal(mgr.ownerOf(row.id),undefined)
})
