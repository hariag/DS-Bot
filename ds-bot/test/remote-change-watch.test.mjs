import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { classifyFiles, createRemoteChangePoller, install, openRemoteChangeStore } from '../src/host/remote-change-watch.mjs'

const a='a'.repeat(40),b='b'.repeat(40),c='c'.repeat(40)
const spec={repository:'example/project',branch:'main',ownerBotId:'pm',initialCursor:a}
const commit=sha=>({sha,commit:{message:`message ${sha[0]}`,author:{name:'A'},committer:{date:'2026-01-01T00:00:00Z'}}})
const response=(body,{status=200,link=''}={})=>({ok:status>=200&&status<300,status,headers:{get:name=>name==='link'?link:null},json:async()=>body})
function fixture({filesB=[{filename:'team/patrol/cursor.json'}],filesC=[{filename:'Ground/web/index.js'}]}={}) {
  let authorized=true,head=c
  const calls=[]
  const authorize=async()=>{if(!authorized)throw new Error('authorization unavailable');return 'test-token'}
  const assertOwner=()=>{if(!authorized)throw new Error('authorization unavailable')}
  const request=async(url,options)=>{
    calls.push({url,options})
    if (url.includes('/commits?')) return response([{sha:head}])
    if (url.includes('/compare/')) return response({status:'ahead',merge_base_commit:{sha:a},total_commits:2,commits:[commit(b),commit(c)]})
    if (url.includes(`/commits/${b}?`)) return response({sha:b,files:filesB})
    if (url.includes(`/commits/${c}?`)) return response({sha:c,files:filesC})
    throw Error('unexpected request')
  }
  return {authorize,assertOwner,request,calls,setHead:value=>{head=value},revoke:()=>{authorized=false}}
}

test('filter only patrol-only files, including rename origins',()=>{
  assert.equal(classifyFiles([{filename:'team/patrol/a'}]),'patrol-only')
  assert.equal(classifyFiles([{filename:'team/patrol/a'},{filename:'Ground/web/x'}]),'relevant')
  assert.equal(classifyFiles([{filename:'team/patrol/a',status:'renamed',previous_filename:'Ground/web/x'}]),'relevant')
  assert.equal(classifyFiles([{filename:'Ground/web/x',status:'renamed',previous_filename:'team/patrol/a'}]),'relevant')
  assert.equal(classifyFiles([{filename:'team/patrol/a',status:'renamed'}]),'unknown')
  assert.equal(classifyFiles([]),'unknown')
})

test('bootstrap reports earlier history as unknown without inventing events',async()=>{
  const f=fixture(),s=openRemoteChangeStore(':memory:',{...spec,initialCursor:undefined},f.assertOwner)
  try { const result=await createRemoteChangePoller({spec,store:s,authorize:f.authorize,request:f.request})();assert.equal(result.earlierUnknown,true);assert.equal(s.state().cursor,c);assert.equal(s.rows().length,0) } finally { s.close() }
})

test('commit relevant events and cursor atomically; restart and repeat do not duplicate',async()=>{
  const f=fixture(),dir=mkdtempSync(join(tmpdir(),'remote-watch-')),path=join(dir,'watch.sqlite')
  let s=openRemoteChangeStore(path,spec,f.assertOwner)
  try {
    let out=await createRemoteChangePoller({spec,store:s,authorize:f.authorize,request:f.request})();assert.equal(out.recorded,1);assert.equal(s.state().cursor,c);assert.equal(s.rows()[0].sha,c)
    s.close();s=openRemoteChangeStore(path,spec,f.assertOwner)
    out=await createRemoteChangePoller({spec,store:s,authorize:f.authorize,request:f.request})();assert.equal(out.status,'ok');assert.equal(s.rows().length,1)
    assert.ok(f.calls.every(x=>x.url.startsWith('https://api.github.com/repos/example/project/')))
  } finally { s.close();rmSync(dir,{recursive:true,force:true}) }
})

test('diverged or incomplete history preserves original cursor and events',async()=>{
  for(const body of [
    {status:'diverged',merge_base_commit:{sha:a},total_commits:1,commits:[commit(c)]},
    {status:'ahead',merge_base_commit:{sha:a},total_commits:1001,commits:[commit(c)]},
    {status:'ahead',merge_base_commit:{sha:a},total_commits:2,commits:[commit(c)]},
  ]) {
    const f=fixture(),s=openRemoteChangeStore(':memory:',spec,f.assertOwner)
    const request=async(url,opts)=>url.includes('/compare/')?response(body):f.request(url,opts)
    try { await assert.rejects(createRemoteChangePoller({spec,store:s,authorize:f.authorize,request})(),/history requires reconciliation|remote response incomplete/);assert.equal(s.state().cursor,a);assert.equal(s.rows().length,0) } finally { s.close() }
  }
})

