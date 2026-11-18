#!/usr/bin/env node
// Real end-to-end check of the DS-Bot task board on the mock bench.
//
// It starts its own bench (dev/mock-llm.mjs + a dsh web whose profile links this
// checkout), seeds two public Bots and a room through POST /api/bot, then drives
// the live Web UI with Playwright/Chrome. Every scenario is reported PASS/FAIL;
// a failure is not allowed to abort unrelated scenarios. Artifacts and a
// machine-readable results.json land in test/e2e/artifacts/<run-id>/.
//
//   node test/e2e/board.e2e.mjs                 # start bench, full run, stop bench
//   node test/e2e/board.e2e.mjs --fresh         # wipe the dedicated DSH_HOME first
//   node test/e2e/board.e2e.mjs --keep          # leave the bench up for debugging
//   node test/e2e/board.e2e.mjs --headed        # show Chrome
//   node test/e2e/board.e2e.mjs --base-url=... --login-url=...   # attach
//
// Environment: BOARD_E2E_HOME (default <repo>/.dsh-test-board-e2e; the ambient
// DSH_HOME is deliberately ignored so a run never touches the user's own data),
// BOARD_E2E_WEB_PORT (3097), BOARD_E2E_MOCK_PORT (8797),
// BOARD_E2E_CHROME (installed Chrome path), BOARD_E2E_NODE (node executable for the bench children).
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULTS, PLUGIN, boardApi, loginToken, startBench, stopBench } from './bench.mjs'

const require = createRequire(join(PLUGIN, 'package.json'))
const { chromium } = require('playwright-core')
const { PNG } = require('pngjs')

const HERE = dirname(fileURLToPath(import.meta.url))
const ARTIFACTS_ROOT = join(HERE, 'artifacts')

function parseArgs(argv) {
  const options = {
    fresh: false,
    keep: false,
    headed: false,
    // Never inherit the ambient DSH_HOME: that is the user's own harness data.
    home: process.env.BOARD_E2E_HOME || DEFAULTS.home,
    webPort: Number(process.env.BOARD_E2E_WEB_PORT || DEFAULTS.webPort),
    mockPort: Number(process.env.BOARD_E2E_MOCK_PORT || DEFAULTS.mockPort),
    chrome: process.env.BOARD_E2E_CHROME || DEFAULTS.chrome,
    baseUrl: process.env.BOARD_E2E_BASE_URL || '',
    loginUrl: process.env.BOARD_E2E_LOGIN_URL || '',
    runId: process.env.BOARD_E2E_RUN_ID || '',
  }
  for (const arg of argv) {
    if (arg === '--fresh') options.fresh = true
    else if (arg === '--keep') options.keep = true
    else if (arg === '--headed') options.headed = true
    else if (arg.startsWith('--home=')) options.home = resolve(arg.slice(7))
    else if (arg.startsWith('--web-port=')) options.webPort = Number(arg.slice(11))
    else if (arg.startsWith('--mock-port=')) options.mockPort = Number(arg.slice(12))
    else if (arg.startsWith('--chrome=')) options.chrome = arg.slice(9)
    else if (arg.startsWith('--base-url=')) options.baseUrl = arg.slice(11).replace(/\/$/, '')
    else if (arg.startsWith('--login-url=')) options.loginUrl = arg.slice(12)
    else if (arg.startsWith('--run-id=')) options.runId = arg.slice(9)
    else if (arg === '--help' || arg === '-h') { console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(0, 24).join('\n')); process.exit(0) }
    else throw new Error('unknown argument ' + arg)
  }
  if (!options.runId) options.runId = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)
  return options
}

const opts = parseArgs(process.argv.slice(2))
const ARTIFACTS = join(ARTIFACTS_ROOT, opts.runId)
mkdirSync(ARTIFACTS, { recursive: true })
const results = []
const startedAt = Date.now()
let bench
let browser
let page
let cookie
let seed
const consoleErrors = []
const pageErrors = []
let shotIndex = 0

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const stamp = () => new Date().toISOString()
function log(line) { console.log(line) }
function evidenceOf(error) { return error && typeof error === 'object' ? (error.evidence ?? {}) : {} }
class StepError extends Error {
  constructor(message, evidence = {}) { super(message); this.name = 'StepError'; this.evidence = evidence }
}

async function shot(name) {
  const file = join(ARTIFACTS, String(++shotIndex).padStart(2, '0') + '-' + name + '.png')
  try { await page.screenshot({ path: file, fullPage: false }) } catch {}
  return file
}

async function waitFor(label, fn, timeoutMs = 20_000, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    try { const value = await fn(); if (value) return value; last = value } catch (error) { last = error.message }
    await sleep(intervalMs)
  }
  throw new StepError('timed out waiting for ' + label + (last === undefined ? '' : ' (last: ' + String(last).slice(0, 300) + ')'), { label })
}

async function step(name, fn) {
  const started = Date.now()
  try {
    const evidence = (await fn()) ?? {}
    results.push({ name, status: 'PASS', evidence, ms: Date.now() - started })
    log('PASS  ' + name)
    return { ok: true, evidence }
  } catch (error) {
    const evidence = { message: error.message, ...evidenceOf(error) }
    results.push({ name, status: 'FAIL', evidence, ms: Date.now() - started })
    log('FAIL  ' + name + ': ' + error.message)
    return { ok: false, error, evidence }
  }
}

function api(endpoint, payload = {}) { return boardApi(seed.base, cookie, endpoint, payload) }
const scope = () => ({ kind: 'room', id: seed.room.id })
async function boardList() { return api('board-list', { scope: scope() }) }
async function taskByTitle(title) {
  const list = await boardList()
  return list.tasks.find(task => task.title === title)
}

