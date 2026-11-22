import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

test('version info reads the current package manifest after a hot reload', async t => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-version-info-'))
  t.after(() => rmSync(home, { recursive:true, force:true, maxRetries:5, retryDelay:20 }))
  const modulePath = join(home, 'src', 'host', 'version-info.mjs')
  mkdirSync(dirname(modulePath), { recursive:true })
  copyFileSync(new URL('../src/host/version-info.mjs', import.meta.url), modulePath)
  const manifestPath = join(home, 'package.json')
  const save = version => writeFileSync(manifestPath, JSON.stringify({
    name:'ds-bot', version, dsBot:{ build:version, fork:'test/fork', forkCommit:'test-commit', upstreamCommit:'test-upstream' },
  }))
  save('0.3.9+test.1')
  const { versionInfo } = await import(pathToFileURL(modulePath).href)
  assert.equal(versionInfo({ revision:1 }, home).version, '0.3.9+test.1')
  save('0.3.9+test.2')
  assert.equal(versionInfo({ revision:2 }, home).version, '0.3.9+test.2')
})
