import { createInboxAudit } from './inbox-audit.js'
import { normalizeRedoBinding, redoIdentity, redoSnapshot, validateRedoMessage } from './guarded-redo-journal.mjs'

// The caller supplies actual synchronous Host authorization, never a guessed
// queue state. A missing target writer or incomplete prefix is not evidence.
export function createTargetWriterRedoProof({ctx,assertLease,leaseVersion,authorizeCurrent}={}) {
  if(!ctx||![assertLease,leaseVersion,authorizeCurrent].every(fn=>typeof fn==='function'))throw Error('redo proof authority unavailable')
  const persistence=()=>{try{return typeof ctx.get==='function'?ctx.get('sessionPersistence'):ctx.sessionPersistence}catch{return undefined}}
  return async input=>{
    let handle
    try {
      const binding=normalizeRedoBinding(input), store=ctx.sessions, writer=persistence()
      if(typeof store?.get!=='function'||typeof writer?.flushLiveSession!=='function'||typeof writer?.open!=='function')return undefined
      const lease=leaseVersion(),session=store.get(binding.sessionId),through=session?.seq
      if(assertLease()!==true||lease===undefined||!session||typeof session.eventAt!=='function'||through!==binding.throughSeq
        ||through<1||through>200_000||authorizeCurrent(binding,session)!==true)return undefined
      const current=()=>assertLease()===true&&leaseVersion()===lease&&store.get(binding.sessionId)===session
        &&session.seq===through&&authorizeCurrent(binding,session)===true
      const signal=AbortSignal.timeout(15_000)
      await writer.flushLiveSession(binding.sessionId)
      if(signal.aborted||!current())return undefined
      handle=await writer.open(binding.sessionId,'read',{signal})
      const read=await handle.read(0,through,{signal})
      if(signal.aborted||!current()||!Array.isArray(read?.events)||read.events.length!==through
        ||read.events.some((event,index)=>event?.seq!==index||typeof event.type!=='string'))return undefined
      const events=read.events,audit=createInboxAudit(binding.sessionId)
      for(const event of events)audit.observe(event)
      const folded=audit.finish(through), original=events[binding.messageSeq]
      const records=folded.records.filter(row=>row.id===binding.originalMessageId)
      if(folded.untrackedAdmissions!==0||records.length!==1||records[0].status!=='entered-in-log'
        ||records[0].entered.length!==1||records[0].entered[0]!==binding.messageSeq
        ||folded.records.filter(row=>row.exchangeIds.includes(binding.exchangeId)).length!==1
        ||original?.type!=='user/message'||original.data?.id!==binding.originalMessageId
        ||JSON.stringify(redoSnapshot(session.eventAt(binding.messageSeq)))!==JSON.stringify(redoSnapshot(original)))return undefined
      let currentTurn,originalTurn,end,starts=0
      for(const event of events){
        if(event.type==='turn/start'){
          if(currentTurn!==undefined||!Number.isSafeInteger(event.data?.turn))return undefined
          currentTurn=event.data.turn;if(currentTurn===binding.turn)starts+=1
        } else if(event.type==='user/message') {
          if(event.seq===binding.messageSeq)originalTurn=currentTurn
          if(event.seq>binding.messageSeq&&Array.isArray(event.data?.source?.recoveryIds)
            &&event.data.source.recoveryIds.includes(`${binding.sessionId}:${binding.messageSeq}`))return undefined
        } else if(event.type==='turn/end'){
          if(currentTurn===undefined||event.data?.turn!==currentTurn)return undefined
          if(currentTurn===binding.turn){if(end!==undefined)return undefined;end=event.data.reason}
          currentTurn=undefined
        }
      }
      if(starts!==1||originalTurn!==binding.turn)return undefined
      // A user- or hook-cancelled turn is not permission to resume it.
      const originalOutcome=end===undefined?'unfinished':end?.kind==='interrupted'?'unfinished':end?.kind==='error'?'failed':undefined
      if(!originalOutcome)return undefined
      const message=redoSnapshot({id:original.data.id,role:'user',source:original.data.source,content:original.data.content})
      validateRedoMessage(binding,{...message,id:redoIdentity(binding).messageId})
      if(!current())return undefined
      return {complete:true,durability:'target-writer-v1',originalOutcome,sessionId:binding.sessionId,throughSeq:through,
        messageSeq:binding.messageSeq,turn:binding.turn,message,isCurrent:current}
    } catch {return undefined} finally {await handle?.close().catch(()=>{})}
  }
}
