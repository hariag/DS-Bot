import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {test} from 'node:test'
import {DICTIONARY} from '../src/client/i18n.js'
test('all legacy review controls have simplified and traditional Chinese copy',()=>{
  const file=readFileSync(new URL('../src/client/task-board.js',import.meta.url),'utf8')
  const part=file.slice(file.indexOf('const recoveryObservationText'),file.indexOf('function DependenciesField'))
  const keys=new Set([...part.matchAll(/\bt\('([^']+)'\)/g)].map(match=>match[1]))
  for(const key of keys)for(const locale of ['zh','zh-TW'])assert.ok(DICTIONARY[locale][key] && DICTIONARY[locale][key]!==key,`${locale}: ${key}`)
})
test('snapshot absence and unknown identity remain distinct in both Chinese locales',()=>{
  assert.equal(DICTIONARY.zh['Observed in snapshot'],'快照中已发现')
  assert.equal(DICTIONARY.zh['Not observed in snapshot'],'快照中未发现')
  assert.equal(DICTIONARY['zh-TW']['Observed in snapshot'],'快照中已發現')
  assert.equal(DICTIONARY['zh-TW']['Not observed in snapshot'],'快照中未發現')
  for(const locale of ['zh','zh-TW'])assert.notEqual(DICTIONARY[locale]['Not observed in snapshot'],DICTIONARY[locale]['Not known'])
})
