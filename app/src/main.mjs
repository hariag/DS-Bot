// Electron main process: one window for the Bot team, served by the app's own DSH Host.
// The dsh-app scheme, the request forwarding and the WebSocket header rewrite follow
// DeepSeek Harness apps/desktop/src/main.ts (MIT); see NOTICE.
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, protocol, session, shell } from 'electron'
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { getDshRuntimeVersion } from '@deepseek-ai/dsh-app-boot'
import electronUpdater from 'electron-updater'
import { chooseLocations, localeText, saveLocations, text } from './first-run.mjs'
import { HostProcess } from './host-process.mjs'
import { copySessions, findTeam, importTeam } from './import.mjs'
import { CHECK_PROFILE, PROFILE } from './profile.mjs'
import { UPDATE_TEXT, watchReleases, watchUpdates } from './updates.mjs'
import { APP_ORIGIN, authenticateWebHost, forwardWebRequest, serveWebDocument } from './web.mjs'

// DSH writes dsh-app://app/ into workspace file URLs and Markdown file links, so the window keeps that scheme.
const SCHEME = 'dsh-app'
const IPC = { boot: 'ds-bot:boot', bootFailed: 'ds-bot:boot-failed' }
const STATIC_PATHS = new Set(['/', '/index.html', '/manifest.webmanifest'])
const UPDATE_CHECK_WAIT_MS = 15_000
const UPDATE_DOWNLOAD_WAIT_MS = 15 * 60_000

const here = dirname(fileURLToPath(import.meta.url))
const webDist = join(dirname(createRequire(import.meta.url).resolve('@deepseek-ai/dsh-web-frontend/package.json')), 'dist')
// Drawn by scripts/icon.mjs. Windows takes the .ico for its several sizes.
const iconFile = join(here, '..', 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png')
if (process.env.DS_BOT_SHELL_DATA) app.setPath('userData', process.env.DS_BOT_SHELL_DATA)

protocol.registerSchemesAsPrivileged([{
  scheme: SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, codeCache: true },
}])

let mainWindow
let host
let hostState
let hostStop
let updates
let stopping = false
let stopped = false
let failed = false
// Quitting while a first-run dialog is open stops the first run, and during the copy it waits
// for the copy to stop at a safe point, so that it leaves no half team and no temporary copy.
let choosing
let copying
const copyAbort = new AbortController()

