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
import { install as installPrivacy } from '../../src/host/privacy.js'
import { openTaskStore } from '../../src/host/task-store.mjs'
import { userRedoIdentity } from '../../src/host/user-redo-journal.mjs'

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'dsbot-board-host-'))
  const effects = [], routes = [], drains = []
  const rt = {
    home, teamTools: [], state: { revision: 1, rooms: { group: { members: ['one','two'] } }, bots: { one: { name:'One' }, two: { name:'Two' } } },
    ctx: { effect(fn) { const dispose = fn(); effects.push(dispose) }, connection: { fetch: { register(route) { routes.push(route); return () => {} } } } },
    onHomeDrain(fn) { drains.push(fn) }, async load() {}, readOnly() {}, requireHomeLock() {}, warn(...args) { console.log(...args) },
  }
  install(rt)
  t.after(async () => { for (const dispose of effects.reverse()) await dispose?.(); for (const drain of drains) await drain(); rmSync(home, { recursive: true, force: true }) })
  return { rt, route: routes.find(route => route.path === BOARD_UPLOAD_PATH), home }
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
  assert.deepEqual(seen, [scope])
  await assert.rejects(rt.boardCall('board-list', { scope:{ kind:'room', id:'unknown' } }), /available/)
  assert.equal(seen.length, 1, 'invalid scope must not reach recovery projection')
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
  assert.equal(rt.state.rooms.group.goal.revision,2)
  assert.equal((await rt.boardCall('board-image',{scope,taskId:card.id,imageId:'img1'})).data,image.data)
  const personal={kind:'personal',id:'one'}
  const personalCard=(await rt.boardCall('board-list',{scope:personal})).tasks.find(task=>task.id===card.id)
  assert.ok(personalCard,'the original group task is also visible on its owner’s board')
  const progress={scope:personal,operationId:'goal:personal-progress',taskId:card.id,expectedRevision:2,expectedBoardRevision:personalCard.legacy.boardRevision,expectedPosition:'current',type:'goal-task-edit',value:{status:'reported',note:'Ready for review'}}
  assert.equal((await rt.boardCall('board-command',progress)).state,'committed')
  assert.equal(rt.state.rooms.group.goal.stages[0].tasks[0].status,'reported')
  assert.equal(rt.state.rooms.group.goal.revision,3)
  const details={scope:personal,operationId:'goal:details',taskId:card.id,expectedRevision:3,expectedBoardRevision:personalCard.legacy.boardRevision,expectedPosition:'current',type:'goal-card-details',value:{description:'Read before review',dueDate:'2026-12-01',labels:['Design'],checklist:[{id:'check-1',text:'Inspect layout',checked:true}]}}
  assert.equal((await rt.boardCall('board-command',details)).state,'committed')
  assert.equal((await rt.boardCall('board-command',details)).state,'committed')
  const shown=(await rt.boardCall('board-list',{scope})).tasks.find(task=>task.id===card.id)
  assert.equal(shown.description,'Read before review')
  assert.deepEqual(shown.labels,['Design'])
  assert.equal(shown.checklist[0].checked,true)
  assert.equal(rt.state.rooms.group.goal.stages[0].tasks[0].status,'reported','checking items does not pass acceptance')
  assert.equal(rt.state.rooms.group.goal.revision,3)
  const comment={scope:personal,operationId:'goal:comment',taskId:card.id,expectedRevision:3,expectedBoardRevision:shown.legacy.boardRevision,expectedPosition:'current',type:'goal-card-comment',value:{text:'Ready for the reviewer'}}
  assert.equal((await rt.boardCall('board-command',comment)).state,'committed')
  assert.equal((await rt.boardCall('board-command',comment)).state,'committed')
  assert.equal((await rt.boardCall('board-list',{scope})).tasks.find(task=>task.id===card.id).comments.length,1)
  assert.equal(rt.state.rooms.group.goal.stages[0].tasks[0].status,'reported')
  const invalidDetails={...details,operationId:'goal:invalid-details',expectedRevision:3,expectedBoardRevision:shown.legacy.boardRevision+1,value:{dueDate:'2026-02-30'}}
  assert.equal((await rt.boardCall('board-command',invalidDetails)).state,'rejected')
  assert.equal(rt.state.rooms.group.goal.revision,3)
  const goal=rt.state.rooms.group.goal
  goal.stages.push({id:'s2',title:'Next',tasks:[]});goal.current=1;goal.revision++
  await rt.save()
  const historical=(await rt.boardCall('board-list',{scope})).tasks.find(task=>task.id===card.id)
  assert.equal(historical.images.length,2)
  assert.equal((await rt.boardCall('board-image',{scope,taskId:card.id,imageId:'img2'})).data,image2.data)
  assert.ok((await rt.boardCall('board-list',{scope})).capabilities.commands[card.id].some(command=>command.type==='goal-card-details'))
  rt.state.rooms.group.pastGoals=[goal]
  rt.state.rooms.group.goal={id:'new-goal',status:'active',current:0,revision:1,events:[],stages:[{id:'new-stage',tasks:[]}]}
  await rt.save()
  const archived=(await rt.boardCall('board-list',{scope})).tasks.find(task=>task.id===card.id)
  assert.equal(archived.legacy.archived,true)
  assert.equal(archived.description,'Read before review')
  assert.equal(archived.comments[0].text,'Ready for the reviewer')
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
  const invalid={...comment,operationId:'comment-invalid',expectedRevision:2,value:{text:'x'.repeat(2049)}}
  await assert.rejects(rt.boardCall('board-command',invalid),/invalid card comment/i)
  assert.equal((await rt.boardCall('board-operation',{scope,operationId:invalid.operationId})).state,'rejected')
  assert.equal((await rt.boardCall('board-list',{scope})).tasks.find(task=>task.id==='t1').comments.length,1)
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
  assert.equal(rt.state.rooms.group.goal.revision,1)
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
