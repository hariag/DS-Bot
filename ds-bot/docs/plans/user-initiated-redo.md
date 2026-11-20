# User-initiated redo in an isolated Session (WIP)

This design is not installed and must not be presented as working. A user may
explicitly request a new attempt only after being told that the original could
already have changed files or sent messages and that a new attempt may repeat
those effects. The original work and its unknown outcome remain unchanged. A
new result belongs to the authenticated user-facing recovery record, not the
original requester or the group transcript.

The user operation has one stable UUID, new Session ID, input ID and admission
ID. The authenticated board scope, recovery ID, exact verified original text,
source Session and turn are bound before Session creation. Only the input ID
and digest are saved in team state; the text and source must be re-read from
the authorized original Session. The record must be
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
The user must see the exact proposed input before confirmation, including that
prior context is not automatically reproduced. Confirmation must be bound to
its digest. A turn containing multiple inputs is unavailable until it can be
represented faithfully; inspection, review and kickoff controls may not be
converted into ordinary work.

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

The separate Session identity currently has a deny-all tool guard and a role
prompt, but there is no Session creation or dispatch path. Denying every tool
is a fail-closed floor, not evidence that original-scope tools are available
or that a redo can usefully finish. Actual Agent setup must also establish the
non-tool boundaries before enabling any input.
The separate tool-parity helper is diagnostic only. Equal preset, sandbox
policy and tool definition cannot establish equal authorization: scope-aware
guards and wrappers can differ per Agent, actual backends may not enforce the
resolved policy, dynamic cwd can differ, and shell can bypass tool-name
restrictions or continue in the background. Group file read boundaries and
revocation need independently verified enforcement before any tool is allowed.

The ordinary routing indexes are not suitable for this new identity. In
`turns.js`, original room inputs can enter the group waiter and late-reply
paths, while request inputs can settle the referenced work. `turns.js` also
injects pending input for `isBotSession`; `parts.js` can switch an indexed
Bot Session to another part. None of those behaviors may run on the new
operation. A standalone redo identity must supply the Bot prompt without
making these existing ownership predicates true. Giving only `selfOf` a new
mapping is also insufficient: callers of that predicate and memory/tools
must be audited independently for privilege and scope.

An original group must remain the tool authorization boundary. In particular,
the current team tools derive the caller room from `groupOwners`; presenting
the redo as a private Bot can permit destinations not present in that group.
Team tools, memory, shell/file operations, `run_code`, connectors and subagents
need verified runtime restrictions, including after configuration changes.
If a required restriction cannot be positively established, block admission;
role text or a successful call to `applyPermission` is not sufficient proof.
The session setup also has to select and verify the intended model and working
directory; the ordinary group setup logs and continues on some failures.

The currently deployed e8 Harness lacks the guarded API and must report this
feature unavailable. Neither this plan nor the journal implies exactly-once
external side effects, nor permission to modify production state.