test('incomplete file pagination and changed authority do not advance cursor',async()=>{
  for(const mode of ['pagination','revoke']) {
    const f=fixture(),s=openRemoteChangeStore(':memory:',spec,f.assertOwner)
    const request=async(url,opts)=>{
      if(url.includes(`/commits/${c}?`)) {
        if(mode==='revoke')f.revoke()
        return response({sha:c,files:[{filename:'Ground/web/x'}]},mode==='pagination'?{link:'<https://api.github.com/next>; rel="next"'}:{})
      }
      return f.request(url,opts)
    }
    try {await assert.rejects(createRemoteChangePoller({spec,store:s,authorize:f.authorize,request})());assert.equal(s.state().cursor,a);assert.equal(s.rows().length,0)} finally {s.close()}
  }
})

test('rate limiting and the API file cap remain visible without moving the cursor',async()=>{
  for (const mode of ['rate-limit','file-cap']) {
    const f=fixture(),s=openRemoteChangeStore(':memory:',spec,f.assertOwner)
    const request=async(url,opts)=>{
      if(url.includes(`/commits/${c}?`)) {
        if(mode==='rate-limit') return {ok:false,status:403,headers:{get:name=>name==='x-ratelimit-remaining'?'0':null}}
        return response({sha:c,files:Array.from({length:3000},(_,i)=>({filename:`team/patrol/${i}`}))})
      }
      return f.request(url,opts)
    }
    try {
      await assert.rejects(createRemoteChangePoller({spec,store:s,authorize:f.authorize,request})(),mode==='rate-limit'?/rate limited/:/history requires reconciliation/)
      assert.equal(s.state().cursor,a);assert.equal(s.rows().length,0)
    } finally {s.close()}
  }
})

test('loss of the Host lock before commit leaves cursor and staged work unchanged',async()=>{
  const f=fixture();let locked=true
  const s=openRemoteChangeStore(':memory:',spec,()=>{if(!locked)throw Error('lock lost')})
  const request=async(url,opts)=>{const out=await f.request(url,opts);if(url.includes(`/commits/${c}?`))locked=false;return out}
  try{await assert.rejects(createRemoteChangePoller({spec,store:s,authorize:f.authorize,request})(),/lock lost/);assert.equal(s.state().cursor,a);assert.equal(s.pending().next_index,0);assert.equal(s.rows().length,0)}finally{s.close()}
})

test('force-push during a scan cannot advance the saved cursor',async()=>{
  const f=fixture(),s=openRemoteChangeStore(':memory:',spec,f.assertOwner),rewritten='d'.repeat(40)
  const request=async(url,opts)=>{
    if(url.includes(`/compare/${c}...${rewritten}`))return response({status:'diverged',merge_base_commit:{sha:a},behind_by:1})
    const out=await f.request(url,opts);if(url.includes(`/commits/${c}?`))f.setHead(rewritten);return out
  }
  try{await assert.rejects(createRemoteChangePoller({spec,store:s,authorize:f.authorize,request})(),/history requires reconciliation/);assert.equal(s.state().cursor,a);assert.equal(s.pending().next_index,0);assert.equal(s.rows().length,0)}finally{s.close()}
})

test('unknown empty diff is recorded instead of mistaken for patrol-only',async()=>{
  const f=fixture({filesB:[],filesC:[{filename:'team/patrol/cursor'}]}),s=openRemoteChangeStore(':memory:',spec,f.assertOwner)
  try{await createRemoteChangePoller({spec,store:s,authorize:f.authorize,request:f.request})();assert.equal(s.state().cursor,c);assert.equal(s.rows().length,1);assert.equal(s.rows()[0].kind,'unknown')}finally{s.close()}
})

test('concurrent polls cannot commit an obsolete cursor or duplicate events',async()=>{
  const f=fixture(),s=openRemoteChangeStore(':memory:',spec,f.assertOwner)
  try {const poll=createRemoteChangePoller({spec,store:s,authorize:f.authorize,request:f.request});const out=await Promise.allSettled([poll(),poll()]);assert.equal(out.filter(x=>x.status==='fulfilled').length,1);assert.equal(s.state().cursor,c);assert.equal(s.rows().length,1)} finally {s.close()}
})

