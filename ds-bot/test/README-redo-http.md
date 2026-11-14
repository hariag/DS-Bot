# Redo preview HTTP fixtures

These scripts create synthetic teams in fresh directories under `E2E_ARTIFACTS`.
They start and stop only their own DSH processes and never send model requests.
Use an isolated network namespace with loopback enabled, no real credentials,
and a disposable writable artifact directory. Never point them at a user's home.

`redo-http-positive.mjs` needs a built Harness with `flushLiveSession` and a
plugin checkout with its dependencies available. Set `DSH_HARNESS` to that
checkout, `DSBOT_PLUGIN` to this plugin directory, `E2E_ARTIFACTS` to the
artifact directory, and optionally `E2E_PLAYWRIGHT_PACKAGE` and `CHROME_PATH`.
The script starts real DSH and Chromium, makes one synthetic Bot, stops its DSH,
uses `redo-http-seed.mjs` and the real JSONL writer to create synthetic held
inputs, then starts DSH again for owner-route assertions. The time-matched
legacy candidate is read-only and must not be presented as authenticated.

`redo-http-auth.mjs` checks an unauthenticated HTTP request and owner-route
negative cases. These fixtures do not prove execution authorization, tools,
model behavior, or exactly-once external effects.
