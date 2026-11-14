# User-requested redo isolation audit (WIP, disabled)

Read at 2026-11-14 15:32 Asia/Shanghai. DS Bot source: commit
`38d39a08e59bf6b86a1774961f3e4649aea683c7`. The matching experimental
Harness source reviewed here is `1e676e202d5f06f35728cb2ad878f4697ccd8273`.
Neither revision establishes that redo is enabled or safe in production.
This note is a static audit; it is not an end-to-end test result.

## Contract

The authenticated user may choose to submit the exact displayed business text
as one new operation, in a clearly identified Bot and group or personal scope.
The display must state that the old result is unknown, that external effects
may repeat, and that the old work remains unresolved. The user confirms the
scope, complete text and warning version. In particular, this is not proof of
the historical producer or that the old work did not execute. No IM delivery,
original-work settlement, original-requester reply or automatic group dispatch
is implied by that confirmation.

Only text-only, complete, uniquely selectable business inputs can be offered;
system inspection, kickoff, review and mixed or ambiguous records must not be
converted into tasks. A candidate matched on a timestamp alone is not a proven
historical producer. If a user confirms an explicitly labelled candidate as a
new instruction, that authorization still requires the complete fixed writer
prefix and a well-defined scope; it does not certify historical authorship.

## Findings about the original-Session approach

The prototype routes only `turns.js` and `resume.js` through a process-local
`redoTurnRoute.isolate` listener. The following paths are outside that fence:

* `src/host/im/index.js:1019` maps Bot own-chat assistant entries through
  `displayItems` and sends them to the configured IM listeners. In particular,
  redoing in an own-chat Session could send output externally without a separate
  authorization. `feed.js:75` also publishes messages and `feed.js:86` publishes
  stream frames. `mobile.js:216` creates notices for unhidden assistant turns.
* `parts.js:1554` displays assistant events unless their turn is hidden by
  `exchangeTurns`; `parts.js:1839` updates own-chat preview from those events.
  `historyEntry` and `partLines` at `parts.js:134` and `:376` can attribute an
  assistant answer to a prior input, because the redo source is not a normal
  recognized input. `chat-index.js:137` uses the same projection for indexing;
  `memory.js:1012` uses it for source attribution. Merely suppressing live
  `turns.js` cannot fix replay after restart or consumers of saved history.
* `parts.js:1269` runs an earlier pre-step handler after inbox claim. A past
  part may call `forward` at `:874`, recreating an input with a new message ID
  and using ordinary `inject` for this redo source. A context/folder/model
  switch can also carry claimed inputs. Such a transfer is outside the guarded
  admission and may break one-operation fencing or result attribution.
* The original Session's persisted message history and Harness projections,
  trajectory/stream consumers and subsequent model prompts can contain the
  redo. Hiding one DS Bot display is not an isolation boundary. Team tools such
  as `message_bot` and `post_to_group` can create further work; the ordinary
  tool guards are not a general no-dispatch or no-external-effects sandbox.

Simply adding the turn to `exchangeTurns` is insufficient: it is maintained
asynchronously and bounded, other history paths do not consistently consult it,
and it does not prevent model/tool side effects. Process-local routing also
cannot classify events after a crash or plugin reload. `computer/index.js:889`
and `steer.js:227` demonstrate additional per-turn observers whose behavior must
be evaluated; filtering them blindly could break lease cleanup or ordinary
steering. Usage should still be accounted for.

## Options and recommendation

**Separate Session is the smaller verification surface** for a user-only
result. Give the operation a durable unique Session identity and do not add it
to chat, group, part or ordinary Bot-owner indexes. That keeps the default
IM/feed/mobile/chat projections from treating its results as a normal chat.
Do not assume it receives the original Session's context: display that limit
and make any explicitly selected, scoped context observable to the user.
Bind a dedicated immutable redo principal containing the Bot, group, operation
and authorization generation; neither make it a private Bot merely by setting
`selfOf` nor insert it into `groupOwners`. The current `tools.js:58-61` and
`:263` derive room restrictions from those ordinary indexes, so a new explicit
caller-scope API and a complete tool-by-tool audit are necessary. Revocation or
scope mismatch must fail closed.

