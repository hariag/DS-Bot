// Electron main process: a small start window while the app's own DSH Host boots, then one window
// for the Bot team. The team window loads the Host's loopback address as DSH Web does: DSH's
// sign-in sends the page's origin as the address the browser comes back to, and accepts only a
// loopback one. It loads hidden and shows once the team view is ready (start-window.mjs). Only
// what the start window needs is imported up front; the rest loads once it is up
// (docs/plans/2026-10-26-start-window.md §11).
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeTheme, screen, session, shell, systemPreferences, WebContentsView } from 'electron'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { release } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { canonicalExecPath } from './canonical-path.mjs'
import { hostPort } from './host-port.mjs'
import { captureStdio, LogFile } from './logs.mjs'
import { readStartFrame, writeStartFrame } from './start-frame.mjs'
import { explainOf, StartWindow } from './start-window.mjs'
import { CAPTION_HEIGHT, cssColor, micaAvailable, nativeThemeSource } from './window-frame.mjs'

const IPC = {
  caption: 'ds-bot:caption-colors', nativeTheme: 'ds-bot:native-theme', fullscreen: 'ds-bot:fullscreen',
  dataLocation: 'ds-bot:data-location', moveData: 'ds-bot:move-data', teamWorkspace: 'ds-bot:team-workspace',
  ready: 'ds-bot:ready', focus: 'ds-bot:focus',
  browserAcquire: 'ds-bot:browser-acquire', browserRelease: 'ds-bot:browser-release', browserForget: 'ds-bot:browser-forget',
  browserViewChanged: 'ds-bot:browser-view-changed', browserViewCreate: 'ds-bot:browser-view-create',
  browserViewSync: 'ds-bot:browser-view-sync', browserViewPlace: 'ds-bot:browser-view-place',
  browserViewNavigate: 'ds-bot:browser-view-navigate', browserViewCommand: 'ds-bot:browser-view-command',
  browserViewFocus: 'ds-bot:browser-view-focus', browserViewRead: 'ds-bot:browser-view-read',
  browserViewClose: 'ds-bot:browser-view-close', browserViewHold: 'ds-bot:browser-view-hold',
  browserImportSources: 'ds-bot:browser-import-sources', browserImportPick: 'ds-bot:browser-import-pick',
  browserImportLive: 'ds-bot:browser-import-live', browserImportApply: 'ds-bot:browser-import-apply',
  browserImportCancel: 'ds-bot:browser-import-cancel',
  appUpdateState: 'ds-bot:app-update-state', appUpdateCheck: 'ds-bot:app-update-check',
  appUpdateInstall: 'ds-bot:app-update-install', appUpdateOpen: 'ds-bot:app-update-open',
  appUpdateChanged: 'ds-bot:app-update-changed',
}
// A cookie export larger than this is not a cookie export.
const IMPORT_FILE_MAX = 32 * 1024 * 1024
const MOVE_PROBLEMS = { drive: 'moveDrive', nested: 'moveNested', workspace: 'moveWorkspace', program: 'inProgram', notEmpty: 'moveNotEmpty' }
const UPDATE_CHECK_WAIT_MS = 15_000
const UPDATE_DOWNLOAD_WAIT_MS = 15 * 60_000

