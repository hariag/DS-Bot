import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { START_ACTS } from '../src/start-window.mjs'
import { TEXT, t } from '../src/start/text.mjs'

const dir = new URL('../src/start/', import.meta.url)
const read = name => readFileSync(new URL(name, dir), 'utf8')
const SCRIPTS = ['start.js', 'whale.js', 'text.mjs']
const html = read('start.html')
const code = Object.fromEntries(SCRIPTS.map(name => [name, read(name)]))
const uncommented = text => text.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//gu, '')

test('the start page runs under its CSP: no inline style or script, no data: or network URLs', () => {
  assert.ok(html.includes(`<meta http-equiv="Content-Security-Policy" content="default-src 'self'; base-uri 'none'; object-src 'none'">`), 'the CSP meta is missing or changed')
  const rules = [
    [/<style[\s>]/iu, '<style> element'],
    [/\sstyle\s*=/iu, 'style= attribute'],
    [/\son[a-z]+\s*=/iu, 'on* handler attribute'],
    [/<script(?![^>]*\ssrc=)[^>]*>/iu, 'inline <script>'],
    [/data:/iu, 'data: URL'],
    [/https?:/iu, 'http(s): URL'],
  ]
  for (const [pattern, what] of rules) assert.doesNotMatch(html, pattern, `start.html: ${what}`)
  for (const name of ['start.css', ...SCRIPTS]) {
    const body = uncommented(read(name))
    assert.doesNotMatch(body, /url\(\s*['"]?(?:data:|https?:)|@import/iu, `${name}: external or data: resource`)
    assert.doesNotMatch(body, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/u, `${name}: markup or code from strings`)
  }
})

test('every file the page loads is relative and inside src/start', () => {
  const inside = (from, url) => {
    assert.doesNotMatch(url, /^(?:[a-z][\w+.-]*:|\/|\\)|\.\./iu, `${from} loads ${url}`)
    assert.ok(existsSync(new URL(url, dir)), `${from} loads ${url}, which is missing`)
  }
  const loads = [...html.matchAll(/\s(?:src|href)="([^"#][^"]*)"/gu)].map(match => match[1])
  assert.deepEqual(loads, ['start.css', 'start.js'])
  assert.match(html, /<script type="module" src="start.js"><\/script>/u)
  for (const url of loads) inside('start.html', url)
  for (const [name, text] of Object.entries(code)) {
    const body = uncommented(text)
    assert.doesNotMatch(body, /\bimport\s*\(/u, `${name}: a dynamic import`)
    for (const match of body.matchAll(/^\s*(?:import|export)\b[^'"\n]*?\bfrom\s*['"]([^'"]+)['"]|^\s*import\s*['"]([^'"]+)['"]/gmu)) inside(name, match[1] ?? match[2])
  }
  for (const [, url] of uncommented(read('start.css')).matchAll(/url\(\s*['"]?([^'")#][^'")]*)/gu)) inside('start.css', url)
})

test('the page binds window.dsBotStart through onState and act only', () => {
  const used = new Set([...code['start.js'].matchAll(/\bbridge\??\.(\w+)/gu)].map(match => match[1]))
  assert.deepEqual([...used].sort(), ['act', 'onState'])
  assert.match(code['start.js'], /const bridge = window\.dsBotStart\b/u)
})

// The acts the main process must accept from the start window (its allowlist).
test('the page sends only the acts of the start window', () => {
  const local = new Set(['toggleDetails', 'toggleMore', 'toggleModels'])
  const sent = new Set([
    ...[...html.matchAll(/data-act="(\w+)"/gu)].map(match => match[1]),
    ...[...code['start.js'].matchAll(/\bact: '(\w+)'|\bact\('(\w+)'/gu)].map(match => match[1] ?? match[2]),
    ...[...code['whale.js'].matchAll(/\bact\('(\w+)'\)/gu)].map(match => match[1]),
  ].filter(name => !local.has(name)))
  assert.deepEqual([...sent].sort(), ['answer', 'copyDetails', 'freshStart', 'handoffDone', 'handoffShow', 'importModel', 'importOption', 'installUpdate', 'keepCopying', 'manualDownload', 'openLogs', 'pick', 'reloadView', 'retry', 'stopCopy', 'wait'])
  // Every act the main process takes is one that the page sends, under the same name.
  for (const name of START_ACTS) assert.ok(sent.has(name), `the main process takes ${name}, which the page never sends`)
})

test('zh and en carry the same keys and the same placeholders', () => {
  const placeholders = text => (text.match(/\{\w+\}/gu) ?? []).sort().join()
  assert.deepEqual(Object.keys(TEXT.en).sort(), Object.keys(TEXT.zh).sort())
  for (const [key, zh] of Object.entries(TEXT.zh)) assert.equal(placeholders(TEXT.en[key]), placeholders(zh), `${key}: placeholders differ`)
})

// docs/plans/2026-10-26-windows-onboarding.md, 用词: proper names and units only.
test('the zh copy shows no English but the allowed names and units', () => {
  const NAMES = ['DS Bot', 'DSH Desktop', 'DSH Web']
  const WORDS = new Set(['DeepSeek', 'Bot', 'API', 'Key', 'Harness', 'DSH', 'Agent', 'MCP', 'Windows', 'PowerShell', 'GitHub', 'SmartScreen', 'OneDrive', 'HTTP', 'SOCKS', 'KB', 'MB', 'GB'])
  const english = []
  for (const [key, value] of Object.entries(TEXT.zh)) {
    let rest = value.replace(/\{\w+\}/gu, ' ')
    for (const name of NAMES) rest = rest.replaceAll(name, ' ')
    for (const word of rest.match(/[A-Za-z][A-Za-z0-9.-]*/gu) ?? []) if (!WORDS.has(word)) english.push(`${key}: ${word}`)
    // A promise the engine cannot keep.
    assert.doesNotMatch(value, /马上|稍后|下个版本/u, key)
  }
  assert.deepEqual(english, [])
})

test('every text key that the page uses exists', () => {
  const keys = Object.keys(TEXT.zh)
  const matching = pattern => keys.filter(key => new RegExp(`^${pattern.replaceAll('.', '\\.').replace(/\{\w+\}/gu, '\\w+')}$`, 'u').test(key))
  for (const [, key] of html.matchAll(/data-t(?:-label)?="([^"]+)"/gu)) assert.ok(matching(key).length > 0, `start.html: unknown text key ${key}`)
  const literal = /^(?:voice|hint|title|say|card|import|copying|eta|sr|state|phase|slow|update|failed|newer|importFailed|track)\.[\w.]+$/u
  for (const name of ['start.js', 'whale.js']) {
    const text = uncommented(code[name])
    const used = [
      ...[...text.matchAll(/'([\w.]+)'/gu)].map(match => match[1]).filter(key => literal.test(key)),
      ...[...text.matchAll(/\b(?:say|label)\('([\w.]+)'/gu)].map(match => match[1]),
    ]
    for (const key of used) assert.ok(key in TEXT.zh, `${name}: unknown text key ${key}`)
    for (const [, prefix] of text.matchAll(/`([\w.]+\.)\$\{/gu)) assert.ok(keys.some(key => key.startsWith(prefix)), `${name}: no text key starts with ${prefix}`)
  }
  // Keys the page builds from the snapshot's views, the stages and the failure reasons.
  for (const key of ['title.failed', 'title.viewFailed', 'title.later', 'title.moving', 'phase.data', 'phase.engine', 'phase.team', 'state.pending', 'state.active', 'state.done', 'state.failed']) assert.ok(key in TEXT.zh, key)
  assert.deepEqual(matching('failed.reason.{reason}').sort(), ['failed.reason.engine', 'failed.reason.files', 'failed.reason.other', 'failed.reason.permission', 'failed.reason.space'])
})

test('t fills placeholders and falls back to zh, then to the key', () => {
  assert.equal(t('zh', 'elapsed', { n: 12 }), '已用 12 秒')
  assert.equal(t('en', 'elapsed', { n: 12 }), '12 s so far')
  assert.equal(t('en', 'voice.helloName', { name: 'Ada' }), 'Hi, I’m Ada')
  assert.equal(t('fr', 'retry'), '重试')
  assert.equal(t('en', 'hint.space', { drive: 'C' }), 'Only {free} left on drive C')
  assert.equal(t('zh', 'no.such.key'), 'no.such.key')
})

test('the generated blocks of the start page are current', () => {
  const script = fileURLToPath(new URL('../scripts/start-assets.mjs', import.meta.url))
  const result = spawnSync(process.execPath, [script, '--check'], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr || result.stdout)
})
