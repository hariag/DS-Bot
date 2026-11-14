import { isDeepStrictEqual } from 'node:util'
import { isAbsolute } from 'node:path'
import { symbols } from '@deepseek-ai/cordis'
import { userRedoIdentity } from './user-redo-journal.mjs'

// JSONL restores a missing delegationDepth as the Session default of zero.
// Keep every other header field in the identity comparison.
const comparableHeader = header => header && typeof header === 'object'
  ? { ...header, delegationDepth:header.delegationDepth === undefined ? 0 : header.delegationDepth } : header

// EXPERIMENTAL PRIMITIVE, NOT INSTALLED. It creates no input and enables no
// tools. A caller MUST supply a reviewed, durable single-use fence. This
// function cannot prove that the fence or the caller's authentication is
// genuine, and is not an admission or result-delivery implementation.
export function createIsolatedRedoSessionFactory(rt, fence) {
  if (!rt?.ctx || typeof fence?.begin !== 'function' || typeof fence?.current !== 'function'
    || typeof rt.userRedoOwner !== 'function' || typeof rt.userRedoReserved !== 'function' || typeof rt.userRedoBinding !== 'function'
    || typeof rt.selfOf !== 'function' || typeof rt.agentOf !== 'function' || typeof rt.botOf !== 'function' || typeof rt.roomOf !== 'function'
    || typeof rt.chatOwners?.has !== 'function' || typeof rt.groupOwners?.has !== 'function' || typeof rt.pastOwners?.has !== 'function') {
    throw new Error('isolated redo authority unavailable')
  }
  const attempted = new Set()
  const { ctx } = rt
  const noOrdinaryOwner = id => !rt.chatOwners.has(id) && !rt.groupOwners.has(id) && !rt.pastOwners.has(id)
    && rt.selfOf(id) === undefined && rt.agentOf(id) === undefined && rt.botOf(id) === undefined && rt.roomOf(id) === undefined
  const snapshot = value => structuredClone(value)
  const providerOf = value => value?.[symbols.original] ?? value

  return async function create({ operationId, cwd, provider, model }) {
    const identity = userRedoIdentity(operationId)
    if (typeof cwd !== 'string' || !isAbsolute(cwd) || cwd.includes('\0')
      || typeof provider !== 'string' || !provider || typeof model !== 'string' || !model) {
      throw new Error('isolated redo configuration unavailable')
    }
    if (attempted.has(operationId)) return { state:'unknown' }
    // Once creation has been attempted, even a failed persistence call is an
    // uncertain outcome. Never make a second attempt in this factory.
    attempted.add(operationId)
    let handle, reader, success = false
    try {
      const initial = { operationId, sessionId:identity.sessionId, cwd, provider, model }
      const reserved = await fence.begin(snapshot(initial))
      if (reserved !== true) return { state:'unknown' }
      const row = snapshot(rt.userRedoBinding(identity.sessionId))
      if (!row || row.operationId !== operationId || row.acknowledged !== true
        || !isDeepStrictEqual(row.identity, identity) || typeof row.original?.botId !== 'string' || !row.original.botId
        || !['personal', 'room'].includes(row.scope?.kind) || typeof row.scope.id !== 'string' || !row.scope.id
        || !/^[a-f0-9]{64}$/.test(row.recoveryId) || !/^[a-f0-9]{64}$/.test(row.confirmationDigest)) return { state:'unknown' }
      const binding = snapshot({ operationId, sessionId:identity.sessionId, cwd, provider, model,
        botId:row.original.botId, scope:row.scope, recoveryId:row.recoveryId, confirmationDigest:row.confirmationDigest })
      const owner = rt.userRedoOwner(identity.sessionId)
      const valid = () => fence.current(snapshot(binding)) === true && rt.userRedoReserved(identity.sessionId) === true
        && isDeepStrictEqual(rt.userRedoBinding(identity.sessionId), row)
        && owner?.id === binding.botId && rt.userRedoOwner(identity.sessionId) === owner && noOrdinaryOwner(identity.sessionId)
      const persistence = ctx.get?.('sessionPersistence') ?? ctx.sessionPersistence
      const persistenceProvider = providerOf(persistence)
      if (!valid() || typeof persistence?.flushLiveSession !== 'function' || typeof persistence?.open !== 'function'
        || ctx.sessions?.get(identity.sessionId) !== undefined || ctx.agents?.get(identity.sessionId) !== undefined) return { state:'unknown' }
      handle = await ctx.agents.create({ sessionId:identity.sessionId, meta:{ cwd }, agentOptions:{ provider, model } })
      const agent = handle?.agent, session = agent?.session
      const current = () => valid() && providerOf(ctx.get?.('sessionPersistence') ?? ctx.sessionPersistence) === persistenceProvider
        && agent?.id === identity.sessionId && session?.id === identity.sessionId && session.header?.cwd === cwd
        && ctx.agents.get(identity.sessionId) === agent && ctx.sessions.get(identity.sessionId) === session
      if (!current() || !Number.isSafeInteger(session.seq) || session.seq < 0 || session.seq > 200_000) throw new Error('redo identity changed')
      const through = session.seq
      await persistence.flushLiveSession(identity.sessionId)
      if (!current() || session.seq !== through) throw new Error('redo changed during flush')
      reader = await persistence.open(identity.sessionId, 'read')
      const result = await reader.read(0, through)
      if (!current() || session.seq !== through || reader.id !== identity.sessionId
        || !isDeepStrictEqual(comparableHeader(reader.header), comparableHeader(session.header)) || reader.inheritedEventCount !== session.inheritedEventCount
        || !Array.isArray(result?.events) || result.events.length !== through
        || result.events.some((event, index) => event.seq !== index || !isDeepStrictEqual(event, session.eventAt(index))
          || ['turn/start', 'user/message', 'assistant/message', 'tool/call'].includes(event.type))) {
        throw new Error('redo writer prefix unavailable')
      }
      await reader.close(); reader = undefined
      if (!current() || session.seq !== through) throw new Error('redo changed after flush')
      // Only the owning future admission code may hold this handle; no UI
      // endpoint is wired to this prototype.
      success = true
      return { state:'ready', sessionId:identity.sessionId, through, handle }
    } catch {
      return { state:'unknown' }
    } finally {
      await reader?.close().catch(() => {})
      // On failure, leave the fence consumed and the outcome unknown, while
      // cancelling the agent to keep a failed setup from later executing.
      // A failed disposal must never turn an unknown outcome into success.
      if (handle && !success) await handle.dispose().catch(() => {})
    }
  }
}
