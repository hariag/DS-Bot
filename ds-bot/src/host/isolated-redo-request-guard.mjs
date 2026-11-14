import { isDeepStrictEqual } from 'node:util'

const immutable = value => value === null || typeof value !== 'object'
  || (Object.isFrozen(value) && Object.values(value).every(immutable))

// Research-only guard for a *single text-only model call*. It does not install
// itself, authenticate a user, enable tools, or dispatch an input. A future
// caller must bind its arguments to the durable, user-confirmed operation.
// Loss of any binding is outcome-unknown and must never trigger an auto-retry.
export function createIsolatedRedoRequestGuard(rt, { agent, expectedMessage, target, isCurrent }) {
  if (!rt?.ctx || !agent?.session || agent.guardedRequestBoundaryVersion !== 1
    || typeof agent.guardedSend !== 'function' || typeof rt.homeLockVersion !== 'function'
    || typeof rt.requireHomeLock !== 'function' || typeof isCurrent !== 'function'
    || !target || typeof target.provider !== 'string' || !target.provider || typeof target.model !== 'string' || !target.model
    || !expectedMessage || expectedMessage.role !== 'user' || typeof expectedMessage.id !== 'string'
    || expectedMessage.source?.kind !== 'ds-bot-user-redo' || !Array.isArray(expectedMessage.content)
    || !expectedMessage.content.length || expectedMessage.content.some(part => part?.type !== 'text' || typeof part.text !== 'string')) {
    throw new Error('isolated redo request authority unavailable')
  }
  const session = agent.session, expected = structuredClone(expectedMessage)
  const selected = Object.freeze({ provider:target.provider, model:target.model })
  rt.requireHomeLock()
  const lease = rt.homeLockVersion()
  if (lease === undefined || lease === null) throw new Error('isolated redo lease unavailable')
  let used = false
  const current = () => {
    try {
      rt.requireHomeLock()
      return rt.homeLockVersion() === lease && agent.session === session && agent.id === session.id
        && rt.ctx.agents?.get(session.id) === agent && rt.ctx.sessions?.get(session.id) === session
        && agent.guardedRequestBoundaryVersion === 1
    } catch { return false }
  }
  return (subject, request, position) => {
    if (used) return false
    // Do not give any second attempt a fresh chance after an uncertain boundary.
    used = true
    try {
      if (subject !== session || !current() || isCurrent() !== true || !current()
        || !Object.isFrozen(request) || !immutable(request.messages)
        || request.sessionId !== session.id || request.provider !== selected.provider || request.model !== selected.model
        || request.system !== undefined || request.purpose !== undefined
        || !Number.isSafeInteger(position?.turn) || position.turn < 0 || position.step !== 1
        || (request.tools !== undefined && (!Array.isArray(request.tools) || !immutable(request.tools) || request.tools.length !== 0))
        || !Array.isArray(request.messages)) return false
      const history = request.toolHistory
      if (history !== undefined && (!history || !immutable(history) || !Array.isArray(history.tools) || history.tools.length !== 0
        || !Array.isArray(history.updates) || history.updates.length !== 0)) return false
      const nonSystem = request.messages.filter(message => message?.role !== 'system')
      if (nonSystem.length !== 1 || !isDeepStrictEqual(nonSystem[0], expected)
        || !Object.isFrozen(nonSystem[0]) || !current()) return false
      // A callback is not trusted to preserve the owning Session or lease.
      return isCurrent() === true && current()
    } catch { return false }
  }
}
