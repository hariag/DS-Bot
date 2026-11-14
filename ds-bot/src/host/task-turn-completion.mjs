import { randomUUID } from 'node:crypto'

// A reported task is not a completed writer turn. The receipt must be opened
// on the real session writer during guarded claim, before any model work.
export function createTaskTurnCompletion({store,actionContext,beginReceipt,assertLease,wake=()=>{},onError=()=>{}}) {
  if (!store || typeof store.reportedForSession!=='function' || typeof store.finishExplicitTurn!=='function'
    || typeof store.pendingReviewsForSession!=='function' || typeof store.finishExplicitReview!=='function'
    || typeof actionContext?.activate!=='function' || typeof actionContext?.current!=='function'
    || typeof beginReceipt!=='function' || typeof assertLease!=='function') throw Error('turn completion host unavailable')
  const observations=new Map(), pending=new Set(), proofs=new Map()
  let closed=false
  const activate=(agent,position)=>{
    if(closed)throw Error('turn completion is closed')
    assertLease()
    const session=agent?.session
    if(!session || session.id!==agent.id || observations.has(session))throw Error('session observation unavailable')
    const receipt=beginReceipt(session.id,'turn/end')
    if(typeof receipt?.confirm!=='function'||typeof receipt?.dispose!=='function')throw Error('durable receipt unavailable')
    try {actionContext.activate(agent,position);observations.set(session,receipt)}
    catch(error){receipt.dispose();throw error}
  }
  const verify=(task,action,proof,actor)=>{
    const saved=proof && proofs.get(proof.nonce)
    return actor==='host' && !!saved && saved.taskId===task?.id && saved.actionId===action?.id
      && JSON.stringify(saved.proof)===JSON.stringify(proof) && !closed
  }
  const authorize=input=>['finish-explicit-turn','finish-explicit-review'].includes(input?.type) && input.actor==='host'
    && [...proofs.values()].some(item=>item.taskId===input.task?.id) && !closed
  const observe=(session,event)=>{
    if(event?.type!=='turn/end')return
    const receipt=observations.get(session),current=actionContext.current(session)
    if(!receipt)return
    observations.delete(session)
    if(!current || event?.data?.turn!==current.turn || !Number.isSafeInteger(event.seq)
      || event.seq<=current.turnStartSeq || event?.data?.reason?.kind!=='completed') {receipt.dispose();return}
    let candidates
    try {
      assertLease()
      candidates=[...store.reportedForSession(session.id).map(item=>({...item,kind:'execute'})),...store.pendingReviewsForSession(session.id).map(item=>({...item,kind:'review'}))].filter(({binding})=>binding?.sessionId===session.id
        && binding.sessionGeneration===current.sessionGeneration && binding.turn===current.turn && binding.turnStartSeq===current.turnStartSeq)
    } catch(error) {receipt.dispose();onError(error);return}
    if(!candidates.length){receipt.dispose();return}
    // Defer confirmation until all synchronous session/event observers have
    // had a chance to route this very event to the persistence writer.
    const job=Promise.resolve().then(async()=>{
      try {
        await receipt.confirm(event)
        assertLease()
        if(closed)throw Error('turn completion is closed')
        for(const {task,actionId,kind} of candidates){
          const proof={nonce:randomUUID(),sessionId:session.id,sessionGeneration:current.sessionGeneration,turn:current.turn,turnStartSeq:current.turnStartSeq,endSeq:event.seq}
          proofs.set(proof.nonce,{taskId:task.id,actionId,proof})
          try {
            const finish=kind==='review' ? store.finishExplicitReview : store.finishExplicitTurn
            finish({operationId:`turn-finished:${actionId}:${event.seq}`,actor:'host',taskId:task.id,expectedRevision:task.revision,proof})
          }
          finally {proofs.delete(proof.nonce)}
        }
        await wake()
      } finally {receipt.dispose()}
    }).catch(error=>{try{onError(error)}catch{}})
    pending.add(job);void job.finally(()=>pending.delete(job))
  }
  return {activate,observe,verify,authorize,async close(){closed=true;for(const receipt of observations.values())receipt.dispose();observations.clear();await Promise.all([...pending])}}
}
