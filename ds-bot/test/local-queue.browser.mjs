/** Isolated browser test for the actual ds-bot QueueDock bundle. No dsh server is contacted. */
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import assert from 'node:assert/strict'

const plugin = resolve(import.meta.dirname, '..')
const harness = process.env.DSH_HARNESS
if (!harness) throw new Error('Set DSH_HARNESS to a DeepSeek Harness checkout')
const req = createRequire(join(harness, 'apps/web/package.json'))
const { chromium } = req('playwright')
const react = join(dirname(req.resolve('react')), 'umd/react.development.js')
const reactDom = join(dirname(req.resolve('react-dom')), 'umd/react-dom.development.js')
const bundlePath = process.argv[2] ?? join(plugin, 'client.js')
const bundle = await readFile(bundlePath, 'utf8')
const start = bundle.indexOf('var OWN_QUEUE_KINDS', bundle.indexOf('// src/client/queue-dock.js'))
const end = bundle.indexOf('// src/client/approval-notices.js', start)
assert.ok(start >= 0 && end > start, 'production QueueDock section not found')
const production = bundle.slice(start, end)
const reactBinding = production.match(/\bimport_react\d+\b/)?.[0]
assert.ok(reactBinding, 'production React binding not found')
const icons = [...new Set(production.match(/\b[A-Za-z][A-Za-z0-9]*Icon\b/g) ?? [])]
const work = await mkdtemp(join(tmpdir(), 'ds-bot-queue-test-'))
// Playwright and Chrome both create transient files; keep them under our owned directory.
const priorTmpDir = process.env.TMPDIR
process.env.TMPDIR = work
const keepScreenshots = process.env.DS_BOT_KEEP_SCREENSHOTS === '1'
let browser
const failures = []
try {
  browser = await chromium.launch({ ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}), headless: true, env: { ...process.env, TMPDIR: work }, args: ['--no-sandbox', '--disable-background-networking'] })
  const context = await browser.newContext({ viewport: { width: 1000, height: 720 }, locale: 'zh-CN' })
  await context.route('**/*', route => route.abort())
  const page = await context.newPage()
  page.on('pageerror', error => failures.push(error.message))
  await page.setContent('<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;font-family:Arial,sans-serif;--bt-main:#fff;--bt-ink:#222;--bt-ink-2:#444;--bt-ink-3:#777;--bt-line:#ddd;--bt-line-2:#ccc;--bt-hover:#f4f4f4;--bt-accent:#335cdd"><div id="root"></div></body></html>')
  await page.addScriptTag({ path: react })
  await page.addScriptTag({ path: reactDom })
  await page.addScriptTag({ content: `
    var ${reactBinding}=window.React;
    var t=(s,params={})=>({'Bot private {n}':'Bot 私聊 {n} 条','Group {n}':'群聊 {n} 条','Bot private messages waiting; count unavailable':'Bot 私聊有待处理消息（数量待确认）','Group messages waiting; count unavailable':'群聊有待处理消息（数量待确认）','Next step':'当前回合下一步','Next turn':'下一回合'}[s]??s).replace(/\\{(\\w+)\\}/g,(_,k)=>String(params[k]??''));
    for(const name of ${JSON.stringify(icons)}) globalThis[name]=()=>React.createElement('span',{'aria-hidden':true},'·');
    ${production}
    const style=document.createElement('style');style.textContent=QUEUE_CSS;document.head.append(style);
    globalThis.fixtureInbox={'next-turn':[],'next-step':[]};
    globalThis.fixtureGroup=[];
    globalThis.fixtureSession='';
    globalThis.fixtureErrors=[];
    const props={
      useSession:select=>select({pendingSubmissions:[],running:true,subagent:null}),
      useProjection:()=>globalThis.fixtureInbox,
      useRoster:select=>select({byId:{[globalThis.fixtureSession]:{id:'bot'}}}),
      useWork:select=>select({groupQueues:{bot:globalThis.fixtureGroup}}),
      updateQueue:()=>{throw Error('fixture must not mutate queue')},
      loadImage:async()=>'',renderFactorySlot:undefined,
      actions:{reportError:error=>globalThis.fixtureErrors.push(String(error))}
    };
    const root=ReactDOM.createRoot(document.getElementById('root'));
    globalThis.renderFixture=(inbox,sessionId,group=[])=>{globalThis.fixtureInbox=inbox;globalThis.fixtureSession=sessionId;globalThis.fixtureGroup=group;ReactDOM.flushSync(()=>root.render(React.createElement(QueueDock,{...props,sessionId})))};
  ` })
  const bot = (id, text, role = 'reply') => ({ id, source: { kind: 'bot', form: 'relay', role, senderName: '测试 Bot', exchangeId: `exchange-${id}` }, content: [{ type: 'text', text }] })
  const user = { id: 'user-1', source: { kind: 'user', rpcId: 'fixture-request' }, content: [{ type: 'text', text: '用户消息测试' }] }
  const fixture = async (inbox, sessionId = 'fixture-session-a') => page.evaluate(({ inbox: value, sessionId: id }) => globalThis.renderFixture(value, id), { inbox, sessionId })
  const head = page.locator('[data-bot-queue-head]')
  const list = page.locator('[data-bot-queue-list]')
  const rows = page.locator('[data-bot-queue-row]')

  // A single Bot entry must still present a collapsed, manually expandable section.
  await fixture({ 'next-turn': [bot('one', '第一条 Bot 消息')], 'next-step': [] })
  await head.waitFor({ state: 'visible' })
  assert.equal(await head.getAttribute('aria-expanded'), 'false', 'single Bot entry must default collapsed')
  assert.equal(await list.isVisible(), false)
  await head.click()
  assert.equal(await head.getAttribute('aria-expanded'), 'true')
  assert.equal(await rows.count(), 1)
  assert.match(await list.innerText(), /第一条 Bot 消息/)
  await head.click()
  assert.equal(await head.getAttribute('aria-expanded'), 'false')
  assert.equal(await list.isVisible(), false)

  await page.evaluate(() => globalThis.renderFixture({ 'next-turn': [], 'next-step': [] }, 'fixture-session-a', [{ id: 'g1', roomId: 'r1', roomName: '研发群', senderName: '架构师', text: '需要决策' }]))
  assert.match(await head.innerText(), /群聊 1 条/)
  assert.equal((await head.innerText()).includes('私聊 0'), false)
  await head.click()
  assert.match(await list.innerText(), /研发群/)
  assert.match(await list.innerText(), /需要决策/)
  await head.click()
  await page.evaluate(() => globalThis.renderFixture({ 'next-turn': [], 'next-step': [] }, 'fixture-session-a', [{ id: 'unknown', roomId: 'r1', roomName: '研发群', unavailable: true }]))
  assert.equal(await head.count(), 0, 'unknown-only queue must not create a count')
  await page.evaluate(() => globalThis.renderFixture({ 'next-turn': [{ id: 'known', source: { kind: 'bot', role: 'reply' }, content: [{ type: 'text', text: 'private' }] }], 'next-step': [] }, 'fixture-session-a', [{ id: 'unknown', roomId: 'r1', roomName: '研发群', unavailable: true }]))
  assert.match(await head.innerText(), /私聊 1 条/)
  assert.equal((await head.innerText()).includes('+?'), false)
  await head.click()
  assert.match(await list.innerText(), /Group inbox unavailable/)
  await head.click()

  // User and Bot queues must be independent. Show both Bot placements without tool context.
  const longText = '长消息内容。'.repeat(80)
  const file = { id: 'file', source: { kind: 'bot', role: 'request', senderName: '测试 Bot' }, content: [{ type: 'text', text: longText }, { type: 'file', attachment: { attachmentId: 'file-1', name: 'fixture.txt', bytes: 2048 } }] }
  await fixture({ 'next-turn': [user, file], 'next-step': [bot('step', '插入当前回合'), { id: 'tool', source: { kind: 'tool-jobs' }, content: [{ type: 'text', text: '工具内部上下文' }] }] })
  assert.match(await page.locator('[data-queue-dock]').innerText(), /用户消息测试/)
  assert.equal(await head.getAttribute('aria-expanded'), 'false', 'user queue must not open Bot queue')
  await head.click()
  assert.equal(await rows.count(), 2)
  assert.equal(await rows.locator('[data-bot-queue-placement="next-step"]').count() + await page.locator('[data-bot-queue-row][data-bot-queue-placement="next-step"]').count(), 1)
  assert.equal(await rows.locator('[data-bot-queue-placement="next-turn"]').count() + await page.locator('[data-bot-queue-row][data-bot-queue-placement="next-turn"]').count(), 1)
  assert.doesNotMatch(await list.innerText(), /工具内部上下文/)
  assert.match(await list.innerText(), /长消息内容/)
  assert.match(await list.innerText(), /fixture\.txt/)
  assert.ok((await list.textContent()).includes(longText), 'long message must be available in full')
  assert.equal(await rows.locator('button').count(), 0, 'Bot rows must be read-only')

  // A long Bot message scrolls internally and does not prevent reaching later entries.
  await fixture({ 'next-step': [file], 'next-turn': [bot('after', '后续 Bot 消息')] })
  const longNode = rows.filter({ hasText: '长消息内容' }).locator('.bt-bot-queue-text')
  const metrics = await longNode.evaluate(el => ({ client: el.clientHeight, scroll: el.scrollHeight, overflow: getComputedStyle(el).overflowY }))
  assert.ok(metrics.scroll > metrics.client && metrics.client <= 160 && ['auto', 'scroll'].includes(metrics.overflow), 'long text must have a bounded, scrollable viewport')
  await longNode.evaluate(el => { el.scrollTop = el.scrollHeight })
  assert.ok(await longNode.evaluate(el => el.scrollTop) > 0, 'long message must allow vertical scrolling')
  const following = rows.filter({ hasText: '后续 Bot 消息' })
  await following.scrollIntoViewIfNeeded()
  assert.equal(await following.isVisible(), true, 'later messages must remain reachable')
  await page.screenshot({ path: join(work, 'queue-later-item.png'), fullPage: true })

  // Switching session binds expansion to that session and never retains other message content.
  await fixture({ 'next-turn': [bot('other', '另一会话内容')], 'next-step': [] }, 'fixture-session-b')
  assert.equal(await head.getAttribute('aria-expanded'), 'false', 'new session must default collapsed')
  assert.equal(await list.isVisible(), false)
  await fixture({ 'next-turn': [user, file], 'next-step': [bot('step', '插入当前回合')] })
  assert.equal(await head.getAttribute('aria-expanded'), 'false', 'A → B → A must reset the original session expansion')
  await fixture({ 'next-turn': [bot('other', '另一会话内容')], 'next-step': [] }, 'fixture-session-b')
  assert.equal(await head.getAttribute('aria-expanded'), 'false')
  await head.click()
  assert.equal(await rows.count(), 1)
  assert.match(await list.innerText(), /另一会话内容/)
  assert.doesNotMatch(await list.innerText(), /长消息内容|插入当前回合/)
  await fixture({ 'next-turn': [user, file], 'next-step': [bot('step', '插入当前回合')] })
  assert.equal(await head.getAttribute('aria-expanded'), 'false', 'another session expansion must not carry over')
  await head.click()

  // Existing user controls stay separate; real-time changes must update the count and rows.
  assert.ok(await page.locator('[data-queue-dock] button[aria-label="Edit queued message"]').count() > 0)
  await fixture({ 'next-turn': [user, bot('new', '实时新增')], 'next-step': [] })
  assert.equal(await rows.count(), 1)
  assert.match(await list.innerText(), /实时新增/)
  await fixture({ 'next-turn': [user], 'next-step': [] })
  assert.equal(await head.count(), 0, 'empty Bot queue should not leave a stale count')
  assert.match(await page.locator('[data-queue-dock]').innerText(), /用户消息测试/)

  // Bot text is untrusted and must remain literal, never create executable markup.
  await fixture({ 'next-turn': [bot('escaped', '<img src=x onerror=alert(1)>')], 'next-step': [] })
  await head.click()
  assert.match(await list.textContent(), /<img src=x onerror=alert\(1\)>/)
  assert.equal(await list.locator('img').count(), 0)

  // Legal 40-character Bot names remain fully readable on a narrow screen and at 200% zoom.
  await page.setViewportSize({ width: 360, height: 740 })
  const longSender = '项目经理'.repeat(10)
  for (const zoom of [1, 2]) {
    await page.evaluate(value => { document.body.style.zoom = String(value) }, zoom)
    const longNameMessage = bot('long-sender', '测试正文')
    longNameMessage.source.senderName = longSender
    await fixture({ 'next-turn': [longNameMessage], 'next-step': [] }, `sender-zoom-${zoom}`)
    if (await head.getAttribute('aria-expanded') === 'false') await head.click()
    const visibleName = await page.locator('.bt-bot-queue-sender').evaluate(el => ({
      text: el.textContent,
      clippedWidth: el.scrollWidth > el.clientWidth + 1,
      clippedHeight: el.scrollHeight > el.clientHeight + 1,
      pageOverflow: document.documentElement.scrollWidth > innerWidth,
    }))
    assert.equal(visibleName.text, longSender, `sender name content at ${zoom * 100}% zoom`)
    assert.equal(visibleName.clippedWidth, false, `sender name must not be clipped horizontally at ${zoom * 100}% zoom`)
    assert.equal(visibleName.clippedHeight, false, `sender name must not be clipped vertically at ${zoom * 100}% zoom`)
    assert.equal(visibleName.pageOverflow, false, `long sender must not cause horizontal overflow at ${zoom * 100}% zoom`)
  }
  await page.evaluate(() => { document.body.style.zoom = '' })

  // Narrow layout and rendered text are visually inspectable without real user data.
  await page.setViewportSize({ width: 360, height: 740 })
  await fixture({ 'next-turn': [user, file], 'next-step': [bot('step', '插入当前回合')] })
  if (await head.getAttribute('aria-expanded') === 'false') await head.click()
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)
  assert.equal(overflow, false, 'narrow layout must not overflow horizontally')
  const screenshot = join(work, 'queue-narrow.png')
  await page.screenshot({ path: screenshot, fullPage: true })
  // Use the bundle's real default dark tokens, including alpha in secondary text.
  await page.evaluate(() => {
    const body = document.body
    body.style.background = '#141414'
    for (const [key, value] of Object.entries({
      '--bt-main': '#141414', '--bt-ink': '#f2f2f2', '--bt-ink-2': 'rgba(242,242,242,.6)',
      '--bt-ink-3': 'rgba(242,242,242,.36)', '--bt-line': 'rgba(255,255,255,.08)',
      '--bt-line-2': 'rgba(255,255,255,.15)', '--bt-hover': 'rgba(160,160,160,.12)',
    })) body.style.setProperty(key, value)
  })
  await fixture({ 'next-turn': [user, bot('dark', '深色主题 Bot 文本')], 'next-step': [] })
  if (await head.getAttribute('aria-expanded') === 'false') await head.click()
  const darkContrast = await page.evaluate(() => {
    const panel = document.querySelector('[data-bot-queue-dock]')
    const background = getComputedStyle(panel, '::before').backgroundColor
    function rgba(s) { const p = s.match(/[\d.]+/g)?.map(Number) ?? []; return [p[0], p[1], p[2], p[3] ?? 1] }
    const bg = rgba(background)
    function luminance(rgb) {
      const v = rgb.map(x => { x /= 255; return x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4 })
      return .2126 * v[0] + .7152 * v[1] + .0722 * v[2]
    }
    function contrast(selector) {
      const el = document.querySelector(selector)
      if (!el) throw Error(`missing dark theme selector ${selector}`)
      const fg = rgba(getComputedStyle(el).color)
      const mixed = [0, 1, 2].map(i => fg[i] * fg[3] + bg[i] * (1 - fg[3]))
      const a = luminance(mixed), b = luminance(bg.slice(0, 3))
      return (Math.max(a, b) + .05) / (Math.min(a, b) + .05)
    }
    return { background, sender: contrast('.bt-bot-queue-sender'), placement: contrast('.bt-bot-queue-placement'), botText: contrast('.bt-bot-queue-text'), userText: contrast('.bt-queue-preview') }
  })
  for (const key of ['sender', 'placement', 'botText', 'userText']) assert.ok(darkContrast[key] >= 4.5, `dark theme ${key} contrast ${darkContrast[key].toFixed(2)} is below 4.5`)
  console.log(`Dark contrast: ${['sender', 'placement', 'botText', 'userText'].map(key => `${key}=${darkContrast[key].toFixed(2)}:1`).join(', ')}`)
  await page.screenshot({ path: join(work, 'queue-dark.png'), fullPage: true })
  assert.deepEqual(failures, [], 'browser must not throw')
  assert.deepEqual(await page.evaluate(() => globalThis.fixtureErrors), [])
  console.log('PASS: real production QueueDock; default collapse, toggle, mixed queues, placements, attachments, bounded long text, session switch, updates, safe text, read-only actions, narrow and dark layouts.')
  await context.close()
} finally {
  try {
    await browser?.close()
  } finally {
    if (priorTmpDir === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = priorTmpDir
    if (keepScreenshots) console.log(`Screenshots retained: ${work}`)
    else await rm(work, { recursive: true, force: true })
  }
}
