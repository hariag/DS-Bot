import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import pngjs from 'pngjs'
import { randomFillSync } from 'node:crypto'
import { install, BOARD_UPLOAD_PATH, BOARD_UPLOAD_MAX_BYTES } from '../../src/host/board-service.js'
import { install as installDelivery } from '../../src/host/delivery.js'
import { install as installPrivacy } from '../../src/host/privacy.js'
import { openTaskStore } from '../../src/host/task-store.mjs'
import { userRedoIdentity } from '../../src/host/user-redo-journal.mjs'

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'dsbot-board-host-'))
  const effects = [], routes = [], drains = [], deliveries = [], agents = new Map()
  const agentFor = id => {
    if (!agents.has(id)) {
      const session = { id }, agent = { id, session, followup:message => deliveries.push({ sessionId:id, message }), steer:message => deliveries.push({ sessionId:id, message }) }
      agents.set(id, agent)
    }
    return agents.get(id)
  }
  const rt = {
    home, teamTools: [], groupOwners:new Map(), state: { revision: 1, exchanges:[], works:{}, rooms: { group: { id:'group', name:'Group', members: ['one','two'], sessions:{}, seen:{} } }, bots: { one: { name:'One' }, two: { name:'Two' } } },
    ctx: { sessionController:{ resolveAgent:async id=>({agent:agentFor(id)}) }, sessions:{flush:async()=>{}},
      effect(fn) { const dispose = fn(); effects.push(dispose) }, connection: { fetch: { register(route) { routes.push(route); return () => {} } } } },
    onHomeDrain(fn) { drains.push(fn) }, async load() {}, readOnly() {}, requireHomeLock() {}, warn(...args) { console.log(...args) },
    botOf:id=>Object.hasOwn(rt.state.bots,id)?{id,...rt.state.bots[id]}:undefined,
    selfOf:id=>id==='group-one'?'one':id==='group-two'?'two':id==='chat-one'?'one':id==='chat-two'?'two':undefined,
    roomOf:id=>Object.hasOwn(rt.state.rooms,id)?rt.state.rooms[id]:undefined,
    chatOf:id=>`chat-${id}`, ensureGroupTaskSession:async(roomId,botId)=>{
      const sessionId=`${roomId}-${botId}`;rt.state.rooms[roomId].sessions[botId]=sessionId;rt.groupOwners.set(sessionId,{botId,roomId});return sessionId
    }, ensureCapabilities:async()=>{}, hideBotUnusedTools(){}, save:async()=>{},
    async createRoom({ members, name, admin }) {
      const id = `release-room-${Object.keys(rt.state.rooms).length + 1}`
      rt.state.rooms[id] = { id, name, members:[...new Set(members)], admin, sessions:{}, seen:{} }
      return rt.state.rooms[id]
    },
    async updateRoom(id, patch) {
      const room = rt.state.rooms[id]
      if (!room) throw new Error('Unknown group chat')
      if (Array.isArray(patch.add)) room.members = [...new Set([...room.members, ...patch.add])]
      return { room, changes:{} }
    },
    ledger:{importer(){},records(){return []},append(){},written:async()=>{}}, goalDispatchBlocked:()=>false,
  }
  installDelivery(rt)
  install(rt)
  t.after(async () => { for (const dispose of effects.reverse()) await dispose?.(); for (const drain of drains) await drain(); rmSync(home, { recursive: true, force: true }) })
  return { rt, route: routes.find(route => route.path === BOARD_UPLOAD_PATH), home, deliveries }
}
const scope = { kind:'room', id:'group' }
const create = { scope, operationId:'create-1', taskId:'t1', type:'create', value:{ title:'Task', owner:'one', reviewer:'two', acceptance:'Independent proof', dependencies:[] } }
const request = payload => new Request('http://localhost/api/bot-board-upload', { method:'POST', body:JSON.stringify({ endpoint:'board-upload', payload }), duplex:'half' })
const image = { uploadId:'img1', name:'a.png', mediaType:'image/png', data:pngjs.PNG.sync.write({ width:1, height:1, data:Buffer.from([0,0,0,255]) }).toString('base64') }
const image2 = { ...image, uploadId:'img2', name:'b.png' }

test('authenticated board view returns only the scoped read-only recovery projection', async t => {
  const { rt } = fixture(t)
  const seen = []
  rt.recoveryHeldView = requested => { seen.push(requested); return { available:true, incomplete:false, items:[] } }
  const result = await rt.boardCall('board-list', { scope })
  assert.deepEqual(result.recovery, { available:true, incomplete:false, items:[] })
  const brief = await rt.boardCall('board-list', { scope, includeRecovery:false })
  assert.equal(Object.hasOwn(brief, 'recovery'), false)
  assert.deepEqual(brief.tasks, result.tasks)
  assert.deepEqual(seen, [scope], 'ordinary board reads skip the recovery journal')
  const full = await rt.boardCall('board-list', { scope, includeRecovery:true })
  assert.deepEqual(full.recovery, result.recovery)
  for (const includeRecovery of [true, false]) {
    await assert.rejects(rt.boardCall('board-list', { scope:{ kind:'room', id:'unknown' }, includeRecovery }), /available/)
  }
  assert.deepEqual(seen, [scope, scope], 'invalid scopes never reach the recovery projection')
})

test('the owner sees only a scope-matched uncertain redo, never unverified result data', async t => {
  const { rt } = fixture(t), recoveryId = 'a'.repeat(64), operationId = '9d5b1723-7063-4e3e-b27e-12f44dd0033d'
  rt.recoveryHeldView = () => ({ available:true, incomplete:false, items:[{ recoveryId, botId:'one', roomId:'group', sessionId:'original' }] })
  rt.state.userRedos = { [operationId]:{ operationId, identity:userRedoIdentity(operationId), recoveryId, scope, acknowledged:true,
    original:{ botId:'one', sessionId:'original', turn:3, messageSeq:5, messageId:'input', messageHash:'b'.repeat(64) },
    state:'completed', result:'SECRET-UNVERIFIED' } }
  const room = await rt.boardCall('board-list', { scope })
  assert.deepEqual(room.recovery.items[0].redo, { operationId, status:'unknown' })
  assert.doesNotMatch(JSON.stringify(room), /SECRET-UNVERIFIED|completed/)
  const personal = await rt.boardCall('board-list', { scope:{ kind:'personal', id:'user' } })
  assert.equal(personal.recovery.items[0].redo, undefined)
  rt.state.rooms.group.members = ['two']
  assert.equal((await rt.boardCall('board-list', { scope })).recovery.items[0].redo, undefined)
})

test('remote code status is limited to the owner personal board', async t => {
  const { rt } = fixture(t)
  rt.remoteChangeView=()=>({status:'ok',events:[{sha:'a'.repeat(40)}]})
  const own=await rt.boardCall('board-list',{scope:{kind:'personal',id:'user'}})
  assert.equal(own.remoteChanges.events.length,1)
  assert.equal((await rt.boardCall('board-list',{scope:{kind:'personal',id:'one'}})).remoteChanges,undefined)
  assert.equal((await rt.boardCall('board-list',{scope})).remoteChanges,undefined)
})

test('actual task journal backs the five instance-user endpoints with isolated group and personal views', async t => {
  const { rt, route } = fixture(t)
  assert.equal(route.requestBody, 'streaming')
  const created = await rt.boardCall('board-command', create)
  assert.equal(created.status, 'proposed'); assert.equal(created.owner, 'one')
  assert.equal((await rt.boardCall('board-operation', { scope, operationId:'create-1' })).state, 'committed')
  assert.equal((await rt.boardCall('board-list', { scope })).tasks[0].id, 't1')
  assert.equal((await rt.boardCall('board-list', { scope:{ kind:'personal', id:'one' } })).tasks[0].id, 't1')
  const edit = { scope, operationId:'edit-1', taskId:'t1', expectedRevision:1, type:'edit', value:{ ...create.value, title:'New title' } }
  assert.equal((await rt.boardCall('board-command', edit)).title, 'New title')
  const upload = { scope, taskId:'t1', operationId:'upload-1', expectedRevision:2, images:[image, image2] }
  const uploaded = await route.fetch(request(upload))
  assert.equal((await uploaded.json()).ok, true)
  assert.equal((await (await route.fetch(request(upload))).json()).ok, true)
  const changed = { ...upload, images:[image, { ...image2, name:'different.png' }] }
  assert.equal((await (await route.fetch(request(changed))).json()).ok, false)
  const shown = await rt.boardCall('board-image', { scope, taskId:'t1', imageId:'img1' })
  assert.equal(shown.data, image.data)
  assert.equal((await rt.boardCall('board-list', { scope })).tasks[0].images.length, 2)
  const remove = { scope, taskId:'t1', operationId:'remove-1', expectedRevision:3, type:'remove-image', value:{imageId:'img1'} }
  await rt.boardCall('board-command', remove)
  assert.equal((await rt.boardCall('board-list', { scope })).tasks[0].images.length, 1)
  await assert.rejects(rt.boardCall('board-image', { scope, taskId:'t1', imageId:'img1' }), /unavailable/)
  assert.equal(readdirSync(join(rt.home, 'board-v1', 'images')).length, 2)
})

test('a scheduled task enters the real DSH Session once with a revision-bound message', async t => {
  const {rt,deliveries}=fixture(t), scope={kind:'room',id:'group'}
  const created=await rt.boardCall('board-command',{scope,operationId:'scheduled-create',taskId:'scheduled-task',type:'create',value:{
    title:'Run the task',owner:'one',reviewer:'two',acceptance:'Independent evidence',dependencies:[],
  }})
  assert.equal(created.status,'proposed')
  const scheduled=await rt.boardCall('board-command',{scope,operationId:'scheduled-run',taskId:created.id,expectedRevision:created.revision,type:'schedule'})
  assert.equal(scheduled.status,'ready')
  const deadline=Date.now()+3000
  while(!deliveries.length&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10))
  assert.equal(deliveries.length,1)
  const {sessionId,message}=deliveries[0]
  assert.equal(sessionId,'group-one');assert.equal(message.role,'user')
  assert.equal(message.source.roomId,'group');assert.equal(message.source.role,'room')
  assert.equal(message.source.taskAction.id.length,64);assert.equal(message.source.taskAction.taskRevision,scheduled.revision)
  assert.equal(message.source.taskAction.actionRevision,scheduled.actionRevision)
  assert.match(message.content[0].text,/Independent evidence/)
  assert.equal((await rt.boardCall('board-list',{scope})).tasks.find(task=>task.id===created.id).dispatchState,'accepted')
  await rt.boardCall('board-command',{scope,operationId:'scheduled-repeat',taskId:created.id,expectedRevision:scheduled.revision,type:'schedule'}).then(
    () => assert.fail('a ready task must not be admitted a second time'),
    error => assert.match(error.message,/not ready to schedule|schedulable/i))
  await new Promise(resolve=>setTimeout(resolve,30))
  assert.equal(deliveries.length,1)
})

