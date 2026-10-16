// Electron main process: one window for the Bot team, served by the app's own DSH Host.
// The dsh-app scheme, the request forwarding and the WebSocket header rewrite follow
// DeepSeek Harness apps/desktop/src/main.ts (MIT); see NOTICE.
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, protocol, session, shell } from 'electron'
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HostProcess } from './host-process.mjs'
import { APP_ORIGIN, authenticateWebHost, forwardWebRequest, serveWebDocument } from './web.mjs'

// DSH writes dsh-app://app/ into workspace file URLs and Markdown file links, so the window keeps that scheme.
const SCHEME = 'dsh-app'
const IPC = { boot: 'ds-bot:boot', bootFailed: 'ds-bot:boot-failed' }
const STATIC_PATHS = new Set(['/', '/index.html', '/manifest.webmanifest'])

const here = dirname(fileURLToPath(import.meta.url))
const webDist = join(dirname(createRequire(import.meta.url).resolve('@deepseek-ai/dsh-web-frontend/package.json')), 'dist')
const dataDir = process.env.DS_BOT_HOME || join(homedir(), '.ds-bot')
if (process.env.DS_BOT_SHELL_DATA) app.setPath('userData', process.env.DS_BOT_SHELL_DATA)

protocol.registerSchemesAsPrivileged([{
  scheme: SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, codeCache: true },
}])

let mainWindow
let host
let hostState
let stopping = false
let stopped = false
let failed = false

if (!app.requestSingleInstanceLock()) {
  app.exit(0)
} else {
  app.on('second-instance', focusWindow)
  app.on('window-all-closed', () => { app.quit() })
  app.on('before-quit', (event) => {
    if (stopped || host === undefined) return
    event.preventDefault()
    if (stopping) return
    stopping = true
    host.stop().catch((error) => { console.error(error) }).finally(() => { stopped = true; app.quit() })
  })
  app.whenReady().then(start).catch(fail)
}

function start() {
  const profileDir = join(dataDir, 'profiles', 'ds-bot')
  mkdirSync(profileDir, { recursive: true })
  host = new HostProcess({
    entry: join(here, 'host.mjs'),
    cwd: profileDir,
    env: { ...process.env, DSH_HOME: dataDir, DS_BOT_APP: '1' },
    pnpm: join(app.getAppPath(), 'node_modules', 'pnpm', 'bin', 'pnpm.mjs'),
    onFailure: fail,
  })
  const ready = host.start().then(async (started) => {
    hostState = { ...started, cookie: await authenticateWebHost(started.url) }
    return hostState
  })
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
  createWindow()
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1320, height: 860, minWidth: 720, minHeight: 480,
    title: 'DeepSeek Bot', show: false,
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
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' }]))
}

function focusWindow() {
  if (mainWindow === undefined) return
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

function fail(error) {
  console.error(error)
  if (failed || stopping) return
  failed = true
  dialog.showErrorBox('DeepSeek Bot', `DeepSeek Bot could not start.\n\n${error instanceof Error ? error.message : String(error)}`)
  app.quit()
}
