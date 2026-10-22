import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { widthOf } from '../src/client/themes.js'

const bundle = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
// The declarations of the rule whose whole selector is `selector`.
const ruleOf = (selector) => {
  const start = bundle.search(new RegExp(`(^|[\\n}\`])${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\{`))
  assert.notEqual(start, -1, `no rule for ${selector}`)
  const open = bundle.indexOf('{', start + 1)
  return bundle.slice(open + 1, bundle.indexOf('}', open))
}

test('a width the plugin does not know reads as the default', () => {
  assert.equal(widthOf({}), 80)
  assert.deepEqual([40, 101, 72.5, 'wide'].map(width => widthOf({ width })), [80, 80, 80, 80])
  assert.deepEqual([50, 95, 100].map(width => widthOf({ width })), [50, 95, 100])
})

test('every bubble takes the share of the column that the width setting gives', () => {
  for (const selector of ['.bt-msg', '.bt-astack[data-lead]>.bt-msg', '.bt-ustack', '.bt-ububble', '.bt-think']) {
    assert.match(ruleOf(selector), /max-width:[^;]*var\(--bt-msg-w\)/, selector)
  }
  assert.match(bundle, /\nbody\{--bt-msg-w:\.8\}/)
})

test('a Bot bubble keeps room for the toolbar beside it', () => {
  assert.match(ruleOf('.bt-msg'), /calc\(100% - 82px\)/)
})
