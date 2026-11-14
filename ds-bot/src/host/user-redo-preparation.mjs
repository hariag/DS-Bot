import { boardList } from './board-query.js'
import { createUserRedoOriginalProof } from './user-redo-proof.mjs'
import { createOriginalRedoJournal } from './original-redo-journal.mjs'
import { userRedoConfirmation } from './user-redo-journal.mjs'
import { createHash } from 'node:crypto'

const user = Object.freeze({ kind:'user', id:'user' })
const warning = 'This is a candidate from the persisted log; its original sender is not authenticated. A future attempt may repeat effects that already happened. The original work remains unresolved. Execution is disabled; this confirmation does not authorize later execution.'
const presented = digest => createHash('sha256').update(JSON.stringify(['ds-bot:redo-preview:v1', warning, digest])).digest('hex')

// Called only after the authenticated owner board route has validated scope.
// This prepares a durable request; it does not create or wake an Agent.
export function createUserRedoPreparation(rt) {
  const proveOriginal = createUserRedoOriginalProof(rt)
  const authorize = (scope, _recoveryId, principal) => {
    if (principal?.kind !== 'user' || principal.id !== 'user') return false
    try { boardList({ scope, principal:user, rooms:rt.state.rooms, bots:rt.state.bots }); return true }
    catch { return false }
  }
  const journal = createOriginalRedoJournal(rt, { authorize, proveOriginal, validateBinding:() => false })
  async function preview({ scope, recoveryId }) {
    rt.requireHomeLock()
    if (!authorize(scope, recoveryId, user)) throw Error('redo unavailable')
    const proof = await proveOriginal(scope, recoveryId)
    if (!proof || !authorize(scope, recoveryId, user) || proof.isCurrent() !== true) throw Error('redo unavailable')
    const confirmationDigest = presented(userRedoConfirmation(scope, recoveryId, proof))
    return { scope:structuredClone(scope), recoveryId, botId:proof.botId, sessionId:proof.sessionId,
      originalTurn:proof.turn, originalSeq:proof.messageSeq, messageId:proof.message.id,
      source:{ kind:proof.message.source.kind, role:proof.message.source.role, exchangeId:proof.message.source.exchangeId },
      content:structuredClone(proof.message.content), confirmationDigest, warning, execution:'disabled' }
  }
  async function confirm({ scope, recoveryId, operationId, confirmationDigest, acknowledged }) {
    if (!authorize(scope, recoveryId, user)) throw Error('redo unavailable')
    const proof = await proveOriginal(scope, recoveryId)
    if (!proof || proof.isCurrent() !== true || !authorize(scope, recoveryId, user)) throw Error('redo unavailable')
    const originalDigest = userRedoConfirmation(scope, recoveryId, proof)
    if (confirmationDigest !== presented(originalDigest)) throw Error('redo confirmation changed')
    const row = await journal.prepare({ scope, recoveryId, operationId, confirmationDigest:originalDigest, acknowledged, principal:user, previewOnly:true })
    return { operationId:row.operationId, status:'prepared', execution:'disabled' }
  }
  return Object.freeze({ preview, confirm })
}
