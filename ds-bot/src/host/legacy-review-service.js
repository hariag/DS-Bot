// Manual owner review only: no agent admission, work settlement, or dispatch.
import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { openReviewLedger } from './review-ledger.mjs'
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const valid = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(value)
const validWorkTime = value => Number.isSafeInteger(value)&&value>=0&&value<=8_640_000_000_000_000
export function install(rt) {
  const {ctx}=rt;let ledger,closing=false
  function writable(){if(closing||rt.stopping||rt.readOnly()!==undefined)throw Error('manual review unavailable');rt.requireHomeLock()}
  function scopeKey(scope,work){
    if(!scope||!['personal','room'].includes(scope.kind)||!valid(scope.id))throw Error('review unavailable')
    if(scope.kind==='room') {if(!rt.state.rooms?.[scope.id]||![work.room,work.fromRoom].includes(scope.id))throw Error('review unavailable');return `room:${scope.id}`}
    if(scope.id!=='user' && (!rt.state.bots?.[scope.id]||![work.from,work.to].includes(scope.id)))throw Error('review unavailable')
    return 'personal:user'
  }
  function workFor(workId){if(!valid(workId))throw Error('review unavailable');const work=rt.state.works?.[workId];if(!work||!valid(work.from)||!valid(work.to)||!rt.state.bots?.[work.from]||!rt.state.bots?.[work.to])throw Error('review unavailable');return work}
  function workHash(workId,work){return hash({workId,from:work.from,to:work.to,room:work.room??null,fromRoom:work.fromRoom??null,parent:work.parent??null,child:work.child??null,at:validWorkTime(work.at)?work.at:null})}
  function archiveAllowed(scope,snapshot){
    if(!scope||!valid(scope.id))return false
    if(scope.kind==='personal'&&scope.id==='user')return true
    if(scope.kind==='room')return !!rt.state.rooms?.[scope.id]&&Array.isArray(snapshot.archiveScopes)&&snapshot.archiveScopes.includes(`room:${scope.id}`)
    return scope.kind==='personal'&&!!rt.state.bots?.[scope.id]&&[snapshot.owner,snapshot.sender].includes(scope.id)
  }
  function privateDir(){const root=join(rt.home,'legacy-reviews-v1');try{lstatSync(root)}catch(e){if(e.code!=='ENOENT')throw e;writable();try{mkdirSync(root,{mode:0o700})}catch(x){if(x.code!=='EEXIST')throw x}}const stat=lstatSync(root);if(!stat.isDirectory()||stat.isSymbolicLink()||stat.uid!==process.getuid()||(stat.mode&0o077))throw Error('manual review unavailable');return root}
  function current(snapshot){const work=rt.state.works?.[snapshot.workId];return !!work && validWorkTime(work.at)&&validWorkTime(snapshot.workAt)&&work.at===snapshot.workAt&&work.from===snapshot.sender&&work.to===snapshot.owner&&workHash(snapshot.workId,work)===snapshot.snapshotId}
  function service(){if(ledger)return ledger;writable();ledger=openReviewLedger(join(privateDir(),'reviews.sqlite'),{assertLease:()=>{try{writable();return true}catch{return false}},assertActor:(actor,_action)=>actor==='user',verifySnapshot:current});return ledger}
  async function call(endpoint,payload={}){
    await rt.load();writable();const {workId,scope}=payload
    if(endpoint==='legacy-review-list'){
      if(!scope||!['personal','room'].includes(scope.kind)||!valid(scope.id)||(scope.kind==='room'&&!rt.state.rooms?.[scope.id])||(scope.kind==='personal'&&scope.id!=='user'&&!rt.state.bots?.[scope.id]))throw Error('review unavailable')
      const revision=rt.state.revision,sample=await rt.recoveryWorkCandidates?.();writable()
      if(!sample||!Array.isArray(sample.ids)||rt.state.revision!==revision)throw Error('review sources unavailable')
      const items=[];for(const id of sample.ids){try{const w=workFor(id);scopeKey(scope,w);items.push({workId:id,owner:w.to})}catch{}}
      return {items,incomplete:sample.incomplete===true}
    }
    if(endpoint==='legacy-review-get'){
      if(!valid(workId))throw Error('review unavailable')
      let work;try{work=workFor(workId);scopeKey(scope,work)}catch{work=undefined}
      if(!ledger){try{lstatSync(join(rt.home,'legacy-reviews-v1','reviews.sqlite'))}catch(e){if(e.code==='ENOENT'){if(!work)throw Error('review unavailable');if(validWorkTime(work.at))return {state:'not-created'};const fingerprint=workHash(workId,work),sample=await rt.recoveryWorkOrigins?.(workId);writable();const fresh=workFor(workId);scopeKey(scope,fresh);if(workHash(workId,fresh)!==fingerprint)throw Error('review changed; retry');return {state:'identity-unverified',archived:true,liveRecovery:sample&&Array.isArray(sample.ids)&&sample.observed?{available:true,...sample}:{available:false}}};throw e}}
      let existing=service().read({actor:'user',workId})
      if(existing&&(!work||!current(existing.snapshot))){if(!archiveAllowed(scope,existing.snapshot))throw Error('review unavailable');return {...existing,archived:true,liveRecovery:{available:false}}}
      if(!work)throw Error('review unavailable')
      const fingerprint=workHash(workId,work),selected=scopeKey(scope,work),sample=await rt.recoveryWorkOrigins?.(workId)
      writable();const fresh=workFor(workId);if(workHash(workId,fresh)!==fingerprint||scopeKey(scope,fresh)!==selected)throw Error('review changed; retry')
      const liveRecovery=sample&&Array.isArray(sample.ids)&&sample.observed?{available:true,...sample}:{available:false}
      existing=service().read({actor:'user',workId});if(!existing)return validWorkTime(fresh.at)?{state:'not-created',liveRecovery}:{state:'identity-unverified',archived:true,liveRecovery};if(!current(existing.snapshot))throw Error('review unavailable');return {...existing,liveRecovery}
    }
    const work=workFor(workId);const selected=scopeKey(scope,work)
    if(!validWorkTime(work.at))throw Error('work identity unavailable')
    if(endpoint==='legacy-review-create'){
      const existing=service().read({actor:'user',workId});if(existing){if(!current(existing.snapshot))throw Error('review unavailable');return existing}
      const fingerprint=workHash(workId,work),sample=await rt.recoveryWorkOrigins?.(workId)
      writable();const fresh=workFor(workId);if(workHash(workId,fresh)!==fingerprint||scopeKey(scope,fresh)!==selected)throw Error('review changed; retry')
      const origins=sample && Array.isArray(sample.ids) && sample.observed ? sample : {ids:[],observed:{queue:'unknown',held:'unknown',external:'unknown'}}
      const sampledAt=Number.isSafeInteger(origins.sampledAt)&&origins.sampledAt>=0&&origins.sampledAt<=8_640_000_000_000_000?origins.sampledAt:null
      const archiveScopes=[...new Set([fresh.room,fresh.fromRoom].filter(id=>valid(id)&&rt.state.rooms?.[id]).map(id=>`room:${id}`))].sort()
      const snapshot={workId,owner:fresh.to,sender:fresh.from,scope:selected,snapshotId:fingerprint,workAt:fresh.at,sampledAt,archiveScopes,sources:origins.ids.map(sessionId=>({sessionId,turnStartSeq:null,cursor:null,complete:false})),observations:{...origins.observed,inbox:'unknown',guarded:'unknown'}}
      return service().createReview({operationId:`review-create:${hash(workId)}`,actor:'user',workId,snapshot}).current
    }
    if(endpoint==='legacy-review-finding'){
      const currentReview=service().read({actor:'user',workId});if(!currentReview||!current(currentReview.snapshot))throw Error('review unavailable')
      const finding={summary:payload.summary,evidenceRefs:payload.evidenceRefs,unfinished:payload.unfinished,sideEffects:'unknown'}
      const expectedRevision=payload.expectedRevision,operationId=`review-finding:${hash({workId,expectedRevision,finding})}`
      return service().submitFinding({operationId,actor:'user',workId,expectedRevision,finding}).current
    }
    throw Error('review unavailable')
  }
  rt.legacyReviewCall=call
  rt.onHomeDrain?.(()=>{closing=true;ledger?.close();ledger=undefined})
  ctx.effect(()=>()=>{closing=true;ledger?.close();ledger=undefined},'ds-bot: legacy reviews')
}
