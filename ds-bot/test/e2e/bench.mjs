// Bench management for the DS-Bot task-board E2E run.
//
// Starts the scripted mock model (dev/mock-llm.mjs) and a dsh web whose profile
// links the ds-bot plugin to this checkout, using the npm-installed harness under
// dev/harness. It does not use pnpm; the profile is a plain package directory with
// a node_modules/ds-bot junction, which is all dsh needs to resolve the bundle.
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import * as os from 'node:os'
import { fileURLToPath } from 'node:url'
import { isPrivateDirectory } from '../../src/host/private-storage.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
export const PLUGIN = resolve(HERE, '..', '..')            // ds-bot/
export const REPO = resolve(PLUGIN, '..')                 // checkout root

export const DEFAULTS = {
  home: join(REPO, '.dsh-test-board-e2e'),
  webPort: 3097,
  mockPort: 8797,
  chrome: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  harness: join(PLUGIN, 'dev', 'harness'),
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// run_code (and some DSH hosts) expose the Electron executable as process.execPath;
// a plain node on PATH is what actually runs the bench scripts there.
const NODE = process.env.BOARD_E2E_NODE || (process.versions.electron ? 'C:\\Program Files\\nodejs\\node.exe' : process.execPath)

// The DSH tool runtime starts programs with an empty environment; give the child
// processes the ordinary Windows variables they expect. In a normal shell this
// merges into the inherited environment unchanged.
function benchEnv(extra = {}) {
  if (process.platform !== 'win32') return { ...process.env, ...extra }
  const home = (() => { try { return os.userInfo().homedir } catch { return 'C:\\Users\\Public' } })()
  const base = {
    SystemRoot: 'C:\\Windows',
    windir: 'C:\\Windows',
    ComSpec: 'C:\\Windows\\System32\\cmd.exe',
    PATH: ['C:\\Program Files\\nodejs', 'C:\\Windows\\System32', 'C:\\Windows', 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0'].join(';'),
    TEMP: 'C:\\Windows\\Temp',
    TMP: 'C:\\Windows\\Temp',
    USERPROFILE: home,
    HOMEDRIVE: home.slice(0, 2),
    HOMEPATH: home.slice(2) || '\\',
    APPDATA: join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(home, 'AppData', 'Local'),
  }
  return { ...base, ...process.env, ...extra }
}

export function portOpen(port, host = '127.0.0.1', timeout = 500) {
  return new Promise(resolve => {
    const socket = connect({ port, host })
    const done = value => { socket.destroy(); resolve(value) }
    socket.setTimeout(timeout)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

export async function waitPort(port, up, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await portOpen(port) === up) return true
    await sleep(200)
  }
  return false
}

function pidFile(home, name) { return join(home, name + '.pid') }

function readPid(home, name) {
  try { return Number(readFileSync(pidFile(home, name), 'utf8').trim()) || undefined } catch { return undefined }
}

function alive(pid) {
  if (!pid) return false
  try { process.kill(pid, 0); return true } catch { return false }
}

function killTree(pid) {
  if (!pid) return
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
  else { try { process.kill(-pid, 'SIGTERM') } catch { try { process.kill(pid, 'SIGTERM') } catch {} } }
}

export async function stopBench(options = {}) {
  const { home = DEFAULTS.home, webPort = DEFAULTS.webPort, mockPort = DEFAULTS.mockPort } = options
  for (const name of ['web', 'mock']) {
    const pid = readPid(home, name)
    if (pid && alive(pid)) killTree(pid)
    try { rmSync(pidFile(home, name), { force: true }) } catch {}
  }
  const freeWeb = await waitPort(webPort, false, 15_000)
  const freeMock = await waitPort(mockPort, false, 15_000)
  return { webPortFree: freeWeb, mockPortFree: freeMock }
}

function secureDir(path) {
  if (process.platform !== 'win32') { try { fsChmod(path, 0o700) } catch {} ; return }
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '$path = $env:DSBOT_E2E_HOME',
    '$acl = Get-Acl -LiteralPath $path -ErrorAction Stop',
    '$acl.SetOwner([Security.Principal.WindowsIdentity]::GetCurrent().User)',
    '$acl.SetAccessRuleProtection($true, $false)',
    'foreach ($rule in @($acl.Access)) { [void]$acl.RemoveAccessRuleSpecific($rule) }',
    "$inherit = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit",
    "$sids = @([Security.Principal.WindowsIdentity]::GetCurrent().User, [Security.Principal.SecurityIdentifier]::new('S-1-5-18'), [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))",
    'foreach ($sid in $sids) {',
    "  $rule = [Security.AccessControl.FileSystemAccessRule]::new($sid, [Security.AccessControl.FileSystemRights]::FullControl, $inherit, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)",
    '  [void]$acl.AddAccessRule($rule)',
    '}',
    'Set-Acl -LiteralPath $path -AclObject $acl',
  ].join('\n')
  const executable = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
  const result = spawnSync(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8', timeout: 10_000, maxBuffer: 32 * 1024, windowsHide: true,
    env: benchEnv({ DSBOT_E2E_HOME: path }),
  })
  if (result.error || result.status !== 0) {
    throw new Error('could not secure bench home ' + path + ': ' + (result.error?.message || result.stderr?.trim() || 'PowerShell exited ' + result.status))
  }
}

function fsChmod(path, mode) { try { chmodSync(path, mode) } catch {} }

// The board service only opens a home whose board directory has a private DACL.
// New directories inherit it from the home, so the bench home must be secured
// before dsh starts (same rule as test/private-temp.mjs in the repo). A home that
// is already private is left alone: re-applying the DACL needs privileges the
// ordinary test process does not have and would fail a previously valid bench.
function ensurePrivate(path) {
  mkdirSync(path, { recursive: true })
  if (isPrivateDirectory(path)) return
  try { secureDir(path) } catch (error) {
    if (isPrivateDirectory(path)) return
    throw error
  }
  if (!isPrivateDirectory(path)) throw new Error('bench directory is not private: ' + path)
}

function secureBenchHome(home) {
  ensurePrivate(home)
  for (const path of [join(home, 'board-v1'), join(home, 'board-v1', 'images')]) {
    if (existsSync(path)) ensurePrivate(path)
  }
}

function ensureProfile(home) {
  const profile = join(home, 'profiles', 'web')
  mkdirSync(join(profile, 'node_modules'), { recursive: true })
  const manifest = join(profile, 'package.json')
  const wanted = {
    name: 'dsh-profile-web',
    private: true,
    dependencies: { 'ds-bot': 'link:' + PLUGIN },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'ds-bot'] } },
  }
  const text = JSON.stringify(wanted, null, 2) + '\n'
  if (!existsSync(manifest) || readFileSync(manifest, 'utf8') !== text) writeFileSync(manifest, text)
  const link = join(profile, 'node_modules', 'ds-bot')
  let linked = false
  try { linked = existsSync(join(link, 'package.json')) } catch {}
  if (!linked) {
    try { rmSync(link, { recursive: true, force: true }) } catch {}
    symlinkSync(PLUGIN, link, 'junction')
  }
  const patch = join(home, 'bench.patch.yml')
  if (!existsSync(patch)) writeFileSync(patch, '[]\n')
  return profile
}

