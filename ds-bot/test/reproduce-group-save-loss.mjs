// Isolated known-defect reproducer. Run from ds-bot/: node test/reproduce-group-save-loss.mjs
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const testDir = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(testDir, 'group-work.test.js'), 'utf8')
const marker = "const kinds = result => result.replies.map(reply => [reply.kind ?? 'message', reply.name])\n"
const end = source.indexOf(marker)
if (end < 0) throw new Error('group-work mock host changed; update the reproducer')
const path = join(testDir, `.group-save-repro-${randomUUID()}.mjs`)
const test = `
test('queued group posts survive a failed save before dispatch', async (t) => {
  const host = await start(t)
  host.emit('r1', 'user/message', host.say('@Writer first request'))
  host.emit('r1', 'user/message', host.say('@Tester second request'))
  assert.equal(rt.roomInbox.get('r1')?.length, 2)
  const save = rt.save
  rt.save = async () => { throw new Error('fixture-save-failed') }
  try {
    await assert.rejects(host.tool('group_relay', {}, 'r1', { callId: 'queued-posts', signal: new AbortController().signal }), /fixture-save-failed/)
  } finally { rt.save = save }
  assert.equal(rt.roomInbox.get('r1')?.length ?? 0, 2, 'queued posts must survive save failure')
})
`
try {
  writeFileSync(path, source.slice(0, end + marker.length) + test, { flag: 'wx' })
  const result = spawnSync(process.execPath, ['--import', './test/harness-resolve.mjs', '--test', '--test-timeout=15000', '--test-force-exit', path], { cwd: join(testDir, '..'), encoding: 'utf8', timeout: 30000 })
  if (result.status === 1 && result.stdout.includes('queued posts must survive save failure') && result.stdout.includes('0 !== 2')) {
    console.log('REPRODUCED: a save failure removes both queued posts before dispatch.')
  } else {
    process.stderr.write(result.stdout ?? '')
    process.stderr.write(result.stderr ?? '')
    throw new Error(`Expected the known failure; test exited ${result.status ?? result.signal}`)
  }
} finally {
  try { unlinkSync(path) } catch (error) {
    if (error.code !== 'ENOENT') { console.error('Could not remove temporary test:', error); process.exitCode = 1 }
  }
}
