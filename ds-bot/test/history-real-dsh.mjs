// Synthetic team on a private DSH_HOME. No production files or credentials.
// The DSH CLI, web UI, plugin Host, persistence and image worker are real;
// no model is configured, so this does not validate model/Agent dispatch.
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'

const harness=process.env.DSH_HARNESS, plugin=process.env.DSBOT_PLUGIN, base=process.env.E2E_ARTIFACTS, expected=process.env.EXPECTED_SHA
if(!harness||!plugin||!base||!expected)throw new Error('DSH_HARNESS, DSBOT_PLUGIN, E2E_ARTIFACTS and EXPECTED_SHA are required')
const sha=execFileSync('git',['-C',plugin,'rev-parse','HEAD'],{encoding:'utf8'}).trim()
if(sha!==expected)throw Error('Plugin SHA does not match EXPECTED_SHA')
if(execFileSync('git',['-C',plugin,'status','--porcelain','--untracked-files=no'],{encoding:'utf8'}).trim())throw Error('Plugin tracked files must match committed SHA')
const {chromium}=createRequire(join(harness,'apps/web/package.json'))('playwright')
const pngjs=createRequire(join(plugin,'package.json'))('pngjs')
const home=mkdtempSync(join(base,'real-dsh-home-')), team=join(home,'bot'), profile=join(home,'profiles/web')
mkdirSync(join(profile,'node_modules'),{recursive:true});mkdirSync(team,{recursive:true})
symlinkSync(plugin,join(profile,'node_modules/ds-bot'),'dir')
writeFileSync(join(profile,'package.json'),JSON.stringify({name:'isolated-board-test',private:true,dependencies:{'ds-bot':`link:${plugin}`},dsh:{profile:{bundles:['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app','ds-bot']}}}))
writeFileSync(join(team,'state.json'),JSON.stringify({version:1,bots:{},rooms:{},mainBotIds:[],capabilities:{items:{}},revision:1}))
const port=await new Promise((ok,fail)=>{const s=createServer();s.on('error',fail);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>ok(p))})})
const sleep=ms=>new Promise(r=>setTimeout(r,ms))
let host,browser,page,output=''
async function start(){
  output=''
  const env={...process.env}
  for(const k of Object.keys(env))if(/^(?:HTTP|HTTPS|ALL|NO)_PROXY$/i.test(k)||/^(?:DSH_|DS_BOT_|NODE_OPTIONS$)/.test(k)||/(?:TOKEN|SECRET|PASSWORD|API_KEY|CREDENTIAL)/i.test(k))delete env[k]
  env.DSH_HOME=home
  host=spawn(process.execPath,['--import','tsx/esm','apps/cli/src/bin.ts','--profile','web','--no-open','--port',String(port)],{cwd:harness,env,stdio:['ignore','pipe','pipe']})
  for(const stream of [host.stdout,host.stderr])stream.on('data',chunk=>{output+=chunk.toString()})
  const until=Date.now()+120_000
  while(Date.now()<until){const match=output.match(new RegExp(`http://127\\.0\\.0\\.1:${port}/\\?token=[^\\s]+`));if(match)return match[0];if(host.exitCode!==null)throw Error(`host exited ${host.exitCode}: ${output.replace(/token=[^\s]+/g,'token=[redacted]').slice(-2500)}`);await sleep(200)}
  throw Error(`host start timed out: ${output.replace(/token=[^\s]+/g,'token=[redacted]').slice(-2500)}`)
}
async function stop(){if(!host)return;const p=host;host=undefined;if(p.exitCode!==null)return;p.kill('SIGTERM');await Promise.race([new Promise(r=>p.once('exit',r)),sleep(5000)]);if(p.exitCode===null)p.kill('SIGKILL')}
async function open(url){
  page=await browser.newPage(); page.setDefaultTimeout(15_000)
  await page.route('**/*',route=>{const u=new URL(route.request().url());return ['127.0.0.1','localhost'].includes(u.hostname)?route.continue():route.abort()})
  await page.goto(url); await page.waitForLoadState('domcontentloaded')
  // The web listener can become ready before the plugin has registered its
  // route. Retry only that 404, and surface any other response or early exit.
  const until=Date.now()+60_000
  while(Date.now()<until){
    const probe=await page.evaluate(async()=>{const r=await fetch('/api/bot',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({endpoint:'state',payload:{}})});return {status:r.status,text:await r.text()}})
    if(probe.status!==404){let data;try{data=JSON.parse(probe.text)}catch{throw Error(`Plugin readiness returned non-JSON HTTP ${probe.status}: ${probe.text.slice(0,300)}`)}
      if(!data.ok)throw Error(`Plugin readiness failed HTTP ${probe.status}: ${JSON.stringify(data.error)}`)
      return
    }
    if(host.exitCode!==null)throw Error(`Host exited ${host.exitCode} before plugin readiness`)
    await sleep(200)
  }
  throw Error('Plugin route did not become ready in 60 seconds')
}
async function api(endpoint,payload={}){
  const data=await page.evaluate(async ({endpoint,payload})=>fetch('/api/bot',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({endpoint,payload})}).then(r=>r.json()),{endpoint,payload})
  if(!data.ok)throw Error(`${endpoint}: ${JSON.stringify(data.error)}`)
  return data.value
}
async function waitFor(predicate,label){let value;const end=Date.now()+15_000;while(Date.now()<end){value=await predicate();if(value)return value;await sleep(100)}throw Error(`Timed out: ${label}`)}

