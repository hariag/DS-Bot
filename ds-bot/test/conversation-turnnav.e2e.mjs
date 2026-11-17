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
const log = readFileSync(join(home, 'web.log'), 'utf8')
const url = log.match(new RegExp(`http://127\\.0\\.0\\.1:${port}/\\?token=[^\\s]+`))?.[0]
if (!url) throw new Error('mock bench is not running')
const response = await fetch(url, { redirect: 'manual' })
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
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  const rail = page.locator('nav:has([class*="_marks"])').first()
  async function checkRail(label) {
    await rail.waitFor({ state: 'visible', timeout: 30000 })
    await page.waitForFunction(() => document.querySelector('nav [class*="_marks"]')?.querySelectorAll('button').length >= 2)
    const marks = rail.locator('button')
    assert.ok(await marks.count() >= 2, `${label}: multiple turn marks`)
    const scroll = page.locator('[data-conversation-scroll]').first()
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
  await checkRail('private chat')
  await page.locator(`[data-room-id="${room.id}"]`).first().click()
  await page.waitForTimeout(1000)
  await checkRail('group chat')
  await page.setViewportSize({ width: 850, height: 1000 })
  await page.waitForTimeout(300)
  assert.equal(await rail.isVisible(), false, 'the host keeps the rail hidden in narrow columns')
  console.log('narrow column: host responsive behavior preserved')
} finally {
  await browser.close()
}
