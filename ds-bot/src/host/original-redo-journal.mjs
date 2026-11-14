import { createHash, randomUUID } from 'node:crypto'
import { constants, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { userRedoConfirmation } from './user-redo-journal.mjs'

const nofollow = constants.O_NOFOLLOW ?? 0
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x1f]/.test(value)
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value)
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const copy = value => structuredClone(value)
const principalValid = value => value?.kind === 'user' && value.id === 'user' && Object.keys(value).every(key => ['kind', 'id'].includes(key))
const scopeValid = value => value && ['room', 'personal'].includes(value.kind) && validId(value.id) && Object.keys(value).every(key => ['kind', 'id'].includes(key))

export function originalRedoIdentity(operationId) {
  if (!uuid(operationId)) throw Error('invalid redo operation')
  const key = hash(['ds-bot:original-session-redo:v1', operationId])
  return { operationId, messageId:`redo-input-${key}`, admissionId:`redo:${key}` }
}

// This journal is not installed by itself. Callers must prove the original
// writer and bind the current Agent, exact Session object and scope before use.
export function createOriginalRedoJournal(rt, { authorize, proveOriginal, validateBinding, verifyResult } = {}) {
  if (typeof rt?.home !== 'string' || typeof rt.requireHomeLock !== 'function' || typeof rt.homeLockVersion !== 'function'
    || typeof authorize !== 'function' || typeof proveOriginal !== 'function' || typeof validateBinding !== 'function') throw Error('redo authority unavailable')
  const root = join(rt.home, 'original-redo-v1'), marker = join(rt.home, '.original-redo-v1.identity'), busy = rt.originalRedoBusy ??= new Set()
  let directoryIdentity
  const lease = () => { rt.requireHomeLock(); const v = rt.homeLockVersion(); if (v == null) throw Error('redo lease unavailable'); return v }
  const sameLease = generation => {
    if (lease() !== generation) throw Error('redo lease changed')
    if (directoryIdentity) {
      const current = lstatSync(root), home = lstatSync(rt.home)
      if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== directoryIdentity.dev || current.ino !== directoryIdentity.ino
        || !home.isDirectory() || home.isSymbolicLink() || home.dev !== directoryIdentity.homeDev || home.ino !== directoryIdentity.homeIno) throw Error('redo directory changed')
    }
  }
  const dirSync = path => { const fd = openSync(path, constants.O_RDONLY | nofollow); try { fsyncSync(fd) } finally { closeSync(fd) } }
  function directory(generation) {
    sameLease(generation)
    try { mkdirSync(root, { mode:0o700 }) } catch (error) { if (error.code !== 'EEXIST') throw error }
    const stat = lstatSync(root), home = lstatSync(rt.home)
    if (!stat.isDirectory() || stat.isSymbolicLink() || (typeof process.getuid === 'function' && stat.uid !== process.getuid()) || (stat.mode & 0o077)) throw Error('redo directory unavailable')
    if (!home.isDirectory() || home.isSymbolicLink()) throw Error('redo directory unavailable')
    const identity = { dev:stat.dev, ino:stat.ino, homeDev:home.dev, homeIno:home.ino }
    let fd
    try {
      fd = openSync(marker, constants.O_RDONLY | nofollow)
    } catch (error) {
      if (error.code !== 'ENOENT' || readdirSync(root).length !== 0) throw Error('redo identity unavailable')
      const created = openSync(marker, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | nofollow, 0o600)
      try { writeFileSync(created, JSON.stringify(identity)); fsyncSync(created) } finally { closeSync(created) }
      dirSync(rt.home)
      fd = openSync(marker, constants.O_RDONLY | nofollow)
    }
    try {
      const state = fstatSync(fd)
      if (!state.isFile() || state.size > 1024 || (state.mode & 0o077) || (typeof process.getuid === 'function' && state.uid !== process.getuid())
        || !isDeepStrictEqual(JSON.parse(readFileSync(fd, 'utf8')), identity)) throw Error('redo identity unavailable')
      fsyncSync(fd)
    } finally { closeSync(fd) }
    dirSync(rt.home)
    const after = lstatSync(root)
    if (!after.isDirectory() || after.isSymbolicLink() || after.dev !== stat.dev || after.ino !== stat.ino) throw Error('redo directory changed')
    if (directoryIdentity && !isDeepStrictEqual(directoryIdentity, identity)) throw Error('redo directory changed')
    directoryIdentity = identity
    sameLease(generation)
  }
  function pathFor(operationId) { if (!uuid(operationId)) throw Error('invalid redo operation'); return join(root, `${operationId}.json`) }
  function read(operationId) {
    const fd = openSync(pathFor(operationId), constants.O_RDONLY | nofollow)
    try {
      const stat = fstatSync(fd)
      if (!stat.isFile() || stat.size > 65536 || (stat.mode & 0o077) || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) throw Error('redo record unavailable')
      const value = JSON.parse(readFileSync(fd, 'utf8'))
      const source = value?.original
      if (value?.version !== 1 || value.operationId !== operationId || !isDeepStrictEqual(value.identity, originalRedoIdentity(operationId))
        || !principalValid(value.principal) || !scopeValid(value.scope) || !digest(value.recoveryId) || !digest(value.confirmationDigest)
        || value.acknowledged !== true || !['prepared', 'dispatching', 'claiming', 'completed'].includes(value.state)
        || !validId(source?.botId) || !validId(source.sessionId) || !validId(source.messageId) || !digest(source.messageHash)
        || !Number.isSafeInteger(source.turn) || source.turn < 0 || !Number.isSafeInteger(source.messageSeq) || source.messageSeq < 0) throw Error('redo record unavailable')
      return value
    } finally { closeSync(fd) }
  }
  function confirm(row, generation) {
    const path = pathFor(row.operationId), fd = openSync(path, constants.O_RDONLY | nofollow)
    try {
      const before = fstatSync(fd)
      if (!before.isFile() || before.size > 65536 || !isDeepStrictEqual(JSON.parse(readFileSync(fd, 'utf8')), row)) throw Error('redo snapshot unavailable')
      fsyncSync(fd); dirSync(root)
      const after = fstatSync(fd), current = lstatSync(path)
      sameLease(generation)
      if (!current.isFile() || current.isSymbolicLink() || before.dev !== current.dev || before.ino !== current.ino
        || before.size !== after.size || before.mtimeMs !== after.mtimeMs || !isDeepStrictEqual(read(row.operationId), row)) throw Error('redo snapshot changed')
    } finally { closeSync(fd) }
  }
  function write(row, generation) {
    sameLease(generation)
    const dest = pathFor(row.operationId), temp = join(root, `.pending-${randomUUID()}`), data = JSON.stringify(row)
    let fd
    try {
      fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | nofollow, 0o600)
      writeFileSync(fd, data); fsyncSync(fd); closeSync(fd); fd = undefined
      sameLease(generation); renameSync(temp, dest); dirSync(root)
      const saved = read(row.operationId)
      sameLease(generation)
      if (!isDeepStrictEqual(saved, row)) throw Error('redo snapshot changed')
    } finally {
      if (fd !== undefined) closeSync(fd)
      try { unlinkSync(temp) } catch (error) { if (error.code !== 'ENOENT') throw error }
    }
  }
  function all() {
    const entries = readdirSync(root)
    if (entries.length > 20000) throw Error('redo journal too large')
    let total = 0
    return entries.filter(name => name.endsWith('.json')).map(name => {
      const operationId = name.slice(0, -5)
      const stat = lstatSync(pathFor(operationId))
      total += stat.size
      if (total > 8 * 1024 * 1024) throw Error('redo journal too large')
      return read(operationId)
    })
  }
  function original(proof, recoveryId, scope, confirmationDigest) {
    if (!digest(recoveryId) || !digest(confirmationDigest) || !scopeValid(scope) || userRedoConfirmation(scope, recoveryId, proof) !== confirmationDigest) throw Error('redo confirmation does not match')
    return { botId:proof.botId, sessionId:proof.sessionId, turn:proof.turn, messageSeq:proof.messageSeq,
      messageId:proof.message.id, messageHash:hash(proof.message) }
  }
  function checkAccess(row, generation) {
    sameLease(generation)
    if (authorize(copy(row.scope), row.recoveryId, copy(row.principal)) !== true) throw Error('redo unavailable')
  }
  async function prepare({ operationId, recoveryId, scope, principal, acknowledged, confirmationDigest }) {
    const identity = originalRedoIdentity(operationId)
    if (!principalValid(principal)
      || acknowledged !== true || !scopeValid(scope) || !digest(recoveryId) || !digest(confirmationDigest)) throw Error('redo confirmation required')
    scope = copy(scope); principal = copy(principal)
    if (busy.has(operationId)) throw Error('redo outcome unknown')
    busy.add(operationId)
    try {
      const generation = lease(); directory(generation)
      if (authorize(copy(scope), recoveryId, copy(principal)) !== true) throw Error('redo unavailable')
      const proof = await proveOriginal(copy(scope), recoveryId)
      const source = original(proof, recoveryId, scope, confirmationDigest)
      sameLease(generation)
      if (authorize(copy(scope), recoveryId, copy(principal)) !== true || proof.isCurrent() !== true) throw Error('redo proof changed')
      const rows = all(), existing = rows.find(row => row.operationId === operationId)
      if (existing) {
        if (existing.recoveryId !== recoveryId || !isDeepStrictEqual(existing.scope, scope) || !isDeepStrictEqual(existing.principal, principal) || existing.confirmationDigest !== confirmationDigest
          || !isDeepStrictEqual(existing.original, source)) throw Error('redo identity conflict')
        try { confirm(existing, generation); checkAccess(existing, generation); if (proof.isCurrent() !== true) throw Error('redo proof changed') }
        catch { throw Error('redo preparation outcome unknown') }
        return copy(existing)
      }
      if (rows.some(row => row.recoveryId === recoveryId)) throw Error('redo already exists; inspect outcome')
      const row = { version:1, operationId, recoveryId, scope:copy(scope), principal:copy(principal), identity, original:source, confirmationDigest,
        acknowledged:true, state:'prepared', createdAt:Date.now() }
      try { write(row, generation); checkAccess(row, generation); if (proof.isCurrent() !== true) throw Error('redo proof changed') }
      catch { throw Error('redo preparation outcome unknown') }
      return copy(row)
    } finally { busy.delete(operationId) }
  }
  async function beginDispatch(operationId, principal) {
    if (busy.has(operationId)) throw Error('redo outcome unknown')
    busy.add(operationId)
    try {
      const generation = lease(); directory(generation)
      const row = read(operationId); checkAccess(row, generation)
      if (!isDeepStrictEqual(row.principal, principal)) throw Error('redo unavailable')
      if (row.state !== 'prepared') return { state:'unknown', operationId }
      const proof = await proveOriginal(copy(row.scope), row.recoveryId)
      const source = original(proof, row.recoveryId, row.scope, row.confirmationDigest)
      checkAccess(row, generation)
      if (!isDeepStrictEqual(source, row.original) || proof.isCurrent() !== true || !isDeepStrictEqual(read(operationId), row)) throw Error('redo proof changed')
      if (validateBinding(copy(row), undefined) !== true) throw Error('redo binding unavailable')
      checkAccess(row, generation); sameLease(generation)
      const next = { ...row, state:'dispatching' }
      try { write(next, generation); checkAccess(next, generation); if (proof.isCurrent() !== true || validateBinding(copy(next), undefined) !== true) throw Error('redo binding changed'); checkAccess(next, generation); sameLease(generation); if (proof.isCurrent() !== true) throw Error('redo proof changed') }
      catch { throw Error('redo dispatch outcome unknown') }
      return { state:'dispatching', operationId, perform:true, binding:copy(next) }
    } finally { busy.delete(operationId) }
  }
  function inspectDispatchSync(binding, principal) {
    const operationId = binding?.operationId
    if (!uuid(operationId) || busy.has(operationId)) throw Error('redo outcome unknown')
    busy.add(operationId)
    try {
      const generation = lease(); directory(generation)
      const row = read(operationId); checkAccess(row, generation)
      if (row.state !== 'dispatching' || !isDeepStrictEqual(row, binding) || !isDeepStrictEqual(row.principal, principal)
        || validateBinding(copy(row), undefined) !== true) throw Error('redo dispatch unavailable')
      try { confirm(row, generation); checkAccess(row, generation); if (validateBinding(copy(row), undefined) !== true) throw Error('redo binding changed'); checkAccess(row, generation); sameLease(generation) }
      catch { throw Error('redo dispatch outcome unknown') }
      return copy(row)
    } finally { busy.delete(operationId) }
  }
  function markClaimingSync(binding, turn, principal) {
    const operationId = binding?.operationId
    if (!uuid(operationId) || busy.has(operationId)) throw Error('redo outcome unknown')
    busy.add(operationId)
    try {
      const generation = lease(); directory(generation)
      const row = read(operationId); checkAccess(row, generation)
      if (row.state !== 'dispatching' || !isDeepStrictEqual(row, binding) || !isDeepStrictEqual(row.principal, principal) || !Number.isSafeInteger(turn?.turn) || turn.turn < 0
        || !Number.isSafeInteger(turn?.turnStartSeq) || turn.turnStartSeq < 0 || validateBinding(copy(row), turn) !== true) throw Error('redo claim unavailable')
      checkAccess(row, generation); sameLease(generation)
      const next = { ...row, state:'claiming', turn:{ turn:turn.turn, turnStartSeq:turn.turnStartSeq } }
      try { write(next, generation); checkAccess(next, generation); if (validateBinding(copy(next), turn) !== true) throw Error('redo binding changed'); checkAccess(next, generation); sameLease(generation) }
      catch { throw Error('redo claim outcome unknown') }
      return copy(next)
    } finally { busy.delete(operationId) }
  }
  async function recordResult(operationId, principal) {
    if (!uuid(operationId) || busy.has(operationId) || typeof verifyResult !== 'function') throw Error('redo result unavailable')
    busy.add(operationId)
    try {
      const generation = lease(); directory(generation)
      const row = read(operationId); checkAccess(row, generation)
      if (!isDeepStrictEqual(row.principal, principal) || !['claiming', 'completed'].includes(row.state)) throw Error('redo result unavailable')
      const proof = await verifyResult(copy(row))
      const ref = proof?.resultRef
      if (typeof proof?.isCurrent !== 'function' || proof.isCurrent() !== true || proof.durability !== 'target-writer-v1'
        || proof.sessionId !== row.original.sessionId || proof.messageId !== row.identity.messageId || proof.admissionId !== row.identity.admissionId
        || !isDeepStrictEqual(proof.turn, row.turn) || !Number.isSafeInteger(proof.throughSeq) || proof.throughSeq <= row.turn.turnStartSeq
        || !digest(proof.resultDigest) || ref?.kind !== 'session-events' || ref.sessionId !== row.original.sessionId
        || !Number.isSafeInteger(ref.firstSeq) || !Number.isSafeInteger(ref.lastSeq) || ref.firstSeq <= row.turn.turnStartSeq
        || ref.lastSeq < ref.firstSeq || ref.lastSeq >= proof.throughSeq || Object.keys(ref).some(key => !['kind', 'sessionId', 'firstSeq', 'lastSeq'].includes(key))) throw Error('redo result unverified')
      checkAccess(row, generation)
      if (proof.isCurrent() !== true || !isDeepStrictEqual(read(operationId), row)) throw Error('redo result changed')
      const result = { digest:proof.resultDigest, ref:copy(ref), throughSeq:proof.throughSeq }
      if (row.state === 'completed' && (!isDeepStrictEqual(row.result?.ref, result.ref) || row.result?.digest !== result.digest
        || !Number.isSafeInteger(row.result?.throughSeq) || result.throughSeq < row.result.throughSeq)) throw Error('redo result conflict')
      const next = row.state === 'completed' ? row : { ...row, state:'completed', result }
      try {
        if (row.state === 'completed') confirm(row, generation)
        else write(next, generation)
        checkAccess(next, generation)
        if (proof.isCurrent() !== true) throw Error('redo result changed')
      } catch { throw Error('redo result outcome unknown') }
      return copy(next)
    } finally { busy.delete(operationId) }
  }
  return { prepare, beginDispatch, inspectDispatchSync, markClaimingSync, recordResult }
}
