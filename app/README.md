# DeepSeek Bot desktop app

The Electron app for Windows and macOS. It installs a pinned DeepSeek Harness (DSH 0.2.0-rc.2) and the `ds-bot` plugin of this repository, boots its own DSH profile `ds-bot` through `@deepseek-ai/dsh/profile-boot`, and keeps its data in its own `DSH_HOME`. It never writes to `~/.dsh`. The design is in [docs/plans/2026-10-16-desktop-app.md](../docs/plans/2026-10-16-desktop-app.md).

## Run

```sh
npm ci
node node_modules/electron/install.js   # when npm did not download Electron (no node_modules/electron/dist)
npm start
```

When GitHub downloads are slow, set `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` before the Electron download. Unset `ELECTRON_RUN_AS_NODE` before `npm start` if your terminal has it (terminals inside some Electron-based editors do): with it, Electron runs as plain Node and the app does not start.

npm installs `ds-bot` from `../ds-bot` as a copy of its package files (`install-links` in `.npmrc`), so the app runs the plugin of this checkout. Run `npm install` again after you change `ds-bot`. `overrides` in `package.json` pins the four peer dependencies of `ds-bot` to the DSH version: they are declared as `*`, and npm does not choose a pre-release to satisfy `*`.

| Variable | What it sets | Default |
|---|---|---|
| `DS_BOT_HOME` | The data location: the `DSH_HOME` of the app | `~/.ds-bot` |
| `DS_BOT_SHELL_DATA` | The app's own data (window, Chromium storage) | Electron's `userData` (Windows: `%APPDATA%\DeepSeek Bot`) |

The Host reads model settings and keys the way DSH does: environment variables such as `DEEPSEEK_API_KEY`, and `.env` and `.credentials.yaml` in the data location.

## Check a change

`scripts/shot.mjs` starts the app on throwaway folders, saves a screenshot of its window, prints the page text, closes the window the way a user does and waits until the app exits. Use the mock model of the plugin, `../ds-bot/dev/mock-llm.mjs` (`MOCK_PORT=<port> node ../ds-bot/dev/mock-llm.mjs`).

```sh
DS_BOT_HOME=<tmp>/home DS_BOT_SHELL_DATA=<tmp>/shell \
DEEPSEEK_BASE_URL=http://127.0.0.1:<port>/v1 DEEPSEEK_API_KEY=mock-key \
node scripts/shot.mjs <tmp>/shot.png 20
```

Never point `DS_BOT_HOME` at `~/.dsh` or at the data of an app that you use.

## Layout

| File | What it does |
|---|---|
| `src/main.mjs` | Main process: one instance, the `dsh-app://app` scheme, request forwarding to the Host, the WebSocket header rewrite, the window |
| `src/host-process.mjs` | Starts the Host in Electron's Node mode and owns its exit |
| `src/host.mjs` | The Host: creates the profile `ds-bot` (`dsh-base`, `dsh-web-app`, `ds-bot`), boots it with `runProfile()` on a loopback port and reports the launch URL |
| `src/web.mjs` | The page document, the launch-token cookie exchange and the request forwarding |
| `src/preload.cjs` | The boot handshake `dshDesktopBoot` for the page |

Plugins that the user installs from the plugin page are installed with the app's own pnpm (`node_modules/pnpm`).

Some files adapt code from DSH Desktop (MIT); see [NOTICE](../NOTICE).