export async function startBench(options = {}) {
  const opts = { ...DEFAULTS, ...options }
  const { home, webPort, mockPort } = opts
  mkdirSync(home, { recursive: true })

  const webPid = readPid(home, 'web'), mockPid = readPid(home, 'mock')
  if ((webPid && alive(webPid)) || (mockPid && alive(mockPid)) || await portOpen(webPort) || await portOpen(mockPort)) {
    throw new Error('bench ports are already in use; run stopBench()/dev bench stop or pass different ports')
  }

  secureBenchHome(home)
  ensureProfile(home)
  const mockOut = join(home, 'mock.out')
  const mockLog = join(home, 'mock.jsonl')
  const webLog = join(home, 'web.log')
  for (const file of [mockOut, webLog]) { try { rmSync(file, { force: true }) } catch {} }

  const mockArgs = [join(PLUGIN, 'dev', 'mock-llm.mjs'), home]
  const mockOutFd = (await import('node:fs')).openSync(mockOut, 'w')
  const mock = spawn(NODE, mockArgs, {
    cwd: PLUGIN,
    env: benchEnv({ MOCK_PORT: String(mockPort), MOCK_DELAY_MS: process.env.MOCK_DELAY_MS ?? '300', MOCK_LOG: mockLog }),
    detached: true, stdio: ['ignore', mockOutFd, mockOutFd], windowsHide: true,
  })
  mock.unref()
  writeFileSync(pidFile(home, 'mock'), String(mock.pid))
  if (!await waitPort(mockPort, true, 30_000)) throw new Error('mock model did not listen on ' + mockPort)

  const webArgs = [join(opts.harness, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), '--profile', 'web',
    '--patch', join(home, 'bench.patch.yml'), '--no-open', '--port', String(webPort)]
  const out = await import('node:fs').then(fs => fs.openSync(webLog, 'w'))
  const web = spawn(NODE, webArgs, {
    cwd: opts.harness,
    env: benchEnv({ DSH_HOME: home, DEEPSEEK_BASE_URL: 'http://127.0.0.1:' + mockPort + '/v1', DEEPSEEK_API_KEY: 'mock-key' }),
    detached: true, stdio: ['ignore', out, out], windowsHide: true,
  })
  web.unref()
  writeFileSync(pidFile(home, 'web'), String(web.pid))

  const deadline = Date.now() + 180_000
  let loginUrl
  while (Date.now() < deadline) {
    await sleep(300)
    try {
      const log = readFileSync(webLog, 'utf8')
      const match = log.match(new RegExp('http://127\\.0\\.0\\.1:' + webPort + '/\\?token=[^\\s]+'))
      if (match) { loginUrl = match[0]; break }
    } catch {}
    if (!alive(web.pid)) break
  }
  if (!loginUrl) {
    let tail = ''
    try { tail = readFileSync(webLog, 'utf8').split('\n').slice(-30).join('\n') } catch {}
    throw new Error('dsh web did not print a login URL; see ' + webLog + '\n' + tail)
  }
  if (!await waitPort(webPort, true, 30_000)) throw new Error('dsh web did not listen on ' + webPort)
  return { home, webPort, mockPort, base: 'http://127.0.0.1:' + webPort, loginUrl, webLog, mockLog, stop: () => stopBench(opts) }
}

