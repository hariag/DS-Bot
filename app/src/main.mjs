// Electron main process: one window for the Bot team, served by the app's own DSH Host.
// The dsh-app scheme and the request forwarding follow DeepSeek Harness
// apps/desktop/src/main.ts (MIT); see NOTICE.
import { app, BrowserWindow, dialog, Menu, nativeTheme, protocol, screen, shell } from 'electron'
import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HostProcess } from './host-process.mjs'
import { APP_ORIGIN, authenticateWebHost, forwardWebRequest, serveFile } from './web.mjs'

// DSH writes dsh-app://app/ into workspace file URLs and Markdown file links, so the window keeps that scheme.
const SCHEME = 'dsh-app'
// The window has no title bar: its page draws a band this high along the top (--dsb-band
// in ui/src/app.css), and the system's window buttons sit in it.
const BAND = 48

const here = dirname(fileURLToPath(import.meta.url))
// The window is the app's own build (ui/, `npm run build`); everything under /api/ goes to the Host.
const uiDist = join(here, '..', 'ui', 'dist')
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
  if (!existsSync(join(uiDist, 'index.html'))) throw new Error('The window is not built. Run npm run build in app/.')
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

  // The window opens while the Host boots; its first requests wait for the Host.
  protocol.handle(SCHEME, async (request) => {
    const url = new URL(request.url)
    if (url.hostname !== 'app') return new Response(null, { status: 404 })
    if (!url.pathname.startsWith('/api/')) return serveFile(request, uiDist)
    const target = hostState ?? await ready.catch(() => undefined)
    if (target === undefined) return new Response(null, { status: 503 })
    return forwardWebRequest(request, target.url, target.cookie)
  })

  setMenu()
  createWindow()
  nativeTheme.on('updated', () => {
    if (mainWindow === undefined) return
    mainWindow.setBackgroundColor(windowFill())
    if (process.platform !== 'darwin') mainWindow.setTitleBarOverlay(windowButtons())
  })
}

const windowFill = () => (nativeTheme.shouldUseDarkColors ? '#141414' : '#fcfcfc')
// Clear, so the buttons sit on the page's own colors; the symbols take its text color.
const windowButtons = () => ({ color: '#00000000', symbolColor: nativeTheme.shouldUseDarkColors ? '#f2f2f2' : '#141414', height: BAND })

function createWindow() {
  const area = screen.getPrimaryDisplay().workAreaSize
  mainWindow = new BrowserWindow({
    width: Math.min(1320, Math.round(area.width * 0.9)), height: Math.min(860, Math.round(area.height * 0.9)),
    minWidth: 720, minHeight: 480,
    title: 'DeepSeek Bot', show: false,
    titleBarStyle: 'hidden',
    // macOS keeps its traffic lights, centered in the band; Windows and Linux draw their
    // buttons over the band's right end.
    ...(process.platform === 'darwin' ? { trafficLightPosition: { x: 18, y: (BAND - 12) / 2 } } : { titleBarOverlay: windowButtons() }),
    backgroundColor: windowFill(),
    webPreferences: { contextIsolation: true, sandbox: true },
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
