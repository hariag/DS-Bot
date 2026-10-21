import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { openBotBrowser } from '../../ds-bot/src/host/browser/session.js'
import { startFixture } from '../bench/fixture.mjs'

const playwrightUrl = new URL('../node_modules/playwright/index.js', import.meta.url).href

test('one Bot keeps its cookies and another Bot does not see them', async () => {
  const fixture = await startFixture()
  const profileRoot = mkdtempSync(join(tmpdir(), 'bot-profiles-'))
  const open = (botId) => openBotBrowser({ botId, profileRoot, headless: true, playwrightUrl })
  const alpha = await open('alpha')
  await alpha.open(`${fixture.origin}/set-cookie`)
  await alpha.open(`${fixture.origin}/who`)
  const alphaText = await alpha.snapshotText()
  await alpha.close()
  const beta = await open('beta')
  await beta.open(`${fixture.origin}/who`)
  const betaText = await beta.snapshotText()
  await beta.close()
  const again = await open('alpha')
  await again.open(`${fixture.origin}/who`)
  const againText = await again.snapshotText()
  await again.close()
  await fixture.close()
  assert.match(alphaText, /bot=alpha/)
  assert.doesNotMatch(betaText, /bot=alpha/)
  assert.match(againText, /bot=alpha/)
})
