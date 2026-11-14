// Isolated network namespace and synthetic DSH_HOME; no provider or credentials.
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

const base=process.env.E2E_ARTIFACTS, harness=process.env.DSH_HARNESS, plugin=process.env.DSBOT_PLUGIN
if (!base || !harness || !plugin) throw Error('E2E_ARTIFACTS, DSH_HARNESS and DSBOT_PLUGIN are required')
const { chromium }=createRequire(process.env.E2E_PLAYWRIGHT_PACKAGE ?? join(harness,'apps/web/package.json'))('playwright')
const home=mkdtempSync(join(base,'home-')),profile=join(home,'profiles/web')
mkdirSync(join(profile,'node_modules'),{recursive:true});mkdirSync(join(home,'bot'),{recursive:true})
symlinkSync(plugin,join(profile,'node_modules/ds-bot'),'dir')
writeFileSync(join(profile,'package.json'),JSON.stringify({name:'redo-auth-test',private:true,dependencies:{'ds-bot':`link:${plugin}`},dsh:{profile:{bundles:['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app','ds-bot']}}}))
writeFileSync(join(home,'bot/state.json'),JSON.stringify({version:1,bots:{},rooms:{},mainBotIds:[],capabilities:{items:{}},revision:1}))
const port=await new Promise((yes,no)=>{const s=createServer();s.on('error',no);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>yes(p))})})
const pause=ms=>new Promise(ok=>setTimeout(ok,ms))
const env={PATH:process.env.PATH,HOME:home,DSH_HOME:home,NO_PROXY:'*',TMPDIR:base}
const host=spawn(process.execPath,['apps/cli/lib/bin.js','web','--no-open','--port',String(port)],{cwd:harness,env,stdio:['ignore','pipe','pipe']})
let output='',browser
for(const stream of [host.stdout,host.stderr])stream.on('data',chunk=>{output+=chunk.toString()})
try {
  let url
  for(let until=Date.now()+90000;Date.now()<until;){
    const match=output.match(new RegExp(`http://127\\.0\\.0\\.1:${port}/\\?token=[^\\s]+`))
    if(match){url=match[0];break} if(host.exitCode!==null)throw Error(`host exited ${host.exitCode}: ${output.replace(/token=[^\s]+/g,'token=[redacted]').slice(-2500)}`)
    await pause(200)
  }
  if(!url)throw Error(`host start timed out: ${output.replace(/token=[^\s]+/g,'token=[redacted]').slice(-2500)}`)
  const payload={endpoint:'board-redo-preview',payload:{scope:{kind:'personal',id:'user'},recoveryId:'a'.repeat(64)}}
  const unauth=await fetch(`http://127.0.0.1:${port}/api/bot`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)})
  assert.ok([401,403].includes(unauth.status),`unauthenticated status ${unauth.status}`)
  browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH ?? '/usr/bin/google-chrome',args:['--no-sandbox','--disable-background-networking']})
  const page=await browser.newPage();await page.goto(url);await page.waitForLoadState('domcontentloaded')
  async function call(body){return page.evaluate(value=>fetch('/api/bot',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(value)}).then(r=>r.json()),body)}
  let board
  for(let end=Date.now()+30000;Date.now()<end;){board=await call({endpoint:'board-list',payload:{scope:{kind:'personal',id:'user'}}});if(board.ok)break;await pause(100)}
  assert.equal(board?.ok,true,'authenticated owner board route ready')
  const preview=await call(payload)
  assert.equal(preview.ok,false);assert.notEqual(preview.error?.code,'bot/not-found')
  const confirmation=await call({endpoint:'board-redo-confirm',payload:{...payload.payload,operationId:'9d5b1723-7063-4e3e-b27e-12f44dd0033d',acknowledged:true,confirmationDigest:'b'.repeat(64)}})
  assert.equal(confirmation.ok,false);assert.notEqual(confirmation.error?.code,'bot/not-found')
  console.log(JSON.stringify({unauthStatus:unauth.status,ownerBoard:board.ok,previewRejected:!preview.ok,confirmRejected:!confirmation.ok,execution:'not invoked'}))
} finally {
  await browser?.close().catch(()=>{})
  if(host.exitCode===null){host.kill('SIGTERM');await Promise.race([new Promise(resolve=>host.once('exit',resolve)),pause(5000)]);if(host.exitCode===null){host.kill('SIGKILL');await new Promise(resolve=>host.once('exit',resolve))}}
}
