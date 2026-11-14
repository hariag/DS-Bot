import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTaskHostAuthority } from '../../src/host/task-host-authority.mjs'

test('binds current workspace and roster, and rechecks reported evidence before review',t=>{
  const temp=mkdtempSync(join(tmpdir(),'dsbot-host-authority-')),root=join(temp,'workspace')
  mkdirSync(root);mkdirSync(join(root,'src'));writeFileSync(join(root,'src','result'),'good')
  t.after(()=>rmSync(temp,{recursive:true,force:true}))
  const ws={id:'ws',path:root,sessionIds:['owner-session','review-session']}
  const bots={owner:{},reviewer:{}},room={id:'r',members:['owner','reviewer'],sessions:{owner:'owner-session',reviewer:'review-session'}}
  const rt={ctx:{workspaceRegistry:{get:id=>id==='ws'?ws:undefined}},botOf:id=>bots[id],roomOf:id=>id==='r'?room:undefined,
    groupOwners:new Map([['owner-session',{botId:'owner',roomId:'r'}],['review-session',{botId:'reviewer',roomId:'r'}]]),goalDispatchBlocked:()=>false}
  let owns=true
  const host=createTaskHostAuthority({rt,assertLease(){if(!owns)throw Error('lost lock')}})
  const execution={workspace:'ws',mode:'write',paths:['src']},task={scope:'room:r',owner:'owner',reviewer:'reviewer',execution}
  task.authority={kind:'user-created',binding:host.capture(task,execution,'user')}
  const hash=createHash('sha256').update('good').digest('hex'),ref=`sha256:${hash}:src/result`
  assert.equal(host.verify(task),true)
  assert.deepEqual(host.target({actor:'owner'},task),{botId:'owner',sessionId:'owner-session'})
  assert.equal(host.verifyEvidence(task,{kind:'personal',evidence:ref},'owner','report'),true)
  task.evidence={kind:'personal',evidence:ref}
  assert.equal(host.verifyEvidence(task,{result:'pass',evidence:ref},'reviewer','review'),true)
  assert.equal(host.verifyEvidence(task,{result:'pass',evidence:ref},'owner','review'),false)
  writeFileSync(join(root,'src','result'),'changed')
  assert.equal(host.verifyEvidence(task,{result:'pass',evidence:ref},'reviewer','review'),false)
  room.members=['owner'];assert.equal(host.verify(task),false);room.members=['owner','reviewer']
  owns=false;assert.equal(host.verify(task),false);owns=true
  renameSync(root,`${root}-old`);mkdirSync(root)
  assert.equal(host.verify(task),false)
})