test('large comparison resumes bounded batches after restart and transient failure',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'remote-watch-batch-')),path=join(dir,'watch.sqlite')
  const ids=Array.from({length:25},(_,i)=>(i+10).toString(16).padStart(40,'0'))
  const last=ids.at(-1),localSpec={...spec,initialCursor:a}
  let s=openRemoteChangeStore(path,localSpec,()=>{}),failOnce=true,compares=0
  const request=async(url)=>{
    if(url.includes('/commits?'))return response([{sha:last}])
    if(url.includes('/compare/')){compares++;return response({status:'ahead',merge_base_commit:{sha:a},total_commits:ids.length,commits:ids.map(commit)})}
    const sha=/\/commits\/([a-f0-9]{40})\?/.exec(url)?.[1]
    if(!sha)throw Error('unexpected request')
    if(sha===ids[20]&&failOnce){failOnce=false;throw Error('temporary')}
    return response({sha,files:[{filename:'Ground/web/x'}]})
  }
  const authorize=async()=> 'test-token'
  try{
    let poll=createRemoteChangePoller({spec:localSpec,store:s,authorize,request})
    assert.equal((await poll()).status,'catching up');assert.equal(s.state().cursor,a);assert.equal(s.pending().next_index,20);assert.equal(s.rows().length,20)
    s.close();s=openRemoteChangeStore(path,localSpec,()=>{});poll=createRemoteChangePoller({spec:localSpec,store:s,authorize,request})
    await assert.rejects(poll(),/temporary/);assert.equal(s.pending().next_index,20);assert.equal(s.rows().length,20)
    assert.equal((await poll()).status,'ok');assert.equal(s.state().cursor,last);assert.equal(s.pending(),undefined);assert.equal(s.rows().length,25);assert.equal(compares,1)
    await poll();assert.equal(s.rows().length,25)
  }finally{s.close();rmSync(dir,{recursive:true,force:true})}
})

test('comparison pagination is complete before any cursor advancement',async()=>{
  const ids=Array.from({length:101},(_,i)=>(i+100).toString(16).padStart(40,'0')),last=ids.at(-1)
  let secondPage=false
  const request=async(url)=>{
    if(url.includes('/commits?'))return response([{sha:last}])
    if(url.includes('/compare/')){
      if(url.includes('page=2')){secondPage=true;return response({status:'ahead',merge_base_commit:{sha:a},total_commits:101,commits:[commit(last)]})}
      return response({status:'ahead',merge_base_commit:{sha:a},total_commits:101,commits:ids.slice(0,100).map(commit)},{link:'<https://api.github.com/next>; rel="next"'})
    }
    const sha=/\/commits\/([a-f0-9]{40})\?/.exec(url)?.[1];if(!sha)throw Error('unexpected request')
    return response({sha,files:[{filename:'team/patrol/cursor'}]})
  }
  const s=openRemoteChangeStore(':memory:',spec,()=>{}),poll=createRemoteChangePoller({spec,store:s,authorize:async()=> 'test-token',request})
  try{assert.equal((await poll()).status,'catching up');assert.equal(secondPage,true);assert.equal(s.state().cursor,a);for(let i=0;i<5;i++)await poll();assert.equal(s.state().cursor,last);assert.equal(s.rows().length,0)}finally{s.close()}
})

test('PM secret authorization and Host lock are required to expose status',async()=>{
  const home=mkdtempSync(join(tmpdir(),'remote-watch-host-'));let allowed=false,locked=true,dispose
  const rt={home,config:{remoteChangeWatch:spec},state:{bots:{pm:{id:'pm'}}},ctx:{effect:fn=>{dispose=fn()}},load:async()=>{},loadSecrets:async()=>{},canUseSecret:()=>allowed,secretValue:()=> 'test-token',requireHomeLock:()=>{if(!locked)throw Error('lock lost')},stopping:false}
  try{
    install(rt);assert.equal(rt.remoteChangeView().status,'authorization unavailable')
    allowed=true;assert.equal(rt.remoteChangeView().status,'waiting')
    locked=false;assert.equal(rt.remoteChangeView().status,'unavailable')
    locked=true;allowed=false;assert.equal(rt.remoteChangeView().status,'authorization unavailable')
  }finally{await dispose();rmSync(home,{recursive:true,force:true})}
})

test('invalid explicit monitor configuration is visible and does not schedule',()=>{
  const rt={config:{remoteChangeWatch:{repository:'../x',branch:'main',ownerBotId:'pm'}},ctx:{effect:()=>{throw Error('must not schedule')}}}
  install(rt);assert.equal(rt.remoteChangeView().status,'invalid configuration')
})
