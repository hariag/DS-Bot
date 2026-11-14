import { userRedoIdentity } from './user-redo-journal.mjs'

// A redo identity is a reserved namespace, not a mutable ownership index. A
// crash, damaged state, or an in-flight removal must never turn a redo Agent
// into an ordinary unrestricted Agent. Identity generation uses the same
// lowercase SHA-256 spelling in userRedoIdentity.
export const isUserRedoSessionId = id => typeof id === 'string' && /^redo-[a-f0-9]{64}$/.test(id)

// This foundation never creates or wakes a Session. A reserved redo identity
// is separate from ordinary Bot/chat ownership and must fail closed while the
// original-scope permission and tool policy have not been positively bound.
export function install(rt) {
  // Process-local mirror of an independently durable, authorized journal row.
  // This alone is not authority: the caller must recheck the journal fence.
  // Losing this map on restart intentionally makes ownership unavailable.
  const transient = new Map()
  const rowsFor = sessionId => {
    const rows = rt.state.userRedos
    const stored = rows && typeof rows === 'object' && !Array.isArray(rows) ? Object.entries(rows) : []
    return [...stored, ...transient.entries()].filter(([, row]) => row?.identity?.sessionId === sessionId)
  }
  const reserved = sessionId => isUserRedoSessionId(sessionId)
  const owner = sessionId => {
    if (!reserved(sessionId)) return undefined
    const rows = rowsFor(sessionId)
    if (rows.length !== 1) return undefined
    const [key, row] = rows[0]
    try {
      const expected = userRedoIdentity(row.operationId)
      if (key !== row.operationId || JSON.stringify(expected) !== JSON.stringify(row.identity) || typeof row.original?.botId !== 'string') return undefined
      const bot = rt.botOf(row.original.botId)
      if (!bot) return undefined
      if (row.scope?.kind === 'room') {
        const room = rt.roomOf(row.scope.id)
        if (!room || room.members?.includes(bot.id) !== true) return undefined
      } else if (row.scope?.kind !== 'personal' || !['user', bot.id].includes(row.scope.id)) return undefined
      return bot
    } catch { return undefined }
  }
  rt.userRedoReserved = reserved
  rt.userRedoOwner = owner
  rt.userRedoBinding = sessionId => {
    const rows = rowsFor(sessionId)
    return reserved(sessionId) && rows.length === 1 ? rows[0][1] : undefined
  }
  rt.userRedoTransient = transient
  // Guard every tool, including shell, run_code, connectors and delegation.
  // This is a safety floor, not an assertion that the redo can do useful work.
  // The feature must stay unavailable until a narrower original-scope policy
  // is installed and verified for the actual Agent, including non-tool paths.
  rt.ctx.tools.guard(exec => (reserved(exec.agent?.id) || reserved(exec.agent?.session?.id))
    ? 'Tools are unavailable in an isolated redo until its original-scope policy is verified.' : undefined)
}
