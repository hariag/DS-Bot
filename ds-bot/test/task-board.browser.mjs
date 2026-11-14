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
      if (x.path.endsWith('i18n.js')) return { contents: 'export const t=(x,v={})=>x.replace(/\\{(\\w+)\\}/g,(_,k)=>String(v[k]??""))' }
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
  const legacy=state.mode==='legacy'?[{id:'old',title:'Legacy task',status:'legacy-unverified',legacy:{originalStatus:'done'}}]:[];
  const shared=payload.scope.kind==='personal'?[{id:'T2',title:'Shared dependency',revision:1,status:'working',shared:true}]:[];
  return {tasks:[task,...legacy,...shared],remoteChanges:state.mode.startsWith('monitor')&&payload.scope.kind==='personal'&&payload.scope.id==='user'?{status:state.mode==='monitor-denied'?'authorization unavailable':'ok',repository:'example/project',branch:'main',totalEvents:31,earlierUnknown:true,checkedAt:'2026-11-14T00:00:00.000Z',events:state.mode==='monitor-denied'?[]:[{sha:'a'.repeat(40),title:'Update service',author:'Developer',committed_at:'2026-11-14T00:00:00Z',kind:'relevant',paths:['src/index.js']}]}:undefined,recovery:state.mode==='recovery'?{available:true,incomplete:false,sampledAt:1700000000000,items:state.recoveryEmpty?[]:[{recoveryId:'rec-1',botId:'a',botName:'Alice',sessionId:'session-original',exchangeId:'exchange-1',status:'uncertain',evidence:'inflight.json'},{recoveryId:'rec-2',botId:'b',botName:'Bob',sessionId:'session-other',exchangeId:'exchange-2',status:'uncertain',evidence:'inflight.json',secret:'SECRET-HIDDEN'}]}:{available:true,incomplete:false,sampledAt:1700000000000,items:[]},capabilities:state.mode==='readonly'?{}:state.mode==='capacity'?{create:true,actors,taskCount:1000,taskLimit:1000,taskLimitReached:true}:{create:true,upload:true,actors,shareTargets:{T1:[{id:'g2',name:'Design group'}]},commands:{T1:[{type:'edit'},{type:'upload'},{type:'remove-image'},{type:'share'},{type:'unshare'},...(state.mode==='manual'?[{type:'personal-progress'}]:[])],old:[{type:'edit'},{type:'upload'}],T2:[{type:'edit'},{type:'share'},{type:'upload'}]}}}
 }
 if(endpoint==='legacy-review-list')return {items:[{workId:'work-a',owner:'a'},{workId:'work-b',owner:'b'}],incomplete:false};
 if(endpoint==='legacy-review-get')return {state:'not-created',liveRecovery:{available:true,sampledAt:1700000000000,ids:['session-original'],observed:{queue:'observed-present',held:'unknown'}}};
 if(endpoint==='legacy-review-create')return {state:'needs-review',owner:'a',revision:1,snapshot:{sampledAt:1700000000000,sources:[{sessionId:'session-original'}]},history:[]};
 if(endpoint==='legacy-review-finding')return {state:'evidence-needed',owner:'a',revision:2,snapshot:{sampledAt:1700000000000,sources:[{sessionId:'session-original'}]},history:[{revision:2,finding:{summary:payload.summary,evidenceRefs:payload.evidenceRefs,unfinished:payload.unfinished}}]};
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
globalThis.renderFixture=(scope,mode='normal')=>{state.scope=scope;state.mode=mode;
 const goal=mode.startsWith('periodic')?{id:'goal-1',revision:1,status:'active',reviewAttempt:{id:'attempt-1',state:'uncertain',at:1}}:undefined;
 const refreshGoal=async()=>{state.calls.push({endpoint:'refresh-goal',scope});if(mode==='periodic-refresh-fail')throw Error('offline')};
 const resolveReview=async(goalId,reviewId,evidence)=>{state.calls.push({endpoint:'review-resolve',scope,payload:{goalId,reviewId,evidence}});if(mode==='periodic-error')throw Object.assign(Error('stale'),{code:'bot/stale'});if(mode==='periodic-network')throw Error('offline')};
 root.render(h(TaskBoard,{scope,title:'Board',goal,initialReview:mode.startsWith('periodic'),refreshGoal,resolveReview,close:()=>{state.closed=(state.closed??0)+1},request}))};
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
  const recovery = page.locator('.bt-recovery-panel').filter({hasText:'Interrupted turns awaiting review'})
  await recovery.getByText('Alice', {exact:true}).waitFor()
  await recovery.getByText('Bob', {exact:true}).waitFor()
  const recoverySearch = recovery.getByPlaceholder('Filter by Bot or ID')
  await recoverySearch.fill('exchange-2')
  assert.equal(await recovery.getByText('session-other', {exact:true}).count(), 1)
  assert.equal(await recovery.getByText('session-original', {exact:true}).count(), 0)
  await recoverySearch.fill('missing')
  await recovery.getByText('No matching records.').waitFor()
  await recoverySearch.fill('')
  const original = recovery.locator('.bt-recovery-record').filter({hasText:'session-original'})
  await original.locator('summary').click()
  assert.match(await original.innerText(), /Original turn[\s\S]*Unknown/)
  assert.match(await original.innerText(), /exchange-1/)
  assert.match(await original.innerText(), /inflight\.json/)
  assert.doesNotMatch(await recovery.innerText(), /SECRET-HIDDEN/)
  assert.equal(await recovery.getByRole('button').count(), 0, 'reconciliation view must not replay or close work')
  if (process.env.RECOVERY_SCREENSHOT) await page.screenshot({ path:process.env.RECOVERY_SCREENSHOT })
  await page.getByText('Snapshot time (UTC): 2023-11-14T22:13:20.000Z').waitFor()
  const beforeRefresh = await page.evaluate(() => globalThis.fixture.calls.filter(call => call.endpoint === 'board-list').length)
  await page.evaluate(() => { globalThis.fixture.recoveryEmpty = true })
  await page.getByRole('button', { name:'Refresh', exact:true }).click()
  await page.getByText('No interrupted turns in this snapshot.').waitFor()
  assert.equal(await page.evaluate(() => globalThis.fixture.calls.filter(call => call.endpoint === 'board-list').length), beforeRefresh + 1)
  await page.evaluate(() => globalThis.renderFixture({ kind:'personal', id:'a' }, 'normal'))
  await page.getByText('Personal task', {exact:true}).waitFor()
  assert.equal(await page.locator('.bt-board-held-record').count(), 0, 'scope change must not retain old recovery rows')

  await page.evaluate(() => globalThis.renderFixture({ kind:'room', id:'g1' }, 'normal'))
  const manual = page.locator('.bt-recovery-panel').filter({hasText:'Review an existing work'})
  await manual.locator('summary').first().click()
  await manual.getByText('Alice', {exact:true}).waitFor()
  await manual.getByText('Bob', {exact:true}).waitFor()
  await manual.getByPlaceholder('Filter by Bot or ID').fill('work-b')
  assert.equal(await manual.getByRole('button', {name:'work-b'}).count(), 1)
  assert.equal(await manual.getByRole('button', {name:'work-a'}).count(), 0)
  await manual.getByRole('button', {name:'work-b'}).click()
  await manual.getByRole('button', {name:'Create review'}).waitFor()
  assert.equal(await page.evaluate(() => globalThis.fixture.calls.some(x => x.endpoint === 'legacy-review-get' && x.payload.workId === 'work-b' && x.payload.scope.id === 'g1')), true)
  await manual.getByRole('button', {name:'Create review'}).click()
  await manual.getByLabel('Review note', {exact:true}).fill('Checked the original session')
  await manual.getByRole('button', {name:'Save review note'}).click()
  await manual.getByText('Checked the original session').waitFor()
  assert.equal(await page.evaluate(() => globalThis.fixture.calls.some(x => x.endpoint === 'legacy-review-finding' && x.payload.workId === 'work-b' && x.payload.expectedRevision === 1)), true)

  await page.evaluate(() => globalThis.renderFixture({ kind:'room', id:'g1' }, 'periodic'))
  const periodic = page.locator('.bt-periodic-review')
  await periodic.getByText('This only resumes periodic inspections; it does not approve or complete tasks.').waitFor()
  await periodic.getByText('The server also checks the group and administrator sessions for pending work, approvals and subagents.').waitFor()
  const resume = periodic.getByRole('button', {name:'Resume periodic reviews'})
  assert.equal(await resume.isDisabled(), true)
  await periodic.getByLabel('What did you verify?').fill('Checked original work')
  assert.equal(await resume.isDisabled(), true, 'confirmation must be explicit')
  await periodic.getByLabel('I checked the original outcome and authorize future reviews.').check()
  await periodic.getByRole('button', {name:'Refresh status'}).click()
  await resume.click()
  await periodic.getByText(/Request accepted/).waitFor()
  assert.equal(await page.evaluate(() => globalThis.fixture.calls.filter(x => x.endpoint === 'review-resolve').length), 1)
  assert.deepEqual(await page.evaluate(() => globalThis.fixture.calls.find(x => x.endpoint === 'review-resolve').payload), {goalId:'goal-1',reviewId:'attempt-1',evidence:'Checked original work'})
  assert.equal(await page.evaluate(() => globalThis.fixture.calls.find(x => x.endpoint === 'review-resolve').scope.id), 'g1')

  await page.evaluate(() => globalThis.renderFixture({ kind:'room', id:'g2' }, 'periodic-error'))
  const refused = page.locator('.bt-periodic-review')
  await refused.getByLabel('What did you verify?').fill('Checked original work')
  await refused.getByLabel('I checked the original outcome and authorize future reviews.').check()
  await refused.getByRole('button', {name:'Refresh status'}).click()
  await refused.getByRole('button', {name:'Resume periodic reviews'}).click()
  await refused.getByRole('alert').getByText('The goal changed or related work is still pending. Check it before recovery.').waitFor()
  assert.equal(await refused.getByRole('button', {name:'Resume periodic reviews'}).isDisabled(), true)

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
  const proposal = await page.evaluate(() => globalThis.fixture.calls.find(x => x.endpoint === 'board-command'))
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
  await page.getByText('Existing group goal aggregates are read only. A new card does not automatically link to or replace them.').waitFor()
  const legacy = page.locator('article').filter({hasText:'Legacy task'})
  await legacy.locator('summary').click()
  assert.match(await legacy.innerText(), /Existing group goal aggregate; child tasks not yet linked/)
  assert.match(await legacy.innerText(), /Original status/)
  assert.equal(await legacy.getByRole('button', {name:'Edit task'}).count(), 0, 'legacy card is read only even if capability is incorrectly supplied')

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
