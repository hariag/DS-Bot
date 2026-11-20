# Offline inbox audit: evidence and limits

`ds-bot/src/host/inbox-audit.js` is a metadata-only fold. It is not wired into
runtime dispatch or recovery, does not read production files, and cannot send,
acknowledge, replay, or alter messages. It records each identity and position
in an insertion and removal batch, not message contents. Results describe only
the supplied log: `pending-in-log` means currently in the reconstructed inbox;
`entered-in-log` means an unambiguous single insertion and removal followed by
one matching `user/message` with no cancellation or exchange-ID conflict.
All other nonpending histories are `uncertain`. Neither status proves a task
completed or that its external effects happened once.

Session files begin with a session header without an event sequence number;
exclude that header, then pass the real events starting at sequence 0. The
caller must supply the complete history from session sequence 0 through a
separately verified exclusive durable boundary. The fold rejects missing,
duplicate, or out-of-order sequence numbers, invalid splices, duplicate pending
IDs, and a mismatch with that boundary. Checking a caller-provided number does
not prove the source is complete or durable: obtain it from a consistent
snapshot and independently establish that the actual writer durably persisted
the prefix. `ctx.sessions.flush` alone only says a listener participated.
The result does not establish the live in-memory state, which can have advanced
past the snapshot, or any external side effect.
Untracked `user/message` admissions are counted; reused IDs, cancellation,
duplicate admissions, and conflicting exchange IDs preclude inferring entry for
that identity. Migration to a different session or ID cannot be matched from
these facts alone. A pending record can include a prior cancellation or reuse;
its status merely states current projected membership, not delivery safety.

In the inspected DSH checkout `fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159`, claim
records an inbox deletion before recording `user/message`. The live claimed
event is not a durable claim record. A crash between those events is ambiguous,
as are cancellation and incomplete migration. Session event listeners run
after append and listener failures do not roll it back; they cannot create an
atomic outbox merely by observing those events. The existing experimental group
outbox and ledger `flushRequired` are not integrated into group dispatch.

Do not automatically replay any uncertain record. A complete recovery barrier
requires independently verified source coverage, durable capture before the
controlled sending boundary, stable recipient-scoped IDs and ordering, plus
recipient deduplication or reconciliation of side effects. These components
are not established by this module, so no end-to-end no-loss or exactly-once
claim follows. Reconcile ambiguous records against recipient and business
evidence before any authorized manual action.
