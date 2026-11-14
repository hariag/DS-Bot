import { isDeepStrictEqual } from 'node:util'
import { createHash } from 'node:crypto'
import { userRedoConfirmation, userRedoIdentity } from './user-redo-journal.mjs'

// Candidate policy only; never installed as the live guard. It can permit a
// small set of original-session file tools if their actual definitions and
// effective permission/sandbox state match the target. Team messaging,
// delegation, connectors and run_code stay denied. A real Host must prove the
// original, journal and Agent setup before binding this to dispatch.
const FILE_TOOLS = new Set(['read', 'write', 'edit', 'glob', 'grep', 'bash'])

export function checkRedoFileTool(rt, { operationId, target, sourceProof, confirmationDigest, exec }) {
  try {
    const ctx = rt.ctx, entry = rt.state.userRedos?.[operationId], identity = userRedoIdentity(operationId)
    if (!entry || !isDeepStrictEqual(entry.identity, identity) || entry.operationId !== operationId
      || entry.acknowledged !== true || entry.confirmationDigest !== confirmationDigest
      || entry.recoveryId !== sourceProof?.recoveryId || entry.original?.sessionId !== sourceProof?.sessionId
      || entry.original?.botId !== sourceProof?.botId || entry.original?.turn !== sourceProof?.turn
      || entry.original?.messageSeq !== sourceProof?.messageSeq || entry.original?.messageId !== sourceProof?.message?.id
      || entry.original?.messageHash !== createHash('sha256').update(JSON.stringify(sourceProof.message)).digest('hex')
      || userRedoConfirmation(entry.scope, entry.recoveryId, sourceProof) !== confirmationDigest
      || typeof sourceProof.isCurrent !== 'function' || sourceProof.isCurrent() !== true) return false
    const original = ctx.agents?.get?.(entry.original.sessionId)
    if (!target || target.id !== identity.sessionId || target.session?.id !== identity.sessionId
      || ctx.agents?.get?.(identity.sessionId) !== target || ctx.sessions?.get?.(identity.sessionId) !== target.session
      || !original || original.id !== entry.original.sessionId || ctx.sessions?.get?.(original.id) !== original.session
      || exec?.agent !== target || !FILE_TOOLS.has(exec.name) || rt.userRedoOwner(identity.sessionId)?.id !== entry.original.botId) return false
    const fromCwd = original.session.header?.cwd, toCwd = target.session.header?.cwd
    if (typeof fromCwd !== 'string' || !fromCwd || fromCwd !== toCwd) return false
    const permissions = ctx.get?.('permissionPresets'), sandbox = ctx.get?.('sandboxPolicy')
    if (typeof permissions?.current !== 'function' || typeof permissions.resolve !== 'function' || typeof sandbox?.resolve !== 'function') return false
    const preset = permissions.current(original.session)
    if (typeof preset !== 'string' || !preset || ['auto', 'custom'].includes(preset)
      || permissions.current(target.session) !== preset) return false
    const spec = permissions.resolve(preset)
    const originalSandbox = sandbox.resolve({ session:original.session }), targetSandbox = sandbox.resolve({ session:target.session })
    if (!spec || typeof spec.sandbox !== 'string' || typeof spec.approval !== 'string' || originalSandbox?.mode !== spec.sandbox
      || !isDeepStrictEqual(originalSandbox, targetSandbox)) return false
    const definitions = ctx.tools?.definitions
    if (typeof definitions !== 'function') return false
    const originalDefs = definitions.call(ctx.tools, original).filter(def => def.name === exec.name)
    const targetDefs = definitions.call(ctx.tools, target, exec.toolSet).filter(def => def.name === exec.name)
    return originalDefs.length === 1 && targetDefs.length === 1 && originalDefs[0] === targetDefs[0]
      && sourceProof.isCurrent() === true && rt.userRedoOwner(identity.sessionId)?.id === entry.original.botId
  } catch { return false }
}
