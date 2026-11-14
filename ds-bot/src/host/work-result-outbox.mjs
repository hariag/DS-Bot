// Experimental work-result journal. Nothing installs this module until the
// guarded Agent, original-result router and shared claim coordinator are bound.
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { dirname } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { textOf } from './text.js'

const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex')
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 300
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const plain = value => value && typeof value === 'object' && !Array.isArray(value)
const validSeq = value => Number.isSafeInteger(value) && value >= 0
const clone = value => structuredClone(value)
const MAX_EVENTS = 100_000
const MAX_RESULT_BYTES = 20_000

export function workResultIdentity(binding) {
  if (!plain(binding) || !hex(binding.recoveryId) || !id(binding.workId) || !id(binding.sourceSessionId)
    || !id(binding.requesterSessionId) || !id(binding.originalInputId) || !validSeq(binding.originalSeq)
    || !validSeq(binding.originalTurn)) throw Error('invalid work result binding')
  const expected = ['recoveryId','workId','sourceSessionId','requesterSessionId','originalInputId','originalSeq','originalTurn']
  if (Object.keys(binding).some(key => !expected.includes(key))) throw Error('invalid work result binding')
  const token = hash(['ds-bot:work-result:v1',binding.recoveryId,binding.workId,binding.requesterSessionId])
  return {outboxId:`result:${token}`,replyExchangeId:`reply:${token}`,messageId:`result-${token}`}
}

const redoIds = recoveryId => {
  const token=hash(`ds-bot:redo:v1:${recoveryId}`)
  return {messageId:`redo-${token}`,admissionId:`redo:${token}`}
}

// This requires the target writer barrier and a complete, unchanged live
// Session. Missing or inaccessible history never establishes absence.
async function fixedPrefix(rt, sessionId) {
  const ctx=rt.ctx, persistence=ctx?.get?.('sessionPersistence') ?? ctx?.sessionPersistence
  const session=ctx?.sessions?.get?.(sessionId), seq=Number(session?.seq)
  if (!session || session.id!==sessionId || !validSeq(seq) || seq>MAX_EVENTS || typeof session.eventAt!=='function'
    || typeof persistence?.flushLiveSession!=='function' || typeof persistence?.open!=='function') throw Error('durable Session prefix unavailable')
  await persistence.flushLiveSession(sessionId)
  if (ctx.sessions.get(sessionId)!==session || Number(session.seq)!==seq) throw Error('Session changed during barrier')
  const reader=await persistence.open(sessionId,'read')
  try {
    const result=await reader.read(0,seq)
    if (ctx.sessions.get(sessionId)!==session || Number(session.seq)!==seq || !Array.isArray(result?.events)
      || result.events.length!==seq || result.events.some((event,index)=>event?.seq!==index
        || !isDeepStrictEqual(event,session.eventAt(index)))) throw Error('durable Session prefix changed')
    return {session,seq,events:result.events,isCurrent:()=>ctx.sessions.get(sessionId)===session && Number(session.seq)===seq}
  } finally { await reader.close() }
}

