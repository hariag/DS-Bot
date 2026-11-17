import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { chromium } from 'playwright-core'

const plugin = dirname(dirname(fileURLToPath(import.meta.url)))
const { outputFiles } = await build({
  stdin: { contents: "export { CONVERSATION_CSS } from './src/client/styles.js'", resolveDir: plugin },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent', external: ['react'],
})
const loaded = { exports: {} }
new Function('module', 'exports', 'require', outputFiles[0].text)(loaded, loaded.exports, () => ({}))
const browser = await chromium.launch({ headless: true, ignoreDefaultArgs: ['--hide-scrollbars'], ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {}), args: ['--no-sandbox'] })
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  const messages = Array.from({ length: 24 }, (_, index) => `<p class="message">Example conversation message ${index + 1}</p>`).join('')
  await page.setContent(`<!doctype html><style>
    body{--bt-ink:#141414;margin:0;background:white;color:#141414}
    ::-webkit-scrollbar{width:5px}
    [data-conversation-scroll]{height:300px;overflow-y:auto;width:min(500px,90vw)}
    .content{padding:20px}
    .message{padding:12px;background:color-mix(in srgb,var(--bt-ink) 8%,transparent);border-radius:12px}
  </style><div data-conversation-scroll><div class="content">${messages}</div></div>`)
  await page.addStyleTag({ content: loaded.exports.CONVERSATION_CSS })
  const scroll = page.locator('[data-conversation-scroll]')
  assert.equal(await scroll.evaluate(el => getComputedStyle(el, '::-webkit-scrollbar').width), '5px', 'scrollbar is unchanged without the Bot layout flag')
  await page.locator('body').evaluate(el => { el.dataset.btLayout = 'bubble' })
  const thumbColors = new Set()
  for (const [theme, ink, background] of [['light', '#141414', '#fcfcfc'], ['dark', '#f2f2f2', '#141414']]) {
    await page.locator('body').evaluate((el, colors) => {
      el.style.setProperty('--bt-ink', colors.ink)
      el.style.background = colors.background
      el.style.color = colors.ink
    }, { ink, background })
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 })
      await page.mouse.move(width - 5, 800)
      const measured = await scroll.evaluate(el => {
        const bar = getComputedStyle(el, '::-webkit-scrollbar')
        const thumb = getComputedStyle(el, '::-webkit-scrollbar-thumb')
        return { width: bar.width, display: bar.display, thumb: thumb.backgroundColor, overflow: getComputedStyle(el).overflowY, max: el.scrollHeight - el.clientHeight }
      })
      assert.equal(measured.width, '8px')
      assert.notEqual(measured.display, 'none')
      assert.notEqual(measured.thumb, 'rgba(0, 0, 0, 0)')
      thumbColors.add(measured.thumb)
      assert.equal(measured.overflow, 'auto')
      assert.ok(measured.max > 0)
      await scroll.evaluate(el => { el.scrollTop = 0 })
      const box = await scroll.boundingBox()
      await page.mouse.move(box.x + 30, box.y + 30)
      await page.mouse.wheel(0, 180)
      await page.waitForTimeout(100)
      assert.ok(await scroll.evaluate(el => el.scrollTop) > 0, `${theme} ${width}px conversation scrolls`)
      await scroll.evaluate(el => { el.scrollTop = 0 })
      await page.mouse.move(box.x + box.width - 4, box.y + 10)
      await page.mouse.down()
      await page.mouse.move(box.x + box.width - 4, box.y + 110, { steps: 5 })
      await page.mouse.up()
      assert.ok(await scroll.evaluate(el => el.scrollTop) > 0, `${theme} ${width}px scrollbar drags`)
      if (process.env.SCREENSHOT_DIR && width === 1440) {
        await mkdir(process.env.SCREENSHOT_DIR, { recursive: true })
        await page.screenshot({ path: resolve(process.env.SCREENSHOT_DIR, `conversation-scrollbar-${theme}.png`) })
      }
      console.log(`${theme} ${width}px: scrollbar visible, wheel and drag work`)
    }
  }
  assert.equal(thumbColors.size, 2, 'the scrollbar thumb follows the light and dark ink colors')
} finally {
  await browser.close()
}
