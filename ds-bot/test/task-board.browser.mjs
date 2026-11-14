import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

const dsbot = createRequire(new URL('../package.json', import.meta.url))
const harness = process.env.DSH_HARNESS
if (!harness) throw new Error('Set DSH_HARNESS to a DeepSeek Harness checkout')
const web = createRequire(join(harness, 'apps/web/package.json'))
const boardEntry = fileURLToPath(new URL('../src/client/task-board.js', import.meta.url))
const { build } = dsbot('esbuild')
const { chromium } = web('playwright')
const react = join(dirname(web.resolve('react')), 'umd/react.development.js')
const reactDom = join(dirname(web.resolve('react-dom')), 'umd/react-dom.development.js')

const shim = {
  name: 'board-fixture',
  setup(b) {
    b.onResolve({ filter: /^(react|react-dom|\.\/api\.js|\.\/i18n\.js)$/ }, x => ({ path: x.path, namespace: 'fixture' }))
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, x => {
      if (x.path === 'react') return { contents: 'export const {createElement,useEffect,useRef,useState}=globalThis.React' }
      if (x.path === 'react-dom') return { contents: 'export const {createPortal,flushSync}=globalThis.ReactDOM' }
      if (x.path.endsWith('i18n.js')) return { contents: 'export const hostText=x=>x;export const t=(x,v={})=>x.replace(/\\{(\\w+)\\}/g,(_,k)=>String(v[k]??""))' }
      return { contents: 'export const call=()=>{throw Error("request injection required")}' }
    })
  },
}

