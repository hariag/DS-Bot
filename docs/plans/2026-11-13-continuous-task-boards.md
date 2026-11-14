# Task boards and continuous execution

Status: implementation and local verification complete on `wip/board-change-requests-20261114`; push/merge to the fork and production deployment remain pending. Production history and queue state have not been verified because 10.10.0.215 was unreachable from the build host.

## Goals

Give each group and each personal scope its own editable task board. Record a stable task identity, owner, independent reviewer, acceptance criteria, dependencies, status, evidence and version. A group may expose a limited read-only view of a task to another group only through an explicit grant. Existing group-goal cards refer directly to the original Goal task, using a stable room/goal/stage/task identity; they do not create a second task. A user may update the current task description, note, permitted progress, card details and images through the original Goal. Card details and image references are retained with the original goal, and a stage rebuild is refused while it would discard them. Stage acceptance and completion remain governed by the Goal workflow; checking a card item does not complete work. Editing an active or completed task creates a separate immutable change-request task that records before/after values and depends on the source task, so accepted work is not silently rewritten.

Images on Goal cards are attached to the original task, with references and operation receipts saved in the same team-state snapshot. Image bytes are durably published before the reference; a failed or uncertain state save never reports success. Earlier stages and archived Goals retain readable attachments, while rebuilding a stage containing images is refused until those references are deliberately preserved and removed.

Task state and task execution are separate. Moving a schedulable Bot task from a waiting lane to a runnable lane creates a durable scheduled action. The card becomes ready only after admission is recorded; it becomes working when the Bot claims it. A report is not acceptance, a queue entry is not proof of execution, and a finished turn is not proof that acceptance criteria passed. Existing pauses, stops, unknown outcomes, user decisions and external blockers remain binding.

The instance owner's own unregistered personal cards may additionally carry a
personal progress marker: to do, doing, or personally finished. This marker is
written through the same durable operation receipt and revision checks as other
edits, but is distinct from the task's verified workflow status. It never
creates an Agent action, completes a task, or unblocks a dependency. A user can
move these cards by dragging or by using the keyboard-accessible progress menu.
Group cards, Bot-owned cards, and personal cards already in the verified workflow
use real workflow transitions instead of this personal marker. Each lane allows
manual task creation; adding to a runnable lane records the task before scheduling
it. Board colors come from the Harness theme, and lane navigation expands to the
available viewport without a horizontal scrollbar.

## Board storage and editing

Use a private, durable task journal with stable IDs and revision checks. Editing, state transitions, sharing and image changes must be authorized in the requested scope and use an operation ID with a queryable outcome. A repeated operation with the same ID and input returns the recorded result; conflicting reuse is rejected. When an answer is lost, query the original operation. If an uncommitted operation is explicitly cancelled, persist a tombstone that prevents its late completion; do not invent a new operation ID to replay an uncertain change.

Group grants carry only the fields the source explicitly allows and are revocable. Shared cards cannot be edited from the target scope. Dependency checks must bind to the grant and current evidence; revocation or evidence invalidation must fence affected pending actions and hold already claimed actions for reconciliation.

Image attachments are authorized per task, not exposed as public file paths. Validate image bytes and decoded dimensions in a bounded worker before committing references. The current candidate accepts JPEG and non-interlaced PNG, with at most 20 images per task, at most 10 per upload, 5 MiB per image and 20 MiB per batch. A determinate validation rejection is recorded; transport, worker or persistence outcomes that cannot be determined remain unknown until reconciled or explicitly cancelled.

## Continuing work safely

Once authorization, dependencies, ownership and capacity are established, a durable action can be admitted as soon as the relevant event occurs. Periodic inspection is a fallback to find missed changes, not a prerequisite for every action. Work with conflicting write scopes or ordering requirements remains serial; unrelated work may proceed independently. A long task should leave a durable checkpoint and continue in bounded turns, with a target of at most 30 model steps per turn. A hard limit is not provided until the runtime enforces and tests a safe continuation boundary.

The task ledger and DSH session log are separate stores. Their writes must not be described as one atomic transaction. Reserve the full immutable intent and identity before attempting admission; require a fenced, synchronous claim against current task permissions and dependency state. If a process stops or a commit result cannot be established, retain the original intent as uncertain and do not automatically replay it. Reconciliation must identify the same target session, message and action, and verify durable evidence before deciding whether to continue.

No local fence can guarantee exactly-once effects in an external system that has no transactional or idempotency support. An uncertain external side effect must remain pending investigation rather than being retried under a new identity.

## Local verification and remaining rollout

The implementation now connects the durable task driver to DSH's synchronous message-admission boundary. It records the task intent before admission, fences a changed authorization/dependency state immediately before the message enters the Session, writes a receipt after admission, and retains uncertain outcomes for reconciliation instead of replaying them. Startup recovery and cancellation use the same stable action identity. Active/completed edits become separate change requests with before/after values; lane drops and per-lane creation go through the durable board operation API.

The locally verified revision contains the upstream `main` history and fork `main` as ancestors. Verification on 2026-11-14: `npm run build` passed; `npm test` passed (2,834 passed, 4 skipped, 0 failed); the browser board suite passed; isolated mock-host smoke passed all 52 steps; `npm run lint` exited 0 with existing warnings; generated-client and diff checks passed. The browser and smoke fixtures used synthetic data and were stopped after the run.

Remaining rollout work:

- Push the reviewed branch to `hariag/DS-Bot`, open and merge a pull request into the fork's verified default branch (`main`), then re-fetch and compare the merged content.
- Review production task queues, uncertain receipts and service logs on 10.10.0.215, then deploy the merged revision with a verified backup and post-deployment health/UI checks. The build host currently reports `No route to host` for 10.10.0.215, so production history and deployment are not yet verified. Do not use or restart 10.10.0.180; its 8888 proxy must remain available.
- Before changing any existing board database, define an explicitly guarded, backed-up migration; absence of a lock alone does not prove a running host is offline.

The board host tests are part of `npm test` in `ds-bot/`. The separate browser fixture runs with `npm run test:board:browser` after installing the plugin's development dependencies and setting `DSH_HARNESS` to a local Harness checkout. Set `CHROME_PATH` if Chrome is not at its default executable path. Both use synthetic data; neither should use a real user's DSH data.