// This helper protects a single work-result state snapshot. It intentionally
// does not register a coordinator or install a result handler in the Host.
export function createWorkResultJournal(rt) {
  if (!rt || !plain(rt.state) || typeof rt.statePath!=='string' || typeof rt.save!=='function'
    || typeof rt.requireHomeLock!=='function' || typeof rt.homeLockVersion!=='function') throw Error('work result journal unavailable')
  const busy=new Set(), confirmed=new Map()
  const table=()=> {
    const value=rt.state.workResultOutbox
    if (value===undefined) return undefined
    if (!plain(value)) throw Error('work result journal unavailable')
    return value
  }
  const stateOf = (entry, state=rt.state) => ({entry:state.workResultOutbox?.[entry.outboxId] ?? null,
    work:state.works?.[entry.binding.workId] ?? null,parent:entry.parentId ? state.works?.[entry.parentId] ?? null : null})
  const lease=()=>{rt.requireHomeLock();return rt.homeLockVersion()}
  const withWork=async (key,fn)=>{
    if (busy.has(key)) throw Error('work result outcome is unknown')
    busy.add(key)
    try{return await fn()}finally{busy.delete(key)}
  }
  async function durable(entry, expected) {
    const generation=lease(), file=await open(rt.statePath,constants.O_RDONLY|(constants.O_NOFOLLOW??0))
    try {
      const before=await file.stat()
      if(!before.isFile())throw Error('work result snapshot unavailable')
      const state=JSON.parse(await file.readFile('utf8'))
      if(!isDeepStrictEqual(stateOf(entry,state),expected))throw Error('work result snapshot changed')
      await file.sync()
      const dir=await open(dirname(rt.statePath),constants.O_RDONLY)
      try{await dir.sync()}finally{await dir.close()}
      const afterFile=await file.stat(), after=await lstat(rt.statePath)
      if(!after.isFile()||after.isSymbolicLink()||before.dev!==after.dev||before.ino!==after.ino
        ||before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.size!==afterFile.size
        ||before.mtimeMs!==afterFile.mtimeMs||lease()!==generation||!isDeepStrictEqual(stateOf(entry),expected)) throw Error('work result durability is unknown')
      confirmed.set(entry.outboxId,{generation,record:JSON.stringify(entry)})
    } finally {await file.close()}
  }
  const get = binding => {
    const identity=workResultIdentity(binding), record=table()?.[identity.outboxId]
    if(record && (!isDeepStrictEqual(record.binding,binding)||record.replyExchangeId!==identity.replyExchangeId||record.messageId!==identity.messageId)) throw Error('work result identity conflict')
    return {identity,record}
  }
  const currentWork = binding => {
    const work=rt.state.works?.[binding.workId]
    if(!plain(work)||!id(work.from)||!id(work.to)||work.fromSession!==binding.requesterSessionId
      ||rt.selfOf?.(binding.sourceSessionId)!==work.to||rt.selfOf?.(binding.requesterSessionId)!==work.from
      ||rt.chatOf?.(work.from)!==binding.requesterSessionId||work.fromRoom!==undefined) throw Error('original work route unavailable')
    return work
  }
  const original = (binding,prefix,work) => {
    const input=prefix.events[binding.originalSeq]
    const start=prefix.events.slice(0,binding.originalSeq).findLast(event=>event.type==='turn/start')
    const end=prefix.events.find(event=>event.seq>binding.originalSeq && event.type==='turn/end' && event.data?.turn===binding.originalTurn)
    if(input?.type!=='user/message'||input.data?.id!==binding.originalInputId||input.data?.source?.kind!=='bot'
      ||input.data.source.role!=='request'||input.data.source.exchangeId!==binding.workId
      ||input.data.source.senderSessionId!==work.from||input.data.source.roomId!==undefined||input.data.source.senderRoomId!==undefined
      ||start?.data?.turn!==binding.originalTurn||end?.data?.reason?.kind==='completed') throw Error('original work input unavailable')
    return input.data
  }
  const replyAbsent = (prefix,workId) => !prefix.events.some(event => {
    if(event.type==='user/message' && event.data?.source?.replyTo===workId)return true
    return event.type==='agent/inbox/spliced' && Array.isArray(event.data?.inserted)
      && event.data.inserted.some(message=>message?.source?.replyTo===workId)
  })
  async function reserve(binding) {
    const {identity}=get(binding)
    return withWork(binding.workId,async()=>{
      const existing=get(binding).record
      if(existing){
        if(existing.state!=='reserved'||!isDeepStrictEqual(currentWork(binding),existing.work))throw Error('work result outcome is unknown')
        const generation=lease(),source=await fixedPrefix(rt,binding.sourceSessionId),target=await fixedPrefix(rt,binding.requesterSessionId)
        original(binding,source,existing.work)
        if(source.events.filter(event=>event.type==='user/message'&&event.data?.source?.exchangeId===binding.workId).length!==1
          ||!replyAbsent(target,binding.workId)||!source.isCurrent()||!target.isCurrent()||lease()!==generation
          ||!isDeepStrictEqual(currentWork(binding),existing.work))throw Error('original work is uncertain')
        await durable(existing,clone(stateOf(existing)))
        if(!source.isCurrent()||!target.isCurrent()||lease()!==generation){confirmed.delete(identity.outboxId);throw Error('work result reservation outcome is unknown')}
        return clone(existing)
      }
      if(Object.values(table()??{}).some(item=>item?.binding?.workId===binding.workId))throw Error('work result is already reserved')
      const generation=lease(),work=currentWork(binding),workSnapshot=clone(work)
      const source=await fixedPrefix(rt,binding.sourceSessionId), target=await fixedPrefix(rt,binding.requesterSessionId)
      original(binding,source,work)
      if(source.events.filter(event=>event.type==='user/message'&&event.data?.source?.exchangeId===binding.workId).length!==1)throw Error('original work identity is ambiguous')
      if(!replyAbsent(target,binding.workId)||!source.isCurrent()||!target.isCurrent()||lease()!==generation
        ||!isDeepStrictEqual(currentWork(binding),workSnapshot))throw Error('original work is uncertain')
      const entry={...identity,binding:clone(binding),parentId:work.parent ?? null,work:workSnapshot,state:'reserved'}
      rt.state.workResultOutbox={...(table()??{}),[identity.outboxId]:entry}
      const expected=clone(stateOf(entry))
      try{await rt.save({required:true});await durable(entry,expected)
        if(!source.isCurrent()||!target.isCurrent()||lease()!==generation)throw Error('Session changed')}catch{confirmed.delete(identity.outboxId);throw Error('work result reservation outcome is unknown')}
      return clone(entry)
    })
  }
  async function stageResult(binding, ref) {
    const {identity}=get(binding)
    return withWork(binding.workId,async()=>{
      const entry=get(binding).record
      if(!entry || entry.state!=='reserved' || !plain(ref) || !validSeq(ref.turn) || !validSeq(ref.startSeq) || !validSeq(ref.endSeq)
        ||ref.endSeq<=ref.startSeq || !hex(ref.resultDigest))throw Error('work result is unavailable')
      const generation=lease(),work=currentWork(binding)
      if(!isDeepStrictEqual(work,entry.work)||!Array.isArray(work.open)||work.open.length
        ||(Array.isArray(work.results)&&work.results.length)||work.held
        ||Object.values(rt.state.works??{}).some(item=>item?.parent===binding.workId))throw Error('original work has unresolved children')
      const prefix=await fixedPrefix(rt,binding.sourceSessionId), prior=original(binding,prefix,work), ids=redoIds(binding.recoveryId)
      const start=prefix.events[ref.startSeq],end=prefix.events[ref.endSeq]
      const turn=prefix.events.slice(ref.startSeq,ref.endSeq+1)
      const inputs=turn.filter(event=>event.type==='user/message')
      const holds=prefix.events.filter(event=>event.type==='agent/admission/hold'&&event.data?.messageId===ids.messageId&&event.data?.admissionId===ids.admissionId)
      const releases=prefix.events.filter(event=>event.type==='agent/admission/release'&&event.data?.messageId===ids.messageId&&event.data?.admissionId===ids.admissionId)
      const inserts=prefix.events.filter(event=>event.type==='agent/inbox/spliced'&&event.data?.inserted?.some(item=>item?.id===ids.messageId))
      const replay=inputs[0]?.data
      if(start?.type!=='turn/start'||start.data?.turn!==ref.turn||end?.type!=='turn/end'||end.data?.turn!==ref.turn
        ||end.data?.reason?.kind!=='completed'||inputs.length!==1||replay?.id!==ids.messageId
        ||!isDeepStrictEqual(replay?.source,prior.source)||!isDeepStrictEqual(replay?.content,prior.content)
        ||holds.length!==1||inserts.length!==1||releases.length!==1||!(holds[0].seq<inserts[0].seq&&inserts[0].seq<releases[0].seq&&releases[0].seq<inputs[0].seq)
        ||prefix.events.some(event=>event.type==='agent/admission/cancel'&&event.data?.messageId===ids.messageId&&event.data?.admissionId===ids.admissionId&&event.seq<inputs[0].seq)
        ||prefix.events.filter(event=>event.type==='user/message'&&event.data?.source?.exchangeId===binding.workId).length!==2
        ||!isDeepStrictEqual(inserts[0].data.inserted.find(item=>item.id===ids.messageId),replay))throw Error('guarded result cannot be verified')
      const answers=turn.filter(event=>event.type==='assistant/message')
      if(!answers.length||answers.some(event=>!Array.isArray(event.data?.message?.content)
        ||event.data.message.content.some(part=>part?.type!=='text'||typeof part.text!=='string')))throw Error('complete result unavailable')
      const text=answers.map(event=>textOf(event.data.message.content)).filter(Boolean).join('\n\n').trim()
      if(!text||Buffer.byteLength(text)>MAX_RESULT_BYTES||hash(text)!==ref.resultDigest)throw Error('complete result unavailable')
      if(!prefix.isCurrent()||lease()!==generation||!isDeepStrictEqual(currentWork(binding),entry.work))throw Error('original work changed')
      const parent=entry.parentId ? rt.state.works?.[entry.parentId] : undefined
      if(entry.parentId && (!plain(parent)||!Array.isArray(parent.open)||!parent.open.includes(binding.workId)||!Array.isArray(parent.results)
        ||parent.results.some(result=>result?.id===binding.workId)))throw Error('parent work unavailable')
      const name=rt.botOf?.(work.to)?.name
      if(!id(name))throw Error('worker unavailable')
      const message={id:identity.messageId,role:'user',content:[{type:'text',text:`[Reply from ${name}]\n${text}`}],source:{kind:'bot',form:'relay',role:'reply',exchangeId:identity.replyExchangeId,replyTo:binding.workId,senderSessionId:work.to,senderName:name,...(entry.parentId?{work:entry.parentId}:{})}}
      const next={...entry,state:'prepared',result:{text,digest:ref.resultDigest,ref:clone(ref)},message}
      // The work settlement and reply intent share one state snapshot. The
      // parent's open entry remains until its Session actually reads the reply.
      if(parent) parent.results=[...parent.results,{id:binding.workId,name,text,at:Date.now()}]
      delete rt.state.works[binding.workId]
      rt.state.workResultOutbox={...table(),[identity.outboxId]:next}
      const expected=clone(stateOf(next))
      try{await rt.save({required:true});await durable(next,expected)
        if(!prefix.isCurrent()||lease()!==generation)throw Error('Session changed')}catch{confirmed.delete(identity.outboxId);throw Error('work result settlement outcome is unknown')}
      return clone(next)
    })
  }
  const parentAwaiting = entry => {
    if(!entry.parentId)return true
    const parent=rt.state.works?.[entry.parentId]
    return Array.isArray(parent?.open)&&parent.open.includes(entry.binding.workId)&&Array.isArray(parent.results)
      &&parent.results.filter(result=>result?.id===entry.binding.workId&&result.text===entry.result?.text).length===1
  }
  async function beginSend(binding) {
    const {identity}=get(binding)
    return withWork(binding.workId,async()=>{
      const entry=get(binding).record
      if(!entry || entry.state!=='prepared')return {state:'unknown'}
      const generation=lease(), receipt=confirmed.get(identity.outboxId)
      if(receipt?.record!==JSON.stringify(entry)||receipt.generation!==generation)return {state:'unknown'}
      if(rt.selfOf?.(binding.requesterSessionId)!==entry.work.from||rt.chatOf?.(entry.work.from)!==binding.requesterSessionId
        ||rt.state.works?.[binding.workId]!==undefined||!parentAwaiting(entry))throw Error('requester Session changed')
      const target=await fixedPrefix(rt,binding.requesterSessionId)
      if(!replyAbsent(target,binding.workId)||!target.isCurrent()||lease()!==generation
        ||rt.selfOf?.(binding.requesterSessionId)!==entry.work.from||rt.chatOf?.(entry.work.from)!==binding.requesterSessionId
        ||rt.state.works?.[binding.workId]!==undefined||!parentAwaiting(entry)||get(binding).record!==entry)return {state:'unknown'}
      const next={...entry,state:'sending',targetFloor:target.seq}
      rt.state.workResultOutbox={...table(),[identity.outboxId]:next}
      const expected=clone(stateOf(next))
      try{await rt.save({required:true});await durable(next,expected)}catch{confirmed.delete(identity.outboxId);return {state:'unknown'}}
      if(lease()!==generation||!target.isCurrent()){confirmed.delete(identity.outboxId);return {state:'unknown'}}
      const saved=confirmed.get(identity.outboxId)
      if(!saved)return {state:'unknown'}
      saved.targetSession=target.session
      return {state:'ready',outboxId:identity.outboxId,message:clone(next.message),target:'next-turn'}
    })
  }
  const noCompetingReply = (entry,receipt) => {
    const session=rt.ctx?.sessions?.get?.(entry.binding.requesterSessionId), seq=Number(session?.seq)
    if(!session||session!==receipt?.targetSession||!validSeq(entry.targetFloor)||!validSeq(seq)||seq<entry.targetFloor||seq>MAX_EVENTS||typeof session.eventAt!=='function')return false
    let ownInsertions=0
    for(let index=entry.targetFloor;index<seq;index+=1) {
      const event=session.eventAt(index)
      if(event?.seq!==index)return false
      if(event.type==='user/message'&&event.data?.source?.replyTo===entry.binding.workId)return false
      if(event.type==='agent/inbox/spliced'&&Array.isArray(event.data?.inserted)) {
        for(const item of event.data.inserted)if(item?.source?.replyTo===entry.binding.workId) {
          if(item.id!==entry.messageId||!isDeepStrictEqual(item,entry.message)||++ownInsertions>1)return false
        }
      }
    }
    return true
  }
  function authorizeClaim(sessionId,message,admissionId) {
    const entry=table()?.[admissionId], receipt=confirmed.get(admissionId)
    try{return !!entry && entry.state==='sending' && entry.binding.requesterSessionId===sessionId
      && entry.messageId===message?.id && isDeepStrictEqual(entry.message,message)
      && receipt?.record===JSON.stringify(entry) && lease()===receipt.generation
      && rt.state.works?.[entry.binding.workId]===undefined && parentAwaiting(entry) && noCompetingReply(entry,receipt)
      && rt.selfOf?.(sessionId)===entry.work.from && rt.chatOf?.(entry.work.from)===sessionId} catch{return false}
  }
  async function inspect(binding) {
    const {record}=get(binding)
    if(!record||record.state==='sending')return {state:'unknown'}
    const receipt=confirmed.get(record.outboxId)
    if(!receipt||receipt.record!==JSON.stringify(record))return {state:'unknown'}
    try{if(lease()!==receipt.generation)return {state:'unknown'};await durable(record,clone(stateOf(record)));return {state:record.state==='reserved'?'reserved':record.state==='prepared'?'prepared':'unknown',outboxId:record.outboxId}}
    catch{return {state:'unknown'}}
  }
  return {reserve,stageResult,beginSend,authorizeClaim,inspect}
}
