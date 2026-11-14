import { createHash, randomUUID } from 'node:crypto'
import { constants, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { isolatedRedoConfirmation, isolatedRedoTargetValid, userRedoConfirmation, userRedoIdentity } from './user-redo-journal.mjs'

const nofollow = constants.O_NOFOLLOW ?? 0
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !Array.from(value).some(char => char.charCodeAt(0) < 32)
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
export function createOriginalRedoJournal(rt, options = {}) { return createRedoJournal(rt, options, false) }
export function createIsolatedRedoJournal(rt, options = {}) { return createRedoJournal(rt, options, true) }

function createRedoJournal(rt, { authorize, proveOriginal, validateBinding, verifyResult } = {}, isolated) {
  if (typeof rt?.home !== 'string' || typeof rt.statePath !== 'string' || !rt.state || typeof rt.save !== 'function'
    || typeof rt.requireHomeLock !== 'function' || typeof rt.homeLockVersion !== 'function'
    || typeof authorize !== 'function' || typeof proveOriginal !== 'function'
    || typeof validateBinding !== 'function') throw Error('redo authority unavailable')
  // Both modes share the recovery witness and operation busy set, so one held
  // record cannot be dispatched once by each mode. Private files and phase
  // markers are otherwise separate and cannot be mistaken for one another.
  const namespace = isolated ? 'isolated-redo-v1' : 'original-redo-v1'
  const root = join(rt.home, namespace), marker = join(rt.home, `.${namespace}.identity`), innerMarker = join(root, '.identity'), busy = rt.originalRedoBusy ??= new Set()
  const identityFor = isolated ? userRedoIdentity : originalRedoIdentity
  const targetValid = isolatedRedoTargetValid
  let directoryIdentity
  function readMarker(path, sync = false) {
    const fd = openSync(path, constants.O_RDONLY | nofollow)
    try {
      const stat = fstatSync(fd)
      if (!stat.isFile() || stat.size > 1024 || (stat.mode & 0o077) || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) throw Error('redo identity unavailable')
      const value = JSON.parse(readFileSync(fd, 'utf8'))
      if (sync) fsyncSync(fd)
      return value
    } finally { closeSync(fd) }
  }
  const lease = () => { rt.requireHomeLock(); const v = rt.homeLockVersion(); if (v == null) throw Error('redo lease unavailable'); return v }
  const sameLease = generation => {
    if (lease() !== generation) throw Error('redo lease changed')
    if (directoryIdentity) {
      const current = lstatSync(root), home = lstatSync(rt.home)
      if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== directoryIdentity.dev || current.ino !== directoryIdentity.ino
        || (current.mode & 0o077) || (typeof process.getuid === 'function' && current.uid !== process.getuid())
        || !home.isDirectory() || home.isSymbolicLink() || home.dev !== directoryIdentity.homeDev || home.ino !== directoryIdentity.homeIno
        || !isDeepStrictEqual(readMarker(marker), directoryIdentity) || !isDeepStrictEqual(readMarker(innerMarker), { token:directoryIdentity.token })) throw Error('redo directory changed')
    }
  }
  const dirSync = path => { const fd = openSync(path, constants.O_RDONLY | nofollow); try { fsyncSync(fd) } finally { closeSync(fd) } }
  function directory(generation) {
    sameLease(generation)
    try { mkdirSync(root, { mode:0o700 }) } catch (error) { if (error.code !== 'EEXIST') throw error }
    const stat = lstatSync(root), home = lstatSync(rt.home)
    if (!stat.isDirectory() || stat.isSymbolicLink() || (typeof process.getuid === 'function' && stat.uid !== process.getuid()) || (stat.mode & 0o077)) throw Error('redo directory unavailable')
    if (!home.isDirectory() || home.isSymbolicLink()) throw Error('redo directory unavailable')
    let identity
    try {
      identity = readMarker(marker, true)
    } catch (error) {
      if (error.code !== 'ENOENT' || readdirSync(root).length !== 0) throw Error('redo identity unavailable')
      identity = { dev:stat.dev, ino:stat.ino, homeDev:home.dev, homeIno:home.ino, token:randomUUID() }
      const inside = openSync(innerMarker, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | nofollow, 0o600)
      try { writeFileSync(inside, JSON.stringify({ token:identity.token })); fsyncSync(inside) } finally { closeSync(inside) }
      dirSync(root)
      const created = openSync(marker, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | nofollow, 0o600)
      try { writeFileSync(created, JSON.stringify(identity)); fsyncSync(created) } finally { closeSync(created) }
      dirSync(rt.home)
    }
    if (!uuid(identity?.token) || identity.dev !== stat.dev || identity.ino !== stat.ino || identity.homeDev !== home.dev || identity.homeIno !== home.ino
      || !isDeepStrictEqual(readMarker(innerMarker, true), { token:identity.token })) throw Error('redo identity unavailable')
    dirSync(root)
    dirSync(rt.home)
    const after = lstatSync(root)
    if (!after.isDirectory() || after.isSymbolicLink() || after.dev !== stat.dev || after.ino !== stat.ino) throw Error('redo directory changed')
    if (directoryIdentity && !isDeepStrictEqual(directoryIdentity, identity)) throw Error('redo directory changed')
    directoryIdentity = identity
    sameLease(generation)
  }
  function pathFor(operationId) { if (!uuid(operationId)) throw Error('invalid redo operation'); return join(root, `${operationId}.json`) }
  function witnessFor(row) {
    return { version:1, recoveryId:row.recoveryId, operationId:row.operationId,
      bindingHash:hash([row.recoveryId, row.operationId, row.scope, row.principal, row.identity, row.original, row.confirmationDigest, ...(isolated ? [row.target] : [])]) }
  }
  function witnessTable() {
    const table = rt.state.originalRedoWitness
    if (table === undefined) return {}
    if (!table || typeof table !== 'object' || Array.isArray(table)) throw Error('redo witness unavailable')
    const operations = new Set()
    for (const [key, witness] of Object.entries(table)) {
      if (!digest(key) || witness?.recoveryId !== key || !uuid(witness.operationId) || !digest(witness.bindingHash)
        || operations.has(witness.operationId)) throw Error('redo witness conflict')
      operations.add(witness.operationId)
    }
    return table
  }
  function confirmWitnessTable(generation) {
    sameLease(generation)
    const expected = copy(witnessTable()), fd = openSync(rt.statePath, constants.O_RDONLY | nofollow)
    try {
      const before = fstatSync(fd)
      if (!before.isFile() || before.size > 64 * 1024 * 1024) throw Error('redo witness unavailable')
      const disk = JSON.parse(readFileSync(fd, 'utf8'))
      if (!isDeepStrictEqual(disk.originalRedoWitness ?? {}, expected)) throw Error('redo witness unavailable')
      fsyncSync(fd); dirSync(rt.home)
      const after = fstatSync(fd), current = lstatSync(rt.statePath)
      sameLease(generation)
      if (!current.isFile() || current.isSymbolicLink() || before.dev !== current.dev || before.ino !== current.ino
        || before.size !== after.size || before.mtimeMs !== after.mtimeMs
        || !isDeepStrictEqual(witnessTable(), expected)) throw Error('redo witness changed')
    } finally { closeSync(fd) }
    return expected
  }
  function confirmWitness(row, generation) {
    if (!isDeepStrictEqual(confirmWitnessTable(generation)[row.recoveryId], witnessFor(row))) throw Error('redo witness unavailable')
  }
  function phasePath(operationId, phase) {
    if (!uuid(operationId) || !['dispatching', 'claiming', 'completed'].includes(phase)) throw Error('invalid redo phase')
    return join(rt.home, `.${isolated ? 'isolated' : 'original'}-redo-${operationId}-${phase}`)
  }
  function phaseEvidence(row, phase, turn) {
    return { version:1, operationId:row.operationId, recoveryId:row.recoveryId, bindingHash:witnessFor(row).bindingHash,
      phase, ...(turn ? { turn:copy(turn) } : {}), ...(phase === 'completed' ? { result:copy(row.result) } : {}) }
  }
  function readPhase(row, phase, generation) {
    let value
    try { value = readMarker(phasePath(row.operationId, phase), true) }
    catch (error) { if (error.code === 'ENOENT') return undefined; throw error }
    dirSync(rt.home); sameLease(generation)
    return value
  }
  function markPhase(row, phase, generation, turn) {
    const value = phaseEvidence(row, phase, turn)
    const fd = openSync(phasePath(row.operationId, phase), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | nofollow, 0o600)
    try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd) } finally { closeSync(fd) }
    dirSync(rt.home); sameLease(generation)
    if (!isDeepStrictEqual(readPhase(row, phase, generation), value)) throw Error('redo phase unavailable')
  }
  function confirmPhase(row, generation) {
    const dispatched = readPhase(row, 'dispatching', generation), claimed = readPhase(row, 'claiming', generation), completed = readPhase(row, 'completed', generation)
    if (row.state === 'prepared') {
      if (dispatched || claimed || completed) throw Error('redo phase outcome unknown')
    } else if (!isDeepStrictEqual(dispatched, phaseEvidence(row, 'dispatching'))
      || (row.state === 'dispatching' ? claimed !== undefined
        : !isDeepStrictEqual(claimed, phaseEvidence(row, 'claiming', row.turn)))
      || (row.state === 'completed' ? !isDeepStrictEqual(completed, phaseEvidence(row, 'completed')) : completed !== undefined)) throw Error('redo phase outcome unknown')
  }
  function recoveryMarker(recoveryId) { if (!digest(recoveryId)) throw Error('invalid recovery'); return join(root, `.recovery-${recoveryId}`) }
  function readRecovery(recoveryId, generation) {
    let data
    try { data = readMarker(recoveryMarker(recoveryId), true) }
    catch (error) { if (error.code === 'ENOENT') return undefined; throw error }
    if (data?.recoveryId !== recoveryId || !uuid(data.operationId) || Object.keys(data).some(key => !['recoveryId', 'operationId'].includes(key))) throw Error('redo recovery marker unavailable')
    dirSync(root); sameLease(generation)
    return data
  }
  function reserveRecovery(recoveryId, operationId, generation) {
    const fd = openSync(recoveryMarker(recoveryId), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | nofollow, 0o600)
    try { writeFileSync(fd, JSON.stringify({ recoveryId, operationId })); fsyncSync(fd) } finally { closeSync(fd) }
    dirSync(root); sameLease(generation)
    if (!isDeepStrictEqual(readRecovery(recoveryId, generation), { recoveryId, operationId })) throw Error('redo recovery marker unavailable')
  }
  function read(operationId) {
    const fd = openSync(pathFor(operationId), constants.O_RDONLY | nofollow)
    try {
      const stat = fstatSync(fd)
      if (!stat.isFile() || stat.size > 65536 || (stat.mode & 0o077) || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) throw Error('redo record unavailable')
      const value = JSON.parse(readFileSync(fd, 'utf8'))
      const source = value?.original
      if (value?.version !== 1 || value.operationId !== operationId || !isDeepStrictEqual(value.identity, identityFor(operationId))
        || (isolated ? !targetValid(value.target) : value.target !== undefined)
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
  function write(row, generation, previous) {
    const checkPrior = () => {
      if (previous === null) {
        try { lstatSync(pathFor(row.operationId)); throw Error('redo snapshot already exists') }
        catch (error) { if (error.code !== 'ENOENT') throw error }
      } else if (!isDeepStrictEqual(read(row.operationId), previous)) throw Error('redo snapshot changed')
    }
    sameLease(generation)
    checkPrior()
    const dest = pathFor(row.operationId), temp = join(root, `.pending-${randomUUID()}`), data = JSON.stringify(row)
    let fd, failure
    try {
      fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | nofollow, 0o600)
      writeFileSync(fd, data); fsyncSync(fd); closeSync(fd); fd = undefined
      sameLease(generation); checkPrior(); renameSync(temp, dest); dirSync(root)
      const saved = read(row.operationId)
      sameLease(generation)
      if (!isDeepStrictEqual(saved, row)) throw Error('redo snapshot changed')
    } catch (error) { failure = error } finally {
      if (fd !== undefined) closeSync(fd)
    }
    try { unlinkSync(temp) } catch (error) { if (error.code !== 'ENOENT' && !failure) failure = error }
    if (failure) throw failure
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
  function original(proof, recoveryId, scope, confirmationDigest, principal, operationId, target) {
    const expected = isolated ? isolatedRedoConfirmation(scope, recoveryId, proof, { principal, operationId, target })
      : userRedoConfirmation(scope, recoveryId, proof)
    if (!digest(recoveryId) || !digest(confirmationDigest) || !scopeValid(scope) || expected !== confirmationDigest) throw Error('redo confirmation does not match')
    return { botId:proof.botId, sessionId:proof.sessionId, turn:proof.turn, messageSeq:proof.messageSeq,
      messageId:proof.message.id, messageHash:hash(proof.message) }
  }
  function checkAccess(row, generation) {
    sameLease(generation)
    if (authorize(copy(row.scope), row.recoveryId, copy(row.principal)) !== true) throw Error('redo unavailable')
    if (!isDeepStrictEqual(readRecovery(row.recoveryId, generation), { recoveryId:row.recoveryId, operationId:row.operationId })) throw Error('redo recovery marker unavailable')
    confirmWitness(row, generation)
  }
  async function prepare({ operationId, recoveryId, scope, principal, acknowledged, confirmationDigest, target }) {
    const identity = identityFor(operationId)
    if (!principalValid(principal)
      || acknowledged !== true || !scopeValid(scope) || !digest(recoveryId) || !digest(confirmationDigest)
      || (isolated ? !targetValid(target) : target !== undefined)) throw Error('redo confirmation required')
    scope = copy(scope); principal = copy(principal); target = copy(target)
    if (busy.has(operationId)) throw Error('redo outcome unknown')
    busy.add(operationId)
    const previous = rt.originalRedoPrepareTail ?? Promise.resolve(), release = Promise.withResolvers()
    rt.originalRedoPrepareTail = release.promise
    try {
      await previous
      const generation = lease(); directory(generation)
      if (authorize(copy(scope), recoveryId, copy(principal)) !== true) throw Error('redo unavailable')
      const proof = await proveOriginal(copy(scope), recoveryId)
      const source = original(proof, recoveryId, scope, confirmationDigest, principal, operationId, target)
      sameLease(generation)
      if (authorize(copy(scope), recoveryId, copy(principal)) !== true || proof.isCurrent() !== true) throw Error('redo proof changed')
      const rows = all(), existing = rows.find(row => row.operationId === operationId), reserved = readRecovery(recoveryId, generation)
      const witnesses = confirmWitnessTable(generation), witness = witnesses[recoveryId]
      if (Object.values(witnesses).some(item => item.operationId === operationId && item.recoveryId !== recoveryId)) throw Error('redo operation identity conflict')
      if (witness && witness.operationId !== operationId) throw Error('redo already exists; inspect outcome')
      if (!!witness !== !!existing || !!witness !== !!reserved) throw Error('redo preparation outcome unknown')
      if (reserved && (!existing || reserved.operationId !== operationId)) throw Error('redo already exists; inspect outcome')
      if (existing) {
        if (!reserved) throw Error('redo preparation outcome unknown')
        if (existing.recoveryId !== recoveryId || !isDeepStrictEqual(existing.scope, scope) || !isDeepStrictEqual(existing.principal, principal) || existing.confirmationDigest !== confirmationDigest
          || !isDeepStrictEqual(existing.original, source) || !isDeepStrictEqual(existing.target, target)) throw Error('redo identity conflict')
        try { confirm(existing, generation); checkAccess(existing, generation); if (proof.isCurrent() !== true) throw Error('redo proof changed'); confirm(existing, generation); confirmPhase(existing, generation); confirmWitness(existing, generation) }
        catch { throw Error('redo preparation outcome unknown') }
        return copy(existing)
      }
      if (rows.some(row => row.recoveryId === recoveryId)) throw Error('redo already exists; inspect outcome')
      const row = { version:1, operationId, recoveryId, scope:copy(scope), principal:copy(principal), identity, original:source, confirmationDigest,
        ...(isolated ? { target:copy(target) } : {}), acknowledged:true, state:'prepared', createdAt:Date.now() }
      try {
        rt.state.originalRedoWitness = { ...witnessTable(), [recoveryId]:witnessFor(row) }
        await rt.save({ required:true })
        confirmWitness(row, generation)
        if (authorize(copy(scope), recoveryId, copy(principal)) !== true || proof.isCurrent() !== true) throw Error('redo proof changed')
        reserveRecovery(recoveryId, operationId, generation); write(row, generation, null); checkAccess(row, generation)
        if (proof.isCurrent() !== true) throw Error('redo proof changed')
        confirm(row, generation); confirmPhase(row, generation); confirmWitness(row, generation)
      }
      catch { throw Error('redo preparation outcome unknown') }
      return copy(row)
    } finally { busy.delete(operationId); release.resolve(); if (rt.originalRedoPrepareTail === release.promise) delete rt.originalRedoPrepareTail }
  }
  async function beginDispatch(operationId, principal) {
    if (busy.has(operationId)) throw Error('redo outcome unknown')
    busy.add(operationId)
    try {
      const generation = lease(); directory(generation)
      const row = read(operationId); checkAccess(row, generation)
      if (!isDeepStrictEqual(row.principal, principal)) throw Error('redo unavailable')
      confirmPhase(row, generation)
      if (row.state !== 'prepared') return { state:'unknown', operationId }
      const proof = await proveOriginal(copy(row.scope), row.recoveryId)
      const source = original(proof, row.recoveryId, row.scope, row.confirmationDigest, row.principal, row.operationId, row.target)
      checkAccess(row, generation)
      if (!isDeepStrictEqual(source, row.original) || proof.isCurrent() !== true || !isDeepStrictEqual(read(operationId), row)) throw Error('redo proof changed')
      if (validateBinding(copy(row), undefined) !== true) throw Error('redo binding unavailable')
      checkAccess(row, generation); sameLease(generation)
      const next = { ...row, state:'dispatching' }
      try { markPhase(row, 'dispatching', generation); write(next, generation, row); checkAccess(next, generation); confirmPhase(next, generation); if (proof.isCurrent() !== true || validateBinding(copy(next), undefined) !== true) throw Error('redo binding changed'); checkAccess(next, generation); if (proof.isCurrent() !== true) throw Error('redo proof changed'); confirm(next, generation); confirmPhase(next, generation); confirmWitness(next, generation) }
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
      confirmPhase(row, generation)
      if (row.state !== 'dispatching' || !isDeepStrictEqual(row, binding) || !isDeepStrictEqual(row.principal, principal)
        || validateBinding(copy(row), undefined) !== true) throw Error('redo dispatch unavailable')
      try { confirm(row, generation); checkAccess(row, generation); confirmPhase(row, generation); if (validateBinding(copy(row), undefined) !== true) throw Error('redo binding changed'); checkAccess(row, generation); confirm(row, generation); confirmPhase(row, generation); confirmWitness(row, generation) }
      catch { throw Error('redo dispatch outcome unknown') }
      return copy(row)
    } finally { busy.delete(operationId) }
  }
  function markClaimingSync(binding, turn, principal) {
    const operationId = binding?.operationId
    if (!uuid(operationId) || busy.has(operationId)) throw Error('redo outcome unknown')
    if (!turn || Object.keys(turn).some(key => !['turn', 'turnStartSeq'].includes(key))
      || !Number.isSafeInteger(turn.turn) || turn.turn < 0 || !Number.isSafeInteger(turn.turnStartSeq) || turn.turnStartSeq < 0) throw Error('redo claim unavailable')
    const boundary = Object.freeze({ turn:turn.turn, turnStartSeq:turn.turnStartSeq })
    busy.add(operationId)
    try {
      const generation = lease(); directory(generation)
      const row = read(operationId); checkAccess(row, generation)
      confirmPhase(row, generation)
      if (row.state !== 'dispatching' || !isDeepStrictEqual(row, binding) || !isDeepStrictEqual(row.principal, principal)
        || validateBinding(copy(row), boundary) !== true) throw Error('redo claim unavailable')
      checkAccess(row, generation); sameLease(generation)
      const next = { ...row, state:'claiming', turn:boundary }
      try { markPhase(row, 'claiming', generation, boundary); write(next, generation, row); checkAccess(next, generation); confirmPhase(next, generation); if (validateBinding(copy(next), boundary) !== true) throw Error('redo binding changed'); checkAccess(next, generation); confirm(next, generation); confirmPhase(next, generation); confirmWitness(next, generation) }
      catch { throw Error('redo claim outcome unknown') }
      return copy(next)
    } finally { busy.delete(operationId) }
  }
  // Read and fsync the exact claiming state before a model request. A caller
  // must still perform its own non-reentrant Agent/Session identity checks.
  function inspectClaimingSync(binding, principal) {
    const operationId = binding?.operationId
    if (!uuid(operationId) || busy.has(operationId)) throw Error('redo outcome unknown')
    busy.add(operationId)
    try {
      const generation = lease(); directory(generation)
      const row = read(operationId); checkAccess(row, generation); confirmPhase(row, generation)
      if (row.state !== 'claiming' || !isDeepStrictEqual(row, binding) || !isDeepStrictEqual(row.principal, principal)
        || authorize(copy(row.scope), row.recoveryId, copy(principal)) !== true
        || validateBinding(copy(row), copy(row.turn)) !== true) throw Error('redo claim unavailable')
      confirm(row, generation); checkAccess(row, generation); confirmPhase(row, generation)
      if (authorize(copy(row.scope), row.recoveryId, copy(principal)) !== true
        || validateBinding(copy(row), copy(row.turn)) !== true) throw Error('redo claim changed')
      checkAccess(row, generation); confirm(row, generation); confirmPhase(row, generation); confirmWitness(row, generation)
      return copy(row)
    } finally { busy.delete(operationId) }
  }
  async function recordResult(operationId, principal) {
    if (!uuid(operationId) || busy.has(operationId) || typeof verifyResult !== 'function') throw Error('redo result unavailable')
    busy.add(operationId)
    try {
      const generation = lease(); directory(generation)
      const row = read(operationId); checkAccess(row, generation)
      confirmPhase(row, generation)
      if (!isDeepStrictEqual(row.principal, principal) || !['claiming', 'completed'].includes(row.state)) throw Error('redo result unavailable')
      const proof = await verifyResult(copy(row))
      const evidence = { durability:proof?.durability, sessionId:proof?.sessionId, messageId:proof?.messageId, admissionId:proof?.admissionId,
        turn:copy(proof?.turn), throughSeq:proof?.throughSeq, resultDigest:proof?.resultDigest, resultRef:copy(proof?.resultRef) }
      const ref = evidence.resultRef
      if (typeof proof?.isCurrent !== 'function' || proof.isCurrent() !== true || evidence.durability !== 'target-writer-v1'
        || evidence.sessionId !== (isolated ? row.identity.sessionId : row.original.sessionId) || evidence.messageId !== row.identity.messageId || evidence.admissionId !== row.identity.admissionId
        || !isDeepStrictEqual(evidence.turn, row.turn) || !Number.isSafeInteger(evidence.throughSeq) || evidence.throughSeq <= row.turn.turnStartSeq
        || !digest(evidence.resultDigest) || ref?.kind !== 'session-events' || ref.sessionId !== (isolated ? row.identity.sessionId : row.original.sessionId)
        || !Number.isSafeInteger(ref.firstSeq) || !Number.isSafeInteger(ref.lastSeq) || ref.firstSeq <= row.turn.turnStartSeq
        || ref.lastSeq < ref.firstSeq || ref.lastSeq >= evidence.throughSeq || Object.keys(ref).some(key => !['kind', 'sessionId', 'firstSeq', 'lastSeq'].includes(key))) throw Error('redo result unverified')
      checkAccess(row, generation)
      if (proof.isCurrent() !== true || !isDeepStrictEqual(read(operationId), row)) throw Error('redo result changed')
      const result = { digest:evidence.resultDigest, ref:copy(ref), throughSeq:evidence.throughSeq }
      if (row.state === 'completed' && (!isDeepStrictEqual(row.result?.ref, result.ref) || row.result?.digest !== result.digest
        || !Number.isSafeInteger(row.result?.throughSeq) || result.throughSeq < row.result.throughSeq)) throw Error('redo result conflict')
      const next = row.state === 'completed' ? row : { ...row, state:'completed', result }
      try {
        if (row.state === 'completed') confirm(row, generation)
        else { markPhase(next, 'completed', generation); write(next, generation, row) }
        checkAccess(next, generation)
        confirmPhase(next, generation)
        if (proof.isCurrent() !== true) throw Error('redo result changed')
        confirm(next, generation); confirmPhase(next, generation); confirmWitness(next, generation)
      } catch { throw Error('redo result outcome unknown') }
      return copy(next)
    } finally { busy.delete(operationId) }
  }
  return { prepare, beginDispatch, inspectDispatchSync, markClaimingSync, inspectClaimingSync, recordResult }
}
