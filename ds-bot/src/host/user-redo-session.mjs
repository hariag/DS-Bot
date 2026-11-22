import { userRedoIdentity } from './user-redo-journal.mjs'

// This foundation never creates or wakes a Session. A reserved redo identity
// is separate from ordinary Bot/chat ownership and must fail closed while the
// original-scope permission and tool policy have not been positively bound.
export function install(rt) {
  const rowsFor = sessionId => Object.values(rt.state.userRedos ?? {})
    .filter(row => row?.identity?.sessionId === sessionId)
  const reserved = sessionId => typeof sessionId === 'string' && rowsFor(sessionId).length > 0
  const owner = sessionId => {
    const rows = rowsFor(sessionId)
    if (rows.length !== 1) return undefined
    const row = rows[0]
    try {
      const expected = userRedoIdentity(row.operationId)
      if (JSON.stringify(expected) !== JSON.stringify(row.identity) || typeof row.original?.botId !== 'string') return undefined
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
  // Guard every tool, including shell, run_code, connectors and delegation.
  // This is a safety floor, not an assertion that the redo can do useful work.
  // The feature must stay unavailable until a narrower original-scope policy
  // is installed and verified for the actual Agent, including non-tool paths.
  rt.ctx.tools.guard(exec => reserved(exec.agent?.id)
    ? 'Tools are unavailable in an isolated redo until its original-scope policy is verified.' : undefined)
}
