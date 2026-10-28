import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { readStartFrame, writeStartFrame } from '../src/start-frame.mjs'
import {
  acceptsAct, centred, clampInto, clockMs, cubicBezier, detailsText, explainOf, failureReason, fallbackMs, GROWTH, GROWTH_EASING,
  growthSteps, isStartPage, MAIN_SIZE, mainRect, START_ACTS, startSize, startSnapshot, startUrl,
} from '../src/start-window.mjs'

const AREA = { x: 0, y: 0, width: 1920, height: 1040 }

test('the start window is 720 × 540, and 720 × 500 on a work area under 588 high', () => {
  assert.deepEqual(startSize(AREA), { width: 720, height: 540 })
  assert.deepEqual(startSize({ ...AREA, height: 588 }), { width: 720, height: 540 })
  assert.deepEqual(startSize({ ...AREA, height: 587 }), { width: 720, height: 500 })
})

test('the start window is centred on the work area under the cursor', () => {
  assert.deepEqual(centred(startSize(AREA), AREA), { x: 600, y: 250, width: 720, height: 540 })
  // A second display left of the first, below a taskbar at the top.
  assert.deepEqual(centred({ width: 720, height: 540 }, { x: -1280, y: 40, width: 1280, height: 984 }), { x: -1000, y: 262, width: 720, height: 540 })
})

test('the team window is centred on the start window and stays inside the work area', () => {
  const start = centred(startSize(AREA), AREA)
  assert.deepEqual(mainRect(start, AREA), { x: 300, y: 90, ...MAIN_SIZE })
  // Dragged to the top left corner: the team window keeps to the work area.
  assert.deepEqual(mainRect({ x: 10, y: 5, width: 720, height: 540 }, AREA), { x: 0, y: 0, ...MAIN_SIZE })
  assert.deepEqual(mainRect({ x: 1190, y: 495, width: 720, height: 540 }, AREA), { x: 600, y: 180, ...MAIN_SIZE })
  // A laptop's work area smaller than the team window: it fills the work area.
  assert.deepEqual(mainRect({ x: 323, y: 94, width: 720, height: 540 }, { x: 0, y: 0, width: 1366, height: 728 }), { x: 23, y: 0, width: 1320, height: 728 })
  assert.deepEqual(clampInto({ x: -50, y: 900, width: 2000, height: 300 }, AREA), { x: 0, y: 740, width: 1920, height: 300 })
})

test('the easing is CSS cubic-bezier()', () => {
  const ease = cubicBezier(0.25, 0.1, 0.25, 1)
  assert.ok(Math.abs(ease(0.5) - 0.8024) < 1e-3)
  assert.equal(GROWTH_EASING(0), 0)
  assert.equal(GROWTH_EASING(1), 1)
  let previous = 0
  for (let step = 1; step <= 100; step += 1) {
    const value = GROWTH_EASING(step / 100)
    assert.ok(value >= previous && value <= 1, `at ${String(step)}%`)
    previous = value
  }
  // cubic-bezier(.2, .7, .2, 1) is quick at first: most of the way in the first half.
  assert.ok(GROWTH_EASING(0.5) > 0.9)
})

test('the start window grows into the team window in about 14 ms steps over 300 ms', () => {
  const from = centred(startSize(AREA), AREA)
  const to = mainRect(from, AREA)
  const steps = growthSteps(from, to)
  assert.equal(GROWTH.duration, 300)
  assert.equal(GROWTH.delay, 160)
  assert.equal(steps.length, 22)
  assert.deepEqual(steps.at(-1), { at: 300, rect: to })
  assert.ok(steps.every((step, index) => index === 0 || step.at > steps[index - 1].at))
  assert.ok(steps.slice(0, -1).every(step => step.at % 14 === 0))
  for (const key of ['x', 'y', 'width', 'height']) {
    const toward = Math.sign(to[key] - from[key])
    let previous = from[key]
    for (const { rect } of steps) {
      assert.ok((rect[key] - previous) * toward >= 0, `${key} turns back`)
      previous = rect[key]
    }
  }
  // At least one size between the two: a growth, not a jump.
  assert.ok(steps.some(({ rect }) => rect.width > from.width && rect.width < to.width))
  // The same rects from wherever the start window was dragged to.
  const dragged = { x: 40, y: 30, width: 720, height: 540 }
  assert.deepEqual(growthSteps(dragged, mainRect(dragged, AREA)).at(-1).rect, { x: 0, y: 0, ...MAIN_SIZE })
})

test('the team window shows by itself after 2.5 s on a first start or a celebration, else 0.8 s', () => {
  assert.equal(fallbackMs({ start: 'first', celebrate: true }), 2500)
  assert.equal(fallbackMs({ start: 'first', celebrate: false }), 2500)
  assert.equal(fallbackMs({ start: 'later', celebrate: true }), 2500)
  assert.equal(fallbackMs({ start: 'later', celebrate: false }), 800)
})

