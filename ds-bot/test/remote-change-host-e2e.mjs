// Isolated real DSH process and browser. Uses only synthetic data and denies external fetch.
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const harness=process.env.DSH_HARNESS
if (!harness) throw new Error('DSH_HARNESS is required')
const here=dirname(fileURLToPath(import.meta.url)), plugin=resolve(here,'..')
const web=createRequire(join(harness,'apps/web/package.json'))
const { chromium }=web('playwright')
const home=mkdtempSync(join(tmpdir(),'dsbot-monitor-e2e-')),team=join(home,'bot'),profile=join(home,'profiles/web')
const a='a'.repeat(40),c='c'.repeat(40)
let host,browser
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))
const port=await new Promise((resolvePort,reject)=>{const s=createServer();s.on('error',reject);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolvePort(p))})})
mkdirSync(join(profile,'node_modules'),{recursive:true});mkdirSync(team,{recursive:true})
symlinkSync(plugin,join(profile,'node_modules/ds-bot'),'dir')
writeFileSync(join(profile,'package.json'),JSON.stringify({name:'isolated-profile',private:true,dependencies:{'ds-bot':`link:${plugin}`},dsh:{profile:{bundles:['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app','ds-bot']}}}))
writeFileSync(join(team,'state.json'),JSON.stringify({version:1,bots:{'pm-fixture':{id:'pm-fixture',name:'Fixture PM',createdAt:1,capabilities:[]}},rooms:{},mainBotIds:[],capabilities:{items:{}},revision:1}))
writeFileSync(join(team,'secrets.json'),JSON.stringify({secrets:[{name:'GITHUB_TOKEN',value:'isolated-test-token',scope:['pm-fixture']}]}),{mode:0o600})
const overlay=join(home,'fixture.patch.yml')
writeFileSync(overlay,`- id: bot\n  config:\n    remoteChangeWatch:\n      repository: example/project\n      branch: main\n      ownerBotId: pm-fixture\n      initialCursor: ${a}\n`)
async function start(){
  let output=''
  host=spawn(process.execPath,['--import','tsx/esm','apps/cli/src/bin.ts','--profile','web','--patch',overlay,'--no-open','--port',String(port)],{cwd:harness,env:{...process.env,DSH_HOME:home,NODE_OPTIONS:`--import=${join(here,'remote-watch-fetch-fixture.mjs')}`},stdio:['ignore','pipe','pipe']})
  for(const stream of [host.stdout,host.stderr])stream.on('data',chunk=>{output+=chunk.toString()})
  const until=Date.now()+45_000
  while(Date.now()<until){
    const match=output.match(new RegExp(`http://127\\.0\\.0\\.1:${port}/\\?token=[^\\s]+`))
    if(match)return match[0]
    if(host.exitCode!==null)throw new Error(`isolated host exited ${host.exitCode}: ${output.replace(/token=[^\s]+/g,'token=[redacted]').slice(-2000)}`)
    await sleep(200)
  }
  throw new Error('isolated host start timed out')
}
async function stop(){if(!host)return;const proc=host;host=undefined;if(proc.exitCode!==null)return;proc.kill('SIGTERM');await Promise.race([new Promise(resolve=>proc.once('exit',resolve)),sleep(5000)]);if(proc.exitCode===null)proc.kill('SIGKILL')}
async function board(page){return page.evaluate(()=>fetch('/api/bot',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({endpoint:'board-list',payload:{scope:{kind:'personal',id:'user'}}})}).then(r=>r.json()))}
try {
  let url=await start()
  browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{}),args:['--no-sandbox','--disable-background-networking']})
  let page=await browser.newPage()
  await page.route('**/*',route=>{const u=new URL(route.request().url());return u.hostname==='127.0.0.1'||u.hostname==='localhost'?route.continue():route.abort()})
  await page.goto(url)
  await page.waitForFunction(async()=>{try{const r=await fetch('/api/bot',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({endpoint:'board-list',payload:{scope:{kind:'personal',id:'user'}}})}).then(r=>r.json());return r.ok&&r.value.remoteChanges?.status==='ok'}catch{return false}},null,{timeout:45_000})
  let result=await board(page);assert.equal(result.value.remoteChanges.events.length,1);assert.equal(result.value.remoteChanges.events[0].sha,c)
  await stop();await page.close()
  url=await start();page=await browser.newPage();await page.route('**/*',route=>{const u=new URL(route.request().url());return u.hostname==='127.0.0.1'||u.hostname==='localhost'?route.continue():route.abort()});await page.goto(url)
  await page.waitForFunction(async()=>{try{const r=await fetch('/api/bot',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({endpoint:'board-list',payload:{scope:{kind:'personal',id:'user'}}})}).then(r=>r.json());return r.ok&&r.value.remoteChanges?.events?.length===1}catch{return false}},null,{timeout:30_000})
  result=await board(page);assert.equal(result.value.remoteChanges.events[0].sha,c)
  const revoke=await page.evaluate(()=>fetch('/api/bot',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({endpoint:'secret-set',payload:{name:'GITHUB_TOKEN',value:'isolated-test-token',scope:[]}})}).then(r=>r.json()))
  assert.equal(revoke.ok,true)
  result=await board(page);assert.equal(result.value.remoteChanges.status,'authorization unavailable');assert.equal(result.value.remoteChanges.events.length,0)
  console.log('isolated real Host: persisted event, restart and authorization revocation passed')
} finally {await browser?.close();await stop();rmSync(home,{recursive:true,force:true})}
