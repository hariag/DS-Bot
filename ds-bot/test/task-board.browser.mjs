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
const state=globalThis.fixture={calls:[],mode:'normal',revision:1,heldDecisions:{},heldRedos:{},workDecisions:{},scope:{kind:'room',id:'g1'},sealed:new Set(),resolvers:{},boardPlans:{},boardStarted:[],boardFinished:[],receiptPlans:{},receiptStarted:[],boardTitles:{}};
const canvas=document.createElement('canvas');canvas.width=2;canvas.height=2;canvas.getContext('2d').fillRect(0,0,2,2);
const images={png:{mediaType:'image/png',data:canvas.toDataURL('image/png').split(',')[1]},jpeg:{mediaType:'image/jpeg',data:canvas.toDataURL('image/jpeg').split(',')[1]},bad:{mediaType:'image/png',data:'YWJj'}};
state.images=images;
function record(scope){return {id:'T1',title:state.boardTitles[scope.kind+':'+scope.id]??(scope.id==='g1'?'Group task':'Personal task'),owner:state.mode==='manual'?'user':'a',reviewer:'b',acceptance:'Evidence',dependencies:[],revision:state.revision,status:state.mode==='manual'?'proposed':'reported',...(state.mode==='manual'?{personalProgress:state.progress??'todo'}:{}),shares:[{id:'grant-old',targetRoomId:'g2',fields:['status']}],images:[{id:'png',name:'existing.png'},{id:'jpeg',name:'existing.jpg'},{id:'bad',name:'broken.png'}]}}
async function request(endpoint,payload){
 state.calls.push({endpoint,payload});
 if(endpoint==='board-list'){
  // Capture the snapshot before blocking so a stale response is observably old.
  const task=record(payload.scope);
  const key=payload.scope.kind+':'+payload.scope.id, plan=state.boardPlans[key]?.shift();
  if(plan){
   state.boardStarted.push(plan.id);
   if(plan.mode==='hold')await new Promise((resolve,reject)=>{state.resolvers['board:'+plan.id]=ok=>ok?resolve():reject(Error('board refresh failed'))});
   else if(plan.mode==='fail')throw Error('board refresh failed');
   state.boardFinished.push(plan.id);
  }
  if(state.mode==='slow'&&payload.scope.id==='g1') await new Promise(resolve=>setTimeout(resolve,500));
  const position=state.mode.startsWith('history-')?state.mode.slice(8):null;
  const legacy=state.mode==='legacy'?[{id:'old',title:'Legacy task',owner:'a',revision:1,status:'legacy-pending',legacy:{originalStatus:'pending',current:true,goalStatus:'active'}}]:position?[{id:'history',title:state.historyTitle??'Original historical task',owner:'a',revision:5,status:position==='future'?'waiting':'legacy-done',legacy:{originalTitle:'Original historical task',originalStatus:position==='future'?'pending':'done',position,current:false,goalStatus:'active',useOverlay:true,boardRevision:state.historyRevision??0},boardHistory:state.historyAudit??[]}]:[];
  const shared=payload.scope.kind==='personal'?[{id:'T2',title:'Shared dependency',revision:1,status:'working',shared:true}]:[];
  return {tasks:[task,...legacy,...shared],remoteChanges:state.mode.startsWith('monitor')&&payload.scope.kind==='personal'&&payload.scope.id==='user'?{status:state.mode==='monitor-denied'?'authorization unavailable':'ok',repository:'example/project',branch:'main',totalEvents:31,earlierUnknown:true,checkedAt:'2026-11-14T00:00:00.000Z',events:state.mode==='monitor-denied'?[]:[{sha:'a'.repeat(40),title:'Update service',author:'Developer',committed_at:'2026-11-14T00:00:00Z',kind:'relevant',paths:['src/index.js']}]}:undefined,recovery:state.mode==='recovery'?{available:true,incomplete:false,sampledAt:1700000000000,items:state.recoveryEmpty?[]:[{recoveryId:'rec-1',botId:'a',botName:'Alice',sessionId:'session-original',exchangeId:'exchange-1',status:'uncertain',decision:state.heldDecisions['rec-1']?.choice??'open',decisionRevision:state.heldDecisions['rec-1']?.revision??0,redo:{operationId:'attempt-1',status:'unknown'},evidence:'inflight.json'},{recoveryId:'rec-2',botId:'b',botName:'Bob',sessionId:'session-other',exchangeId:'exchange-2',status:'uncertain',decision:'open',decisionRevision:0,redo:{available:false,state:'source-unavailable'},evidence:'inflight.json',secret:'SECRET-HIDDEN'}]}:{available:true,incomplete:false,sampledAt:1700000000000,items:[]},capabilities:state.mode==='readonly'?{}:state.mode==='capacity'?{create:true,actors,taskCount:1000,taskLimit:1000,taskLimitReached:true}:{create:true,upload:true,actors,shareTargets:{T1:[{id:'g2',name:'Design group'}]},commands:{T1:[{type:'edit'},{type:'card-details'},{type:'card-comment'},{type:'upload'},{type:'remove-image'},{type:'share'},{type:'unshare'},...(state.mode==='manual'?[{type:'personal-progress'}]:[])],old:[{type:'goal-task-edit'},{type:'goal-card-details'},{type:'goal-card-comment'},{type:'upload'}],history:[{type:'goal-history-title'},{type:'goal-card-details'},{type:'goal-card-comment'},{type:'upload'}],T2:[{type:'edit'},{type:'share'},{type:'upload'}]}}}
 }
 if(endpoint==='board-held-decision'){state.heldDecisions[payload.recoveryId]={choice:payload.choice,revision:payload.expectedRevision+1};return {decision:payload.choice,revision:payload.expectedRevision+1}}
 if(endpoint==='board-held-redo'){if(payload.confirmed!==true)throw Error('confirmation required');state.heldRedos[payload.recoveryId]=true;return {state:'submitted'}}
 if(endpoint==='legacy-review-list'){
  if(state.mode==='review-invalid-list')return {items:'invalid',incomplete:false};
  return {items:['work-a','work-b'].map((workId,index)=>({workId,owner:index?'b':'a',sender:index?'a':'b',canDecide:true,...(state.workDecisions[workId]??{choice:'open',revision:0})})),incomplete:false};
 }
 if(endpoint==='board-redo-preview'){
  if(state.candidateHold)await new Promise(resolve=>{state.resolvers['candidate']=resolve});
  if(state.candidateFail)throw Error('writer unavailable');
  return {kind:'unverified-legacy-candidate',producerVerified:false,executeAllowed:false,snapshotOnly:true,recoveryId:payload.recoveryId,sessionId:'session-original',textSegments:['Candidate task\\nSecond line']};
 }
 if(endpoint==='legacy-review-decision'){const old=state.workDecisions[payload.workId]??{choice:'open',revision:0};if(old.revision!==payload.expectedRevision)throw Error('stale');state.workDecisions[payload.workId]={choice:payload.choice,revision:old.revision+1};return state.workDecisions[payload.workId]}
 if(endpoint==='legacy-review-prepare')return {operationId:'manual-review:'+ (payload.kind==='create'?'a':'b').repeat(64)};
 if(endpoint==='legacy-review-operation')return {status:state.reviewReceipt?'committed':'unknown'};
 if(endpoint==='legacy-review-get'){
  const mode=state.mode;
  if(mode==='review-slow'&&payload.scope.id==='g5')await new Promise(resolve=>{state.resolvers['review:g5:'+payload.workId]=resolve});
  if(mode==='review-wrong-id')return {state:'not-created',workId:'different-work'};
  if(mode==='review-lost'&&state.reviewSaved)return {state:'evidence-needed',workId:payload.workId,owner:'a',revision:2,snapshot:{workId:payload.workId,sampledAt:1700000000000,sources:[]},history:[{revision:2,finding:{summary:'A verified result',evidenceRefs:[],unfinished:[]}}]};
  if(mode==='review-slow')return {state:'identity-unverified',archived:true};
  return {state:'not-created',liveRecovery:{available:true,sampledAt:1700000000000,ids:['session-original'],observed:{queue:'observed-present',held:'unknown'}}};
 }
 if(endpoint==='legacy-review-create')return {state:'needs-review',owner:'a',revision:1,snapshot:{workId:payload.workId,sampledAt:1700000000000,sources:[{sessionId:'session-original'}]},history:[]};
 if(endpoint==='legacy-review-finding'){
  if(state.mode==='review-lost'){state.reviewSaved=true;throw Error('response lost after save')}
  return {state:'evidence-needed',owner:'a',revision:2,snapshot:{workId:payload.workId,sampledAt:1700000000000,sources:[{sessionId:'session-original'}]},history:[{revision:2,finding:{summary:payload.summary,evidenceRefs:payload.evidenceRefs,unfinished:payload.unfinished}}]};
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
  if(endpoint==='board-command'&&payload.type==='goal-history-title'){state.historyTitle=payload.value.title;state.historyRevision=(state.historyRevision??0)+1;state.historyAudit=[{operationId:payload.operationId,at:1700000000000,kind:'title',reason:payload.value.reason,before:{title:'Original historical task'},after:{title:payload.value.title}}]}
  return {};
 }
 if(endpoint==='board-operation-cancel'){
  if(state.mode==='cancel-fails')throw Error('network lost');
  state.sealed.add(payload.operationId);return {state:'rejected',message:'safely cancelled'};
 }
 if(endpoint==='board-operation'){
  const plan=state.receiptPlans[payload.operationId];
  if(plan){delete state.receiptPlans[payload.operationId];state.receiptStarted.push(plan.id);await new Promise(resolve=>{state.resolvers['receipt:'+plan.id]=resolve})}
  return {state:state.sealed.has(payload.operationId)?'rejected':state.mode==='lost'||state.mode==='cancel-fails'?'unknown':state.mode==='conflict'||state.mode==='invalid-image'?'rejected':'committed',message:state.mode==='invalid-image'?'Interlaced PNG is not supported':'stale revision'};
 }
 throw Error('unexpected endpoint '+endpoint);
}
const root=ReactDOM.createRoot(document.getElementById('root'));
globalThis.renderFixture=(scope,mode='normal')=>{state.scope=scope;state.mode=mode;
 const goal=mode.startsWith('periodic')?{id:'goal-1',revision:1,status:mode==='periodic-paused'?'paused':'active',reviewAttempt:mode==='periodic-no-id'?{state:'uncertain',at:1}:{id:'attempt-1',state:'uncertain',at:1}}:undefined;
 state.currentGoal=goal;
 const refreshGoal=async()=>{state.calls.push({endpoint:'refresh-goal',scope});if(mode==='periodic-refresh-fail')throw Error('offline');const current=mode==='periodic-changed'?{...state.currentGoal,revision:2}:state.currentGoal;return {roomsById:{[scope.id]:{goal:current}}}};
 const currentRoomGoal=id=>id===scope.id?state.currentGoal:undefined;
 const resolveReview=async(goalId,reviewId)=>{state.calls.push({endpoint:'review-resolve',scope,payload:{goalId,reviewId}});if(mode==='periodic-error')throw Object.assign(Error('stale'),{code:'bot/stale'});if(mode==='periodic-network')throw Error('offline')};
 root.render(h(TaskBoard,{scope,title:'Board',goal,initialReview:mode.startsWith('periodic'),refreshGoal,currentRoomGoal,resolveReview,close:()=>{state.closed=(state.closed??0)+1},request}))};
