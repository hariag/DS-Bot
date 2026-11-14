// Experimental integration boundary. It is deliberately not installed by the
// plugin until real Host authority and result settlement are implemented.
import { normalizeRedoBinding, redoIdentity, redoSnapshot, validateRedoMessage } from './guarded-redo-journal.mjs'

const unavailable = reason => ({state:'unavailable',reason})
const unknown = () => ({state:'unknown'})

// Wrap the single coordinator during its initial registration. Never register
// another coordinator on an already active Agent. A mixed batch is held before
// claim; no message is removed or converted to another identity.
export function sharedGuardedCoordinator({sessionId,agent,redoJournal,otherCoordinator,isCurrent}) {
  if(typeof sessionId!=='string'||!agent||agent.id!==sessionId||agent.session?.id!==sessionId||agent.durableAdmissionVersion!==1||agent.guardedClaimTurnVersion!==1
    ||!redoJournal||typeof redoJournal.claim!=='function'||typeof otherCoordinator!=='function'||typeof isCurrent!=='function')throw Error('shared guarded coordinator unavailable')
  return (actualSessionId,inputs,claim,turn)=>{
    if(actualSessionId!==sessionId||isCurrent(agent)!==true||!Array.isArray(inputs)||inputs.length===0||typeof claim!=='function')throw Error('guarded coordinator changed')
    const redo=inputs.filter(item=>typeof item?.admissionId==='string'&&item.admissionId.startsWith('redo:'))
    if(redo.length===0)return otherCoordinator(actualSessionId,inputs,claim,turn)
    if(redo.length!==1||inputs.length!==1)throw Error('mixed guarded claim must remain queued')
    return redoJournal.claim(actualSessionId,redo[0],turn,claim)
  }
}

// verifyOriginal must read an exact contiguous persisted prefix behind the
// target writer barrier and prove the original work route. isCurrent must
// recheck the same live writer, scope, membership, stop state and lease.
// resultAuthority must be bound to the actual Agent result path. Its durable
// receipt is separate from admission; a boolean acknowledgement is not enough.
export function createGuardedRedoBridge({enabled=false,journal,verifyOriginal,resolveAgent,isCurrent,resultAuthority,isResultRouterBound,makeMessage,leaseVersion,coordinatorReady}={}) {
  const ready=()=>enabled===true&&journal&&typeof journal.reserve==='function'&&typeof journal.beginSend==='function'&&typeof journal.markQueued==='function'
    &&[verifyOriginal,resolveAgent,isCurrent,resultAuthority,isResultRouterBound,makeMessage,leaseVersion,coordinatorReady].every(fn=>typeof fn==='function')
  return {
    available:()=>ready()===true,
    async request({binding,confirmed}={}) {
      if(!ready())return unavailable('guarded redo authority is unavailable')
      if(confirmed!==true)return unavailable('explicit user confirmation is required')
      let value,lease,proof,agent,message,original,settlement,started=false
      try {
        value=normalizeRedoBinding(binding);lease=leaseVersion()
        if(lease===undefined)return unavailable('host lease is unavailable')
        proof=await verifyOriginal(value)
        if(!proof||proof.complete!==true||proof.durability!=='target-writer-v1'||!['unfinished','aborted','failed'].includes(proof.originalOutcome)
          ||proof.sessionId!==value.sessionId||proof.throughSeq!==value.throughSeq
          ||proof.messageSeq!==value.messageSeq||proof.turn!==value.turn||!proof.message||leaseVersion()!==lease)return unavailable('original work cannot be verified')
        original=redoSnapshot(proof.message)
        settlement=await resultAuthority(value,proof)
        if(!settlement||settlement.version!=='durable-original-result-v1'||typeof settlement.claimOriginalResult!=='function'
          ||typeof settlement.readResultReceipt!=='function'||typeof settlement.isCurrent!=='function'||settlement.isCurrent()!==true
          ||leaseVersion()!==lease)return unavailable('original work result cannot be safely reconciled')
        agent=await resolveAgent(value.sessionId)
        if(!agent||agent.id!==value.sessionId||agent.session?.id!==value.sessionId||agent.durableAdmissionVersion!==1
          ||agent.guardedClaimTurnVersion!==1||typeof agent.guardedSend!=='function'||coordinatorReady(agent)!==true||isResultRouterBound(agent,settlement)!==true||settlement.isCurrent()!==true
          ||isCurrent(value,proof,agent)!==true||leaseVersion()!==lease)return unavailable('guarded target is unavailable')
        const identity=redoIdentity(value)
        if(JSON.stringify(redoSnapshot(proof.message))!==JSON.stringify(original))return unavailable('original message changed')
        message=redoSnapshot(makeMessage(original,identity.messageId))
        validateRedoMessage(value,message)
        // The new user message may have a new message ID but cannot replace,
        // truncate, summarize or mix the selected original input.
        if(JSON.stringify(message.content)!==JSON.stringify(original.content)||JSON.stringify(message.source)!==JSON.stringify(original.source))return unavailable('original message cannot be reproduced exactly')
        started=true
        const reserved=journal.reserve({binding:value,message,confirmed:true})
        if(reserved.state!=='prepared')return unknown()
        journal.beginSend({binding:value,message})
        if(leaseVersion()!==lease||isCurrent(value,proof,agent)!==true||coordinatorReady(agent)!==true||isResultRouterBound(agent,settlement)!==true||settlement.isCurrent()!==true)return unknown()
        await agent.guardedSend(message,'next-turn',identity.admissionId)
        if(leaseVersion()!==lease||isCurrent(value,proof,agent)!==true||coordinatorReady(agent)!==true||isResultRouterBound(agent,settlement)!==true||settlement.isCurrent()!==true)return unknown()
        journal.markQueued({binding:value,message})
        // Admission is not completion or an external exactly-once guarantee.
        return {state:'submitted',operationId:identity.operationId}
      } catch {return started?unknown():unavailable('original work cannot be verified')}
    },
  }
}
