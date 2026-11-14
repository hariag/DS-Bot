// Separate authority journal: an admission outcome is never a work result.
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { constants, closeSync, fsyncSync, lstatSync, openSync } from 'node:fs'
import { dirname, isAbsolute } from 'node:path'

const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/
const HEX = /^[a-f0-9]{64}$/
const SCHEMA = "CREATE TABLE redo_intents (operation_id TEXT PRIMARY KEY, recovery_id TEXT NOT NULL UNIQUE, admission_id TEXT NOT NULL UNIQUE, message_id TEXT NOT NULL UNIQUE, binding TEXT NOT NULL, binding_hash TEXT NOT NULL, message TEXT NOT NULL, message_hash TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('prepared','sending','queued','claiming','claimed')), turn INTEGER, turn_start_seq INTEGER)"
const id = value => typeof value === 'string' && ID.test(value)
const digest = value => createHash('sha256').update(value).digest('hex')
const stable = value => JSON.stringify(value, function (_key, current) {
  if (current && typeof current === 'object' && !Array.isArray(current)) return Object.fromEntries(Object.entries(current).sort(([a],[b]) => a.localeCompare(b)))
  return current
})
const object = value => value && typeof value === 'object' && !Array.isArray(value)
const keys = (value, allowed) => object(value) && Object.keys(value).every(key => allowed.includes(key))
function assertJson(value, seen = new Set()) {
  if (value===null || typeof value==='string' || typeof value==='boolean')return
  if (typeof value==='number' && Number.isFinite(value))return
  if (!value || typeof value!=='object' || seen.has(value))throw Error('non-JSON redo data')
  if (!Array.isArray(value) && Object.getPrototypeOf(value)!==Object.prototype && Object.getPrototypeOf(value)!==null)throw Error('non-JSON redo object')
  for(const key of Reflect.ownKeys(value)) {
    if(Array.isArray(value)&&key==='length')continue
    const descriptor=Object.getOwnPropertyDescriptor(value,key)
    if(typeof key!=='string'||!descriptor?.enumerable||!Object.hasOwn(descriptor,'value'))throw Error('non-JSON redo property')
  }
  seen.add(value)
  if(Array.isArray(value)) {
    for(let index=0;index<value.length;index+=1){if(!Object.hasOwn(value,index))throw Error('sparse redo data');assertJson(value[index],seen)}
    if(Object.keys(value).some(key=>!/^\d+$/.test(key)||Number(key)>=value.length))throw Error('invalid redo array')
  } else for(const key of Object.keys(value))assertJson(value[key],seen)
  seen.delete(value)
}
const exactJson = value => {
  assertJson(value)
  const result = stable(value)
  if (typeof result !== 'string' || Buffer.byteLength(result)>100_000 || stable(JSON.parse(result)) !== result) throw Error('invalid redo data')
  return result
}
const freeze = value => {
  if(value&&typeof value==='object'&&!Object.isFrozen(value)){for(const part of Object.values(value))freeze(part);Object.freeze(value)}
  return value
}
export const redoSnapshot = value => freeze(JSON.parse(exactJson(value)))

// This version is intentionally narrow: one original bot request, one message,
// and an explicitly validated work association. Other histories remain held.
export function normalizeRedoBinding(value) {
  if (!keys(value,['recoveryId','scope','sessionId','turn','messageSeq','throughSeq','exchangeId','workId','senderId','recipientId','roomId','sourceHash'])) throw Error('invalid redo binding')
  if (!HEX.test(value.recoveryId) || !HEX.test(value.sourceHash) || !id(value.sessionId) || !id(value.exchangeId)
    || !id(value.workId) || !id(value.senderId) || !id(value.recipientId)
    || !Number.isSafeInteger(value.turn) || value.turn<0 || !Number.isSafeInteger(value.messageSeq) || value.messageSeq<0
    || !Number.isSafeInteger(value.throughSeq) || value.throughSeq<=value.messageSeq) throw Error('invalid original identity')
  if (!keys(value.scope,['kind','id']) || !['room','personal'].includes(value.scope.kind) || !id(value.scope.id)) throw Error('invalid redo scope')
  if (value.roomId !== undefined && !id(value.roomId)) throw Error('invalid room')
  if (value.scope.kind==='room' && value.roomId!==value.scope.id) throw Error('redo scope mismatch')
  if (value.scope.kind==='personal' && !['user',value.senderId,value.recipientId].includes(value.scope.id)) throw Error('redo scope mismatch')
  return redoSnapshot(value)
}