const here = dirname(fileURLToPath(import.meta.url))
// Drawn by scripts/icon.mjs. Windows takes the .ico for its several sizes.
const iconFile = join(here, '..', 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png')
// Windows 11 draws Mica behind the page; mica.css lets it through the sidebar.
const mica = micaAvailable(process.platform, release())
if (process.env.DS_BOT_SHELL_DATA) app.setPath('userData', process.env.DS_BOT_SHELL_DATA)
const frameFile = join(app.getPath('userData'), 'start-frame.json')

// Loaded once the start window is up (loadModules).
let BotBrowserGuests, partitionOf, BotViews, isBotId, importFromBrowser, listSources, applyCookies, CookieImports, parseCookieFile
let downloadSaver, chooseLocations, localeText, programFolder, saveLocations, teamIn, teamsAt, text, HostProcess
let copySessions, findTeam, importTeam, teamInUse, userDshHome, copyData, moveProblem, CHECK_PROFILE, PROFILE
let UPDATE_TEXT, watchReleases, watchUpdates, getDshRuntimeVersion, electronUpdater

let mainWindow
// Settles once the hidden team window exists.
let mainCreated
let startWindow
let logs
// Writers to the console that bypass the log: the Host's output goes into the log on its own.
let rawOutput
let host
// The Host's loopback origin, which the window loads.
let origin
let port
let hostStop
let updates
let updatesStarted = false
let stopping = false
let stopped = false
let failed = false
let places
// The first run's answer to the import; only the first boot copies.
let pendingImport
// Each boot of the engine; a retry starts a new one, and what an old one still reports is dropped.
let attempt = 0
// Quitting while a first-run dialog is open stops the first run, and during the copy (of the
// first run or of a data move) it waits for the copy to stop at a safe point, so that it leaves
// no half team and no temporary copy.
let choosing
let copying
const copyAbort = new AbortController()
let browserGuests
let botViews
let cookieImports
app.once('will-quit', () => { botViews?.dispose() })

// A packaged app started through an 8.3 short path or a junction restarts once on the
// canonical path: the lock below and every path the Host sees then agree with the long
// form, and the profile patch layer stops mixing the two.
const canonical = app.isPackaged ? canonicalExecPath(process.execPath) : undefined
if (canonical !== undefined) {
  app.relaunch({ execPath: canonical, args: process.argv.slice(1) })
  app.exit(0)
} else if (!app.requestSingleInstanceLock()) {
  app.exit(0)
} else {
  logs = new LogFile({ dir: join(app.getPath('userData'), 'logs') })
  rawOutput = captureStdio(logs)
  app.once('will-quit', () => { logs.flush() })
  console.log(`DeepSeek Bot ${app.getVersion()} (${process.platform} ${process.arch}), Electron ${process.versions.electron}`)
  startWindow = new StartWindow({
    electron: { BrowserWindow, ipcMain, screen, shell, clipboard, nativeTheme, systemPreferences },
    page: join(here, 'start', 'start.html'), preload: join(here, 'preload.cjs'), icon: iconFile, mica, devTools: !app.isPackaged,
    // On Windows the locale is known only once the app is ready.
    lang: () => (app.getLocale().toLowerCase().startsWith('zh') ? 'zh' : 'en'), motion: readStartFrame(frameFile).motion,
    version: app.getVersion(), log: logs, mainWindow: () => mainWindow,
    onRetry: () => { retry().catch(fail) },
    onReload: () => { mainWindow?.webContents.reload() },
    // Closing the start window before the hand-off quits, as closing the team window does.
    onClose: () => { app.quit() },
  })
  app.on('second-instance', focusWindow)
  app.on('window-all-closed', () => { app.quit() })
  app.on('before-quit', (event) => {
    if (choosing !== undefined) {
      event.preventDefault()
      choosing.abort()
      return
    }
    if (copying !== undefined) {
      event.preventDefault()
      if (copyAbort.signal.aborted) return
      copyAbort.abort()
      void copying.finally(() => { copying = undefined; app.quit() })
      return
    }
    if (stopped || host === undefined) return
    event.preventDefault()
    if (stopping) return
    void stopHost().then(() => { app.quit() })
  })
  app.whenReady().then(start).catch(fail)
}

function stopHost() {
  stopping = true
  hostStop ??= (host?.stop() ?? Promise.resolve()).catch((error) => { console.error(error) }).finally(() => { stopped = true })
  return hostStop
}

// A throwaway run (DS_BOT_HOME) asks nothing and shows what a later start shows.
const startKind = () => (process.env.DS_BOT_HOME || existsSync(join(app.getPath('userData'), 'locations.json')) ? 'later' : 'first')

async function start() {
  setMenu()
  nativeTheme.themeSource = readStartFrame(frameFile).themeSource
  // A packaged app has the icon in its bundle; Electron's own run shows Electron's.
  if (process.platform === 'darwin' && !app.isPackaged) app.dock?.setIcon(iconFile)
  await prepare()
  run()
}

// What the boot needs; a retry after a failure here does what is still missing.
async function prepare() {
  // Before the windows: the team window's page is told the Host's origin.
  if (port === undefined) {
    port = await hostPort(join(app.getPath('userData'), 'host-port.json'))
    origin = `http://127.0.0.1:${String(port)}`
  }
  startWindow.open(startKind())
  if (browserGuests === undefined) {
    await loadModules()
    handleIpc()
  }
  // The team window is made once the start window has painted, already on its final rect.
  mainCreated ??= startWindow.painted.then(createWindow)
}

async function loadModules() {
  const [browser, views, sources, cookies, cookieFiles, downloads, firstRun, hostProcess, imports, moves, profile, updatesModule, boot, updater] = await Promise.all([
    import('./bot-browser.mjs'), import('./bot-views.mjs'), import('./browser-sources.mjs'), import('./cookie-import.mjs'),
    import('./cookie-parse.mjs'), import('./downloads.mjs'), import('./first-run.mjs'), import('./host-process.mjs'),
    import('./import.mjs'), import('./move-data.mjs'), import('./profile.mjs'), import('./updates.mjs'),
    import('@deepseek-ai/dsh-app-boot'), import('electron-updater'),
  ])
  ;({ BotBrowserGuests, partitionOf } = browser)
  ;({ BotViews, isBotId } = views)
  ;({ importFromBrowser, listSources } = sources)
  ;({ applyCookies, CookieImports } = cookies)
  ;({ parseCookieFile } = cookieFiles)
  ;({ downloadSaver } = downloads)
  ;({ chooseLocations, localeText, programFolder, saveLocations, teamIn, teamsAt, text } = firstRun)
  ;({ HostProcess } = hostProcess)
  ;({ copySessions, findTeam, importTeam, teamInUse, userDshHome } = imports)
  ;({ copyData, moveProblem } = moves)
  ;({ CHECK_PROFILE, PROFILE } = profile)
  ;({ UPDATE_TEXT, watchReleases, watchUpdates } = updatesModule)
  ;({ getDshRuntimeVersion } = boot)
  electronUpdater = updater.default
  browserGuests = new BotBrowserGuests({ session, origin: () => origin, devTools: !app.isPackaged })
  botViews = new BotViews({
    window: () => mainWindow, WebContentsView, guests: browserGuests, origin: () => origin, devTools: !app.isPackaged,
    statePath: join(app.getPath('userData'), 'bot-views.json'),
    onChange: state => mainWindow?.webContents.send(IPC.browserViewChanged, state),
  })
  cookieImports = new CookieImports()
}

function run() {
  const mine = (attempt += 1)
  boot(mine).catch((error) => { if (mine === attempt) void fail(error) })
}

// The engine starts again after a failure or the 180 s question; the places stay.
async function retry() {
  attempt += 1
  failed = false
  const old = host
  host = undefined
  await old?.stop().catch((error) => { console.error(error) })
  await prepare()
  run()
}

// The data folder (with the first run's questions on a first start), the engine, then the team
// view in the hidden team window.
async function boot(mine) {
  if (places === undefined) {
    const first = startWindow.kind === 'first'
    if (first) startWindow.explain(explainOf(teamsAt()))
    choosing = new AbortController()
    const ui = { owner: () => startWindow.owner(), asking: answer => startWindow.asking(answer) }
    const where = await chooseLocations(choosing.signal, ui).finally(() => { choosing = undefined })
    if (where.quit) { app.exit(0); return }
    places = { dataDir: where.dataDir, workspace: where.workspace }
    pendingImport = where.import
    if (first) startWindow.explain(explainOf({ offered: where.offered === true, team: teamIn(where.dataDir) }))
  }
  // Also the check that the data folder can be written.
  mkdirSync(profileDir(), { recursive: true })
  startWindow.done('data')
  const engine = await startEngine()
  if (engine === undefined || mine !== attempt) return
  startWindow.done('engine')
  await mainCreated
  if (mine !== attempt || mainWindow === undefined) return
  startWindow.teamLoading()
  // The launch URL trades its token for the Host's cookie and goes on to the page.
  void mainWindow.loadURL(engine.url).catch(() => {})
}

const profileDir = () => join(places.dataDir, 'profiles', PROFILE)
const pnpmEntry = () => join(app.getAppPath(), 'node_modules', 'pnpm', 'bin', 'pnpm.mjs')
const hostOutput = (stream, chunk) => {
  logs.write('engine', chunk)
  rawOutput[stream](chunk)
}

function newHost() {
  return new HostProcess({
    entry: join(here, 'host.mjs'),
    cwd: profileDir(),
    env: { ...process.env, DSH_HOME: places.dataDir, DS_BOT_PORT: String(port), DS_BOT_APP: '1', DS_BOT_USER_DSH_HOME: userDshHome(), ...(places.workspace ? { DS_BOT_WORKSPACE: places.workspace } : {}) },
    pnpm: pnpmEntry(),
    onFailure: fail,
    output: hostOutput,
  })
}

// A failed check is not a failed start: start() rejects, and the copy goes on unchecked.
function newCheck(home, list) {
  const cwd = join(home, 'profiles', CHECK_PROFILE)
  mkdirSync(cwd, { recursive: true })
  return new HostProcess({ entry: join(here, 'host.mjs'), cwd, env: { ...process.env, DSH_HOME: home, DS_BOT_CHECK: list }, pnpm: pnpmEntry(), onFailure: () => {}, output: hostOutput })
}

/** @returns {Promise<{ url: string } | undefined>} the Host's launch URL; none when the app quits during the copy */
async function startEngine() {
  if (pendingImport !== undefined) {
    const where = { ...places, import: pendingImport }
    pendingImport = undefined
    copying = copyTeam(where, copyAbort.signal)
    const copied = await copying
    copying = undefined
    if (copied === 'quit') app.exit(0)
    if (copied !== undefined) return undefined
  }
  // Not during the import, which a restart would cut short; before the Host, so that an
  // update can still come when this version's Host does not start.
  if (!updatesStarted) {
    updatesStarted = true
    updates = startUpdates()
    updates?.subscribe((state) => { mainWindow?.webContents.send(IPC.appUpdateChanged, state) })
  }
  host = newHost()
  host.onMessage(message => {
    if (message?.type !== 'ds-bot:browser-endpoint' || typeof message.id !== 'string' || !isBotId(message.botId)) return
    const downloadRoots = message.downloadRoots
    if (!Array.isArray(downloadRoots) || downloadRoots.length > 4 || !Array.from(downloadRoots).every(root => typeof root === 'string' && isAbsolute(root))) {
      host?.send({ type: 'ds-bot:browser-endpoint-response', id: message.id, error: 'Could not create the browser endpoint.' })
      return
    }
    void botViews.endpoint(message.botId, { downloadRoots }).then(url => {
      host?.send({ type: 'ds-bot:browser-endpoint-response', id: message.id, url })
    }).catch(() => host?.send({ type: 'ds-bot:browser-endpoint-response', id: message.id, error: 'Could not create the browser endpoint.' }))
  })
  return host.start()
}

function handleIpc() {
  // A throwaway run (DS_BOT_HOME) keeps its folders where it was told.
  const fixed = Boolean(process.env.DS_BOT_HOME)
  // The team view has mounted (ds-bot calls dsBotApp.ready()): the start window hands over.
  ipcMain.on(IPC.ready, (event) => { if (fromWindow(event)) startWindow.ready() })
  ipcMain.on(IPC.focus, (event) => { if (fromWindow(event)) focusWindow() })
  ipcMain.handle(IPC.dataLocation, (event) => {
    assertWindow(event)
    return { path: places.dataDir, fixed }
  })
  ipcMain.handle(IPC.moveData, (event, workspace) => {
    assertWindow(event)
    return fixed ? false : moveData(typeof workspace === 'string' && isAbsolute(workspace) ? workspace : places.workspace)
  })
  // ds-bot's Bot browsers: one webview per lease, in the storage of the Bot's key.
  ipcMain.handle(IPC.browserAcquire, (event, key) => {
    assertWindow(event)
    return browserGuests.acquire(event.sender, key)
  })
  ipcMain.handle(IPC.browserRelease, (event, lease) => {
    assertWindow(event)
    return browserGuests.release(event.sender, lease)
  })
  ipcMain.handle(IPC.browserForget, (event, key) => {
    assertWindow(event)
    const botId = typeof key === 'string' && key.startsWith('bot:') ? key.slice(4) : ''
    return Promise.resolve(botId === '' ? undefined : botViews.forget(botId)).then(() => browserGuests.forget(event.sender, key))
  })
  ipcMain.handle(IPC.browserViewCreate, (event, botId, tabId, url) => {
    assertWindow(event)
    return botViews.create(String(botId), { tabId: String(tabId), ...(typeof url === 'string' && url !== '' ? { url } : {}) }).tabId
  })
  ipcMain.handle(IPC.browserViewSync, (event, botId) => {
    assertWindow(event)
    return botViews.sync(String(botId))
  })
  ipcMain.handle(IPC.browserViewPlace, (event, tabId, rect, visible) => { assertWindow(event); return botViews.place(String(tabId), rect, visible === true) })
  ipcMain.handle(IPC.browserViewNavigate, (event, botId, tabId, url) => { assertWindow(event); return botViews.operate(String(botId), 'navigate', { tabId: String(tabId), url }) })
  ipcMain.handle(IPC.browserViewCommand, (event, botId, tabId, command) => { assertWindow(event); return botViews.operate(String(botId), 'command', { tabId: String(tabId), command }) })
  ipcMain.handle(IPC.browserViewFocus, (event, botId, tabId) => { assertWindow(event); return botViews.operate(String(botId), 'focus', { tabId: String(tabId) }) })
  ipcMain.handle(IPC.browserViewRead, (event, botId, tabId, script) => { assertWindow(event); return botViews.operate(String(botId), 'read', { tabId: String(tabId), script }) })
  ipcMain.handle(IPC.browserViewClose, (event, botId, tabId) => { assertWindow(event); return botViews.operate(String(botId), 'close', { tabId: String(tabId) }) })
  ipcMain.handle(IPC.browserViewHold, (event, botId, held) => { assertWindow(event); return botViews.hold(String(botId), held === true) })
  // Cookie imports: a file or an installed browser's profile is parsed or harvested into a
  // pending set first; only apply (the user's confirm) writes into the Bot's partition.
  ipcMain.handle(IPC.browserImportSources, (event) => {
    assertWindow(event)
    return listSources()
  })
  ipcMain.handle(IPC.browserImportPick, async (event) => {
    assertWindow(event)
    const picked = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: [{ name: 'Cookie files', extensions: ['txt', 'json', 'cookies'] }, { name: 'All files', extensions: ['*'] }],
    })
    if (picked.canceled || !picked.filePaths[0]) return { canceled: true }
    const buffer = await readFile(picked.filePaths[0])
    if (buffer.length > IMPORT_FILE_MAX) return { error: 'too-large' }
    const parsed = parseCookieFile(buffer)
    if (!parsed.ok) return { error: parsed.error ?? 'unreadable', format: parsed.format }
    return cookieImports.store(parsed, { kind: 'file', label: basename(picked.filePaths[0]) })
  })
  ipcMain.handle(IPC.browserImportLive, async (event, sourceId, close) => {
    assertWindow(event)
    const source = (await listSources()).find((item) => item.id === sourceId)
    if (!source) throw new Error('DeepSeek Bot: an unknown browser profile')
    let outcome
    try {
      outcome = await importFromBrowser(source, { close: close === true })
    } catch (error) {
      if (error?.code === 'app-bound') return { error: 'app-bound' }
      throw error
    }
    if (outcome.running) return { running: true, label: source.label, kind: source.kind }
    const result = {
      format: 'live', entries: outcome.result.cookies.length + outcome.result.skipped.length,
      cookies: outcome.result.cookies, skipped: outcome.result.skipped, warnings: [], info: {},
    }
    return { ...cookieImports.store(result, { kind: source.kind, label: source.label }), restarted: outcome.restarted }
  })
  ipcMain.handle(IPC.browserImportApply, async (event, key, id) => {
    assertWindow(event)
    if (typeof key !== 'string' || !key.startsWith('bot:')) throw new Error('DeepSeek Bot: a Bot storage key is required')
    const pending = cookieImports.take(typeof id === 'string' ? id : '')
    if (!pending) throw new Error('DeepSeek Bot: this import is no longer pending')
    const storage = session.fromPartition(partitionOf(key))
    return applyCookies(storage, pending.cookies)
  })
  ipcMain.handle(IPC.browserImportCancel, (event, id) => {
    assertWindow(event)
    if (typeof id === 'string') cookieImports.drop(id)
  })
  // The app's own update state, for the About row. `updates` exists once the engine's first
  // start created it; before that (and in runs without an updater) the state is null.
  ipcMain.handle(IPC.appUpdateState, (event) => {
    assertWindow(event)
    return updates?.state() ?? null
  })
  ipcMain.handle(IPC.appUpdateCheck, (event) => {
    assertWindow(event)
    updates?.check()
  })
  ipcMain.handle(IPC.appUpdateInstall, async (event) => {
    assertWindow(event)
    if (updates?.state().phase === 'downloaded') await updates.install()
  })
  ipcMain.handle(IPC.appUpdateOpen, (event) => {
    assertWindow(event)
    const state = updates?.state()
    if (state?.phase === 'available' && typeof state.page === 'string' && state.page.startsWith('https://')) {
      void shell.openExternal(state.page)
    }
  })
  // The plugin keeps the team workspace; the app remembers it for its own checks.
  ipcMain.on(IPC.teamWorkspace, (event, path) => {
    if (fixed || !fromWindow(event) || typeof path !== 'string' || !isAbsolute(path)) return
    places = { ...places, workspace: path }
    saveLocations(places)
  })
  if (process.platform === 'win32') {
    // Windows ignores the alpha of the caption buttons' color, so they take the opaque color
    // of the surface under them, which the page measures.
    ipcMain.on(IPC.caption, (event, color, symbolColor) => {
      if (fromWindow(event) && cssColor(color) && cssColor(symbolColor)) mainWindow.setTitleBarOverlay({ color, symbolColor })
    })
    // Mica and the caption buttons follow the app's theme, not only the system's; the start
    // window takes it at the next start, before the team view has loaded.
    ipcMain.on(IPC.nativeTheme, (event, source) => {
      const value = nativeThemeSource(source)
      if (!fromWindow(event) || value === undefined) return
      nativeTheme.themeSource = value
      writeStartFrame(frameFile, { themeSource: value })
    })
  }
}

