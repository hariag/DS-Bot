// Manual owner review only: no agent admission, work settlement, or dispatch.
import { createHash } from 'node:crypto'
import { constants, lstatSync, mkdirSync } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { openReviewLedger, readReviewReceipt } from './review-ledger.mjs'
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const valid = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(value)
const validOperation = value => typeof value==='string' && /^manual-review:[0-9a-f]{64}$/.test(value)
function operationId(kind,workId,payload) {
  if(kind==='create')return `manual-review:${hash({kind,workId})}`
  const {expectedRevision,summary,evidenceRefs,unfinished}=payload
  if(kind!=='finding'||!Number.isSafeInteger(expectedRevision)||expectedRevision<0||typeof summary!=='string'||!summary.trim()||summary.length>4000||!Array.isArray(evidenceRefs)||evidenceRefs.length>32||evidenceRefs.some(v=>typeof v!=='string'||!v.trim()||v.length>500)||!Array.isArray(unfinished)||unfinished.length>32||unfinished.some(v=>typeof v!=='string'||!v.trim()||v.length>500))throw Error('invalid operation')
  return `manual-review:${hash({kind,workId,expectedRevision,summary,evidenceRefs,unfinished})}`
}
const validWorkTime = value => Number.isSafeInteger(value)&&value>=0&&value<=8_640_000_000_000_000
export function install(rt) {
  const {ctx}=rt;let ledger,closing=false,decisionBusy=false,decisionBlocked=false,confirmedTable,confirmedLease
  function writable(){if(closing||rt.stopping||rt.readOnly()!==undefined)throw Error('manual review unavailable');rt.requireHomeLock()}
  function scopeKey(scope,work){
    if(!scope||!['personal','room'].includes(scope.kind)||!valid(scope.id))throw Error('review unavailable')
    if(scope.kind==='room') {if(!rt.state.rooms?.[scope.id]||![work.room,work.fromRoom].includes(scope.id))throw Error('review unavailable');return `room:${scope.id}`}
    if(scope.id!=='user' && (!rt.state.bots?.[scope.id]||![work.from,work.to].includes(scope.id)))throw Error('review unavailable')
    return 'personal:user'
  }
  function workFor(workId){if(!valid(workId))throw Error('review unavailable');const work=rt.state.works?.[workId];if(!work||!valid(work.from)||!valid(work.to)||!rt.state.bots?.[work.from]||!rt.state.bots?.[work.to])throw Error('review unavailable');return work}
  function workHash(workId,work){return hash({workId,from:work.from,to:work.to,room:work.room??null,fromRoom:work.fromRoom??null,parent:work.parent??null,child:work.child??null,at:validWorkTime(work.at)?work.at:null})}
  function decisions(){const table=rt.state.legacyWorkDecisions;if(table===undefined)return undefined;if(!table||typeof table!=='object'||Array.isArray(table))throw Error('work decision history unavailable');return table}
  function decisionFor(workId,work){
    const entry=decisions()?.[hash(workId)]
    if(!entry)return {choice:'open',revision:0}
    if(entry.workId!==workId || entry.fingerprint!==workHash(workId,work) || !Array.isArray(entry.history) || entry.history.length>100
      || entry.history.some((item,index)=>!item||item.revision!==index+1||!['open','ignored','user-accepted'].includes(item.choice)||item.by!=='user'||typeof item.scope!=='string'||!Number.isSafeInteger(item.at))) throw Error('work identity or decision history changed')
    return {choice:entry.history.at(-1)?.choice??'open',revision:entry.history.length}
  }
  async function syncDecisions(){
    const table=decisions();if(table===undefined){if(decisionBlocked)throw Error('work decision outcome unknown');return}
    writable();const lease=rt.homeLockVersion()
    if(!decisionBlocked&&table===confirmedTable&&lease===confirmedLease)return
    const file=await open(rt.statePath,constants.O_RDONLY | (constants.O_NOFOLLOW??0))
    try {
      const before=await file.stat();if(!before.isFile())throw Error('work decision journal unavailable')
      const saved=JSON.parse(await file.readFile('utf8'))?.legacyWorkDecisions
      if(JSON.stringify(saved)!==JSON.stringify(table))throw Error('work decisions are not saved')
      await file.sync();const directory=await open(dirname(rt.statePath),constants.O_RDONLY)
      try{await directory.sync()}finally{await directory.close()}
      const afterFile=await file.stat(),after=await lstat(rt.statePath);writable()
      if(!after.isFile()||after.isSymbolicLink()||before.dev!==after.dev||before.ino!==after.ino||before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.size!==afterFile.size||before.mtimeMs!==afterFile.mtimeMs||rt.homeLockVersion()!==lease||decisions()!==table)throw Error('work decisions changed during confirmation')
      confirmedTable=table;confirmedLease=lease;decisionBlocked=false
    } finally {await file.close()}
  }
  function archiveAllowed(scope,snapshot){
    if(!scope||!valid(scope.id))return false
    if(scope.kind==='personal'&&scope.id==='user')return true
    if(scope.kind==='room')return !!rt.state.rooms?.[scope.id]&&Array.isArray(snapshot.archiveScopes)&&snapshot.archiveScopes.includes(`room:${scope.id}`)
    return scope.kind==='personal'&&!!rt.state.bots?.[scope.id]&&[snapshot.owner,snapshot.sender].includes(scope.id)
  }
  function privateDir(){const root=join(rt.home,'legacy-reviews-v1');try{lstatSync(root)}catch(e){if(e.code!=='ENOENT')throw e;writable();try{mkdirSync(root,{mode:0o700})}catch(x){if(x.code!=='EEXIST')throw x}}const stat=lstatSync(root);if(!stat.isDirectory()||stat.isSymbolicLink()||stat.uid!==process.getuid()||(stat.mode&0o077))throw Error('manual review unavailable');return root}
  function current(snapshot){const work=rt.state.works?.[snapshot.workId];return !!work && validWorkTime(work.at)&&validWorkTime(snapshot.workAt)&&work.at===snapshot.workAt&&work.from===snapshot.sender&&work.to===snapshot.owner&&workHash(snapshot.workId,work)===snapshot.snapshotId}
  function service(){if(ledger)return ledger;writable();ledger=openReviewLedger(join(privateDir(),'reviews.sqlite'),{assertLease:()=>{try{writable();return true}catch{return false}},assertActor:actor=>actor==='user',verifySnapshot:current});return ledger}
  async function call(endpoint,payload={}){
    await rt.load();writable();const {workId,scope}=payload
    if(endpoint==='legacy-review-list'){
      if(decisionBusy)throw Error('work decision outcome unknown')
      const observedTable=decisions()
      await syncDecisions()
      if(decisionBusy||decisionBlocked||decisions()!==observedTable)throw Error('work decisions changed')
      if(!scope||!['personal','room'].includes(scope.kind)||!valid(scope.id)||(scope.kind==='room'&&!rt.state.rooms?.[scope.id])||(scope.kind==='personal'&&scope.id!=='user'&&!rt.state.bots?.[scope.id]))throw Error('review unavailable')
      const revision=rt.state.revision,sample=await rt.recoveryWorkCandidates?.();writable()
      if(!sample||!Array.isArray(sample.ids)||rt.state.revision!==revision||decisionBusy||decisionBlocked||decisions()!==observedTable)throw Error('review sources unavailable')
      let incomplete=sample.incomplete===true
      const ids=new Set(sample.ids)
      for(const entry of Object.values(observedTable??{}))if(typeof entry?.workId==='string')ids.add(entry.workId)
      const items=[];for(const id of ids){let w;try{w=workFor(id);scopeKey(scope,w)}catch{if(observedTable?.[hash(id)]?.history?.some(item=>item.scope===JSON.stringify([scope.kind,scope.id])))incomplete=true;continue}try{if(items.length>=500){incomplete=true;break}items.push({workId:id,owner:w.to,sender:w.from,canDecide:validWorkTime(w.at),...decisionFor(id,w)})}catch{incomplete=true}}
      return {items,incomplete}
    }
    if(endpoint==='legacy-review-decision'){
      if(decisionBusy)throw Error('work decision outcome unknown')
      decisionBusy=true
      try {
        await syncDecisions()
        const work=workFor(workId);scopeKey(scope,work)
        if(!validWorkTime(work.at)||!Number.isSafeInteger(payload.expectedRevision)||payload.expectedRevision<0||!['open','ignored','user-accepted'].includes(payload.choice))throw Error('invalid work decision')
        const fingerprint=workHash(workId,work),key=hash(workId),table=decisions()??{},entry=table[key],history=entry?.history??[]
        decisionFor(workId,work)
        const previous=history[payload.expectedRevision], scoped=JSON.stringify([scope.kind,scope.id])
        if(previous?.revision===payload.expectedRevision+1&&previous.choice===payload.choice&&previous.scope===scoped)return {choice:previous.choice,revision:previous.revision}
        if(history.length!==payload.expectedRevision||history.length>=100||Object.keys(table).length>=10000&&!entry)throw Error('work decision changed or history is full')
        const next={workId,fingerprint,history:[...history,{revision:history.length+1,choice:payload.choice,by:'user',scope:scoped,at:Date.now()}]}
        rt.state.legacyWorkDecisions={...table,[key]:next}
        try {await rt.save({required:true});await syncDecisions()}catch(error){decisionBlocked=true;throw error}
        const fresh=workFor(workId);scopeKey(scope,fresh)
        if(workHash(workId,fresh)!==fingerprint)throw Error('work changed; inspect the decision')
        return {choice:payload.choice,revision:next.history.length}
      } finally {decisionBusy=false}
    }
    if(endpoint==='legacy-review-prepare'){
      const work=workFor(workId);scopeKey(scope,work)
      return {operationId:operationId(payload.kind,workId,payload)}
    }
    if(endpoint==='legacy-review-operation'){
      const {operationId,kind}=payload
      if(!validOperation(operationId)||!['create','finding'].includes(kind))throw Error('invalid receipt request')
      const work=workFor(workId);scopeKey(scope,work)
      return readReviewReceipt(join(rt.home,'legacy-reviews-v1','reviews.sqlite'),{actor:'user',workId,operationId,kind,scope:`${scope.kind}:${scope.id}`,verifySnapshot:current})
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
      const explicit=payload.operationId!==undefined
      if(explicit&&payload.operationId!==operationId('create',workId,payload))throw Error('invalid operation')
      const receiptScope=explicit?`${scope.kind}:${scope.id}`:null
      const existing=service().read({actor:'user',workId});if(existing){
        if(!current(existing.snapshot))throw Error('review unavailable')
        if(explicit&&readReviewReceipt(join(rt.home,'legacy-reviews-v1','reviews.sqlite'),{actor:'user',workId,operationId:payload.operationId,kind:'create',scope:receiptScope,verifySnapshot:current}).status!=='committed')throw Error('work already has a review')
        return existing
      }
      const fingerprint=workHash(workId,work),sample=await rt.recoveryWorkOrigins?.(workId)
      writable();const fresh=workFor(workId);if(workHash(workId,fresh)!==fingerprint||scopeKey(scope,fresh)!==selected)throw Error('review changed; retry')
      const origins=sample && Array.isArray(sample.ids) && sample.observed ? sample : {ids:[],observed:{queue:'unknown',held:'unknown',external:'unknown'}}
      const sampledAt=Number.isSafeInteger(origins.sampledAt)&&origins.sampledAt>=0&&origins.sampledAt<=8_640_000_000_000_000?origins.sampledAt:null
      const archiveScopes=[...new Set([fresh.room,fresh.fromRoom].filter(id=>valid(id)&&rt.state.rooms?.[id]).map(id=>`room:${id}`))].sort()
      const snapshot={workId,owner:fresh.to,sender:fresh.from,scope:selected,snapshotId:fingerprint,workAt:fresh.at,sampledAt,archiveScopes,sources:origins.ids.map(sessionId=>({sessionId,turnStartSeq:null,cursor:null,complete:false})),observations:{...origins.observed,inbox:'unknown',guarded:'unknown'}}
      return service().createReview({operationId:explicit?payload.operationId:`review-create:${hash(workId)}`,actor:'user',workId,snapshot,scope:receiptScope}).current
    }
    if(endpoint==='legacy-review-finding'){
      const currentReview=service().read({actor:'user',workId});if(!currentReview||!current(currentReview.snapshot))throw Error('review unavailable')
      const finding={summary:payload.summary,evidenceRefs:payload.evidenceRefs,unfinished:payload.unfinished,sideEffects:'unknown'}
      const explicit=payload.operationId!==undefined
      if(explicit&&payload.operationId!==operationId('finding',workId,payload))throw Error('invalid operation')
      const expectedRevision=payload.expectedRevision,receiptId=explicit?payload.operationId:`review-finding:${hash({workId,expectedRevision,finding})}`
      return service().submitFinding({operationId:receiptId,actor:'user',workId,expectedRevision,finding,scope:explicit?`${scope.kind}:${scope.id}`:null}).current
    }
    throw Error('review unavailable')
  }
  rt.legacyReviewCall=call
  rt.onHomeDrain?.(()=>{closing=true;ledger?.close();ledger=undefined})
  ctx.effect(()=>()=>{closing=true;ledger?.close();ledger=undefined},'ds-bot: legacy reviews')
}
