// Registration is kept separate from the journal; the host supplies the real
// DSH defineTool and the workflow instance backed by its current writer lock.
export function installTaskTool(rt, workflow, defineTool) {
  if (!Array.isArray(rt?.teamTools) || typeof workflow?.invoke !== 'function' || typeof defineTool !== 'function') throw new TypeError('Task tool dependencies required')
  const tool = defineTool({
    name: 'board_task',
    description: 'Inspect or update your authorized task. Show the task first. Use one stable operation_id for one exact logical update; if the outcome is unknown, call operation with that same ID before doing anything again. Only the real owner may start or report, and only its independent reviewer may review. The host checks actor, scope and required evidence fields; the independent reviewer checks whether the evidence meets acceptance. A report is not an acceptance. Respect paused goals, existing work, dependencies, authorization, and the 30-step turn budget.',
    parameters: {
      action: { type:'string', required:true, enum:['show','operation','start','report','review','block','unblock'], description:'Task action' },
      task_id: { type:'string', required:true, description:'Stable task ID' },
      operation_id: { type:'string', description:'Stable ID for this exact update, or the original ID when checking operation' },
      expected_revision: { type:'integer', description:'Exact task revision from show for a state update' },
      value: { type:'object', additionalProperties:false, properties: {
        kind: { type:'string', enum:['git','personal'] }, evidence: { type:'string' },
        targetCommit: { type:'string' }, targetBlob: { type:'string' }, acceptanceBlob: { type:'string' }, environment: { type:'string' },
        result: { type:'string', enum:['pass','rework'] }, reason: { type:'string' }, condition: { type:'string' }, owner: { type:'string' },
      }, description:'Structured evidence or blocker fields required by the action' },
    },
    output: { schema:{ type:'string' }, render:(_args, value) => [{ type:'text', text:String(value) }] },
    async execute(args, exec) {
      const result = await workflow.invoke(exec, { action:args.action, taskId:args.task_id,
        ...(args.operation_id === undefined ? {} : { operationId:args.operation_id }),
        ...(args.expected_revision === undefined ? {} : { expectedRevision:args.expected_revision }),
        ...(args.value === undefined ? {} : { value:args.value }) })
      return JSON.stringify(result)
    },
  })
  rt.teamTools.push(tool)
  return tool
}
