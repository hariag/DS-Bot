// Run only against an isolated mock bench: node test/conversation-turnnav.e2e.mjs <name> <port>
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import { modelsFor } from '../src/client/agent-routes.js'

const [name, port] = process.argv.slice(2)
if (!/^[a-z0-9-]+$/.test(name ?? '') || !/^\d+$/.test(port ?? '') || port === '3080') throw new Error('use an isolated mock bench name and port')
const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const home = join(root, `.dsh-test-${name}`)
// The mock bench starts its web process with this dedicated DSH_HOME. Refuse a
// different process even if a caller picked the same port or copied a log.
if (process.platform === 'linux') {
  const pid = Number(readFileSync(join(home, 'web.pid'), 'utf8').trim())
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error('invalid mock bench process')
  const env = readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0')
  if (!env.includes(`DSH_HOME=${home}`)) throw new Error('mock bench home does not match')
}
const log = readFileSync(join(home, 'web.log'), 'utf8')
const url = log.match(new RegExp(`http://127\\.0\\.0\\.1:${port}/\\?token=[^\\s]+`))?.[0]
if (!url) throw new Error('mock bench is not running')
let response
try { response = await fetch(url, { redirect: 'manual' }) } catch { throw new Error('could not connect to mock bench') }
const cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
async function api(endpoint, payload = {}) {
  const response = await fetch(`http://127.0.0.1:${port}/api/bot`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ endpoint, payload }) })
  const result = await response.json()
  if (!result.ok) throw new Error(`${endpoint}: ${result.error?.message}`)
  return result.value
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function settle() {
  let quiet = 0
  for (let i = 0; i < 150; i++) {
    await sleep(300)
    const state = await api('state')
    if (Object.keys(state.activity ?? {}).length === 0) { if (++quiet >= 7) return } else quiet = 0
  }
  throw new Error('mock team did not become idle')
}
let state = await api('state')
const chief = state.bots.find(bot => bot.name === 'Chief')
assert.ok(chief)
if (!chief.model) {
  const models = modelsFor(state.models)
  assert.ok(models.length)
  await api('update-bot', { id: chief.id, model: models.at(-1).ref })
  await settle()
}
for (let i = 1; i <= 4; i++) {
  await api('send', { sessionId: chief.id, text: `Private turn ${i}: ${'fixture '.repeat(140)}` })
  await settle()
}
state = await api('state')
const peer = state.bots.find(bot => bot.name === 'Turn Tester') ?? await api('create-bot', { name: 'Turn Tester', role: 'Tester', instructions: 'Respond to the group.' })
await settle()
const room = await api('create-room', { name: 'Turn navigation fixture', members: [chief.id, peer.id], admin: chief.id })
for (let i = 1; i <= 3; i++) {
  await api('send', { sessionId: room.id, text: `Group turn ${i}: ${'fixture '.repeat(140)}` })
  await settle()
}
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_BIN || undefined, args: ['--no-sandbox'] })
try {
  const page = await browser.newPage({ viewport: { width: 1709, height: 1000 }, reducedMotion: 'reduce' })
  try { await page.goto(url, { waitUntil: 'domcontentloaded' }) } catch { throw new Error('could not open mock bench') }
  const rail = page.locator('nav:has([class*="_marks"])').first()
  async function checkRail(label) {
    await rail.waitFor({ state: 'visible', timeout: 30000 })
    await page.waitForFunction(() => document.querySelector('nav [class*="_marks"]')?.querySelectorAll('button').length >= 2)
    const marks = rail.locator('button')
    assert.ok(await marks.count() >= 2, `${label}: multiple turn marks`)
    const scroll = page.locator('[data-conversation-scroll]').first()
    await scroll.evaluate(el => { el.scrollTop = el.scrollHeight })
    await page.waitForFunction(() => (document.querySelector('[data-conversation-scroll]')?.scrollTop ?? 0) > 100)
    const before = await scroll.evaluate(el => el.scrollTop)
    await marks.first().hover()
    await page.waitForFunction(() => !!document.querySelector('nav [role="tooltip"]'))
    await marks.first().click()
    await page.waitForFunction(beforeTop => {
      const el = document.querySelector('[data-conversation-scroll]')
      return el && Math.abs(el.scrollTop - beforeTop) > 10
    }, before, { timeout: 10000 })
    await page.waitForFunction(() => document.querySelector('nav [class*="_marks"] button')?.getAttribute('aria-current') === 'true')
    console.log(`${label}: visible marks, hover preview and click navigation passed`)
  }
  const privateButton = page.locator(`[data-bot-id="${chief.id}"]`).first()
  await privateButton.click()
  await page.waitForFunction(id => document.querySelector(`[data-bot-id="${id}"]`)?.getAttribute('aria-current') === 'page', chief.id)
  await page.waitForFunction(() => document.querySelector('[data-conversation-scroll]')?.textContent.includes('Private turn'))
  await checkRail('private chat')
  const roomButton = page.locator(`[data-room-id="${room.id}"]`).first()
  await roomButton.click()
  await page.waitForFunction(id => document.querySelector(`[data-room-id="${id}"]`)?.getAttribute('aria-current') === 'page', room.id)
  await page.waitForFunction(() => document.querySelector('[data-conversation-scroll]')?.textContent.includes('Group turn'))
  await checkRail('group chat')
  await page.setViewportSize({ width: 850, height: 1000 })
  await page.waitForTimeout(300)
  assert.equal(await rail.isVisible(), false, 'the host keeps the rail hidden in narrow columns')
  console.log('narrow column: host responsive behavior preserved')
} finally {
  await browser.close()
}
