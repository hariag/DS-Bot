// Isolated reproducer for a rejected candidate, using group-work's temporary mock host.
// Run from ds-bot/: node test/reproduce-group-adopt-race.mjs
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
const path = join(testDir, `.group-adopt-repro-${randomUUID()}.mjs`)
const test = `
test('a reclaim that adopts newer state does not consume an unpersisted post', async (t) => {
  const host = await start(t)
  await rt.save({ required: true })
  host.emit('r1', 'user/message', host.say('@Writer race request'))
  writeFileSync(join(host.home, 'state.json'), JSON.stringify(seed({ name: 'Ops changed elsewhere' })))
  rmSync(join(host.home, 'state.lock'))
  const stop = new AbortController()
  t.after(() => stop.abort())
  void host.tool('group_relay', {}, 'r1', { callId: 'adopt-race', signal: stop.signal }).catch(() => {})
  await settle(() => host.agentOf('gb').calls.length > 0)
  assert.ok(rt.state.rooms.r1.log.some(row => row.text === '@Writer race request') || (rt.roomInbox.get('r1') ?? []).some(post => post.text === '@Writer race request'), 'adopted state or queue must retain the post')
})
`
try {
  writeFileSync(path, source.slice(0, end + marker.length) + test, { flag: 'wx' })
  const result = spawnSync(process.execPath, ['--import', './test/harness-resolve.mjs', '--test', '--test-timeout=15000', '--test-force-exit', path], { cwd: join(testDir, '..'), encoding: 'utf8', timeout: 30000 })
  if (result.status === 1 && result.stdout.includes('adopted state or queue must retain the post')) {
    console.log('REPRODUCED: lock reclaim adopted new state while the old room consumed the queued post.')
  } else {
    process.stderr.write(result.stdout ?? '')
    process.stderr.write(result.stderr ?? '')
    throw new Error(`Expected the candidate failure; test exited ${result.status ?? result.signal}`)
  }
} finally {
  try { unlinkSync(path) } catch (error) {
    if (error.code !== 'ENOENT') { console.error('Could not remove temporary test:', error); process.exitCode = 1 }
  }
}