// The window that a dialog belongs to: the start window while it shows, then the team window.
const owner = () => startWindow.owner() ?? mainWindow
const setProgress = (value) => { owner()?.setProgressBar(value) }

// The Host starts once on the new data location first: DSH then sets up its project list
// without the copied Sessions' folders, so the old team's folders are not offered as projects.
// Before that, the app's own DSH reads every chat of the team once: a newer DSH can write
// records that this one refuses while the log format stays the same. Such a chat stops the
// copy, as a newer log format does; 'quit' means the user updates DeepSeek Bot first, and
// 'stopped' that the app quit during the copy.
async function copyTeam(where, signal) {
  const unreadable = await checkTeam(where, signal)
  if (signal.aborted) return 'stopped'
  if (unreadable > 0) {
    const t = text()
    const { response } = await startWindow.asking(dialog.showMessageBox(owner(), { type: 'warning', title: 'DeepSeek Bot', noLink: true, message: t.newer(unreadable), buttons: [t.quit, t.startEmpty], defaultId: 0, cancelId: 0, signal }))
    if (signal.aborted) return 'stopped'
    if (response === 0) return 'quit'
    saveLocations(where)
    return undefined
  }
  const warm = newHost()
  host = warm
  const stopWarm = () => { void warm.stop() }
  signal.addEventListener('abort', stopWarm, { once: true })
  try {
    await warm.start()
    if (signal.aborted) return 'stopped'
    setProgress(2)
    await warm.stop()
    host = undefined
    const summary = await importTeam({ ...where.import, to: where.dataDir, workspace: where.workspace, dsh: getDshRuntimeVersion(), signal })
    console.log(`DeepSeek Bot: copied ${String(summary.bots)} Bots and ${String(summary.sessions)} Sessions from ${summary.from}`)
  } catch (error) {
    if (signal.aborted) return 'stopped'
    console.error(error)
    await startWindow.asking(dialog.showMessageBox(owner(), { type: 'warning', title: 'DeepSeek Bot', message: text().failed(error instanceof Error ? error.message : String(error)), signal }))
    if (signal.aborted) return 'stopped'
  } finally {
    signal.removeEventListener('abort', stopWarm)
    setProgress(-1)
  }
  saveLocations(where)
  return undefined
}