globalThis.clearFixture=()=>ReactDOM.flushSync(()=>root.render(null));
`
const bundle = await build({ stdin: { contents: entry, resolveDir: dirname(boardEntry), sourcefile: 'board-globalThis.fixture.js' },
  bundle: true, platform: 'browser', format: 'iife', write: false, plugins: [shim] })

async function exerciseColumns(page, rail) {
  const viewport=rail.locator('.bt-board-columns')
  const previous=rail.getByRole('button',{name:/^(Previous columns|上一组列表)$/})
  const next=rail.getByRole('button',{name:/^(Next columns|下一组列表)$/})
  await previous.waitFor();await next.waitFor()
  const measure=()=>viewport.evaluate(el=>{const style=getComputedStyle(el),bar=getComputedStyle(el,'::-webkit-scrollbar');const outer=el.closest('.bt-board-content');return {left:el.scrollLeft,max:el.scrollWidth-el.clientWidth,outerMax:outer?outer.scrollWidth-outer.clientWidth:0,hidden:style.scrollbarWidth==='none'||bar.display==='none'||parseFloat(bar.height)===0}})
  let m=await measure()
  assert.ok(m.max>1,'column rail retains horizontal overflow for navigation')
  assert.equal(m.hidden,true,'horizontal scrollbar is visually hidden')
  assert.ok(m.outerMax<=1,'the surrounding board has no horizontal overflow')
  for(let i=0;i<12&&m.left<m.max-2;i++){await next.click();await page.waitForTimeout(250);m=await measure()}
  assert.ok(m.left>=m.max-2,'next control reaches the last column')
  const lastVisible=await viewport.evaluate(el=>{const r=el.getBoundingClientRect(),c=el.lastElementChild?.getBoundingClientRect();return !!c&&c.right<=r.right+2&&c.left>=r.left-2})
  assert.equal(lastVisible,true,'last column is fully visible at the end')
  for(let i=0;i<12&&m.left>2;i++){await previous.click();await page.waitForTimeout(250);m=await measure()}
  assert.ok(m.left<=2,'previous control returns to the first column')
  const firstVisible=await viewport.evaluate(el=>{const r=el.getBoundingClientRect(),c=el.firstElementChild?.getBoundingClientRect();return !!c&&c.left>=r.left-2&&c.right<=r.right+2})
  assert.equal(firstVisible,true,'first column is fully visible at the start')
}

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
  await page.getByText('Interrupted work').click()
  const recovery = page.locator('.bt-recovery-panel').filter({hasText:'Interrupted work'})
  await recovery.getByText('Alice', {exact:true}).waitFor()
  await recovery.getByText('Bob', {exact:true}).waitFor()
  const recoverySearch = recovery.getByPlaceholder('Filter by Bot or ID')
  await recoverySearch.fill('exchange-2')
  assert.equal(await recovery.locator('.bt-recovery-record').filter({hasText:'session-other'}).count(), 1)
  assert.equal(await recovery.locator('.bt-recovery-record').filter({hasText:'session-original'}).count(), 0)
  await recoverySearch.fill('missing')
  await recovery.getByText('No matching records.').waitFor()
  await recoverySearch.fill('')
  const original = recovery.locator('.bt-recovery-record').filter({hasText:'session-original'})
  await original.locator('summary').click()
  assert.match(await original.innerText(), /Original turn[\s\S]*Unknown/)
  assert.match(await original.innerText(), /exchange-1/)
  await original.getByText('A separate redo record exists. Its execution and result are unknown; the original work remains unresolved.').waitFor()
  assert.doesNotMatch(await recovery.innerText(), /SECRET-HIDDEN/)
  await original.getByRole('button',{name:'Ignore',exact:true}).click()
  const ignored = recovery.locator('details').filter({hasText:'Ignored (1)'}).last()
  await ignored.locator('summary').first().click()
  await ignored.locator('.bt-recovery-record summary').click()
  assert.match(await ignored.innerText(), /does not complete the work/)
  await ignored.getByRole('button',{name:'Undo ignore'}).click()
  await original.locator('summary').click()
  await original.getByText('Redo is not available. You can inspect candidate text without sending it.').waitFor()
  assert.equal(await original.getByRole('button',{name:'Redo',exact:true}).count(),0)
  await original.getByRole('button',{name:'View candidate text'}).click()
  await original.getByText('This text is only a time-matched candidate. Its sender and original outcome are unverified; it is for inspection and cannot be executed directly.').waitFor()
  await original.getByText('This saved snapshot may omit other inputs and may be out of date.').waitFor()
  assert.equal(await original.locator('.bt-recovery-candidate-text').innerText(),'Candidate task\nSecond line')
  await original.locator('summary').click(); await original.locator('summary').click()
  assert.equal(await original.locator('.bt-recovery-candidate-text').count(),0,'closing clears candidate text')
  await page.evaluate(() => { globalThis.fixture.candidateFail = true })
  await original.getByRole('button',{name:'View candidate text'}).click()
  await original.getByRole('alert').getByText('Candidate text is unavailable. The record may be missing, incomplete or changing.').waitFor()
  await page.evaluate(() => { globalThis.fixture.candidateFail = false })
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
  await page.evaluate(() => { globalThis.fixture.recoveryEmpty = false; globalThis.fixture.candidateHold = true; globalThis.renderFixture({ kind:'room', id:'g1' }, 'recovery') })
  const delayedRecovery = page.locator('.bt-recovery-panel').filter({hasText:'Interrupted work'})
  await delayedRecovery.locator('summary').first().click()
  const delayedRecord = delayedRecovery.locator('.bt-recovery-record').filter({hasText:'session-original'})
  await delayedRecord.locator('summary').click(); await delayedRecord.getByRole('button',{name:'View candidate text'}).click()
  await page.waitForFunction(() => typeof globalThis.fixture.resolvers.candidate === 'function')
  await page.evaluate(() => { globalThis.renderFixture({ kind:'personal', id:'a' }, 'normal'); globalThis.fixture.resolvers.candidate(); globalThis.fixture.candidateHold = false })
  await page.getByText('Personal task', {exact:true}).waitFor()
  assert.equal(await page.locator('.bt-recovery-candidate-text').count(),0,'late response must not leak into a different scope')

  await page.evaluate(() => globalThis.renderFixture({ kind:'room', id:'g1' }, 'normal'))
  const decisions = page.locator('.bt-recovery-panel').filter({hasText:'Work decisions'})
  await decisions.locator('summary').first().click()
  await decisions.locator('button[title="work-a"]').click()
  await decisions.getByRole('button',{name:'Ignore',exact:true}).click()
  await decisions.getByText('Ignored',{exact:true}).waitFor()
  await decisions.getByRole('button',{name:'Move back to needs a decision'}).click()
  await decisions.getByRole('button',{name:'Record my acceptance'}).waitFor()
  page.once('dialog', dialog => dialog.accept())
  await decisions.getByRole('button',{name:'Record my acceptance'}).click()
  await decisions.getByText('Accepted by you').waitFor()
  assert.equal(await decisions.getByText('The result remains unknown; this is not independent acceptance.').count(),1)
  assert.deepEqual(await page.evaluate(() => globalThis.fixture.calls.filter(x=>x.endpoint==='legacy-review-decision').map(x=>x.payload.choice)),['ignored','open','user-accepted'])
  assert.equal(await decisions.locator('textarea').count(),0,'no reason or note is required')
  const manual = page.locator('.bt-recovery-panel').filter({hasText:'Manual notes (optional)'})
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
  if (process.env.REVIEW_SCREENSHOT) { await manual.scrollIntoViewIfNeeded(); await page.screenshot({ path:process.env.REVIEW_SCREENSHOT }) }
  await manual.getByRole('button', {name:'Save review note'}).click()
  await manual.getByText('Checked the original session').waitFor()
  assert.equal(await page.evaluate(() => globalThis.fixture.calls.some(x => x.endpoint === 'legacy-review-finding' && x.payload.workId === 'work-b' && x.payload.expectedRevision === 1)), true)

  await page.evaluate(() => globalThis.renderFixture({ kind:'room', id:'g5' }, 'review-slow'))
  await page.waitForFunction(() => globalThis.fixture.calls.some(x => x.endpoint === 'board-list' && x.payload.scope.id === 'g5'))
  const slowReview = page.locator('.bt-recovery-panel').filter({hasText:'Manual notes (optional)'})
  await slowReview.locator('summary').first().click()
  await slowReview.getByRole('button', {name:'work-a'}).waitFor()
  await slowReview.getByRole('button', {name:'work-b'}).waitFor()
  await page.evaluate(() => {
    const panel = [...document.querySelectorAll('.bt-recovery-panel')].find(el => el.textContent.includes('Manual notes (optional)'))
    const buttons = [...panel.querySelectorAll('button')]
    buttons.find(button => button.textContent === 'work-a').click()
    buttons.find(button => button.textContent === 'work-b').click()
  })
  await page.waitForFunction(() => typeof globalThis.fixture.resolvers['review:g5:work-a'] === 'function')
  const simultaneous = await page.evaluate(() => globalThis.fixture.calls.filter(x => x.endpoint === 'legacy-review-get' && x.payload.scope.id === 'g5').map(x => x.payload.workId))
  assert.deepEqual(simultaneous, ['work-a'], 'a second candidate cannot start while the first request is pending')
  await page.evaluate(() => globalThis.renderFixture({ kind:'room', id:'g6' }, 'normal'))
  await page.waitForFunction(() => globalThis.fixture.calls.some(x => x.endpoint === 'board-list' && x.payload.scope.id === 'g6'))
  const nextReview = page.locator('.bt-recovery-panel').filter({hasText:'Manual notes (optional)'})
  await nextReview.locator('summary').first().click()
  await nextReview.getByRole('button', {name:'work-b'}).click()
  await nextReview.getByRole('button', {name:'Create review'}).waitFor()
  await page.evaluate(() => globalThis.fixture.resolvers['review:g5:work-a']())
  await page.waitForTimeout(50)
  assert.equal(await nextReview.getByLabel('Original work ID').inputValue(), 'work-b')
  assert.equal(await nextReview.getByRole('button', {name:'Create review'}).count(), 1, 'late response from another group must not replace this review')
  assert.equal(await nextReview.getByText('Work identity unverified').count(), 0)

  await page.evaluate(() => globalThis.renderFixture({ kind:'room', id:'g7' }, 'review-invalid-list'))
  await page.waitForFunction(() => globalThis.fixture.calls.some(x => x.endpoint === 'board-list' && x.payload.scope.id === 'g7'))
  const invalidReview = page.locator('.bt-recovery-panel').filter({hasText:'Manual notes (optional)'})
  await invalidReview.locator('summary').first().click()
  await invalidReview.getByRole('alert').getByText('Review sources are unavailable.').waitFor()
  assert.equal(await invalidReview.getByText('No work awaiting inspection.').count(), 0, 'unreadable sources are not an empty list')

  await page.evaluate(() => { globalThis.fixture.reviewSaved=false; globalThis.fixture.reviewReceipt=false; globalThis.renderFixture({ kind:'room', id:'g8' }, 'review-lost') })
  await page.waitForFunction(() => globalThis.fixture.calls.some(x => x.endpoint === 'board-list' && x.payload.scope.id === 'g8'))
  const lostReview = page.locator('.bt-recovery-panel').filter({hasText:'Manual notes (optional)'})
  await lostReview.locator('summary').first().click()
  await lostReview.getByRole('button', {name:'work-a'}).click()
  await lostReview.getByRole('button', {name:'Create review'}).click()
  await lostReview.getByLabel('Review note', {exact:true}).fill('A verified result')
  await lostReview.getByRole('button', {name:'Save review note'}).click()
  await lostReview.getByRole('alert').getByText('Action outcome is unknown; check it before making another change.').waitFor()
  assert.equal(await lostReview.getByRole('button', {name:'Save review note'}).isDisabled(), true)
  assert.equal(await lostReview.locator('.bt-recovery-form textarea').first().inputValue(), 'A verified result')
  await lostReview.getByRole('button', {name:'Check',exact:true}).click()
  await lostReview.getByText('Evidence still needed').waitFor()
  assert.equal(await lostReview.locator('.bt-recovery-form textarea').first().inputValue(), 'A verified result', 'rechecking must retain the local draft')
  assert.equal(await lostReview.getByRole('button', {name:'Save review note'}).isDisabled(), true, 'a newer revision without a receipt must not enable another save')
  assert.equal(await page.evaluate(() => JSON.stringify(localStorage).includes('A verified result')), false, 'pending markers must not contain note content')
  await page.evaluate(() => globalThis.renderFixture({ kind:'room', id:'g9' }, 'review-lost'))
  const switchedReview = page.locator('.bt-recovery-panel').filter({hasText:'Manual notes (optional)'})
  await switchedReview.locator('summary').first().click()
  await switchedReview.getByRole('button', {name:'work-a'}).click()
  await switchedReview.getByText('Evidence still needed').waitFor()
  assert.equal(await switchedReview.getByRole('button', {name:'Save review note'}).isDisabled(), true, 'switching scope must not bypass the original pending operation')
  await page.evaluate(() => { globalThis.fixture.reviewReceipt=true })
  await switchedReview.getByRole('button', {name:'Check',exact:true}).click()
  await switchedReview.getByText('Evidence still needed').waitFor()
  assert.equal(await switchedReview.getByRole('button', {name:'Save review note'}).isDisabled(), true, 'a confirmed old operation does not resubmit the note')
  assert.equal(await page.evaluate(() => globalThis.fixture.calls.filter(x => x.endpoint==='legacy-review-finding' && x.payload.workId==='work-a' && x.payload.scope.id==='g8').length), 1)

  await page.evaluate(() => globalThis.renderFixture({ kind:'room', id:'g1' }, 'periodic'))
  const periodic = page.locator('.bt-periodic-review')
  await periodic.getByText('This only resumes periodic inspections; it does not approve or complete tasks.').waitFor()
  await periodic.getByText('The server also checks the group and administrator sessions for pending work, approvals and subagents.').waitFor()
  const resume = periodic.getByRole('button', {name:'Allow future inspections'})
  await periodic.getByText('Current status checked').waitFor()
  assert.equal(await resume.isEnabled(), true, 'an exact refreshed attempt permits an explicit decision')
  if (process.env.PERIODIC_SCREENSHOT) { await periodic.scrollIntoViewIfNeeded(); await page.screenshot({ path:process.env.PERIODIC_SCREENSHOT }) }
  assert.equal(await periodic.getByLabel('What did you verify?').count(), 0, 'no explanation is required')
  await periodic.getByRole('button', {name:'Refresh status'}).click()
  await resume.click()
  await periodic.getByText(/Request accepted/).waitFor()
  assert.equal(await page.evaluate(() => globalThis.fixture.calls.filter(x => x.endpoint === 'review-resolve').length), 1)
  assert.deepEqual(await page.evaluate(() => globalThis.fixture.calls.find(x => x.endpoint === 'review-resolve').payload), {goalId:'goal-1',reviewId:'attempt-1'})
  assert.equal(await page.evaluate(() => globalThis.fixture.calls.find(x => x.endpoint === 'review-resolve').scope.id), 'g1')

  await page.evaluate(() => globalThis.renderFixture({ kind:'room', id:'g2' }, 'periodic-error'))
  const refused = page.locator('.bt-periodic-review')
  await refused.getByText('g2', {exact:true}).waitFor()
  await refused.getByRole('button', {name:'Refresh status'}).click()
  await refused.getByRole('button', {name:'Allow future inspections'}).click()
  await refused.getByRole('alert').getByText('The goal changed or related work is still pending. Check it before recovery.').waitFor()
  assert.equal(await refused.getByRole('button', {name:'Allow future inspections'}).isDisabled(), true)

  await page.evaluate(() => globalThis.renderFixture({ kind:'room', id:'g3' }, 'periodic-paused'))
  const paused = page.locator('.bt-periodic-review')
  await paused.getByText('g3', {exact:true}).waitFor()
  await paused.getByText('The group goal must be active before reviews can resume.').waitFor()
  assert.equal(await paused.getByRole('button', {name:'Allow future inspections'}).isDisabled(), true)

  await page.evaluate(() => globalThis.renderFixture({ kind:'room', id:'g4' }, 'periodic-network'))
  const unknown = page.locator('.bt-periodic-review')
  await unknown.getByText('g4', {exact:true}).waitFor()
  await unknown.getByRole('button', {name:'Refresh status'}).click()
  const priorAttempts = await page.evaluate(() => globalThis.fixture.calls.filter(x => x.endpoint === 'review-resolve').length)
  await unknown.getByRole('button', {name:'Allow future inspections'}).click()
  await unknown.getByRole('alert').getByText('Action outcome is unknown; check it before making another change.').waitFor()
  assert.equal(await unknown.getByRole('button', {name:'Allow future inspections'}).isDisabled(), true)
  assert.equal(await page.evaluate(() => globalThis.fixture.calls.filter(x => x.endpoint === 'review-resolve').length), priorAttempts + 1, 'an uncertain request is not repeated automatically')

  await page.evaluate(() => globalThis.renderFixture({ kind: 'personal', id: 'user' }, 'capacity'))
  await page.getByText('Instance task capacity: 1000 / 1000').waitFor()
  await page.getByText('Task limit reached. New tasks cannot be created.').waitFor()
  assert.equal(await page.getByRole('button', {name:'Create task'}).isDisabled(), true)
  await page.evaluate(() => globalThis.renderFixture({ kind: 'room', id: 'g1' }, 'readonly'))
  await page.getByRole('heading', { name: 'Awaiting review 1' }).waitFor()
  await exerciseColumns(page,page.locator('.bt-board-rail').first())
  assert.equal(await page.locator('[aria-label="Done"] article').count(), 0, 'reported must not be displayed as done')
  assert.equal(await page.getByRole('button', { name: 'Create task' }).count(), 0, 'missing capability is read only')
  assert.equal(await page.getByText('Instance task capacity: 1000 / 1000').count(), 0, 'capacity is not shown when the host omits it')
  await page.locator('article').filter({hasText:'Group task'}).locator('.bt-board-card-summary').click()
  await page.locator('.bt-card-modal').waitFor()
  assert.equal(await page.locator('.bt-card-modal').getByText('Read only').count(), 1)
  assert.match(await page.locator('.bt-card-modal .bt-board-fact').filter({hasText:'Owner'}).innerText(), /\ba\b/, 'missing actor name falls back to ID')
  await page.waitForFunction(() => {const imgs=[...document.querySelectorAll('.bt-board-photo img')];return imgs.length===2&&imgs.every(img=>img.complete&&img.naturalWidth===2&&img.naturalHeight===2)})
  await page.getByText('Image unavailable').waitFor()
  assert.equal(await page.evaluate(() => globalThis.fixture.calls.some(x => x.endpoint === 'board-image' && x.payload.scope.id === 'g1' && x.payload.taskId === 'T1')), true)

  await page.evaluate(() => globalThis.renderFixture({ kind: 'personal', id: 'a' }, 'normal'))
  await page.getByText('Personal task', { exact: true }).waitFor()
  assert.equal(await page.getByText('Group task', { exact: true }).count(), 0, 'group data must not persist in another scope')
  const namedCardTrigger = page.locator('article').filter({hasText:'Personal task'}).locator('.bt-board-card-summary')
  await namedCardTrigger.click()
  const namedCard = page.locator('.bt-card-modal')
  await namedCard.waitFor()
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
  await namedCard.getByLabel('Add a comment').fill('Personal board comment')
  await namedCard.getByRole('button',{name:'Post comment'}).click()
  await page.waitForFunction(()=>globalThis.fixture.calls.some(x=>x.endpoint==='board-command'&&x.payload.type==='card-comment'))
  const personalComment=await page.evaluate(()=>globalThis.fixture.calls.find(x=>x.endpoint==='board-command'&&x.payload.type==='card-comment'))
  assert.equal(personalComment.payload.value.text,'Personal board comment')
  assert.match(await namedCard.locator('.bt-board-fact').filter({hasText:'Owner'}).innerText(), /Alice/)
  assert.match(await namedCard.locator('.bt-board-fact').filter({hasText:'Reviewer'}).innerText(), /Bob/)
  await page.keyboard.press('Escape')
  await namedCard.waitFor({state:'detached'})
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
  await shared.locator('.bt-board-card-summary').click()
  const sharedModal=page.locator('.bt-card-modal')
  await sharedModal.waitFor()
  assert.equal(await sharedModal.getByRole('button', {name:'Edit task'}).count(), 0, 'a shared task cannot be edited even if a bad capability is sent')
  assert.equal(await sharedModal.getByRole('button', {name:'Share with group'}).count(), 0)
  await page.keyboard.press('Escape')
  await sharedModal.waitFor({state:'detached'})
  await namedCardTrigger.click()
  await namedCard.waitFor()
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
  await namedCard.getByText('An action needs confirmation.').waitFor()
  const shareCount = await page.evaluate(() => globalThis.fixture.calls.filter(x => x.endpoint==='board-command' && x.payload.type==='share').length)
  await namedCard.getByRole('button', {name:'Check action'}).click()
  assert.equal(await page.evaluate(() => globalThis.fixture.calls.filter(x => x.endpoint==='board-command' && x.payload.type==='share').length), shareCount, 'checking an uncertain share must not resend it')
  await namedCard.getByRole('button', {name:'Safely cancel pending request'}).click()
  await namedCard.getByText('An action needs confirmation.').waitFor({state:'hidden'})
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
  await namedCard.getByText('Interlaced PNG is not supported').waitFor()
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
  await page.keyboard.press('Escape')
  await namedCard.waitFor({state:'detached'})
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
  await page.locator('[aria-label="To do"] article .bt-board-card-summary').click()
  await page.locator('.bt-card-modal').waitFor()
  await page.getByLabel('Move personal task').focus()
  await page.keyboard.press('ArrowDown')
  await page.locator('[aria-label="Doing"] article').getByText('Personal task',{exact:true}).waitFor()
  const move = await page.evaluate(() => globalThis.fixture.calls.find(x=>x.endpoint==='board-command'&&x.payload.type==='personal-progress'))
  assert.equal(move.payload.value.progress,'doing')
  assert.ok(move.payload.operationId)
  assert.equal(await page.evaluate(id=>globalThis.fixture.calls.some(x=>x.endpoint==='board-operation'&&x.payload.operationId===id),move.payload.operationId),true)
  await page.keyboard.press('Escape')
  await page.locator('.bt-card-modal').waitFor({state:'detached'})
  await page.locator('[aria-label="Doing"] article').dragTo(page.locator('[aria-label="Personally finished"]'))
  await page.locator('[aria-label="Personally finished"] article').getByText('Personal task',{exact:true}).waitFor()
  await page.getByLabel('Search tasks').fill('no matching title')
  assert.equal(await page.getByText('Personal task',{exact:true}).count(),0)
  await page.getByLabel('Search tasks').fill('')
  await page.locator('[aria-label="Personally finished"] article').getByText('Personal task',{exact:true}).waitFor()

  await page.evaluate(() => globalThis.renderFixture({kind:'room',id:'g1'},'legacy'))
  await page.getByText('Legacy task', {exact:true}).waitFor()
  await page.getByText('Goal card details can be corrected without changing the original task or acceptance record.').waitFor()
  await page.locator('article').filter({hasText:'Legacy task'}).locator('.bt-board-card-summary').click()
  const legacy = page.locator('.bt-card-modal')
  await legacy.waitFor()
  assert.match(await legacy.innerText(), /Current goal task/)
  await legacy.getByRole('button',{name:'Edit card details'}).click()
  await legacy.getByLabel('Description',{exact:true}).fill('Original goal notes')
  await legacy.getByLabel('Labels, one per line').fill('UX')
  await legacy.getByRole('button',{name:'Save changes'}).click()
  await page.waitForFunction(()=>globalThis.fixture.calls.some(x=>x.endpoint==='board-command'&&x.payload.type==='goal-card-details'))
  const goalDetails=await page.evaluate(()=>globalThis.fixture.calls.find(x=>x.endpoint==='board-command'&&x.payload.type==='goal-card-details'))
  assert.match(goalDetails.payload.operationId,/^goal:/)
  assert.equal(goalDetails.payload.value.description,'Original goal notes')
  await legacy.getByLabel('Add a comment').fill('Goal comment')
  await legacy.getByRole('button',{name:'Post comment'}).click()
  await page.waitForFunction(()=>globalThis.fixture.calls.some(x=>x.endpoint==='board-command'&&x.payload.type==='goal-card-comment'))
  const goalComment=await page.evaluate(()=>globalThis.fixture.calls.find(x=>x.endpoint==='board-command'&&x.payload.type==='goal-card-comment'))
  assert.match(goalComment.payload.operationId,/^goal:/)
  assert.equal(goalComment.payload.value.text,'Goal comment')
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

  for (const [position, label] of [['previous','Earlier goal stage'],['future','Upcoming goal stage'],['archived','Archived goal task']]) {
    await page.evaluate(position => { globalThis.fixture.historyTitle=undefined;globalThis.fixture.historyRevision=0;globalThis.fixture.historyAudit=[];globalThis.renderFixture({kind:'room',id:'history-'+position},'history-'+position) }, position)
    await page.locator('article').filter({hasText:'Original historical task'}).locator('.bt-board-card-summary').click()
    const history=page.locator('.bt-card-modal')
    await history.getByText(label,{exact:true}).waitFor()
    await history.getByText('Original task description',{exact:true}).waitFor()
    assert.equal(await history.getByRole('button',{name:'Edit goal task'}).count(),0,'historical card cannot alter original workflow')
    await history.getByRole('button',{name:'Correct card title'}).click()
    await history.getByLabel('Card display title').fill('Corrected '+position)
    await history.getByLabel('Reason for correction').fill('Clarify accepted work')
    await history.getByRole('button',{name:'Save changes'}).click()
    await page.waitForFunction(position=>globalThis.fixture.calls.some(x=>x.endpoint==='board-command'&&x.payload.type==='goal-history-title'&&x.payload.expectedPosition===position),position)
    const correction=await page.evaluate(position=>globalThis.fixture.calls.find(x=>x.endpoint==='board-command'&&x.payload.type==='goal-history-title'&&x.payload.expectedPosition===position),position)
    assert.equal(correction.payload.expectedRevision,5)
    assert.equal(correction.payload.expectedBoardRevision,0)
    assert.deepEqual(correction.payload.value,{title:'Corrected '+position,reason:'Clarify accepted work'})
    await history.getByText('Corrected '+position,{exact:true}).waitFor()
    await history.getByText('Original historical task',{exact:true}).waitFor()
    await history.getByText('Card revision history',{exact:true}).click()
    await history.getByText('Clarify accepted work',{exact:true}).waitFor()
    await page.keyboard.press('Escape')
    await history.waitFor({state:'detached'})
  }

  await page.evaluate(() => globalThis.renderFixture({kind:'personal',id:'a'},'normal'))
  await page.getByText('Personal task', { exact:true }).waitFor()
  const previousVisible = await page.evaluate(() => { globalThis.ReactDOM.flushSync(()=>globalThis.renderFixture({kind:'room',id:'g1'},'slow')); return document.querySelector('.bt-board-dialog')?.textContent.includes('Personal task') })
  assert.equal(previousVisible,false,'a scope change must immediately hide the previous scope')
  await page.evaluate(() => { sessionStorage.clear(); globalThis.renderFixture({kind:'room',id:'g1'},'slow'); setTimeout(()=>globalThis.renderFixture({kind:'personal',id:'a'},'normal'),20) })
  await page.getByText('Personal task', { exact:true }).waitFor()
  await page.waitForTimeout(600)
  assert.equal(await page.getByText('Group task', { exact:true }).count(), 0, 'late response must not overwrite the new board')

  // A committed receipt does not make the old board revision safe for another
  // command. A failed refresh must keep the original ID and file input fenced.
  await page.evaluate(()=>{globalThis.fixture.calls=[];globalThis.fixture.boardPlans['personal:a']=[{id:'after-commit-fails',mode:'fail'}]})
  const openReceiptCard=async title=>{
    await page.locator('article').filter({hasText:title}).locator('.bt-board-card-summary').click()
    const modal=page.locator('.bt-card-modal');await modal.waitFor();return modal
  }
  let receiptModal=await openReceiptCard('Personal task')
  await receiptModal.getByRole('button',{name:'Edit card details'}).click()
  await receiptModal.getByLabel('Description',{exact:true}).fill('Committed but refresh failed')
  await receiptModal.getByRole('button',{name:'Save changes'}).click()
  await page.waitForFunction(()=>globalThis.fixture.boardStarted.includes('after-commit-fails'))
  await receiptModal.getByText('An action needs confirmation.').waitFor()
  const committedId=await page.evaluate(()=>sessionStorage.getItem('ds-bot:board-pending:personal:a'))
  assert.ok(committedId,'the original operation ID remains durable after the failed board read')
  assert.equal(await page.evaluate(id=>globalThis.fixture.calls.some(x=>x.endpoint==='board-operation'&&x.payload.operationId===id),committedId),true,'the operation receipt was checked')
  assert.equal(await receiptModal.locator('input[type=file]').isDisabled(),true,'file upload remains fenced while the board is stale')
  await page.evaluate(()=>{globalThis.fixture.boardPlans['personal:a']=[{id:'retry-refresh',mode:'hold'}]})
  await receiptModal.getByRole('button',{name:'Check action'}).click()
  await page.waitForFunction(()=>globalThis.fixture.boardStarted.includes('retry-refresh'))
  assert.equal(await page.evaluate(()=>sessionStorage.getItem('ds-bot:board-pending:personal:a')),committedId)
  assert.equal(await receiptModal.locator('input[type=file]').isDisabled(),true,'a pending refreshed snapshot cannot release the fence')
  assert.equal(await page.evaluate(id=>globalThis.fixture.calls.filter(x=>x.endpoint==='board-operation'&&x.payload.operationId===id).length>=2,committedId),true,'Check queries the same operation ID')
  assert.equal(await page.evaluate(id=>globalThis.fixture.calls.filter(x=>x.endpoint==='board-command'&&x.payload.operationId===id).length,committedId),1,'Check does not replay the command')
  await page.evaluate(()=>globalThis.fixture.resolvers['board:retry-refresh'](true))
  await page.waitForFunction(()=>sessionStorage.getItem('ds-bot:board-pending:personal:a')===null)
  await page.waitForFunction(()=>document.querySelector('.bt-card-modal input[type=file]')?.disabled===false)
  assert.equal(await receiptModal.locator('input[type=file]').isDisabled(),false)
  await page.keyboard.press('Escape');await receiptModal.waitFor({state:'detached'})

  // A manual Refresh may supersede the committed receipt's older load. The
  // older response cannot release the operation while the latest load is held.
  await page.evaluate(()=>{globalThis.fixture.calls=[];globalThis.fixture.boardPlans['personal:a']=[{id:'older-load',mode:'hold'},{id:'newer-load',mode:'hold'}]})
  receiptModal=await openReceiptCard('Personal task')
  await receiptModal.getByRole('button',{name:'Edit card details'}).click()
  await receiptModal.getByLabel('Description',{exact:true}).fill('Receipt with competing refresh')
  await receiptModal.getByRole('button',{name:'Save changes'}).click()
  await page.waitForFunction(()=>globalThis.fixture.boardStarted.includes('older-load'))
  const racingId=await page.evaluate(()=>sessionStorage.getItem('ds-bot:board-pending:personal:a'))
  assert.ok(racingId)
  await page.keyboard.press('Escape');await receiptModal.waitFor({state:'detached'})
  await page.evaluate(()=>{globalThis.fixture.revision=2;globalThis.fixture.boardTitles['personal:a']='Fresh snapshot task'})
  await page.getByRole('button',{name:'Refresh',exact:true}).click()
  await page.waitForFunction(()=>globalThis.fixture.boardStarted.includes('newer-load'))
  await page.evaluate(async()=>{globalThis.fixture.resolvers['board:older-load'](true);await new Promise(resolve=>setTimeout(resolve,0))})
  assert.equal(await page.evaluate(()=>sessionStorage.getItem('ds-bot:board-pending:personal:a')),racingId,'superseded response cannot clear pending')
  await page.evaluate(()=>globalThis.fixture.resolvers['board:newer-load'](true))
  await page.getByText('Fresh snapshot task',{exact:true}).waitFor()
  if(await page.getByText('An action needs confirmation.').isVisible())await page.getByRole('button',{name:'Check action'}).click()
  await page.waitForFunction(()=>sessionStorage.getItem('ds-bot:board-pending:personal:a')===null)

  // A late response for the old scope cannot touch a different scope's marker
  // or enable its controls, even if both scopes have unsettled receipts.
  await page.evaluate(()=>{globalThis.fixture.calls=[];globalThis.fixture.boardPlans['personal:a']=[{id:'scope-a-late',mode:'hold'}]})
  receiptModal=await openReceiptCard('Fresh snapshot task')
  await receiptModal.getByRole('button',{name:'Edit card details'}).click()
  await receiptModal.getByLabel('Description',{exact:true}).fill('Old scope late response')
  await receiptModal.getByRole('button',{name:'Save changes'}).click()
  await page.waitForFunction(()=>globalThis.fixture.boardStarted.includes('scope-a-late'))
  const oldScopeId=await page.evaluate(()=>sessionStorage.getItem('ds-bot:board-pending:personal:a'))
  assert.ok(oldScopeId)
  const newScopeId='scope-b-pending-operation'
  await page.evaluate(id=>{sessionStorage.setItem('ds-bot:board-pending:room:g2',id);globalThis.fixture.receiptPlans[id]={id:'scope-b-receipt'};globalThis.renderFixture({kind:'room',id:'g2'},'normal')},newScopeId)
  await page.waitForFunction(()=>globalThis.fixture.receiptStarted.includes('scope-b-receipt'))
  await page.getByText('Personal task',{exact:true}).waitFor()
  const newModal=await openReceiptCard('Personal task')
  assert.equal(await newModal.locator('input[type=file]').isDisabled(),true)
  await page.evaluate(async()=>{globalThis.fixture.resolvers['board:scope-a-late'](true);await new Promise(resolve=>setTimeout(resolve,0))})
  assert.equal(await page.evaluate(()=>sessionStorage.getItem('ds-bot:board-pending:room:g2')),newScopeId,'old-scope result cannot clear the new scope ID')
  assert.equal(await page.evaluate(()=>sessionStorage.getItem('ds-bot:board-pending:personal:a')),oldScopeId,'old scope keeps its own unresolved UI marker')
  assert.equal(await newModal.locator('input[type=file]').isDisabled(),true,'old-scope response cannot enable new-scope uploads')
  await page.evaluate(()=>{globalThis.fixture.boardPlans['room:g2']=[{id:'scope-b-fresh',mode:'hold'}];globalThis.fixture.resolvers['receipt:scope-b-receipt']()})
  await page.waitForFunction(()=>globalThis.fixture.boardStarted.includes('scope-b-fresh'))
  assert.equal(await newModal.locator('input[type=file]').isDisabled(),true)
  await page.evaluate(()=>globalThis.fixture.resolvers['board:scope-b-fresh'](true))
  await page.waitForFunction(()=>sessionStorage.getItem('ds-bot:board-pending:room:g2')===null)
  assert.equal(await newModal.locator('input[type=file]').isDisabled(),false)
  await page.evaluate(()=>{globalThis.fixture.boardTitles={};globalThis.fixture.revision=1;globalThis.renderFixture({kind:'personal',id:'a'},'normal')})
  await page.getByText('Personal task',{exact:true}).waitFor()
  await page.waitForFunction(()=>sessionStorage.getItem('ds-bot:board-pending:personal:a')===null)

  await page.setViewportSize({ width: 375, height: 700 })
  const box = await page.locator('.bt-board-dialog').boundingBox()
  assert.ok(box && box.width <= 375, 'board must fit a narrow viewport')
  await exerciseColumns(page,page.locator('.bt-board-rail').first())
  const mobileTrigger=page.locator('article').filter({hasText:'Personal task'}).locator('.bt-board-card-summary')
  await mobileTrigger.click()
  const mobileModal=page.locator('.bt-card-modal')
  await mobileModal.waitFor()
  assert.equal(await mobileModal.getAttribute('role'),'dialog')
  assert.equal(await mobileModal.getAttribute('aria-modal'),'true')
  const mobileBox=await mobileModal.boundingBox()
  assert.ok(mobileBox && mobileBox.width<=375 && mobileBox.height<=700, 'card detail must fit the mobile viewport')
  const scrollable=await mobileModal.evaluate(root=>[root,...root.querySelectorAll('*')].some(el=>el.scrollHeight>el.clientHeight+1&&['auto','scroll'].includes(getComputedStyle(el).overflowY)))
  assert.equal(scrollable,true,'long mobile card details must scroll within the modal')
  await page.evaluate(()=>{const button=document.createElement('button');button.id='shell-focus-probe';document.body.append(button);button.focus()})
  assert.equal(await mobileModal.evaluate(el=>el.contains(document.activeElement)),true,'host focus changes must not escape the active card dialog')
  await page.evaluate(()=>{document.activeElement?.blur();document.getElementById('shell-focus-probe')?.remove()})
  for(const key of ['Tab','Tab','Shift+Tab']) {
    await page.keyboard.press(key)
    assert.equal(await mobileModal.evaluate(el=>el.contains(document.activeElement)),true,`${key} stays in the card dialog`)
  }
  const closeCard=mobileModal.locator('[data-close-card]')
  await closeCard.focus()
  await page.keyboard.press('Shift+Tab')
  assert.equal(await mobileModal.evaluate(el=>el.contains(document.activeElement)),true,'Shift+Tab wraps inside the card dialog')
  assert.equal(await closeCard.evaluate(el=>el===document.activeElement),false,'Shift+Tab wraps away from first control')
  await page.keyboard.press('Tab')
  assert.equal(await closeCard.evaluate(el=>el===document.activeElement),true,'Tab wraps to the first control')
  await page.keyboard.press('Escape')
  await mobileModal.waitFor({state:'detached'})
  await page.waitForFunction(el=>document.activeElement===el,await mobileTrigger.elementHandle())
  assert.equal(await page.locator('.bt-board-dialog').count(),1,'first Escape leaves the board open')
  await page.keyboard.press('Escape')
  await page.locator('.bt-board-backdrop').waitFor({state:'detached'})
  assert.equal(await page.evaluate(()=>globalThis.fixture.closed),1,'second Escape closes the board')
  await page.evaluate(()=>globalThis.clearFixture())
  await page.evaluate(()=>globalThis.renderFixture({kind:'personal',id:'a'},'normal'))
  await page.getByText('Personal task',{exact:true}).waitFor()
  await page.keyboard.press('Tab')
  assert.equal(await page.evaluate(() => document.querySelector('.bt-board-dialog').contains(document.activeElement)), true, 'keyboard focus remains in the dialog')
  await page.getByRole('button', {name:'Close',exact:true}).click()
  await page.locator('.bt-board-backdrop').waitFor({state:'detached'})
  assert.equal(await page.evaluate(()=>globalThis.listenerCount()),0,'close must remove its keyboard listener')
  assert.equal(await page.evaluate(()=>globalThis.fixture.closed),2)
  await page.evaluate(()=>globalThis.clearFixture())
  await page.evaluate(()=>globalThis.renderFixture({kind:'room',id:'g1'},'normal'))
  await page.getByText('Group task',{exact:true}).waitFor()
  await page.keyboard.press('Escape')
  await page.locator('.bt-board-backdrop').waitFor({state:'detached'})
  assert.equal(await page.evaluate(()=>globalThis.listenerCount()),0,'Escape must remove its keyboard listener')
  assert.equal(await page.evaluate(()=>globalThis.fixture.closed),3)
  await page.evaluate(()=>globalThis.clearFixture())
  await page.evaluate(()=>globalThis.renderFixture({kind:'room',id:'g1'},'normal'))
  await page.getByText('Group task',{exact:true}).waitFor()
  await page.evaluate(()=>globalThis.clearFixture())
  await page.locator('.bt-board-backdrop').waitFor({state:'detached'})
  assert.equal(await page.evaluate(()=>globalThis.listenerCount()),0,'host unmount must remove keyboard listener')
  assert.deepEqual(errors, [])
  console.log('PASS board images, legacy cards, explicit cancellation, late response, reopen, scoped rendering and conflicts')
} finally { await browser.close() }
