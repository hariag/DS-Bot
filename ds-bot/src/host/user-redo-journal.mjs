// Experimental journal only: this module neither creates an Agent nor sends
// an input. A real Host must bind proof, authorization and isolated routing
// before exposing a redo action.
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { dirname } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

const id = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x1f]/.test(value)
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const clone = value => structuredClone(value)

export function userRedoIdentity(operationId) {
  if (typeof operationId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(operationId)) throw new Error('invalid redo operation')
  const token = digest(['ds-bot:user-redo:v1', operationId])
  return { operationId, sessionId:`redo-${token}`, messageId:`redo-input-${token}`, admissionId:`redo:${token}` }
}

function validateScope(scope) {
  if (!scope || !['room', 'personal'].includes(scope.kind) || !id(scope.id)
    || Object.keys(scope).some(key => !['kind', 'id'].includes(key))) throw new Error('invalid redo scope')
}

// Proof must describe the complete original input from the exact target writer
// and retain an isCurrent check; this helper never infers absence or retries.
function validateProof(proof, recoveryId) {
  const message = proof?.message
  if (proof?.complete !== true || proof.durability !== 'target-writer-v1' || proof.recoveryId !== recoveryId
    || typeof proof.isCurrent !== 'function' || proof.isCurrent() !== true
    || !id(proof.sessionId) || !id(message?.id) || message.role !== 'user' || !message.source || typeof message.source !== 'object'
    || Array.isArray(message.source) || !Number.isSafeInteger(proof.messageSeq) || proof.messageSeq < 0
    || !Number.isSafeInteger(proof.turn) || proof.turn < 0 || !Array.isArray(message.content) || !message.content.length
    || message.content.some(part => part?.type !== 'text' || typeof part.text !== 'string'
      || Object.keys(part).some(key => !['type', 'text'].includes(key)))
    || message.content.every(part => !part.text.trim())
    || Buffer.byteLength(JSON.stringify(message)) > 65536) throw new Error('original input cannot be verified')
}

export function createUserRedoJournal(rt, { authorize, proveOriginal } = {}) {
  if (!rt?.state || typeof rt.statePath !== 'string' || typeof rt.save !== 'function'
    || typeof rt.requireHomeLock !== 'function' || typeof rt.homeLockVersion !== 'function'
    || typeof authorize !== 'function' || typeof proveOriginal !== 'function') throw new Error('redo authority unavailable')
  const busy = rt.userRedoBusy ??= new Set()
  const lease = () => {
    rt.requireHomeLock()
    const generation = rt.homeLockVersion()
    if (generation === undefined || generation === null) throw new Error('redo lease unavailable')
    return generation
  }
  const table = () => {
    const rows = rt.state.userRedos
    if (rows !== undefined && (!rows || typeof rows !== 'object' || Array.isArray(rows))) throw new Error('redo journal unavailable')
    return rows ?? {}
  }
  async function durable(entry, generation) {
    const file = await open(rt.statePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      const before = await file.stat(), disk = JSON.parse(await file.readFile('utf8'))
      if (!before.isFile() || !isDeepStrictEqual(disk.userRedos?.[entry.operationId], entry)) throw new Error('redo snapshot unavailable')
      await file.sync()
      const dir = await open(dirname(rt.statePath), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      try { await dir.sync() } finally { await dir.close() }
      const afterFile = await file.stat(), after = await lstat(rt.statePath)
      if (!after.isFile() || after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino
        || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.size !== afterFile.size
        || before.mtimeMs !== afterFile.mtimeMs || lease() !== generation
        || !isDeepStrictEqual(table()[entry.operationId], entry)) throw new Error('redo snapshot changed')
    } finally { await file.close() }
  }
  async function prepare({ operationId, recoveryId, scope, acknowledged, confirmedMessageHash }) {
    const identity = userRedoIdentity(operationId)
    if (!hex(recoveryId) || !hex(confirmedMessageHash) || acknowledged !== true) throw new Error('redo confirmation required')
    validateScope(scope)
    if (busy.has(operationId)) throw new Error('redo outcome is unknown')
    busy.add(operationId)
    try {
      const generation = lease()
      if (authorize(scope, recoveryId) !== true) throw new Error('redo is unavailable')
      const previous = table()[operationId]
      if (previous) {
        if (previous.recoveryId !== recoveryId || !isDeepStrictEqual(previous.scope, scope)
          || !isDeepStrictEqual(previous.identity, identity)) throw new Error('redo operation identity conflict')
        const proof = await proveOriginal(scope, recoveryId)
        validateProof(proof, recoveryId)
        const original = { sessionId:proof.sessionId, messageSeq:proof.messageSeq, turn:proof.turn,
          messageId:proof.message.id, messageHash:digest(proof.message) }
        if (original.messageHash !== confirmedMessageHash || !isDeepStrictEqual(previous.original, original) || lease() !== generation
          || authorize(scope, recoveryId) !== true) throw new Error('redo proof changed')
        await durable(previous, generation)
        if (authorize(scope, recoveryId) !== true || proof.isCurrent() !== true) throw new Error('redo is unavailable')
        return clone(previous)
      }
      if (Object.values(table()).some(row => row?.recoveryId === recoveryId)) throw new Error('redo already exists; inspect its outcome')
      const proof = await proveOriginal(scope, recoveryId)
      validateProof(proof, recoveryId)
      if (lease() !== generation || authorize(scope, recoveryId) !== true || table()[operationId]
        || Object.values(table()).some(row => row?.recoveryId === recoveryId)) throw new Error('redo changed during verification')
      const original = { sessionId:proof.sessionId, messageSeq:proof.messageSeq, turn:proof.turn,
        messageId:proof.message.id, messageHash:digest(proof.message) }
      if (original.messageHash !== confirmedMessageHash) throw new Error('redo confirmation does not match the input')
      const entry = { operationId, identity, recoveryId, scope:clone(scope), original, state:'prepared', acknowledged:true, createdAt:Date.now() }
      rt.state.userRedos = { ...table(), [operationId]:entry }
      try {
        await rt.save({ required:true })
        await durable(entry, generation)
        if (authorize(scope, recoveryId) !== true || proof.isCurrent() !== true) throw new Error('redo proof changed')
      } catch { throw new Error('redo preparation outcome is unknown') }
      return clone(entry)
    } finally { busy.delete(operationId) }
  }
  return { prepare }
}
