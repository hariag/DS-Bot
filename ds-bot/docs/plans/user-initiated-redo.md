# User-initiated redo in an isolated Session (WIP)

This design is not installed and must not be presented as working. A user may
explicitly request a new attempt only after being told that the original could
already have changed files or sent messages and that a new attempt may repeat
those effects. The original work and its unknown outcome remain unchanged. A
new result belongs to the authenticated user-facing recovery record, not the
original requester or the group transcript.

The user operation has one stable UUID, new Session ID, input ID and admission
ID. The authenticated board scope, recovery ID, exact verified original text,
source Session and turn are bound before Session creation. The record must be
durably committed before execution; uncertain persistence, Session creation,
admission or result evidence is `unknown`, never a reason to issue a new ID.
The original `source` is evidence only: copying its `role`, work, exchange or
group routing into the new input can close the original work or post to a group.
The new input needs a neutral redo-specific source and a content digest.

The initial journal is deliberately not connected to an endpoint or an Agent.
Its `prepared` state does not mean an Agent was created or work was done. Its
proof callback is an internal Host contract, not a boolean configuration or a
substitute for actual original Session evidence. The Host must authorize the
current user and scope using the board API, obtain a fixed live target-writer
prefix and verify the exact held turn and unique original message; missing or
ambiguous evidence is unavailable. Unsupported attachment content must not be
silently omitted. Original text is sensitive and is never returned by the
metadata list without the same current authorization.

Before enabling this path, implementation and real Host tests must establish:

* a durable, separate redo Session identity/scope, without adding it to the
  ordinary `groupOwners` or `chatOwners` indexes; no guessed re-creation after
  a lost creation response;
* the actual Bot role, model, workspace, scoped tools and permission limits
  on that exact Agent, with current group membership and lease rechecked across
  asynchronous boundaries; ordinary initialization logs warnings and is not
  proof these limits were applied;
* isolation from automatic part switching, pending input injection, group
  waiters, broadcasting, original work settlement and unsafely scoped memory;
* guarded admission with a unique shared coordinator and durable target-writer
  receipt, preserving every existing inbox input; no normal `followup` fallback;
* a result obtained from the fixed, persisted new Session turn and shown only
  to the still-authorized user. A completion event alone is not proof of
  downstream or external effects, and a missing result is not proof of absence;
* crash, restart, duplicate request, altered request, scope revocation, source
  change, Session collision, mixed inbox, failed save and lost-response tests,
  followed by real fake-home DSH and browser checks.

The currently deployed e8 Harness lacks the guarded API and must report this
feature unavailable. Neither this plan nor the journal implies exactly-once
external side effects, nor permission to modify production state.
