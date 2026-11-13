# Task boards and continuous execution

Status: implementation in progress. Board editing and storage can be tested independently; automatic task dispatch must stay disabled until the admission and recovery integration is complete and verified.

## Goals

Give each group and each personal scope its own editable task board. Record a stable task identity, owner, independent reviewer, acceptance criteria, dependencies, status, evidence and version. A group may expose a limited read-only view of a task to another group only through an explicit grant. The existing group-goal aggregate remains a separate, read-only projection until it is deliberately linked to task records; adding a card must not silently replace or complete an existing goal.

Task state and task execution are separate. A report is not acceptance, a queue entry is not proof of execution, and a finished turn is not proof that acceptance criteria passed. Existing pauses, stops, unknown outcomes, user decisions and external blockers remain binding.

## Board storage and editing

Use a private, durable task journal with stable IDs and revision checks. Editing, state transitions, sharing and image changes must be authorized in the requested scope and use an operation ID with a queryable outcome. A repeated operation with the same ID and input returns the recorded result; conflicting reuse is rejected. When an answer is lost, query the original operation. If an uncommitted operation is explicitly cancelled, persist a tombstone that prevents its late completion; do not invent a new operation ID to replay an uncertain change.

Group grants carry only the fields the source explicitly allows and are revocable. Shared cards cannot be edited from the target scope. Dependency checks must bind to the grant and current evidence; revocation or evidence invalidation must fence affected pending actions and hold already claimed actions for reconciliation.

Image attachments are authorized per task, not exposed as public file paths. Validate image bytes and decoded dimensions in a bounded worker before committing references. The current candidate accepts JPEG and non-interlaced PNG, with at most 20 images per task, at most 10 per upload, 5 MiB per image and 20 MiB per batch. A determinate validation rejection is recorded; transport, worker or persistence outcomes that cannot be determined remain unknown until reconciled or explicitly cancelled.

## Continuing work safely

Once authorization, dependencies, ownership and capacity are established, a durable action can be admitted as soon as the relevant event occurs. Periodic inspection is a fallback to find missed changes, not a prerequisite for every action. Work with conflicting write scopes or ordering requirements remains serial; unrelated work may proceed independently. A long task should leave a durable checkpoint and continue in bounded turns, with a target of at most 30 model steps per turn. A hard limit is not provided until the runtime enforces and tests a safe continuation boundary.

The task ledger and DSH session log are separate stores. Their writes must not be described as one atomic transaction. Reserve the full immutable intent and identity before attempting admission; require a fenced, synchronous claim against current task permissions and dependency state. If a process stops or a commit result cannot be established, retain the original intent as uncertain and do not automatically replay it. Reconciliation must identify the same target session, message and action, and verify durable evidence before deciding whether to continue.

No local fence can guarantee exactly-once effects in an external system that has no transactional or idempotency support. An uncertain external side effect must remain pending investigation rather than being retried under a new identity.

## Remaining integration and verification

- Connect the task driver to actual DSH admission and recovery, including durable cancellation and startup reconciliation, before enabling automatic dispatch.
- Validate concurrent revocation, cancellation and process termination at each boundary between the task database, session journal and external operations.
- Define an explicitly guarded, backed-up migration for any existing board database; an absent lock alone does not prove a running host is offline.
- Exercise editing, multiple-image upload and authorization in real group, personal user and Bot scopes, including refresh, interruption, scope changes and stale revisions.
- Build the generated client and run the repository's unit, lint and isolated mock-host checks on the exact revision intended for deployment.

The board host tests are part of `npm test` in `ds-bot/`. The separate browser fixture runs with `npm run test:board:browser` after installing the plugin's development dependencies and setting `DSH_HARNESS` to a local Harness checkout. Set `CHROME_PATH` if Chrome is not at its default executable path. Both use synthetic data; neither should use a real user's DSH data.
