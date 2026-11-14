import { isAbsolute } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { boardList } from './board-query.js'
import { candidateRedoConfirmation } from './candidate-redo-confirmation.mjs'
import { isLegacyCandidateReaderFor } from './user-redo-legacy-candidate.mjs'
import { isolatedRedoTargetValid, userRedoIdentity } from './user-redo-journal.mjs'
import { ISOLATED_REDO_WARNING } from '../shared/user-redo-warning.js'

// Experimental authority, not installed as an endpoint and not a dispatcher.
// Only an authenticated owner route may provide the principal; callers cannot
// substitute a request-body principal. Preparing consumes a one-shot fence,
// so production must expose it only when real execution and recovery are ready.
export function createCandidateRedoPreparation(rt, { candidateReader, journal }) {
  if (!isLegacyCandidateReaderFor(rt, candidateReader) || typeof candidateReader.inspectEvidence !== 'function'
    || typeof journal?.prepare !== 'function' || typeof rt.requireHomeLock !== 'function'
    || typeof rt.homeLockVersion !== 'function' || !rt.ctx?.agents || !rt.ctx?.sessions) throw Error('candidate preparation unavailable')
  const owner = principal => principal?.kind === 'user' && principal.id === 'user'
    && Object.keys(principal).every(key => ['kind', 'id'].includes(key))
  const permitted = (scope, principal) => {
    if (!owner(principal)) return false
    try { boardList({ scope, principal, rooms:rt.state.rooms, bots:rt.state.bots }); return true } catch { return false }
  }
  const getTarget = (session, agent) => {
    const selected = agent?.model?.current?.(), cwd = rt.ctx.get?.('workingDirectory')?.get?.(session) ?? session?.header?.cwd
    if (!selected || typeof cwd !== 'string' || !isAbsolute(cwd) || cwd.includes('\0')) return undefined
    const target = { cwd, provider:selected.provider, model:selected.model }
    return isolatedRedoTargetValid(target) ? target : undefined
  }
  async function inspect({ principal, scope, recoveryId, operationId }) {
    if (!permitted(scope, principal)) throw Error('candidate unavailable')
    userRedoIdentity(operationId)
    rt.requireHomeLock()
    const lease = rt.homeLockVersion()
    if (lease === undefined || lease === null) throw Error('candidate unavailable')
    const evidence = await candidateReader.inspectEvidence(structuredClone(scope), recoveryId)
    if (!evidence || evidence.isCurrent() !== true || !permitted(scope, principal)) throw Error('candidate unavailable')
    const view = evidence.view, session = rt.ctx.sessions.get(view.sessionId), agent = rt.ctx.agents.get(view.sessionId)
    const target = getTarget(session, agent)
    const belongs = () => {
      const bot = Object.hasOwn(rt.state.bots ?? {}, view.botId)
      if (!bot) return false
      if (scope.kind === 'room') {
        const room = Object.hasOwn(rt.state.rooms ?? {}, scope.id) ? rt.state.rooms[scope.id] : undefined
        return view.roomId === scope.id && Array.isArray(room?.members) && room.members.includes(view.botId)
      }
      return view.roomId === undefined && (scope.id === 'user' || scope.id === view.botId)
    }
    const stable = () => {
      try {
        rt.requireHomeLock()
        const checked = rt.homeLockVersion() === lease && rt.ctx.sessions.get(view.sessionId) === session
          && rt.ctx.agents.get(view.sessionId) === agent && agent?.id === view.sessionId && agent.session === session
          && isDeepStrictEqual(getTarget(session, agent), target) && permitted(scope, principal) && belongs() && evidence.isCurrent() === true
        // The evidence check can call Host code. Recheck the live bindings
        // after it returns before exposing or persisting a confirmation.
        return checked && rt.ctx.sessions.get(view.sessionId) === session && rt.ctx.agents.get(view.sessionId) === agent
          && agent.session === session && isDeepStrictEqual(getTarget(session, agent), target)
          && belongs() && rt.homeLockVersion() === lease
      } catch { return false }
    }
    if (!target || !stable()) throw Error('candidate target unavailable')
    const confirmationDigest = candidateRedoConfirmation(scope, recoveryId, evidence, { principal, operationId, target })
    if (!stable()) throw Error('candidate changed')
    return { evidence, target, confirmationDigest, stable }
  }
  async function preview(raw) {
    const input = structuredClone(raw)
    const { evidence, target, confirmationDigest, stable } = await inspect(input)
    const view = structuredClone(evidence.view)
    if (!stable()) throw Error('candidate changed')
    return { operationId:input.operationId, scope:structuredClone(input.scope), recoveryId:input.recoveryId,
      candidate:view, target:structuredClone(target), warning:ISOLATED_REDO_WARNING,
      confirmationDigest, execution:'disabled' }
  }
  async function prepare(raw) {
    const input = structuredClone(raw)
    if (input.acknowledged !== true || typeof input.confirmationDigest !== 'string') throw Error('candidate confirmation required')
    const { target, confirmationDigest, stable } = await inspect(input)
    if (input.confirmationDigest !== confirmationDigest || !stable()) throw Error('candidate confirmation changed')
    const result = await journal.prepare({ operationId:input.operationId, recoveryId:input.recoveryId,
      scope:structuredClone(input.scope), principal:structuredClone(input.principal), target,
      confirmationDigest, acknowledged:true })
    if (!stable()) throw Error('candidate preparation outcome unknown')
    return { operationId:result.operationId, state:'prepared', execution:'disabled' }
  }
  return Object.freeze({ preview, prepare })
}
