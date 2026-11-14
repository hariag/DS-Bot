// Cooperative serialization for Bot tool calls. This runs at both the early
// guard and immediately around the tool body: a call approved before a task
// acquired the lease must still be checked at its actual execution boundary.
// It does not claim to sandbox the operating system or external processes.
export function createTaskCooperativeGate({store,actionContext,resolveBot,assertLease}) {
  if (!store || typeof store.currentWriteLease!=='function' || typeof actionContext?.verify!=='function' || typeof resolveBot!=='function' || typeof assertLease!=='function') throw Error('cooperative gate unavailable')
  const active=new Set()
  const readOnly=new Set(['read','glob','grep'])
  const classify=exec=>{
    const sid=exec?.agent?.id,actor=typeof sid==='string' ? resolveBot(sid) : undefined
    return actor && !readOnly.has(exec.name) ? {actor,sid} : undefined
  }
  const allowed=(exec,caller)=>{
    assertLease()
    const review=store.currentReviewLease?.()
    if (review) return !review.ambiguous && review.state==='accepted' && exec.name==='board_task'
      && review.actor===caller.actor && actionContext.verify(review.task,caller,'review',exec)===true
    const lease=store.currentWriteLease()
    if (!lease) return true
    return !lease.ambiguous && lease.state==='accepted' && lease.actor===caller.actor
      && actionContext.verify(lease.task,caller,'start',exec)===true
  }
  const guard=exec=>{
    const caller=classify(exec)
    if (!caller) return undefined
    try {if(allowed(exec,caller))return undefined} catch {}
    return 'Another task holds the cooperative workspace write lease; wait for it to complete or be reconciled.'
  }
  const execute=async (exec,next)=>{
    const caller=classify(exec)
    if (!caller) return next()
    if (!allowed(exec,caller)) throw Error('Cooperative workspace write lease changed before tool execution')
    // Use object identity: callers cannot manufacture or remove another
    // invocation's in-flight token, even when tool call IDs collide.
    const token={};active.add(token)
    try{return await next()}finally{active.delete(token)}
  }
  return {guard,execute,mayClaim:()=>{try{assertLease();return active.size===0}catch{return false}},activeCount:()=>active.size}
}

// Install only after the caller has exclusive ownership of the task journal
// and before any Bot Agent can begin a tool call. The host owns teardown.
export function attachTaskCooperativeGate(ctx, gate) {
  if (typeof ctx?.tools?.guard!=='function' || typeof ctx?.on!=='function'
    || typeof gate?.guard!=='function' || typeof gate?.execute!=='function') throw Error('cooperative Host hooks unavailable')
  const dropGuard=ctx.tools.guard(gate.guard)
  try {
    const dropExecute=ctx.on('tools/execute',gate.execute)
    return () => {dropExecute?.();dropGuard?.()}
  } catch(error) {dropGuard?.();throw error}
}