const zh = {
  board: /^(任务看板|Task board)$/,
  addCard: /^(Add card|添加卡片|添加任务|创建任务)$/,
  createCard: /^(Create card|创建卡片|提交提案|Submit proposal)$/,
  createDialog: /^(Create card|创建卡片|创建任务)$/,
  title: /^(标题|Title)$/,
  owner: /^(负责人|Owner ID)/,
  reviewer: /^(Independent reviewer|独立验收人)/,
  acceptance: /^(验收条件|Acceptance criteria)$/,
  save: /^(保存|Save)$/,
  add: /^(添加|Add)$/,
  edit: /^(编辑|Edit)$/,
  description: /^(说明|Description)$/,
  descriptionOpen: /^(Add a more detailed description|添加更详细的说明|添加)$/,
  checklistNew: /^(新清单项|New checklist item)$/,
  addItem: /^(添加项目|Add item)$/,
  labelNew: /^(添加标签|Add a label)$/,
  dueDate: /^(截止日期|Due date)$/,
  dueTime: /^(Due time|截止时间)$/,
  dueCompleteMark: /^(Mark due date complete|标记截止日期已完成)$/,
  comment: /^(添加评论|Add a comment)$/,
  postComment: /^(发表评论|Post comment)$/,
  deleteComment: /^(删除|Delete)$/,
  confirmDelete: /^(确认删除|Confirm delete)$/,
  chooseImages: /^(选择图片|Choose images)$/,
  uploadImages: /^(上传文件|Upload files)$/,
  chooseFiles: /^(选择文件|Choose files)$/,
  setCover: /^(Set as cover|Set cover|设为封面)$/,
  draft: /^(Save as draft|保存起草|保存为起草)$/,
  cancelCard: /^(Cancel card|取消卡片)$/,
  restoreCard: /^(Restore card|恢复卡片)$/,
  closeCard: /^(关闭卡片|Close card)$/,
  refresh: /^(Refresh|刷新)$/,
}

function lane(stage) {
  return page.locator('.bt-board-lane[data-stage="' + stage + '"], .bt-board-column[data-stage="' + stage + '"]').first()
}

async function ensureBoard() {
  // Wait for the DS-Bot client to replace the stock sidebar before asking for
  // the board launch control; a freshly loaded page renders it asynchronously.
  await waitFor('DS Bot sidebar and room row', async () => {
    const side = page.locator('.bt-side')
    if (!await side.isVisible().catch(() => false)) return false
    return page.locator('button.bt-row').filter({ hasText: seed.room.name }).count()
  }, 30_000)
  const close = page.locator('[data-close-card]').first()
  if (await close.isVisible().catch(() => false)) await close.click().catch(() => {})
  if (await page.locator('.bt-board-dialog').isVisible().catch(() => false)) {
    const openHeading = page.locator('.bt-board-dialog h2').first()
    const openTitle = await openHeading.count() ? await openHeading.innerText().catch(() => '') : ''
    if (openTitle.includes(seed.room.name)) return page.locator('.bt-board-dialog')
    await page.locator('.bt-board-head-actions button').last().click().catch(() => {})
    await page.locator('.bt-board-dialog').waitFor({ state:'detached', timeout:5000 }).catch(() => {})
  }
  // A modal card can outlive a navigation; close it before using the board.
  const row = page.locator('button.bt-row').filter({ hasText: seed.room.name }).first()
  const current = await row.count() ? await row.getAttribute('aria-current') : null
  if (await row.count() && !['true', 'page'].includes(current)) {
    await row.click()
    await page.waitForTimeout(600)
  }
  const launch = page.locator('.bt-board-launch').first()
  await launch.waitFor({ state: 'visible', timeout: 20_000 })
  await launch.click()
  await page.locator('.bt-board-dialog').waitFor({ state: 'visible', timeout: 20_000 })
  const heading = page.locator('.bt-board-dialog h2').first()
  const headingText = await heading.count() ? await heading.innerText().catch(() => '') : ''
  if (!headingText.includes(seed.room.name)) {
    await page.locator('.bt-board-head-actions button').last().click().catch(() => {})
    await row.click()
    await page.waitForTimeout(600)
    await page.locator('.bt-board-launch').first().click()
    await page.locator('.bt-board-dialog').waitFor({ state: 'visible', timeout: 20_000 })
  }
  return page.locator('.bt-board-dialog')
}

async function openCard(taskId) {
  await ensureBoard()
  const card = page.locator('.bt-board-card[data-task-id="' + taskId + '"]').first()
  await card.waitFor({ state: 'visible', timeout: 15_000 })
  await card.click()
  const dialog = page.locator('.bt-card-modal[role="dialog"]').first()
  await dialog.waitFor({ state: 'visible', timeout: 10_000 })
  return dialog
}

async function closeCard() {
  const close = page.locator('[data-close-card]').first()
  if (await close.isVisible().catch(() => false)) await close.click().catch(() => {})
  await page.waitForTimeout(250)
}

// Phase 2 asks the user to confirm every card content edit. The confirmation
// sits inside the card dialog so it remains reachable by the dialog focus trap.
async function approveChange(dialog, timeoutMs = 5_000) {
  const panel = dialog.locator('.bt-card-confirm').first()
  await panel.waitFor({ state: 'visible', timeout: timeoutMs }).catch(() => {})
  if (!await panel.isVisible().catch(() => false)) return false
  const confirm = panel.getByRole('button', { name: /^(确认|Confirm)$/ }).first()
  if (!await confirm.count()) throw new StepError('confirmation panel has no Confirm control')
  await confirm.click()
  await panel.waitFor({ state: 'detached', timeout: 10_000 })
  return true
}

async function withCard(taskId, fn) {
  const dialog = await openCard(taskId)
  try { return await fn(dialog) } finally { await closeCard() }
}

async function selectLabelValue(container, label, optionText) {
  const field = container.locator('label').filter({ hasText: label }).first()
  const select = (await field.locator('select').count()) ? field.locator('select').first() : container.getByLabel(label).first()
  await select.selectOption({ label: optionText })
}