// A copy of the chats in a DSH home of its own, so that nothing of the check stays in the data.
async function checkTeam(where, signal) {
  // A run that was killed can leave its temporary check home behind.
  for (const name of readdirSync(where.dataDir).filter(entry => /^\.import-check-\d+$/u.test(entry))) {
    await rm(join(where.dataDir, name), { recursive: true, force: true }).catch((error) => { console.error(error) })
  }
  const home = join(where.dataDir, `.import-check-${String(Date.now())}`)
  try {
    const found = findTeam(where.import.from)
    const ids = found === undefined ? [] : await copySessions(where.import.from, found.team, home, signal)
    if (ids.length === 0) return 0
    setProgress(2)
    const list = join(home, 'check.json')
    writeFileSync(list, JSON.stringify(ids))
    const check = newCheck(home, list)
    const stop = () => { void check.stop() }
    signal.addEventListener('abort', stop, { once: true })
    try {
      signal.throwIfAborted()
      const { unreadable } = await check.start()
      if (unreadable.length > 0) console.warn(`DeepSeek Bot: this DSH cannot read ${unreadable.join(', ')}`)
      return unreadable.length
    } finally {
      signal.removeEventListener('abort', stop)
      await check.stop()
    }
  } catch (error) {
    if (!signal.aborted) console.error('DeepSeek Bot: the chats were not checked before the copy:', error)
    return 0
  } finally {
    setProgress(-1)
    await rm(home, { recursive: true, force: true, maxRetries: 5 }).catch((error) => { console.error(error) })
  }
}

