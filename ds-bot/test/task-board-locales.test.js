import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DICTIONARY } from '../src/client/i18n.js'

test('task-board translations preserve capacity placeholders and image limits', () => {
  const capacity = 'Instance task capacity: {count} / {limit}'
  const imageLimits = 'Choose non-interlaced PNG or JPEG: up to 20 per task, 10 per batch, 5 MiB each and 20 MiB per batch.'
  for (const locale of ['zh', 'zh-TW', 'ja', 'ko', 'es', 'fr', 'de']) {
    const dict = DICTIONARY[locale]
    const translated = dict[capacity]
    assert.equal(typeof translated, 'string', locale)
    assert.deepEqual([...translated.matchAll(/\{([^}]+)\}/g)].map(match => match[1]).sort(), ['count', 'limit'], locale)
    const limits = dict[imageLimits]
    assert.equal(typeof limits, 'string', locale)
    for (const required of ['20', '10', '5', 'MiB', 'PNG', 'JPEG']) assert.ok(limits.includes(required), `${locale}: ${required}`)
  }
})