async function createCard({ title, ownerName, reviewerName, acceptance, description = '' }) {
  await ensureBoard()
  const proposed = lane('proposed')
  const add = proposed.getByRole('button', { name: zh.addCard })
  if (await add.count()) await add.first().click()
  else await proposed.locator('button.bt-board-primary').first().click()
  await page.waitForTimeout(300)
  const quick = proposed.locator('.bt-board-quick-add')
  if (await quick.isVisible().catch(() => false)) {
    await quick.locator('textarea').fill(title)
    await quick.locator('button[type=submit]').click()
    await page.waitForTimeout(300)
  }
  const dialog = page.getByRole('dialog', { name: zh.createDialog }).first()
  const fill = async container => {
    await container.getByLabel(zh.title).fill(title)
    await selectLabelValue(container, zh.owner, ownerName)
    await selectLabelValue(container, zh.reviewer, reviewerName)
    await container.getByLabel(zh.acceptance).fill(acceptance)
    if (description) await container.getByLabel(zh.description).first().fill(description)
    await container.getByRole('button', { name: zh.createCard }).first().click()
  }
  if (await dialog.count()) await fill(dialog)
  else await fill(proposed.locator('form.bt-board-create').first())
  return waitFor('card ' + title + ' in the board API', async () => taskByTitle(title), 25_000)
}

async function readSchedulerErrors() {
  try {
    return readFileSync(join(opts.home, 'web.log'), 'utf8').split('\n').filter(line => /board scheduler/i.test(line)).slice(-10)
  } catch { return [] }
}

