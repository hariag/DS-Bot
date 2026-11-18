import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { harnessRequire, playwrightOf, reactDirOf } from './harness-root.mjs'

let assertions = 0
let assertionFailures = 0
for (const name of ['ok', 'equal', 'deepEqual', 'match', 'doesNotMatch']) {
  const original = assert[name]
  assert[name] = (...args) => {
    assertions += 1
    try { return original.apply(assert, args) } catch (error) { assertionFailures += 1; throw error }
  }
}

const dsbot = createRequire(new URL('../package.json', import.meta.url))
// The harness is optional here: the npm-installed dev/harness has no React, so
// BOARD_REACT_DIR supplies React 18's UMD builds and playwright-core the browser.
const web = harnessRequire()
const boardEntry = fileURLToPath(new URL('../src/client/task-board.js', import.meta.url))
const { build } = dsbot('esbuild')
const boardReact = reactDirOf(web)
if (!boardReact) throw new Error('Set BOARD_REACT_DIR to a node_modules directory holding react and react-dom (React 18 with UMD builds), or point DSH_HARNESS at an official DeepSeek Harness source checkout')
const react = join(boardReact, 'umd/react.development.js')
const reactDom = join(boardReact, '../react-dom/umd/react-dom.development.js')
const { chromium } = playwrightOf(web)
const chrome = process.env.CHROME_PATH || (existsSync('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe') ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : undefined)

