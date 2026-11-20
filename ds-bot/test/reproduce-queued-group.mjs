// Standalone known-defect reproducer. It uses group-work's mock host and temporary data.
// Run from ds-bot/: node test/reproduce-queued-group.mjs
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
const path = join(testDir, `.queued-group-repro-${randomUUID()}.mjs`)
const test = `
test('queued group posts each deliver their own named request', async (t) => {
  const host = await start(t)
  const stop = new AbortController()
  t.after(() => stop.abort())
  host.emit('r1', 'user/message', host.say('@Writer first request'))
  host.emit('r1', 'user/message', host.say('@Tester second request'))
  void host.tool('group_relay', {}, 'r1', { callId: 'queued-posts', signal: stop.signal }).catch(() => {})
  await settle(() => host.agentOf('gc').calls.length > 0)
  assert.equal(host.agentOf('gb').calls.length, 1, 'the earlier @Writer must be delivered')
  assert.equal(host.agentOf('gc').calls.length, 1, 'the later @Tester must be delivered')
})
`
try {
  writeFileSync(path, source.slice(0, end + marker.length) + test, { flag: 'wx' })
  const result = spawnSync(process.execPath, ['--import', './test/harness-resolve.mjs', '--test', '--test-timeout=15000', '--test-force-exit', path], { cwd: join(testDir, '..'), encoding: 'utf8', timeout: 30000 })
  if (result.status === 1 && result.stdout.includes('the earlier @Writer must be delivered') && result.stdout.includes('0 !== 1')) {
    console.log('REPRODUCED: the first queued @Writer is not delivered; @Tester is delivered.')
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