async function main() {
  // -------------------------------------------------------------------------
  // Bench + API seed. This is setup, not a UI scenario.
  // -------------------------------------------------------------------------
  const setup = await step('bench: boot mock model and dsh web with the linked plugin', async () => {
    if (opts.fresh) {
      await stopBench({ home: opts.home, webPort: opts.webPort, mockPort: opts.mockPort })
      rmSync(opts.home, { recursive: true, force: true })
    }
    if (opts.baseUrl) {
      seed = { base: opts.baseUrl, loginUrl: opts.loginUrl, home: opts.home }
      if (!opts.loginUrl) throw new StepError('--base-url needs --login-url (or run without --base-url to start a bench)', {})
    } else {
      bench = await startBench({ home: opts.home, webPort: opts.webPort, mockPort: opts.mockPort })
      seed = { base: bench.base, loginUrl: bench.loginUrl, home: bench.home }
    }
    const login = await loginToken(seed.loginUrl)
    cookie = login.cookie
    return { base: seed.base, home: seed.home, loginStatus: login.status }
  })
  if (!setup.ok) throw new Error('bench setup failed')

  const seeding = await step('seed: two public Bots and a room via POST /api/bot', async () => {
    let state = await api('state')
    const ensureBot = async (name, role, instructions) => {
      let bot = Object.values(state.bots).find(item => item.name === name)
      if (!bot) {
        await api('create-bot', { name, role, instructions })
        state = await api('state')
        bot = Object.values(state.bots).find(item => item.name === name)
      }
      if (!bot) throw new StepError('Bot ' + name + ' was not created')
      if (bot.private === true) throw new StepError('Bot ' + name + ' is private; the board requires public Bots')
      return bot
    }
    const alice = await ensureBot('E2E Alice', 'Engineer', 'Own the engineering work on this board.')
    const bob = await ensureBot('E2E Bob', 'Tester', 'Independently review the engineering work.')
    state = await api('state')
    const chief = Object.values(state.bots).find(item => item.name === 'Chief')
    let room = Object.values(state.rooms).find(item => item.name === 'Board E2E')
    if (!room && chief) {
      room = await api('create-room', { name: 'Board E2E', members: [alice.id, bob.id, chief.id], admin: chief.id })
      state = await api('state')
      room = Object.values(state.rooms).find(item => item.id === room.id) ?? room
    }
    if (!room) throw new StepError('no Board E2E room could be created')
    const members = room.members ?? []
    if (!members.includes(alice.id) || !members.includes(bob.id)) throw new StepError('room is missing one of the seeded Bots', { members })
    seed = { ...seed, alice, bob, chief, room: { id: room.id, name: room.name } }
    // Let the Bots finish their kickoff turns so the dispatch lane is not queued behind them.
    for (let i = 0; i < 120; i++) {
      const now = await api('state')
      if (!now.activity || Object.keys(now.activity).length === 0) break
      await sleep(500)
    }
    const list = await boardList()
    if (list.capabilities?.create !== true) throw new StepError('board is not writable', { capabilities: list.capabilities })
    if (!list.capabilities?.upload) throw new StepError('board image upload is unavailable', { capabilities: list.capabilities })
    return { alice: alice.id, bob: bob.id, room: room.id, roomName: room.name, actors: list.capabilities.actors.map(actor => actor.name) }
  })
  if (!seeding.ok) throw new Error('seed failed')

  // -------------------------------------------------------------------------
  // Browser
  // -------------------------------------------------------------------------
  browser = await chromium.launch({
    executablePath: opts.chrome,
    headless: !opts.headed,
    args: ['--disable-dev-shm-usage', '--no-first-run'],
  })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' })
  page = await context.newPage()
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()) })
  page.on('pageerror', error => pageErrors.push(error.message))
  await page.goto(seed.loginUrl, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2500)

  let createdTask
  const boardCheck = await step('UI: open the group board from the header and render the workflow lanes', async () => {
    await ensureBoard()
    const lanes = await page.locator('.bt-board-lane, .bt-board-column').evaluateAll(els => els.map(el => el.getAttribute('data-stage')).filter(Boolean))
    const text = await page.locator('.bt-board-dialog').innerText()
    if (/Board directory is not private|看板不可用|Board unavailable/.test(text)) throw new StepError('board is unavailable', { text: text.slice(0, 500) })
    if (!['proposed', 'waiting', 'working', 'reported', 'done'].every(stage => lanes.includes(stage))) {
      throw new StepError('workflow lanes are missing', { lanes })
    }
    return { lanes, screenshot: await shot('board-open') }
  })

  if (boardCheck.ok) {
    await step('UI: switch between Status and Type views', async () => {
      await ensureBoard()
      const typeTab = page.getByRole('button', { name: /^(Type|类型)$/ }).first()
      await typeTab.click()
      await page.locator('.bt-board-section[aria-label="Task types"], .bt-board-section[aria-label="任务类型"]').first().waitFor({ state: 'visible', timeout: 10_000 })
      const typeLanes = await page.locator('.bt-board-lane[data-kind="type"]').evaluateAll(els => els.map(el => el.getAttribute('data-stage')))
      if (!['requirement','design','feature','development','test'].every(type => typeLanes.includes(type))) throw new StepError('type lanes are missing', { typeLanes })
      await page.getByRole('button', { name: /^(Status|状态)$/ }).first().click()
      await lane('proposed').waitFor({ state: 'visible', timeout: 10_000 })
      return { typeLanes }
    })

    await step('UI: a draft card can be created, submitted, cancelled and restored', async () => {
      const draftTitle = 'E2E draft ' + opts.runId
      const draftLane = lane('draft')
      await draftLane.getByRole('button', { name: zh.addCard }).last().click()
      const quick = draftLane.locator('.bt-board-quick-add')
      await quick.locator('textarea').fill(draftTitle)
      await quick.locator('button[type=submit]').click()
      const dialog = page.getByRole('dialog', { name: zh.createDialog }).first()
      await dialog.waitFor({ state: 'visible', timeout: 10_000 })
      await dialog.getByLabel(zh.title).fill(draftTitle)
      await selectLabelValue(dialog, zh.owner, seed.alice.name)
      await selectLabelValue(dialog, zh.reviewer, seed.bob.name)
      await dialog.getByLabel(zh.acceptance).fill('Draft acceptance ' + opts.runId)
      await dialog.getByLabel(zh.draft).check()
      await dialog.getByRole('button', { name: zh.draft }).first().click()
      const draft = await waitFor('draft card in board-list', async () => {
        const current = await taskByTitle(draftTitle)
        return current?.status === 'draft' ? current : undefined
      }, 25_000)
      const card = page.locator('.bt-board-card[data-task-id="' + draft.id + '"]').first()
      await card.waitFor({ state: 'visible', timeout: 10_000 })
      await card.dragTo(lane('proposed'), { timeout: 15_000 })
      await waitFor('draft card submitted to Preparing', async () => (await taskByTitle(draftTitle))?.status === 'proposed', 20_000)
      await openCard(draft.id)
      const cardDialog = page.locator('.bt-card-modal').first()
      await cardDialog.getByRole('button', { name: zh.cancelCard }).first().click()
      await waitFor('card cancelled', async () => (await taskByTitle(draftTitle))?.status === 'cancelled', 20_000)
      await cardDialog.getByRole('button', { name: zh.restoreCard }).first().click()
      await waitFor('card restored', async () => (await taskByTitle(draftTitle))?.status === 'proposed', 20_000)
      await closeCard()
      return { taskId: draft.id, status: 'proposed', screenshot: await shot('draft-submit-cancel-restore') }
    })

    const title = 'E2E card ' + opts.runId
    const acceptance = 'Acceptance ' + opts.runId + ': card persists after reload.'
    const createDescription = 'E2E description set at create ' + opts.runId + ': survives reload.'
    const create = await step('UI: create a card with title, Bot owner, independent reviewer, acceptance and optional description', async () => {
      createdTask = await createCard({ title, ownerName: seed.alice.name, reviewerName: seed.bob.name, acceptance, description: createDescription })
      if (!createdTask) throw new StepError('card did not appear in board-list')
      if (createdTask.status !== 'proposed') throw new StepError('new card is not in proposed', { status: createdTask.status })
      if (createdTask.owner !== seed.alice.id || createdTask.reviewer !== seed.bob.id) throw new StepError('owner/reviewer were not saved', { owner: createdTask.owner, reviewer: createdTask.reviewer })
      if (createdTask.acceptance !== acceptance) throw new StepError('acceptance was not saved', { acceptance: createdTask.acceptance })
      if (createdTask.description !== createDescription) throw new StepError('description was not saved at creation', { actual: createdTask.description, expected: createDescription })
      const card = page.locator('.bt-board-card[data-task-id="' + createdTask.id + '"]')
      await card.waitFor({ state: 'visible', timeout: 10_000 })
      return { taskId: createdTask.id, title, screenshot: await shot('card-created') }
    })

    if (create.ok) {
      await step('reorder: a second card in Preparing starts after the first and a drag reverses the order', async () => {
        const secondTitle = 'E2E card B ' + opts.runId
        const second = await createCard({ title: secondTitle, ownerName: seed.alice.name, reviewerName: seed.bob.name, acceptance: 'Acceptance B ' + opts.runId })
        if (!second) throw new StepError('second card did not appear in board-list')
        const orderOf = async () => {
          const list = await boardList()
          const a = list.tasks.findIndex(task => task.id === createdTask.id)
          const b = list.tasks.findIndex(task => task.id === second.id)
          return { a, b, list }
        }
        const before = await orderOf()
        if (before.a === -1 || before.b === -1 || before.a >= before.b) throw new StepError('creation order is not stable', { before: [before.a, before.b] })
        const first = page.locator('.bt-board-card[data-task-id="' + createdTask.id + '"]').first()
        const secondCard = page.locator('.bt-board-card[data-task-id="' + second.id + '"]').first()
        await first.dragTo(secondCard, { targetPosition: { x: 100, y: 80 }, timeout: 15_000 })
        const after = await waitFor('first card to come after the second in board-list', async () => {
          const order = await orderOf()
          return order.a !== -1 && order.b !== -1 && order.a > order.b ? order : undefined
        }, 25_000)
        if (!after) throw new StepError('reorder did not persist in board-list')
        const domOrder = await waitFor('card order in the lane to follow the drag', async () => {
          const order = await page.locator('.bt-board-lane[data-stage="proposed"] .bt-board-card').evaluateAll(els => els.map(el => el.getAttribute('data-task-id')))
          return order.indexOf(createdTask.id) !== -1 && order.indexOf(second.id) !== -1 && order.indexOf(createdTask.id) > order.indexOf(second.id) ? order : undefined
        }, 20_000)
        return { before: 'first before second', after: 'second before first', domOrder, screenshot: await shot('reordered') }
      })

      await step('release: create a release, assign a card and remove it again', async () => {
        const second = await taskByTitle('E2E card B ' + opts.runId)
        if (!second) throw new StepError('second card is missing for release assignment')
        const release = await api('board-release-create', { scope: scope(), operationId: randomUUID(),
          release: { id: randomUUID(), name: 'E2E release', version: '0.0.1' } })
        const assigned = await api('board-release-assign', { scope: scope(), operationId: randomUUID(),
          releaseId: release.id, expectedReleaseRevision: release.revision, taskId: second.id, expectedTaskRevision: second.revision })
        if (assigned.releaseId !== release.id) throw new StepError('card was not assigned to the release', { assigned })
        const listed = (await boardList()).releases?.find(item => item.id === release.id)
        if (!listed || listed.itemCount !== 1) throw new StepError('release item was not projected on the board', { listed })
        const taskAfter = await taskByTitle(second.title)
        if (taskAfter.releaseId !== release.id) throw new StepError('card release id did not persist')
        await api('board-release-remove', { scope: scope(), operationId: randomUUID(), releaseId: release.id,
          expectedReleaseRevision: listed.revision, taskId: second.id, expectedTaskRevision: taskAfter.revision })
        const restored = await taskByTitle(second.title)
        if (restored.releaseId !== null) throw new StepError('card was not removed from the release', { restored })
        return { releaseId: release.id, taskId: second.id }
      })

      await step('UI: switch to the Release view and back', async () => {
        await ensureBoard()
        await page.getByRole('button', { name: zh.refresh }).first().click()
        await page.waitForTimeout(800)
        const releaseTab = page.getByRole('button', { name: /^(Release|发布)$/ }).first()
        await releaseTab.click()
        const releaseSection = page.locator('.bt-board-section[aria-label="Releases"], .bt-board-section[aria-label="发布"]').first()
        await releaseSection.waitFor({ state: 'visible', timeout: 10_000 })
        const releaseLanes = await page.locator('.bt-board-lane[data-kind="release"]').count()
        if (releaseLanes < 2) throw new StepError('release lanes are missing', { releaseLanes })
        await page.getByRole('button', { name: /^(Status|状态)$/ }).first().click()
        await lane('proposed').waitFor({ state: 'visible', timeout: 10_000 })
        return { releaseLanes, screenshot: await shot('release-view') }
      })

      await step('UI: drag the card from Preparing into a dispatch lane', async () => {
        const card = page.locator('.bt-board-card[data-task-id="' + createdTask.id + '"]').first()
        const target = lane('waiting')
        await card.dragTo(target, { timeout: 15_000 })
        const moved = await waitFor('card to leave proposed / change task status', async () => {
          const current = await api('board-list', { scope: scope() }).then(list => list.tasks.find(item => item.id === createdTask.id))
          return current && current.status !== 'proposed' ? current : undefined
        }, 25_000)
        const stage = await waitFor('card to render in a dispatch lane', async () => {
          const current = await page.locator('.bt-board-card[data-task-id="' + createdTask.id + '"]').evaluate(el => el.closest('[data-stage]')?.getAttribute('data-stage')).catch(() => undefined)
          return ['waiting', 'working'].includes(current) ? current : undefined
        }, 20_000)
        if (!['waiting', 'working'].includes(stage)) throw new StepError('card is not in a dispatch lane after the drop', { stage, status: moved.status })
        if (!['pending', 'claimed', 'accepted', 'uncertain'].includes(moved.dispatchState)) throw new StepError('no dispatch action was recorded', { dispatchState: moved.dispatchState, status: moved.status })
        return { status: moved.status, dispatchState: moved.dispatchState, stage, screenshot: await shot('card-dispatched') }
      })

      await step('dispatch: the Bot delivery completes (accepted, not uncertain)', async () => {
        const final = await waitFor('dispatch action to settle', async () => {
          const current = await api('board-list', { scope: scope() }).then(list => list.tasks.find(item => item.id === createdTask.id))
          return current && ['accepted', 'uncertain'].includes(current.dispatchState) ? current : undefined
        }, 90_000)
        if (final.dispatchState === 'uncertain') {
          throw new StepError('dispatch ended uncertain; the Bot message was not confirmed', { dispatchState: final.dispatchState, schedulerErrors: await readSchedulerErrors(), screenshot: await shot('dispatch-uncertain') })
        }
        return { dispatchState: final.dispatchState, screenshot: await shot('dispatch-accepted') }
      })

      await step('card details: edit description', async () => {
        const description = 'E2E description ' + opts.runId + ': survives reload.'
        await withCard(createdTask.id, async dialog => {
          const section = dialog.locator('.bt-card-description').first()
          const add = section.getByRole('button', { name: zh.descriptionOpen }).first()
          if (await add.count()) await add.click()
          else await section.locator('button.bt-card-ghost, button.bt-card-mini').first().click()
          const textarea = section.getByLabel(zh.description).first()
          await textarea.fill(description)
          const save = section.locator('.bt-card-editor-actions button.bt-btn-primary, button.bt-board-primary').first()
          const selector = '.bt-card-description .bt-card-editor-actions .bt-btn-primary'
          if (!await save.count()) {
            await shot('description-save-missing')
            throw new StepError('description editor has no Save control', { selector, screenshot: join(ARTIFACTS, String(shotIndex).padStart(2, '0') + '-description-save-missing.png') })
          }
          if (await save.isDisabled()) {
            const screenshot = await shot('description-save-disabled')
            throw new StepError('description Save stays disabled after typing; draft cannot be saved', {
              selector, disabled: true, editorValue: await textarea.inputValue(), screenshot,
              sourceHint: 'src/client/task-board.js DescriptionEditor: Save is gated by !changed (external change) instead of draft !== description',
            })
          }
          await save.click()
          await approveChange(dialog)
          const saved = await waitFor('description in board-list', async () => {
            const current = await taskByTitle(title)
            return current?.description === description ? current : undefined
          }, 20_000)
          return { description: saved.description, screenshot: await shot('description-saved') }
        })
        return { description }
      })

      await step('card details: labels, due date and checklist', async () => {
        const label = 'e2e-' + opts.runId.slice(-4)
        const due = '2026-12-15'
        const checklistText = 'Checklist ' + opts.runId
        await withCard(createdTask.id, async dialog => {
          const labels = dialog.locator('.bt-card-labels').first()
          await labels.getByRole('button', { name: zh.edit }).first().click()
          await labels.getByLabel(zh.labelNew).first().fill(label)
          await labels.getByRole('button', { name: zh.add }).first().click()
          await labels.getByRole('button', { name: zh.save }).first().click()
          await approveChange(dialog)
          const dueEditor = dialog.locator('.bt-card-due-editor').first()
          if (await dueEditor.count()) {
            await dueEditor.getByLabel(zh.dueDate).first().fill(due)
            const time = dueEditor.getByLabel(zh.dueTime).first()
            if (await time.count()) await time.fill('09:30').catch(() => {})
            await dueEditor.getByRole('button', { name: zh.save }).first().click()
            await approveChange(dialog)
            await waitFor('due date in board-list', async () => String((await taskByTitle(title))?.dueDate ?? '').startsWith(due), 20_000)
            const mark = dueEditor.getByText(zh.dueCompleteMark).first()
            if (await mark.count()) { await mark.click(); await dueEditor.getByRole('button', { name: zh.save }).first().click(); await approveChange(dialog) }
          }
          const checklist = dialog.locator('.bt-card-checklist').first()
          await checklist.getByLabel(zh.checklistNew).first().fill(checklistText)
          await checklist.getByRole('button', { name: zh.addItem }).first().click()
          await approveChange(dialog)
          const saved = await waitFor('labels, due date and checklist in board-list', async () => {
            const current = await taskByTitle(title)
            return current && (current.labels ?? []).includes(label) && String(current.dueDate ?? '').startsWith(due)
              && current.dueComplete === true && (current.checklist ?? []).some(item => item.text === checklistText) ? current : undefined
          }, 25_000)
          return { labels: saved.labels, dueDate: saved.dueDate, dueComplete: saved.dueComplete, checklist: saved.checklist.map(item => item.text), screenshot: await shot('card-fields-saved') }
        })
        const current = await taskByTitle(title)
        return { labels: current.labels, dueDate: current.dueDate, dueComplete: current.dueComplete, checklist: (current.checklist ?? []).map(item => item.text) }
      })

      await step('comments: over-limit text is blocked, a valid comment is posted', async () => {
        const commentText = 'E2E comment ' + opts.runId
        let overLimitDisabled
        await withCard(createdTask.id, async dialog => {
          const comments = dialog.locator('.bt-card-comments').first()
          const textarea = comments.getByLabel(zh.comment).first()
          const post = comments.getByRole('button', { name: zh.postComment }).first()
          await textarea.fill('x'.repeat(2049))
          overLimitDisabled = await post.isDisabled()
          if (!overLimitDisabled) throw new StepError('over-limit comment is not blocked', { selector: '.bt-card-comments textarea + button', length: 2049 })
          await textarea.fill(commentText)
          if (await post.isDisabled()) throw new StepError('valid comment cannot be posted', { length: commentText.length })
          await post.click()
          await waitFor('comment in board-list', async () => {
            const current = await taskByTitle(title)
            return (current?.comments ?? []).some(comment => comment.text === commentText) ? current : undefined
          }, 20_000)
          await waitFor('posted comment rendered', async () => (await comments.innerText()).includes(commentText), 10_000)
          const ui = await comments.innerText()
          if (!ui.includes(commentText)) throw new StepError('posted comment is not rendered', { selector: '.bt-comment-text', text: ui.slice(0, 400) })
          return { comment: commentText, screenshot: await shot('comment-posted') }
        })
        return { overLimitDisabled, comment: commentText }
      })

      await step('comments: an existing comment can be edited and a new one deleted', async () => {
        const editedText = 'E2E comment edited ' + opts.runId
        const deletedText = 'E2E comment deleted ' + opts.runId
        await withCard(createdTask.id, async dialog => {
          const comments = dialog.locator('.bt-card-comments').first()
          const original = comments.locator('.bt-comment').first()
          await original.getByRole('button', { name: zh.edit }).first().click()
          const editor = original.locator('textarea')
          await editor.waitFor({ state: 'visible', timeout: 10_000 })
          await editor.fill(editedText)
          await original.getByRole('button', { name: zh.save }).first().click()
          await waitFor('edited comment in board-list', async () => (await taskByTitle(title))?.comments?.some(comment => comment.text === editedText), 20_000)
          await waitFor('edited comment rendered', async () => (await comments.innerText()).includes(editedText), 10_000)
          const textarea = comments.getByLabel(zh.comment).first()
          const post = comments.getByRole('button', { name: zh.postComment }).first()
          await textarea.fill(deletedText)
          await post.click()
          await waitFor('deletable comment in board-list', async () => (await taskByTitle(title))?.comments?.some(comment => comment.text === deletedText), 20_000)
          const doomed = comments.locator('.bt-comment').filter({ hasText: deletedText }).first()
          await doomed.getByRole('button', { name: zh.deleteComment }).first().click()
          await doomed.getByRole('button', { name: zh.confirmDelete }).first().click()
          await waitFor('comment removed from board-list', async () => {
            const current = await taskByTitle(title)
            return !(current?.comments ?? []).some(comment => comment.text === deletedText) ? current : undefined
          }, 20_000)
          await waitFor('deleted comment removed from the dialog', async () => !(await comments.innerText()).includes(deletedText), 10_000)
          const ui = await comments.innerText()
          if (!ui.includes(editedText)) throw new StepError('edited comment is not rendered', { text: ui.slice(0, 400) })
          if (ui.includes(deletedText)) throw new StepError('deleted comment is still rendered', { text: ui.slice(0, 400) })
          return { editedText, deletedText, screenshot: await shot('comment-edited-deleted') }
        })
        const final = await taskByTitle(title)
        return { edited: (final.comments ?? []).some(comment => comment.text === editedText), deletedGone: !(final.comments ?? []).some(comment => comment.text === deletedText) }
      })

      await step('attachments: unsupported file rejected, valid PNG uploaded and rendered', async () => {
        const png = PNG.sync.write({ width: 16, height: 16, data: Buffer.alloc(16 * 16 * 4, 128) })
        let rejectedText = ''
        await withCard(createdTask.id, async dialog => {
          const attachments = dialog.locator('.bt-card-attachments').first()
          const input = attachments.locator('input[type=file]').first()
          await input.setInputFiles({ name: 'unsupported.exe', mimeType: 'application/x-msdownload', buffer: Buffer.from('not allowed') })
          await page.waitForTimeout(500)
          const alerts = await attachments.locator('[role=alert]').allInnerTexts()
          rejectedText = alerts.join(' | ')
          if (!/PNG|JPEG|支持|PDF/.test(rejectedText)) throw new StepError('unsupported file was not rejected with an attachment message', { alerts: rejectedText })
          if (await attachments.locator('.bt-attachment-queue img').count()) throw new StepError('unsupported file was queued as an image')
          await input.setInputFiles({ name: 'e2e-' + opts.runId + '.png', mimeType: 'image/png', buffer: png })
          await page.waitForTimeout(500)
          const upload = attachments.getByRole('button', { name: zh.uploadImages }).first()
          if (!await upload.count()) throw new StepError('no Upload images button after choosing a PNG')
          await upload.click()
          await waitFor('uploaded image in board-list', async () => {
            const current = await taskByTitle(title)
            return (current?.images ?? []).length ? current : undefined
          }, 30_000)
          const image = attachments.locator('.bt-attachment-grid img').first()
          await image.waitFor({ state: 'visible', timeout: 10_000 })
          const natural = await image.evaluate(node => ({ width: node.naturalWidth, height: node.naturalHeight }))
          if (!natural.width || !natural.height) throw new StepError('uploaded image is not decoded by the browser', { natural })
          await input.setInputFiles({ name: 'e2e-spec-' + opts.runId + '.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\nE2E attachment\n') })
          await page.waitForTimeout(300)
          await attachments.getByRole('button', { name: zh.uploadImages }).first().click()
          const withPdf = await waitFor('PDF attachment in board-list', async () => {
            const current = await taskByTitle(title)
            return (current?.images ?? []).some(item => item.mediaType === 'application/pdf') ? current : undefined
          }, 30_000)
          await attachments.locator('.bt-attachment-file').filter({ hasText: 'e2e-spec-' + opts.runId }).waitFor({ state:'visible', timeout:10_000 })
          return { images: withPdf.images.length, natural, rejectedText, screenshot: await shot('image-uploaded') }
        })
        return { rejectedText }
      })

      await step('attachments: an uploaded image can be chosen as the card cover', async () => {
        const current = await taskByTitle(title)
        const imageId = (current?.images ?? [])[0]?.id
        if (!imageId) throw new StepError('no uploaded image to use as a cover')
        await withCard(createdTask.id, async dialog => {
          const tile = dialog.locator('.bt-card-attachments .bt-attachment').first()
          await tile.hover()
          const setCover = tile.getByRole('button', { name: zh.setCover }).first()
          if (!await setCover.count()) throw new StepError('no Set as cover action on the attachment')
          await setCover.click()
          await approveChange(dialog)
          await waitFor('cover selection in board-list', async () => (await taskByTitle(title))?.coverImageId === imageId, 20_000)
          await tile.locator('.bt-attachment-cover-flag').waitFor({ state: 'visible', timeout: 10_000 })
          return { imageId, screenshot: await shot('cover-set') }
        })
        const coverImage = page.locator('.bt-board-card[data-task-id="' + createdTask.id + '"] .bt-board-card-cover img').first()
        await coverImage.waitFor({ state: 'visible', timeout: 10_000 })
        const natural = await coverImage.evaluate(node => ({ width: node.naturalWidth, height: node.naturalHeight }))
        if (!natural.width) throw new StepError('card cover is not decoded', { natural })
        return { imageId, natural }
      })

      await step('reload: card, lane, labels, due date, checklist, comment and image persist', async () => {
        await page.reload({ waitUntil: 'domcontentloaded' })
        await page.waitForTimeout(2500)
        await ensureBoard()
        const current = await taskByTitle(title)
        if (!current) throw new StepError('card is missing from board-list after reload')
        const card = page.locator('.bt-board-card[data-task-id="' + createdTask.id + '"]').first()
        await card.waitFor({ state: 'visible', timeout: 15_000 })
        const stage = await card.evaluate(el => el.closest('[data-stage]')?.getAttribute('data-stage'))
        if (stage !== 'waiting' && stage !== 'working') throw new StepError('card is not in its dispatch lane after reload', { stage })
        if (!current.coverImageId) throw new StepError('card cover did not survive reload')
        await card.locator('.bt-board-card-cover img').first().waitFor({ state: 'visible', timeout: 10_000 })
        await withCard(createdTask.id, async dialog => {
          const text = await dialog.innerText()
          if (!text.includes('E2E comment')) throw new StepError('comment did not survive reload', { text: text.slice(0, 1200) })
          if (!text.includes('Checklist ' + opts.runId)) throw new StepError('checklist did not survive reload', { text: text.slice(0, 1200) })
          if (!text.includes('e2e-' + opts.runId.slice(-4))) throw new StepError('label did not survive reload', { text: text.slice(0, 1200) })
          const dueValue = await dialog.locator('.bt-card-due-editor input[type=date]').first().inputValue().catch(() => '')
          if (!dueValue.startsWith('2026-12-15')) throw new StepError('due date did not survive reload', { dueValue, text: text.slice(0, 1200) })
          const image = dialog.locator('.bt-attachment-grid img').first()
          const natural = await image.evaluate(node => ({ width: node.naturalWidth, height: node.naturalHeight })).catch(() => ({}))
          if (!natural.width) throw new StepError('image did not render after reload', { natural })
          return { stage, screenshot: await shot('reload-persisted') }
        })
        return { stage }
      })

      await step('reload: edited description persists', async () => {
        const current = await taskByTitle(title)
        const expected = 'E2E description ' + opts.runId + ': survives reload.'
        if (current?.description !== expected) throw new StepError('description was not saved before reload', { actual: current?.description, expected })
        await withCard(createdTask.id, async dialog => {
          const text = await dialog.locator('.bt-card-description').innerText()
          if (!text.includes(expected)) throw new StepError('description is not rendered after reload', { text: text.slice(0, 400) })
          return { screenshot: await shot('description-persisted') }
        })
        return { description: expected }
      })

      await step('release: starting a release schedules its item through the real scheduler', async () => {
        const draftTask = await taskByTitle('E2E draft ' + opts.runId)
        if (!draftTask) throw new StepError('draft card is missing for release start')
        const release = await api('board-release-create', { scope: scope(), operationId: randomUUID(),
          release: { id: randomUUID(), name: 'E2E start release', version: '0.0.2' } })
        await api('board-release-assign', { scope: scope(), operationId: randomUUID(),
          releaseId: release.id, expectedReleaseRevision: release.revision, taskId: draftTask.id, expectedTaskRevision: draftTask.revision })
        const started = await api('board-release-start', { scope: scope(), operationId: randomUUID(),
          releaseId: release.id, expectedRevision: release.revision })
        if (started.status !== 'running') throw new StepError('release did not start', { started })
        const scheduled = await waitFor('release item to enter the dispatch lanes', async () => {
          const list = await boardList()
          const current = list.tasks.find(item => item.id === draftTask.id)
          return current && ['ready', 'working', 'reported', 'done'].includes(current.status) ? { list, current } : undefined
        }, 25_000)
        const activeRelease = scheduled.list.releases.find(item => item.id === release.id)
        if (activeRelease?.status !== 'running') throw new StepError('release status did not stay running', { activeRelease })
        if (scheduled.current.releaseId !== release.id) throw new StepError('release item lost its release id')
        return { releaseId: release.id, taskId: draftTask.id, status: scheduled.current.status, dispatchState: scheduled.current.dispatchState, screenshot: await shot('release-started') }
      })
    } else {
      results.push({ name: 'downstream board scenarios', status: 'SKIP', evidence: { message: 'card creation failed' }, ms: 0 })
    }
  } else {
    results.push({ name: 'downstream board scenarios', status: 'SKIP', evidence: { message: 'board open failed' }, ms: 0 })
  }

  await step('console: no uncaught page errors and no console errors', async () => {
    if (pageErrors.length || consoleErrors.length) {
      throw new StepError('browser reported errors', { pageErrors, consoleErrors: consoleErrors.slice(0, 20) })
    }
    return { pageErrors: 0, consoleErrors: 0 }
  })
}

