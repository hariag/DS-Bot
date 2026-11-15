# Queued delivery recovery review

After a restart, DS Bot may retain a queued exchange when it cannot establish whether the recipient Session already received it. The recovery board currently shows interrupted turns but not these held deliveries, so the user sees the warning only in the startup log.

The board will show only queued deliveries that recovery deliberately held. Each row is scoped to its group or personal recipient and exposes metadata only: recipient, Session, exchange ID, time and a bounded status. Message text, raw errors and unrelated groups remain private.

The user may ignore a held delivery or restore it to the review list. Ignoring durably prevents automatic resend and does not complete the associated task. Restoring a record only allows the existing recovery checks to inspect it again on a later startup; it does not send immediately. A delivery whose send outcome is unknown or whose Session history is unreadable must never be blindly replayed from the UI.

Verification covers scope isolation, metadata redaction, malformed and excessive records, durable revision-checked decisions, restart behavior, and the board interaction in a synthetic browser fixture.
