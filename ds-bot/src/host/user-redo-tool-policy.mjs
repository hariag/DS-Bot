import { isDeepStrictEqual } from 'node:util'
import { createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { userRedoConfirmation, userRedoIdentity } from './user-redo-journal.mjs'

// Diagnostic parity check only. A positive result is NOT authorization and
// must never open the live guard: file roots, dynamic cwd, shell/network and
// external effects are not confined here. The guard remains deny-all.
const FILE_TOOLS = new Set(['read', 'write', 'edit', 'glob', 'grep', 'bash'])
const sandboxPolicy = (policy, sessionId) => {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy) || policy.sessionId !== sessionId
    || Object.keys(policy).some(key => !['mode', 'workspaceRoot', 'additionalWritableRoots', 'sessionId'].includes(key))
    || !['read-only', 'workspace-write', 'danger-full-access'].includes(policy.mode)
    || typeof policy.workspaceRoot !== 'string' || !isAbsolute(policy.workspaceRoot) || policy.workspaceRoot.includes('\0')
    || (policy.additionalWritableRoots !== undefined && (!Array.isArray(policy.additionalWritableRoots)
      || policy.additionalWritableRoots.some(root => typeof root !== 'string' || !isAbsolute(root) || root.includes('\0'))))) return undefined
  return { mode:policy.mode, workspaceRoot:policy.workspaceRoot, additionalWritableRoots:policy.additionalWritableRoots ?? [] }
}

export function sameRedoToolRuntime(rt, { operationId, target, sourceProof, confirmationDigest, exec }) {
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
    const originalSandbox = sandboxPolicy(sandbox.resolve({ session:original.session }), original.id)
    const targetSandbox = sandboxPolicy(sandbox.resolve({ session:target.session }), target.id)
    if (!spec || typeof spec.sandbox !== 'string' || typeof spec.approval !== 'string' || originalSandbox?.mode !== spec.sandbox
      || !targetSandbox || !isDeepStrictEqual(originalSandbox, targetSandbox)) return false
    const executable = ctx.tools?.executable
    // Without a resolved original step set, conditional registrations cannot
    // be shown to be executable and are deliberately unavailable.
    if (typeof executable !== 'function' || !exec.toolSet) return false
    const originalDef = executable.call(ctx.tools, exec.name, original)
    const targetDef = executable.call(ctx.tools, exec.name, target, exec.toolSet)
    return !!originalDef && originalDef === targetDef
      && sourceProof.isCurrent() === true && rt.userRedoOwner(identity.sessionId)?.id === entry.original.botId
  } catch { return false }
}
