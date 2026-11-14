import { randomUUID } from 'node:crypto'

// Session identity is deliberately process-local. The journal stores this
// generation with the guarded receipt; a restart or replacement Session
// object therefore cannot impersonate the accepted turn.
export function createTaskActionContext(store) {
  if (!store || typeof store.listActions !== 'function' || typeof store.guardedContext !== 'function') throw new Error('task journal unavailable')
  const generations = new WeakMap()
  const activeTurns = new WeakMap()
  const generation = agent => {
    const session=agent?.session
    if (!session || typeof session !== 'object' || session.id !== agent.id) return undefined
    let value=generations.get(session)
    if (!value) {value=randomUUID();generations.set(session,value)}
    return value
  }
  const verify = (task, caller, operation, exec) => {
    try {
      const agent=exec?.agent
      if (!agent || agent.id!==caller?.sid || agent.guardedClaimTurnVersion!==1 || agent.session?.id!==caller.sid) return false
      const kind=operation==='review' || (['block','unblock'].includes(operation) && caller.actor===task.reviewer) ? 'review' : 'execute'
      const accepted=store.listActions(task.id).filter(row=>row.kind===kind && row.actor===caller.actor && row.state==='accepted')
      if (accepted.length!==1) return false
      const binding=store.guardedContext(accepted[0].id)
      if (!binding || binding.sessionId!==caller.sid || binding.sessionGeneration!==generation(agent)) return false
      const turn=activeTurns.get(agent.session)
      return !!turn && turn.turnStartSeq===binding.turnStartSeq && turn.turn===binding.turn
    } catch {return false}
  }
  const activate = (agent, position) => {
    if (!generation(agent) || !Number.isSafeInteger(position?.turn) || !Number.isSafeInteger(position?.turnStartSeq)) throw new Error('turn identity unavailable')
    activeTurns.set(agent.session,{turn:position.turn,turnStartSeq:position.turnStartSeq})
  }
  // Hook the real Session's ordered event stream. A new turn or the end of the
  // current one immediately invalidates the binding, without replaying or
  // synchronously scanning potentially very long conversation histories.
  const observe = (session, event) => {
    const active=session && activeTurns.get(session)
    if (!active) return
    if (event?.type==='turn/end' || (event?.type==='turn/start' && event.seq!==active.turnStartSeq)) activeTurns.delete(session)
  }
  const current = session => {
    const turn=session && activeTurns.get(session),sessionGeneration=session && generations.get(session)
    return turn && sessionGeneration ? {sessionGeneration,...turn} : undefined
  }
  return {generation,activate,observe,verify,current}
}
