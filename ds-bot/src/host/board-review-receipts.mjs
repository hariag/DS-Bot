const marker = /^(TECH_REVIEW|BUSINESS_ACCEPTANCE) (PASS|REJECT) report_operation_id=(\S+)$/
export const reviewReceiptError = message => Object.assign(new Error(message), { code:'bot/invalid' })

export function recordReviewReceipt(task, comment) {
  if (task.acceptor === undefined) return undefined
  const matches = comment.text.split(/\r?\n/).map(line => marker.exec(line.trim())).filter(Boolean)
  if (matches.length === 0) return undefined
  if (matches.length > 1) throw reviewReceiptError('Record one review or acceptance decision per comment')
  const [, stage, result, reportOperationId] = matches[0]
  const technical = stage === 'TECH_REVIEW'
  const role = technical ? task.reviewer : task.acceptor
  if (comment.author !== role) throw reviewReceiptError(technical ? 'Only the assigned reviewer records the technical decision' : 'Only the assigned acceptor records the business decision')
  const receipts = task.reviewReceipts
  if (task.status !== 'reported' || task.stale || receipts?.reportOperationId !== reportOperationId) {
    throw reviewReceiptError('Read the current owner report and use its operation ID for the review or acceptance decision')
  }
  const receipt = { operationId: comment.id, actor: comment.author, result, at: comment.at, revision: task.revision + 1 }
  if (technical) {
    // A new verdict explicitly supersedes the technical receipt. In particular,
    // its business ACK cannot be carried over from another technical decision.
    return { reportOperationId, reportRevision: receipts.reportRevision, technical: receipt }
  }
  if (result === 'PASS' && receipts.technical?.result !== 'PASS') {
    throw reviewReceiptError('Business acceptance must follow the technical PASS on this report')
  }
  return { ...receipts, business: receipt }
}

export function requireReviewReceipts(task, evidence) {
  if (task.acceptor === undefined) return
  const { reportOperationId, reportRevision, technical, business } = task.reviewReceipts ?? {}
  if (!reportOperationId || technical?.actor !== task.reviewer || technical.result !== 'PASS'
    || !(technical.revision > reportRevision)) {
    throw reviewReceiptError('Record the independent technical PASS for the current report before closing')
  }
  if (business?.actor !== task.acceptor || business.result !== 'PASS'
    || !(business.revision > technical.revision && business.revision <= task.revision)) {
    throw reviewReceiptError('Wait for the assigned acceptor to record business PASS for the current report')
  }
  if (!evidence.split(/\r?\n/).some(line => line.trim() === `report_operation_id=${reportOperationId}`)) {
    throw reviewReceiptError('Put report_operation_id for the current report on its own line in the final review evidence')
  }
}

export const isCurrentReviewReceipt = (task, id) => task.reviewReceipts?.technical?.operationId === id
  || task.reviewReceipts?.business?.operationId === id
