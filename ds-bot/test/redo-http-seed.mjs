import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import * as Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
const [home,sessionId]=process.argv.slice(2)
const ctx=new Context()
try {
  await ctx.plugin(SessionStore)
  await ctx.plugin(Jsonl,{root:join(home,'sessions')})
  const writer=await ctx.sessionPersistence.open(sessionId,'write')
  try {
    const { events }=await writer.read(), n=events.length, now=Date.now()
    const turn=Math.max(0,...events.filter(e=>e.type==='turn/start').map(e=>Number(e.data?.turn)||0))+1
    const message=createUserMessage({content:[{type:'text',text:'Synthetic task to review'}],source:{kind:'bot',role:'request',exchangeId:'synthetic-exchange',senderSessionId:'synthetic-sender'}})
    await writer.append([
      {seq:n,time:now,type:'agent/inbox/spliced',data:{target:'next-turn',start:0,inserted:[message]}},
      {seq:n+1,time:now+1,type:'turn/start',data:{turn}},
      {seq:n+2,time:now+2,type:'agent/inbox/spliced',data:{target:'next-turn',start:0,removedCount:1,inserted:[]}},
      {seq:n+3,time:now+3,type:'user/message',data:message,surfaceOp:'append'},
      {seq:n+4,time:now+4,type:'turn/end',data:{turn,reason:{kind:'interrupted'}}},
    ])
    await writer.flush()
    const record={botId:sessionId,turn,trigger:{role:'request',exchangeId:'synthetic-exchange',senderSessionId:'synthetic-sender'}}
    const recoveryId=createHash('sha256').update(JSON.stringify([sessionId,record])).digest('hex')
    const legacy={botId:sessionId,since:now+1,trigger:record.trigger}
    const legacyRecovery=createHash('sha256').update(JSON.stringify([sessionId,legacy])).digest('hex')
    await writeFile(join(home,'bot/inflight.json'),JSON.stringify({turns:{},queued:{},heldTurns:{
      [recoveryId]:{sessionId,record,reason:'interrupted outcome unknown'},
      [legacyRecovery]:{sessionId,record:legacy,reason:'interrupted outcome unknown'},
    }}),{mode:0o600})
    console.log(JSON.stringify({recoveryId,legacyRecovery}))
  } finally { await writer.close() }
} finally { await ctx.fiber.dispose() }