// The data moves as a copy while the Host is stopped, and the app starts again on the new
// folder; after a failed copy it starts again on the old one. The old folder stays.
async function moveData(workspace) {
  if (copying !== undefined || stopping || mainWindow === undefined) return false
  const t = text()
  const { canceled, filePaths } = await dialog.showOpenDialog(owner(), { title: t.pickMove, defaultPath: dirname(places.dataDir), properties: ['openDirectory', 'createDirectory', 'promptToCreate'] })
  if (canceled || filePaths[0] === undefined) return false
  const to = resolve(filePaths[0])
  const dshHome = userDshHome()
  // The team workspace can move while a dialog is open; the window tells the latest one.
  const refused = async () => {
    for (const current of new Set([workspace, places.workspace])) {
      const problem = moveProblem({ from: places.dataDir, to, workspace: current, dshHome, program: app.isPackaged ? programFolder() : undefined })
      if (problem === undefined) continue
      await dialog.showMessageBox(owner(), { type: 'warning', title: 'DeepSeek Bot', message: problem === 'dsh' ? t.inDsh(dshHome) : t[MOVE_PROBLEMS[problem]], buttons: ['OK'] })
      return true
    }
    return false
  }
  if (await refused()) return false
  const { response } = await dialog.showMessageBox(owner(), { type: 'question', title: 'DeepSeek Bot', noLink: true, message: t.moveConfirm(to), detail: t.moveDetail(places.dataDir), buttons: [t.move, t.cancel], defaultId: 0, cancelId: 1 })
  if (response !== 0 || stopping || await refused()) return false
  const signal = copyAbort.signal
  copying = (async () => {
    // The settings go away first, so that nothing moves the team workspace from here on; the
    // start window shows the move meanwhile.
    void mainWindow?.loadURL('about:blank').catch(() => {})
    mainWindow?.hide()
    startWindow.open('moving')
    await stopHost()
    // The app may have heard of a team workspace change while the Host stopped.
    if (await refused()) {
      app.relaunch()
      return
    }
    // Another DSH on the same data would go on writing while the copy is made.
    if (teamInUse(places.dataDir)) {
      await dialog.showMessageBox(owner(), { type: 'warning', title: 'DeepSeek Bot', message: t.moveInUse })
      app.relaunch()
      return
    }
    setProgress(2)
    try {
      await copyData(places.dataDir, to, signal)
      try {
        saveLocations({ dataDir: to, workspace: places.workspace ?? workspace })
      } catch (error) {
        // Unused, the copy would only keep the folder from being chosen again.
        await rm(to, { recursive: true, force: true, maxRetries: 5 }).catch((failure) => { console.error(failure) })
        throw error
      }
    } catch (error) {
      if (signal.aborted) return
      console.error(error)
      await dialog.showMessageBox(owner(), { type: 'warning', title: 'DeepSeek Bot', message: t.moveFailed(error instanceof Error ? error.message : String(error)) })
    } finally {
      setProgress(-1)
    }
    app.relaunch()
  })()
  await copying
  copying = undefined
  app.quit()
  return true
}