export function redoIdentity(binding) {
  const normalized = normalizeRedoBinding(binding)
  // One recovery record gets one admission identity across every UI scope.
  const token = digest(`ds-bot:redo:v1:${normalized.recoveryId}`)
  return { operationId:`redo:${token}`, admissionId:`redo:${token}`, messageId:`redo-${token}` }
}
export function validateRedoMessage(binding,message) {
  const value=normalizeRedoBinding(binding), identity=redoIdentity(value)
  if(!object(message)||message.id!==identity.messageId||message.role!=='user'||!object(message.source)
    ||message.source.kind!=='bot'||message.source.role!=='request'||message.source.exchangeId!==value.exchangeId
    ||message.source.senderSessionId!==value.senderId||value.workId!==value.exchangeId
    ||message.source.roomId!==value.roomId||!Array.isArray(message.content)||message.content.length===0
    ||message.content.some(part=>!keys(part,['type','text'])||part.type!=='text'||typeof part.text!=='string')
    ||message.content.every(part=>part.text.trim()===''))throw Error('unsupported original message')
  if(digest(exactJson({source:message.source,content:message.content}))!==value.sourceHash)throw Error('original message changed')
  exactJson(message)
  return true
}

export function openGuardedRedoJournal(path, { assertLease, authorizeIntent, authorizeClaim } = {}) {
  if (![assertLease,authorizeIntent,authorizeClaim].every(fn => typeof fn === 'function')) throw Error('redo authority unavailable')
  if (!isAbsolute(path)) throw Error('redo journal requires an absolute path')
  const dir=lstatSync(dirname(path))
  if(!dir.isDirectory()||dir.isSymbolicLink()||dir.uid!==process.getuid()||(dir.mode&0o077)!==0) throw Error('redo directory unavailable')
  let created=false
  try { const fd=openSync(path,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|(constants.O_NOFOLLOW??0),0o600);closeSync(fd);created=true }
  catch(error) { if(error.code!=='EEXIST')throw error }
  const file=lstatSync(path)
  if(!file.isFile()||file.isSymbolicLink()||file.uid!==process.getuid()||(file.mode&0o077)!==0)throw Error('redo journal unavailable')
  const lease=()=>{
    if(assertLease()!==true)throw Error('redo lease unavailable')
    const current=lstatSync(path)
    if(!current.isFile()||current.isSymbolicLink()||current.uid!==file.uid||(current.mode&0o077)!==0||current.dev!==file.dev||current.ino!==file.ino)throw Error('redo journal replaced')
  }
  lease()
  const db=new DatabaseSync(path)
  try {
    db.exec('PRAGMA busy_timeout=0; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL')
    const version=db.prepare('PRAGMA user_version').get().user_version
    const app=db.prepare('PRAGMA application_id').get().application_id
    if(created){
      db.exec('BEGIN IMMEDIATE')
      try {
        db.exec(`${SCHEMA}; PRAGMA application_id=1146311247; PRAGMA user_version=1`)
        lease();db.exec('COMMIT')
      } catch(error){try{db.exec('ROLLBACK')}catch{};throw error}
      const fd=openSync(dirname(path),constants.O_RDONLY|(constants.O_NOFOLLOW??0));try{fsyncSync(fd)}finally{closeSync(fd)}
    } else if(version!==1||app!==1146311247)throw Error('unknown redo journal')
    const names=db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all()
    const columns=db.prepare('PRAGMA table_info(redo_intents)').all().map(row=>[row.name,row.type,row.notnull,row.pk])
    const expected=[['operation_id','TEXT',0,1],['recovery_id','TEXT',1,0],['admission_id','TEXT',1,0],['message_id','TEXT',1,0],['binding','TEXT',1,0],['binding_hash','TEXT',1,0],['message','TEXT',1,0],['message_hash','TEXT',1,0],['state','TEXT',1,0],['turn','INTEGER',0,0],['turn_start_seq','INTEGER',0,0]]
    if(names.length!==1||names[0].type!=='table'||names[0].name!=='redo_intents'||names[0].sql!==SCHEMA||JSON.stringify(columns)!==JSON.stringify(expected)||db.prepare('PRAGMA quick_check').get().quick_check!=='ok')throw Error('invalid redo journal')
  } catch(error){db.close();throw error}
  let inTransaction=false
  const read=operationId=>db.prepare('SELECT * FROM redo_intents WHERE operation_id=?').get(operationId)
  const tx=fn=>{
    if(inTransaction)throw Error('nested redo transaction')
    inTransaction=true
    try {lease();db.exec('BEGIN IMMEDIATE');try{lease();const result=fn();lease();db.exec('COMMIT');return result}catch(error){try{db.exec('ROLLBACK')}catch{};throw error}}
    finally {inTransaction=false}
  }
  function verifyRow(row,binding,message){
    const identity=redoIdentity(binding);validateRedoMessage(binding,message)
    if(!row||row.operation_id!==identity.operationId||row.recovery_id!==binding.recoveryId||row.admission_id!==identity.admissionId||row.message_id!==identity.messageId
      ||row.binding!==exactJson(binding)||row.binding_hash!==digest(row.binding)||row.message!==exactJson(message)||row.message_hash!==digest(row.message))throw Error('redo identity conflict')
  }
  return {
    close(){if(inTransaction)throw Error('nested redo transaction');db.close()},
    reserve({binding,message,confirmed}) {
      const normalized=normalizeRedoBinding(binding), safeMessage=redoSnapshot(message), identity=redoIdentity(normalized), messageText=exactJson(safeMessage), bindingText=exactJson(normalized)
      if(confirmed!==true)throw Error('explicit redo confirmation required')
      validateRedoMessage(normalized,safeMessage)
      return tx(()=>{
        if(authorizeIntent(normalized,safeMessage)!==true)throw Error('redo intent unauthorized')
        const existing=read(identity.operationId)
        if(existing){verifyRow(existing,normalized,safeMessage);return {state:'unknown',...identity}}
        db.prepare('INSERT INTO redo_intents VALUES (?,?,?,?,?,?,?,?,?,NULL,NULL)').run(identity.operationId,normalized.recoveryId,identity.admissionId,identity.messageId,bindingText,digest(bindingText),messageText,digest(messageText),'prepared')
        return {state:'prepared',...identity}
      })
    },
    beginSend({binding,message}) {
      const normalized=normalizeRedoBinding(binding),safeMessage=redoSnapshot(message),identity=redoIdentity(normalized)
      return tx(()=>{
        const row=read(identity.operationId);verifyRow(row,normalized,safeMessage)
        if(row.state!=='prepared'||authorizeIntent(normalized,safeMessage)!==true)throw Error('redo admission unavailable')
        if(db.prepare("UPDATE redo_intents SET state='sending' WHERE operation_id=? AND state='prepared'").run(identity.operationId).changes!==1)throw Error('redo admission changed')
        return identity
      })
    },
    markQueued({binding,message}) {
      const normalized=normalizeRedoBinding(binding),safeMessage=redoSnapshot(message),identity=redoIdentity(normalized)
      return tx(()=>{
        const row=read(identity.operationId);verifyRow(row,normalized,safeMessage)
        if(row.state==='sending')db.prepare("UPDATE redo_intents SET state='queued' WHERE operation_id=? AND state='sending'").run(identity.operationId)
        // A claim may have begun before guardedSend returned; never reverse it.
        else if(!['claiming','claimed'].includes(row.state))throw Error('redo admission changed')
        return {state:'unknown',...identity}
      })
    },
    claim(sessionId,input,turn,claim) {
      if(inTransaction)throw Error('nested redo transaction')
      if(!id(sessionId)||!object(input)||input.target!=='next-turn'||!id(input.admissionId)||typeof claim!=='function'
        ||!object(turn)||!Number.isSafeInteger(turn.turn)||turn.turn<0||!Number.isSafeInteger(turn.turnStartSeq)||turn.turnStartSeq<0)throw Error('invalid redo claim')
      const row=db.prepare('SELECT * FROM redo_intents WHERE admission_id=?').get(input.admissionId)
      if(!row)throw Error('redo admission unavailable')
      const binding=normalizeRedoBinding(JSON.parse(row.binding)),message=redoSnapshot(JSON.parse(row.message))
      verifyRow(row,binding,message)
      if(binding.sessionId!==sessionId||input.message?.id!==row.message_id||exactJson(input.message)!==row.message)throw Error('redo target changed')
      tx(()=>{
        const current=read(row.operation_id);verifyRow(current,binding,message)
        if(!['sending','queued'].includes(current.state)||authorizeClaim(binding,message,turn)!==true)throw Error('redo claim unauthorized or already reserved')
        if(db.prepare("UPDATE redo_intents SET state='claiming',turn=?,turn_start_seq=? WHERE operation_id=? AND state=?").run(turn.turn,turn.turnStartSeq,row.operation_id,current.state).changes!==1)throw Error('redo claim changed')
      })
      return tx(()=>{
        const current=read(row.operation_id);verifyRow(current,binding,message)
        if(current.state!=='claiming'||authorizeClaim(binding,message,turn)!==true)throw Error('redo claim changed')
        const result=claim()
        if(result!==undefined){if(result instanceof Promise)void result.catch(()=>{});throw Error('redo claim must be synchronous')}
        if(db.prepare("UPDATE redo_intents SET state='claimed' WHERE operation_id=? AND state='claiming'").run(row.operation_id).changes!==1)throw Error('redo claim changed')
        return 'committed'
      })
    },
    inspect({binding,message}) {
      if(inTransaction)throw Error('nested redo transaction')
      const normalized=normalizeRedoBinding(binding),safeMessage=redoSnapshot(message),identity=redoIdentity(normalized)
      lease();if(authorizeIntent(normalized,safeMessage)!==true)throw Error('redo inspection unauthorized')
      const row=read(identity.operationId);if(!row)return {state:'unknown',...identity}
      verifyRow(row,normalized,safeMessage);lease()
      // Neither a missing receipt nor a claimed row proves the business result.
      return {state:'unknown',...identity}
    },
  }
}
