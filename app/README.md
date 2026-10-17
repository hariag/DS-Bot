# DeepSeek Bot desktop app

The Electron app for Windows and macOS. It installs a pinned DeepSeek Harness (DSH 0.2.0-rc.2) and the `ds-bot` plugin of this repository, boots its own DSH profile `ds-bot` through `@deepseek-ai/dsh/profile-boot`, and keeps its data in its own `DSH_HOME`. It never writes to `~/.dsh`. Its window is its own page (`ui/`), which talks only to ds-bot's channel in the engine. The design is in [docs/plans/2026-10-16-desktop-app.md](../docs/plans/2026-10-16-desktop-app.md).

## Run

```sh
npm ci
node node_modules/electron/install.js   # when npm did not download Electron (no node_modules/electron/dist)
npm start                               # builds the window (npm run build), then starts the app
```

When GitHub downloads are slow, set `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` before the Electron download. Unset `ELECTRON_RUN_AS_NODE` before `npm start` if your terminal has it (terminals inside some Electron-based editors do): with it, Electron runs as plain Node and the app does not start.

npm installs `ds-bot` from `../ds-bot` as a copy of its package files (`install-links` in `.npmrc`), so the app runs the plugin of this checkout. Run `npm install` again after you change `ds-bot`. `overrides` in `package.json` pins the four peer dependencies of `ds-bot` to the DSH version: they are declared as `*`, and npm does not choose a pre-release to satisfy `*`.

| Variable | What it sets | Default |
|---|---|---|
| `DS_BOT_HOME` | The data location: the `DSH_HOME` of the app | `~/.ds-bot` |
| `DS_BOT_SHELL_DATA` | The app's own data (window, Chromium storage) | Electron's `userData` (Windows: `%APPDATA%\DeepSeek Bot`) |

The Host reads model settings and keys the way DSH does: environment variables such as `DEEPSEEK_API_KEY`, and `.env` and `.credentials.yaml` in the data location.

## The profile

The Host's profile `ds-bot` is in `profiles/ds-bot` in the data location. It stacks three bundles, and after them the bundles that the user installs:

| Bundle | What it adds |
|---|---|
| `@deepseek-ai/dsh-base` | DSH's shared core: models, Sessions, tools, settings, plugin management |
| `deepseek-bot-engine` (`engine/`) | The loopback transport for ds-bot's channel, the host services that ds-bot uses, and the `standard` agent preset that Bot Sessions run on, without the goal command and tool. It has no row of DSH's Web front end |
| `ds-bot` | The Bot team |

At every start the Host puts these three bundles at the head of the profile's bundle list. Settings for one machine go into the profile's `cordis.patch.yml`, as in DSH. The `@deepseek-ai/dsh` package still installs DSH's Web front end, but the profile does not load it. When the app moves to another DSH version, compare `engine/` with the `dsh-web-app` bundle patch and the standard preset of that version.

## Check a change

`npm test` checks the composition of the profile.

`scripts/shot.mjs` starts the app on throwaway folders, saves a screenshot of its window, prints the page text, closes the window the way a user does and waits until the app exits. Build the window first (`npm run build`). Use the mock model of the plugin, `../ds-bot/dev/mock-llm.mjs` (`MOCK_PORT=<port> node ../ds-bot/dev/mock-llm.mjs`).

```sh
npm run build
DS_BOT_HOME=<tmp>/home DS_BOT_SHELL_DATA=<tmp>/shell \
DEEPSEEK_BASE_URL=http://127.0.0.1:<port>/v1 DEEPSEEK_API_KEY=mock-key \
node scripts/shot.mjs <tmp>/shot.png 20
```

Never point `DS_BOT_HOME` at `~/.dsh` or at the data of an app that you use.

## Layout

| File | What it does |
|---|---|
| `src/main.mjs` | Main process: one instance, the `dsh-app://app` scheme (the window's build, and `/api/` forwarded to the Host), the window. The window has no title bar: a band along the top of the page moves it, and the system's window buttons sit in that band |
| `src/host-process.mjs` | Starts the Host in Electron's Node mode and owns its exit |
| `src/host.mjs` | The Host: boots the profile with `runProfile()` and reports the launch URL |
| `src/profile.mjs` | The profile: its name, its bundles, and its creation and update |
| `engine/` | The bundle `deepseek-bot-engine`: `cordis.patch.yml`, `preset-standard.patch.yml`, and `index.js`, which trades the launch token for the Host cookie |
| `test/` | `npm test`: the composition of the profile |
| `src/web.mjs` | The window's files, the launch-token cookie exchange and the request forwarding |
| `ui/` | The window: React, built with Vite (`vite.config.js`) into `ui/dist`. It draws the plugin's own Bot views from `../ds-bot/src/client/` (sidebar, chat rows, docks, dialogs and their stylesheets) and puts its own Markdown in place of DSH's. It uses ds-bot's `api/bot` channel and its live feed `api/bot/feed` |
| `assets/` | The app icon: `icon.svg`, `icon.png` (1024 px) and `icon.ico` (Windows, 16 to 256 px). `npm run icon` (`scripts/icon.mjs`) draws them again from the Main Bot's whale in `../ds-bot` |

The Host installs plugins with the app's own pnpm (`node_modules/pnpm`).

Some files adapt code from DSH Desktop (MIT); see [NOTICE](../NOTICE).
