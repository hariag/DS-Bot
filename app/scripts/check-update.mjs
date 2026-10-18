// Check the update of a packaged app on Windows: serve a folder with a latest.yml and its
// installer, start the app on throwaway folders with that feed, and wait until the app has
// downloaded the update and checked its sha512. Then close the app as a user does, so that it
// installs the update as it quits, or with --kill end it at once, so that nothing is installed.
// Usage: node scripts/check-update.mjs <app executable> <feed folder> [--kill]
import { spawn, spawnSync } from 'node:child_process'
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const [executable, feedDir, mode] = process.argv.slice(2)
if (!executable || !feedDir || !existsSync(executable) || !existsSync(join(feedDir, 'latest.yml'))) {
  console.error('check-update: usage: node scripts/check-update.mjs <app executable> <feed folder with latest.yml> [--kill]')
  process.exit(2)
}
const version = /^version:\s*(\S+)/mu.exec(readFileSync(join(feedDir, 'latest.yml'), 'utf8'))?.[1]
const work = mkdtempSync(join(tmpdir(), 'ds-bot-update-'))
mkdirSync(join(work, 'home'))

const served = []
const server = createServer((request, response) => {
  const name = basename(decodeURIComponent(new URL(request.url, 'http://feed/').pathname))
  const file = join(feedDir, name)
  served.push(name)
  if (!existsSync(file) || !statSync(file).isFile()) { response.writeHead(404).end(); return }
  response.writeHead(200, { 'content-length': statSync(file).size })
  createReadStream(file).pipe(response)
})
await new Promise((done) => { server.listen(0, '127.0.0.1', done) })
const feed = `http://127.0.0.1:${String(server.address().port)}/`

let failed = false
let app
try {
  // A terminal inside an Electron-based editor may set ELECTRON_RUN_AS_NODE, which turns the app into plain Node.
  const { ELECTRON_RUN_AS_NODE: _runAsNode, ...env } = process.env
  Object.assign(env, { DS_BOT_HOME: join(work, 'home'), DS_BOT_SHELL_DATA: join(work, 'shell'), DS_BOT_UPDATE_URL: feed })
  app = spawn(resolve(executable), [], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  const exited = new Promise((done) => { app.once('exit', (code) => { done(code) }) })
  let output = ''
  for (const stream of [app.stdout, app.stderr]) {
    stream.setEncoding('utf8')
    stream.on('data', (chunk) => { output += chunk; process.stdout.write(chunk) })
  }
  const downloaded = `DeepSeek Bot: update ${String(version)} downloaded`
  const end = Date.now() + 5 * 60_000
  while (!output.includes(downloaded)) {
    if (/DeepSeek Bot: update failed/u.test(output)) throw new Error('the app reported a failed update')
    if (app.exitCode !== null) throw new Error(`the app exited (code ${String(app.exitCode)}) before the update was downloaded`)
    if (Date.now() > end) throw new Error('the update was not downloaded within 5 minutes')
    await sleep(500)
  }
  console.log(`check-update: ${downloaded}; the feed served ${served.join(', ')}`)
  if (mode === '--kill') {
    spawnSync('taskkill', ['/pid', String(app.pid), '/T', '/F'], { stdio: 'ignore' })
    await exited
    console.log('check-update: ended the app, so nothing was installed')
  } else {
    // Without /F, taskkill asks the window to close, as a user closing it does.
    spawnSync('taskkill', ['/pid', String(app.pid)], { stdio: 'ignore' })
    const code = await Promise.race([exited, sleep(60_000).then(() => 'timeout')])
    if (code === 'timeout') throw new Error('the app did not exit after its window closed')
    if (code !== 0) throw new Error(`the app exited with code ${String(code)}, so it does not install the update`)
    console.log('check-update: the app closed; its installer runs now')
  }
  console.log('check-update: passed')
} catch (error) {
  failed = true
  console.error(`check-update: FAILED: ${error instanceof Error ? error.message : String(error)}`)
  if (app?.exitCode === null) spawnSync('taskkill', ['/pid', String(app.pid), '/T', '/F'], { stdio: 'ignore' })
}
server.close()
await sleep(500)
rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 })
process.exit(failed ? 1 : 0)
