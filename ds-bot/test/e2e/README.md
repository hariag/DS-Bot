# Task-board end-to-end check

`board.e2e.mjs` starts an isolated bench (mock model + the npm-installed `dsh web` from `ds-bot/dev/harness`, with this checkout linked into a throwaway `DSH_HOME`), seeds two public Bots and a room through `POST /api/bot`, then drives the real Web UI with Playwright/Chrome. No DeepSeek Harness source checkout is needed; `npm run harness` installs the official packages.

It deliberately ignores the ambient `DSH_HOME`: the bench home defaults to
`<repo>/.dsh-test-board-e2e` and can be changed with `BOARD_E2E_HOME`. Never point it at
`~/.dsh` or at a DSH that a person is using.

## Run

From `ds-bot/`:

```sh
node test/e2e/board.e2e.mjs --fresh     # wipe the bench home, run, stop the bench
node test/e2e/board.e2e.mjs             # reuse the existing bench home
node test/e2e/board.e2e.mjs --keep      # leave the bench up for debugging
node test/e2e/board.e2e.mjs --headed    # show Chrome
```

or:

```sh
npm run test:board:e2e -- --fresh
```

The mock model must be reachable on `BOARD_E2E_MOCK_PORT` (default 8797); `dsh web` uses
`BOARD_E2E_WEB_PORT` (default 3097). Stop every bench the run started; the script does this
unless `--keep` is given.

## Artifacts

Each run writes `test/e2e/artifacts/<run-id>/results.json` plus numbered PNG screenshots.
`results.json` lists every scenario as `PASS`, `FAIL` or `SKIP`, with evidence such as the
API payload, the selector used, and the first lines of page text on a failure.

The current scenarios cover:

1. opening the board and rendering all workflow lanes;
2. quick-add and the full create dialog (title, owner, reviewer, acceptance, description);
3. same-lane drag reorder and cross-lane drag dispatch;
4. the Bot delivery receipt reaching `accepted` rather than `uncertain`;
5. description editing, labels, due date and checklist;
6. comment posting, the 2048-byte limit, editing and deleting;
7. unsupported-file rejection, PNG upload and decode, and choosing the uploaded image as
   the card cover;
8. reload persistence for the card, lane, labels, due date, checklist, comment, image and
   description;
9. no uncaught page errors and no console errors.

The separate browser fixture (`npm run test:board:browser`) mounts `task-board.js` against
synthetic requests; it covers recovery/review panels, read-only, capacity, personal
progress and command payload edge cases without a host.

## Lifecycle sample

`npm run test:lifecycle:e2e -- --fresh` runs the student-grades sample on ports 3098/8798.
It seeds the release role Bots, creates the project group and `Student Grades 1.0.0`
release, lets the PM import an 11-task TDD lifecycle through `board_task plan`, starts the
release, verifies board edits reach the release group, waits for the periodic release
monitor to publish after all four gates pass, and checks the generated Markdown/HTML
summary report. Set `MOCK_BOARD_AUTORUN=1` for this run; the script sets it itself.