const entry = `
import { TaskBoard, TASK_BOARD_CSS } from ${JSON.stringify(boardEntry)};
const h=React.createElement;
const keyListeners=new Set();
const add=window.addEventListener.bind(window), remove=window.removeEventListener.bind(window);
window.addEventListener=(type,fn,options)=>{if(type==='keydown')keyListeners.add(fn);return add(type,fn,options)};
window.removeEventListener=(type,fn,options)=>{if(type==='keydown')keyListeners.delete(fn);return remove(type,fn,options)};
globalThis.listenerCount=()=>keyListeners.size;
const sheet=document.createElement('style');sheet.textContent=\`body{font-family:system-ui,sans-serif;--bt-main:#fcfcfc;--bt-sidebar:#f7f7f7;--bt-card:#fff;--bt-ink:#141414;--bt-ink-2:#666;--bt-ink-3:#999;--bt-line:#e8e8e8;--bt-line-2:#d9d9d9;--bt-hover:#eee;--bt-accent:#4d6bfe;--bt-accent-ink:#fff;--bt-tag-bg:#eee;--bt-green:#00c972;--bt-danger:#e02135;--bt-danger-soft:#faeeee;--bt-glass-shadow:0 18px 50px #0003}\`+TASK_BOARD_CSS;document.head.append(sheet);
const actors=[{id:'a',name:'Alice'},{id:'b',name:'Bob'},{id:'user',name:'You'}];
const state=globalThis.fixture={calls:[],mode:'normal',revision:1,scope:{kind:'room',id:'g1'},sealed:new Set(),resolvers:{}};
const canvas=document.createElement('canvas');canvas.width=2;canvas.height=2;canvas.getContext('2d').fillRect(0,0,2,2);
const images={png:{mediaType:'image/png',data:canvas.toDataURL('image/png').split(',')[1]},jpeg:{mediaType:'image/jpeg',data:canvas.toDataURL('image/jpeg').split(',')[1]},bad:{mediaType:'image/png',data:'YWJj'}};
state.images=images;
function record(scope){return {id:'T1',title:scope.id==='g1'?'Group task':'Personal task',owner:state.mode==='manual'?'user':'a',reviewer:'b',acceptance:'Evidence',dependencies:[],revision:state.revision,status:state.mode==='manual'?'proposed':'reported',...(state.mode==='manual'?{personalProgress:state.progress??'todo'}:{}),shares:[{id:'grant-old',targetRoomId:'g2',fields:['status']}],images:[{id:'png',name:'existing.png'},{id:'jpeg',name:'existing.jpg'},{id:'bad',name:'broken.png'}]}}
async function request(endpoint,payload){
 state.calls.push({endpoint,payload});
 if(endpoint==='board-list'){
  const task=record(payload.scope);
  if(state.mode==='slow'&&payload.scope.id==='g1') await new Promise(resolve=>setTimeout(resolve,500));
  const legacy=state.mode==='legacy'?[{id:'old',title:'Legacy task',owner:'a',revision:1,status:'legacy-pending',legacy:{originalStatus:'pending',current:true,goalStatus:'active'}}]:[];
  const shared=payload.scope.kind==='personal'?[{id:'T2',title:'Shared dependency',revision:1,status:'working',shared:true}]:[];
  return {tasks:[task,...legacy,...shared],remoteChanges:state.mode.startsWith('monitor')&&payload.scope.kind==='personal'&&payload.scope.id==='user'?{status:state.mode==='monitor-denied'?'authorization unavailable':'ok',repository:'example/project',branch:'main',totalEvents:31,earlierUnknown:true,checkedAt:'2026-11-14T00:00:00.000Z',events:state.mode==='monitor-denied'?[]:[{sha:'a'.repeat(40),title:'Update service',author:'Developer',committed_at:'2026-11-14T00:00:00Z',kind:'relevant',paths:['src/index.js']}]}:undefined,recovery:state.mode==='recovery'?{available:true,incomplete:false,sampledAt:1700000000000,items:state.recoveryEmpty?[]:[{recoveryId:'rec-1',botName:'Alice',sessionId:'session-original',exchangeId:'exchange-1',status:'uncertain',evidence:'inflight.json'}]}:{available:true,incomplete:false,sampledAt:1700000000000,items:[]},capabilities:state.mode==='readonly'?{}:state.mode==='capacity'?{create:true,actors,taskCount:1000,taskLimit:1000,taskLimitReached:true}:{create:true,upload:true,actors,shareTargets:{T1:[{id:'g2',name:'Design group'}]},commands:{T1:[{type:'edit'},{type:'card-details'},{type:'upload'},{type:'remove-image'},{type:'share'},{type:'unshare'},...(state.mode==='manual'?[{type:'personal-progress'}]:[])],old:[{type:'goal-task-edit'},{type:'goal-card-details'},{type:'upload'}],T2:[{type:'edit'},{type:'share'},{type:'upload'}]}}}
 }
 if(endpoint==='board-image')return images[payload.imageId];
 if(endpoint==='board-command'||endpoint==='board-upload'){
  if(state.mode==='lost')throw Error('network lost');
  if(endpoint==='board-upload'&&state.mode==='invalid-image')throw Error('rejected by host');
  if(state.mode==='hang'){
   const id=payload.operationId;
   await new Promise(resolve=>{state.resolvers[id]=resolve});
   if(state.sealed.has(id))throw Error('sealed');
  }
  if(state.mode==='conflict')state.revision=2;
  if(endpoint==='board-command'&&payload.type==='personal-progress'){state.progress=payload.value.progress;state.revision++}
  return {};
 }
 if(endpoint==='board-operation-cancel'){
  if(state.mode==='cancel-fails')throw Error('network lost');
  state.sealed.add(payload.operationId);return {state:'rejected',message:'safely cancelled'};
 }
 if(endpoint==='board-operation')return {state:state.sealed.has(payload.operationId)?'rejected':state.mode==='lost'||state.mode==='cancel-fails'?'unknown':state.mode==='conflict'||state.mode==='invalid-image'?'rejected':'committed',message:state.mode==='invalid-image'?'Interlaced PNG is not supported':'stale revision'};
 throw Error('unexpected endpoint '+endpoint);
}
const root=ReactDOM.createRoot(document.getElementById('root'));
globalThis.renderFixture=(scope,mode='normal')=>{state.scope=scope;state.mode=mode;root.render(h(TaskBoard,{scope,title:'Board',close:()=>{state.closed=(state.closed??0)+1},request}))};
globalThis.clearFixture=()=>ReactDOM.flushSync(()=>root.render(null));
`
const bundle = await build({ stdin: { contents: entry, resolveDir: dirname(boardEntry), sourcefile: 'board-fixture.js' },
  bundle: true, platform: 'browser', format: 'iife', write: false, plugins: [shim] })
const browser = await chromium.launch({ ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}), headless: true,
  args: ['--no-sandbox', '--disable-background-networking'] })
