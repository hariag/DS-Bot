import { registrationFields } from './board-intake.mjs'

const personalFields = ['kind', 'environment', 'evidence']
const gitFields = [...personalFields, 'targetCommit', 'targetBlob', 'acceptanceBlob']
const reviewFields = ['result', 'evidence']
const evidenceByteLimit = 8192
const receiptHint = 'On a card with acceptor, read reviewReceipts.reportOperationId with show. The reviewer records a decision on its own comment line: `TECH_REVIEW PASS report_operation_id=<id>` or `TECH_REVIEW REJECT report_operation_id=<id>`. The acceptor uses `BUSINESS_ACCEPTANCE PASS report_operation_id=<id>` after the technical PASS, or `BUSINESS_ACCEPTANCE REJECT report_operation_id=<id>` to flag a failed criterion. Use an ordinary comment to add detail without replacing a decision. The reviewer submits formal review(pass) after both PASS receipts, with `report_operation_id=<id>` on its own line in value.evidence.'
const registerHint = `register requires task_id, operation_id, room_id in private chat, and change.value {"title":"...","owner":"Bot ID or unique name","reviewer":"different Bot","acceptance":"measurable criteria"}. Allowed change.value fields are ${registrationFields.join(', ')}. Title ≤200 characters, acceptance and description ≤8192 UTF-8 bytes each. Root cards use feature (default) or bugfix. Child items require parent_task_id and default to development. Optional acceptor must be a third Bot in the room and enables separate technical review and business acceptance.`

export const OWNER_REPORT_FIELDS = 'For board_task report, send value exactly as {"kind":"personal","environment":"where you checked","evidence":"what you checked and observed"}. For Git evidence, use kind git and include environment, evidence, targetCommit, targetBlob and acceptanceBlob. Each Git object ID must contain 40 or 64 lowercase hex characters and is verified against the configured repository. Environment and evidence must be nonempty and at most 8192 UTF-8 bytes each.'
export const REVIEW_FIELDS = 'For board_task review, send value exactly as {"result":"pass","evidence":"your independent findings"}. Use "pass" for verified acceptance and "rework" for a verified failed criterion. Evidence must be nonempty and at most 8192 UTF-8 bytes. Identify the criterion, target revision, expected and observed results. Request missing or mismatched evidence on the original card before giving a verdict. On a card with acceptor, check both PASS receipts and place `report_operation_id=<id>` on its own line in value.evidence.'

function evidenceFieldError(args, error) {
  if (error?.message === 'revision conflict') {
    return new Error('revision conflict. Read the original card with board_task show. Check the original operation if its result is unknown; submit a new update only if the current card still needs it.', {cause:error})
  }
  if (args.action === 'review' && error?.message === 'cannot review') {
    return new Error('cannot review. Read the original card and verify that it is reported, current and unblocked. Follow up on the recorded blocker or missing evidence before submitting a verdict.', {cause:error})
  }
  if (args.action === 'register' && error?.message === 'invalid card details') {
    return new Error('Invalid register card details. Use feature or bugfix for a root card. For a child item, use requirement, design, feature, development, test, deployment, operations, bugfix, ui, ux or other. Description must be text of up to 8192 UTF-8 bytes.', {cause:error})
  }
  if (args.action === 'reply' && error?.message === 'invalid card reply') {
    return new Error('invalid card reply. Use note with nonempty text of up to 2048 UTF-8 bytes on your assigned draft card. Use comment for ordinary discussion.', {cause:error})
  }
  if (args.action === 'progress' && ['invalid fields','invalid progress summary','invalid next step','task progress too long','payload string too long'].includes(error?.message)) {
    return new Error('progress requires value {summary, next}. Both fields must be nonempty text of up to 1024 UTF-8 bytes each.', {cause:error})
  }
  const report = args.action === 'report'
  if (!report && args.action !== 'review') return error
  const invalid = ['invalid fields','payload string too long','invalid evidence','invalid environment','invalid evidence kind','invalid evidence identity',
    'invalid personal evidence','invalid review evidence','invalid review'].includes(error?.message)
  if (!invalid && !(report && args.value?.kind === 'git' && error?.message === 'report evidence unverified')) return error
  const allowed = report ? (args.value?.kind === 'git' ? gitFields : personalFields) : reviewFields
  const unexpected = Object.keys(args.value ?? {}).filter(key => !allowed.includes(key) && /^[a-zA-Z][a-zA-Z0-9_]{0,32}$/.test(key)).slice(0,5)
  const missing = allowed.filter(field => args.value?.[field] === undefined || (typeof args.value[field] === 'string' && !args.value[field].trim()))
  const oversized = (report ? ['evidence','environment'] : ['evidence']).flatMap(field => {
    const value = args.value?.[field]
    if (typeof value !== 'string') return []
    const bytes = Buffer.byteLength(value, 'utf8')
    return bytes > evidenceByteLimit ? [`value.${field} is ${bytes} UTF-8 bytes (limit ${evidenceByteLimit})`] : []
  })
  const hint = report ? OWNER_REPORT_FIELDS : REVIEW_FIELDS
  return new Error([error.message, missing.length ? 'Missing value fields '+missing.join(', ') : '',
    unexpected.length ? 'Unexpected value fields '+unexpected.join(', ') : '', ...oversized, hint].filter(Boolean).join('. '), {cause:error})
}