test('a failure gets one of the five reasons of the failure page', () => {
  const coded = (code, message) => Object.assign(new Error(message), { code })
  assert.equal(failureReason(coded('EACCES', 'EACCES: permission denied, mkdir \'D:\\data\\profiles\'')), 'permission')
  assert.equal(failureReason(new Error('EPERM: operation not permitted, open \'x\'')), 'permission')
  assert.equal(failureReason(coded('ENOSPC', 'ENOSPC: no space left on device, write')), 'space')
  assert.equal(failureReason(new Error('There is not enough space on the disk.')), 'space')
  assert.equal(failureReason(coded('ENOENT', 'spawn C:\\Program Files\\DeepSeek Bot\\DeepSeek Bot.exe ENOENT')), 'files')
  assert.equal(failureReason(new Error('The DSH Host stopped (exit 1):\nError: Cannot find module \'@deepseek-ai/dsh-base\'')), 'files')
  assert.equal(failureReason(new Error('The app could not load its own bundles:\nds-bot: missing')), 'files')
  assert.equal(failureReason(new Error('The DSH Host stopped (exit 1):\nError: EACCES: permission denied, open \'state.json\'')), 'permission')
  assert.equal(failureReason(new Error('The DSH Host stopped (exit 3221225477)')), 'engine')
  assert.equal(failureReason(new Error('The profile in D:\\x does not start the engine\'s web server and connection.')), 'engine')
  assert.equal(failureReason(new Error('DeepSeek Bot: no free port on 127.0.0.1')), 'other')
  assert.equal(failureReason('a string'), 'other')
  assert.equal(failureReason(undefined), 'other')
})

test('the main process takes only its own acts, each in its own views', () => {
  assert.deepEqual([...START_ACTS].sort(), ['copyDetails', 'handoffDone', 'handoffShow', 'openLogs', 'reloadView', 'retry', 'wait'])
  assert.equal(acceptsAct('handoffShow', 'handoff'), true)
  assert.equal(acceptsAct('handoffShow', 'boot'), false)
  assert.equal(acceptsAct('handoffDone', 'handoff'), true)
  assert.equal(acceptsAct('retry', 'failed'), true)
  assert.equal(acceptsAct('retry', 'watchdog'), true)
  assert.equal(acceptsAct('retry', 'boot'), false)
  assert.equal(acceptsAct('retry', 'handoff'), false)
  assert.equal(acceptsAct('wait', 'watchdog'), true)
  assert.equal(acceptsAct('wait', 'failed'), false)
  assert.equal(acceptsAct('reloadView', 'viewFailed'), true)
  assert.equal(acceptsAct('reloadView', 'failed'), false)
  for (const view of ['boot', 'failed', 'viewFailed', 'watchdog', 'handoff', 'moving']) {
    assert.equal(acceptsAct('openLogs', view), true)
    assert.equal(acceptsAct('copyDetails', view), true)
  }
  // The cards of later pull requests, and names that are not acts at all.
  for (const name of ['reload', 'toggleDetails', 'answer', 'pick', 'freshStart', 'installUpdate', 'manualDownload', 'stopCopy', 'keepCopying', 'importModel', 'importOption', '__proto__', 'constructor', 'toString', '']) {
    assert.equal(acceptsAct(name, 'failed'), false, name)
  }
  assert.equal(acceptsAct(undefined, 'failed'), false)
  assert.equal(acceptsAct(42, 'failed'), false)
})

test('acts come only from the start page that was loaded', () => {
  const page = 'C:\\Program Files\\DeepSeek Bot\\resources\\app.asar\\src\\start\\start.html'
  const loaded = startUrl(page, 'first')
  assert.equal(loaded, 'file:///C:/Program%20Files/DeepSeek%20Bot/resources/app.asar/src/start/start.html?start=first')
  assert.equal(isStartPage(loaded, loaded), true)
  assert.equal(isStartPage(`${loaded}#x`, loaded), false)
  assert.equal(isStartPage(loaded.replace('first', 'later'), loaded), false)
  assert.equal(isStartPage(loaded.replace('start.html', 'other.html'), loaded), false)
  assert.equal(isStartPage('http://127.0.0.1:52817/src/start/start.html?start=first', loaded), false)
  assert.equal(isStartPage('not a url', loaded), false)
  assert.equal(isStartPage(undefined, loaded), false)
})

const state = (change = {}) => ({
  lang: 'zh', start: 'first', motion: 'normal', frame: 'band', view: 'boot', done: [], celebrate: true,
  explain: explainOf(), clock: { base: 0, from: 1000, running: true }, hint: undefined, failure: undefined, ...change,
})

