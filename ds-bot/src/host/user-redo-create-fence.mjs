import { isDeepStrictEqual } from 'node:util'
import { userRedoIdentity } from './user-redo-journal.mjs'

// Experimental bridge. `journal` must be an isolated-mode journal backed by
// real durable state and proof authorities; this adapter does not create one
// and does not authenticate the caller. Consuming its dispatch intent permits
// only the separate empty Session creation: it does not enqueue model input.
export function createIsolatedRedoCreationFence(rt, journal, principal) {
  if (!(rt?.userRedoTransient instanceof Map) || typeof rt.userRedoBinding !== 'function'
    || typeof journal?.beginDispatch !== 'function' || typeof journal?.inspectDispatchSync !== 'function'
    || principal?.kind !== 'user' || principal.id !== 'user' || Object.keys(principal).some(key => !['kind', 'id'].includes(key))) {
    throw new Error('isolated redo creation fence unavailable')
  }
  const actor = structuredClone(principal), active = new Map()
  const sameTarget = (binding, row) => binding.operationId === row.operationId
    && binding.sessionId === row.identity?.sessionId
    && isDeepStrictEqual({ cwd:binding.cwd, provider:binding.provider, model:binding.model }, row.target)
  const sameFullBinding = (binding, row) => sameTarget(binding, row) && binding.botId === row.original?.botId
    && isDeepStrictEqual(binding.scope, row.scope) && binding.recoveryId === row.recoveryId
    && binding.confirmationDigest === row.confirmationDigest
  return Object.freeze({
    async begin(binding) {
      const identity = userRedoIdentity(binding?.operationId)
      if (binding.sessionId !== identity.sessionId || active.has(binding.operationId)
        || rt.userRedoTransient.has(binding.operationId) || rt.userRedoBinding(identity.sessionId) !== undefined) return false
      const dispatch = await journal.beginDispatch(binding.operationId, structuredClone(actor))
      const row = structuredClone(dispatch?.binding)
      if (dispatch?.perform !== true || dispatch.state !== 'dispatching' || !row || row.state !== 'dispatching'
        || !isDeepStrictEqual(row.identity, identity) || !isDeepStrictEqual(row.principal, actor) || !sameTarget(binding, row)
        || rt.userRedoTransient.has(binding.operationId) || rt.userRedoBinding(identity.sessionId) !== undefined) return false
      // Recheck the durable phase before publishing a process-local owner. A
      // later mismatch leaves the operation unknown and never grants a retry.
      if (!isDeepStrictEqual(journal.inspectDispatchSync(row, structuredClone(actor)), row)) return false
      rt.userRedoTransient.set(binding.operationId, structuredClone(row))
      active.set(binding.operationId, row)
      return true
    },
    current(binding) {
      const row = active.get(binding?.operationId)
      if (!row || !sameFullBinding(binding, row) || !isDeepStrictEqual(rt.userRedoBinding(row.identity.sessionId), row)) return false
      try { return isDeepStrictEqual(journal.inspectDispatchSync(row, structuredClone(actor)), row) } catch { return false }
    },
  })
}