// Windows and a Linux AppImage update themselves; macOS and a Linux deb ask to download the new
// version. Throwaway runs check only a given feed and never ask.
function startUpdates() {
  const feed = process.env.DS_BOT_UPDATE_URL || undefined
  const throwaway = Boolean(process.env.DS_BOT_HOME)
  if (!app.isPackaged || (throwaway && feed === undefined)) return undefined
  if (process.platform === 'darwin') {
    return watchReleases({
      current: app.getVersion(), arch: process.arch, feed, ask: throwaway ? undefined : askDownload, open: url => shell.openExternal(url),
    })
  }
  // electron-updater's Linux updater works only from inside an AppImage (APPIMAGE is set there);
  // a deb cannot update itself and points at the release page instead, as on macOS. The deb's
  // file name uses the Debian architecture (x64 → amd64).
  if (process.platform === 'linux' && process.env.APPIMAGE === undefined) {
    const debArch = { x64: 'amd64', arm64: 'arm64' }[process.arch] ?? process.arch
    return watchReleases({
      current: app.getVersion(), arch: process.arch, feed, ask: throwaway ? undefined : askDownload, open: url => shell.openExternal(url),
      asset: version => `DeepSeek-Bot-${version}-linux-${debArch}.deb`,
    })
  }
  if (process.platform === 'win32' || process.platform === 'linux') {
    return watchUpdates({ updater: electronUpdater.autoUpdater, feed, ask: throwaway ? undefined : askRestart, beforeInstall: stopHost })
  }
  return undefined
}