test('the snapshot carries the phase, the stages done and the clock', () => {
  const now = 1_700_000_000_000
  const booting = startSnapshot(state({ clock: { base: 0, from: now - 6400, running: true } }), now)
  assert.deepEqual(booting, {
    v: 1, lang: 'zh', start: 'first', motion: 'normal', frame: 'band', view: 'boot', phase: 'data', done: [],
    clock: { ms: 6400, at: now, running: true, rate: 1 },
    explain: { mode: 'new', nextStep: true, previewNotice: false }, celebrate: true,
  })
  assert.equal(startSnapshot(state({ done: ['data'] }), now).phase, 'engine')
  const ready = startSnapshot(state({ view: 'handoff', done: ['team', 'data', 'engine'] }), now)
  assert.equal(ready.phase, 'team')
  assert.deepEqual(ready.done, ['data', 'engine', 'team'])
  // A paused clock (a dialog, the 180 s question, a failure) stays where it stopped.
  assert.deepEqual(startSnapshot(state({ view: 'watchdog', clock: { base: 180_000, from: 5, running: false } }), now).clock, { ms: 180_000, at: now, running: false, rate: 1 })
  assert.equal(clockMs({ base: 1000, from: now - 500, running: true }, now), 1500)
  assert.equal(clockMs({ base: 1000, from: now + 500, running: true }, now), 1000)
  const failed = startSnapshot(state({ view: 'failed', failure: { reason: 'engine', log: ['a', 'b'] } }), now)
  assert.deepEqual(failed.failure, { reason: 'engine', log: ['a', 'b'] })
  assert.equal('card' in failed, false)
  assert.equal('hint' in failed, false)
  assert.deepEqual(startSnapshot(state({ hint: { drive: 'C', free: '1.2 GB' } }), now).hint, { drive: 'C', free: '1.2 GB' })
  // The page gets copies: it cannot change the main process's state.
  const source = state({ failure: { reason: 'other', log: ['x'] } })
  const sent = startSnapshot(source, now)
  sent.explain.mode = 'import'
  sent.failure.log.push('y')
  assert.equal(source.explain.mode, 'new')
  assert.deepEqual(source.failure.log, ['x'])
})

test('what the hint row can prepare for: a new team, a reinstall or an import', () => {
  assert.deepEqual(explainOf(), { mode: 'new', nextStep: true, previewNotice: false })
  assert.deepEqual(explainOf({ team: { bots: 6, rooms: 2 } }), { mode: 'reinstall', bots: 6, groups: 2, nextStep: false, previewNotice: false })
  assert.deepEqual(explainOf({ offered: true }), { mode: 'import', nextStep: false, previewNotice: false })
  assert.deepEqual(explainOf({ offered: true, team: { bots: 1, rooms: 0 } }).mode, 'import')
  // The greeting names the kept team's first Main Bot; without a readable name it names none.
  const state = { mainBotIds: ['b2', 'b1'], bots: { b1: { name: 'Chief' }, b2: { name: ' Ada ' } } }
  assert.equal(explainOf({ team: { bots: 2, rooms: 0, team: state } }).name, 'Ada')
  assert.equal(explainOf({ team: { bots: 1, rooms: 0, team: { mainBotId: 'b1', bots: state.bots } } }).name, 'Chief')
  assert.equal(Object.hasOwn(explainOf({ team: { bots: 1, rooms: 0, team: { mainBotIds: ['gone'], bots: {} } } }), 'name'), false)
  assert.equal(Object.hasOwn(explainOf({ team: { bots: 1, rooms: 0, team: { mainBotIds: ['b1'], bots: { b1: { name: '  ' } } } } }), 'name'), false)
})

test('the copied details name the version and the reason before the log', () => {
  assert.equal(detailsText({ version: '0.2.2', platform: 'win32', arch: 'x64', reason: 'engine', lines: ['l1', 'l2'] }), 'DeepSeek Bot 0.2.2 (win32 x64)\nreason: engine\n\nl1\nl2')
})

test('the start window remembers the theme and the motion tier in its own file', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ds-bot-start-frame-'))
  t.after(() => { rmSync(dir, { recursive: true, force: true }) })
  const file = join(dir, 'start-frame.json')
  assert.deepEqual(readStartFrame(file), { themeSource: 'system', motion: 'normal' })
  assert.equal(writeStartFrame(file, { themeSource: 'dark' }), true)
  assert.equal(writeStartFrame(file, { themeSource: 'dark' }), false)
  assert.equal(writeStartFrame(file, { motion: 'lively', themeSource: 'moonlight' }), true)
  assert.deepEqual(readStartFrame(file), { themeSource: 'dark', motion: 'lively' })
  assert.deepEqual(readdirSync(dir), ['start-frame.json'])
  writeFileSync(file, '{"themeSource":"neon","motion":7}')
  assert.deepEqual(readStartFrame(file), { themeSource: 'system', motion: 'normal' })
  writeFileSync(file, 'not json')
  assert.deepEqual(readStartFrame(file), { themeSource: 'system', motion: 'normal' })
})

// Onboarding acceptance: no dialog during the first start without a window it belongs to.
test('every dialog belongs to a window', () => {
  const src = new URL('../src/', import.meta.url)
  const files = readdirSync(src).filter(name => /\.m?js$/u.test(name))
  const loose = files.flatMap((name) => {
    const code = readFileSync(new URL(name, src), 'utf8')
    return [...code.matchAll(/dialog\.(show\w+)\(\s*(\{|\))/gu)].map(match => `${name}: dialog.${match[1]}`)
  })
  assert.deepEqual(loose, [])
  assert.ok(files.every(name => !readFileSync(new URL(name, src), 'utf8').includes('showErrorBox')))
})