const shim = {
  name: 'board-fixture',
  setup(b) {
    b.onResolve({ filter: /^(react|react-dom|\.\/api\.js|\.\/i18n\.js)$/ }, x => ({ path: x.path, namespace: 'fixture' }))
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, x => {
      if (x.path === 'react') return { contents: 'export const {createElement,useEffect,useLayoutEffect,useRef,useState}=globalThis.React' }
      if (x.path === 'react-dom') return { contents: 'export const {createPortal,flushSync}=globalThis.ReactDOM' }
      if (x.path.endsWith('i18n.js')) return { contents: 'export const hostText=x=>x;export const dateLocale=()=>"en-US";export const t=(x,v={})=>x.replace(/\\{(\\w+)\\}/g,(_,k)=>String(v[k]??""))' }
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
const state=globalThis.fixture={calls:[],mode:'normal',revision:1,heldDecisions:{},heldRedos:{},queuedDecisions:{},workDecisions:{},scope:{kind:'room',id:'g1'},sealed:new Set(),resolvers:{},boardPlans:{},boardStarted:[],boardFinished:[],receiptPlans:{},receiptStarted:[],boardTitles:{},card:{description:'',labels:[],checklist:[],dueDate:'',dueComplete:false,comments:[],coverImageId:null},shares:[{id:'grant-old',targetRoomId:'g2',fields:['status']}],gallery:[{id:'png',name:'existing.png',mediaType:'image/png'},{id:'jpeg',name:'existing.jpg',mediaType:'image/jpeg'},{id:'bad',name:'broken.png',mediaType:'image/gif'}],created:[],commentSeq:0,phase2Tasks:[],releases:[],proposals:[]};
const canvas=document.createElement('canvas');canvas.width=2;canvas.height=2;canvas.getContext('2d').fillRect(0,0,2,2);
const images={png:{mediaType:'image/png',data:canvas.toDataURL('image/png').split(',')[1]},jpeg:{mediaType:'image/jpeg',data:canvas.toDataURL('image/jpeg').split(',')[1]},bad:{mediaType:'image/gif',data:'YWJj'}};
state.images=images;
function record(scope){const status=state.mode==='schedule'?(state.boardStatus??'proposed'):state.mode==='manual'?'proposed':'reported';const card=state.card;return {id:'T1',title:state.boardTitles[scope.kind+':'+scope.id]??(scope.id==='g1'?'Group task':'Personal task'),description:card.description||'',labels:card.labels,checklist:card.checklist,dueDate:card.dueDate||'',dueComplete:card.dueComplete===true,...(card.coverImageId?{coverImageId:card.coverImageId}:{}),comments:card.comments,owner:state.mode==='manual'?'user':'a',reviewer:'b',acceptance:'Evidence',dependencies:[],revision:state.revision,status,...(state.mode==='schedule'&&status==='ready'?{dispatchState:'accepted'}:{}),...(state.mode==='manual'?{personalProgress:state.progress??'todo'}:{}),shares:state.shares,images:state.gallery}}
globalThis.resetBoardState=()=>{state.calls=[];state.revision=1;state.progress='todo';state.boardStatus='proposed';state.card={description:'',labels:[],checklist:[],dueDate:'',dueComplete:false,comments:[],coverImageId:null};state.shares=[{id:'grant-old',targetRoomId:'g2',fields:['status']}];state.gallery=[{id:'png',name:'existing.png',mediaType:'image/png'},{id:'jpeg',name:'existing.jpg',mediaType:'image/jpeg'},{id:'bad',name:'broken.png',mediaType:'image/gif'}];state.created=[];state.commentSeq=0}
function phase2Commands(task){const commands=[{type:'edit'},{type:'card-details'},{type:'reorder'},{type:'card-comment'}];if(task.status==='draft')commands.push({type:'submit'},{type:'cancel'});else if(task.status==='cancelled')commands.push({type:'restore'});else commands.push({type:'cancel'});if(task.archivedAt)commands.push({type:'unarchive'});else commands.push({type:'archive'});if(!['done','cancelled'].includes(task.status)&&(state.releases??[]).some(release=>['draft','queued'].includes(release.status)))commands.push({type:'release-assign'});return commands}
globalThis.initPhase2=()=>{state.phase2Tasks=[{id:'T1',title:'Phase task',type:'feature',owner:'a',reviewer:'b',acceptance:'Evidence',dependencies:[],revision:1,status:'proposed',comments:[]}];state.releases=[{id:'rel-1',name:'Release one',version:'1.0',status:'draft',revision:1,position:0},{id:'rel-2',name:'Release two',version:'2.0',status:'queued',revision:1,position:1}];state.proposals=[{id:'p1',revision:1,kind:'update',status:'pending',taskId:'T1',taskTitle:'Phase task',proposer:'a',createdAt:1700000000000,note:'Confirm change',before:{title:'Phase task'},after:{title:'Phase task renamed'}}];state.calls=[];state.phase2Reject={id:'p2',revision:1,kind:'update',status:'pending',taskId:'T1',taskTitle:'Phase task',proposer:'b',createdAt:1700000001000,note:'Reject change',before:{type:'bugfix'},after:{type:'test'}}}
async function request(endpoint,payload){
 state.calls.push({endpoint,payload});
 if(endpoint==='board-list'){
  if(state.mode==='phase2'){
   const tasks=state.phase2Tasks.map(task=>({...task}));
   const releases=state.releases.map(release=>({...release,itemCount:tasks.filter(task=>task.releaseId===release.id).length,doneCount:tasks.filter(task=>task.releaseId===release.id&&task.status==='done').length}));
   const proposals=state.proposals.map(proposal=>({...proposal,taskTitle:tasks.find(task=>task.id===proposal.taskId)?.title}));
   const commands=Object.fromEntries(tasks.map(task=>[task.id,phase2Commands(task)]));
   return {tasks,releases,proposals,capabilities:{create:true,upload:false,actors,commands,shareTargets:{}}};
  }
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
  const legacy=state.mode==='legacy'?[{id:'old',title:'Legacy task',owner:'a',revision:1,status:'legacy-pending',legacy:{originalStatus:'pending',current:true,position:'current',goalStatus:'active'}},{id:'old-done',title:'Completed goal task',owner:'b',revision:1,status:'legacy-done',legacy:{originalTitle:'Completed goal task',originalStatus:'done',position:'previous',current:false,goalStatus:'active',useOverlay:true,boardRevision:0}}]:position?[{id:'history',title:state.historyTitle??'Original historical task',owner:'a',revision:5,status:position==='future'?'waiting':'legacy-done',legacy:{originalTitle:'Original historical task',originalStatus:position==='future'?'pending':'done',position,current:false,goalStatus:'active',useOverlay:true,boardRevision:state.historyRevision??0},boardHistory:state.historyAudit??[]}]:[];
  const shared=[{id:'T2',title:'Shared dependency',revision:1,status:'working',shared:true}];
  const created=state.created.filter(item=>item.scope===payload.scope.kind+':'+payload.scope.id).map(item=>item.task);
  return {tasks:[task,...created,...legacy,...shared],remoteChanges:state.mode.startsWith('monitor')&&payload.scope.kind==='personal'&&payload.scope.id==='user'?{status:state.mode==='monitor-denied'?'authorization unavailable':'ok',repository:'example/project',branch:'main',totalEvents:31,earlierUnknown:true,checkedAt:'2026-11-14T00:00:00.000Z',events:state.mode==='monitor-denied'?[]:[{sha:'a'.repeat(40),title:'Update service',author:'Developer',committed_at:'2026-11-14T00:00:00Z',kind:'relevant',paths:['src/index.js']}]}:undefined,recovery:state.mode==='recovery'?{available:true,incomplete:false,deliveriesIncomplete:false,sampledAt:1700000000000,items:state.recoveryEmpty?[]:[{recoveryId:'rec-1',botId:'a',botName:'Alice',sessionId:'session-original',exchangeId:'exchange-1',status:'uncertain',decision:state.heldDecisions['rec-1']?.choice??'open',decisionRevision:state.heldDecisions['rec-1']?.revision??0,redo:{operationId:'attempt-1',status:'unknown'},evidence:'inflight.json'},{recoveryId:'rec-2',botId:'b',botName:'Bob',sessionId:'session-other',exchangeId:'exchange-2',status:'uncertain',decision:'open',decisionRevision:0,redo:{available:false,state:'source-unavailable'},evidence:'inflight.json',secret:'SECRET-HIDDEN'}],deliveries:state.recoveryEmpty?[]:[{recoveryId:'d'.repeat(64),exchangeId:'queued-exchange-1',sessionId:'session-queued',recipientId:'b',recipientName:'Bob',status:'history-unavailable',decision:state.queuedDecisions['d'.repeat(64)]?.choice??'open',decisionRevision:state.queuedDecisions['d'.repeat(64)]?.revision??0,secret:'SECRET-QUEUED'}]}:{available:true,incomplete:false,sampledAt:1700000000000,items:[]},capabilities:state.mode==='readonly'?{}:state.mode==='capacity'?{create:true,actors,taskCount:1000,taskLimit:1000,taskLimitReached:true}:{create:true,upload:true,actors,shareTargets:{T1:[{id:'g2',name:'Design group'}]},commands:{T1:[{type:'edit'},{type:'card-details'},{type:'card-comment'},{type:'card-comment-edit'},{type:'card-comment-delete'},{type:'upload'},{type:'remove-image'},{type:'share'},{type:'unshare'},...(state.mode==='manual'?[{type:'personal-progress'},{type:'reorder'}]:[]),...(state.mode==='schedule'?[{type:'schedule'},{type:'reorder'}]:[])],old:[{type:'goal-task-edit'},{type:'goal-card-details'},{type:'goal-card-comment'},{type:'upload'}],history:[{type:'goal-history-title'},{type:'goal-card-details'},{type:'goal-card-comment'},{type:'upload'}],T2:[{type:'edit'},{type:'share'},{type:'upload'}]}}}
 }
 if(endpoint==='board-held-decision'){state.heldDecisions[payload.recoveryId]={choice:payload.choice,revision:payload.expectedRevision+1};return {decision:payload.choice,revision:payload.expectedRevision+1}}
 if(endpoint==='board-queued-delivery-decision'){state.queuedDecisions[payload.recoveryId]={choice:payload.choice,revision:payload.expectedRevision+1};return {decision:payload.choice,revision:payload.expectedRevision+1}}
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
  if(state.mode==='phase2'&&endpoint==='board-command'){
   const type=payload.type,value=payload.value??{};
   if(type==='create'){
    state.phase2Tasks.push({id:payload.taskId,title:value.title,type:value.type||'feature',owner:value.owner,reviewer:value.reviewer,acceptance:value.acceptance,dependencies:value.dependencies??[],revision:1,status:value.draft?'draft':'proposed',comments:[],...(value.description?{description:value.description}:{}),...(value.parentTaskId?{parentTaskId:value.parentTaskId}:{})});
    return {};
   }
   const task=state.phase2Tasks.find(item=>item.id===payload.taskId);
   if(!task)throw Error('unknown task');
   if(type==='card-details'){
    if(value.type)task.type=value.type;
    if('description' in value)task.description=value.description;
    if('stage' in value)task.stage=value.stage;
   }
   if(type==='submit'||type==='restore')task.status='proposed';
   if(type==='cancel')task.status='cancelled';
   if(type==='archive')task.archivedAt=1700000000000;
   if(type==='unarchive')delete task.archivedAt;
   task.revision++;
   return {};
  }
  if(state.mode==='conflict'){state.revision=2;return {}}
  if(endpoint==='board-upload'){
   for(const image of payload.images??[]){
    const id='upload-'+image.uploadId;
    state.gallery.push({id,name:image.name,mediaType:image.mediaType});
    images[id]={mediaType:image.mediaType,data:image.data};
   }
   state.revision++;
   return {};
  }
  const type=payload.type,value=payload.value??{};
  if(type==='personal-progress')state.progress=value.progress;
  if(type==='schedule')state.boardStatus='ready';
  if(type==='card-details'){
   for(const key of ['description','labels','checklist','dueDate','dueComplete'])if(key in value)state.card[key]=value[key];
   if('coverImageId' in value)state.card.coverImageId=value.coverImageId;
  }
  if(type==='card-comment')state.card.comments=[...state.card.comments,{id:'comment-'+(++state.commentSeq),author:'user',at:1700000000000,text:value.text}];
  if(type==='card-comment-edit')state.card.comments=state.card.comments.map(comment=>comment.id===value.commentId?{...comment,text:value.text}:comment);
  if(type==='card-comment-delete')state.card.comments=state.card.comments.filter(comment=>comment.id!==value.commentId);
  if(type==='remove-image')state.gallery=state.gallery.filter(image=>image.id!==value.imageId);
  if(type==='share')state.shares=[...state.shares,{id:'grant-'+(++state.commentSeq),targetRoomId:value.targetRoomId,fields:value.fields}];
  if(type==='unshare')state.shares=state.shares.filter(share=>share.id!==value.shareId);
  if(type==='create')state.created.push({scope:payload.scope.kind+':'+payload.scope.id,task:{id:payload.taskId,title:value.title,owner:value.owner,reviewer:value.reviewer,acceptance:value.acceptance,dependencies:value.dependencies??[],revision:1,status:value.schedule?'ready':'proposed',description:value.description??'',labels:value.labels??[],checklist:value.checklist??[],dueDate:value.dueDate??'',dueComplete:value.dueComplete===true,comments:[],shares:[],images:[],...(value.personalProgress!==undefined?{personalProgress:value.personalProgress}:{})}});
  if(type==='goal-history-title'){state.historyTitle=value.title;state.historyRevision=(state.historyRevision??0)+1;state.historyAudit=[{operationId:payload.operationId,at:1700000000000,kind:'title',reason:value.reason,before:{title:'Original historical task'},after:{title:value.title}}]}
  state.revision++;
  return {};
 }
 if(endpoint==='board-release-assign'||endpoint==='board-release-remove'){
   const task=state.phase2Tasks.find(item=>item.id===payload.taskId);
   const release=state.releases.find(item=>item.id===payload.releaseId);
   if(!task||!release)throw Error('release task unavailable');
   if(endpoint==='board-release-assign')task.releaseId=release.id; else delete task.releaseId;
   task.revision++;release.revision++;
   return {};
  }
  if(endpoint==='board-release-queue'||endpoint==='board-release-start'||endpoint==='board-release-cancel'){
   const release=state.releases.find(item=>item.id===payload.releaseId);
   if(!release)throw Error('release unavailable');
   release.status=endpoint==='board-release-queue'?'queued':endpoint==='board-release-start'?'running':'cancelled';
   release.revision++;
   return {};
  }
  if(endpoint==='board-proposal-decide'){
   const proposal=state.proposals.find(item=>item.id===payload.proposalId);
   if(!proposal)throw Error('Proposal is unavailable');
   state.proposals=state.proposals.filter(item=>item.id!==payload.proposalId);
   if(payload.proposalId==='p1'&&payload.decision==='confirm'&&state.phase2Reject)state.proposals=[state.phase2Reject];
   return {proposal:{...proposal,status:payload.decision==='confirm'?'confirmed':'rejected'}};
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
globalThis.renderFixture=(scope,mode='normal',fresh=false)=>{state.scope=scope;state.mode=mode;
 const goal=mode.startsWith('periodic')?{id:'goal-1',revision:1,status:mode==='periodic-paused'?'paused':'active',reviewAttempt:mode==='periodic-confirmed'?{id:'attempt-1',state:'uncertain',at:1,terminalFailure:{at:2}}:mode==='periodic-no-id'?{state:'uncertain',at:1}:{id:'attempt-1',state:'uncertain',at:1}}:undefined;
 state.currentGoal=goal;
 const refreshGoal=async()=>{state.calls.push({endpoint:'refresh-goal',scope});if(mode==='periodic-refresh-fail')throw Error('offline');const current=mode==='periodic-changed'?{...state.currentGoal,revision:2}:state.currentGoal;return {roomsById:{[scope.id]:{goal:current}}}};
 const currentRoomGoal=id=>id===scope.id?state.currentGoal:undefined;
 const resolveReview=async(goalId,reviewId)=>{state.calls.push({endpoint:'review-resolve',scope,payload:{goalId,reviewId}});if(mode==='periodic-error')throw Object.assign(Error('stale'),{code:'bot/stale'});if(mode==='periodic-network')throw Error('offline')};
 root.render(h(TaskBoard,{...(fresh?{key:'board-'+(state.renderSeq=(state.renderSeq??0)+1)}:{}),scope,title:scope.id==='hierarchy'?'November delivery':'Board',goal,initialReview:mode.startsWith('periodic'),refreshGoal,currentRoomGoal,resolveReview,close:()=>{state.closed=(state.closed??0)+1},request}))};
globalThis.clearFixture=()=>ReactDOM.flushSync(()=>root.render(null));
`
const bundle = await build({ stdin: { contents: entry, resolveDir: dirname(boardEntry), sourcefile: 'board-globalThis.fixture.js' },
  bundle: true, platform: 'browser', format: 'iife', write: false, plugins: [shim] })

async function exerciseColumns(page, rail) {
  const viewport=rail.locator('.bt-board-columns')
  const previous=rail.getByRole('button',{name:/^(Previous columns|上一组列表)$/})
  const next=rail.getByRole('button',{name:/^(Next columns|下一组列表)$/})
  await previous.waitFor();await next.waitFor()
  const railStatus=rail.locator('.bt-board-rail-status')
  await railStatus.waitFor()
  assert.match(await railStatus.innerText(),/Columns 1–\d+ of \d+/)
  assert.match(await railStatus.innerText(),/more/)
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

async function approveChange(page, dialog) {
  const panel = dialog.locator('.bt-card-confirm').first()
  await panel.waitFor()
  await panel.getByRole('button', { name: 'Confirm', exact: true }).click()
  await panel.waitFor({ state: 'detached' })
}

const browser = await chromium.launch({ ...(chrome ? { executablePath: chrome } : {}), headless: true,
  args: ['--no-sandbox', '--disable-background-networking'] })
async function runBrowserCases() {
  const page = await browser.newPage()
  page.setDefaultTimeout(5000)
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.route('http://localhost:17394/**', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><div id="root"></div>' }))
  await page.goto('http://localhost:17394/')
  await page.addScriptTag({ path: react })
  await page.addScriptTag({ path: reactDom })
  await page.addScriptTag({ content: bundle.outputFiles[0].text })

  const focusStatus = async status => {
    await page.locator('.bt-status-chip[data-status="' + status + '"]').click()
    await page.waitForFunction(value => document.querySelector('.bt-board-focus-lane .bt-board-lane')?.getAttribute('data-stage') === value, status)
  }
  const workflowLane = status => page.locator('.bt-board-focus-lane .bt-board-lane[data-stage="' + status + '"]')
  const statusChip = status => page.locator('.bt-status-chip[data-status="' + status + '"]')

  // A room board renders an execution item in its feature and opens the same
  // full card for the owner or human. Reading the hierarchy needs no extra fetch.
  await page.evaluate(() => {
    globalThis.initPhase2()
    const parent = globalThis.fixture.phase2Tasks[0]
    globalThis.fixture.phase2Tasks.push({...parent,id:'I1',title:'Verify the retry',type:'test',owner:'b',reviewer:'a',
      parentTaskId:parent.id,status:'working',progress:{summary:'Retry covered',next:'Run the offline case'},
      comments:[{id:'milestone',workflowAction:'progress',author:'b',at:1700000000000,text:'Retry covered',next:'Run the offline case'}]})
    globalThis.fixture.phase2Tasks.push({id:'legacy-I2',parentTaskId:parent.id,title:'Existing goal item',owner:'a',revision:1,
      status:'legacy-done',legacy:{originalStatus:'done',position:'previous',goalStatus:'active'}})
    globalThis.renderFixture({kind:'room',id:'hierarchy'},'phase2',true)
  })
  await focusStatus('proposed')
  const parentCard = page.locator('article[data-task-id="T1"]')
  const itemLink = parentCard.locator('[data-item-id="I1"]')
  await itemLink.waitFor()
  assert.equal(await page.locator('article[data-task-id="I1"]').count(),0)
  assert.match(await itemLink.innerText(),/Verify the retry/)
  assert.match(await itemLink.innerText(),/Bob/)
  assert.match(await itemLink.innerText(),/Run the offline case/)
  const boardReads = () => page.evaluate(() => globalThis.fixture.calls.filter(call => call.endpoint === 'board-list').length)
  await parentCard.locator('[data-item-id="legacy-I2"]').click()
  const goalDialog = page.getByRole('dialog',{name:'Existing goal item',exact:true})
  await goalDialog.getByRole('button',{name:'Close card'}).click()
  assert.equal(await page.locator('article[data-task-id="legacy-I2"]').count(),0)
  const readsBefore = await boardReads()
  await itemLink.click()
  const itemDialog = page.getByRole('dialog',{name:'Verify the retry',exact:true})
  await itemDialog.waitFor()
  assert.match(await itemDialog.locator('.bt-card-comments').innerText(),/Retry covered/)
  assert.equal(await itemDialog.locator('.bt-comment').getByRole('button',{name:'Edit',exact:true}).count(),0)
  await itemDialog.locator('[data-item-id="T1"]').click()
  const featureDialog = page.getByRole('dialog',{name:'Phase task',exact:true})
  await featureDialog.getByRole('button',{name:'Create task item'}).click()
  const createItem = page.getByRole('dialog',{name:'Create task item',exact:true})
  assert.equal(await boardReads(),readsBefore)
  await createItem.getByLabel('Title',{exact:true}).fill('Exercise the offline case')
  await createItem.getByLabel('Task type').selectOption('test')
  await createItem.getByLabel('Owner',{exact:true}).selectOption('a')
  await createItem.getByLabel('Independent reviewer').selectOption('b')
  await createItem.getByLabel('Acceptance criteria').fill('Retry succeeds after reconnect')
  await createItem.getByRole('button',{name:'Create card',exact:true}).click()
  await featureDialog.waitFor()
  const itemValue = await page.evaluate(() => globalThis.fixture.calls.find(call => call.endpoint === 'board-command' && call.payload.type === 'create').payload.value)
  assert.equal(itemValue.parentTaskId,'T1'); assert.equal(itemValue.type,'test')
  await featureDialog.getByRole('button',{name:'Close card'}).click()
  await itemLink.waitFor()
  assert.equal(await parentCard.locator('[data-item-id]').count(),3)
  await itemLink.click()
  const stageEditor = itemDialog.locator('.bt-card-stage')
  await stageEditor.getByRole('button',{name:'Set work stage'}).click()
  await stageEditor.getByLabel('Work stage').fill('Release verification')
  await stageEditor.getByRole('button',{name:'Save'}).click()
  const stageConfirmation = itemDialog.getByRole('alertdialog')
  assert.match(await stageConfirmation.innerText(), /Release verification/)
  await stageConfirmation.getByRole('button',{name:'Confirm',exact:true}).click()
  await stageEditor.getByText('Release verification',{exact:true}).waitFor()
  await itemDialog.getByRole('button',{name:'Close card'}).click()
  assert.match(await itemLink.innerText(),/Release verification/)
  const beforeVersions = await boardReads()
  await page.locator('.bt-board-views').getByRole('button',{name:'Release',exact:true}).click()
  const major = page.getByRole('region',{name:'Major version',exact:true})
  assert.match(await major.innerText(), /November delivery/)
  assert.match(await major.innerText(), /1 feature or bugfix cards · 3 task items/)
  const releases = major.getByRole('listitem')
  assert.equal(await releases.count(),2)
  assert.match(await releases.first().innerText(),/Release one[\s\S]*1.0[\s\S]*Draft/)
  assert.match(await releases.nth(1).innerText(),/Release two[\s\S]*2.0[\s\S]*Queued/)
  await releases.nth(1).getByRole('button').click()
  await page.getByRole('dialog',{name:'Release details: Release two'}).waitFor()
  assert.equal(await boardReads(),beforeVersions)

  assert.deepEqual(errors,[])
  if (process.argv.includes('--hierarchy')) return
  await page.evaluate(() => globalThis.clearFixture())

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
  await recovery.getByText('Bob', {exact:true}).first().waitFor()
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
  const queuedDelivery = recovery.locator('.bt-recovery-delivery').filter({hasText:'Bob'})
  await queuedDelivery.getByText('Session history unavailable').waitFor()
  await queuedDelivery.getByText('The relevant Session history could not be read. The same exchange stays held until recovery can check it.').waitFor()
  assert.doesNotMatch(await recovery.innerText(), /SECRET-HIDDEN|SECRET-QUEUED/)
  await queuedDelivery.getByRole('button',{name:'Ignore',exact:true}).click()
  const ignoredQueue = recovery.locator('details').filter({hasText:'Ignored queued messages (1)'})
  await ignoredQueue.locator('summary').click()
  const ignoredDelivery = ignoredQueue.locator('.bt-recovery-delivery').filter({hasText:'Bob'})
  await ignoredDelivery.getByText('Ignoring prevents future automatic recovery and does not complete the work.').waitFor()
  await ignoredDelivery.getByRole('button',{name:'Undo ignore'}).click()
  const deliveryDecision = await page.evaluate(() => globalThis.fixture.calls.filter(call => call.endpoint === 'board-queued-delivery-decision').at(-1))
  assert.deepEqual(deliveryDecision.payload, {scope:{kind:'room',id:'g1'},recoveryId:'d'.repeat(64),expectedRevision:1,choice:'open'})
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
  await page.waitForFunction(() => ![...document.querySelectorAll('.bt-recovery-panel')].some(el => el.textContent.includes('Interrupted work')), null, { timeout:5000 })
  assert.equal(await page.getByText('No interrupted turns in this snapshot.').count(),0,'an empty recovery panel is not left on the board')
  assert.equal(await page.evaluate(() => globalThis.fixture.calls.filter(call => call.endpoint === 'board-list').length), beforeRefresh + 1)
  await page.evaluate(() => globalThis.renderFixture({ kind:'personal', id:'a' }, 'normal'))
  await focusStatus('reported')
  await page.locator('.bt-board-focus-lane article').filter({hasText:'Personal task'}).first().waitFor()
  assert.equal(await page.locator('.bt-board-held-record').count(), 0, 'scope change must not retain old recovery rows')
  await page.evaluate(() => { globalThis.fixture.recoveryEmpty = false; globalThis.fixture.candidateHold = true; globalThis.renderFixture({ kind:'room', id:'g1' }, 'recovery') })
  const delayedRecovery = page.locator('.bt-recovery-panel').filter({hasText:'Interrupted work'})
  await delayedRecovery.locator('summary').first().click()
  const delayedRecord = delayedRecovery.locator('.bt-recovery-record').filter({hasText:'session-original'})
  await delayedRecord.locator('summary').click(); await delayedRecord.getByRole('button',{name:'View candidate text'}).click()
  await page.waitForFunction(() => typeof globalThis.fixture.resolvers.candidate === 'function')
  await page.evaluate(() => { globalThis.renderFixture({ kind:'personal', id:'a' }, 'normal'); globalThis.fixture.resolvers.candidate(); globalThis.fixture.candidateHold = false })
  await focusStatus('reported')
  await page.locator('.bt-board-focus-lane article').filter({hasText:'Personal task'}).first().waitFor()
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

  await page.evaluate(() => globalThis.renderFixture({ kind:'room', id:'g5' }, 'periodic-confirmed'))
  const confirmed = page.locator('.bt-periodic-review')
  await confirmed.getByText('Inspection failed before any administrator tool ran').waitFor()
  assert.equal(await confirmed.getByRole('button', { name:'Allow future inspections' }).count(), 0)

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
  assert.equal((await page.locator('.bt-board-title-row .bt-board-capacity').innerText()).trim(), '1000 / 1000')
  await page.getByText('Task limit reached. New tasks cannot be created.').waitFor()
  const capacityLane = page.locator('.bt-board-columns-personal > [data-stage="todo"]')
  assert.equal(await capacityLane.getByRole('button', {name:'Add card'}).count(), 0, 'a full instance offers no add control')
  assert.equal(await capacityLane.getByRole('button', {name:'Add card to To do'}).count(), 0)
  assert.equal(await page.locator('.bt-board-quick-add').count(), 0, 'a full instance cannot open the quick add composer')
  await page.evaluate(() => globalThis.renderFixture({ kind: 'room', id: 'g1' }, 'readonly'))
  await focusStatus('reported')
  await page.getByRole('heading', { name: 'Awaiting review' }).waitFor()
  const readOnlyLane = workflowLane('reported')
  assert.equal(await readOnlyLane.locator('.bt-board-count').innerText(), '1', 'the lane count is a separate span')
  assert.equal(await page.locator('.bt-card-slot[data-offset="0"] article').count(), 1, 'one task card is in focus')
  assert.equal((await page.locator('.bt-card-stage-count').innerText()).trim(), '1 / 1', 'the card counter reflects the lane')
  assert.equal((await statusChip('done').locator('.bt-status-chip-count').innerText()).trim(), '0', 'reported must not be counted as done')
  assert.equal(await page.locator('.bt-board-lane-add, .bt-board-lane-add-icon, .bt-board-quick-add').count(), 0, 'missing capability is read only')
  assert.equal(await page.getByText('This board is read only.').count(), 1)
  assert.equal(await page.locator('.bt-board-capacity').count(), 0, 'capacity is not shown when the host omits it')
  await page.locator('article').filter({hasText:'Group task'}).locator('.bt-board-card-summary').click()
  const readOnlyModal = page.locator('.bt-card-modal')
  await readOnlyModal.waitFor()
  assert.equal(await readOnlyModal.locator('.bt-card-side > p.bt-card-note').filter({hasText:'Read only'}).count(), 1)
  assert.equal(await readOnlyModal.locator('textarea, input[type=file], select').count(), 0, 'a read only card exposes no editors')
  assert.match(await readOnlyModal.locator('.bt-card-people').innerText(), /\ba\b[\s\S]*Owner/, 'missing actor name falls back to ID')
  await page.waitForFunction(() => {const imgs=[...document.querySelectorAll('.bt-attachment-grid img')];return imgs.length===2&&imgs.every(img=>img.complete&&img.naturalWidth===2&&img.naturalHeight===2)})
  await readOnlyModal.getByText('Image unavailable').waitFor()
  assert.equal(await page.evaluate(() => globalThis.fixture.calls.some(x => x.endpoint === 'board-image' && x.payload.scope.id === 'g1' && x.payload.taskId === 'T1')), true)
  await page.keyboard.press('Escape')
  await readOnlyModal.waitFor({state:'detached'})

  await page.evaluate(() => {globalThis.fixture.calls=[];globalThis.fixture.boardStatus='proposed';globalThis.renderFixture({kind:'room',id:'g1'},'schedule',true)})
  await focusStatus('proposed')
  await workflowLane('proposed').locator('[data-task-id="T1"]').waitFor()
  for(const status of ['draft','proposed','waiting','working','reported','done']){
    await focusStatus(status)
    const lane=workflowLane(status)
    const label=(await lane.locator('h3').innerText()).trim()
    assert.equal(await lane.getByRole('button',{name:'Add card',exact:true}).count(),1,`${status} has a quick-add entry`)
    assert.equal(await lane.getByRole('button',{name:'Add card to '+label}).count(),1,`${status} has a card creation entry`)
  }
  await focusStatus('proposed')
  const proposedLane=workflowLane('proposed')
  assert.equal(await proposedLane.locator('article').getAttribute('draggable'),'true','the card is an explicit drag handle')
  const laneStyle=await proposedLane.evaluate(el=>({height:el.getBoundingClientRect().height,headingWeight:getComputedStyle(el.querySelector('h3')).fontWeight}))
  assert.ok(laneStyle.height>=260,`the focused lane provides a usable drop area: ${laneStyle.height}px`)
  assert.equal(laneStyle.headingWeight,'600','lane headings use the standard UI weight')
  await proposedLane.locator('article').dragTo(statusChip('working'))
  await page.waitForFunction(()=>globalThis.fixture.calls.some(x=>x.endpoint==='board-command'&&x.payload.type==='schedule'))
  const dragSchedule=await page.evaluate(()=>globalThis.fixture.calls.find(x=>x.endpoint==='board-command'&&x.payload.type==='schedule'))
  assert.equal(dragSchedule.payload.taskId,'T1','dropping a Bot task on In progress schedules the original card')
  assert.equal(dragSchedule.payload.scope.id,'g1')
  await page.waitForFunction(()=>globalThis.fixture.calls.some(x=>x.endpoint==='board-operation'))
  await page.getByText('Saving…').waitFor({state:'hidden'})
  await focusStatus('waiting')
  const waitingLane=workflowLane('waiting')
  await waitingLane.locator('[data-task-id="T1"]').waitFor()
  assert.equal(await statusChip('ready').count(),0,'ready shares the Waiting lane instead of a chip of its own')
  await focusStatus('working')
  assert.equal(await workflowLane('working').locator('[data-task-id="T1"]').count(),0,'a queued Bot action stays ready until the owner starts it')
  await focusStatus('waiting')
  await page.evaluate(()=>{globalThis.fixture.calls=[];globalThis.fixture.boardStatus='waiting';globalThis.renderFixture({kind:'room',id:'g1'},'schedule')})
  await page.getByRole('button',{name:'Refresh',exact:true}).click()
  await focusStatus('waiting')
  await workflowLane('waiting').locator('[data-task-id="T1"]').waitFor()
  await workflowLane('waiting').locator('[data-task-id="T1"]').dragTo(statusChip('working'))
  await page.waitForFunction(()=>globalThis.fixture.calls.some(x=>x.endpoint==='board-command'&&x.payload.type==='schedule'))
  const waitingDrag=await page.evaluate(()=>globalThis.fixture.calls.find(x=>x.endpoint==='board-command'&&x.payload.type==='schedule'))
  assert.equal(waitingDrag.payload.taskId,'T1','dropping Waiting on In progress schedules the task')
  assert.equal(waitingDrag.payload.scope.id,'g1')
  await page.waitForFunction(()=>globalThis.fixture.calls.some(x=>x.endpoint==='board-operation'))
  await page.getByText('Saving…').waitFor({state:'hidden'})
  await workflowLane('waiting').locator('[data-task-id="T1"]').waitFor()
  if(process.env.GROUP_BOARD_SCREENSHOT){await page.screenshot({path:process.env.GROUP_BOARD_SCREENSHOT})}
  await waitingLane.getByRole('button',{name:'Add card to Waiting'}).click()
  const createModal=page.locator('.bt-create-modal')
  await createModal.waitFor()
  await createModal.getByLabel('Title').fill('Created from waiting')
  await createModal.getByLabel('Owner').selectOption('a')
  await createModal.getByLabel('Independent reviewer').selectOption('b')
  await createModal.getByLabel('Description').fill('Planned work')
  await createModal.getByRole('checkbox',{name:'Shared dependency'}).check()
  await createModal.getByLabel('Acceptance criteria').fill('Evidence')
  await createModal.getByRole('button',{name:'Create and schedule'}).click()
  await page.waitForFunction(()=>globalThis.fixture.calls.some(x=>x.endpoint==='board-command'&&x.payload.type==='create'&&x.payload.value.title==='Created from waiting'))
  const scheduledCreate=await page.evaluate(()=>globalThis.fixture.calls.find(x=>x.endpoint==='board-command'&&x.payload.type==='create'&&x.payload.value.title==='Created from waiting'))
  assert.equal(scheduledCreate.payload.value.schedule,true)
  assert.deepEqual(scheduledCreate.payload.value.dependencies,['T2'],'a visible shared group dependency can be selected')
  assert.equal(scheduledCreate.payload.value.description,'Planned work')
  await page.waitForFunction(()=>globalThis.fixture.calls.some(x=>x.endpoint==='board-operation'&&x.payload.operationId===globalThis.fixture.calls.find(c=>c.endpoint==='board-command'&&c.payload.type==='create')?.payload.operationId))
  await createModal.waitFor({state:'detached'})
  await focusStatus('reported')
  assert.equal(await workflowLane('reported').getByRole('button',{name:'Add card',exact:true}).count(),1)
  await focusStatus('done')
  assert.equal(await workflowLane('done').getByRole('button',{name:'Add card',exact:true}).count(),1)
  await focusStatus('proposed')
  const groupPreparing=workflowLane('proposed')
  await page.locator('.bt-board-toast').waitFor({state:'hidden', timeout:6000}).catch(()=>{})
  await groupPreparing.getByRole('button',{name:'Add card',exact:true}).click()
  const groupQuick=groupPreparing.locator('.bt-board-quick-add')
  await groupQuick.getByLabel('Card title').fill('Quick group card')
  await groupQuick.getByRole('button',{name:'Add card'}).click()
  const groupCreate=page.locator('.bt-create-modal')
  await groupCreate.waitFor()
  assert.equal(await groupCreate.getByLabel('Title').inputValue(),'Quick group card','quick add prefills the create dialog title')
  await groupCreate.getByLabel('Owner').selectOption('a')
  await groupCreate.getByLabel('Independent reviewer').selectOption('b')
  await groupCreate.getByLabel('Acceptance criteria').fill('Quick evidence')
  await groupCreate.getByRole('button',{name:'Create card'}).click()
  await page.waitForFunction(()=>globalThis.fixture.calls.some(x=>x.endpoint==='board-command'&&x.payload.type==='create'&&x.payload.value.title==='Quick group card'))
  const groupQuickCommand=await page.evaluate(()=>globalThis.fixture.calls.find(x=>x.endpoint==='board-command'&&x.payload.type==='create'&&x.payload.value.title==='Quick group card'))
  assert.equal(groupQuickCommand.payload.value.owner,'a')
  assert.equal(groupQuickCommand.payload.value.reviewer,'b')
  assert.equal(groupQuickCommand.payload.value.schedule,undefined,'a plain quick add does not dispatch work')
  await page.waitForFunction(id=>globalThis.fixture.calls.some(x=>x.endpoint==='board-operation'&&x.payload.operationId===id),groupQuickCommand.payload.operationId)
  await groupCreate.waitFor({state:'detached'})
  await page.getByText('Quick group card',{exact:true}).waitFor()

  await page.evaluate(() => { globalThis.resetBoardState(); globalThis.renderFixture({ kind: 'personal', id: 'user' }, 'manual') })
  await page.locator('[data-stage="todo"] [data-task-id="T1"]').waitFor()
  assert.equal(await page.getByText('Personal task', { exact: true }).count(), 1)
  assert.equal(await page.getByText('Group task', { exact: true }).count(), 0, 'group data must not persist in another scope')
  assert.equal(await page.getByText('Your own progress markers do not complete shared work or unblock dependencies.').count(), 1)
  await page.setViewportSize({width:1600,height:900})
  const personalRail=page.locator('.bt-board-columns-personal')
  await personalRail.waitFor()
  await page.waitForFunction(()=>{const el=document.querySelector('.bt-board-columns-personal');return el&&el.scrollWidth<=el.clientWidth+1})
  assert.equal(await personalRail.locator('..').locator('.bt-board-rail-controls').isVisible(),false,'column controls are hidden when all personal columns fit')
  const personalFrom=await page.locator('[data-stage="todo"] [data-task-id="T1"] .bt-board-card-summary').boundingBox()
  const personalTo=await page.locator('[data-stage="doing"]').boundingBox()
  assert.ok(personalFrom&&personalTo,'the personal card and destination lane are visible')
  await page.mouse.move(personalFrom.x+personalFrom.width/2,personalFrom.y+personalFrom.height/2)
  await page.mouse.down()
  await page.mouse.move(personalTo.x+personalTo.width/2,personalTo.y+personalTo.height/2,{steps:12})
  await page.mouse.up()
  await page.locator('[data-stage="doing"] [data-task-id="T1"]').waitFor()
  const personalDrag=await page.evaluate(()=>globalThis.fixture.calls.filter(x=>x.endpoint==='board-command'&&x.payload.type==='personal-progress').at(-1))
  assert.equal(personalDrag.payload.value.progress,'doing')
  assert.ok(personalDrag.payload.operationId)
  assert.equal(await page.evaluate(id=>globalThis.fixture.calls.some(x=>x.endpoint==='board-operation'&&x.payload.operationId===id),personalDrag.payload.operationId),true)
  await page.locator('[data-stage="doing"] [data-task-id="T1"] .bt-board-card-summary').click()
  const personalModal=page.locator('.bt-card-modal')
  await personalModal.waitFor()
  await personalModal.getByLabel('Move personal task').selectOption('finished')
  await page.locator('[data-stage="finished"] [data-task-id="T1"]').waitFor()
  const personalSelect=await page.evaluate(()=>globalThis.fixture.calls.filter(x=>x.endpoint==='board-command'&&x.payload.type==='personal-progress').at(-1))
  assert.equal(personalSelect.payload.value.progress,'finished')
  await page.keyboard.press('Escape')
  await personalModal.waitFor({state:'detached'})
  await page.setViewportSize({width:1280,height:720})
  await page.getByRole('button',{name:'Select',exact:true}).click()
  await page.locator('[data-stage="finished"] [data-task-id="T1"]').getByLabel('Select card').check()
  await page.getByLabel('Move selected cards').selectOption('todo')
  await page.locator('.bt-board-confirm').getByRole('button',{name:'Confirm',exact:true}).click()
  await page.waitForFunction(()=>globalThis.fixture.calls.some(call=>call.endpoint==='board-command'&&call.payload.type==='personal-progress'&&call.payload.value.progress==='todo'))
  const bulkPersonalMove=await page.evaluate(()=>globalThis.fixture.calls.find(call=>call.endpoint==='board-command'&&call.payload.type==='personal-progress'&&call.payload.value.progress==='todo'))
  assert.equal(bulkPersonalMove.payload.taskId,'T1','selected personal cards move through the existing progress command')
  await page.locator('[data-stage="todo"] [data-task-id="T1"]').waitFor()
  await page.getByRole('button',{name:'Select',exact:true}).click()
  await page.locator('[data-stage="todo"] [data-task-id="T1"]').getByLabel('Select card').check()
  await page.getByRole('button',{name:'Duplicate selected',exact:true}).click()
  await page.locator('.bt-board-confirm').getByRole('button',{name:'Confirm',exact:true}).click()
  await page.waitForFunction(()=>globalThis.fixture.calls.some(call=>call.endpoint==='board-command'&&call.payload.type==='create'))
  const bulkCopy=await page.evaluate(()=>globalThis.fixture.calls.find(call=>call.endpoint==='board-command'&&call.payload.type==='create'))
  assert.equal(bulkCopy.payload.value.title,'Copy of Personal task','bulk duplicate copies the selected card title')
  await page.locator('.bt-board-toast-action').click()
  await page.waitForFunction(id=>globalThis.fixture.calls.some(call=>call.endpoint==='board-command'&&call.payload.type==='archive'&&call.payload.taskId===id),bulkCopy.payload.taskId)
  await page.getByRole('button',{name:'Select',exact:true}).click()
  await page.locator('[data-stage="todo"] [data-task-id="T1"]').getByLabel('Select card').check()
  await page.getByLabel('Set owner for selected cards').selectOption('a')
  await page.locator('.bt-board-confirm').getByRole('button',{name:'Confirm',exact:true}).click()
  await page.waitForFunction(()=>globalThis.fixture.calls.some(call=>call.endpoint==='board-command'&&call.payload.type==='edit'&&call.payload.value.owner==='a'))
  const bulkOwner=await page.evaluate(()=>globalThis.fixture.calls.find(call=>call.endpoint==='board-command'&&call.payload.type==='edit'&&call.payload.value.owner==='a'))
  assert.equal(bulkOwner.payload.taskId,'T1','bulk owner applies to the selected card')
  await page.locator('.bt-board-toast-action').click()
  await page.waitForFunction(()=>globalThis.fixture.calls.some(call=>call.endpoint==='board-command'&&call.payload.type==='edit'&&call.payload.value.owner==='user'))
  const bulkOwnerUndo=await page.evaluate(()=>globalThis.fixture.calls.find(call=>call.endpoint==='board-command'&&call.payload.type==='edit'&&call.payload.value.owner==='user'))
  assert.equal(bulkOwnerUndo.payload.taskId,'T1','bulk owner undo restores the previous owner')

  await page.evaluate(() => { globalThis.resetBoardState(); globalThis.renderFixture({ kind: 'personal', id: 'a' }, 'normal') })
  await focusStatus('reported')
  await page.locator('.bt-board-focus-lane article').filter({hasText:'Personal task'}).locator('.bt-board-card-summary').click()
  const namedCard = page.locator('.bt-card-modal')
  await namedCard.waitFor()
  const description=namedCard.locator('.bt-card-description')
  await description.getByRole('button',{name:/^(Add|Edit)$/}).click()
  const descriptionInput=description.getByLabel('Description',{exact:true})
  await descriptionInput.waitFor()
  assert.equal(await description.getByRole('button',{name:'Save'}).isDisabled(),true,'Save stays disabled while the draft matches')
  await descriptionInput.fill('Release details')
  assert.equal(await description.getByRole('button',{name:'Save'}).isEnabled(),true,'a changed description enables Save')
  await description.getByRole('button',{name:'Save'}).click()
  await approveChange(page, namedCard)
  await page.waitForFunction(()=>globalThis.fixture.calls.some(x=>x.endpoint==='board-command'&&x.payload.type==='card-details'&&x.payload.value.description==='Release details'))
  await description.getByText('Release details',{exact:true}).waitFor()
  const descriptionCommand=await page.evaluate(()=>globalThis.fixture.calls.find(x=>x.endpoint==='board-command'&&x.payload.type==='card-details'&&x.payload.value.description))
  assert.equal(descriptionCommand.payload.value.description,'Release details')

  const labels=namedCard.locator('.bt-card-labels')
  await labels.getByRole('button',{name:'Edit'}).click()
  await labels.getByLabel('Add a label').fill('Design')
  await labels.getByRole('button',{name:'Add',exact:true}).click()
  await labels.getByRole('button',{name:'Save'}).click()
  await approveChange(page, namedCard)
  await page.waitForFunction(()=>globalThis.fixture.calls.some(x=>x.endpoint==='board-command'&&x.payload.type==='card-details'&&Array.isArray(x.payload.value.labels)&&x.payload.value.labels.includes('Design')))
  const labelsCommand=await page.evaluate(()=>globalThis.fixture.calls.find(x=>x.endpoint==='board-command'&&x.payload.type==='card-details'&&Array.isArray(x.payload.value.labels)))
  assert.deepEqual(labelsCommand.payload.value.labels,['Design'])
  await labels.getByText('Design',{exact:true}).waitFor()

  const due=namedCard.locator('.bt-card-due-editor')
  await due.getByLabel('Due date',{exact:true}).fill('2026-12-01')
  await due.getByRole('button',{name:'Save'}).click()
  await approveChange(page, namedCard)
  await page.waitForFunction(()=>globalThis.fixture.calls.some(x=>x.endpoint==='board-command'&&x.payload.type==='card-details'&&x.payload.value.dueDate==='2026-12-01'))
  const dueCommand=await page.evaluate(()=>globalThis.fixture.calls.find(x=>x.endpoint==='board-command'&&x.payload.type==='card-details'&&x.payload.value.dueDate==='2026-12-01'))
  assert.equal(dueCommand.payload.value.dueComplete,false)
  await page.waitForFunction(()=>document.querySelector('.bt-card-due-editor input[type=date]')?.value==='2026-12-01')
  assert.equal(await due.getByLabel('Due date',{exact:true}).inputValue(),'2026-12-01')

  const checklist=namedCard.locator('.bt-card-checklist')
  await checklist.getByLabel('New checklist item').fill('Verify layout')
  await checklist.getByRole('button',{name:'Add item'}).click()
  await approveChange(page, namedCard)
  await page.waitForFunction(()=>globalThis.fixture.calls.some(x=>x.endpoint==='board-command'&&x.payload.type==='card-details'&&x.payload.value.checklist?.[0]?.text==='Verify layout'))
  const addedItem=await page.evaluate(()=>globalThis.fixture.calls.find(x=>x.endpoint==='board-command'&&x.payload.type==='card-details'&&x.payload.value.checklist?.[0]?.text==='Verify layout'))
  const itemId=addedItem.payload.value.checklist[0].id
  assert.ok(itemId)
  await checklist.getByText('Verify layout',{exact:true}).waitFor()
  await checklist.getByRole('button',{name:'Edit checklist item'}).click()
  await checklist.getByLabel('Edit checklist item').fill('Verify layout twice')
  await checklist.locator('.bt-card-checklist-edit').getByRole('button',{name:'Save'}).click()
  await approveChange(page, namedCard)
  await page.waitForFunction(()=>globalThis.fixture.calls.some(x=>x.endpoint==='board-command'&&x.payload.type==='card-details'&&x.payload.value.checklist?.[0]?.text==='Verify layout twice'))
  const editedItem=await page.evaluate(()=>globalThis.fixture.calls.filter(x=>x.endpoint==='board-command'&&x.payload.type==='card-details').at(-1))
  assert.equal(editedItem.payload.value.checklist[0].id,itemId,'editing keeps the checklist item ID')
  await checklist.getByText('Verify layout twice',{exact:true}).waitFor()

  await page.keyboard.press('Escape')
  await namedCard.waitFor({state:'detached'})

  await focusStatus('proposed')
  const personalPreparing=workflowLane('proposed')
  await personalPreparing.getByRole('button',{name:'Add card',exact:true}).click()
  const personalQuick=personalPreparing.locator('.bt-board-quick-add')
  await personalQuick.getByLabel('Card title').fill('Personal quick card')
  await personalQuick.getByRole('button',{name:'Add card'}).click()
  const personalCreate=page.locator('.bt-create-modal')
  await personalCreate.waitFor()
  assert.equal(await personalCreate.getByLabel('Title').inputValue(),'Personal quick card')
  assert.equal(await personalCreate.getByLabel('Owner').inputValue(),'a')
  const reviewerOptions=await personalCreate.getByLabel('Independent reviewer').evaluate(select=>[...select.options].map(option=>option.value))
  assert.ok(reviewerOptions.includes('b'),'a personal-board owner can choose an independent reviewer')
  assert.equal(reviewerOptions.includes('a'),false,'the current owner is not offered as reviewer')
  await personalCreate.getByLabel('Independent reviewer').selectOption('b')
  const personalCreateButton=personalCreate.getByRole('button',{name:'Create card'})
  assert.equal(await personalCreateButton.isDisabled(),true,'Create card waits for the required acceptance criteria')
  await personalCreate.getByLabel('Acceptance criteria').fill('Independent review evidence')
  assert.equal(await personalCreateButton.isEnabled(),true,'Create card enables once the reviewer and acceptance are set')
  await personalCreate.getByRole('button',{name:'Cancel'}).click()
  await personalCreate.waitFor({state:'detached'})

  await focusStatus('working')
  const shared = page.locator('.bt-board-focus-lane article').filter({hasText:'Shared dependency'})
  assert.match(await shared.innerText(), /Shared task · read only/)
  await shared.locator('.bt-board-card-summary').click()
  const sharedModal=page.locator('.bt-card-modal')
  await sharedModal.waitFor()
  assert.equal(await sharedModal.getByRole('button', {name:'Edit task'}).count(), 0, 'a shared task cannot be edited even if a bad capability is sent')
  assert.equal(await sharedModal.getByRole('button', {name:'Share with group'}).count(), 0)
  await page.keyboard.press('Escape')
  await sharedModal.waitFor({state:'detached'})
  await focusStatus('reported')
  await page.locator('.bt-board-focus-lane article').filter({hasText:'Personal task'}).locator('.bt-board-card-summary').click()
  await namedCard.waitFor()
  const shares=namedCard.locator('.bt-card-shares')
  const shareRevision=await page.evaluate(()=>globalThis.fixture.revision)
  await shares.getByRole('button', {name:'Share with group'}).click()
  await shares.getByLabel('Target group').selectOption('g2')
  await shares.getByRole('button', {name:'Share',exact:true}).click()
  await shares.getByRole('button', {name:'Share with group'}).waitFor()
  const share = await page.evaluate(() => globalThis.fixture.calls.find(x => x.endpoint==='board-command' && x.payload.type==='share'))
  assert.deepEqual(share.payload.value, {targetRoomId:'g2',fields:['status']})
  assert.equal(share.payload.expectedRevision, shareRevision)
  await page.waitForFunction(()=>document.querySelectorAll('.bt-card-shares .bt-card-share-row').length===2)
  assert.equal(await shares.getByText('Design group',{exact:true}).count(),2,'the committed share appears beside the existing grant')
  await shares.getByRole('button', {name:'Share with group'}).click()
  await shares.getByLabel('Target group').selectOption('g2')
  await shares.getByLabel('Share title too').check()
  await shares.getByRole('button', {name:'Share',exact:true}).click()
  await page.waitForFunction(()=>globalThis.fixture.calls.filter(x=>x.endpoint==='board-command'&&x.payload.type==='share').length===2)
  const titled = await page.evaluate(() => globalThis.fixture.calls.filter(x => x.endpoint==='board-command' && x.payload.type==='share')[1])
  assert.deepEqual(titled.payload.value.fields, ['status','title'])
  await shares.getByRole('button', {name:'Share with group'}).waitFor()
  await shares.getByRole('button', {name:'Revoke share'}).first().click()
  await page.waitForFunction(() => globalThis.fixture.calls.some(x => x.endpoint==='board-command' && x.payload.type==='unshare'))
  const unshare = await page.evaluate(() => globalThis.fixture.calls.find(x => x.endpoint==='board-command' && x.payload.type==='unshare'))
  assert.equal(unshare.payload.value.shareId, 'grant-old')
  await page.evaluate(() => { globalThis.fixture.mode='lost' })
  await shares.getByRole('button', {name:'Share with group'}).click()
  await shares.getByLabel('Target group').selectOption('g2')
  await shares.getByRole('button', {name:'Share',exact:true}).click()
  await namedCard.getByText('An action needs confirmation.').waitFor()
  const shareCount = await page.evaluate(() => globalThis.fixture.calls.filter(x => x.endpoint==='board-command' && x.payload.type==='share').length)
  await namedCard.getByRole('button', {name:'Check action'}).click()
  assert.equal(await page.evaluate(() => globalThis.fixture.calls.filter(x => x.endpoint==='board-command' && x.payload.type==='share').length), shareCount, 'checking an uncertain share must not resend it')
  await namedCard.getByRole('button', {name:'Safely cancel pending request'}).click()
  await namedCard.getByText('An action needs confirmation.').waitFor({state:'hidden'})
  await shares.getByRole('button', {name:'Cancel'}).click()
  await page.evaluate(() => { globalThis.fixture.mode='normal' })

  await namedCard.locator('.bt-card-more > summary').click()
  const beforeRevision=await page.evaluate(()=>globalThis.fixture.revision)
  await page.evaluate(() => { globalThis.fixture.mode='conflict' })
  await namedCard.getByRole('button', { name: 'Edit task' }).click()
  const editForm=namedCard.locator('.bt-card-more .bt-card-form')
  await editForm.getByLabel('Title', { exact: true }).fill('Unsaved draft')
  await editForm.getByRole('button', { name: 'Save changes' }).click()
  await approveChange(page, namedCard)
  await namedCard.getByText('Task changed. Reload its current values before saving.').waitFor()
  assert.equal(await editForm.getByLabel('Title', { exact: true }).inputValue(), 'Unsaved draft')
  assert.equal(await editForm.getByRole('button', { name: 'Save changes' }).isDisabled(), true, 'conflict must not silently overwrite revision 2')
  const edit = await page.evaluate(() => globalThis.fixture.calls.find(x => x.endpoint === 'board-command' && x.payload.type === 'edit'))
  assert.equal(edit.payload.expectedRevision, beforeRevision)

  await editForm.getByRole('button',{name:'Cancel'}).click()
  await page.evaluate(() => { globalThis.fixture.mode='normal' })
  const png = Buffer.from(await page.evaluate(() => globalThis.fixture.images.png.data), 'base64')
  const attachments=namedCard.locator('.bt-card-attachments')
  await attachments.getByText('PNG/JPEG, PDF, ZIP, text, Markdown and JSON are supported.').waitFor()
  const fileInput=attachments.locator('input[type=file]')
  await fileInput.setInputFiles([{ name:'bad.exe',mimeType:'application/x-msdownload',buffer:Buffer.from('not allowed') }])
  await attachments.getByText('Choose PNG/JPEG, PDF, ZIP, plain text, Markdown or JSON: up to 20 per task, 10 per batch, 5 MiB each and 20 MiB per batch.').waitFor()
  assert.equal(await attachments.locator('.bt-attachment-queue img').count(), 0, 'an unsupported type must not enter the upload queue')
  await fileInput.setInputFiles(Array.from({length:11}, (_, i) => ({ name:'image-'+i+'.png', mimeType:'image/png', buffer:png })))
  assert.equal(await attachments.locator('.bt-attachment-queue img').count(), 0, 'a batch of 11 must not enter the upload queue')
  await page.evaluate(() => { globalThis.fixture.mode='invalid-image' })
  await fileInput.setInputFiles([{ name:'rejected.png',mimeType:'image/png',buffer:png }])
  await attachments.getByRole('button', {name:'Upload files'}).click()
  await namedCard.getByText('Interlaced PNG is not supported').waitFor()
  assert.equal(await page.evaluate(() => sessionStorage.getItem('ds-bot:board-pending:personal:a')), null, 'a persisted rejected receipt settles the operation')
  await attachments.locator('.bt-attachment-queue').getByRole('button', {name:'Remove attachment'}).click()
  await page.evaluate(() => { globalThis.fixture.mode='normal' })
  await fileInput.setInputFiles([{ name:'one.png',mimeType:'image/png',buffer:png },{ name:'two.png',mimeType:'image/png',buffer:png }])
  assert.equal(await attachments.locator('.bt-attachment-queue img').count(), 2)
  await attachments.locator('.bt-attachment-queue').getByRole('button', {name:'Remove attachment'}).first().click()
  assert.equal(await attachments.locator('.bt-attachment-queue img').count(), 1)
  await attachments.getByRole('button', {name:'Upload files'}).click()
  await page.waitForFunction(() => globalThis.fixture.calls.some(x => x.endpoint === 'board-upload' && x.payload.images?.[0]?.name === 'two.png'))
  const upload = await page.evaluate(() => globalThis.fixture.calls.find(x => x.endpoint === 'board-upload' && x.payload.images?.[0]?.name === 'two.png'))
  assert.equal(upload.payload.images.length, 1)
  assert.equal(upload.payload.images[0].name, 'two.png')
  assert.equal(upload.payload.images[0].mediaType, 'image/png')
  assert.ok(upload.payload.images[0].uploadId)
  assert.ok(upload.payload.images[0].data.length > 0)
  await page.waitForFunction(id => globalThis.fixture.calls.some(x => x.endpoint === 'board-operation' && x.payload.operationId === id), upload.payload.operationId)
  await attachments.getByText('two.png',{exact:true}).waitFor()
  const coverTile=attachments.locator('.bt-attachment').filter({hasText:'existing.png'})
  await coverTile.getByRole('button',{name:'Set as cover'}).click()
  await approveChange(page, namedCard)
  await page.waitForFunction(()=>globalThis.fixture.calls.some(x=>x.endpoint==='board-command'&&x.payload.type==='card-details'&&x.payload.value.coverImageId==='png'))
  await coverTile.getByRole('button',{name:'Remove cover'}).waitFor()
  await coverTile.getByRole('button',{name:'Remove cover'}).click()
  await approveChange(page, namedCard)
  await page.waitForFunction(()=>globalThis.fixture.calls.some(x=>x.endpoint==='board-command'&&x.payload.type==='card-details'&&x.payload.value.coverImageId===null))
  await coverTile.getByRole('button',{name:'Set as cover'}).waitFor()

  const comments=namedCard.locator('.bt-card-comments')
  await comments.getByLabel('Add a comment').fill('Personal board comment')
  await comments.getByRole('button',{name:'Post comment'}).click()
  await page.waitForFunction(()=>globalThis.fixture.calls.some(x=>x.endpoint==='board-command'&&x.payload.type==='card-comment'&&x.payload.value.text==='Personal board comment'))
  const personalComment=await page.evaluate(()=>globalThis.fixture.calls.find(x=>x.endpoint==='board-command'&&x.payload.type==='card-comment'))
  assert.equal(personalComment.payload.value.text,'Personal board comment')
  const commentItem=comments.locator('.bt-comment').first()
  await commentItem.waitFor()
  await commentItem.getByRole('button',{name:'Edit'}).click()
  await commentItem.getByLabel('Edit comment').fill('Edited board comment')
  await commentItem.getByRole('button',{name:'Save'}).click()
  await page.waitForFunction(()=>globalThis.fixture.calls.some(x=>x.endpoint==='board-command'&&x.payload.type==='card-comment-edit'))
  const commentEdit=await page.evaluate(()=>globalThis.fixture.calls.find(x=>x.endpoint==='board-command'&&x.payload.type==='card-comment-edit'))
  assert.equal(commentEdit.payload.value.text,'Edited board comment')
  assert.ok(commentEdit.payload.value.commentId)
  const editedComment=comments.locator('.bt-comment').filter({hasText:'Edited board comment'})
  await editedComment.getByRole('button',{name:'Delete'}).click()
  await editedComment.getByRole('button',{name:'Confirm delete'}).click()
  await page.waitForFunction(()=>globalThis.fixture.calls.some(x=>x.endpoint==='board-command'&&x.payload.type==='card-comment-delete'))
  const commentDelete=await page.evaluate(()=>globalThis.fixture.calls.find(x=>x.endpoint==='board-command'&&x.payload.type==='card-comment-delete'))
  assert.equal(commentDelete.payload.value.commentId,commentEdit.payload.value.commentId)
  await page.waitForFunction(()=>globalThis.fixture.card.comments.length===0)
  await comments.getByText('Edited board comment').waitFor({state:'detached'})

  await page.keyboard.press('Escape')
  await namedCard.waitFor({state:'detached'})
  await page.evaluate(() => { globalThis.fixture.mode='lost'; globalThis.fixture.calls=[]; globalThis.renderFixture({kind:'room',id:'g1'},'lost') })
  await focusStatus('proposed')
  await workflowLane('proposed').getByRole('button', { name:'Add card to Preparing' }).click()
  const lostCreate=page.locator('.bt-create-modal')
  await lostCreate.waitFor()
  await lostCreate.getByLabel('Title').fill('Potentially sent')
  await lostCreate.getByLabel('Owner').selectOption('a')
  await lostCreate.getByLabel('Independent reviewer').selectOption('b')
  await lostCreate.getByLabel('Acceptance criteria').fill('evidence')
  await lostCreate.getByRole('button', { name:'Create card' }).click()
  await page.getByText('An action needs confirmation.').waitFor()
  const before = await page.evaluate(() => globalThis.fixture.calls.filter(x => x.endpoint === 'board-command').length)
  assert.equal(await lostCreate.getByRole('button', { name:'Create card' }).isDisabled(), true, 'a pending action blocks another create')
  await lostCreate.getByRole('button',{name:'Cancel'}).click()
  await lostCreate.waitFor({state:'detached'})
  await page.locator('.bt-board-pending').getByRole('button', { name:'Check action' }).click()
  assert.equal(await page.evaluate(() => globalThis.fixture.calls.filter(x => x.endpoint === 'board-command').length), before, 'unknown outcome must not resend')

  const originalId = await page.evaluate(() => sessionStorage.getItem('ds-bot:board-pending:room:g1'))
  assert.ok(originalId)
  await page.reload()
  await page.addScriptTag({ path:react })
  await page.addScriptTag({ path:reactDom })
  await page.addScriptTag({ content:bundle.outputFiles[0].text })
  await page.evaluate(() => globalThis.renderFixture({kind:'room',id:'g1'},'lost'))
  await page.getByText('An action needs confirmation.').waitFor()
  assert.equal(await page.evaluate(() => globalThis.fixture.calls.some(call => call.endpoint==='board-operation' && call.payload.operationId===sessionStorage.getItem('ds-bot:board-pending:room:g1'))), true, 'reopen checks the original operation ID')
  await page.evaluate(() => { globalThis.fixture.mode='cancel-fails' })
  await page.getByRole('button', { name:'Safely cancel pending request' }).click()
  await page.getByText('Cancellation outcome is unknown. Check the original action again.').waitFor()
  assert.equal(await page.evaluate(() => sessionStorage.getItem('ds-bot:board-pending:room:g1')), originalId, 'failed cancel retains the original operation')
  await page.evaluate(() => { globalThis.fixture.mode='lost' })
  await page.getByRole('button', { name:'Safely cancel pending request' }).click()
  await page.getByText('An action needs confirmation.').waitFor({state:'hidden'})
  assert.equal(await page.evaluate(id => globalThis.fixture.calls.some(call => call.endpoint==='board-operation-cancel' && call.payload.operationId===id), originalId), true)

  await page.evaluate(() => globalThis.renderFixture({kind:'room',id:'g1'},'legacy',true))
  await page.getByText('Legacy task', {exact:true}).waitFor()
  await page.getByText('Goal card details can be corrected without changing the original task or acceptance record.').waitFor()
  assert.equal(await page.locator('[aria-label="Not started"]').count(),0,'goal cards do not occupy a workflow status column')
  assert.equal(await page.locator('[aria-label="Goal marked done"]').count(),0,'completed goal cards do not occupy a workflow status column')
  const goalSection=page.locator('.bt-board-section[aria-label="Goal cards"]')
  assert.equal(await goalSection.count(),1,'goal cards have their own section')
  assert.equal(await goalSection.locator('article').count(),2,'both goal cards are listed outside the workflow lanes')
  assert.equal(await goalSection.getByRole('button',{name:'Add card',exact:true}).count(),0,'the goal section is not a workflow lane and offers no quick add')
  await page.locator('article').filter({hasText:'Legacy task'}).locator('.bt-board-card-summary').click()
  const legacy = page.locator('.bt-card-modal')
  await legacy.waitFor()
  assert.match(await legacy.innerText(), /Current goal task/)
  const legacyDescription=legacy.locator('.bt-card-description')
  await legacyDescription.getByRole('button',{name:/^(Add|Edit)$/}).click()
  await legacyDescription.getByLabel('Description',{exact:true}).fill('Original goal notes')
  await legacyDescription.getByRole('button',{name:'Save'}).click()
  await approveChange(page, legacy)
  await page.waitForFunction(()=>globalThis.fixture.calls.some(x=>x.endpoint==='board-command'&&x.payload.type==='goal-card-details'))
  const goalDetails=await page.evaluate(()=>globalThis.fixture.calls.find(x=>x.endpoint==='board-command'&&x.payload.type==='goal-card-details'))
  assert.match(goalDetails.payload.operationId,/^goal:/)
  assert.equal(goalDetails.payload.value.description,'Original goal notes')
  const legacyLabels=legacy.locator('.bt-card-labels')
  await legacyLabels.getByRole('button',{name:'Edit'}).click()
  await legacyLabels.getByLabel('Add a label').fill('UX')
  await legacyLabels.getByRole('button',{name:'Add',exact:true}).click()
  await legacyLabels.getByRole('button',{name:'Save'}).click()
  await approveChange(page, legacy)
  await page.waitForFunction(()=>globalThis.fixture.calls.some(x=>x.endpoint==='board-command'&&x.payload.type==='goal-card-details'&&Array.isArray(x.payload.value.labels)))
  const legacyLabelsCommand=await page.evaluate(()=>globalThis.fixture.calls.find(x=>x.endpoint==='board-command'&&x.payload.type==='goal-card-details'&&Array.isArray(x.payload.value.labels)))
  assert.deepEqual(legacyLabelsCommand.payload.value.labels,['UX'])
  await legacy.getByLabel('Add a comment').fill('Goal comment')
  await legacy.getByRole('button',{name:'Post comment'}).click()
  await page.waitForFunction(()=>globalThis.fixture.calls.some(x=>x.endpoint==='board-command'&&x.payload.type==='goal-card-comment'))
  const goalComment=await page.evaluate(()=>globalThis.fixture.calls.find(x=>x.endpoint==='board-command'&&x.payload.type==='goal-card-comment'))
  assert.match(goalComment.payload.operationId,/^goal:/)
  assert.equal(goalComment.payload.value.text,'Goal comment')
  await legacy.locator('.bt-card-more > summary').click()
  await legacy.getByRole('button', {name:'Edit goal task'}).click()
  await legacy.getByLabel('Task description').fill('Updated original work')
  await legacy.getByLabel('Goal task status').selectOption('working')
  await legacy.getByLabel('Goal task note').fill('Work started')
  assert.equal(await legacy.getByLabel('Goal task status').locator('option[value="done"]').count(),0, 'goal task cannot skip review')
  await legacy.getByRole('button',{name:'Save changes'}).click()
  await approveChange(page, legacy)
  await page.waitForFunction(()=>globalThis.fixture.calls.some(x=>x.endpoint==='board-command'&&x.payload.type==='goal-task-edit'))
  const goalEdit=await page.evaluate(()=>globalThis.fixture.calls.find(x=>x.endpoint==='board-command'&&x.payload.type==='goal-task-edit'))
  assert.match(goalEdit.payload.operationId,/^goal:/)
  assert.equal(goalEdit.payload.expectedRevision,1)
  assert.deepEqual(goalEdit.payload.value,{title:'Updated original work',status:'working',note:'Work started'})

  for (const [position, label] of [['previous','Earlier goal stage'],['future','Upcoming goal stage'],['archived','Archived goal task']]) {
    await page.evaluate(position => { globalThis.fixture.historyTitle=undefined;globalThis.fixture.historyRevision=0;globalThis.fixture.historyAudit=[];globalThis.renderFixture({kind:'room',id:'history-'+position},'history-'+position) }, position)
    await page.locator('article').filter({hasText:'Original historical task'}).locator('.bt-board-card-summary').click()
    const history=page.locator('.bt-card-modal')
    await history.getByText(label,{exact:true}).first().waitFor()
    await history.getByText('Original task description',{exact:true}).waitFor()
    await history.locator('.bt-card-more > summary').click()
    assert.equal(await history.getByRole('button',{name:'Edit goal task'}).count(),0,'historical card cannot alter original workflow')
    await history.getByRole('button',{name:'Correct card title'}).click()
    await history.getByLabel('Card display title').fill('Corrected '+position)
    await history.getByLabel('Reason for correction').fill('Clarify accepted work')
    await history.getByRole('button',{name:'Save changes'}).click()
    await approveChange(page, history)
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
  await focusStatus('reported')
  await page.locator('.bt-board-focus-lane article').filter({hasText:'Personal task'}).first().waitFor()
  const previousVisible = await page.evaluate(() => { globalThis.ReactDOM.flushSync(()=>globalThis.renderFixture({kind:'room',id:'g1'},'slow')); return document.querySelector('.bt-board-dialog')?.textContent.includes('Personal task') })
  assert.equal(previousVisible,false,'a scope change must immediately hide the previous scope')
  await page.evaluate(() => { sessionStorage.clear(); globalThis.renderFixture({kind:'room',id:'g1'},'slow'); setTimeout(()=>globalThis.renderFixture({kind:'personal',id:'a'},'normal'),20) })
  await focusStatus('reported')
  await page.locator('.bt-board-focus-lane article').filter({hasText:'Personal task'}).first().waitFor()
  await page.waitForTimeout(600)
  assert.equal(await page.getByText('Group task', { exact:true }).count(), 0, 'late response must not overwrite the new board')

  // A committed receipt does not make the old board revision safe for another
  // command. A failed refresh must keep the original ID and file input fenced.
  await page.evaluate(()=>{globalThis.fixture.calls=[];globalThis.fixture.boardPlans['personal:a']=[{id:'after-commit-fails',mode:'fail'},{id:'after-commit-fails-retry',mode:'fail'}]})
  const openReceiptCard=async title=>{
    await focusStatus('reported')
    await page.locator('.bt-board-focus-lane article').filter({hasText:title}).locator('.bt-board-card-summary').click()
    const modal=page.locator('.bt-card-modal');await modal.waitFor();return modal
  }
  let receiptModal=await openReceiptCard('Personal task')
  let receiptDescription=receiptModal.locator('.bt-card-description')
  await receiptDescription.getByRole('button',{name:/^(Add|Edit)$/}).click()
  await receiptDescription.getByLabel('Description',{exact:true}).fill('Committed but refresh failed')
  await receiptDescription.getByRole('button',{name:'Save'}).click()
  await approveChange(page, receiptModal)
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
  receiptDescription=receiptModal.locator('.bt-card-description')
  await receiptDescription.getByRole('button',{name:/^(Add|Edit)$/}).click()
  await receiptDescription.getByLabel('Description',{exact:true}).fill('Receipt with competing refresh')
  await receiptDescription.getByRole('button',{name:'Save'}).click()
  await approveChange(page, receiptModal)
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
  receiptDescription=receiptModal.locator('.bt-card-description')
  await receiptDescription.getByRole('button',{name:/^(Add|Edit)$/}).click()
  await receiptDescription.getByLabel('Description',{exact:true}).fill('Old scope late response')
  await receiptDescription.getByRole('button',{name:'Save'}).click()
  await approveChange(page, receiptModal)
  await page.waitForFunction(()=>globalThis.fixture.boardStarted.includes('scope-a-late'))
  const oldScopeId=await page.evaluate(()=>sessionStorage.getItem('ds-bot:board-pending:personal:a'))
  assert.ok(oldScopeId)
  const newScopeId='scope-b-pending-operation'
  await page.evaluate(id=>{sessionStorage.setItem('ds-bot:board-pending:room:g2',id);globalThis.fixture.receiptPlans[id]={id:'scope-b-receipt'};globalThis.renderFixture({kind:'room',id:'g2'},'normal')},newScopeId)
  await page.waitForFunction(()=>globalThis.fixture.receiptStarted.includes('scope-b-receipt'))
  await focusStatus('reported')
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
  await focusStatus('reported')
  await page.getByText('Personal task',{exact:true}).waitFor()
  await page.waitForFunction(()=>sessionStorage.getItem('ds-bot:board-pending:personal:a')===null)

  await page.setViewportSize({ width: 375, height: 700 })
  const box = await page.locator('.bt-board-dialog').boundingBox()
  assert.ok(box && box.width <= 375, 'board must fit a narrow viewport')
  assert.equal(await page.locator('.bt-status-chips').evaluate(el=>el.scrollWidth>el.clientWidth+1),true,'status chips scroll horizontally on a narrow board')
  const mobileFocus=await page.locator('.bt-card-slot[data-offset="0"]').boundingBox()
  assert.ok(mobileFocus && mobileFocus.width<=375,'the focused task card fits the narrow viewport')
  await page.locator('.bt-board-filter-toggle').click()
  await page.locator('.bt-board-filters-open').waitFor()
  assert.equal(await page.locator('.bt-board-filter-scrim').isVisible(),true,'mobile filters open over a scrim')
  const scrimBox=await page.locator('.bt-board-filter-scrim').boundingBox()
  assert.ok(scrimBox && scrimBox.width>=375 && scrimBox.height>=700,'the scrim covers the mobile viewport')
  await page.locator('.bt-board-filter-scrim').click({position:{x:8,y:8}})
  await page.waitForFunction(()=>!document.querySelector('.bt-board-filters-open'))
  assert.equal(await page.locator('.bt-board-filter-scrim').count(),0,'closing the panel removes the scrim')
  await page.locator('.bt-board-filter-toggle').click()
  await page.locator('.bt-board-filters-open').waitFor()
  await page.keyboard.press('Escape')
  await page.waitForFunction(()=>!document.querySelector('.bt-board-filters-open'))
  assert.equal(await page.locator('.bt-board-dialog').count(),1,'Escape closes the filter sheet first and keeps the board')
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
  assert.equal(await mobileModal.locator('.bt-card-more').evaluate(el=>el.open),false,'More actions stays closed for the focus-wrap check')
  await closeCard.focus()
  await page.keyboard.press('Shift+Tab')
  assert.equal(await mobileModal.evaluate(el=>el.contains(document.activeElement)),true,'Shift+Tab wraps inside the card dialog')
  assert.equal(await closeCard.evaluate(el=>el===document.activeElement),false,'Shift+Tab leaves the close button with More actions closed')
  assert.equal(await page.evaluate(()=>{const el=document.activeElement;return !!el&&el.tabIndex>=0&&el.getClientRects().length>0}),true,'Shift+Tab lands on a visible control')
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
  await focusStatus('reported')
  await page.getByText('Personal task',{exact:true}).waitFor()
  await page.keyboard.press('Tab')
  assert.equal(await page.evaluate(() => document.querySelector('.bt-board-dialog').contains(document.activeElement)), true, 'keyboard focus remains in the dialog')
  await page.getByRole('button', {name:'Close',exact:true}).click()
  await page.locator('.bt-board-backdrop').waitFor({state:'detached'})
  assert.equal(await page.evaluate(()=>globalThis.listenerCount()),0,'close must remove its keyboard listener')
  assert.equal(await page.evaluate(()=>globalThis.fixture.closed),2)
  await page.evaluate(()=>globalThis.clearFixture())
  await page.evaluate(()=>globalThis.renderFixture({kind:'room',id:'g1'},'normal'))
  await focusStatus('reported')
  await page.getByText('Group task',{exact:true}).waitFor()
  await page.keyboard.press('Escape')
  await page.locator('.bt-board-backdrop').waitFor({state:'detached'})
  assert.equal(await page.evaluate(()=>globalThis.listenerCount()),0,'Escape must remove its keyboard listener')
  assert.equal(await page.evaluate(()=>globalThis.fixture.closed),3)
  await page.evaluate(()=>globalThis.clearFixture())
  await page.evaluate(()=>globalThis.renderFixture({kind:'room',id:'g1'},'normal'))
  await focusStatus('reported')
  await page.getByText('Group task',{exact:true}).waitFor()
  await page.evaluate(()=>globalThis.clearFixture())
  await page.locator('.bt-board-backdrop').waitFor({state:'detached'})
  assert.equal(await page.evaluate(()=>globalThis.listenerCount()),0,'host unmount must remove keyboard listener')
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.evaluate(()=>{globalThis.clearFixture();globalThis.initPhase2();globalThis.renderFixture({kind:'room',id:'p2'},'phase2',true)})
  await page.getByText('Phase task',{exact:true}).waitFor()

  // Type: create with an explicit type, filter by it, then move it between type lanes.
  const preparingLane=workflowLane('proposed')
  await focusStatus('proposed')
  await preparingLane.getByRole('button',{name:'Add card to Preparing'}).click()
  const typeCreateDialog=page.locator('.bt-create-modal')
  await typeCreateDialog.waitFor()
  await typeCreateDialog.getByLabel('Title').fill('Typed card')
  await typeCreateDialog.getByLabel('Task type').selectOption('bugfix')
  await typeCreateDialog.getByLabel('Owner').selectOption('a')
  await typeCreateDialog.getByLabel('Independent reviewer').selectOption('b')
  await typeCreateDialog.getByLabel('Acceptance criteria').fill('Type evidence')
  await typeCreateDialog.getByRole('button',{name:'Create card'}).click()
  await page.waitForFunction(()=>globalThis.fixture.calls.some(call=>call.endpoint==='board-command'&&call.payload.type==='create'&&call.payload.value.title==='Typed card'))
  const typedCreate=await page.evaluate(()=>globalThis.fixture.calls.find(call=>call.endpoint==='board-command'&&call.payload.type==='create'&&call.payload.value.title==='Typed card'))
  const typedId=typedCreate.payload.taskId
  assert.equal(typedCreate.payload.value.type,'bugfix','create sends the selected task type')
  await typeCreateDialog.waitFor({state:'detached'})
  const typedCard=page.locator('article.bt-board-card').filter({hasText:'Typed card'})
  await typedCard.waitFor()
  assert.equal(await typedCard.locator('.bt-board-type-bugfix').innerText(),'Bugfix','the card shows its type chip')

  await page.getByLabel('Filter by type').selectOption('bugfix')
  await page.waitForFunction(()=>document.querySelectorAll('article.bt-board-card').length===1)
  assert.equal(await page.getByText('Phase task',{exact:true}).count(),0,'the type filter hides other types')
  await typedCard.waitFor()
  await page.getByLabel('Filter by type').selectOption('')

  await page.locator('.bt-board-views').getByRole('button',{name:'Type',exact:true}).click()
  const typeSection=page.locator('.bt-board-section[aria-label="Task types"]')
  await typeSection.waitFor()
  await exerciseColumns(page, typeSection)
  const bugfixLane=typeSection.locator('.bt-board-lane[aria-label="Bugfix"]')
  const featureLane=typeSection.locator('.bt-board-lane[aria-label="Feature"]')
  await bugfixLane.locator('[data-task-id="'+typedId+'"]').waitFor()
  const typeCommandCount=async()=>page.evaluate(id=>globalThis.fixture.calls.filter(call=>call.endpoint==='board-command'&&call.payload.type==='card-details'&&call.payload.taskId===id).length,typedId)
  assert.equal(await typeCommandCount(),0,'no type change is sent before the board confirmation')
  await bugfixLane.locator('[data-task-id="'+typedId+'"]').dragTo(featureLane)
  const boardConfirm=page.locator('.bt-board-confirm')
  await boardConfirm.waitFor()
  assert.match(await boardConfirm.innerText(),/Type[\s\S]*Bugfix[\s\S]*Feature/,'the board confirmation shows the before and after type')
  await boardConfirm.getByRole('button',{name:'Cancel',exact:true}).click()
  await boardConfirm.waitFor({state:'detached'})
  assert.equal(await typeCommandCount(),0,'cancelling the board confirmation sends no command')
  await bugfixLane.locator('[data-task-id="'+typedId+'"]').waitFor()
  assert.equal(await featureLane.locator('[data-task-id="'+typedId+'"]').count(),0,'cancelling leaves the card in its original type lane')

  await bugfixLane.locator('[data-task-id="'+typedId+'"]').dragTo(featureLane)
  await boardConfirm.waitFor()
  await boardConfirm.getByRole('button',{name:'Confirm',exact:true}).click()
  await boardConfirm.waitFor({state:'detached'})
  await page.waitForFunction(id=>globalThis.fixture.calls.some(call=>call.endpoint==='board-command'&&call.payload.type==='card-details'&&call.payload.taskId===id&&call.payload.value.type==='feature'),typedId)
  const typeCommand=await page.evaluate(id=>globalThis.fixture.calls.find(call=>call.endpoint==='board-command'&&call.payload.type==='card-details'&&call.payload.taskId===id&&call.payload.value.type==='feature'),typedId)
  assert.equal(typeCommand.payload.value.type,'feature')
  await featureLane.locator('[data-task-id="'+typedId+'"]').waitFor()

  // The card Type editor is the confirmation path for a type change.
  await featureLane.locator('[data-task-id="'+typedId+'"] .bt-board-card-summary').click()
  const typedModal=page.locator('.bt-card-modal')
  await typedModal.waitFor()
  await typedModal.getByLabel('Task type').selectOption('bugfix')
  await approveChange(page,typedModal)
  await page.waitForFunction(id=>globalThis.fixture.calls.some(call=>call.endpoint==='board-command'&&call.payload.type==='card-details'&&call.payload.taskId===id&&call.payload.value.type==='bugfix'),typedId)
  assert.equal(await typedModal.getByLabel('Task type').inputValue(),'bugfix')
  await page.keyboard.press('Escape')
  await typedModal.waitFor({state:'detached'})
  await typeSection.locator('.bt-board-lane[aria-label="Bugfix"] [data-task-id="'+typedId+'"]').waitFor()

  await page.locator('.bt-board-views').getByRole('button',{name:'Status',exact:true}).click()
  await page.locator('.bt-board-release-bar').waitFor()

  // Draft: create into Draft, then submit, cancel and restore from the detail actions.
  await focusStatus('draft')
  const draftLane=workflowLane('draft')
  const proposedBefore=Number((await statusChip('proposed').locator('.bt-status-chip-count').innerText()).trim())
  const cancelledBefore=Number((await statusChip('cancelled').locator('.bt-status-chip-count').innerText()).trim())
  await draftLane.getByRole('button',{name:'Add card',exact:true}).click()
  const draftQuick=draftLane.locator('.bt-board-quick-add')
  await draftQuick.getByLabel('Card title').fill('Draft card')
  await draftQuick.getByRole('button',{name:'Add card'}).click()
  const draftDialog=page.locator('.bt-create-modal')
  await draftDialog.waitFor()
  assert.equal(await draftDialog.getByLabel('Save as draft').isChecked(),true,'the Draft lane defaults to Save as draft')
  await draftDialog.getByLabel('Owner').selectOption('a')
  await draftDialog.getByLabel('Independent reviewer').selectOption('b')
  await draftDialog.getByLabel('Acceptance criteria').fill('Draft evidence')
  await draftDialog.getByRole('button',{name:'Save as draft'}).click()
  await page.waitForFunction(()=>globalThis.fixture.calls.some(call=>call.endpoint==='board-command'&&call.payload.type==='create'&&call.payload.value.title==='Draft card'))
  const draftCreate=await page.evaluate(()=>globalThis.fixture.calls.find(call=>call.endpoint==='board-command'&&call.payload.type==='create'&&call.payload.value.title==='Draft card'))
  const draftId=draftCreate.payload.taskId
  assert.equal(draftCreate.payload.value.draft,true,'Draft lane creation sends draft:true')
  await draftDialog.waitFor({state:'detached'})
  await draftLane.locator('[data-task-id="'+draftId+'"]').waitFor()

  await draftLane.locator('[data-task-id="'+draftId+'"] .bt-board-card-summary').click()
  const draftModal=page.locator('.bt-card-modal')
  await draftModal.waitFor()
  await draftModal.getByText('Draft cards are not scheduled.').waitFor()
  await draftModal.getByRole('button',{name:'Submit card'}).click()
  await page.waitForFunction(id=>globalThis.fixture.calls.some(call=>call.endpoint==='board-command'&&call.payload.type==='submit'&&call.payload.taskId===id),draftId)
  await page.waitForFunction(expected=>Number(document.querySelector('.bt-status-chip[data-status="proposed"] .bt-status-chip-count')?.textContent)===expected,proposedBefore+1)
  await draftModal.getByRole('button',{name:'Cancel card'}).click()
  await page.waitForFunction(id=>globalThis.fixture.calls.some(call=>call.endpoint==='board-command'&&call.payload.type==='cancel'&&call.payload.taskId===id),draftId)
  await page.waitForFunction(expected=>Number(document.querySelector('.bt-status-chip[data-status="cancelled"] .bt-status-chip-count')?.textContent)===expected,cancelledBefore+1)
  await draftModal.getByText('Cancelled cards are not scheduled and can be restored.').waitFor()
  await draftModal.getByRole('button',{name:'Restore card'}).click()
  await page.waitForFunction(id=>globalThis.fixture.calls.some(call=>call.endpoint==='board-command'&&call.payload.type==='restore'&&call.payload.taskId===id),draftId)
  await page.waitForFunction(expected=>Number(document.querySelector('.bt-status-chip[data-status="proposed"] .bt-status-chip-count')?.textContent)===expected,proposedBefore+1)
  await page.keyboard.press('Escape')
  await draftModal.waitFor({state:'detached'})
  await page.locator('.bt-board-toast').waitFor({state:'hidden', timeout:6000}).catch(()=>{})
  await draftLane.getByRole('button',{name:'Add card',exact:true}).click()
  const quickDraft=draftLane.locator('.bt-board-quick-add')
  await quickDraft.getByLabel('Card title').fill('Quick draft')
  await quickDraft.getByRole('button',{name:'Add card'}).click()
  const quickDraftDialog=page.locator('.bt-create-modal')
  await quickDraftDialog.waitFor()
  await quickDraftDialog.getByRole('button',{name:'Save as draft'}).click()
  await page.waitForFunction(()=>globalThis.fixture.calls.some(call=>call.endpoint==='board-command'&&call.payload.type==='create'&&call.payload.value.title==='Quick draft'))
  const quickDraftCreate=await page.evaluate(()=>globalThis.fixture.calls.find(call=>call.endpoint==='board-command'&&call.payload.type==='create'&&call.payload.value.title==='Quick draft'))
  assert.equal(quickDraftCreate.payload.value.owner,'a','a title-only draft gets an owner')
  assert.equal(quickDraftCreate.payload.value.reviewer,'b','a title-only draft gets an independent reviewer')
  assert.equal(quickDraftCreate.payload.value.acceptance,'To be defined.','a title-only draft gets placeholder acceptance')
  await quickDraftDialog.waitFor({state:'detached'})

  // Releases: two releases, assignment both ways, then queue, start and cancel.
  const releaseBar=page.locator('.bt-board-release-bar')
  await releaseBar.waitFor()
  assert.equal(await releaseBar.locator('.bt-board-release-chip').count(),2,'the release bar shows both releases')
  assert.match(await releaseBar.locator('.bt-board-release-chip').first().innerText(),/1\.0[\s\S]*0\/0/)
  assert.match(await releaseBar.locator('.bt-board-release-chip').first().getAttribute('aria-label'),/Release one[\s\S]*Draft/)
  assert.match(await releaseBar.locator('.bt-board-release-chip').nth(1).innerText(),/2\.0[\s\S]*0\/0/)
  assert.match(await releaseBar.locator('.bt-board-release-chip').nth(1).getAttribute('aria-label'),/Release two[\s\S]*Queued/)
  await releaseBar.locator('.bt-board-release-chip').first().click()
  const releaseSection=page.locator('.bt-board-section[aria-label="Releases"]')
  await releaseSection.waitFor()
  assert.equal(await page.locator('.bt-board-views').getByRole('button',{name:'Release',exact:true}).getAttribute('aria-pressed'),'true','the release chip opens the Release view')
  await page.locator('.bt-board-views').getByRole('button',{name:'Status',exact:true}).click()
  await releaseBar.waitFor()
  await page.locator('.bt-board-views').getByRole('button',{name:'Release',exact:true}).click()
  await releaseSection.waitFor()
  const unassignedLane=releaseSection.locator('[data-kind="release"][data-stage="unassigned"]')
  const releaseOneLane=releaseSection.locator('[data-release-id="rel-1"]')
  const releaseTwoLane=releaseSection.locator('[data-release-id="rel-2"]')
  assert.equal(await unassignedLane.count(),1,'the release view includes the Unassigned lane')
  assert.equal(await releaseOneLane.count(),1,'the release view includes the first release lane')
  assert.equal(await releaseTwoLane.count(),1,'the release view includes the second release lane')
  await unassignedLane.locator('[data-task-id="T1"]').waitFor()
  await unassignedLane.locator('[data-task-id="T1"]').dragTo(releaseOneLane)
  await page.waitForFunction(()=>globalThis.fixture.calls.some(call=>call.endpoint==='board-release-assign'))
  const assign=await page.evaluate(()=>globalThis.fixture.calls.find(call=>call.endpoint==='board-release-assign'))
  assert.equal(assign.payload.releaseId,'rel-1')
  assert.equal(assign.payload.taskId,'T1')
  assert.equal(assign.payload.afterId,null)
  assert.equal(assign.payload.expectedReleaseRevision,1)
  assert.equal(assign.payload.expectedTaskRevision,1)
  await releaseOneLane.locator('[data-task-id="T1"]').waitFor()
  assert.equal(await releaseOneLane.locator('.bt-board-lane-title .bt-board-count').innerText(),'1','the release lane count follows the assignment')
  assert.match(await releaseOneLane.locator('.bt-board-release-progress').innerText(),/0\/1 done/)
  await releaseOneLane.locator('[data-task-id="T1"]').dragTo(unassignedLane)
  await page.waitForFunction(()=>globalThis.fixture.calls.some(call=>call.endpoint==='board-release-remove'))
  const remove=await page.evaluate(()=>globalThis.fixture.calls.find(call=>call.endpoint==='board-release-remove'))
  assert.equal(remove.payload.releaseId,'rel-1')
  assert.equal(remove.payload.taskId,'T1')
  assert.equal(remove.payload.expectedReleaseRevision,2)
  assert.equal(remove.payload.expectedTaskRevision,2)
  await unassignedLane.locator('[data-task-id="T1"]').waitFor()

  const queueRevision=await page.evaluate(()=>globalThis.fixture.releases.find(release=>release.id==='rel-1').revision)
  await releaseOneLane.getByRole('button',{name:'Queue',exact:true}).click()
  await page.waitForFunction(()=>globalThis.fixture.calls.some(call=>call.endpoint==='board-release-queue'))
  const queue=await page.evaluate(()=>globalThis.fixture.calls.find(call=>call.endpoint==='board-release-queue'))
  assert.equal(queue.payload.releaseId,'rel-1')
  assert.equal(queue.payload.expectedRevision,queueRevision)
  await releaseOneLane.getByRole('button',{name:'Start',exact:true}).waitFor()
  const startRevision=await page.evaluate(()=>globalThis.fixture.releases.find(release=>release.id==='rel-1').revision)
  await releaseOneLane.getByRole('button',{name:'Start',exact:true}).click()
  await page.waitForFunction(()=>globalThis.fixture.calls.some(call=>call.endpoint==='board-release-start'))
  const start=await page.evaluate(()=>globalThis.fixture.calls.find(call=>call.endpoint==='board-release-start'))
  assert.equal(start.payload.releaseId,'rel-1')
  assert.equal(start.payload.expectedRevision,startRevision)
  const cancelRevision=await page.evaluate(()=>globalThis.fixture.releases.find(release=>release.id==='rel-1').revision)
  await releaseOneLane.locator('.bt-board-release-menu > summary').click()
  await releaseOneLane.getByRole('button',{name:'Cancel release',exact:true}).click()
  await page.locator('.bt-board-confirm').waitFor()
  await page.locator('.bt-board-confirm').getByRole('button',{name:'Confirm',exact:true}).click()
  await page.waitForFunction(()=>globalThis.fixture.calls.some(call=>call.endpoint==='board-release-cancel'))
  const cancelRelease=await page.evaluate(()=>globalThis.fixture.calls.find(call=>call.endpoint==='board-release-cancel'))
  assert.equal(cancelRelease.payload.releaseId,'rel-1')
  assert.equal(cancelRelease.payload.expectedRevision,cancelRevision)
  assert.match(await releaseOneLane.innerText(),/Cancelled/)
  await page.locator('.bt-board-views').getByRole('button',{name:'Status',exact:true}).click()
  assert.match(await releaseBar.locator('.bt-board-release-chip').first().getAttribute('aria-label'),/Cancelled/)

  // Proposals: pending changes show before/after rows and both decisions hit the endpoint.
  const changesButton=page.locator('.bt-board-changes')
  assert.match(await changesButton.innerText(),/Changes[\s\S]*1/)
  await changesButton.click()
  const proposalPanel=page.locator('.bt-board-proposals')
  await proposalPanel.waitFor()
  assert.equal(await proposalPanel.locator('.bt-board-proposal').count(),1)
  const confirmProposal=proposalPanel.locator('.bt-board-proposal').filter({hasText:'Confirm change'})
  assert.match(await confirmProposal.locator('.bt-board-proposal-diff').innerText(),/Title[\s\S]*Phase task[\s\S]*Phase task renamed/)
  await confirmProposal.getByRole('button',{name:'Confirm',exact:true}).click()
  await page.waitForFunction(()=>globalThis.fixture.calls.some(call=>call.endpoint==='board-proposal-decide'&&call.payload.proposalId==='p1'))
  const confirmDecision=await page.evaluate(()=>globalThis.fixture.calls.find(call=>call.endpoint==='board-proposal-decide'&&call.payload.proposalId==='p1'))
  assert.equal(confirmDecision.payload.decision,'confirm')
  assert.equal(confirmDecision.payload.expectedRevision,1)
  await confirmProposal.waitFor({state:'detached'})
  const rejectProposal=proposalPanel.locator('.bt-board-proposal').filter({hasText:'Reject change'})
  await rejectProposal.waitFor()
  assert.match(await rejectProposal.locator('.bt-board-proposal-diff').innerText(),/Type[\s\S]*Bugfix[\s\S]*Test/)
  await rejectProposal.getByRole('button',{name:'Reject',exact:true}).click()
  await page.waitForFunction(()=>globalThis.fixture.calls.some(call=>call.endpoint==='board-proposal-decide'&&call.payload.proposalId==='p2'))
  const rejectDecision=await page.evaluate(()=>globalThis.fixture.calls.find(call=>call.endpoint==='board-proposal-decide'&&call.payload.proposalId==='p2'))
  assert.equal(rejectDecision.payload.decision,'reject')
  assert.equal(rejectDecision.payload.expectedRevision,1)
  await rejectProposal.waitFor({state:'detached'})
  assert.equal(await proposalPanel.locator('.bt-board-proposal').count(),0)

  // Bulk status + archive view: a draft can be submitted and undone, and an
  // archived card can be restored from the Archive view.
  await page.evaluate(()=>{const s=globalThis.fixture;s.phase2Tasks=[
    {id:'D1',title:'Bulk draft',type:'feature',owner:'a',reviewer:'b',acceptance:'Evidence',dependencies:[],revision:1,status:'draft',comments:[]},
    {id:'A1',title:'Archived card',type:'bugfix',owner:'a',reviewer:'b',acceptance:'Evidence',dependencies:[],revision:1,status:'proposed',archivedAt:1700000000000,comments:[]},
  ];s.phase2Reject=undefined;s.calls=[];globalThis.renderFixture({kind:'room',id:'g1'},'phase2',true)})
  await focusStatus('draft')
  await workflowLane('draft').locator('[data-task-id="D1"]').waitFor()
  await page.getByRole('button',{name:'Select',exact:true}).click()
  await page.getByLabel('Select card').check()
  await page.getByLabel('Apply status to selected cards').selectOption('submit')
  await page.locator('.bt-board-confirm').getByRole('button',{name:'Confirm',exact:true}).click()
  await page.waitForFunction(()=>globalThis.fixture.calls.some(call=>call.endpoint==='board-command'&&call.payload.type==='submit'&&call.payload.taskId==='D1'))
  const bulkSubmit=await page.evaluate(()=>globalThis.fixture.calls.find(call=>call.endpoint==='board-command'&&call.payload.type==='submit'))
  assert.equal(bulkSubmit.payload.taskId,'D1','bulk status applies to the selected draft')
  await page.locator('.bt-board-toast-action').click()
  await page.waitForFunction(()=>globalThis.fixture.calls.some(call=>call.endpoint==='board-command'&&call.payload.type==='cancel'&&call.payload.taskId==='D1'))
  const bulkUndo=await page.evaluate(()=>globalThis.fixture.calls.find(call=>call.endpoint==='board-command'&&call.payload.type==='cancel'))
  assert.equal(bulkUndo.payload.taskId,'D1','bulk status undo uses the inverse command')
  await page.locator('.bt-board-views').getByRole('button',{name:'Archive',exact:true}).click()
  await page.locator('.bt-board-section[aria-label="Archive"] [data-task-id="A1"]').waitFor()
  await page.getByRole('button',{name:'Select',exact:true}).click()
  await page.getByLabel('Select card').check()
  await page.getByLabel('Apply status to selected cards').selectOption('unarchive')
  await page.locator('.bt-board-confirm').getByRole('button',{name:'Confirm',exact:true}).click()
  await page.waitForFunction(()=>globalThis.fixture.calls.some(call=>call.endpoint==='board-command'&&call.payload.type==='unarchive'&&call.payload.taskId==='A1'))
  const bulkUnarchive=await page.evaluate(()=>globalThis.fixture.calls.find(call=>call.endpoint==='board-command'&&call.payload.type==='unarchive'))
  assert.equal(bulkUnarchive.payload.taskId,'A1','Archive view restores selected archived cards')

  assert.deepEqual(errors, [])
  console.log('PASS ' + assertions + ' assertions: board images, legacy cards, description/labels/due/checklist/comments, attachments and covers, quick add, personal progress, group scheduling, sharing, explicit cancellation, late response, reopen, scoped rendering and conflicts, task types, draft/cancelled, releases and proposals')
}
try { await runBrowserCases() } finally { console.log('ASSERTIONS executed=' + assertions + ' failed=' + assertionFailures); await browser.close() }
