// Real DSH CLI/browser, synthetic HOME and a synthetic JSONL candidate; no model.
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
const base=process.env.E2E_ARTIFACTS, harness=process.env.DSH_HARNESS, plugin=process.env.DSBOT_PLUGIN
if (!base || !harness || !plugin) throw Error('E2E_ARTIFACTS, DSH_HARNESS and DSBOT_PLUGIN are required')
const { chromium }=createRequire(process.env.E2E_PLAYWRIGHT_PACKAGE ?? join(harness,'apps/web/package.json'))('playwright')
const home=mkdtempSync(join(base,'positive-')),profile=join(home,'profiles/web')
mkdirSync(join(profile,'node_modules'),{recursive:true});mkdirSync(join(home,'bot'),{recursive:true})
symlinkSync(plugin,join(profile,'node_modules/ds-bot'),'dir')
writeFileSync(join(profile,'package.json'),JSON.stringify({name:'redo-positive-test',private:true,dependencies:{'ds-bot':`link:${plugin}`},dsh:{profile:{bundles:['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app','ds-bot']}}}))
writeFileSync(join(home,'bot/state.json'),JSON.stringify({version:1,bots:{},rooms:{},mainBotIds:[],capabilities:{items:{}},revision:1}))
const port=await new Promise((yes,no)=>{const s=createServer();s.on('error',no);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>yes(p))})})
const pause=ms=>new Promise(ok=>setTimeout(ok,ms)), env={PATH:process.env.PATH,HOME:home,DSH_HOME:home,DSH_HARNESS:harness,NO_PROXY:'*',TMPDIR:base}
let output='',host,browser,page
async function start(){
 output='';host=spawn(process.execPath,['apps/cli/lib/bin.js','web','--no-open','--port',String(port)],{cwd:harness,env,stdio:['ignore','pipe','pipe']})
 for(const stream of [host.stdout,host.stderr])stream.on('data',chunk=>{output+=chunk.toString()})
 for(let until=Date.now()+90000;Date.now()<until;){const match=output.match(new RegExp(`http://127\\.0\\.0\\.1:${port}/\\?token=[^\\s]+`));if(match)return match[0];if(host.exitCode!==null)throw Error(`host exited ${host.exitCode}: ${output.replace(/token=[^\s]+/g,'token=[redacted]').slice(-2500)}`);await pause(200)}
 throw Error(`host start timed out: ${output.replace(/token=[^\s]+/g,'token=[redacted]').slice(-2500)}`)
}
async function stop(){if(!host)return;const p=host;host=undefined;if(p.exitCode!==null)return;p.kill('SIGTERM');await Promise.race([new Promise(ok=>p.once('exit',ok)),pause(5000)]);if(p.exitCode===null){p.kill('SIGKILL');await new Promise(ok=>p.once('exit',ok))}}
async function open(url){page=await browser.newPage();await page.goto(url);await page.waitForLoadState('domcontentloaded')}
async function raw(endpoint,payload){return page.evaluate(({endpoint,payload})=>fetch('/api/bot',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({endpoint,payload})}).then(r=>r.json()),{endpoint,payload})}
async function api(endpoint,payload){const value=await raw(endpoint,payload);if(!value.ok)throw Error(`${endpoint}: ${JSON.stringify(value.error)}`);return value.value}
try {
 browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH ?? '/usr/bin/google-chrome',args:['--no-sandbox','--disable-background-networking']})
 await open(await start())
 let ready=false;for(let end=Date.now()+30000;Date.now()<end;){const r=await raw('board-list',{scope:{kind:'personal',id:'user'}});if(r.ok){ready=true;break}await pause(100)}
 assert.ok(ready,'board route ready')
 const bot=await api('create-bot',{name:'Synthetic Owner',role:'Developer'})
 await page.close();await stop()
 const seeded=await new Promise((ok,no)=>{let text='',err='';const p=spawn(process.execPath,['--import',join(plugin,'test/harness-resolve.mjs'),join(plugin,'test/redo-http-seed.mjs'),home,bot.id],{cwd:plugin,env});p.stdout.on('data',c=>text+=c);p.stderr.on('data',c=>err+=c);p.on('exit',code=>code===0?ok(JSON.parse(text)):no(Error(`seed failed ${code}: ${err.slice(-2000)}`)))})
 await open(await start())
 const scope={kind:'personal',id:bot.id}, legacy=await api('board-redo-preview',{scope,recoveryId:seeded.legacyRecovery})
 assert.equal(legacy.kind,'unverified-legacy-candidate');assert.equal(legacy.producerVerified,false);assert.equal(legacy.executeAllowed,false)
 assert.equal(legacy.snapshotOnly,true);assert.deepEqual(legacy.textSegments,['Synthetic task to review'])
 const legacyConfirm=await raw('board-redo-confirm',{scope,recoveryId:seeded.legacyRecovery,confirmationDigest:'b'.repeat(64),acknowledged:true});assert.equal(legacyConfirm.ok,false)
 assert.equal(JSON.parse(readFileSync(join(home,'bot/state.json'),'utf8')).originalRedoWitness,undefined)
 console.log(JSON.stringify({coldSnapshot:true,legacyCandidate:true,legacyConfirmRejected:true,execution:'not invoked'}))
} catch (error) {
 if(page)await page.screenshot({path:join(base,'redo-ui-failure.png')}).catch(()=>{})
 throw error
} finally {await page?.close().catch(()=>{});await browser?.close().catch(()=>{});await stop()}