try {
  const page = await browser.newPage()
  page.setDefaultTimeout(5000)
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.route('http://localhost:17394/**', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><div id="root"></div>' }))
  await page.goto('http://localhost:17394/')
  await page.addScriptTag({ path: react })
  await page.addScriptTag({ path: reactDom })
  await page.addScriptTag({ content: bundle.outputFiles[0].text })

  await page.evaluate(() => globalThis.renderFixture({ kind:'personal', id:'user' }, 'monitor'))
  await page.getByText('Remote code changes (31)', { exact:true }).click()
  await page.getByText('Earlier history before the first checkpoint was not verified.').waitFor()
  await page.getByText('Update service').waitFor()
  assert.equal(await page.locator('a').filter({hasText:'aaaaaaaa'}).getAttribute('href'), 'https://github.com/example/project/commit/'+'a'.repeat(40))
  await page.evaluate(() => globalThis.renderFixture({ kind:'personal', id:'user' }, 'monitor-denied'))
  await page.getByRole('button', {name:'Refresh', exact:true}).click()
  await page.getByText('Status: Monitor authorization unavailable').waitFor()
  assert.equal(await page.getByText('Update service').count(),0)

  await page.evaluate(() => globalThis.renderFixture({ kind:'room', id:'g1' }, 'recovery'))
  await page.getByText('Interrupted turns awaiting review').click()
  const recovery = page.locator('.bt-board-held-record')
  await recovery.getByText('session-original').waitFor()
  assert.match(await recovery.innerText(), /Original turn[\s\S]*Unknown/)
  assert.match(await recovery.innerText(), /exchange-1/)
  assert.match(await recovery.innerText(), /inflight\.json/)
  assert.equal(await recovery.getByRole('button').count(), 0, 'reconciliation view must not replay or close work')
  await page.getByText('Snapshot time (UTC): 2023-11-14T22:13:20.000Z').waitFor()
  const beforeRefresh = await page.evaluate(() => globalThis.fixture.calls.filter(call => call.endpoint === 'board-list').length)
  await page.evaluate(() => { globalThis.fixture.recoveryEmpty = true })
  await page.getByRole('button', { name:'Refresh', exact:true }).click()
  await page.getByText('No interrupted turns in this snapshot.').waitFor()
  assert.equal(await page.evaluate(() => globalThis.fixture.calls.filter(call => call.endpoint === 'board-list').length), beforeRefresh + 1)
  await page.evaluate(() => globalThis.renderFixture({ kind:'personal', id:'a' }, 'normal'))
  await page.getByText('Personal task', {exact:true}).waitFor()
  assert.equal(await page.locator('.bt-board-held-record').count(), 0, 'scope change must not retain old recovery rows')

  await page.evaluate(() => globalThis.renderFixture({ kind: 'personal', id: 'user' }, 'capacity'))
  await page.getByText('Instance task capacity: 1000 / 1000').waitFor()
  await page.getByText('Task limit reached. New tasks cannot be created.').waitFor()
  assert.equal(await page.getByRole('button', {name:'Create task'}).isDisabled(), true)
  await page.evaluate(() => globalThis.renderFixture({ kind: 'room', id: 'g1' }, 'readonly'))
  await page.getByRole('heading', { name: 'Awaiting review 1' }).waitFor()
  assert.equal(await page.locator('[aria-label="Done"] article').count(), 0, 'reported must not be displayed as done')
  assert.equal(await page.getByRole('button', { name: 'Create task' }).count(), 0, 'missing capability is read only')
  assert.equal(await page.getByText('Read only').count(), 1)
  assert.equal(await page.getByText('Instance task capacity: 1000 / 1000').count(), 0, 'capacity is not shown when the host omits it')
  await page.locator('article').filter({hasText:'Group task'}).locator('summary').click()
  assert.match(await page.locator('article').filter({hasText:'Group task'}).locator('.bt-board-fact').filter({hasText:'Owner'}).innerText(), /\ba\b/, 'missing actor name falls back to ID')
  await page.waitForFunction(() => {const imgs=[...document.querySelectorAll('.bt-board-photo img')];return imgs.length===2&&imgs.every(img=>img.complete&&img.naturalWidth===2&&img.naturalHeight===2)})
  await page.getByText('Image unavailable').waitFor()
  assert.equal(await page.evaluate(() => globalThis.fixture.calls.some(x => x.endpoint === 'board-image' && x.payload.scope.id === 'g1' && x.payload.taskId === 'T1')), true)

  await page.evaluate(() => globalThis.renderFixture({ kind: 'personal', id: 'a' }, 'normal'))
  await page.getByText('Personal task', { exact: true }).waitFor()
  assert.equal(await page.getByText('Group task', { exact: true }).count(), 0, 'group data must not persist in another scope')
  const namedCard = page.locator('article').filter({hasText:'Personal task'})
  await namedCard.locator('summary').click()
  await namedCard.getByRole('button',{name:'Edit card details'}).click()
  await namedCard.getByLabel('Description',{exact:true}).fill('Release details')
  await namedCard.getByLabel('Due date').fill('2026-12-01')
  await namedCard.getByLabel('Labels, one per line').fill('Design\nUrgent')
  await namedCard.getByLabel('New checklist item').fill('Verify layout')
  await namedCard.getByRole('button',{name:'Add item'}).click()
  await namedCard.getByRole('button',{name:'Save changes'}).click()
  await page.waitForFunction(()=>globalThis.fixture.calls.some(x=>x.endpoint==='board-command'&&x.payload.type==='card-details'))
  const details=await page.evaluate(()=>globalThis.fixture.calls.find(x=>x.endpoint==='board-command'&&x.payload.type==='card-details'))
  assert.equal(details.payload.value.description,'Release details')
  assert.equal(details.payload.value.dueDate,'2026-12-01')
  assert.deepEqual(details.payload.value.labels,['Design','Urgent'])
  assert.equal(details.payload.value.checklist[0].text,'Verify layout')
  assert.match(await namedCard.locator('.bt-board-fact').filter({hasText:'Owner'}).innerText(), /Alice/)
  assert.match(await namedCard.locator('.bt-board-fact').filter({hasText:'Reviewer'}).innerText(), /Bob/)
  await page.getByRole('button', { name: 'Create task' }).click()
  await page.getByLabel('Title', { exact: true }).fill('New task')
  await page.getByLabel('Owner ID', { exact: true }).selectOption('a')
  await page.getByLabel('Independent reviewer ID', { exact: true }).selectOption('b')
  await page.getByLabel('Acceptance criteria').fill('Review evidence')
  await page.getByLabel('Dependencies', {exact:true}).selectOption('T2')
  await page.getByRole('button', { name: 'Submit proposal' }).click()
  await page.getByRole('button', { name: 'Create task' }).waitFor()
  const proposal = await page.evaluate(() => globalThis.fixture.calls.find(x => x.endpoint === 'board-command' && x.payload.type === 'create'))
  assert.equal(proposal.payload.type, 'create')
  assert.equal(proposal.payload.value.owner, 'a')
  assert.equal(proposal.payload.value.reviewer, 'b')
  assert.deepEqual(proposal.payload.value.dependencies, ['T2'], 'only a visible shared task may be selected as a dependency')
  assert.equal(await page.evaluate(id => globalThis.fixture.calls.some(x => x.endpoint === 'board-operation' && x.payload.operationId === id), proposal.payload.operationId), true)

  const shared = page.locator('article').filter({hasText:'Shared dependency'})
  assert.match(await shared.innerText(), /Shared task · read only/)
  assert.equal(await shared.getByRole('button', {name:'Edit task'}).count(), 0, 'a shared task cannot be edited even if a bad capability is sent')
  assert.equal(await shared.getByRole('button', {name:'Share with group'}).count(), 0)
  await page.getByRole('button', {name:'Share with group'}).click()
  await page.getByLabel('Target group', {exact:true}).selectOption('g2')
  await page.getByRole('button', {name:'Share',exact:true}).click()
  await page.getByRole('button', {name:'Share with group'}).waitFor()
  const share = await page.evaluate(() => globalThis.fixture.calls.find(x => x.endpoint==='board-command' && x.payload.type==='share'))
  assert.deepEqual(share.payload.value, {targetRoomId:'g2',fields:['status']})
  assert.equal(share.payload.expectedRevision, 1)
  await page.getByRole('button', {name:'Share with group'}).click()
  await page.getByLabel('Target group', {exact:true}).selectOption('g2')
  await page.getByLabel('Share title too').check()
  await page.getByRole('button', {name:'Share',exact:true}).click()
  await page.getByRole('button', {name:'Share with group'}).waitFor()
  const titled = await page.evaluate(() => globalThis.fixture.calls.filter(x => x.endpoint==='board-command' && x.payload.type==='share')[1])
  assert.deepEqual(titled.payload.value.fields, ['status','title'])
  await page.getByRole('button', {name:'Revoke share'}).click()
  await page.waitForFunction(() => globalThis.fixture.calls.some(x => x.endpoint==='board-command' && x.payload.type==='unshare'))
  const unshare = await page.evaluate(() => globalThis.fixture.calls.find(x => x.endpoint==='board-command' && x.payload.type==='unshare'))
  assert.equal(unshare.payload.value.shareId, 'grant-old')
  await page.evaluate(() => { globalThis.fixture.mode='lost' })
  await page.getByRole('button', {name:'Share with group'}).click()
  await page.getByLabel('Target group', {exact:true}).selectOption('g2')
  await page.getByRole('button', {name:'Share',exact:true}).click()
  await page.getByText('An action needs confirmation.').waitFor()
  const shareCount = await page.evaluate(() => globalThis.fixture.calls.filter(x => x.endpoint==='board-command' && x.payload.type==='share').length)
  await page.getByRole('button', {name:'Check action'}).click()
  assert.equal(await page.evaluate(() => globalThis.fixture.calls.filter(x => x.endpoint==='board-command' && x.payload.type==='share').length), shareCount, 'checking an uncertain share must not resend it')
  await page.getByRole('button', {name:'Safely cancel pending request'}).click()
  await page.getByText('An action needs confirmation.').waitFor({state:'hidden'})
  await page.locator('form').filter({hasText:'Target group'}).getByRole('button', {name:'Cancel'}).click()
  await page.evaluate(() => { globalThis.fixture.mode='normal' })

  await page.evaluate(() => { globalThis.fixture.mode='conflict'; globalThis.fixture.revision=1 })
  await page.getByRole('button', { name: 'Edit task' }).click()
  await page.locator('.bt-board-actions').getByLabel('Title', { exact: true }).fill('Unsaved draft')
  await page.getByRole('button', { name: 'Save changes' }).click()
  await page.getByText('Task changed. Reload its current values before saving.').waitFor()
  assert.equal(await page.locator('.bt-board-actions').getByLabel('Title', { exact: true }).inputValue(), 'Unsaved draft')
  assert.equal(await page.getByRole('button', { name: 'Save changes' }).isDisabled(), true, 'conflict must not silently overwrite revision 2')
  const edit = await page.evaluate(() => globalThis.fixture.calls.find(x => x.endpoint === 'board-command' && x.payload.type === 'edit'))
  assert.equal(edit.payload.expectedRevision, 1)

  await page.evaluate(() => { globalThis.fixture.mode='normal' })
  const png = Buffer.from(await page.evaluate(() => globalThis.fixture.images.png.data), 'base64')
  await page.getByText('Non-interlaced PNG and JPEG are supported.').waitFor()
  await page.locator('.bt-board-upload input[type=file]').setInputFiles([{ name:'bad.txt',mimeType:'text/plain',buffer:Buffer.from('not an image') }])
  await page.getByText('Choose non-interlaced PNG or JPEG: up to 20 per task, 10 per batch, 5 MiB each and 20 MiB per batch.').waitFor()
  assert.equal(await page.locator('.bt-board-upload img').count(), 0, 'an unsupported type must not enter the upload queue')
  await page.locator('.bt-board-upload input[type=file]').setInputFiles(Array.from({length:11}, (_, i) => ({ name:`image-${i}.png`, mimeType:'image/png', buffer:png })))
  assert.equal(await page.locator('.bt-board-upload img').count(), 0, 'a batch of 11 must not enter the upload queue')
  await page.evaluate(() => { globalThis.fixture.mode='invalid-image' })
  await page.locator('.bt-board-upload input[type=file]').setInputFiles([{ name:'rejected.png',mimeType:'image/png',buffer:png }])
  await page.getByRole('button', {name:'Upload images'}).click()
  await page.getByText('Interlaced PNG is not supported').waitFor()
  assert.equal(await page.evaluate(() => sessionStorage.getItem('ds-bot:board-pending:personal:a')), null, 'a persisted rejected receipt settles the operation')
  await page.locator('.bt-board-upload').getByRole('button', {name:'Remove image'}).click()
  await page.evaluate(() => { globalThis.fixture.mode='normal' })
  await page.locator('.bt-board-upload input[type=file]').setInputFiles([{ name:'one.png',mimeType:'image/png',buffer:png },{ name:'two.png',mimeType:'image/png',buffer:png }])
  assert.equal(await page.locator('.bt-board-upload img').count(), 2)
  await page.locator('.bt-board-upload').getByRole('button', { name:'Remove image' }).first().click()
  assert.equal(await page.locator('.bt-board-upload img').count(), 1)
  await page.getByRole('button', { name:'Upload images' }).click()
  await page.waitForFunction(() => globalThis.fixture.calls.some(x => x.endpoint === 'board-upload' && x.payload.images?.[0]?.name === 'two.png'))
  const upload = await page.evaluate(() => globalThis.fixture.calls.find(x => x.endpoint === 'board-upload' && x.payload.images?.[0]?.name === 'two.png'))
  assert.equal(upload.payload.images.length, 1)
  assert.equal(upload.payload.images[0].name, 'two.png')
  assert.ok(upload.payload.images[0].uploadId)
  await page.waitForFunction(id => globalThis.fixture.calls.some(x => x.endpoint === 'board-operation' && x.payload.operationId === id), upload.payload.operationId)

  await page.locator('.bt-board-actions').getByRole('button', { name:'Cancel' }).click()
  await page.evaluate(() => { globalThis.fixture.mode='lost' })
  await page.getByRole('button', { name:'Create task' }).click()
  await page.getByLabel('Title', { exact:true }).fill('Potentially sent')
  await page.getByLabel('Owner ID', { exact:true }).selectOption('a')
  await page.getByLabel('Independent reviewer ID', { exact:true }).selectOption('b')
  await page.getByLabel('Acceptance criteria').fill('evidence')
  await page.getByRole('button', { name:'Submit proposal' }).click()
  await page.getByText('An action needs confirmation.').waitFor()
  const before = await page.evaluate(() => globalThis.fixture.calls.filter(x => x.endpoint === 'board-command').length)
  await page.getByRole('button', { name:'Check action' }).click()
  assert.equal(await page.evaluate(() => globalThis.fixture.calls.filter(x => x.endpoint === 'board-command').length), before, 'unknown outcome must not resend')
  assert.equal(await page.getByRole('button', { name:'Submit proposal' }).isDisabled(), true)

  const originalId = await page.evaluate(() => sessionStorage.getItem('ds-bot:board-pending:personal:a'))
  assert.ok(originalId)
  await page.reload()
  await page.addScriptTag({ path:react })
  await page.addScriptTag({ path:reactDom })
  await page.addScriptTag({ content:bundle.outputFiles[0].text })
  await page.evaluate(() => globalThis.renderFixture({kind:'personal',id:'a'},'lost'))
  await page.getByText('An action needs confirmation.').waitFor()
  assert.equal(await page.evaluate(() => globalThis.fixture.calls.some(call => call.endpoint==='board-operation' && call.payload.operationId===sessionStorage.getItem('ds-bot:board-pending:personal:a'))), true, 'reopen checks the original operation ID')
  await page.evaluate(() => { globalThis.fixture.mode='cancel-fails' })
  await page.getByRole('button', { name:'Safely cancel pending request' }).click()
  await page.getByText('Cancellation outcome is unknown. Check the original action again.').waitFor()
  assert.equal(await page.evaluate(() => sessionStorage.getItem('ds-bot:board-pending:personal:a')), originalId, 'failed cancel retains the original operation')
  await page.evaluate(() => { globalThis.fixture.mode='lost' })
  await page.getByRole('button', { name:'Safely cancel pending request' }).click()
  await page.getByText('An action needs confirmation.').waitFor({state:'hidden'})
  assert.equal(await page.evaluate(id => globalThis.fixture.calls.some(call => call.endpoint==='board-operation-cancel' && call.payload.operationId===id), originalId), true)

  await page.evaluate(() => { globalThis.fixture.mode='hang' })
  await page.getByRole('button', { name:'Create task' }).click()
  await page.getByLabel('Title', { exact:true }).fill('First pending')
  await page.getByLabel('Owner ID', { exact:true }).selectOption('a')
  await page.getByLabel('Independent reviewer ID', { exact:true }).selectOption('b')
  await page.getByLabel('Acceptance criteria').fill('Evidence')
  await page.getByRole('button', { name:'Submit proposal' }).click()
  await page.getByText('Saving…').waitFor()
  const firstId = await page.evaluate(() => sessionStorage.getItem('ds-bot:board-pending:personal:a'))
  await page.getByRole('button', { name:'Safely cancel pending request' }).click()
  await page.getByText('Saving…').waitFor({state:'hidden'})
  await page.getByLabel('Title', { exact:true }).fill('Second pending')
  await page.getByRole('button', { name:'Submit proposal' }).click()
  await page.getByText('Saving…').waitFor()
  const secondId = await page.evaluate(() => sessionStorage.getItem('ds-bot:board-pending:personal:a'))
  assert.notEqual(firstId, secondId)
  await page.evaluate(id => globalThis.fixture.resolvers[id](), firstId)
  await page.waitForTimeout(100)
  assert.equal(await page.evaluate(() => sessionStorage.getItem('ds-bot:board-pending:personal:a')), secondId, 'late first request must not clear the next pending action')
  await page.getByRole('button', { name:'Safely cancel pending request' }).click()
  await page.getByText('Saving…').waitFor({state:'hidden'})
  await page.evaluate(id => globalThis.fixture.resolvers[id](), secondId)

  await page.evaluate(() => { sessionStorage.clear(); globalThis.fixture.revision=1; globalThis.fixture.progress='todo'; globalThis.renderFixture({kind:'personal',id:'user'},'manual') })
  await page.locator('[aria-label="To do"] article').getByText('Personal task',{exact:true}).waitFor()
  await page.getByText('Your own progress markers do not complete shared work or unblock dependencies.').waitFor()
  if (process.env.BOARD_SCREENSHOT) await page.screenshot({ path:process.env.BOARD_SCREENSHOT })
  await page.locator('[aria-label="To do"] article summary').click()
  await page.getByLabel('Move personal task').focus()
  await page.keyboard.press('ArrowDown')
  await page.locator('[aria-label="Doing"] article').getByText('Personal task',{exact:true}).waitFor()
  const move = await page.evaluate(() => globalThis.fixture.calls.find(x=>x.endpoint==='board-command'&&x.payload.type==='personal-progress'))
  assert.equal(move.payload.value.progress,'doing')
  assert.ok(move.payload.operationId)
  assert.equal(await page.evaluate(id=>globalThis.fixture.calls.some(x=>x.endpoint==='board-operation'&&x.payload.operationId===id),move.payload.operationId),true)
  await page.locator('[aria-label="Doing"] article').dragTo(page.locator('[aria-label="Personally finished"]'))
  await page.locator('[aria-label="Personally finished"] article').getByText('Personal task',{exact:true}).waitFor()
  await page.getByLabel('Search tasks').fill('no matching title')
  assert.equal(await page.getByText('Personal task',{exact:true}).count(),0)
  await page.getByLabel('Search tasks').fill('')
  await page.locator('[aria-label="Personally finished"] article').getByText('Personal task',{exact:true}).waitFor()

  await page.evaluate(() => globalThis.renderFixture({kind:'room',id:'g1'},'legacy'))
  await page.getByText('Legacy task', {exact:true}).waitFor()
  await page.getByText('Group goal cards edit the original task. Earlier stages remain read only.').waitFor()
  const legacy = page.locator('article').filter({hasText:'Legacy task'})
  await legacy.locator('summary').click()
  assert.match(await legacy.innerText(), /Original group goal task/)
  await legacy.getByRole('button',{name:'Edit card details'}).click()
  await legacy.getByLabel('Description',{exact:true}).fill('Original goal notes')
  await legacy.getByLabel('Labels, one per line').fill('UX')
  await legacy.getByRole('button',{name:'Save changes'}).click()
  await page.waitForFunction(()=>globalThis.fixture.calls.some(x=>x.endpoint==='board-command'&&x.payload.type==='goal-card-details'))
  const goalDetails=await page.evaluate(()=>globalThis.fixture.calls.find(x=>x.endpoint==='board-command'&&x.payload.type==='goal-card-details'))
  assert.match(goalDetails.payload.operationId,/^goal:/)
  assert.equal(goalDetails.payload.value.description,'Original goal notes')
  await legacy.getByRole('button', {name:'Edit goal task'}).click()
  await legacy.getByLabel('Task description').fill('Updated original work')
  await legacy.getByLabel('Goal task status').selectOption('working')
  await legacy.getByLabel('Goal task note').fill('Work started')
  assert.equal(await legacy.getByLabel('Goal task status').locator('option[value="done"]').count(),0, 'goal task cannot skip review')
  await legacy.getByRole('button',{name:'Save changes'}).click()
  await page.waitForFunction(()=>globalThis.fixture.calls.some(x=>x.endpoint==='board-command'&&x.payload.type==='goal-task-edit'))
  const goalEdit=await page.evaluate(()=>globalThis.fixture.calls.find(x=>x.endpoint==='board-command'&&x.payload.type==='goal-task-edit'))
  assert.match(goalEdit.payload.operationId,/^goal:/)
  assert.equal(goalEdit.payload.expectedRevision,1)
  assert.deepEqual(goalEdit.payload.value,{title:'Updated original work',status:'working',note:'Work started'})

  await page.evaluate(() => globalThis.renderFixture({kind:'personal',id:'a'},'normal'))
  await page.getByText('Personal task', { exact:true }).waitFor()
  const previousVisible = await page.evaluate(() => { globalThis.ReactDOM.flushSync(()=>globalThis.renderFixture({kind:'room',id:'g1'},'slow')); return document.querySelector('.bt-board-dialog')?.textContent.includes('Personal task') })
  assert.equal(previousVisible,false,'a scope change must immediately hide the previous scope')
  await page.evaluate(() => { sessionStorage.clear(); globalThis.renderFixture({kind:'room',id:'g1'},'slow'); setTimeout(()=>globalThis.renderFixture({kind:'personal',id:'a'},'normal'),20) })
  await page.getByText('Personal task', { exact:true }).waitFor()
  await page.waitForTimeout(600)
  assert.equal(await page.getByText('Group task', { exact:true }).count(), 0, 'late response must not overwrite the new board')
  await page.setViewportSize({ width: 375, height: 700 })
  const box = await page.locator('.bt-board-dialog').boundingBox()
  assert.ok(box && box.width <= 375, 'board must fit a narrow viewport')
  await page.keyboard.press('Tab')
  assert.equal(await page.evaluate(() => document.querySelector('.bt-board-dialog').contains(document.activeElement)), true, 'keyboard focus remains in the dialog')
  await page.getByRole('button', {name:'Close',exact:true}).click()
  await page.locator('.bt-board-backdrop').waitFor({state:'detached'})
  assert.equal(await page.evaluate(()=>globalThis.listenerCount()),0,'close must remove its keyboard listener')
  assert.equal(await page.evaluate(()=>globalThis.fixture.closed),1)
  await page.evaluate(()=>globalThis.clearFixture())
  await page.evaluate(()=>globalThis.renderFixture({kind:'room',id:'g1'},'normal'))
  await page.getByText('Group task',{exact:true}).waitFor()
  await page.keyboard.press('Escape')
  await page.locator('.bt-board-backdrop').waitFor({state:'detached'})
  assert.equal(await page.evaluate(()=>globalThis.listenerCount()),0,'Escape must remove its keyboard listener')
  assert.equal(await page.evaluate(()=>globalThis.fixture.closed),2)
  await page.evaluate(()=>globalThis.clearFixture())
  await page.evaluate(()=>globalThis.renderFixture({kind:'room',id:'g1'},'normal'))
  await page.getByText('Group task',{exact:true}).waitFor()
  await page.evaluate(()=>globalThis.clearFixture())
  await page.locator('.bt-board-backdrop').waitFor({state:'detached'})
  assert.equal(await page.evaluate(()=>globalThis.listenerCount()),0,'host unmount must remove keyboard listener')
  assert.deepEqual(errors, [])
  console.log('PASS board images, legacy cards, explicit cancellation, late response, reopen, scoped rendering and conflicts')
} finally { await browser.close() }
