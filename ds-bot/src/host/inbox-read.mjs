import { HISTORY_TIMEOUT_MS } from './constants.js'

const unavailable = () => ({ status:'unavailable' })
const service = (ctx, name) => ctx.get?.(name) ?? ctx[name]

function queues(nextStep, nextTurn) {
  if (!Array.isArray(nextStep) || !Array.isArray(nextTurn)) return unavailable()
  return { status:'ready', nextStep:[...nextStep], nextTurn:[...nextTurn] }
}

function projectionQueues(snapshot) {
  if (!Number.isSafeInteger(snapshot?.asOfSeq) || snapshot.asOfSeq < -1) return unavailable()
  const inbox = snapshot.values?.inbox
  return queues(inbox?.['next-step'], inbox?.['next-turn'])
}

// The caller authorizes the Session and schedules demand reads. None of
// these paths resolves an Agent, attaches a cold Session, or drains its inbox.
export async function readSessionInbox(ctx, sessionId, signal) {
  if (typeof sessionId !== 'string' || !sessionId || signal?.aborted) return unavailable()
  const timeout = AbortSignal.timeout(HISTORY_TIMEOUT_MS)
  const readSignal = signal ? AbortSignal.any([signal, timeout]) : timeout
  try {
    const agent = service(ctx, 'agents')?.get?.(sessionId)
    if (agent) {
      if ((agent.id !== undefined && agent.id !== sessionId)
        || (agent.session?.id !== undefined && agent.session.id !== sessionId)) return unavailable()
      const result = queues(agent.inbox?.nextStep, agent.inbox?.nextTurn)
      if (result.status === 'ready') return result
    }

    const sessions = service(ctx, 'sessions')
    const projections = service(ctx, 'sessionProjections')
    const fromSession = session => session?.id === sessionId
      ? projectionQueues(projections.snapshot(session, ['inbox'])) : unavailable()
    if (typeof projections?.snapshot === 'function') {
      const live = sessions?.get?.(sessionId)
      if (live) return fromSession(live)
      const query = service(ctx, 'sessionQuery')
      const persistence = service(ctx, 'sessionPersistence')
      if (typeof query?.inspectSession === 'function' && typeof persistence?.stat === 'function') {
        const stored = await persistence.stat(sessionId, { signal:readSignal })
        readSignal.throwIfAborted()
        const attached = sessions?.get?.(sessionId)
        if (attached) return fromSession(attached)
        if (stored === undefined) return { status:'missing' }
        if (stored?.header?.id !== sessionId) return unavailable()
        if (stored.formatStatus === 'migration-required') return { status:'migration' }
        const result = await query.inspectSession(sessionId, fromSession, readSignal)
        readSignal.throwIfAborted()
        return result
      }
    }

    // Older hosts may expose only the public projection controller. Cached
    // migration hints have no exact event cut and cannot establish emptiness.
    const controller = service(ctx, 'sessionController')
    if (typeof controller?.projections !== 'function') return unavailable()
    const snapshot = await controller.projections({ sessionId }, readSignal)
    readSignal.throwIfAborted()
    if (snapshot === null) return { status:'missing' }
    if (snapshot?.kind === 'migration-required') return { status:'migration' }
    return snapshot?.kind === 'sequenced' ? projectionQueues(snapshot) : unavailable()
  } catch (error) {
    if (!readSignal.aborted && ['session/not-found', 'SESSION_QUERY_SESSION_NOT_FOUND'].includes(error?.code)) return { status:'missing' }
    return unavailable()
  }
}
