import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { userRedoIdentity } from './user-redo-journal.mjs'
import { createIsolatedRedoRequestGuard } from './isolated-redo-request-guard.mjs'

// Experimental, not installed. This does not authenticate, enqueue, expose a
// UI, or verify results. Caller supplies a previously confirmed durable row and
// must bind the original proof, principal and current permission to the journal.
export function createIsolatedRedoCoordinator(rt, { agent, journal, binding, principal, originalMessage, message }) {
  const row = structuredClone(binding), actor = structuredClone(principal), original = structuredClone(originalMessage)
  const input = structuredClone(message), identity = userRedoIdentity(row?.operationId)
  const candidate = row?.original?.kind === 'unverified-legacy-candidate'
  const segments = Array.isArray(original?.content) && original.content.every(part => part?.type === 'text' && typeof part.text === 'string')
    ? original.content.map(part => part.text) : undefined
  const hash = createHash('sha256').update(JSON.stringify(candidate ? segments : original)).digest('hex')
  if (!rt?.ctx || typeof rt.userRedoOwner !== 'function' || typeof rt.userRedoBinding !== 'function'
    || !(rt.userRedoTransient instanceof Map) || typeof journal?.markClaimingSync !== 'function'
    || typeof journal?.inspectClaimingSync !== 'function' || row?.state !== 'dispatching'
    || !isDeepStrictEqual(row.identity, identity) || !isDeepStrictEqual(row.principal, actor)
    || actor?.kind !== 'user' || actor.id !== 'user' || row.original?.messageHash !== hash
    || (candidate && (row.original.producerVerified !== false || !segments?.length || original.id !== row.original.messageId))
    || input?.id !== identity.messageId || input.role !== 'user' || input.source?.kind !== 'ds-bot-user-redo'
    || Object.keys(input.source).some(key => key !== 'kind') || !isDeepStrictEqual(input.content, original?.content)
    || agent?.id !== identity.sessionId || agent?.session?.id !== identity.sessionId
    || agent.guardedRequestBoundaryVersion !== 1) throw Error('isolated redo coordinator unavailable')
  const session = agent.session, owner = rt.userRedoOwner(identity.sessionId)
  let claimed
  const live = expected => {
    try {
      return rt.ctx.agents?.get(identity.sessionId) === agent && rt.ctx.sessions?.get(identity.sessionId) === session
        && agent.session === session && agent.guardedRequestBoundaryVersion === 1 && owner?.id === row.original.botId
        && rt.userRedoOwner(identity.sessionId) === owner && isDeepStrictEqual(rt.userRedoBinding(identity.sessionId), expected)
    } catch { return false }
  }
  const inspect = () => {
    if (!claimed || !live(claimed)) return false
    try { return isDeepStrictEqual(journal.inspectClaimingSync(claimed, actor), claimed) && live(claimed) } catch { return false }
  }
  const requestGuard = createIsolatedRedoRequestGuard(rt, { agent, expectedMessage:input, target:row.target, isCurrent:inspect })
  const coordinate = (sessionId, inputs, claim, turn) => {
    if (claimed || sessionId !== identity.sessionId || !live(row) || !Array.isArray(inputs) || inputs.length !== 1
      || inputs[0]?.admissionId !== identity.admissionId || inputs[0]?.target !== 'next-turn'
      || !isDeepStrictEqual(inputs[0]?.message, input) || typeof claim !== 'function'
      || !Number.isSafeInteger(turn?.turn) || !Number.isSafeInteger(turn?.turnStartSeq)) throw Error('isolated redo claim unavailable')
    const start = session.eventAt?.(turn.turnStartSeq)
    if (start?.type !== 'turn/start' || start.data?.turn !== turn.turn) throw Error('isolated redo turn unavailable')
    const next = journal.markClaimingSync(row, turn, actor)
    // If anything changes after the durable transition, retain the unknown
    // claiming state. Never recreate or automatically resend this operation.
    if (next?.state !== 'claiming' || !live(row) || !isDeepStrictEqual(next.turn, turn)) throw Error('isolated redo claim changed')
    rt.userRedoTransient.set(row.operationId, structuredClone(next))
    claimed = structuredClone(next)
    if (!inspect()) throw Error('isolated redo claim changed')
    claim()
    return 'committed'
  }
  coordinate.beforeModelRequest = (subject, request, position) => {
    if (!claimed || position?.turn !== claimed.turn?.turn) return false
    return requestGuard(subject, request, position)
  }
  return Object.freeze(coordinate)
}
