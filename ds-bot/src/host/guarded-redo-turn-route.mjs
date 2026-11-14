// An opt-in, process-local routing fence for a single user-requested redo.
// It is NOT an admission authority, result receipt, or proof of durability.
// No production module installs it until the original intent and the shared
// guarded coordinator can both be verified by the caller.
export function createGuardedRedoTurnRoute({ sessions, resolveIntent }) {
  if (typeof sessions?.get !== 'function' || typeof resolveIntent !== 'function') {
    throw new Error('guarded redo routing is unavailable')
  }
  const bySession = new WeakMap()
  const byId = new Map()
  const current = session => session && typeof session.id === 'string' && sessions.get(session.id) === session
  const canonical = (session, event) => current(session) && Number.isSafeInteger(event?.seq)
    && typeof session.eventAt === 'function' && session.eventAt(event.seq) === event
  const same = (route, session, input, turn) => route?.session === session
    && route.messageId === input?.message?.id && route.admissionId === input?.admissionId
    && route.turn === turn?.turn && route.seq === turn?.turnStartSeq

  // The caller must compose this around the ONE coordinator already bound to
  // this Agent; a new coordinator must not displace existing task authority.
  function wrap(agent, authority) {
    if (!agent?.session || agent.session.id !== agent.id || typeof authority !== 'function') throw new Error('guarded redo authority is unavailable')
    const session = agent.session
    const before = authority.beforeTurnStart, cancel = authority.cancelTurnStart
    if ((before === undefined) !== (cancel === undefined)
      || (before !== undefined && typeof before !== 'function') || (cancel !== undefined && typeof cancel !== 'function')) {
      throw new Error('guarded coordinator callbacks are incomplete')
    }
    const wrapped = (...args) => authority(...args)
    wrapped.beforeTurnStart = (subject, input, turn) => {
      if (subject !== session || !current(session) || session.id !== agent.id) throw new Error('guarded target changed')
      const intent = resolveIntent(agent, input, turn)
      const previousInstance = byId.get(session.id)
      if (previousInstance && previousInstance.session !== session) {
        previousInstance.phase = 'unknown'
        if (byId.get(session.id) === previousInstance) byId.delete(session.id)
      }
      const prior = bySession.get(session)
      if (prior?.phase === 'ended' && current(session) && session.seq > prior.endSeq) {
        bySession.delete(session)
        if (byId.get(session.id) === prior) byId.delete(session.id)
      }
      if (intent !== null) {
        if (!intent || typeof intent !== 'object' || typeof intent.operationId !== 'string' || intent.operationId === ''
          || input?.message?.source?.kind !== 'ds-bot-user-redo'
          || Object.keys(input.message.source).some(key => key !== 'kind')
          || intent.session !== session || typeof intent.messageId !== 'string' || intent.messageId === ''
          || typeof intent.admissionId !== 'string' || intent.admissionId === ''
          || intent.messageId !== input?.message?.id || intent.admissionId !== input?.admissionId
          || !['next-turn', 'next-step'].includes(input?.target)
          || typeof intent.isCurrent !== 'function' || intent.isCurrent() !== true
          || !Number.isSafeInteger(turn?.turn) || turn.turn < 0 || !Number.isSafeInteger(turn?.turnStartSeq) || turn.turnStartSeq < 0
          || turn.turnStartSeq !== session.seq || byId.has(session.id)) throw new Error('guarded redo intent is unavailable')
        const route = { session, operationId:intent.operationId, messageId:intent.messageId, admissionId:intent.admissionId,
          turn:turn.turn, seq:turn.turnStartSeq, isCurrent:intent.isCurrent, phase:'planned', endSeq:undefined }
        bySession.set(session, route); byId.set(session.id, route)
      }
      if (before !== undefined) {
        try {
          const result = before.call(authority, subject, input, turn)
          if (result !== undefined) {
            const route = bySession.get(session)
            if (same(route, subject, input, turn)) route.phase = 'unknown'
          }
          return result
        } catch (error) {
          const route = bySession.get(session)
          if (same(route, subject, input, turn)) route.phase = 'unknown'
          throw error
        }
      }
    }
    wrapped.cancelTurnStart = (subject, input, turn) => {
      let error
      try {
        const result = cancel?.call(authority, subject, input, turn)
        if (result !== undefined) {
          if (result instanceof Promise) void result.catch(() => {})
          throw new Error('guarded coordinator cleanup is unknown')
        }
      } catch (failure) { error = failure }
      const route = bySession.get(session)
      if (error !== undefined && same(route, subject, input, turn)) route.phase = 'unknown'
      // Never erase a route owned by a replacement Session or a later turn.
      if (same(route, subject, input, turn) && route.phase === 'planned') {
        bySession.delete(session)
        if (byId.get(session.id) === route) byId.delete(session.id)
      }
      if (error !== undefined) throw error
    }
    return wrapped
  }

  // Both turns.js and resume.js call this for the same event. Keep the end
  // marker until a later canonical event so both consumers see the same fence.
  function isolate(session, event) {
    const route = bySession.get(session)
    if (route === undefined) {
      const old = typeof session?.id === 'string' ? byId.get(session.id) : undefined
      if (old === undefined) return false
      // A real replacement Session must not be stalled by the abandoned route;
      // the old route stays unknown and cannot authorize the replacement.
      try {
        if (old.session !== session && current(session)) {
          if (!canonical(session, event)) return true
          old.phase = 'unknown'
          if (byId.get(session.id) === old) byId.delete(session.id)
          return false
        }
      } catch {}
      return true
    }
    try { if (!canonical(session, event)) return true } catch { route.phase = 'unknown'; return true }
    if (route.phase === 'ended') {
      if (event.seq <= route.endSeq) return true
      bySession.delete(session)
      if (byId.get(session.id) === route) byId.delete(session.id)
      return false
    }
    if (route.phase === 'planned') {
      if (event.type !== 'turn/start' || event.seq !== route.seq || event.data?.turn !== route.turn) return true
      try { if (route.isCurrent() !== true) { route.phase = 'unknown'; return true } }
      catch { route.phase = 'unknown'; return true }
      route.phase = 'active'
      return true
    }
    if (event.seq < route.seq) return true
    if (route.phase === 'active' && event.type === 'turn/end' && event.data?.turn === route.turn) {
      route.phase = 'ended'; route.endSeq = event.seq
    }
    return true
  }
  const active = session => {
    const route = bySession.get(session)
    return route !== undefined && route.phase !== 'ended'
  }
  const status = session => {
    const route = bySession.get(session)
    return route === undefined ? undefined : Object.freeze({ operationId:route.operationId, state:route.phase })
  }
  return Object.freeze({ wrap, isolate, active, status })
}
