// Projection only. The Host must establish a fixed, complete, authoritative snapshot;
// these values never prove a model turn or external side effect did or did not happen.
const object = v => v && typeof v === 'object' && !Array.isArray(v)
const validId = v => typeof v === 'string' && v.length>0 && v.length<=256
const references = (v,workId) => [v?.exchangeId,v?.work,v?.replyTo].includes(workId)
export function observeRecoveryRecords({workId,inflight,maxRecords=20_000}) {
  if(!validId(workId)||!Number.isSafeInteger(maxRecords)||maxRecords<1||maxRecords>20_000)throw Error('invalid query')
  if(!object(inflight)||!object(inflight.queued)||!object(inflight.heldTurns))return {queue:'unknown',held:'unknown',external:'unknown'}
  let qFound=false,qUnknown=false,hFound=false,hUnknown=false,qSeen=0,hSeen=0
  for(const [session,entries] of Object.entries(inflight.queued)) {
    if(!validId(session)||!Array.isArray(entries)){qUnknown=true;continue}
    for(const item of entries) {
      if(++qSeen>maxRecords){qUnknown=true;break}
      const args=item?.args
      if(!object(args)){qUnknown=true;continue}
      if(references(args,workId))qFound=true
      else if(![args.exchangeId,args.work,args.replyTo].some(validId))qUnknown=true
    }
    if(qSeen>maxRecords)break
  }
  for(const value of Object.values(inflight.heldTurns)) {
    if(++hSeen>maxRecords){hUnknown=true;break}
    const trigger=value?.record?.trigger
    if(!object(trigger)){hUnknown=true;continue}
    if(references(trigger,workId))hFound=true
    else if(![trigger.exchangeId,trigger.work,trigger.replyTo].some(validId))hUnknown=true
  }
  const status=(found,unknown)=>found?'observed-present':unknown?'unknown':'observed-absent'
  return {queue:status(qFound,qUnknown),held:status(hFound,hUnknown),external:'unknown'}
}

export function collectRecoveryOrigins({workId,inflight,maxRecords=20_000}) {
  if(!validId(workId)||!Number.isSafeInteger(maxRecords)||maxRecords<1||maxRecords>20_000||!object(inflight)||!object(inflight.queued)||!object(inflight.heldTurns)||!object(inflight.turns)) return undefined
  const ids=new Set();let seen=0
  const add = value => {if(typeof value==='string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(value))ids.add(value)}
  for(const [session,entries] of Object.entries(inflight.queued)) {
    if(!Array.isArray(entries))return undefined
    for(const item of entries){if(++seen>maxRecords)return undefined;const args=item?.args;if(!references(args,workId))continue;add(session);add(args?.sessionId);if(Array.isArray(item.resumeOrigins))for(const id of item.resumeOrigins)add(id)}
  }
  for(const [session,record] of Object.entries(inflight.turns)){if(++seen>maxRecords)return undefined;if(references(record?.trigger,workId))add(session)}
  for(const value of Object.values(inflight.heldTurns)){if(++seen>maxRecords)return undefined;if(references(value?.record?.trigger,workId))add(value?.sessionId)}
  return ids.size>64?undefined:[...ids]
}

export function collectRecoveryCandidates(inflight) {
  if(!object(inflight)||!object(inflight.queued)||!object(inflight.turns)||!object(inflight.heldTurns))return undefined
  const ids=new Set();let seen=0,incomplete=false
  const collect = trigger => {
    if(!object(trigger)){incomplete=true;return}
    const workId = trigger.role==='request' ? trigger.exchangeId : trigger.work
    if(validId(workId))ids.add(workId);else incomplete=true
  }
  for(const entries of Object.values(inflight.queued)) {
    if(!Array.isArray(entries)){incomplete=true;continue}
    for(const item of entries){if(++seen>20_000){incomplete=true;break}collect(item?.args)}
    if(seen>20_000)break
  }
  for(const record of Object.values(inflight.turns)){if(++seen>20_000){incomplete=true;break}collect(record?.trigger)}
  for(const value of Object.values(inflight.heldTurns)){if(++seen>20_000){incomplete=true;break}collect(value?.record?.trigger)}
  const all=[...ids].sort();return {ids:all.slice(0,500),incomplete:incomplete||all.length>500}
}
