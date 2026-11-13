// Isolated legacy work review journal. This module does not send, execute, or close work.
// Security callbacks must come from a real authenticated, leased Host before integration.
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { closeSync, lstatSync, openSync } from 'node:fs'
const id = (v, name) => { if (typeof v !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(v)) throw Error(`invalid ${name}`); return v }
const safeInt = (v, name) => { if (!Number.isSafeInteger(v) || v < 0) throw Error(`invalid ${name}`); return v }
const stable = v => JSON.stringify(v, function (_, value) { return value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b))) : value })
const hash = v => createHash('sha256').update(stable(v)).digest('hex')
const keys = (v, allowed, name) => { if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).some(k=>!allowed.includes(k))) throw Error(`invalid ${name}`) }
function normalizeSnapshot(value,workId) {
  keys(value,['workId','owner','sender','scope','snapshotId','workAt','sources','observations','sampledAt','archiveScopes'],'snapshot')
  if (id(value.workId,'work')!==workId) throw Error('work mismatch')
  id(value.owner,'owner'); id(value.sender,'sender'); id(value.scope,'scope'); id(value.snapshotId,'snapshot')
  safeInt(value.workAt,'work time');if(value.workAt>8_640_000_000_000_000)throw Error('invalid work time')
  if(value.sampledAt!==null&&(!Number.isSafeInteger(value.sampledAt)||value.sampledAt<0||value.sampledAt>8_640_000_000_000_000))throw Error('invalid sampled time')
  if(!Array.isArray(value.archiveScopes)||value.archiveScopes.length>3||value.archiveScopes.some(v=>typeof v!=='string'||!/^room:[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(v))||new Set(value.archiveScopes).size!==value.archiveScopes.length)throw Error('invalid archive scopes')
  if (!Array.isArray(value.sources) || value.sources.length>64) throw Error('invalid sources')
  const sources=value.sources.map(source=>{keys(source,['sessionId','turnStartSeq','cursor','complete'],'source');id(source.sessionId,'session');if(source.turnStartSeq===null || source.cursor===null){if(source.turnStartSeq!==null || source.cursor!==null || source.complete!==false)throw Error('invalid source')}else{safeInt(source.turnStartSeq,'turn');safeInt(source.cursor,'cursor');if(source.turnStartSeq>source.cursor || typeof source.complete!=='boolean')throw Error('invalid source')}return {...source}})
  if(new Set(sources.map(s=>`${s.sessionId}:${s.turnStartSeq}`)).size!==sources.length)throw Error('duplicate source')
  keys(value.observations,['queue','held','inbox','guarded','external'],'observations')
  const observations={};for(const key of ['queue','held','inbox','guarded','external']) {const v=value.observations[key];if(!['observed-present','observed-absent','unknown'].includes(v))throw Error('invalid observation');observations[key]=v}
  return {workId,owner:value.owner,sender:value.sender,scope:value.scope,snapshotId:value.snapshotId,workAt:value.workAt,sampledAt:value.sampledAt,archiveScopes:[...value.archiveScopes],sources,observations}
}
export function openReviewLedger(path,{assertActor,verifySnapshot,assertLease}={}) {
  if (![assertActor,verifySnapshot,assertLease].every(x=>typeof x==='function')) throw Error('host authority unavailable')
  if (path!==':memory:') {
    try {closeSync(openSync(path,'wx',0o600))} catch(e) {if(e.code!=='EEXIST')throw e}
    const file=lstatSync(path);if(!file.isFile() || (file.mode & 0o077)!==0)throw Error('private journal unavailable')
  }
  const db=new DatabaseSync(path)
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS reviews(work_id TEXT PRIMARY KEY, owner TEXT NOT NULL, scope TEXT NOT NULL, state TEXT NOT NULL, revision INTEGER NOT NULL, snapshot TEXT NOT NULL, snapshot_hash TEXT NOT NULL, finding TEXT);
    CREATE TABLE IF NOT EXISTS receipts(operation_id TEXT PRIMARY KEY, actor TEXT NOT NULL, payload_hash TEXT NOT NULL, work_id TEXT NOT NULL, revision INTEGER NOT NULL, kind TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS review_findings(work_id TEXT NOT NULL, revision INTEGER NOT NULL, actor TEXT NOT NULL, finding TEXT NOT NULL, PRIMARY KEY(work_id,revision));`)
  const get=workId=>{const r=db.prepare('SELECT * FROM reviews WHERE work_id=?').get(workId);return r?{workId:r.work_id,owner:r.owner,scope:r.scope,state:r.state,revision:r.revision,snapshot:JSON.parse(r.snapshot),finding:r.finding?JSON.parse(r.finding):null,history:db.prepare('SELECT revision,actor,finding FROM review_findings WHERE work_id=? ORDER BY revision').all(workId).map(v=>({revision:v.revision,actor:v.actor,finding:JSON.parse(v.finding)}))}:undefined}
  const lease=()=>{if(assertLease()!==true)throw Error('host lease unavailable')}
  const authority=(actor,action,record)=>{if(assertActor(actor,action,record)!==true)throw Error('not authorized')}
  function transact({operationId,actor,workId,payload,kind,existingAuth,commit}) {
    id(operationId,'operation');id(actor,'actor');id(workId,'work'); const payloadHash=hash(payload)
    db.exec('BEGIN IMMEDIATE')
    try {
      lease();const existing=db.prepare('SELECT * FROM receipts WHERE operation_id=?').get(operationId)
      if(existing){ if(existing.actor!==actor||existing.payload_hash!==payloadHash||existing.work_id!==workId||existing.kind!==kind)throw Error('operation id conflict');const current=get(workId);authority(actor,'read',current);lease();db.exec('COMMIT');return {status:'committed',operationId,receiptRevision:existing.revision,current} }
      existingAuth(); const result=commit();lease()
      db.prepare('INSERT INTO receipts VALUES (?,?,?,?,?,?)').run(operationId,actor,payloadHash,workId,result.revision,kind)
      db.exec('COMMIT');return {status:'committed',operationId,receiptRevision:result.revision,current:result}
    } catch(e) {try{db.exec('ROLLBACK')}catch{};throw e}
  }
  return {
    close(){db.close()},
    createReview({operationId,actor,workId,snapshot}) {
      id(workId,'work'); const normalized=normalizeSnapshot(snapshot,workId); const payload={kind:'create',workId,snapshot:normalized}
      return transact({operationId,actor,workId,payload,kind:'create',existingAuth:()=>authority(actor,'create',normalized),commit:()=>{
        if(verifySnapshot(normalized)!==true)throw Error('snapshot unavailable or changed')
        if(get(workId))throw Error('work already has a review')
        const s=stable(normalized);db.prepare('INSERT INTO reviews VALUES (?,?,?,?,?,?,?,NULL)').run(workId,normalized.owner,normalized.scope,'needs-review',1,s,hash(normalized));if(verifySnapshot(normalized)!==true)throw Error('snapshot unavailable or changed');authority(actor,'create',normalized);return get(workId)
      }})
    },
    submitFinding({operationId,actor,workId,expectedRevision,finding}) {
      safeInt(expectedRevision,'revision');keys(finding,['summary','evidenceRefs','unfinished','sideEffects'],'finding')
      if(typeof finding.summary!=='string'||!finding.summary.trim()||finding.summary.length>4000||!Array.isArray(finding.evidenceRefs)||finding.evidenceRefs.length>32||finding.evidenceRefs.some(v=>typeof v!=='string'||!v.trim()||v.length>500)||!Array.isArray(finding.unfinished)||finding.unfinished.length>32||finding.unfinished.some(v=>typeof v!=='string'||!v.trim()||v.length>500)||finding.sideEffects!=='unknown')throw Error('invalid finding')
      const payload={kind:'finding',workId,expectedRevision,finding}
      return transact({operationId,actor,workId,payload,kind:'finding',existingAuth:()=>authority(actor,'submit',get(workId)),commit:()=>{
        const row=get(workId);if(!row||(actor!=='user'&&row.owner!==actor)||row.revision!==expectedRevision||row.revision>=101||!['needs-review','evidence-needed'].includes(row.state))throw Error('review unavailable or changed')
        if(verifySnapshot(row.snapshot)!==true)throw Error('snapshot unavailable or changed')
        db.prepare("UPDATE reviews SET state='evidence-needed',revision=revision+1,finding=? WHERE work_id=?").run(stable(finding),workId);db.prepare('INSERT INTO review_findings VALUES (?,?,?,?)').run(workId,row.revision+1,actor,stable(finding));if(verifySnapshot(row.snapshot)!==true)throw Error('snapshot unavailable or changed');authority(actor,'submit',row);return get(workId)
      }})
    },
    read({actor,workId}) {id(actor,'actor');id(workId,'work');lease();const row=get(workId);if(!row)return undefined;authority(actor,'read',row);lease();return row}
  }
}