async function askRestart(version) {
  // After a failed start, fail() installs the update itself.
  if (failed) return false
  const t = localeText(UPDATE_TEXT)
  const { response } = await dialog.showMessageBox(owner(), { type: 'info', title: 'DeepSeek Bot', message: t.ready(version), detail: t.readyDetail, buttons: [t.restart, t.later], defaultId: 0, cancelId: 1, noLink: true })
  return response === 0
}

async function askDownload(version) {
  if (failed) return false
  const t = localeText(UPDATE_TEXT)
  const { response } = await dialog.showMessageBox(owner(), { type: 'info', title: 'DeepSeek Bot', message: t.available(version), detail: t.availableDetail, buttons: [t.download, t.later], defaultId: 0, cancelId: 1, noLink: true })
  return response === 0
}

// Hidden, on the rect the start window grows into; the start window shows it at the hand-off.
function createWindow() {
  const dark = nativeTheme.shouldUseDarkColors
  const win32 = process.platform === 'win32'
  mainWindow = new BrowserWindow({
    ...startWindow.mainBounds(), minWidth: 720, minHeight: 480,
    title: 'DeepSeek Bot', show: false, icon: iconFile,
    backgroundColor: mica ? '#00000000' : dark ? '#1b1b1c' : '#ffffff',
    // Frameless as in DSH Desktop: the caption buttons overlay the page's band. They keep the
    // sidebar's colors until the page sends the colors of the surface under them.
    ...(win32 ? {
      titleBarStyle: 'hidden',
      titleBarOverlay: { height: CAPTION_HEIGHT, color: dark ? '#1b1b1c' : '#f9fafb', symbolColor: dark ? '#f9fafb' : '#0f1115' },
      ...(mica ? { backgroundMaterial: 'mica' } : {}),
    } : {}),
    webPreferences: {
      preload: join(here, 'preload.cjs'), contextIsolation: true, sandbox: true, webviewTag: true,
      additionalArguments: [`--ds-bot-origin=${origin}`, ...(win32 ? [`--ds-bot-caption=${String(CAPTION_HEIGHT)}`, ...(mica ? ['--ds-bot-mica'] : [])] : [])],
    },
  })
  startWindow.placeMain(mainWindow)
  mainWindow.on('page-title-updated', (event) => { event.preventDefault() })
  mainWindow.on('closed', () => { mainWindow = undefined })
  browserGuests.bind(mainWindow)
  const contents = mainWindow.webContents
  contents.session.on('will-download', downloadSaver({ window: mainWindow, dialog, getPath: name => app.getPath(name) }))
  if (win32) {
    // Fullscreen hides the caption buttons, and the page drops its band meanwhile. A reload
    // registers the page's listener again, so the state goes out after every load too.
    const sendFullscreen = () => { if (mainWindow !== undefined) contents.send(IPC.fullscreen, mainWindow.isFullScreen()) }
    mainWindow.on('enter-full-screen', sendFullscreen)
    mainWindow.on('leave-full-screen', sendFullscreen)
    contents.on('did-finish-load', sendFullscreen)
  }
  if (mica) {
    const css = readFileSync(join(here, 'mica.css'), 'utf8')
    contents.on('dom-ready', () => { void contents.insertCSS(css) })
  }
  contents.setWindowOpenHandler(({ url }) => {
    // DSH's sign-in opens a blank window during the click and sends it to the sign-in page later.
    if (url === 'about:blank') return { action: 'allow', overrideBrowserWindowOptions: { show: false, webPreferences: { sandbox: true, webviewTag: false } } }
    openOutside(url)
    return { action: 'deny' }
  })
  contents.on('did-create-window', (child) => {
    const away = (event, url) => {
      if (url === 'about:blank') return
      event.preventDefault()
      openOutside(url)
      child.destroy()
    }
    child.webContents.on('will-navigate', away)
    child.webContents.on('will-redirect', away)
  })
  contents.on('will-navigate', (event, url) => {
    if (url.startsWith(`${origin}/`)) return
    event.preventDefault()
    openOutside(url)
  })
  if (!app.isPackaged) {
    contents.on('before-input-event', (_event, input) => {
      if (input.type === 'keyDown' && (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i'))) contents.toggleDevTools()
    })
  }
}

function setMenu() {
  if (process.platform !== 'darwin') { Menu.setApplicationMenu(null); return }
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'fileMenu' }, { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' }]))
}

// The window that is showing: the start window until the hand-off (also after a failed start),
// then the team window. A second launch is how the user finds it again.
function focusWindow() {
  if (startWindow.focus() || mainWindow === undefined) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function assertWindow(event) {
  const contents = mainWindow?.webContents
  if (contents === undefined || event.sender !== contents || event.senderFrame !== contents.mainFrame
    || !event.senderFrame.url.startsWith(`${origin}/`)) throw new Error('DeepSeek Bot: rejected IPC from an unknown page')
}

function fromWindow(event) {
  try { assertWindow(event); return true } catch { return false }
}

function openOutside(url) {
  if (/^https?:\/\//iu.test(url)) void shell.openExternal(url)
}

// The start window shows the failure page and stays. A new version may fix what keeps this one
// from starting: one that installs itself does so once it is downloaded, unless the user has
// tried again meanwhile; a release page (macOS, a Linux deb) waits for the page's update row.
async function fail(error) {
  console.error(error)
  if (failed || stopping) return
  failed = true
  const mine = attempt
  startWindow.fail(error, startKind())
  const found = await Promise.race([updates?.latest() ?? null, sleep(UPDATE_CHECK_WAIT_MS).then(() => null)])
  if (!found || mine !== attempt) return
  if (found.page) {
    console.log(`DeepSeek Bot: ${found.version} is out: ${found.page}`)
    return
  }
  if (await Promise.race([found.downloaded, sleep(UPDATE_DOWNLOAD_WAIT_MS).then(() => false)]) && failed && mine === attempt) await updates.install()
}