test('scheduled owner and reviewer receive their exact evidence fields and can correct a rejected report', async t => {
  const {rt, deliveries} = fixture(t)
  const card = await rt.boardCall('board-command', create)
  const ready = await rt.boardCall('board-command', { scope, taskId:card.id, type:'schedule', expectedRevision:card.revision, operationId:'schedule-evidence' })
  await settle(async () => deliveries.length === 1)
  assert.match(deliveries[0].message.content[0].text, /report, send value exactly as \{"kind":"personal","environment":".+?","evidence":"/)
  const tool = rt.teamTools.find(item => item.name === 'board_task')
  const call = async (sessionId, args) => JSON.parse(await tool.execute({ task_id:card.id, ...args }, { agent:{ id:sessionId } }))
  const {task:working} = await call('group-one', { action:'start', operation_id:'owner-start', expected_revision:ready.revision })
  const report = { action:'report', operation_id:'owner-report', expected_revision:working.revision }
  const personal = {kind:'personal', environment:'repository checkout', evidence:'Compared the original and updated objects'}
  await assert.rejects(call('group-one', {...report, operation_id:'owner-extra', value:{...personal, result:'pass'}}),
    /invalid fields.*Unexpected value fields result.*"kind":"personal"/)
  await assert.rejects(call('group-two', {...report, operation_id:'wrong-owner', value:{...personal, result:'pass'}}),
    /not authorized$/)
  const oid = 'a'.repeat(40)
  await assert.rejects(call('group-one', {...report, operation_id:'git-report', value:{
    ...personal, kind:'git', targetCommit:oid, targetBlob:oid, acceptanceBlob:oid,
  }}), /report evidence unverified.*"kind":"personal"/)
  const {task:reported} = await call('group-one', {...report, value:personal})
  assert.equal(reported.status, 'reported')
  await settle(async () => deliveries.length === 2)
  assert.equal(deliveries[1].sessionId, 'group-two')
  assert.match(deliveries[1].message.content[0].text, /review, send value exactly as \{"result":"pass","evidence":".+?"\}.*"rework"/)
  const review = { action:'review', operation_id:'reviewer-review', expected_revision:reported.revision }
  const decision = { result:'pass', evidence:'Independently verified the acceptance criteria' }
  await assert.rejects(call('group-two', {...review, operation_id:'review-extra', value:{...decision, environment:'fixture'}}),
    /invalid fields.*Unexpected value fields environment.*"result":"pass"/)
  const {task:done} = await call('group-two', {...review, value:decision})
  assert.equal(done.status, 'done')

  const change = await rt.boardCall('board-command', { scope, taskId:card.id, type:'card-details',
    expectedRevision:done.revision, operationId:'changed-description', value:{description:'Cover a new case'} })
  const changePrompt = sessionId => settle(async () => deliveries.find(entry => entry.sessionId === sessionId
    && entry.message.source?.taskAction && entry.message.content[0].text.includes('Task ID: '+change.id+' (revision '))?.message.content[0].text)
  const ownerPrompt = await changePrompt('group-one')
  assert.match(ownerPrompt, /Before:.*\nAfter:.*Cover a new case/)
  assert.match(ownerPrompt, /adjust what is needed or explicitly reassign it/)
  const {task:startedChange} = await call('group-one', { task_id:change.id, action:'start', operation_id:'changed-start', expected_revision:change.revision })
  await call('group-one', { task_id:change.id, action:'report', operation_id:'changed-report', expected_revision:startedChange.revision, value:personal })
  const reviewerPrompt = await changePrompt('group-two')
  assert.match(reviewerPrompt, /Before:.*\nAfter:.*Cover a new case/)
  assert.match(reviewerPrompt, /Independently compare the before and after requirements/)
  assert.match(reviewerPrompt, /board_task review/)
  assert.doesNotMatch(reviewerPrompt, /adjust what is needed|board_task report/)
})

test('a personal Bot task can be created and delivered to its private Session', async t => {
  const {rt,deliveries}=fixture(t),scope={kind:'personal',id:'one'}
  const created=await rt.boardCall('board-command',{scope,operationId:'personal-scheduled-create',taskId:'personal-scheduled',type:'create',value:{
    title:'Private task',owner:'one',reviewer:'two',acceptance:'Independent evidence',dependencies:[],
  }})
  assert.equal(created.status,'proposed')
  const scheduled=await rt.boardCall('board-command',{scope,operationId:'personal-scheduled-run',taskId:created.id,expectedRevision:created.revision,type:'schedule'})
  assert.equal(scheduled.status,'ready')
  const deadline=Date.now()+3000
  while(!deliveries.length&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10))
  assert.equal(deliveries.length,1)
  const {sessionId,message}=deliveries[0]
  assert.equal(sessionId,'chat-one');assert.equal(message.role,'user');assert.equal(message.source.role,'request')
  assert.equal(message.source.taskAction.taskRevision,scheduled.revision)
  assert.equal((await rt.boardCall('board-list',{scope})).tasks.find(task=>task.id===created.id).dispatchState,'accepted')
})

test('owner moves a personal card with a durable receipt without changing shared workflow', async t => {
  const { rt } = fixture(t), personal={kind:'personal',id:'user'}
  await rt.boardCall('board-command',{scope:personal,operationId:'personal-create',taskId:'mine',type:'create',value:{title:'Mine',owner:'user',reviewer:'one',acceptance:'Check',dependencies:[]}})
  const before=await rt.boardCall('board-list',{scope:personal})
  assert.equal(before.tasks[0].personalProgress,'todo')
  assert.ok(before.capabilities.commands.mine.some(command=>command.type==='personal-progress'))
  const input={scope:personal,operationId:'personal-move',taskId:'mine',expectedRevision:1,type:'personal-progress',value:{progress:'finished'}}
  const result=await rt.boardCall('board-command',input)
  assert.equal(result.personalProgress,'finished'); assert.equal(result.status,'proposed')
  assert.deepEqual(await rt.boardCall('board-command',input),result)
  assert.equal((await rt.boardCall('board-operation',{scope:personal,operationId:'personal-move'})).state,'committed')
  assert.equal((await rt.boardCall('board-list',{scope:personal})).tasks[0].status,'proposed')
  await assert.rejects(rt.boardCall('board-command',{...input,operationId:'other',expectedRevision:2,value:{progress:'done'}}),/unavailable|invalid/i)
})

test('card order, due metadata and comment editing round-trip through the host journal', async t => {
  const { rt } = fixture(t), personal = { kind:'personal', id:'user' }
  const createCard = (operationId, taskId, value) => rt.boardCall('board-command', { scope:personal, operationId, taskId, type:'create', value:{ title:taskId, owner:'user', reviewer:'one', acceptance:'Check', dependencies:[], personalProgress:'todo', ...value } })
  const first = await createCard('card-a', 'a', { description:'Prefilled', dueDate:'2028-02-29T09:30', dueComplete:true, labels:['Urgent'], checklist:[{ id:'check', text:'Inspect', checked:false }] })
  assert.equal(first.description, 'Prefilled'); assert.equal(first.dueDate, '2028-02-29T09:30'); assert.equal(first.dueComplete, true); assert.equal(typeof first.position, 'string')
  await createCard('card-b', 'b', {}); await createCard('card-c', 'c', {})
  let board = await rt.boardCall('board-list', { scope:personal })
  assert.deepEqual(board.tasks.map(task => task.id), ['a', 'b', 'c'])
  assert.equal(board.tasks[0].dueComplete, true)
  const moved = await rt.boardCall('board-command', { scope:personal, operationId:'move-c', taskId:'c', expectedRevision:1, type:'reorder', value:{ afterId:null } })
  assert.equal(moved.revision, 2); assert.equal(moved.boardActivity.at(-1).type, 'reorder')
  board = await rt.boardCall('board-list', { scope:personal })
  assert.deepEqual(board.tasks.map(task => task.id), ['c', 'a', 'b'])
  const progressed = await rt.boardCall('board-command', { scope:personal, operationId:'progress-b', taskId:'b', expectedRevision:1, type:'personal-progress', value:{ progress:'doing', afterId:null } })
  assert.equal(progressed.personalProgress, 'doing')
  const added = await rt.boardCall('board-command', { scope:personal, operationId:'comment-a', taskId:'a', expectedRevision:1, type:'card-comment', value:{ text:' First note ' } })
  assert.equal(added.comments.length, 1); assert.equal(added.comments[0].text, 'First note')
  const edited = await rt.boardCall('board-command', { scope:personal, operationId:'comment-edit', taskId:'a', expectedRevision:2, type:'card-comment-edit', value:{ commentId:added.comments[0].id, text:' Edited note ' } })
  assert.equal(edited.comments[0].text, 'Edited note'); assert.equal(edited.boardActivity.at(-1).type, 'card-comment-edit')
  const deleted = await rt.boardCall('board-command', { scope:personal, operationId:'comment-delete', taskId:'a', expectedRevision:3, type:'card-comment-delete', value:{ commentId:added.comments[0].id } })
  assert.deepEqual(deleted.comments, []); assert.equal(deleted.boardActivity.at(-1).type, 'card-comment-delete')
  const missing = { scope:personal, operationId:'comment-missing', taskId:'a', expectedRevision:4, type:'card-comment-edit', value:{ commentId:'missing', text:'x' } }
  await assert.rejects(rt.boardCall('board-command', missing), /unknown card comment/)
  assert.equal((await rt.boardCall('board-operation', { scope:personal, operationId:'comment-missing' })).state, 'rejected')
  const badDue = { scope:personal, operationId:'bad-due', taskId:'a', expectedRevision:4, type:'card-details', value:{ dueDate:'2027-02-29' } }
  await assert.rejects(rt.boardCall('board-command', badDue), /invalid card details/)
  assert.equal((await rt.boardCall('board-operation', { scope:personal, operationId:'bad-due' })).state, 'rejected')
  const cross = { scope:personal, operationId:'cross-lane', taskId:'a', expectedRevision:4, type:'reorder', value:{ afterId:'b' } }
  await assert.rejects(rt.boardCall('board-command', cross), /same lane/)
  assert.equal((await rt.boardCall('board-operation', { scope:personal, operationId:'cross-lane' })).state, 'rejected')
})
test('a rejected stale edit has a durable outcome after a lost response and rejects changed payload reuse', async t => {
  const { rt } = fixture(t); await rt.boardCall('board-command', create)
  const edit = { scope, operationId:'reject-1', taskId:'t1', expectedRevision:3, type:'edit', value:create.value }
  await assert.rejects(rt.boardCall('board-command', edit), /revision conflict/)
  assert.deepEqual(await rt.boardCall('board-operation', { scope, operationId:'reject-1' }), { state:'rejected', message:'revision conflict' })
  await assert.rejects(rt.boardCall('board-command', edit), /revision conflict/)
  await assert.rejects(rt.boardCall('board-command', { ...edit, value:{ ...edit.value, title:'Changed' } }), /operation id conflict/)
  assert.equal((await rt.boardCall('board-list', { scope })).tasks[0].revision, 1)
})

test('deterministic image validation failure has a durable rejected receipt', async t => {
  const { rt, route, home } = fixture(t); await rt.boardCall('board-command', create)
  const invalid = { ...image, data:Buffer.from(image.data, 'base64').subarray(0,8).toString('base64') }
  const input = { scope, taskId:'t1', operationId:'invalid-image', expectedRevision:1, images:[invalid] }
  const first = await (await route.fetch(request(input))).json()
  assert.equal(first.ok, false); assert.match(first.error.message, /invalid/i)
  const receipt = await rt.boardCall('board-operation', { scope, operationId:'invalid-image' })
  assert.equal(receipt.state, 'rejected'); assert.match(receipt.message, /invalid/i)
  assert.equal((await (await route.fetch(request(input))).json()).ok, false)
  assert.equal(readdirSync(join(home, 'board-v1', 'images')).length, 0)
  const changed = { ...input, images:[image] }
  assert.equal((await (await route.fetch(request(changed))).json()).ok, false)
  assert.deepEqual(await rt.boardCall('board-operation', { scope, operationId:'invalid-image' }), receipt)
})

test('cancel tombstone wins over later deterministic image rejection', async t => {
  const { rt, route } = fixture(t); await rt.boardCall('board-command', create)
  await rt.boardCall('board-operation-cancel', { scope, operationId:'cancelled-invalid' })
  const invalid = { ...image, data:Buffer.from(image.data, 'base64').subarray(0,8).toString('base64') }
  const result = await (await route.fetch(request({ scope, taskId:'t1', operationId:'cancelled-invalid', expectedRevision:1, images:[invalid] }))).json()
  assert.equal(result.ok, false); assert.match(result.error.message, /cancelled/i)
  assert.match((await rt.boardCall('board-operation', { scope, operationId:'cancelled-invalid' })).message, /cancelled/i)
})

test('worker parse failure stays unknown and can be explicitly cancelled', async t => {
  const { rt, route } = fixture(t); await rt.boardCall('board-command', create)
  const req = new Request('http://localhost/api/bot-board-upload', { method:'POST', body:'{"endpoint":"board-upload","operationId":"worker-unknown",', duplex:'half' })
  assert.equal((await (await route.fetch(req)).json()).ok, false)
  assert.equal((await rt.boardCall('board-operation', { scope, operationId:'worker-unknown' })).state, 'unknown')
  assert.equal((await rt.boardCall('board-operation-cancel', { scope, operationId:'worker-unknown' })).state, 'rejected')
})

test('cancel-if-absent wins before late create; committed operation wins before cancel', async t => {
  const { rt } = fixture(t)
  const cancelled = await rt.boardCall('board-operation-cancel', { scope, operationId:create.operationId })
  assert.deepEqual(cancelled, { state:'rejected', message:'Request cancelled before commit' })
  await assert.rejects(rt.boardCall('board-command', create), /cancelled/)
  await assert.rejects(rt.boardCall('board-command', { ...create, value:{ ...create.value, title:'Other' } }), /cancelled/)
  assert.equal((await rt.boardCall('board-list', { scope })).tasks.length, 0)
  const later = { ...create, operationId:'committed-first' }
  await rt.boardCall('board-command', later)
  assert.equal((await rt.boardCall('board-operation-cancel', { scope, operationId:'committed-first' })).state, 'committed')
})

test('cancel while upload stream is active prevents any later image admission', async t => {
  const { rt, route, home } = fixture(t); await rt.boardCall('board-command', create)
  let controller
  const stream = new ReadableStream({ start(c) { controller = c } })
  const pending = route.fetch(new Request('http://localhost/api/bot-board-upload', { method:'POST', body:stream, duplex:'half' }))
  controller.enqueue(new TextEncoder().encode('{'))
  const cancel = await rt.boardCall('board-operation-cancel', { scope, operationId:'upload-late' })
  assert.equal(cancel.state, 'rejected')
  const body = JSON.stringify({ endpoint:'board-upload', payload:{ scope, taskId:'t1', operationId:'upload-late', expectedRevision:1, images:[image] } })
  controller.enqueue(new TextEncoder().encode(body.slice(1))); controller.close()
  assert.equal((await (await pending).json()).ok, false)
  assert.equal(readdirSync(join(home, 'board-v1', 'images')).length, 0)
  assert.equal((await rt.boardCall('board-operation', { scope, operationId:'upload-late' })).state, 'rejected')
})

test('streaming limit aborts an oversized request before image storage', async t => {
  const { route, home } = fixture(t)
  let sent = false
  const body = new ReadableStream({ pull(controller) { if (!sent) { sent = true; controller.enqueue(new Uint8Array(BOARD_UPLOAD_MAX_BYTES + 1)) } else controller.close() } })
  const result = await route.fetch(new Request('http://localhost/api/bot-board-upload', { method:'POST', body, duplex:'half' }))
  assert.equal(result.status, 413); assert.equal((await result.json()).ok, false)
  assert.equal(existsSync(join(home, 'board-v1')), false)
})

test('upload concurrency is bounded before reading bodies and an outstanding ID can be cancelled', async t => {
  const { rt, route, home } = fixture(t); await rt.boardCall('board-command', create)
  const bodies = [], aborts = [], pending = []
  for (let i = 0; i < 6; i += 1) {
    let controller; const stream = new ReadableStream({ start(value) { controller = value } })
    const abort = new AbortController(); bodies.push(controller); aborts.push(abort)
    pending.push(route.fetch(new Request('http://localhost/api/bot-board-upload', { method:'POST', body:stream, signal:abort.signal, duplex:'half' })))
  }
  await new Promise(resolve => setImmediate(resolve))
  const busy = await route.fetch(request({ scope, taskId:'t1', operationId:'overflow', expectedRevision:1, images:[image] }))
  assert.equal(busy.status, 429)
  assert.equal((await rt.boardCall('board-operation', { scope, operationId:'overflow' })).state, 'unknown')
  assert.equal((await rt.boardCall('board-operation-cancel', { scope, operationId:'late-stream' })).state, 'rejected')
  const body = JSON.stringify({ endpoint:'board-upload', payload:{ scope, taskId:'t1', operationId:'late-stream', expectedRevision:1, images:[image] } })
  bodies[0].enqueue(new TextEncoder().encode(body)); bodies[0].close()
  assert.equal((await (await pending[0]).json()).ok, false)
  for (let i = 1; i < bodies.length; i += 1) { aborts[i].abort(); try { bodies[i].error(new Error('client gone')) } catch {} }
  await Promise.allSettled(pending.slice(1))
  assert.equal(readdirSync(join(home, 'board-v1', 'images')).length, 0)
})

test('near-limit image batch is processed while event loop remains observable', async t => {
  const { rt, route } = fixture(t); await rt.boardCall('board-command', create)
  await rt.boardCall('board-command', { ...create, operationId:'create-2', taskId:'t2' })
  const raw = randomFillSync(Buffer.alloc(1022 * 1022 * 4))
  const png = pngjs.PNG.sync.write({ width:1022, height:1022, data:raw }, { deflateLevel:0 })
  const images = Array.from({ length:5 }, (_, i) => ({ uploadId:`big-${i}`, name:`big-${i}.png`, mediaType:'image/png', data:png.toString('base64') }))
  assert.ok(png.length * images.length > 20 * 1024 * 1024 * .99 && png.length * images.length <= 20 * 1024 * 1024)
  const req = request({ scope, taskId:'t1', operationId:'big-upload', expectedRevision:1, images })
  const req2 = request({ scope, taskId:'t2', operationId:'big-upload-2', expectedRevision:1, images })
  const samples = []; let previous = performance.now()
  const timer = setInterval(() => { const now = performance.now(); samples.push(now - previous - 10); previous = now }, 10)
  const started = performance.now(), rssBefore = process.memoryUsage().rss
  let resultsUpload
  try { resultsUpload = await Promise.all([route.fetch(req), route.fetch(req2)]) } finally { clearInterval(timer) }
  const elapsed = performance.now() - started, rssAfter = process.memoryUsage().rss
  for (const result of resultsUpload) assert.equal((await result.json()).ok, true)
  assert.ok(samples.length > 0)
  samples.sort((a, b) => a - b)
  console.log(`BOARD_PERF decoded_bytes=${png.length * images.length * 2} elapsed_ms=${elapsed.toFixed(1)} lag_p95_ms=${samples[Math.floor((samples.length - 1) * .95)].toFixed(1)} lag_max_ms=${samples.at(-1).toFixed(1)} rss_before=${rssBefore} rss_after=${rssAfter}`)
  const readSamples = []; let readPrevious = performance.now()
  const readTimer = setInterval(() => { const now = performance.now(); readSamples.push(now - readPrevious - 10); readPrevious = now }, 10)
  const readStarted = performance.now(), readRssBefore = process.memoryUsage().rss
  let results
  try { results = await Promise.all(images.map(async image => JSON.stringify(await rt.boardCall('board-image', { scope, taskId:'t1', imageId:image.uploadId })))) }
  finally { clearInterval(readTimer) }
  assert.equal(results.length, 5); assert.ok(readSamples.length > 0)
  readSamples.sort((a, b) => a - b)
  console.log(`BOARD_READ_PERF decoded_bytes=${png.length * images.length} elapsed_ms=${(performance.now()-readStarted).toFixed(1)} lag_p95_ms=${readSamples[Math.floor((readSamples.length-1)*.95)].toFixed(1)} lag_max_ms=${readSamples.at(-1).toFixed(1)} rss_before=${readRssBefore} rss_after=${process.memoryUsage().rss}`)
})

test('a concurrently removed image is not returned after the read worker finishes', async t => {
  const { rt, route } = fixture(t); await rt.boardCall('board-command', create)
  assert.equal((await (await route.fetch(request({ scope, taskId:'t1', operationId:'upload-one', expectedRevision:1, images:[image] }))).json()).ok, true)
  const pending = rt.boardCall('board-image', { scope, taskId:'t1', imageId:'img1' })
  await rt.boardCall('board-command', { scope, taskId:'t1', operationId:'remove-one', expectedRevision:2, type:'remove-image', value:{ imageId:'img1' } })
  await assert.rejects(pending, /unavailable|changed/)
})

test('full edit form cannot erase hidden dependencies', async t => {
  const { rt, home } = fixture(t), root = join(home, 'board-v1')
  rt.state.rooms.source = { members:['one','two'] }
  mkdirSync(root, { mode:0o700 }); mkdirSync(join(root,'images'), { mode:0o700 })
  const store = openTaskStore(join(root,'tasks.sqlite'), { assertWriteLock() {}, authorize() { return true }, verifyShare() { return true }, verifyDependency() { return true } })
  store.create({ operationId:'seed-private', actor:'user', task:{ id:'private', scope:'room:source', title:'Private', owner:'one', reviewer:'two', acceptance:'Check', dependencies:[] } })
  const shared = store.command({ operationId:'seed-share', taskId:'private', expectedRevision:1, actor:'user', type:'share', value:{targetRoomId:'group',fields:['status']} })
  store.create({ operationId:'seed-group', actor:'user', task:{ id:'t1', scope:'room:group', title:'Task', owner:'one', reviewer:'two', acceptance:'Check', dependencies:['private'], dependencyGrants:[{taskId:'private',grantId:shared.shares[0].id}] } })
  store.close()
  rt.state.rooms.source.members = ['two']
  const board = await rt.boardCall('board-list', { scope })
  assert.deepEqual(board.tasks[0].dependencies, [])
  await assert.rejects(rt.boardCall('board-command', { scope, operationId:'safe-edit', taskId:'t1', expectedRevision:1, type:'edit', value:{ title:'Renamed', owner:'one', reviewer:'two', acceptance:'Check', dependencies:[] } }), /Dependency grant is unavailable/)
  const reopened = openTaskStore(join(root,'tasks.sqlite'), { assertWriteLock() {} })
  assert.deepEqual(reopened.get('t1').dependencies, ['private']); reopened.close()
})

test('cross-group dependency binds active grant and revocation blocks dependent task', async t => {
  const { rt } = fixture(t); rt.state.rooms.other = { members:['one','two'] }
  await rt.boardCall('board-command', create)
  const shared = await rt.boardCall('board-command', { scope, taskId:'t1', operationId:'grant-dep', expectedRevision:1, type:'share', value:{ targetRoomId:'other', fields:['status'] } })
  const grant = shared.shares[0], target = { kind:'room', id:'other' }
  const child = await rt.boardCall('board-command', { scope:target, taskId:'child', operationId:'create-child', type:'create', value:{ title:'Child', owner:'one', reviewer:'two', acceptance:'Check', dependencies:['t1'] } })
  assert.deepEqual(child.dependencyGrants, [{ taskId:'t1', grantId:grant.id }])
  await rt.boardCall('board-command', { scope, taskId:'t1', operationId:'revoke-dep', expectedRevision:2, type:'unshare', value:{ shareId:grant.id } })
  const board = await rt.boardCall('board-list', { scope:target })
  assert.equal(board.tasks.length, 1); assert.match(board.tasks[0].blocked.reason, /revoked/)
  assert.deepEqual(board.tasks[0].dependencies, [])
})

test('existing goal tasks expose their original status and the goal-specific edit capability', async t => {
  const { rt } = fixture(t)
  rt.state.rooms.group.goal = { id:'goal', status:'active', current:0, revision:1, stages:[{ id:'s3', title:'Repair', acceptance:'Independent proof', tasks:[{ id:'t9', botId:'one', task:'Original work', status:'done' }] }] }
  const board = await rt.boardCall('board-list', { scope })
  const old = board.tasks.find(task => task.legacy?.taskId === 't9')
  assert.ok(old); assert.equal(old.status, 'legacy-done'); assert.ok(board.capabilities.commands[old.id].some(command=>command.type==='goal-task-edit'))
  await assert.rejects(rt.boardCall('board-command', { scope, taskId:old.id, operationId:'edit-legacy', expectedRevision:1, type:'edit', value:{} }))
})

function goalFixture(t) {
  const context=fixture(t), {rt,home}=context
  rt.statePath=join(home,'state.json')
  rt.homeLockVersion=()=>1
  rt.roomOf=id=>rt.state.rooms[id]
  rt.state.rooms.group.goal={id:'goal',title:'Goal',status:'active',current:0,revision:1,events:[],stages:[{id:'s1',title:'Repair',acceptance:'Independent review',tasks:[{id:'t1',botId:'one',task:'Original',status:'pending'}]}]}
  rt.save=async()=>{const tmp=join(home,'state.next');writeFileSync(tmp,JSON.stringify(rt.state));renameSync(tmp,rt.statePath)}
  writeFileSync(rt.statePath,JSON.stringify(rt.state))
  return context
}

test('human edits of a working goal item steer only the current live group turn once', async t => {
  const {rt,deliveries} = goalFixture(t)
  const room = rt.state.rooms.group
  room.goal.stages[0].tasks[0].status = 'working'
  const sessionId = await rt.ensureGroupTaskSession(room.id,'one')
  rt.live = new Map([['chat-one',{turn:'different-chat'}]])
  const card = (await rt.boardCall('board-list',{scope})).tasks.find(task => task.legacy)
  const edit = (operationId,value) => ({scope,taskId:card.id,type:'goal-task-edit',operationId,
    expectedRevision:room.goal.revision,value})
  const command = payload => rt.boardCall('board-command',payload)
  const sent = () => deliveries.filter(entry => entry.message?.source?.role === 'board-update')
  assert.equal((await command(edit('goal:idle',{title:'Durable even while idle'}))).state,'committed')
  assert.equal(room.goal.stages[0].tasks[0].task,'Durable even while idle')
  assert.equal(sent().length,0)
  rt.live.set(sessionId,{turn:'first-turn'})
  const latest = edit('goal:live',{title:'Use the corrected filter'})
  const results = await Promise.all([command(latest),command(latest)])
  assert.ok(results.some(result => result.state === 'committed'))
  assert.equal((await command(latest)).state,'committed')
  await settle(async () => sent().length > 0)
  assert.deepEqual(sent().map(entry => entry.sessionId),[sessionId])
  assert.equal(sent()[0].message.source.exchangeId,'board-edit:goal:live')
  assert.match(sent()[0].message.content[0].text,/group_goal show/)
  rt.ensureCapabilities = async () => { rt.live.set(sessionId,{turn:'replacement-turn'}) }
  assert.equal((await command(edit('goal:turn-race',{title:'Changed as the turn finished'}))).state,'committed')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(sent().length,1)
  rt.ensureCapabilities = async () => {}
  assert.equal((await command(edit('goal:already-reported',{status:'reported',note:'Initial checks complete'}))).state,'committed')
  await settle(async () => sent().length === 2)
  const read = (await rt.boardCall('board-list',{scope})).tasks.find(task => task.legacy)
  assert.equal((await command({scope,taskId:card.id,type:'goal-card-comment',operationId:'goal:reported-note',
    expectedRevision:read.revision,expectedBoardRevision:read.legacy.boardRevision,expectedPosition:read.legacy.position,value:{text:'Reviewing'}})).state,'committed')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(sent().length,2)
})

test('an uncertain human goal edit never replays a live-turn notification', async t => {
  const {rt,deliveries} = goalFixture(t)
  const room = rt.state.rooms.group
  room.goal.stages[0].tasks[0].status = 'working'
  const sessionId = await rt.ensureGroupTaskSession(room.id,'one')
  rt.live = new Map([[sessionId,{turn:'busy'}]])
  const card = (await rt.boardCall('board-list',{scope})).tasks.find(task => task.legacy)
  rt.save = async () => { throw new Error('uncertain save') }
  const payload = {scope,taskId:card.id,type:'goal-task-edit',operationId:'goal:uncertain-notice',
    expectedRevision:card.revision,value:{title:'New title'}}
  assert.equal((await rt.boardCall('board-command',payload)).state,'unknown')
  assert.equal((await rt.boardCall('board-command',payload)).state,'unknown')
  assert.equal(deliveries.length,0)
})

test('real image worker edits the original goal and preserves two authorized images across stage changes', async t => {
  const {rt,route}=goalFixture(t)
  const before=await rt.boardCall('board-list',{scope}), card=before.tasks.find(task=>task.legacy)
  const edit={scope,operationId:'goal:edit',taskId:card.id,expectedRevision:1,type:'goal-task-edit',value:{title:'Revised',status:'working',note:'Started'}}
  assert.equal((await rt.boardCall('board-command',edit)).state,'committed')
  assert.equal(rt.state.rooms.group.goal.stages[0].tasks[0].task,'Revised')
  assert.equal((await rt.boardCall('board-command',edit)).state,'committed')
  assert.equal(rt.state.rooms.group.goal.revision,2)
  const invalid={...edit,operationId:'goal:done',expectedRevision:2,value:{status:'done',note:'No review'}}
  assert.equal((await rt.boardCall('board-command',invalid)).state,'rejected')
  assert.equal(rt.state.rooms.group.goal.stages[0].tasks[0].status,'working')
  const stale={...edit,operationId:'goal:stale',value:{title:'Stale'}}
  assert.equal((await rt.boardCall('board-command',stale)).state,'rejected')
  const upload={scope,taskId:card.id,operationId:'goal:upload',expectedRevision:2,images:[image,image2]}
  assert.equal((await (await route.fetch(request(upload))).json()).ok,true)
  assert.equal((await (await route.fetch(request(upload))).json()).ok,true)
  assert.equal(rt.state.rooms.group.goal.revision,3)
  assert.equal((await rt.boardCall('board-image',{scope,taskId:card.id,imageId:'img1'})).data,image.data)
  const personal={kind:'personal',id:'one'}
  const personalCard=(await rt.boardCall('board-list',{scope:personal})).tasks.find(task=>task.id===card.id)
  assert.ok(personalCard,'the original group task is also visible on its owner’s board')
  const progress={scope:personal,operationId:'goal:personal-progress',taskId:card.id,expectedRevision:3,type:'goal-task-edit',value:{status:'reported',note:'Ready for review'}}
  assert.equal((await rt.boardCall('board-command',progress)).state,'committed')
  assert.equal(rt.state.rooms.group.goal.stages[0].tasks[0].status,'reported')
  assert.equal(rt.state.rooms.group.goal.revision,4)
  const details={scope:personal,operationId:'goal:details',taskId:card.id,expectedRevision:4,type:'goal-card-details',value:{description:'Read before review',dueDate:'2026-12-01',labels:['Design'],checklist:[{id:'check-1',text:'Inspect layout',checked:true}]}}
  assert.equal((await rt.boardCall('board-command',details)).state,'committed')
  assert.equal((await rt.boardCall('board-command',details)).state,'committed')
  const shown=(await rt.boardCall('board-list',{scope})).tasks.find(task=>task.id===card.id)
  assert.equal(shown.description,'Read before review')
  assert.deepEqual(shown.labels,['Design'])
  assert.equal(shown.checklist[0].checked,true)
  assert.equal(rt.state.rooms.group.goal.stages[0].tasks[0].status,'reported','checking items does not pass acceptance')
  assert.equal(rt.state.rooms.group.goal.revision,5)
  const comment={scope:personal,operationId:'goal:comment',taskId:card.id,expectedRevision:5,type:'goal-card-comment',value:{text:'Ready for the reviewer'}}
  assert.equal((await rt.boardCall('board-command',comment)).state,'committed')
  assert.equal((await rt.boardCall('board-command',comment)).state,'committed')
  const savedComments = (await rt.boardCall('board-list',{scope})).tasks.find(task=>task.id===card.id).comments
  assert.equal(savedComments.filter(comment=>!comment.workflowAction).length,1)
  assert.equal(savedComments.filter(comment=>comment.workflowAction==='goal-update').length,2)
  assert.equal(rt.state.rooms.group.goal.stages[0].tasks[0].status,'reported')
  const invalidDetails={...details,operationId:'goal:invalid-details',expectedRevision:6,value:{dueDate:'2026-02-30'}}
  assert.equal((await rt.boardCall('board-command',invalidDetails)).state,'rejected')
  assert.equal(rt.state.rooms.group.goal.revision,6)
  const goal=rt.state.rooms.group.goal
  goal.stages.push({id:'s2',title:'Next',tasks:[]});goal.current=1;goal.revision++
  await rt.save()
  const historical=(await rt.boardCall('board-list',{scope})).tasks.find(task=>task.id===card.id)
  assert.equal(historical.images.length,2)
  assert.equal((await rt.boardCall('board-image',{scope,taskId:card.id,imageId:'img2'})).data,image2.data)
  assert.equal((await rt.boardCall('board-list',{scope})).capabilities.commands[card.id].length,0)
  rt.state.rooms.group.pastGoals=[goal]
  rt.state.rooms.group.goal={id:'new-goal',status:'active',current:0,revision:1,events:[],stages:[{id:'new-stage',tasks:[]}]}
  await rt.save()
  const archived=(await rt.boardCall('board-list',{scope})).tasks.find(task=>task.id===card.id)
  assert.equal(archived.legacy.archived,true)
  assert.equal(archived.description,'Read before review')
  assert.equal(archived.comments.find(comment=>!comment.workflowAction && comment.author==='user').text,'Ready for the reviewer')
  assert.equal((await rt.boardCall('board-image',{scope,taskId:card.id,imageId:'img1'})).data,image.data)
  rt.state.rooms.group.members=[]
  await assert.rejects(rt.boardCall('board-image',{scope:{kind:'personal',id:'one'},taskId:card.id,imageId:'img1'}),/not available|unavailable/i)
  await assert.rejects(rt.boardCall('board-command',{...edit,operationId:'goal:bad-namespace',type:'edit'}),/Goal operation ID/)
})

test('native card comments are idempotent and excluded from shared status projections', async t => {
  const {rt}=fixture(t); rt.state.rooms.other={members:['one','two']}
  await rt.boardCall('board-command',create)
  const comment={scope,operationId:'comment-1',taskId:'t1',expectedRevision:1,type:'card-comment',value:{text:'Private review note'}}
  await rt.boardCall('board-command',comment)
  await rt.boardCall('board-command',comment)
  const shown=(await rt.boardCall('board-list',{scope})).tasks.find(task=>task.id==='t1')
  assert.equal(shown.comments.length,1)
  assert.equal(shown.comments[0].text,'Private review note')
  assert.equal(shown.status,'proposed')
  assert.equal(shown.boardActivity.at(-1).type,'card-comment')
  await rt.boardCall('board-command',{scope,operationId:'share-comment',taskId:'t1',expectedRevision:2,type:'share',value:{targetRoomId:'other',fields:['status']}})
  const shared=(await rt.boardCall('board-list',{scope:{kind:'room',id:'other'}})).tasks.find(task=>task.id==='t1')
  assert.equal(shared.shared,true)
  assert.equal(shared.comments,undefined)
  assert.equal(shared.boardActivity,undefined)
})

test('real upload confirms a snapshot written before the save response is lost', async t => {
  const {rt,route}=goalFixture(t), card=(await rt.boardCall('board-list',{scope})).tasks.find(task=>task.legacy)
  const save=rt.save
  rt.save=async()=>{await save();throw new Error('simulated lost save response')}
  const upload={scope,taskId:card.id,operationId:'goal:written-image',expectedRevision:1,images:[image]}
  assert.equal((await (await route.fetch(request(upload))).json()).ok,false)
  assert.equal((await rt.boardCall('board-operation',{scope,operationId:upload.operationId})).state,'committed')
  assert.equal((await rt.boardCall('board-image',{scope,taskId:card.id,imageId:'img1'})).data,image.data)
  assert.equal((await (await route.fetch(request(upload))).json()).ok,true)
  assert.equal(rt.state.rooms.group.goal.revision,2)
})

test('invalid image worker input records a rejected original goal upload without changing the task', async t => {
  const {rt,route,home}=goalFixture(t), card=(await rt.boardCall('board-list',{scope})).tasks.find(task=>task.legacy)
  const broken={...image,data:Buffer.from(image.data,'base64').subarray(0,8).toString('base64')}
  const upload={scope,taskId:card.id,operationId:'goal:invalid-image',expectedRevision:1,images:[broken]}
  assert.equal((await (await route.fetch(request(upload))).json()).ok,false)
  assert.equal((await rt.boardCall('board-operation',{scope,operationId:upload.operationId})).state,'rejected')
  assert.equal(rt.state.rooms.group.goal.revision,1)
  assert.equal(readdirSync(join(home,'board-v1','images')).length,0)
})

test('real upload cannot expose published files when goal snapshot save fails', async t => {
  const {rt,route,home}=goalFixture(t), card=(await rt.boardCall('board-list',{scope})).tasks.find(task=>task.legacy)
  rt.save=async()=>{throw new Error('simulated failure before state write')}
  const upload={scope,taskId:card.id,operationId:'goal:uncertain-image',expectedRevision:1,images:[image]}
  const result=await (await route.fetch(request(upload))).json()
  assert.equal(result.ok,false)
  assert.equal(readdirSync(join(home,'board-v1','images')).length,1,'actual worker published an immutable orphan')
  assert.equal((await rt.boardCall('board-operation',{scope,operationId:upload.operationId})).state,'unknown')
  await assert.rejects(rt.boardCall('board-image',{scope,taskId:card.id,imageId:'img1'}),/unavailable/i)
  assert.equal((await (await route.fetch(request(upload))).json()).ok,false)
})

test('explicit share exposes only approved fields, freezes title, and revocation hides it', async t => {
  const { rt } = fixture(t); rt.state.rooms.other = { members:['one','two'] }
  await rt.boardCall('board-command', create)
  const initial = await rt.boardCall('board-list', { scope })
  assert.equal(initial.capabilities.shareTargets.t1[0].id, 'other')
  assert.ok(initial.capabilities.commands.t1.some(command => command.type === 'share'))
  const share = await rt.boardCall('board-command', { scope, taskId:'t1', operationId:'share-1', expectedRevision:1, type:'share', value:{ targetRoomId:'other', fields:['status','title'] } })
  assert.ok((await rt.boardCall('board-list', { scope })).capabilities.commands.t1.some(command => command.type === 'unshare'))
  const target = { kind:'room', id:'other' }, shared = (await rt.boardCall('board-list', { scope:target })).tasks[0]
  assert.equal(shared.id, 't1'); assert.equal(shared.title, 'Task'); assert.equal(shared.shared, true)
  assert.equal(shared.owner, undefined); assert.equal(shared.originRoomId, undefined); assert.equal(shared.evidence, undefined); assert.equal(shared.images, undefined)
  assert.deepEqual((await rt.boardCall('board-list', { scope:target })).capabilities.commands.t1, [])
  await assert.rejects(rt.boardCall('board-command', { scope:target, taskId:'t1', operationId:'edit-shared', expectedRevision:2, type:'edit', value:create.value }), /not available/)
  await rt.boardCall('board-command', { scope, taskId:'t1', operationId:'edit-after-share', expectedRevision:2, type:'edit', value:{ ...create.value, title:'Private later title' } })
  assert.equal((await rt.boardCall('board-list', { scope:target })).tasks[0].title, 'Task')
  const grant = share.shares.find(item => !item.revoked)
  await rt.boardCall('board-command', { scope, taskId:'t1', operationId:'unshare-1', expectedRevision:3, type:'unshare', value:{ shareId:grant.id } })
  assert.equal((await rt.boardCall('board-list', { scope:target })).tasks.length, 0)
  const again = await rt.boardCall('board-list', { scope })
  assert.equal(again.capabilities.shareTargets.t1[0].id, 'other')
  assert.equal(again.capabilities.commands.t1.some(command => command.type === 'unshare'), false)
})

test('sharing rejects private bots and removes visibility when source membership changes', async t => {
  const { rt } = fixture(t); rt.state.rooms.other = { members:['one','two'] }
  await rt.boardCall('board-command', create); rt.state.bots.one.private = true
  const privateView = await rt.boardCall('board-list', { scope })
  assert.equal(privateView.capabilities.shareTargets.t1, undefined)
  assert.equal(privateView.capabilities.commands.t1.some(command => command.type === 'share'), false)
  await assert.rejects(rt.boardCall('board-command', { scope, taskId:'t1', operationId:'share-private', expectedRevision:1, type:'share', value:{ targetRoomId:'other', fields:['status'] } }), /share not authorized/)
  rt.state.bots.one.private = false
  await rt.boardCall('board-command', { scope, taskId:'t1', operationId:'share-safe', expectedRevision:1, type:'share', value:{ targetRoomId:'other', fields:['status'] } })
  assert.equal((await rt.boardCall('board-list', { scope:{ kind:'room', id:'other' } })).tasks.length, 1)
  rt.state.rooms.group.members = ['two']; rt.state.revision += 1
  assert.equal((await rt.boardCall('board-list', { scope:{ kind:'room', id:'other' } })).tasks.length, 0)
})

test('process death before the request commit leaves neither task nor rejection receipt', t => {
  const home = mkdtempSync(join(tmpdir(), 'dsbot-board-crash-')); t.after(() => rmSync(home, { recursive:true, force:true }))
  const path = join(home, 'tasks.sqlite')
  const child = spawnSync(process.execPath, [fileURLToPath(new URL('./board-crash-child.mjs', import.meta.url)), path], { encoding:'utf8' })
  assert.equal(child.signal, 'SIGKILL')
  const store = openTaskStore(path, { assertWriteLock() {} }); t.after(() => store.close())
  assert.equal(store.get('crash-task'), undefined); assert.equal(store.operation('crash-op'), undefined)
})

test('process death after cancel commit preserves its rejection tombstone', t => {
  const home = mkdtempSync(join(tmpdir(), 'dsbot-board-cancel-')); t.after(() => rmSync(home, { recursive:true, force:true }))
  const path = join(home, 'tasks.sqlite')
  const child = spawnSync(process.execPath, [fileURLToPath(new URL('./board-cancel-child.mjs', import.meta.url)), path], { encoding:'utf8' })
  assert.equal(child.signal, 'SIGKILL')
  const store = openTaskStore(path, { assertWriteLock() {}, authorize() { return true } }); t.after(() => store.close())
  assert.equal(store.operation('cancel-crash').status, 'rejected')
  assert.equal(store.cancelRequest({ operationId:'cancel-crash', actor:'user' }).state, 'rejected')
})

test('unknown version and missing schema are rejected without overwriting database', t => {
  const home = mkdtempSync(join(tmpdir(), 'dsbot-board-schema-')); t.after(() => rmSync(home, { recursive:true, force:true }))
  for (const [name, mutate, probe] of [
    ['old', db => db.exec('PRAGMA user_version=1'), db => db.prepare('PRAGMA user_version').get().user_version === 1],
    ['missing', db => db.exec('DROP TABLE history'), db => !db.prepare("SELECT 1 FROM sqlite_master WHERE name='history'").get()],
    ['trigger', db => db.exec('CREATE TRIGGER extra AFTER INSERT ON tasks BEGIN SELECT 1; END'), db => !!db.prepare("SELECT 1 FROM sqlite_master WHERE name='extra'").get()],
  ]) {
    const path = join(home, `${name}.sqlite`), store = openTaskStore(path, { assertWriteLock() {} }); store.close()
    const db = new DatabaseSync(path); mutate(db); db.close()
    assert.throws(() => openTaskStore(path, { assertWriteLock() {} }), /unknown or damaged/)
    const after = new DatabaseSync(path); assert.equal(probe(after), true); after.close()
  }
})

test('no private Bot is needed to block direct board path reads by a Bot', async () => {
  let hook
  const rt = { home:'/safe/bot', dshHome:'/safe', state:{ bots:{}, privateArchives:[] },
    ctx:{ on(name, fn) { if (name === 'tools/execute') hook = fn } },
    selfOf(id) { return id === 'bot-session' ? 'bot-id' : undefined }, sessionFolder() { return '/work' },
    async realBeyond(path) { return path }, botOf() {}, teamFolder() {}, defaultTeamFolder() { return '/work' },
  }
  installPrivacy(rt)
  const next = () => 'allowed'
  await assert.rejects(hook({ name:'read', agent:{ id:'bot-session' }, arguments:{ file_path:'/safe/bot/board-v1/tasks.sqlite' } }, next), /private/)
  await assert.rejects(hook({ name:'bash', agent:{ id:'bot-session' }, arguments:{ command:'cat ~/.dsh/bot/board-v1/tasks.sqlite' } }, next), /private/)
  assert.equal(await hook({ name:'read', agent:{ id:'instance-user' }, arguments:{ file_path:'/safe/bot/board-v1/tasks.sqlite' } }, next), 'allowed')
})

test('release endpoints create, order, assign, start and cancel a release', async t => {
  const { rt } = fixture(t)
  await rt.boardCall('board-command', create)
  const created = await rt.boardCall('board-release-create', { scope, operationId:'release-1', release:{ id:'r1', name:'Release one', version:'1.0.0' } })
  assert.equal(created.status, 'draft')
  const second = await rt.boardCall('board-release-create', { scope, operationId:'release-2', release:{ id:'r2', name:'Release two', version:'1.1.0' } })
  assert.ok(created.position < second.position)
  let board = await rt.boardCall('board-list', { scope })
  const release = board.releases.find(item => item.id === 'r1'), task = board.tasks.find(item => item.id === 't1')
  const assigned = await rt.boardCall('board-release-assign', { scope, operationId:'assign-1', releaseId:'r1', expectedReleaseRevision:release.revision, taskId:'t1', expectedTaskRevision:task.revision })
  assert.equal(assigned.releaseId, 'r1')
  const queued = await rt.boardCall('board-release-queue', { scope, operationId:'queue-2', releaseId:'r2', expectedRevision:second.revision })
  assert.equal(queued.status, 'queued')
  const cancelled = await rt.boardCall('board-release-cancel', { scope, operationId:'cancel-2', releaseId:'r2', expectedRevision:queued.revision })
  assert.equal(cancelled.status, 'cancelled')
  board = await rt.boardCall('board-list', { scope })
  const running = await rt.boardCall('board-release-start', { scope, operationId:'start-1', releaseId:'r1', expectedRevision:board.releases.find(item => item.id === 'r1').revision })
  assert.equal(running.status, 'running')
  board = await rt.boardCall('board-list', { scope })
  assert.equal(board.tasks.find(item => item.id === 't1').status, 'ready')
  assert.equal(board.releases.find(item => item.id === 'r1').status, 'running')
})

test('the board_task tool creates a user-confirmed proposal that the board applies', async t => {
  const { rt } = fixture(t)
  await rt.boardCall('board-command', create)
  await rt.boardCall('board-command', { scope, operationId:'schedule-1', taskId:'t1', expectedRevision:1, type:'schedule' })
  const before = (await rt.boardCall('board-list', { scope })).tasks.find(item => item.id === 't1')
  const tool = rt.teamTools.find(definition => definition.name === 'board_task')
  assert.ok(tool, 'board_task tool is registered')
  const result = JSON.parse(await tool.execute({ action:'propose', task_id:'t1', expected_revision:before.revision, operation_id:'p1',
    change:{ kind:'update', value:{ description:'Bot proposal' } }, note:'Please confirm' }, { agent:{ id:'chat-one' }, callId:'c1' }))
  assert.equal(result.proposal.status, 'pending')
  assert.equal(result.proposal.taskId, 't1')
  const pending = await rt.boardCall('board-proposal-list', { scope })
  assert.equal(pending.length, 1)
  assert.equal(pending[0].after.description, 'Bot proposal')
  const decided = await rt.boardCall('board-proposal-decide', { scope, operationId:'decide-p1', proposalId:pending[0].id, expectedRevision:pending[0].revision, decision:'confirm' })
  assert.equal(decided.proposal.status, 'confirmed')
  const after = (await rt.boardCall('board-list', { scope })).tasks.find(item => item.id === 't1')
  assert.equal(after.description, 'Bot proposal')
  assert.equal(after.revision > before.revision, true)
})

test('the board_task tool proposes a new card and confirmation creates it', async t => {
  const { rt } = fixture(t)
  const personalScope = { kind:'personal', id:'one' }
  const tool = rt.teamTools.find(definition => definition.name === 'board_task')
  assert.ok(tool, 'board_task tool is registered')
  const result = JSON.parse(await tool.execute({ action:'propose', operation_id:'new-card-1',
    change:{ kind:'create', value:{ title:'Bot-created requirement', owner:'one', reviewer:'two', acceptance:'Independent proof', type:'requirement', description:'Proposed from a Bot' } },
    note:'Please create this card' }, { agent:{ id:'chat-one' }, callId:'c-create' }))
  assert.equal(result.proposal.kind, 'create')
  assert.equal(result.proposal.status, 'pending')
  assert.match(result.proposal.taskId, /^card-/)
  const pending = await rt.boardCall('board-proposal-list', { scope: personalScope })
  assert.equal(pending.length, 1)
  assert.equal(pending[0].after.title, 'Bot-created requirement')
  assert.equal(pending[0].taskTitle, 'Bot-created requirement')
  const decided = await rt.boardCall('board-proposal-decide', { scope: personalScope, operationId:'decide-new-card', proposalId:pending[0].id, expectedRevision:pending[0].revision, decision:'confirm' })
  assert.equal(decided.proposal.status, 'confirmed')
  const created = (await rt.boardCall('board-list', { scope: personalScope })).tasks.find(item => item.id === result.proposal.taskId)
  assert.equal(created.title, 'Bot-created requirement')
  assert.equal(created.type, 'requirement')
  assert.equal(created.status, 'proposed')
})

function addReleaseMembers(rt, bots) {
  Object.assign(rt.state.bots, bots)
  rt.state.rooms.group.members.push(...Object.keys(bots))
}

test('a user explicitly configures a draft release team in its original group exactly once', async t => {
  const { rt, deliveries } = fixture(t)
  const roles = { projectManager:'pm', productManager:'product', architect:'arch', frontend:'fe', backend:'be', tester:'test', reviewer:'two', ops:'ops' }
  const labels = { pm:'项目经理', product:'产品经理', arch:'架构师', fe:'前端开发', be:'后端开发', test:'测试工程师', ops:'运维工程师' }
  addReleaseMembers(rt, Object.fromEntries(Object.entries(labels).map(([id, name]) => [id, { id, name, role:'成员' }])))
  const create = id => rt.boardCall('board-release-create', { scope, operationId:'create-'+id, release:{ id, name:id, version:'1.1' } })
  const draft = await create('draft')
  const board = () => rt.boardCall('board-list', { scope })
  const before = await board()
  assert.equal(before.releases[0].canConfigureTeam,true)
  assert.equal(before.releaseCandidates.projectManager[0].id, 'pm')
  assert.equal(before.releaseCandidates.reviewer.length, 0)
  const request = { scope, operationId:'set-team', releaseId:draft.id, expectedRevision:draft.revision, team:{projectManagerId:'pm', roles} }
  const configure = (changes = {}) => rt.boardCall('board-release-configure-team', { ...request, ...changes })

  await assert.rejects(configure({ operationId:'stale-version', expectedRevision:42 }), /revision conflict/)
  const partial = { ...roles }; delete partial.reviewer
  await assert.rejects(configure({ operationId:'missing-reviewer', team:{roles:partial} }), /Missing release roles.*Independent Reviewer/)
  await assert.rejects(configure({ operationId:'same-reviewer', team:{roles:{...roles, reviewer:'pm'}} }), /independent reviewer/)
  await assert.rejects(configure({ operationId:'missing-bot', team:{roles:{...roles, reviewer:'missing'}} }), /available Bot/)
  addReleaseMembers(rt, { privateActor:{ name:'Private Bot', private:true } })
  await assert.rejects(configure({ operationId:'private-bot', team:{roles:{...roles, reviewer:'privateActor'}} }), /available Bot/)
  rt.state.bots.outside = { id:'outside', name:'Outside' }
  await assert.rejects(configure({ operationId:'outside-bot', team:{roles:{...roles, reviewer:'outside'}} }), /available Bot/)
  rt.state.rooms.other = {id:'other', name:'Other', members:Object.values(roles), sessions:{}}
  await assert.rejects(configure({ operationId:'outside-room', scope:{kind:'room',id:'other'} }), /in this group/)
  await assert.rejects(configure({ operationId:'personal-scope', scope:{kind:'personal',id:'user'} }), /needs a group board/)

  const invalid = await rt.boardCall('board-operation', {scope, operationId:'missing-reviewer'})
  assert.equal(invalid.state, 'rejected')
  assert.match(invalid.message, /Missing release roles/)
  const cancelled = await rt.boardCall('board-operation-cancel', {scope, operationId:'cancel-late'})
  assert.equal(cancelled.state, 'rejected')
  await assert.rejects(configure({operationId:'cancel-late'}), /cancelled before commit/)
  assert.deepEqual(await rt.boardCall('board-operation', {scope, operationId:'cancel-late'}), cancelled)
  assert.equal((await board()).releases[0].canConfigureTeam, true)

  const competing = await Promise.allSettled([configure(), configure({operationId:'competing'})])
  const [winner] = competing.filter(result => result.status === 'fulfilled')
  assert.equal(competing.filter(result => result.status === 'rejected').length, 1)
  assert.equal(winner.value.status, 'draft')
  assert.equal(winner.value.revision, draft.revision + 1)
  assert.deepEqual(winner.value.roles, roles)
  const confirmedId = competing[0].status === 'fulfilled' ? 'set-team' : 'competing'
  const configured = await configure({operationId:confirmedId})
  assert.deepEqual(configured, winner.value)
  assert.equal((await rt.boardCall('board-operation', {scope,operationId:confirmedId})).state, 'committed')
  await assert.rejects(configure({operationId:confirmedId, team:{roles:{ ...roles, reviewer:'one' }}}), /operation id conflict/)
  await assert.rejects(configure({operationId:'replace-configured', expectedRevision:configured.revision}), /unconfigured draft/)
  const after = await board()
  assert.equal(after.releases[0].canConfigureTeam, false)
  assert.deepEqual(after.tasks, before.tasks)
  assert.equal(deliveries.length, 0)

  const second = await create('queued')
  const queued = await rt.boardCall('board-release-queue', { scope, releaseId:second.id, expectedRevision:second.revision, operationId:'queue-later' })
  assert.equal((await board()).releases.find(r=>r.id===queued.id).canConfigureTeam, false)
  await assert.rejects(configure({releaseId:queued.id,expectedRevision:queued.revision,operationId:'too-late'}), /unconfigured draft/)
})

test('minor releases reuse their board group and preserve the membership and admin', async t => {
  const { rt } = fixture(t)
  const roles = {
    pm:{ name:'PM', role:'Project Manager' }, product:{ name:'Product', role:'Product Manager' },
    arch:{ name:'Architect', role:'Architect' }, fe:{ name:'Frontend', role:'Frontend Developer' },
    be:{ name:'Backend', role:'Backend Developer' }, test:{ name:'Tester', role:'Test Engineer' },
    review:{ name:'Reviewer', role:'Independent Reviewer' }, ops:{ name:'Ops', role:'Operations Engineer' },
  }
  addReleaseMembers(rt, roles)
  const team = { projectManagerId:'pm', roles:Object.fromEntries(Object.keys(roles).map(id => [id === 'pm' ? 'projectManager' : id === 'product' ? 'productManager' : id === 'arch' ? 'architect' : id === 'fe' ? 'frontend' : id === 'be' ? 'backend' : id === 'test' ? 'tester' : id === 'review' ? 'reviewer' : 'ops', id])) }
  rt.state.rooms.group.admin = 'one'
  const request = { scope, operationId:'release-team', team, release:{ id:'r-team', name:'Student grades', version:'1.0.0' } }
  const release = await rt.boardCall('board-release-create', request)
  assert.deepEqual(await rt.boardCall('board-release-create', request), release)
  const second = await rt.boardCall('board-release-create', { ...request, operationId:'release-team-2', release:{ ...request.release, id:'r-next', version:'1.1.0' } })
  assert.equal(release.groupId, 'group')
  assert.equal(second.groupId, 'group')
  assert.deepEqual(Object.keys(rt.state.rooms), ['group'])
  assert.equal(release.projectManagerId, 'pm')
  assert.equal(release.roles.tester, 'test')
  assert.equal(rt.state.rooms.group.admin, 'one')
  rt.state.bots.outsider = { name:'Outsider' }
  await assert.rejects(rt.boardCall('board-release-create', { ...request, operationId:'outsider', release:{ ...request.release, id:'r-bad' },
    team:{ ...team, roles:{ ...team.roles, ops:'outsider' } } }), /not an available Bot/)
  assert.equal(rt.state.rooms.group.members.includes('outsider'), false)
  assert.equal(release.gates.docs.status, 'pending')
})

test('release gates and checks fail a release when an item is cancelled', async t => {
  const { rt } = fixture(t)
  await rt.boardCall('board-command', create)
  const release = await rt.boardCall('board-release-create', { scope, operationId:'gate-release', release:{ id:'r-gate', name:'Gate release', version:'2.0.0' } })
  let board = await rt.boardCall('board-list', { scope })
  const task = board.tasks.find(item => item.id === 't1')
  await rt.boardCall('board-release-assign', { scope, operationId:'gate-assign', releaseId:release.id, expectedReleaseRevision:release.revision, taskId:'t1', expectedTaskRevision:task.revision })
  const gate = await rt.boardCall('board-release-gate', { scope, operationId:'gate-docs', releaseId:release.id, expectedRevision:release.revision, gate:'docs', status:'passed', evidence:'README and API docs reviewed' })
  assert.equal(gate.gates.docs.status, 'passed')
  board = await rt.boardCall('board-list', { scope })
  const currentTask = board.tasks.find(item => item.id === 't1')
  await rt.boardCall('board-command', { scope, operationId:'gate-cancel-task', taskId:'t1', expectedRevision:currentTask.revision, type:'cancel', value:{ reason:'scope changed' } })
  board = await rt.boardCall('board-list', { scope })
  const started = await rt.boardCall('board-release-start', { scope, operationId:'gate-start', releaseId:release.id, expectedRevision:board.releases.find(item => item.id === release.id).revision })
  assert.equal(started.status, 'running')
  board = await rt.boardCall('board-list', { scope })
  const failed = await rt.boardCall('board-release-check', { scope, operationId:'gate-check', releaseId:release.id, expectedRevision:board.releases.find(item => item.id === release.id).revision })
  assert.equal(failed.status, 'failed')
  assert.match(failed.failure, /cancelled/i)
})

test('a board edit on a release item is delivered to the release project manager', async t => {
  const { rt, deliveries } = fixture(t)
  const roles = { pm:{ name:'PM', role:'Project Manager' }, product:{ name:'Product', role:'Product Manager' }, arch:{ name:'Architect', role:'Architect' }, fe:{ name:'Frontend', role:'Frontend Developer' }, be:{ name:'Backend', role:'Backend Developer' }, test:{ name:'Tester', role:'Test Engineer' }, review:{ name:'Reviewer', role:'Independent Reviewer' }, ops:{ name:'Ops', role:'Operations Engineer' } }
  addReleaseMembers(rt, roles)
  const team = { projectManagerId:'pm', roles:{ projectManager:'pm', productManager:'product', architect:'arch', frontend:'fe', backend:'be', tester:'test', reviewer:'review', ops:'ops' } }
  const release = await rt.boardCall('board-release-create', { scope, operationId:'sync-release', team, release:{ id:'r-sync', name:'Sync', version:'1.0.0' } })
  await rt.boardCall('board-command', create)
  let board = await rt.boardCall('board-list', { scope })
  const task = board.tasks.find(item => item.id === 't1')
  await rt.boardCall('board-release-assign', { scope, operationId:'sync-assign', releaseId:release.id, expectedReleaseRevision:release.revision, taskId:'t1', expectedTaskRevision:task.revision })
  board = await rt.boardCall('board-list', { scope })
  const current = board.tasks.find(item => item.id === 't1')
  await rt.boardCall('board-command', { scope, operationId:'sync-edit', taskId:'t1', expectedRevision:current.revision, type:'card-details', value:{ description:'Changed from the board' } })
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.ok(deliveries.some(entry => entry.sessionId === 'chat-pm' && /Board change/.test(entry.message?.content?.[0]?.text ?? '')))
  const before = deliveries.filter(entry => entry.sessionId === 'chat-pm').length
  rt.state.rooms.group.members = rt.state.rooms.group.members.filter(id => id !== 'pm')
  const latest = (await rt.boardCall('board-list', { scope })).tasks.find(item => item.id === 't1')
  await rt.boardCall('board-command', { scope, operationId:'sync-removed', taskId:'t1', expectedRevision:latest.revision,
    type:'card-details', value:{ description:'Visible to current group members' } })
  assert.equal(deliveries.filter(entry => entry.sessionId === 'chat-pm').length, before)

})

test('comments, attachments and release membership changes on a release item reach the project manager', async t => {
  const { rt, deliveries, route } = fixture(t)
  const roles = { pm:{ name:'PM', role:'Project Manager' }, product:{ name:'Product', role:'Product Manager' }, arch:{ name:'Architect', role:'Architect' }, fe:{ name:'Frontend', role:'Frontend Developer' }, be:{ name:'Backend', role:'Backend Developer' }, test:{ name:'Tester', role:'Test Engineer' }, review:{ name:'Reviewer', role:'Independent Reviewer' }, ops:{ name:'Ops', role:'Operations Engineer' } }
  addReleaseMembers(rt, roles)
  const team = { projectManagerId:'pm', roles:{ projectManager:'pm', productManager:'product', architect:'arch', frontend:'fe', backend:'be', tester:'test', reviewer:'review', ops:'ops' } }
  const release = await rt.boardCall('board-release-create', { scope, operationId:'sync-content-release', team, release:{ id:'r-content', name:'Content sync', version:'1.0.0' } })
  await rt.boardCall('board-command', create)
  let board = await rt.boardCall('board-list', { scope })
  const task = board.tasks.find(item => item.id === 't1')
  const texts = () => deliveries.filter(entry => entry.sessionId === 'chat-pm').map(entry => entry.message?.content?.[0]?.text ?? '')
  await rt.boardCall('board-release-assign', { scope, operationId:'sync-content-assign', releaseId:release.id, expectedReleaseRevision:release.revision, taskId:'t1', expectedTaskRevision:task.revision })
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.ok(texts().some(text => /Board change/.test(text) && /release-assign/.test(text)), 'assigning a card to the release reaches the PM')
  board = await rt.boardCall('board-list', { scope })
  const listed = board.tasks.find(item => item.id === 't1')
  await rt.boardCall('board-command', { scope, operationId:'sync-content-comment', taskId:'t1', expectedRevision:listed.revision, type:'card-comment', value:{ text:'Check the export before review.' } })
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.ok(texts().some(text => /card-comment/.test(text) && /Check the export before review\./.test(text)), 'a new comment reaches the PM')
  board = await rt.boardCall('board-list', { scope })
  const uploading = board.tasks.find(item => item.id === 't1')
  const upload = { scope, taskId:'t1', operationId:'sync-content-upload', expectedRevision:uploading.revision, images:[image] }
  assert.equal((await (await route.fetch(request(upload))).json()).ok, true)
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.ok(texts().some(text => /attach/.test(text)), 'adding an attachment reaches the PM')
  board = await rt.boardCall('board-list', { scope })
  const removing = board.tasks.find(item => item.id === 't1')
  const currentRelease = board.releases.find(item => item.id === release.id)
  await rt.boardCall('board-release-remove', { scope, operationId:'sync-content-remove', releaseId:release.id, expectedReleaseRevision:currentRelease.revision, taskId:'t1', expectedTaskRevision:removing.revision })
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.ok(texts().some(text => /release-remove/.test(text)), 'removing a card from the release reaches the PM')
})

test('a confirmed board proposal on a release item reaches the project manager', async t => {
  const { rt, deliveries } = fixture(t)
  const roles = { pm:{ name:'PM', role:'Project Manager' }, product:{ name:'Product', role:'Product Manager' }, arch:{ name:'Architect', role:'Architect' }, fe:{ name:'Frontend', role:'Frontend Developer' }, be:{ name:'Backend', role:'Backend Developer' }, test:{ name:'Tester', role:'Test Engineer' }, review:{ name:'Reviewer', role:'Independent Reviewer' }, ops:{ name:'Ops', role:'Operations Engineer' } }
  addReleaseMembers(rt, roles)
  const team = { projectManagerId:'pm', roles:{ projectManager:'pm', productManager:'product', architect:'arch', frontend:'fe', backend:'be', tester:'test', reviewer:'review', ops:'ops' } }
  const release = await rt.boardCall('board-release-create', { scope, operationId:'sync-proposal-release', team, release:{ id:'r-proposal', name:'Proposal sync', version:'1.0.0' } })
  await rt.boardCall('board-command', create)
  let board = await rt.boardCall('board-list', { scope })
  const task = board.tasks.find(item => item.id === 't1')
  await rt.boardCall('board-release-assign', { scope, operationId:'sync-proposal-assign', releaseId:release.id, expectedReleaseRevision:release.revision, taskId:'t1', expectedTaskRevision:task.revision })
  await new Promise(resolve => setTimeout(resolve, 50))
  board = await rt.boardCall('board-list', { scope })
  const before = board.tasks.find(item => item.id === 't1')
  const tool = rt.teamTools.find(definition => definition.name === 'board_task')
  assert.ok(tool, 'board_task tool is registered')
  const result = JSON.parse(await tool.execute({ action:'propose', task_id:'t1', expected_revision:before.revision, operation_id:'sync-proposal',
    change:{ kind:'update', value:{ description:'Bot proposal' } }, note:'Please confirm' }, { agent:{ id:'chat-one' }, callId:'c-sync' }))
  assert.equal(result.proposal.status, 'pending')
  const pending = await rt.boardCall('board-proposal-list', { scope })
  const proposal = pending.find(item => item.taskId === 't1')
  assert.ok(proposal)
  await rt.boardCall('board-proposal-decide', { scope, operationId:'sync-proposal-decide', proposalId:proposal.id, expectedRevision:proposal.revision, decision:'confirm' })
  await new Promise(resolve => setTimeout(resolve, 50))
  const texts = deliveries.filter(entry => entry.sessionId === 'chat-pm').map(entry => entry.message?.content?.[0]?.text ?? '')
  assert.ok(texts.some(text => /Board change/.test(text) && /proposal-confirm/.test(text)), 'a confirmed Bot proposal reaches the PM')
})

test('a release lifecycle plan creates a typed dependency chain assigned to the release', async t => {
  const { rt } = fixture(t)
  const bots = { pm:{ name:'PM', role:'Project Manager' }, product:{ name:'Product', role:'Product Manager' }, arch:{ name:'Architect', role:'Architect' }, ui:{ name:'UI', role:'UI Designer' }, ux:{ name:'UX', role:'UX Designer' }, fe:{ name:'Frontend', role:'Frontend Developer' }, be:{ name:'Backend', role:'Backend Developer' }, test:{ name:'Tester', role:'Test Engineer' }, review:{ name:'Reviewer', role:'Independent Reviewer' }, ops:{ name:'Ops', role:'Operations Engineer' } }
  addReleaseMembers(rt, bots)
  const roles = { projectManager:'pm', productManager:'product', architect:'arch', uiDesigner:'ui', uxDesigner:'ux', frontend:'fe', backend:'be', tester:'test', reviewer:'review', ops:'ops' }
  const release = await rt.boardCall('board-release-create', { scope, operationId:'plan-release', team:{ projectManagerId:'pm', roles }, release:{ id:'r-plan', name:'Student grades', version:'1.0.0' } })
  const beforePlan = await rt.boardCall('board-list', { scope })
  assert.deepEqual(Object.fromEntries(beforePlan.capabilities.actors.map(actor => [actor.id, true])), { user:true, one:true, two:true, pm:true, product:true, arch:true, ui:true, ux:true, fe:true, be:true, test:true, review:true, ops:true }, JSON.stringify({ room:rt.state.rooms.group.members, roles }))
  const planned = await rt.boardCall('board-release-plan', { scope, releaseId:release.id, requirement:'Build a student grade management system' })
  assert.ok(planned.tasks.length >= 9)
  const board = await rt.boardCall('board-list', { scope })
  const items = board.tasks.filter(task => task.id === planned.cardId || task.parentTaskId === planned.cardId)
  const card = items.find(task => task.id === planned.cardId)
  assert.equal(card.type, 'feature')
  assert.equal(card.releaseId, release.id)
  assert.equal(items.length, planned.tasks.length)
  assert.deepEqual(await rt.boardCall('board-release-plan', { scope, releaseId:release.id, operationId:'retry-plan', requirement:'Build a student grade management system' }), planned)
  await assert.rejects(rt.boardCall('board-release-plan', { scope, releaseId:release.id, operationId:'retry-plan', requirement:'Another requirement' }), /operation id conflict/)
  assert.ok(items.every(task => task.status === 'proposed' && task.owner && task.reviewer && task.type))
  assert.equal(board.releases.find(item => item.id === release.id).itemCount, 1)
  const requirement = items.find(task => task.title.startsWith('Requirement'))
  const design = items.find(task => task.title.startsWith('Technical'))
  assert.ok(design.dependencies.includes(requirement.id))
  const idFor = key => planned.tasks.find(task => task.key === key).taskId
  for (const key of ['backend', 'frontend']) assert.ok(items.find(task => task.id === idFor(key)).dependencies.includes(idFor('test-plan')))
  assert.deepEqual(card.dependencies, [idFor('operations')])
  const bugfix = await rt.boardCall('board-release-plan', { scope, releaseId:release.id, requirement:'Correct the GPA rounding', cardType:'bugfix' })
  const updated = await rt.boardCall('board-list', { scope })
  assert.equal(updated.tasks.find(task => task.id === bugfix.cardId).type, 'bugfix')
  assert.equal(updated.releases.find(item => item.id === release.id).itemCount, 2)

})

test('replaying a legacy flat plan preserves the original cards and coordination group', async t => {
  const { rt, home } = fixture(t)
  const bots = { pm:{}, product:{}, arch:{}, fe:{}, be:{}, test:{}, review:{}, ops:{} }
  addReleaseMembers(rt, bots)
  rt.state.rooms.old = { id:'old', name:'Old release group', admin:'pm', members:Object.keys(bots) }
  const roles = { projectManager:'pm', productManager:'product', architect:'arch', frontend:'fe', backend:'be', tester:'test', reviewer:'review', ops:'ops' }
  await rt.boardCall('board-list', { scope })
  const store = openTaskStore(join(home, 'board-v1', 'tasks.sqlite'), { assertWriteLock() {}, authorize() { return true } })
  const release = { id:'old-release', name:'Historical', version:'1.0', scope:'room:group', groupId:'old', projectManagerId:'pm', roles }
  const steps = ['requirement','design','test-plan','backend','frontend','test-run','review','deploy','operations','summary']
  try {
    store.createRelease({ operationId:'old-create', actor:'user', release })
    for (const key of steps) {
      const taskId = `earlier-old-release-${key}`
      const card = store.create({ operationId:`earlier:old-release:${key}`, actor:'user', task:{
        id:taskId, scope:'room:group', title:key, type:'other', owner:'one', reviewer:'two',
        acceptance:'review result', dependencies:[], description:'Release requirement: Historical work' } })
      store.assignRelease({ operationId:`earlier-assign:old-release:${key}`, actor:'user', releaseId:release.id,
        expectedReleaseRevision:1, taskId, expectedTaskRevision:card.revision })
    }
  } finally { store.close() }
  const replay = await rt.boardCall('board-release-create', { scope, operationId:'old-create',
    team:{ projectManagerId:'pm', roles }, release:{ id:release.id, name:release.name, version:release.version } })
  assert.equal(replay.groupId, 'old')
  const plan = await rt.boardCall('board-release-plan', { scope, releaseId:release.id, requirement:'Historical work' })
  assert.deepEqual(plan.tasks.map(task => task.key), steps)
  const board = await rt.boardCall('board-list', { scope })
  assert.equal(board.tasks.length, steps.length)
  assert.ok(board.tasks.every(task => task.releaseId === release.id && !task.parentTaskId))
})

test('a failed release plan rolls back its parent and all previously created items', async t => {
  const { rt } = fixture(t)
  const bots = { pm:{}, product:{}, arch:{}, fe:{}, be:{}, test:{}, review:{}, ops:{} }
  addReleaseMembers(rt, bots)
  const roles = { projectManager:'pm', productManager:'product', architect:'arch', frontend:'fe', backend:'be', tester:'test', reviewer:'review', ops:'ops' }
  await rt.boardCall('board-release-create', { scope, operationId:'atomic-create', team:{ roles },
    release:{ id:'atomic', name:'Team release', version:'1.1' } })
  rt.state.rooms.group.members = rt.state.rooms.group.members.filter(id => id !== 'ops')
  const request = { scope, releaseId:'atomic', requirement:'Deliver this change', operationId:'atomic-plan' }
  await assert.rejects(rt.boardCall('board-release-plan', request), /participant/)
  assert.deepEqual((await rt.boardCall('board-list', { scope })).tasks, [])
  rt.state.rooms.group.members.push('ops')
  const planned = await rt.boardCall('board-release-plan', request)
  assert.equal(planned.tasks.length, 10)
  await assert.rejects(rt.boardCall('board-release-plan', { ...request, operationId:'reclassify', cardType:'bugfix' }), /operation id conflict/)
})

test('only the release project manager may import a lifecycle plan', async t => {
  const { rt } = fixture(t)
  const selfOf = rt.selfOf
  rt.selfOf = id => id === 'chat-pm' ? 'pm' : selfOf(id)
  const roles = { pm:{ name:'PM', role:'Project Manager' }, product:{ name:'Product', role:'Product Manager' }, arch:{ name:'Architect', role:'Architect' }, fe:{ name:'Frontend', role:'Frontend Developer' }, be:{ name:'Backend', role:'Backend Developer' }, test:{ name:'Tester', role:'Test Engineer' }, review:{ name:'Reviewer', role:'Independent Reviewer' }, ops:{ name:'Ops', role:'Operations Engineer' } }
  addReleaseMembers(rt, roles)
  const team = { projectManagerId:'pm', roles:{ projectManager:'pm', productManager:'product', architect:'arch', frontend:'fe', backend:'be', tester:'test', reviewer:'review', ops:'ops' } }
  const release = await rt.boardCall('board-release-create', { scope, operationId:'plan-permission', team, release:{ id:'r-permission', name:'Permission', version:'1.0.0' } })
  const tool = rt.teamTools.find(definition => definition.name === 'board_task')
  await assert.rejects(tool.execute({ action:'plan', release_id:release.id, requirement:'Build it', operation_id:'plan-not-pm' },
    { agent:{ id:'chat-two' }, callId:'c-plan-denied' }), /project manager/)
  const planned = JSON.parse(await tool.execute({ action:'plan', release_id:release.id, requirement:'Build it', operation_id:'plan-by-pm' },
    { agent:{ id:'chat-pm' }, callId:'c-plan-pm' }))
  assert.ok(planned.plan.tasks.length >= 9)
  await assert.rejects(rt.boardPlanRelease({ caller:{ actor:'pm', roomId:'another-group' }, releaseId:release.id, requirement:'Build it' }), /unavailable/)
  rt.state.rooms.group.members = rt.state.rooms.group.members.filter(id => id !== 'pm')
  await assert.rejects(rt.boardPlanRelease({ caller:{ actor:'pm' }, releaseId:release.id, requirement:'Build it' }), /unavailable/)
})

const settle = async (fn, timeout = 5000) => {
  const deadline = Date.now() + timeout
  for (;;) {
    const value = await fn().catch(() => undefined)
    if (value) return value
    if (Date.now() > deadline) throw new Error('timed out waiting for the board')
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

test('confirming a Bot proposal rechecks that the proposing Bot still holds its role', async t => {
  const { rt } = fixture(t)
  await rt.boardCall('board-command', create)
  const tool = rt.teamTools.find(definition => definition.name === 'board_task')
  const task = (await rt.boardCall('board-list', { scope })).tasks.find(item => item.id === 't1')
  const proposed = JSON.parse(await tool.execute({ action:'propose', task_id:'t1', expected_revision:task.revision, operation_id:'role-check',
    change:{ kind:'update', value:{ description:'Proposed while a member' } }, note:'Role check' }, { agent:{ id:'chat-one' }, callId:'c-role' }))
  const proposal = (await rt.boardCall('board-proposal-list', { scope })).find(item => item.id === proposed.proposal.id)
  assert.ok(proposal)
  const decide = (operationId) => rt.boardCall('board-proposal-decide', { scope, operationId, proposalId:proposal.id, expectedRevision:proposal.revision, decision:'confirm' })
  rt.state.rooms.group.members = ['two']
  await assert.rejects(decide('role-check-removed'), /no longer authorized/)
  rt.state.rooms.group.members = ['one', 'two']
  rt.state.bots.one.private = true
  await assert.rejects(decide('role-check-private'), /no longer authorized/)
  rt.state.bots.one.private = false
  const confirmed = await decide('role-check-confirmed')
  assert.equal(confirmed.proposal.status, 'confirmed')
  assert.equal((await rt.boardCall('board-list', { scope })).tasks.find(item => item.id === 't1').description, 'Proposed while a member')
})

test('confirming a new-card proposal rechecks that the proposing Bot can still see the board', async t => {
  const { rt } = fixture(t)
  rt.groupOwners.set('group-one', { roomId:'group', botId:'one' })
  const tool = rt.teamTools.find(definition => definition.name === 'board_task')
  const proposed = JSON.parse(await tool.execute({ action:'propose', operation_id:'create-role-check',
    change:{ kind:'create', value:{ title:'Bot card', owner:'one', reviewer:'two', acceptance:'Independent proof' } }, note:'Add this card' }, { agent:{ id:'group-one' }, callId:'c-create-role' }))
  const proposal = (await rt.boardCall('board-proposal-list', { scope })).find(item => item.id === proposed.proposal.id)
  assert.ok(proposal)
  assert.equal(proposal.scope, 'room:group')
  const decide = (operationId) => rt.boardCall('board-proposal-decide', { scope, operationId, proposalId:proposal.id, expectedRevision:proposal.revision, decision:'confirm' })
  rt.state.rooms.group.members = ['two']
  await assert.rejects(decide('create-role-removed'), /no longer authorized/)
  rt.state.rooms.group.members = ['one', 'two']
  const confirmed = await decide('create-role-confirmed')
  assert.equal(confirmed.proposal.status, 'confirmed')
  assert.equal((await rt.boardCall('board-list', { scope })).tasks.find(item => item.id === proposed.proposal.taskId).title, 'Bot card')
})

test('an archived card is not offered for scheduling and cannot be scheduled', async t => {
  const { rt } = fixture(t)
  await rt.boardCall('board-command', create)
  let board = await rt.boardCall('board-list', { scope })
  const task = board.tasks.find(item => item.id === 't1')
  assert.ok((board.capabilities.commands.t1 ?? []).some(command => command.type === 'schedule'), 'a waiting Bot card offers Schedule first')
  const archived = await rt.boardCall('board-command', { scope, operationId:'archive-before-schedule', taskId:'t1', expectedRevision:task.revision, type:'archive' })
  assert.ok(archived.archivedAt)
  board = await rt.boardCall('board-list', { scope })
  assert.equal((board.capabilities.commands.t1 ?? []).some(command => command.type === 'schedule'), false, 'the archive view does not offer Schedule')
  await assert.rejects(rt.boardCall('board-command', { scope, operationId:'archive-schedule', taskId:'t1', expectedRevision:archived.revision, type:'schedule' }), /not schedulable/)
})

test('a release published by its last review still writes the report and tells the project manager', async t => {
  process.env.DS_BOT_RELEASE_MONITOR_MS = '1000'
  t.after(() => { delete process.env.DS_BOT_RELEASE_MONITOR_MS })
  const { rt, deliveries } = fixture(t)
  const roles = { pm:{ name:'PM', role:'Project Manager' }, product:{ name:'Product', role:'Product Manager' }, arch:{ name:'Architect', role:'Architect' }, fe:{ name:'Frontend', role:'Frontend Developer' }, be:{ name:'Backend', role:'Backend Developer' }, test:{ name:'Tester', role:'Test Engineer' }, review:{ name:'Reviewer', role:'Independent Reviewer' }, ops:{ name:'Ops', role:'Operations Engineer' } }
  addReleaseMembers(rt, roles)
  const team = { projectManagerId:'pm', roles:{ projectManager:'pm', productManager:'product', architect:'arch', frontend:'fe', backend:'be', tester:'test', reviewer:'review', ops:'ops' } }
  const release = await rt.boardCall('board-release-create', { scope, operationId:'auto-release', team, release:{ id:'r-auto', name:'Auto release', version:'2.0.0' } })
  await rt.boardCall('board-command', create)
  let board = await rt.boardCall('board-list', { scope })
  const task = board.tasks.find(item => item.id === 't1')
  await rt.boardCall('board-release-assign', { scope, operationId:'auto-assign', releaseId:release.id, expectedReleaseRevision:release.revision, taskId:'t1', expectedTaskRevision:task.revision })
  for (const [gate, evidence] of [['docs','README'], ['artifacts','build.zip'], ['environment','health 200'], ['summary','meeting done']]) {
    const current = (await rt.boardCall('board-list', { scope })).releases.find(item => item.id === release.id)
    await rt.boardCall('board-release-gate', { scope, operationId:`auto-gate-${gate}`, releaseId:release.id, expectedRevision:current.revision, gate, status:'passed', evidence })
  }
  const ready = (await rt.boardCall('board-list', { scope })).releases.find(item => item.id === release.id)
  await rt.boardCall('board-release-start', { scope, operationId:'auto-start-release', releaseId:release.id, expectedRevision:ready.revision })
  const tool = rt.teamTools.find(definition => definition.name === 'board_task')
  const dispatched = () => settle(async () => {
    const list = await rt.boardCall('board-list', { scope })
    const item = list.tasks.find(entry => entry.id === 't1')
    return item && item.dispatchState === 'accepted' ? item : undefined
  })
  let current = await dispatched()
  current = JSON.parse(await tool.execute({ action:'start', task_id:'t1', operation_id:'auto-start-work', expected_revision:current.revision },
    { agent:{ id:'chat-one' }, callId:'c-auto-start' })).task
  const working = (await rt.boardCall('board-list', { scope })).tasks.find(entry => entry.id === 't1')
  const changeTask = await rt.boardCall('board-command', { scope, operationId:'auto-active-edit', taskId:'t1', expectedRevision:working.revision,
    type:'card-details', value:{ description:'Edited while the card is being worked' } })
  assert.match(changeTask.id, /^change-/, 'editing active work creates a change-request task')
  await new Promise(resolve => setTimeout(resolve, 50))
  const changeNotes = deliveries.filter(entry => entry.sessionId === 'chat-pm').map(entry => entry.message?.content?.[0]?.text ?? '')
  assert.ok(changeNotes.some(text => /change-request/.test(text) && text.includes(changeTask.id)), 'the PM hears that a change request was created, not that the source card changed')
  current = JSON.parse(await tool.execute({ action:'report', task_id:'t1', operation_id:'auto-report', expected_revision:current.revision,
    value:{ kind:'personal', evidence:'Delivered the card', environment:'test' } }, { agent:{ id:'chat-one' }, callId:'c-auto-report' })).task
  current = await settle(async () => {
    const list = await rt.boardCall('board-list', { scope })
    const item = list.tasks.find(entry => entry.id === 't1')
    return item && item.status === 'reported' && item.dispatchState === 'accepted' ? item : undefined
  })
  await tool.execute({ action:'review', task_id:'t1', operation_id:'auto-review', expected_revision:current.revision,
    value:{ evidence:'Accepted', result:'pass' } }, { agent:{ id:'chat-two' }, callId:'c-auto-review' })
  assert.equal((await rt.boardCall('board-list', { scope })).tasks.find(entry => entry.id === 't1').status, 'done')
  const published = await settle(async () => {
    const list = await rt.boardCall('board-list', { scope })
    const item = list.releases.find(entry => entry.id === release.id)
    return item?.status === 'published' && item.report ? item : undefined
  }, 8000)
  assert.ok(published.report.markdownPath)
  assert.equal(existsSync(published.report.markdownPath), true)
  const report = await rt.boardCall('board-release-report', { scope, releaseId:release.id })
  assert.match(report.markdown, /Auto release/)
  const texts = deliveries.filter(entry => entry.sessionId === 'chat-pm').map(entry => entry.message?.content?.[0]?.text ?? '')
  assert.ok(texts.some(text => /已发布/.test(text) && /summary\.md/.test(text)), 'the report notification reaches the release project manager')
})

test('a chat instruction becomes a scoped board card, with child work, human steering and independent replies', async t => {
  const {rt, deliveries} = fixture(t)
  const tool = rt.teamTools.find(tool => tool.name === 'board_task')
  const call = async (sid, args) => JSON.parse(await tool.execute(args, {agent:{id:sid}}))
  const register = {action:'register', room_id:'group', operation_id:'intake-feature', task_id:'feature-123',
    change:{value:{title:'Improve project search', type:'feature', owner:'one', reviewer:'two', acceptance:'A query returns a result'}}}
  const missingFields = {action:'register', task_id:register.task_id, change:register.change}
  await assert.rejects(call('chat-one', missingFields), /register requires room_id for a private chat, a stable operation_id/)
  await assert.rejects(call('chat-one', {...missingFields, room_id:'group'}), /register requires a stable operation_id/)
  await assert.rejects(call('chat-one', {...missingFields, room_id:'unknown'}), /not authorized/)
  assert.deepEqual((await call('chat-one', {action:'list', room_id:'group', query:register.task_id})).items, [])
  await assert.rejects(call('chat-one', {...register,room_id:'unknown'}))
  const card = (await call('chat-one', register)).task
  assert.equal(card.scope, 'room:group')
  assert.equal((await call('chat-one', register)).task.id, card.id)
  const item = (await call('chat-one',{...register,operation_id:'intake-item',task_id:'search-lookup',parent_task_id:card.id,
    change:{value:{...register.change.value,type:'development',title:'Implement lookup'}}})).task
  const list = await call('chat-two', {action:'list',room_id:'group',parent_task_id:card.id})
  assert.deepEqual(list.items.map(row => [row.kind,row.id]), [['item',item.id]])
  await assert.rejects(call('chat-two', {action:'start',task_id:item.id,operation_id:'wrong-owner',expected_revision:item.revision}))
  const start = {action:'start',task_id:item.id,operation_id:'start-lookup',expected_revision:item.revision}
  const working = (await call('chat-one', start)).task
  assert.equal((await call('chat-one', start)).task.revision, working.revision)
  rt.live = new Map([['chat-one',{turn:'existing-chat-turn'}]])
  const edit = {scope,type:'card-comment',taskId:item.id,operationId:'user-comment',expectedRevision:working.revision,value:{text:'Include an empty query'}}
  await rt.boardCall('board-command', edit)
  await rt.boardCall('board-command', edit)
  await settle(async () => deliveries.some(entry => entry.sessionId === 'chat-one' && JSON.stringify(entry.message).includes('Human board update')))
  assert.equal(deliveries.filter(entry => JSON.stringify(entry.message).includes('Human board update')).length, 1)
  const show = async () => (await call('chat-one',{action:'show',task_id:item.id})).task
  const steering = deliveries.find(entry => entry.sessionId === 'chat-one' && entry.message?.source?.role === 'board-update')
  assert.ok(steering)
  rt.live.clear()
  const idleEdit = {...edit,operationId:'idle-comment',expectedRevision:(await show()).revision,value:{text:'Remember the empty result UI'}}
  await rt.boardCall('board-command', idleEdit)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(deliveries.filter(entry => entry.message?.source?.role === 'board-update').length,1)
  const current = await show()
  assert.ok(current.replies.some(reply => reply.text === edit.value.text))
  assert.ok(current.replies.some(reply => reply.text === idleEdit.value.text))
  const progress = {action:'progress',task_id:item.id,operation_id:'lookup-progress',expected_revision:working.revision,value:{summary:'Lookup implemented',next:'Check empty query'}}
  const incomplete = {action:'progress',task_id:item.id,expected_revision:current.revision,value:progress.value}
  await assert.rejects(call('chat-one',incomplete), /progress requires a stable operation_id/)
  await assert.rejects(call('chat-two',incomplete), /unavailable or the action is not authorized/)
  await assert.rejects(call('chat-one',{...incomplete,task_id:'does-not-exist'}), /unavailable or the action is not authorized/)
  await assert.rejects(call('chat-one',progress), /revision/)
  const advanced = (await call('chat-one',{...progress,expected_revision:current.revision})).task
  const report = (await call('chat-one',{action:'report',task_id:item.id,operation_id:'lookup-result',expected_revision:advanced.revision,
    value:{kind:'personal',environment:'fixture',evidence:'Lookup and empty query pass in the fixture'}})).task
  assert.equal(report.status,'reported')
  const reviewed = (await call('chat-two',{action:'review',task_id:item.id,operation_id:'lookup-review',expected_revision:report.revision,
    value:{result:'pass',evidence:'Independently checked both queries'}})).task
  assert.equal(reviewed.status,'done')
  assert.deepEqual(reviewed.replies.filter(reply=>reply.workflowAction).map(reply=>reply.workflowAction), ['start','progress','report','review'])
  assert.deepEqual((await call('chat-one',{action:'list',room_id:'group',query:'search-lookup'})).items.map(row=>row.id), [item.id])
  const release = await rt.boardCall('board-release-create', {scope,operationId:'create-minor',release:{id:'minor',name:'Search',version:'1.1'}})
  await rt.boardCall('board-release-assign',{scope,operationId:'assign-feature',releaseId:release.id,expectedReleaseRevision:release.revision,
    taskId:card.id,expectedTaskRevision:card.revision})
  assert.equal((await show()).releaseId,release.id)

})

test('organizing a goal item keeps the original editable task and its actual state under one feature', async t => {
  const {rt} = fixture(t)
  const room = rt.state.rooms.group
  room.goal = {id:'g',revision:3,status:'active',current:0,stages:[{id:'s',title:'Verify',acceptance:'Two reviewers',tasks:[{id:'check',botId:'two',task:'Check release',status:'reported'}]}]}
  const row = (await rt.boardCall('board-list',{scope})).tasks.find(row=>row.legacy)
  const parent = await rt.boardCall('board-command',{...create,value:{...create.value,type:'feature'}})
  const attach = {scope,type:'link-goal-items',taskId:parent.id,operationId:'link-g',expectedRevision:parent.revision,value:{itemIds:[row.id]}}
  await rt.boardCall('board-command',attach)
  await rt.boardCall('board-command',attach)
  const rows = (await rt.boardCall('board-list',{scope})).tasks.filter(t=>t.id===row.id)
  assert.deepEqual(rows.map(r=>[r.parentTaskId,r.legacy.originalStatus]), [[parent.id,'reported']])
  const tool = rt.teamTools.find(tool=>tool.name==='board_task')
  const query = async args => JSON.parse(await tool.execute(args, {agent:{id:'chat-one'}}))
  const {itemsQuery} = await query({action:'show',task_id:parent.id})
  const list = () => query(itemsQuery)
  const goal = await query({action:'show',task_id:row.id,room_id:'group'})
  assert.equal(goal.task.roomId, 'group')
  assert.equal(goal.itemsQuery, undefined)
  assert.deepEqual((await list()).items.map(r=>[r.kind,r.goalTaskId,r.parentTaskId,r.status]), [['group_goal','check',parent.id,'reported']])
  const release = await rt.boardCall('board-release-create',{scope,operationId:'create-minor',release:{id:'minor',name:'Verify release',version:'1.1'}})
  const latestParent = (await rt.boardCall('board-list',{scope})).tasks.find(task=>task.id===parent.id)
  await rt.boardCall('board-release-assign',{scope,operationId:'assign',taskId:parent.id,expectedTaskRevision:latestParent.revision,releaseId:release.id,expectedReleaseRevision:release.revision})
  const asOwner = async args => JSON.parse(await tool.execute({room_id:'group',...args},{agent:{id:'chat-two'}}))
  const ownGoal = await asOwner({action:'list',kind:'group_goal',mine:true,release_id:release.id})
  assert.deepEqual(ownGoal.items.map(task=>[task.id,task.releaseId]), [[row.id,release.id]])
  assert.equal((await asOwner({action:'show',task_id:row.id})).task.releaseId, release.id)
  room.goal.stages[0].tasks[0].status='done'
  room.goal.revision++
  assert.equal((await list()).items[0].status,'done')
  assert.equal((await asOwner({action:'list',kind:'group_goal',release_id:release.id})).items[0].status,'done')
  const other = await rt.boardCall('board-command',{...create,operationId:'new-feature',taskId:'other',value:{...create.value,type:'bugfix'}})
  await assert.rejects(rt.boardCall('board-command',{...attach,taskId:other.id,expectedRevision:other.revision,operationId:'link-twice'}), /already belongs/)
})

test('the assigned Bot replies on the original goal item, with a replayable receipt and independent status', async t => {
  const {rt} = goalFixture(t)
  const board = rt.teamTools.find(tool => tool.name === 'board_task')
  const run = async (args, who='one') => JSON.parse(await board.execute({room_id:'group',...args},{agent:{id:'chat-'+who}}))
  const row = (await run({action:'list'})).items[0]
  const show = () => run({action:'show',task_id:row.id})
  const item = (await show()).task
  const reply = {action:'reply',task_id:row.id,expected_revision:item.revision,expected_board_revision:item.legacy.boardRevision,operation_id:'work-ack',note:'Checking the deployment evidence.'}
  await assert.rejects(run(reply,'two'), /authorized/)
  assert.equal((await run(reply)).state, 'committed')
  assert.equal((await run(reply)).state, 'committed')
  assert.equal((await run({action:'operation',task_id:row.id,operation_id:reply.operation_id})).state,'committed')
  const current = (await show()).task
  assert.deepEqual(current.replies.map(r => [r.author,r.text]), [['one',reply.note]])
  assert.equal(current.status,'pending')
  assert.equal((await run({...reply,operation_id:'new-result',note:'Ready for review.'})).state,'rejected')
  rt.goalDispatchBlocked = () => true
  assert.equal((await run({...reply,operation_id:'paused-update',expected_board_revision:current.legacy.boardRevision})).state,'rejected')
})

test('an unclaimed item stays editable in Draft until a human assigns its owner and reviewer', async t => {
  const {rt} = fixture(t)
  const command = payload => rt.boardCall('board-command',{scope,...payload})
  const parent = await command({...create,value:{...create.value,type:'feature'}})
  const body = {title:'Legacy proof',type:'test',parentTaskId:parent.id,draft:true,owner:null,reviewer:null,dependencies:[]}
  const item = await command({operationId:'import',taskId:'proof',type:'create',value:body})
  assert.deepEqual([item.owner,item.reviewer,item.status], [null,null,'draft'])
  const blocked = {type:'submit',operationId:'too-early',taskId:item.id,expectedRevision:item.revision}
  await assert.rejects(command(blocked), /invalid state/)
  const edit = {type:'edit',taskId:item.id,expectedRevision:item.revision,operationId:'assign',value:{title:'Follow up on evidence',acceptance:'Inspect the comparison',dependencies:[],owner:'one',reviewer:'two'}}
  const assigned = await command(edit)
  assert.deepEqual([assigned.owner,assigned.reviewer,assigned.status,assigned.authority],['one','two','draft',null])
  assert.equal((await command({...blocked,operationId:'submit-assigned',expectedRevision:assigned.revision})).status,'proposed')
})

test('organizing existing items moves their original records atomically inside one release', async t => {
  const {rt} = goalFixture(t)
  const board = async () => (await rt.boardCall('board-list',{scope})).tasks
  const row = async id => (await board()).find(task => task.id === id)
  const call = payload => rt.boardCall('board-command',{scope,...payload})
  const make = (id,value) => call({...create,taskId:id,operationId:'make-'+id,value:{...create.value,type:'feature',draft:true,...value}})
  const source = await make('source',{}), target = await make('target',{type:'bugfix'})
  const item = await make('item',{parentTaskId:source.id,type:'test',owner:null,reviewer:null})
  const orig = (await board()).find(x => x.legacy)
  const bind = await call({taskId:source.id,type:'link-goal-items',expectedRevision:source.revision,operationId:'first-link',value:{itemIds:[orig.id]}})
  const move = {taskId:item.id,type:'move-item',expectedRevision:item.revision,operationId:'reparent',value:{parentTaskId:target.id}}
  await call(move); await call(move)
  assert.deepEqual([(await row(item.id)).parentTaskId,(await row(item.id)).owner,(await row(item.id)).status],[target.id,null,'draft'])
  const goalMove = {taskId:source.id,type:'move-goal-item',expectedRevision:bind.revision,operationId:'goal-move',value:{itemId:orig.id,parentTaskId:target.id}}
  await call(goalMove); await call(goalMove)
  const goal = await row(orig.id)
  assert.deepEqual([goal.parentTaskId,goal.revision,goal.owner,goal.legacy.originalStatus],[target.id,orig.revision,orig.owner,orig.legacy.originalStatus])
  assert.equal((await board()).filter(x => x.id === orig.id).length,1)
  const rel = await rt.boardCall('board-release-create',{scope,operationId:'release-move',release:{id:'rel',name:'Candidate',version:'1.1'}})
  await rt.boardCall('board-release-assign',{scope,operationId:'assign-source',taskId:source.id,expectedTaskRevision:(await row(source.id)).revision,releaseId:rel.id,expectedReleaseRevision:rel.revision})
  await assert.rejects(call({...move,operationId:'no-cross-release',expectedRevision:(await row(item.id)).revision,value:{parentTaskId:source.id}}),/cannot move/)
  assert.equal((await row(item.id)).parentTaskId,target.id)
})

test('human goal comments remain available when the task has many workflow replies', async t => {
  const {rt} = goalFixture(t)
  const task = rt.state.rooms.group.goal.stages[0].tasks[0]
  task.goalBoardReplies = Array.from({length:100},(_,i)=>({id:`reply-${i}`,at:i+1,author:'one',workflowAction:'goal-update',text:'Working'}))
  const card=(await rt.boardCall('board-list',{scope})).tasks.find(row=>row.legacy)
  const payload={scope,operationId:'goal:human-after-work',taskId:card.id,expectedRevision:card.revision,expectedBoardRevision:card.legacy.boardRevision,expectedPosition:'current',type:'goal-card-comment',value:{text:'Human feedback'}}
  assert.equal((await rt.boardCall('board-command',payload)).state,'committed')
  const comments=(await rt.boardCall('board-list',{scope})).tasks.find(row=>row.id===card.id).comments
  assert.equal(comments.length,101)
  assert.equal(comments.filter(comment=>comment.author==='user').length,1)
})