if (!app.requestSingleInstanceLock()) {
  app.exit(0)
} else {
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

async function start() {
  choosing = new AbortController()
  const where = await chooseLocations(choosing.signal).finally(() => { choosing = undefined })
  if (where.quit) { app.exit(0); return }
  const pnpm = join(app.getAppPath(), 'node_modules', 'pnpm', 'bin', 'pnpm.mjs')
  const profileDir = join(where.dataDir, 'profiles', PROFILE)
  mkdirSync(profileDir, { recursive: true })
  const newHost = () => new HostProcess({
    entry: join(here, 'host.mjs'),
    cwd: profileDir,
    env: { ...process.env, DSH_HOME: where.dataDir, DS_BOT_APP: '1', ...(where.workspace ? { DS_BOT_WORKSPACE: where.workspace } : {}) },
    pnpm,
    onFailure: fail,
  })
  // A failed check is not a failed start: start() rejects, and the copy goes on unchecked.
  const newCheck = (home, list) => {
    const cwd = join(home, 'profiles', CHECK_PROFILE)
    mkdirSync(cwd, { recursive: true })
    return new HostProcess({ entry: join(here, 'host.mjs'), cwd, env: { ...process.env, DSH_HOME: home, DS_BOT_CHECK: list }, pnpm, onFailure: () => {} })
  }
  const ready = (async () => {
    let copied
    if (where.import) {
      copying = copyTeam(where, newHost, newCheck, copyAbort.signal)
      copied = await copying
      copying = undefined
    }
    if (copied === 'quit') app.exit(0)
    // The window may be waiting for the Host; it goes away with the app.
    if (copied !== undefined) return new Promise(() => {})
    // Not during the import, which a restart would cut short; before the Host, so that an
    // update can still come when this version's Host does not start.
    updates = startUpdates()
    host = newHost()
    const started = await host.start()
    hostState = { ...started, cookie: await authenticateWebHost(started.url) }
    return hostState
  })()
  ready.catch(fail)

  protocol.handle(SCHEME, (request) => {
    const url = new URL(request.url)
    if (url.hostname !== 'app') return new Response(null, { status: 404 })
    if (STATIC_PATHS.has(url.pathname) || url.pathname.startsWith('/assets/')) return serveWebDocument(request, webDist)
    if (hostState === undefined) return new Response(null, { status: 503 })
    return forwardWebRequest(request, hostState.url, hostState.cookie)
  })

  ipcMain.handle(IPC.boot, async (event) => {
    assertWindow(event)
    const { url, injections } = await ready
    return { injections, streamBaseUrl: new URL(url).origin }
  })
  ipcMain.handle(IPC.bootFailed, (event, message) => {
    assertWindow(event)
    fail(new Error(String(message)))
  })

  // The stream connects to the Host directly; the Host accepts only its own origin and cookie.
  session.defaultSession.webRequest.onBeforeSendHeaders({ urls: ['ws://127.0.0.1/*'] }, (details, callback) => {
    if (hostState === undefined || details.webContentsId !== mainWindow?.webContents.id) { callback({}); return }
    const target = new URL(hostState.url)
    if (new URL(details.url).host !== target.host) { callback({}); return }
    const headers = Object.fromEntries(Object.entries(details.requestHeaders).map(([name, value]) => [name.toLowerCase(), value]))
    if (headers.origin !== APP_ORIGIN) { callback({ cancel: true }); return }
    callback({ requestHeaders: { ...headers, origin: target.origin, cookie: hostState.cookie, 'sec-fetch-site': 'same-origin' } })
  })

  setMenu()
  // A packaged app has the icon in its bundle; Electron's own run shows Electron's.
  if (process.platform === 'darwin' && !app.isPackaged) app.dock?.setIcon(iconFile)
  createWindow()
}

// The Host starts once on the new data location first: DSH then sets up its project list
// without the copied Sessions' folders, so the old team's folders are not offered as projects.
// Before that, the app's own DSH reads every chat of the team once: a newer DSH can write
// records that this one refuses while the log format stays the same. Such a chat stops the
// copy, as a newer log format does; 'quit' means the user updates DeepSeek Bot first, and
// 'stopped' that the app quit during the copy.
async function copyTeam(where, newHost, newCheck, signal) {
  const unreadable = await checkTeam(where, newCheck, signal)
  if (signal.aborted) return 'stopped'
  if (unreadable > 0) {
    const t = text()
    const { response } = await dialog.showMessageBox({ type: 'warning', title: 'DeepSeek Bot', noLink: true, message: t.newer(unreadable), buttons: [t.quit, t.startEmpty], defaultId: 0, cancelId: 0, signal })
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
    mainWindow?.setProgressBar(2)
    await warm.stop()
    host = undefined
    const summary = await importTeam({ ...where.import, to: where.dataDir, workspace: where.workspace, dsh: getDshRuntimeVersion(), signal })
    console.log(`DeepSeek Bot: copied ${String(summary.bots)} Bots and ${String(summary.sessions)} Sessions from ${summary.from}`)
  } catch (error) {
    if (signal.aborted) return 'stopped'
    console.error(error)
    await dialog.showMessageBox({ type: 'warning', title: 'DeepSeek Bot', message: text().failed(error instanceof Error ? error.message : String(error)), signal })
    if (signal.aborted) return 'stopped'
  } finally {
    signal.removeEventListener('abort', stopWarm)
    mainWindow?.setProgressBar(-1)
  }
  saveLocations(where)
  return undefined
}

// A copy of the chats in a DSH home of its own, so that nothing of the check stays in the data.
async function checkTeam(where, newCheck, signal) {
  // A run that was killed can leave its temporary check home behind.
  for (const name of readdirSync(where.dataDir).filter(entry => /^\.import-check-\d+$/u.test(entry))) {
    await rm(join(where.dataDir, name), { recursive: true, force: true }).catch((error) => { console.error(error) })
  }
  const home = join(where.dataDir, `.import-check-${String(Date.now())}`)
  try {
    const found = findTeam(where.import.from)
    const ids = found === undefined ? [] : await copySessions(where.import.from, found.team, home, signal)
    if (ids.length === 0) return 0
    mainWindow?.setProgressBar(2)
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
    mainWindow?.setProgressBar(-1)
    await rm(home, { recursive: true, force: true, maxRetries: 5 }).catch((error) => { console.error(error) })
  }
}

// Windows updates itself; macOS asks to download the new version. Throwaway runs check only a
// given feed and never ask.
function startUpdates() {
  const feed = process.env.DS_BOT_UPDATE_URL || undefined
  const throwaway = Boolean(process.env.DS_BOT_HOME)
  if (!app.isPackaged || (throwaway && feed === undefined)) return undefined
  if (process.platform === 'darwin') {
    return watchReleases({
      current: app.getVersion(), arch: process.arch, feed, ask: throwaway ? undefined : askDownload, open: url => shell.openExternal(url),
    })
  }
  if (process.platform === 'win32') {
    return watchUpdates({ updater: electronUpdater.autoUpdater, feed, ask: throwaway ? undefined : askRestart, beforeInstall: stopHost })
  }
  return undefined
}

async function askRestart(version) {
  // After a failed start, fail() installs the update itself.
  if (failed) return false
  const t = localeText(UPDATE_TEXT)
  const options = { type: 'info', title: 'DeepSeek Bot', message: t.ready(version), detail: t.readyDetail, buttons: [t.restart, t.later], defaultId: 0, cancelId: 1, noLink: true }
  const { response } = await (mainWindow ? dialog.showMessageBox(mainWindow, options) : dialog.showMessageBox(options))
  return response === 0
}

async function askDownload(version) {
  if (failed) return false
  const t = localeText(UPDATE_TEXT)
  const options = { type: 'info', title: 'DeepSeek Bot', message: t.available(version), detail: t.availableDetail, buttons: [t.download, t.later], defaultId: 0, cancelId: 1, noLink: true }
  const { response } = await (mainWindow ? dialog.showMessageBox(mainWindow, options) : dialog.showMessageBox(options))
  return response === 0
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1320, height: 860, minWidth: 720, minHeight: 480,
    title: 'DeepSeek Bot', show: false, icon: iconFile,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1b1b1c' : '#ffffff',
    webPreferences: { preload: join(here, 'preload.cjs'), contextIsolation: true, sandbox: true },
  })
  mainWindow.once('ready-to-show', () => { mainWindow?.show() })
  mainWindow.on('page-title-updated', (event) => { event.preventDefault() })
  mainWindow.on('closed', () => { mainWindow = undefined })
  const contents = mainWindow.webContents
  contents.setWindowOpenHandler(({ url }) => { openOutside(url); return { action: 'deny' } })
  contents.on('will-navigate', (event, url) => {
    if (url.startsWith(`${APP_ORIGIN}/`)) return
    event.preventDefault()
    openOutside(url)
  })
  if (!app.isPackaged) {
    contents.on('before-input-event', (_event, input) => {
      if (input.type === 'keyDown' && (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i'))) contents.toggleDevTools()
    })
  }
  void mainWindow.loadURL(`${APP_ORIGIN}/`)
}

function setMenu() {
  if (process.platform !== 'darwin') { Menu.setApplicationMenu(null); return }
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'fileMenu' }, { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' }]))
}

function focusWindow() {
  if (mainWindow === undefined || failed) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function assertWindow(event) {
  const contents = mainWindow?.webContents
  if (contents === undefined || event.sender !== contents || event.senderFrame !== contents.mainFrame
    || !event.senderFrame.url.startsWith(`${APP_ORIGIN}/`)) throw new Error('DeepSeek Bot: rejected IPC from an unknown page')
}

function openOutside(url) {
  if (/^https?:\/\//iu.test(url)) void shell.openExternal(url)
}

// A new version may fix what keeps this one from starting.
async function fail(error) {
  console.error(error)
  if (failed || stopping) return
  failed = true
  const found = await Promise.race([updates?.latest() ?? null, sleep(UPDATE_CHECK_WAIT_MS).then(() => null)])
  const throwaway = Boolean(process.env.DS_BOT_HOME)
  const t = localeText(UPDATE_TEXT)
  const next = found ? `\n\n${found.page ? t.onFailurePage(found.version) : t.onFailure(found.version)}` : ''
  dialog.showErrorBox('DeepSeek Bot', `${text().notStarted}\n\n${error instanceof Error ? error.message : String(error)}${next}`)
  if (found?.page) {
    if (!throwaway) await shell.openExternal(found.page)
    app.quit()
    return
  }
  if (found) {
    mainWindow?.hide()
    if (await Promise.race([found.downloaded, sleep(UPDATE_DOWNLOAD_WAIT_MS).then(() => false)])) {
      await updates.install()
      return
    }
  }
  app.quit()
}
