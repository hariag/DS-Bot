import { createBotWorkflow } from './workflow.mjs'
import { installTaskTool } from './task-tool.mjs'

// This adapter creates no independent store and never enables dispatch on its
// own. The enclosing board service owns the home lock and the SQLite lifetime.
export function installHostWorkflow(rt, { defineTool, getStore, run, verifyBinding = () => false, verifyShare = () => false, wake = () => {}, onError = () => {} } = {}) {
  let workflow
  let closed = false
  const facade = {
    invoke(exec, args) { return run(async () => {
      if (closed || typeof getStore !== 'function') throw new Error('Task service is unavailable')
      const store = await getStore()
      if (closed) throw new Error('Task service is unavailable')
      if (!workflow || workflow.store !== store) throw new Error('Task service is not bound to this journal')
      return workflow.impl.invoke(exec, args)
    }) },
  }
  installTaskTool(rt, facade, defineTool)
  return {
    bind(store) {
      if (closed || !store) throw new Error('Task service is unavailable')
      if (workflow && workflow.store !== store) throw new Error('Task journal changed while active')
      if (!workflow) workflow = { store, impl:createBotWorkflow({ rt, store, verifyBinding, verifyShare, wake, onError }) }
    },
    authorize(input) { return !closed && workflow?.impl.authorize(input) === true },
    close() { closed = true; workflow = undefined },
  }
}