// Registration is kept separate from the journal; the host supplies the real
// DSH defineTool and the workflow instance backed by its current writer lock.
export function installTaskTool(rt, workflow, defineTool) {
  if (!Array.isArray(rt?.teamTools) || typeof workflow?.invoke !== 'function' || typeof defineTool !== 'function') throw new TypeError('Task tool dependencies required')
  const tool = defineTool({
    name: 'board_task',
    description: 'Use list/show to find work and check the original card and its revision. Check for duplicate IDs and register a unique task (T-<DOMAIN>-<NNNN> or T-SUB-<DOMAIN>-<NNNN>) before work. Registration records a card without dispatch. Use the original task_id, current expected_revision and a stable operation_id for each exact update. If its result is unknown, read operation with the same task_id and operation_id before retrying. Owners start, record progress and report evidence. The independent reviewer verifies acceptance and records a verdict. Check parent state after child updates. Use the returned itemsQuery to read children, including group-goal items. Finish their independent reviews before reporting the parent. Respect paused goals, dependencies, authorization and the 30-step turn budget.',
    parameters: {
      action: { type:'string', required:true, enum:['list','register','show','operation','reply','start','progress','report','review','block','unblock','comment','propose','proposal','plan'], description:'Task action; plan asks the host to create the release lifecycle task chain' },
      task_id: { type:'string', description:'Original card ID from show/list. Required for register, show, operation, reply, start, progress, report, review, block, unblock, comment and proposals for an existing card.' },
      room_id: { type:'string', description:'Exact group ID. Copy task.roomId from show; scope includes a room: prefix and cannot be used as room_id. A group session is restricted to its own room.' },
      parent_task_id: { type:'string', description:'Parent feature or bugfix for a task item; use with list to see its items.' },
      query: { type:'string', description:'Filter list by stable ID or case-insensitive text; searches completed work as well.' },
      kind: { type:'string', enum:['card','item','group_goal','shared','proposal','release'], description:'List one type of record. Use release to find minor releases by name, version or ID in the selected group.' },
      mine: { type:'boolean', description:'List only tasks assigned to you as owner, reviewer or acceptor.' },
      cursor: { type:'string', description:'Continue the same list with its nextCursor.' },
      release_id: { type:'string', description:'Minor release ID in the selected group. Use with list to include its cards and items, including completed work, or with plan or register.' },
      requirement: { type:'string', description:'Requirement text for plan' },
      operation_id: { type:'string', description:'Required for register, comment, reply, start, progress, report, review, block and unblock. Use the same ID for identical retries and for action operation. Use a new ID for a changed update.' },
      expected_revision: { type:'integer', description:'Current task.revision from show, required for comment, reply, start, progress, report, review, block and unblock. Also required when proposing a title or acceptance edit.' },
      expected_board_revision: { type:'integer', description:'For a group-goal reply, use legacy.boardRevision from show along with expected_revision.' },
      proposal_id: { type:'string', description:'Proposal ID returned by propose, when checking a proposal' },
      note: { type:'string', description:'Text for comment or reply, up to 2048 UTF-8 bytes. Use task_id, current expected_revision and a stable operation_id. Reply records a draft or goal-item note. Use @Name in a comment to add and notify a participant. A proposal note is optional and up to 2000 UTF-8 bytes. '+receiptHint },
      change: { type:'object', additionalProperties:false, properties: {
        kind: { type:'string', enum:['create','update','status','release'] },
        value: { type:'object', additionalProperties:true, description:'create: card fields (title, owner, reviewer, acceptance, description, type, labels, dueDate, dueComplete, checklist, dependencies, draft). update: description, type, stage, labels, dueDate, dueComplete and checklist. On an undispatched draft or proposed card, the owner or reviewer can include title, description and acceptance together. Use the original task_id, current expected_revision and a stable operation_id. status: {type: submit|cancel|restore, reason?}. release: {releaseId}.' },
      }, description:registerHint+' With propose, the user confirms or rejects a content, status or release change in the board Changes panel. Read it with proposal.' },
      value: { type:'object', additionalProperties:false, properties: {
        summary:{ type:'string' }, next:{ type:'string' },
        kind: { type:'string', enum:['git','personal'], description:'Evidence kind for report only.' }, evidence: { type:'string' },
        targetCommit: { type:'string' }, targetBlob: { type:'string' }, acceptanceBlob: { type:'string' }, environment: { type:'string' },
        result: { type:'string', enum:['pass','rework'] }, reason: { type:'string' }, condition: { type:'string' }, owner: { type:'string' },
        itemTaskIds: { type:'array', items:{type:'string'}, description:'Optional child task IDs affected by a block.' },
      }, description:'progress requires {summary, next}, up to 1024 UTF-8 bytes each. block requires {reason, condition, owner}, with user or an in-scope Bot ID as owner. Each reason or condition is up to 8192 UTF-8 bytes. '+OWNER_REPORT_FIELDS+' '+REVIEW_FIELDS },
    },
    output: { schema:{ type:'string' }, render:(_args, value) => [{ type:'text', text:String(value) }] },
    async execute(args, exec) {
      const input = { action:args.action, taskId:args.task_id, roomId:args.room_id,
        expectedBoardRevision:args.expected_board_revision, query:args.query, cursor:args.cursor, parentTaskId:args.parent_task_id,
        kind:args.kind, mine:args.mine,
        ...(args.release_id === undefined ? {} : { releaseId:args.release_id }),
        ...(args.requirement === undefined ? {} : { requirement:args.requirement }),
        ...(args.operation_id === undefined ? {} : { operationId:args.operation_id }),
        ...(args.expected_revision === undefined ? {} : { expectedRevision:args.expected_revision }),
        ...(args.proposal_id === undefined ? {} : { proposalId:args.proposal_id }),
        ...(args.note === undefined ? {} : { note:args.note }),
        ...(args.change === undefined ? {} : { change:args.change }),
        ...(args.value === undefined ? {} : { value:args.value }) }
      try { return JSON.stringify(await workflow.invoke(exec, input)) }
      catch (error) { throw evidenceFieldError(args, error) }
    },
  })
  rt.teamTools.push(tool)
  return tool
}
