import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { ISOLATED_REDO_WARNING, isolatedRedoTargetValid, userRedoIdentity } from './user-redo-journal.mjs'
import { isIssuedLegacyCandidateEvidence, LEGACY_CANDIDATE_WARNING } from './user-redo-legacy-candidate.mjs'

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x1f]/.test(value)
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)

// Candidate evidence certifies only a still-current physical prefix. The
// timestamp and source metadata do not authenticate the historical producer.
// The source summary never includes plaintext textSegments.
export function candidateRedoSource(scope, recoveryId, evidence) {
  const view = evidence?.view
  if (!isIssuedLegacyCandidateEvidence(evidence) || evidence?.kind !== 'unverified-candidate-evidence-v1' || !Object.isFrozen(evidence)
    || !Object.isFrozen(view) || !Object.isFrozen(view?.textSegments) || typeof evidence.isCurrent !== 'function'
    || evidence.isCurrent() !== true || !digest(recoveryId) || view?.recoveryId !== recoveryId
    || view.kind !== 'unverified-legacy-candidate' || view.producerVerified !== false || view.executeAllowed !== false
    || !isDeepStrictEqual(view.warning, LEGACY_CANDIDATE_WARNING) || !id(view.botId) || !id(view.sessionId)
    || !scope || !['room', 'personal'].includes(scope.kind) || !id(scope.id)
    || Object.keys(scope).some(key => !['kind', 'id'].includes(key))
    || (scope.kind === 'room' ? view.roomId !== scope.id : view.roomId !== undefined || !['user', view.botId].includes(scope.id))
    || !Number.isSafeInteger(view.turn) || view.turn < 0 || !Number.isSafeInteger(view.turnStartSeq) || view.turnStartSeq < 0
    || !Number.isSafeInteger(view.messageSeq) || view.messageSeq <= view.turnStartSeq
    || !Number.isSafeInteger(view.matchedTime) || view.matchedTime < 0
    || !Array.isArray(view.textSegments) || !view.textSegments.length || view.textSegments.some(part => typeof part !== 'string')
    || view.textSegments.every(part => !part.trim()) || Buffer.byteLength(JSON.stringify(view.textSegments)) > 65536) {
    throw new Error('legacy candidate unavailable')
  }
  const result = Object.freeze({ kind:'unverified-legacy-candidate', producerVerified:false,
    botId:view.botId, sessionId:view.sessionId, turn:view.turn, turnStartSeq:view.turnStartSeq,
    messageSeq:view.messageSeq, matchedTime:view.matchedTime, textHash:hash(view.textSegments) })
  if (evidence.isCurrent() !== true) throw new Error('legacy candidate changed')
  return result
}

// Separate domain from authenticated-original redo. The user authorizes only a
// new operation containing the displayed candidate, not its historical origin.
export function candidateRedoConfirmation(scope, recoveryId, evidence, { principal, operationId, target } = {}) {
  const identity = userRedoIdentity(operationId)
  if (principal?.kind !== 'user' || principal.id !== 'user' || Object.keys(principal).some(key => !['kind', 'id'].includes(key))
    || !isolatedRedoTargetValid(target)) throw new Error('candidate redo confirmation unavailable')
  const source = candidateRedoSource(scope, recoveryId, evidence)
  const value = hash(['ds-bot:candidate-isolated-confirmation-v2', recoveryId, scope.kind, scope.id, source,
    principal.kind, principal.id, operationId, identity.sessionId, target.cwd, target.provider, target.model,
    LEGACY_CANDIDATE_WARNING.zh, LEGACY_CANDIDATE_WARNING.en,
    ISOLATED_REDO_WARNING.version, ISOLATED_REDO_WARNING.zh, ISOLATED_REDO_WARNING.en])
  if (evidence.isCurrent() !== true) throw new Error('legacy candidate changed')
  return value
}