Build a small allowlist, not a claim of full tool parity. Initially only permit
capabilities whose effective enforcement can be demonstrated for the new
Session, with explicit denial of messaging, posting, scheduling, connectors,
subagents, computer control, shell and arbitrary execution unless a stricter
runtime boundary is independently proven. A text-only result may be useful for
analysis but does not implement a code-changing redo; the UI must say exactly
which operations are unavailable. Add workspace file tools only when the
actual file backend enforces a bounded root and excludes the DSH state and
communication paths; verify symlink and backend behavior, not just the preset
name. A backend without enforceable confinement, a `danger-full-access`
original, or a changed policy cannot be called a successful permission clone.
Do not silently run reduced capabilities as though the old job completed.

The original-Session alternative would require a durable `(session, turn,
start-seq, operation)` identity before any output, a crash-recoverable authority
that classifies every event consistently, fail-closed interception of all live
and historical consumers above, explicit prevention of part forwarding, and a
Harness-level decision about whether subsequent normal model contexts include
the redo. It also needs enforced tool restrictions for the specific turn,
including subprocess lifetime. Even if an interface calls the operation
public in its group, the private-chat IM path still cannot be assumed
authorized. This option has substantially more cross-product readers and is
not ready to enable.

## Minimum implementation and acceptance sequence

1. Finish the independent witness/journal review: stable operation, message and
   admission IDs; current principal and scope; no creation of a replacement
   operation after an uncertain write; fixed original writer and source proof.
   State and journal missing or disagreeing must remain unknown. Coordinated
   rollback of all local data cannot be detected without an external monotonic
   witness. Never store the source text in a world-readable state file.
2. Add a private operation Session creation path using an explicit redo owner
   and scope, without ordinary ownership aliases. Confirm the exact resulting
   Session/Agent, current group membership, workspace, model and allowed tool
   definitions. Enforce the documented per-operation restrictions in the real
   execution backend. A registration failure leaves the button unavailable.
3. Install one shared guarded admission provider before Agent publication,
   with a durable claim and target-writer receipt. Guarded replays use the same
   identities; never fall back to `followup`/`inject` or auto-retry unknown
   admission. Reconcile reload and a lost result without closing the old work.
   Verify the final post-hook model-visible input batch and effective tool set
   before the first model call; an earlier exact claim cannot prove that later
   pre-step hooks did not add or replace inputs. Capture and authorize the
   exact persisted result separately.
4. Add an authenticated preview and confirmation endpoint and a concise UI
   only after the preceding authority is real. Bind the confirmation digest to
   the scope, exact full text, identity and warning; revalidate at admission.
   Do not expose original text to Bot-facing endpoints or logs.
5. Test a real fake-home DSH, real Host, real Session/Agent/JSONL and a mock
   model: two clicks, lost response, crash at each persistence boundary, reload,
   journal loss/mismatch, membership changes, multi-input ambiguity, old
   sessions, source/control/attachment exclusion, ordinary queued work ordering,
   and a part switch. Install a fake IM listener and feed/mobile subscribers;
   verify no output or notification escapes. Verify no old-work completion,
   reply, group dispatch or unauthorized tool execution. Inspect historical
   views, search and the next ordinary model prompt after reload. Add negative
   controls that actually demonstrate each test catches its intended failure.
6. Deploy only the matched, reviewed Harness and DS Bot artifacts after their
   compatibility and rollback behavior are checked. Existing older readers
   may fail closed on new guarded-admission events; rollback is not assumed
   seamless. Preserve interrupted work and recheck real queue identities.

No source changes in this audit enable an endpoint, admit an operation, alter
production state or authorize a message to an external recipient.