export async function benchStatus(options = {}) {
  const { home = DEFAULTS.home, webPort = DEFAULTS.webPort, mockPort = DEFAULTS.mockPort } = options
  return {
    home,
    web: { pid: readPid(home, 'web'), alive: alive(readPid(home, 'web')), portOpen: await portOpen(webPort) },
    mock: { pid: readPid(home, 'mock'), alive: alive(readPid(home, 'mock')), portOpen: await portOpen(mockPort) },
  }
}

export async function loginToken(loginUrl) {
  const response = await fetch(loginUrl, { redirect: 'manual' })
  const cookies = response.headers.getSetCookie().map(cookie => cookie.split(';')[0])
  if (!cookies.length) throw new Error('login returned no cookie (' + response.status + ')')
  return { cookie: cookies.join('; '), setCookies: response.headers.getSetCookie(), status: response.status }
}

export async function boardApi(base, cookie, endpoint, payload = {}) {
  const response = await fetch(base + '/api/bot', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ endpoint, payload }),
  })
  let result
  try { result = await response.json() } catch { throw new Error(endpoint + ': HTTP ' + response.status) }
  if (!result.ok) throw new Error(endpoint + ': ' + (result.error?.message ?? JSON.stringify(result)))
  return result.value
}

// Small CLI used during development and by the E2E README:
//   node bench.mjs start|stop|status
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const action = process.argv[2] || 'status'
  if (action === 'start') {
    startBench().then(bench => {
      console.log(JSON.stringify({ base: bench.base, loginUrl: bench.loginUrl, home: bench.home }))
      const keep = setInterval(() => {}, 1 << 30)
      const stop = async () => { clearInterval(keep); await stopBench(); process.exit(0) }
      process.on('SIGINT', stop)
      process.on('SIGTERM', stop)
    }).catch(error => { console.error('bench start failed: ' + error.message); process.exit(1) })
  } else if (action === 'stop') {
    stopBench().then(result => { console.log(JSON.stringify(result)); process.exit(0) }).catch(error => { console.error(error.message); process.exit(1) })
  } else if (action === 'status') {
    benchStatus().then(result => { console.log(JSON.stringify(result, null, 2)); process.exit(0) })
  } else { console.error('usage: node bench.mjs start|stop|status'); process.exit(2) }
}
