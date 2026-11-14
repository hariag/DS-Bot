# Durable return of recovered work results

A recovered Bot turn must return its result to the original work requester. The admission of the recovered input, the generation of the result, the durable insertion of a reply, and the requester's consumption of that reply are separate events. None establishes that arbitrary external effects happened once.

## Authority and identity

Before admitting a redo, bind its recovery ID to one original work, the worker's exact Session and original input, and the requester's exact Session and scope. The binding is established only from current, durable original evidence and the original work under the team lock. A historical work whose original requester Session cannot be established stays unavailable; do not substitute the requester's current Session or another group. Scope or ownership changes invalidate admission.

Reserve one permanent operation for each `(recoveryId, workId, requesterSessionId)`. It contains stable reply exchange and message identities, a binding fingerprint, and the original work's immutable routing fields. An identical reservation is idempotent; a different binding or payload under the same identity is a conflict. Reservations and operation receipts are retained, not expired by time or queue size.

## Result and delivery

After the guarded worker turn ends, read its exact durable Session prefix through the target writer barrier, verify the live Session identity and fixed sequence, bind the completed turn to the admitted input, and extract the complete result. A failed, canceled, truncated, switched, ambiguous, or unreadable turn is not a completed result. Outstanding child work and independently required review keep the work open. Protect the complete result and its digest before naming it in a reply; unsupported long or attachment-bearing results remain unresolved rather than being silently truncated.

Prepare the immutable reply and its stable message ID in a durable outbox before attempting delivery. Keep the original work intact while the delivery or its persistence is unknown. Store the work's eventual settlement and its outbox receipt in the same durable team-state snapshot, with lease validation, file and parent-directory fsync, and a reread of the committed identities. If persistence cannot be confirmed, fence the operation and report unknown; never infer a failed send from a missing reply or generate another ID.

The target Agent must offer guarded admission that persistently deduplicates the stable message ID, confirms the original inbox insertion and release on the target writer before execution, and preserves unrelated queued messages. A single coordinator validates the complete selected claim against the durable outbox and work binding. A guarded send response is an admission result, not proof of model consumption or business completion. A pending observation is not sufficient to authorize a second send. An absent Session event, lost response, or failed persistence operation remains unknown until exact positive evidence or an explicitly safe reconciliation exists.

The original result can be marked returned only after evidence binds the exact reply, target Session and durable admission. Consumption and any resulting model action are separate facts. Do not close or recreate an original work solely because a synthetic receipt, a queue count, or a successfully initiated send exists. Existing result and retry paths must be made exclusive with the new authority before it is installed.

## Proposed integration boundary

The bridge obtains a capability `{version: 'durable-original-result-v1', isCurrent(), claimOriginalResult(input), readResultReceipt(key)}` only after an authoritative durable route reservation. `claimOriginalResult` verifies the actual completed guarded turn and prepares the outbox; `readResultReceipt` only reports positively supported facts and returns unknown for missing, unreadable or ambiguous evidence. A real Host integration must bind its unique result handler and guarded coordinator to the same capability. The capability is unavailable by default until that integration and its crash tests exist.

The implementation is staged independently: neither an in-memory test double nor a SQLite commit makes the DS Bot team state and a DSH Session one atomic transaction. Failure between those domains must remain observable as unknown. Safe retry of external messages, commands, HTTP requests, filesystem edits, or other side effects requires an idempotent or transactional guarantee from each effect's own system; this outbox does not supply that guarantee.