async function cleanup() {
  try { if (browser) await browser.close() } catch {}
  if (!opts.baseUrl) {
    if (opts.keep) {
      log('bench kept at ' + (seed?.base ?? 'unknown') + ' (pid files under ' + opts.home + ')')
    } else {
      const stopped = await stopBench({ home: opts.home, webPort: opts.webPort, mockPort: opts.mockPort })
      const free = stopped.webPortFree && stopped.mockPortFree
      results.push({ name: 'bench: stop every started process and free the ports', status: free ? 'PASS' : 'FAIL', evidence: stopped, ms: 0 })
      log((free ? 'PASS' : 'FAIL') + '  bench: stop every started process and free the ports ' + JSON.stringify(stopped))
    }
  }
}

let fatal
try {
  await main()
} catch (error) {
  fatal = error
  results.push({ name: 'run', status: 'FAIL', evidence: { message: error.message, stack: error.stack?.split('\n').slice(0, 6) }, ms: Date.now() - startedAt })
  log('FAIL  run: ' + error.message)
} finally {
  await cleanup()
}

const summary = {
  runId: opts.runId,
  startedAt: new Date(startedAt).toISOString(),
  finishedAt: stamp(),
  base: seed?.base ?? null,
  home: opts.home,
  room: seed?.room ?? null,
  checks: results,
  browser: { pageErrors, consoleErrors },
  source: (() => {
    try {
      const file = join(PLUGIN, 'src', 'client', 'task-board.js')
      return { path: 'ds-bot/src/client/task-board.js', bytes: readFileSync(file).length }
    } catch { return null }
  })(),
}
writeFileSync(join(ARTIFACTS, 'results.json'), JSON.stringify(summary, null, 2) + '\n')
const failed = results.filter(item => item.status === 'FAIL')
const passed = results.filter(item => item.status === 'PASS')
log('')
log('artifacts: ' + ARTIFACTS)
log('checks: ' + passed.length + ' passed, ' + failed.length + ' failed' + (results.some(item => item.status === 'SKIP') ? ', ' + results.filter(item => item.status === 'SKIP').length + ' skipped' : ''))
for (const item of failed) log('  FAIL ' + item.name + ': ' + (item.evidence?.message ?? ''))
if (fatal) log('run error: ' + fatal.message)
process.exit(failed.length ? 1 : 0)
