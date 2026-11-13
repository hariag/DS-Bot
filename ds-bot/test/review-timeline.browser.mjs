import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import assert from 'node:assert/strict'

const harness = process.env.DSH_HARNESS
if (!harness) throw new Error('Set DSH_HARNESS to a DeepSeek Harness checkout')
const req = createRequire(join(harness, 'apps/web/package.json'))
const { chromium } = req('playwright')
const react = join(dirname(req.resolve('react')), 'umd/react.development.js')
const reactDom = join(dirname(req.resolve('react-dom')), 'umd/react-dom.development.js')
const base = resolve(import.meta.dirname, '..')
const shim = {
  name: 'browser-fixture-shim',
  setup(b) {
    b.onResolve({ filter: /^(react|react-dom|@deepseek-ai\/dsh-client-ui-primitives)$/ }, x => ({ path: x.path, namespace: 'fixture' }))
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, x => {
      if (x.path === 'react') return { contents: 'export const {createElement,Fragment,useEffect,useLayoutEffect,useMemo,useRef,useState,useSyncExternalStore,useId,useCallback,createContext,useContext}=globalThis.React' }
      if (x.path === 'react-dom') return { contents: 'export const createPortal=globalThis.ReactDOM.createPortal' }
      return { contents: 'export const MarkdownText=({text})=>globalThis.React.createElement("span",null,text); export const FishLogo=()=>null; export const writeClipboard=()=>Promise.resolve()' }
    })
  },
}
const entry = `
import { TriggerCell, TurnTailCell, ToolCell } from './src/client/cells.js';
import { FailureCell } from './src/client/turn-error.js';
const h=React.createElement;
const room='room';
const roster={roomsById:{room:{id:'room'}},byId:{a:{id:'a',name:'Alice'}},bots:[{id:'a',name:'Alice'}],exchangeTurns:{},prefs:{},models:[]};
const useRoster=f=>f(roster), useUi=f=>f({visits:{}}), useSessions=f=>f({projectionsBySession:{room:{values:{turnOutline:[{turn:1},{turn:2},{turn:3},{turn:4}]}}}}), useWork=f=>f({bots:{}});
const minute=60000;
function App({mode}){
 const unknown=mode==='paged-unknown'||mode==='paged-unknown-unread'||mode==='unknown-first-reply';
 const paged=mode==='paged'||mode==='paged-unread'||unknown;
 const store=React.useMemo(()=>{let value={room:{...(unknown?{}:{1:{first:1000,end:2000}}),2:{first:31*minute,end:32*minute},3:{first:62*minute,end:63*minute},...(unknown?{4:{first:64*minute,end:65*minute}}:['later','paged','paged-unread'].includes(mode)?{4:{first:94*minute,end:95*minute}}:{})}};const listeners=new Set();return {getSnapshot:()=>value,subscribe:fn=>(listeners.add(fn),()=>listeners.delete(fn)),set:fn=>{const next=fn(value);if(next===value)return;value=next;for(const listener of [...listeners])listener()}}},[]);
 const clock=React.useSyncExternalStore(store.subscribe,store.getSnapshot),setClock=store.set;
 const actions=React.useMemo(()=>({noteTurnReview:(s,t)=>setClock(v=>v[s]?.[t]?.internalReview?v:{...v,[s]:{...v[s],[t]:{...v[s]?.[t],internalReview:true}}}),noteTurnVisible:(s,t)=>setClock(v=>v[s]?.[t]?.visible?v:{...v,[s]:{...v[s],[t]:{...v[s]?.[t],visible:true}}}),noteTurnTail:(s,t,d)=>setClock(v=>({...v,[s]:{...v[s],[t]:{...v[s]?.[t],tails:Math.max(0,(v[s]?.[t]?.tails??0)+d)}}})),noteTurnTime(){},noteLive(){},noteTurnPeer(){},noteCards(){},async groupRows(){await new Promise(r=>setTimeout(r,30));return {rows:[{botId:'a',kind:'folder',text:'async visible review result'}],open:false}}}),[]);
 const [showPrevious,setShowPrevious]=React.useState(!paged); globalThis.showPrevious=()=>setShowPrevious(true);
 const useTurnClock=f=>React.useSyncExternalStore(store.subscribe,()=>f(store.getSnapshot()));
 const caseUi=mode==='paged-unread'?f=>f({visits:{room:{seen:50*minute,entered:100*minute}}}):['paged-unknown-unread','unknown-first-reply'].includes(mode)?f=>f({visits:{room:{seen:10*minute,entered:100*minute}}}):useUi;
 const caseSessions=mode==='unknown-first-reply'?f=>f({projectionsBySession:{room:{values:{turnOutline:[{turn:2},{turn:3},{turn:4}]}}}}):useSessions;
 const trigger=t=>h(TriggerCell,{key:'g'+t,node:{data:{source:{kind:'bot',role:'goal',reviewId:'r'+t},content:[]},location:{turn:{turn:t}}},sessionId:room,useRoster,useSessions:caseSessions,useTurnClock,useUi:caseUi,actions});
 const tail=t=>h(TurnTailCell,{key:'t'+t,turn:{turn:t,end:{time:clock.room[t].end}},sessionId:room,useTurnClock,useUi:caseUi,actions});
 const call={kind:'tool-result',name:'group_relay',callId:'c',content:[{type:'text',text:JSON.stringify(mode==='async-reply'?{from:3488,anchor:'test'}:{replies:[{botId:'a',kind:'folder',text:'visible review result'}]})}]};
 const tool=['reply','async-reply','unknown-first-reply'].includes(mode)?h(ToolCell,{key:'tool',node:{data:{root:call},location:{turn:{turn:mode==='unknown-first-reply'?4:3}}},sessionId:room,useRoster,useUi:caseUi,useWork,actions}):null;
 const failure=mode==='failure'?h(FailureCell,{key:'failure',node:{data:{turn:3,code:'TEST_ERROR',message:'failed'}},sessionId:room,useRoster,useTurnClock,actions}):null;
 return h('main',null,trigger(2),trigger(3),mode==='unknown-first-reply'?trigger(4):null,showPrevious?tail(1):null,tail(2),tail(3),['later','paged','paged-unread','paged-unknown','paged-unknown-unread','unknown-first-reply'].includes(mode)?tail(4):null,tool,failure,paged&&mode!=='unknown-first-reply'?h('div',null,'visible user message'):null);
}
function FirstApp(){
 const [clock,setClock]=React.useState({room:{3:{first:62*minute,end:63*minute}}});
 const actions=React.useMemo(()=>({noteTurnReview:(s,t)=>setClock(v=>v[s]?.[t]?.internalReview?v:{...v,[s]:{...v[s],[t]:{...v[s]?.[t],internalReview:true}}}),noteTurnVisible:(s,t)=>setClock(v=>v[s]?.[t]?.visible?v:{...v,[s]:{...v[s],[t]:{...v[s]?.[t],visible:true}}}),noteTurnTime(){},noteLive(){},noteTurnPeer(){},noteCards(){}}),[]);
 const useTurnClock=f=>f(clock), firstSessions=f=>f({projectionsBySession:{room:{values:{turnOutline:[{turn:3}]}}}}), firstUi=f=>f({visits:{room:{seen:1,entered:99999999}}});
 const trigger=h(TriggerCell,{node:{data:{source:{kind:'bot',role:'goal',reviewId:'r3'},content:[]},location:{turn:{turn:3}}},sessionId:room,useRoster,useSessions:firstSessions,useTurnClock,useUi:firstUi,actions});
 const call={kind:'tool-result',name:'group_relay',callId:'c',content:[{type:'text',text:JSON.stringify({replies:[{botId:'a',kind:'folder',text:'first visible result'}]})}]};
 const tool=h(ToolCell,{node:{data:{root:call},location:{turn:{turn:3}}},sessionId:room,useRoster,useUi:firstUi,useWork,actions});
 return h('main',null,trigger,tool);
}
let root;
globalThis.renderFixture=(mode)=>{if(root)root.unmount();root=ReactDOM.createRoot(document.getElementById('root'));root.render(mode==='first-reply'?h(FirstApp):h(App,{mode}));};
`
const bundle = await build({ stdin: { contents: entry, resolveDir: base, sourcefile: 'review-fixture.js' }, bundle: true, platform: 'browser', format: 'iife', write: false, plugins: [shim] })
const browser = await chromium.launch({ ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}), headless: true, args: ['--no-sandbox', '--disable-background-networking'] })
try {
  const page = await browser.newPage({ locale: 'zh-CN' })
  const errors = []
  const consoleErrors = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()) })
  await page.setContent('<!doctype html><meta charset="utf-8"><div id="root"></div>')
  await page.addScriptTag({ path: react })
  await page.addScriptTag({ path: reactDom })
  await page.addScriptTag({ content: bundle.outputFiles[0].text })
  for (const [mode, clocks] of [['silent',0], ['reply',1], ['async-reply',1], ['failure',1], ['later',1]]) {
    await page.evaluate(m => globalThis.renderFixture(m), mode)
    await page.waitForTimeout(150)
    assert.equal(await page.locator('.bt-time-sep').count(), clocks, mode)
    assert.equal(await page.locator('.bt-new-sep').count(), 0, mode)
    if (mode === 'reply') assert.match(await page.locator('main').innerText(), /visible review result/)
    if (mode === 'async-reply') assert.match(await page.locator('main').innerText(), /async visible review result/)
    if (mode === 'failure') assert.equal(await page.locator('.bt-fail').count(), 1)
  }
  await page.evaluate(() => globalThis.renderFixture('first-reply'))
  await page.waitForTimeout(150)
  assert.match(await page.locator('main').innerText(), /first visible result/)
  assert.equal(await page.locator('.bt-new-sep').count(), 1, 'a visible first review keeps its unread marker')
  for (const mode of ['paged','paged-unread']) {
    await page.evaluate(m => globalThis.renderFixture(m), mode)
    await page.waitForTimeout(150)
    assert.match(await page.locator('main').innerText(), /visible user message/)
    assert.equal(await page.locator('.bt-time-sep').count(), 1, mode+' preserves the timestamp after a virtualized prior turn')
    assert.equal(await page.locator('.bt-new-sep').count(), mode==='paged-unread'?1:0, mode+' preserves unread boundary')
    await page.evaluate(() => globalThis.showPrevious())
    await page.waitForTimeout(150)
    assert.equal(await page.locator('.bt-time-sep').count(), 1, mode+' has no duplicate after older turn loads')
    assert.equal(await page.locator('.bt-new-sep').count(), mode==='paged-unread'?1:0, mode+' has no duplicate unread after older turn loads')
  }
  for (const mode of ['paged-unknown','paged-unknown-unread']) {
    await page.evaluate(m => globalThis.renderFixture(m), mode)
    await page.waitForTimeout(150)
    assert.match(await page.locator('main').innerText(), /visible user message/)
    assert.equal(await page.locator('.bt-time-sep').count(), 1, mode+' conservatively preserves timestamp without earlier clock')
    assert.equal(await page.locator('.bt-new-sep').count(), mode==='paged-unknown-unread'?1:0, mode+' preserves unread without earlier clock')
  }
  await page.evaluate(() => globalThis.renderFixture('unknown-first-reply'))
  await page.waitForTimeout(150)
  assert.match(await page.locator('main').innerText(), /visible review result/)
  assert.equal(await page.locator('.bt-time-sep').count(), 1, 'first visible review does not duplicate timestamp')
  assert.equal(await page.locator('.bt-new-sep').count(), 1, 'first visible review does not duplicate unread')
  assert.deepEqual(errors, [])
  assert.deepEqual(consoleErrors, [], 'React external-store snapshots must be stable')
  console.log('PASS: real React and Chrome silence, visible reply, failure, and later turn')
} finally { await browser.close() }
