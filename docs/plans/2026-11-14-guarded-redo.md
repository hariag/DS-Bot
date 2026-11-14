# Guarded single-work redo: disabled experiment

Status: isolated WIP. No Host endpoint installs this code; the current DSH and
DS Bot production versions cannot safely perform this redo. The experiment
must not be enabled or treated as a completion, result-delivery or exactly-once
guarantee. A confirmation is permission to try; external effects can repeat.

The intent is keyed by the original held record, so another scope or a second
click cannot create a second operation. The record binds the original work,
sender, recipient, scope, Session, turn, message sequence, complete durable
boundary and exact text-only original message. Unsupported or missing source,
attachments and unavailable authority fail closed. An uncertain write or send
remains unknown and cannot be retried under another identity.

`guarded-redo-journal.mjs` stores the intent in a private SQLite file, with full
sync and a two-stage claim. A `claiming` record is committed before the Agent's
synchronous claim callback; if callback or the next commit fails, the record
stays claiming and cannot be claimed again. The SQLite and Session journals are
separate durable domains: this is a fence against re-admission, not an atomic
transaction across files or proof the business operation completed.

`guarded-redo-bridge.mjs` does not install an Agent coordinator. A Host must
register one shared coordinator before Agent restoration; it must integrate
existing board claims and reject mixed batches before any claim. It must supply
an independently verified target-writer Session prefix, current membership,
scope and lease checks, and a versioned original-result authority actually
bound to the Agent result route. The existing `answerSender`/`closeWork` path
does not supply a unique durable original-recipient receipt. Until such a path
exists, `resultAuthority`/`isResultRouterBound` cannot legitimately authorize
the bridge, and the UI must say redo is unavailable.

The `agent/pre-step` event in the production Harness occurs after inbox claim.
Rejecting a mixed batch there may lose already removed input. This experiment
uses only the guarded pre-claim coordinator API from an isolated Harness WIP;
it never uses ordinary `followup` or pre-step rejection to protect messages.

Before any rollout, implement and independently verify the real original-work
settlement authority and target writer proof; test concurrent normal inputs,
stop/membership revocation, loss at every cross-store boundary, restart and
actual sender result deduplication. A simulated Agent test cannot prove that an
external action ran exactly once, that a work was completed, or that its
original recipient received a result.