// These hashes bind the synthetic historical evidence; they do not claim that a
// real administrator carried out an inspection in this isolated home.
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
function inspection(goal) {
  const stage=goal.stages?.[goal.current]
  return digest({id:goal.id,revision:goal.revision,status:goal.status,title:goal.title,objective:goal.objective,
    acceptance:goal.acceptance,constraints:goal.constraints,current:goal.current,stage:stage===undefined?null:{
      id:stage.id,title:stage.title,acceptance:stage.acceptance,status:stage.status,tasks:(stage.tasks??[]).map(digest)}})
}
function facts(goal) { const copy=structuredClone(goal); delete copy.boardCards; return copy }
const clickText=async pattern=>{const item=page.getByText(pattern,{exact:true}).first();await item.waitFor();await item.click()}
const roomScope=id=>({kind:'room',id})
const lookup=(view,title)=>view.tasks.find(task=>task.legacy?.originalTitle===title)
const statePath=join(team,'state.json')
const saveState=state=>writeFileSync(statePath,JSON.stringify(state))
const readState=()=>JSON.parse(readFileSync(statePath,'utf8'))
const titleFor=position=>`Synthetic ${position} task`
let roomId, baseline, archivedBaseline, originalFingerprints, inspectionBefore, originals={}
try {
  console.log(`Plugin commit ${sha}`)
  browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{}),args:['--no-sandbox','--disable-background-networking']})
  await open(await start())
  const first=await api('create-bot',{name:'Fixture Owner',role:'Developer'})
  const second=await api('create-bot',{name:'Fixture Reviewer',role:'Reviewer'})
  const room=await api('create-room',{name:'Fixture History Group',members:[first.id,second.id],admin:first.id,greet:false})
  roomId=room.id
  await page.close();page=undefined;await stop()
  const state=readState(), now=1700000000000
  const task=(id,position,status)=>({id,botId:first.id,task:titleFor(position),status,statusVersion:1,note:`Original ${position} evidence`,noteStatus:status,noteAt:now})
  const goal={id:'fixture-goal',title:'Synthetic goal',status:'paused',by:'user',revision:11,current:1,createdAt:now,updatedAt:now,
    objective:'Synthetic goal objective',acceptance:'Independent acceptance',constraints:['Original constraint'],events:[],stages:[
      {id:'s-prev',title:'Previous phase',status:'passed',acceptance:'Previous acceptance',evidence:'Previous proof',passedAt:now,tasks:[task('t-prev','previous','done')]},
      {id:'s-current',title:'Current phase',status:'active',acceptance:'Current acceptance',tasks:[task('t-current','current','working')]},
      {id:'s-future',title:'Future phase',status:'pending',acceptance:'Future acceptance',tasks:[task('t-future','future','pending')]},
    ]}
  goal.ownerReview={stageId:'s-current',checks:{'t-current':{fingerprint:digest(goal.stages[1].tasks[0]),unresolved:false,evidence:'Synthetic stored review evidence'}}}
  const archived={id:'fixture-archived',title:'Archived synthetic goal',status:'complete',by:'user',revision:4,current:0,createdAt:now,updatedAt:now,endedAt:now,
    objective:'Archived objective',acceptance:'Archived acceptance',constraints:[],events:[],stages:[{id:'s-archived',title:'Archived phase',status:'passed',acceptance:'Archived stage acceptance',evidence:'Archived proof',passedAt:now,tasks:[task('t-archived','archived','done')]}]}
  state.rooms[roomId].goal=goal;state.rooms[roomId].pastGoals=[archived];saveState(state)
  // Allow actual Host initialization to normalize its isolated state, then take
  // the baseline from the stopped process before any user edit.
  await start();await stop()
  const settled=readState().rooms[roomId]
  baseline=facts(settled.goal);archivedBaseline=facts(settled.pastGoals[0])
  originalFingerprints=settled.goal.stages.flatMap(stage=>stage.tasks.map(digest))
  inspectionBefore=inspection(settled.goal)
  assert.equal(settled.goal.ownerReview.checks['t-current'].fingerprint,digest(settled.goal.stages[1].tasks[0]))
  await open(await start())
  const scope=roomScope(roomId)
  let board=await waitFor(async()=>{const value=await api('board-list',{scope});return ['current','previous','future','archived'].every(p=>lookup(value,titleFor(p)))&&value},'four original goal cards')
  for(const position of ['current','previous','future','archived']){
    const item=lookup(board,titleFor(position));originals[position]=item.id
    assert.equal(item.legacy.position,position)
  }
  await clickText(/^Fixture History Group$/)
  await page.getByRole('button',{name:/^(Task board|任务看板)$/}).click()
  const png=pngjs.PNG.sync.write({width:1,height:1,data:Buffer.from([1,2,3,255])})
  for(const position of ['current','previous','future','archived']) {
    await page.locator('article').filter({hasText:titleFor(position)}).locator('.bt-board-card-summary').click()
    const card=page.locator('.bt-card-modal');await card.waitFor()
    const labels={current:/^(Current goal task|当前目标任务)$/,previous:/^(Earlier goal stage|先前目标阶段)$/,future:/^(Upcoming goal stage|后续目标阶段)$/,archived:/^(Archived goal task|已归档目标任务)$/}
    await card.getByText(labels[position],{exact:true}).waitFor()
    await card.getByText(/^(Original task description|原始任务说明)$/,{exact:true}).waitFor()
    if(position!=='current')assert.equal(await card.getByRole('button',{name:/^(Edit goal task|编辑群目标任务)$/}).count(),0)
    await card.getByRole('button',{name:/^(Edit card details|编辑卡片详情)$/}).click()
    await card.getByLabel(/^(Description|描述|说明)$/,{exact:true}).fill(`Details ${position}`)
    await card.getByLabel(/^(Due date|截止日期)$/).fill('2026-12-01')
    await card.getByLabel(/^(Labels, one per line|标签，每行一个)$/).fill('fixture')
    await card.getByRole('button',{name:/^(Save changes|保存更改|保存修改)$/}).click()
    await waitFor(async()=>lookup(await api('board-list',{scope}),titleFor(position))?.description===`Details ${position}`,`save ${position} details`)
    await waitFor(()=>card.getByRole('button',{name:/^(Correct card title|修订卡片显示标题)$/}).isEnabled(),`settle ${position}`)
    await card.getByRole('button',{name:/^(Correct card title|修订卡片显示标题)$/}).click()
    await card.getByLabel(/^(Card display title|卡片显示标题)$/).fill(`Corrected ${position}`)
    await card.getByLabel(/^(Reason for correction|修订说明)$/).fill(`Clarify ${position} card`)
    await card.getByRole('button',{name:/^(Save changes|保存更改|保存修改)$/}).click()
    await waitFor(async()=>lookup(await api('board-list',{scope}),titleFor(position))?.title===`Corrected ${position}`,`save ${position} title`)
    await card.getByText(titleFor(position),{exact:true}).waitFor()
    await card.getByText(/^(Card revision history|卡片修订记录)$/,{exact:true}).click()
    await card.getByText(`Clarify ${position} card`,{exact:true}).waitFor()
    if(position==='archived'){
      await waitFor(()=>card.locator('input[type=file]').isEnabled(),'archived image input')
      await card.locator('input[type=file]').setInputFiles([{name:'one.png',mimeType:'image/png',buffer:png},{name:'two.png',mimeType:'image/png',buffer:png}])
      await card.getByRole('button',{name:/^(Upload images|上传图片)$/}).click()
      await waitFor(async()=>lookup(await api('board-list',{scope}),titleFor(position))?.images?.length===2,'archived two images')
    }
    await page.keyboard.press('Escape');await card.waitFor({state:'detached'})
  }
  await page.screenshot({path:join(base,'history-real-board.png')})
  await page.close();page=undefined;await stop();await open(await start())
  board=await api('board-list',{scope})
  for(const position of ['current','previous','future','archived']){
    const item=lookup(board,titleFor(position))
    assert.equal(item.id,originals[position]);assert.equal(item.title,`Corrected ${position}`)
    assert.equal(item.description,`Details ${position}`);assert.equal(item.dueDate,'2026-12-01')
    assert.deepEqual(item.labels,['fixture']);assert.ok(item.boardHistory.length>=2)
    assert.equal(item.legacy.position,position)
  }
  const old=lookup(board,titleFor('archived'));assert.equal(old.images.length,2)
  for(const image of old.images)assert.ok((await api('board-image',{scope,taskId:old.id,imageId:image.id})).data)
  await page.close();page=undefined;await stop()
  const final=readState().rooms[roomId]
  assert.deepEqual(facts(final.goal),baseline,'goal business facts and stored owner review are unchanged')
  assert.deepEqual(facts(final.pastGoals[0]),archivedBaseline,'archived acceptance facts are unchanged')
  assert.deepEqual(final.goal.stages.flatMap(stage=>stage.tasks.map(digest)),originalFingerprints,'task review fingerprints are unchanged')
  assert.equal(inspection(final.goal),inspectionBefore,'inspection fingerprint is unchanged')
  console.log('PASS: real DSH UI edited current, previous, future and archived card data; original facts, stored review and both fingerprint types survive restart')
  console.log('LIMIT: synthetic held review evidence; no model configured, no dispatch or physical power-loss verification')
  console.log(`Synthetic home retained: ${home}`)
} catch(error) {
  if(page)await page.screenshot({path:join(base,'history-real-failure.png')}).catch(()=>{})
  console.error('FAIL:',error.stack||error);console.error('Host output:',output.replace(/token=[^\s]+/g,'token=[redacted]').slice(-5000));console.error(`Synthetic home retained: ${home}`);process.exitCode=1
} finally {await page?.close().catch(()=>{});await browser?.close().catch(()=>{});await stop()}
