// Registration is kept separate from the journal; the host supplies the real
// DSH defineTool and the workflow instance backed by its current writer lock.
export function installTaskTool(rt, workflow, defineTool) {
  if (!Array.isArray(rt?.teamTools) || typeof workflow?.invoke !== 'function' || typeof defineTool !== 'function') throw new TypeError('Task tool dependencies required')
  const tool = defineTool({
    name: 'board_task',
    description: 'Find work with list. Register actionable instructions on the group board before executing. For register, supply both task_id and operation_id, plus room_id in private chat. Registration records work without dispatch. Show the original card before any update. For a group card, pass its returned itemsQuery to board_task to read one page of child items, including linked group-goal items. Finish and independently review the items before reporting the parent. A working owner records partial results or a pending dependency on the original card with progress. Use one stable operation_id for one exact logical update; if the outcome is unknown, call operation with that same ID before doing anything again. Only the real owner may start or report, and only its independent reviewer may review. The host checks actor, scope and required evidence fields; the independent reviewer checks whether the evidence meets acceptance. A report is not an acceptance. Respect paused goals, existing work, dependencies, authorization, and the 30-step turn budget.',
    parameters: {
      action: { type:'string', required:true, enum:['list','register','show','operation','reply','start','progress','report','review','block','unblock','propose','proposal','plan'], description:'Task action; plan asks the host to create the release lifecycle task chain' },
      task_id: { type:'string', description:'Stable task ID (required for task actions, not for plan)' },
      room_id: { type:'string', description:'Exact group ID. Copy task.roomId from show; scope includes a room: prefix and cannot be used as room_id. A group session is restricted to its own room.' },
      parent_task_id: { type:'string', description:'Parent feature or bugfix for a task item; use with list to see its items.' },
      query: { type:'string', description:'Filter list by stable ID or case-insensitive text; searches completed work as well.' },
      kind: { type:'string', enum:['card','item','group_goal','shared','proposal','release'], description:'List one type of record. Use release to find minor releases by name, version or ID in the selected group.' },
      mine: { type:'boolean', description:'List only tasks you own or review.' },
      cursor: { type:'string', description:'Continue the same list with its nextCursor.' },
      release_id: { type:'string', description:'Minor release ID in the selected group. Use with list to include its cards and items, including completed work, or with plan or register.' },
      requirement: { type:'string', description:'Requirement text for plan' },
      operation_id: { type:'string', description:'Required for start, progress, report, review, reply, block, unblock and register. Use a stable ID for this exact update, or the original ID when checking operation.' },
      expected_revision: { type:'integer', description:'Exact task revision from show for a state update' },
      expected_board_revision: { type:'integer', description:'For a group-goal reply, use legacy.boardRevision from show along with expected_revision.' },
      proposal_id: { type:'string', description:'Proposal ID returned by propose, when checking a proposal' },
      note: { type:'string', description:'Reply text on the original group-goal item or assigned draft card; a reply records a note without authorizing or scheduling work. Also used to explain a proposal' },
      change: { type:'object', additionalProperties:false, properties: {
        kind: { type:'string', enum:['create','update','status','release'] },
        value: { type:'object', additionalProperties:true, description:'create: card fields (title, owner, reviewer, acceptance, description, type, labels, dueDate, dueComplete, checklist, dependencies, draft). update: description, type, labels, dueDate, dueComplete, checklist. status: {type: submit|cancel|restore, reason?}. release: {releaseId}.' },
      }, description:'For register, supply value with title, owner, independent reviewer, acceptance, type and optional description. For propose, a proposed content, status or release change; the user confirms or rejects it in the board Changes panel before it applies. Query it with action proposal.' },
      value: { type:'object', additionalProperties:false, properties: {
        summary:{ type:'string' }, next:{ type:'string' },
        kind: { type:'string', enum:['git','personal'] }, evidence: { type:'string' },
        targetCommit: { type:'string' }, targetBlob: { type:'string' }, acceptanceBlob: { type:'string' }, environment: { type:'string' },
        result: { type:'string', enum:['pass','rework'] }, reason: { type:'string' }, condition: { type:'string' }, owner: { type:'string' },
      }, description:'progress requires exactly {summary, next}: record the result or pending dependency and who does what next. block requires {reason, condition, owner}. report requires acceptance evidence.' },
    },
    output: { schema:{ type:'string' }, render:(_args, value) => [{ type:'text', text:String(value) }] },
    async execute(args, exec) {
      const result = await workflow.invoke(exec, { action:args.action, taskId:args.task_id, roomId:args.room_id,
        expectedBoardRevision:args.expected_board_revision, query:args.query, cursor:args.cursor, parentTaskId:args.parent_task_id,
        kind:args.kind, mine:args.mine,
        ...(args.release_id === undefined ? {} : { releaseId:args.release_id }),
        ...(args.requirement === undefined ? {} : { requirement:args.requirement }),
        ...(args.operation_id === undefined ? {} : { operationId:args.operation_id }),
        ...(args.expected_revision === undefined ? {} : { expectedRevision:args.expected_revision }),
        ...(args.proposal_id === undefined ? {} : { proposalId:args.proposal_id }),
        ...(args.note === undefined ? {} : { note:args.note }),
        ...(args.change === undefined ? {} : { change:args.change }),
        ...(args.value === undefined ? {} : { value:args.value }) })
      return JSON.stringify(result)
    },
  })
  rt.teamTools.push(tool)
  return tool
}
