// Isolated known-defect reproducer. Run from ds-bot/:
// node test/reproduce-group-drain-save-failure.mjs
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
const path = join(testDir, `.group-drain-repro-${randomUUID()}.mjs`)
const test = `
test('a running round does not consume and dispatch before a failed save', async (t) => {
  const host = await start(t)
  const agent = host.agentOf('r1')
  agent.id = 'r1'
  const stop = new AbortController()
  t.after(() => stop.abort())
  host.emit('r1', 'user/message', host.say('@Chief first'))
  const relay = rt.teamTools.find(tool => tool.name === 'group_relay')
  void relay.execute({}, { agent, callId: 'drain-save', signal: stop.signal }).catch(() => {})
  await settle(() => host.agentOf('ga').calls.length === 1)
  const save = rt.save
  rt.save = async () => { throw new Error('fixture-save-failed') }
  try {
    agent.inbox.nextStep.push({ id: 'mid-round', ...host.say('@Writer urgent work') })
    rt.nudgeRoom('r1')
    await settle(() => host.agentOf('gb').calls.length === 1)
    assert.ok(agent.inbox.nextStep.some(message => message.id === 'mid-round'), 'message must remain in inbox when state save fails')
  } finally { rt.save = save }
})
`
try {
  writeFileSync(path, source.slice(0, end + marker.length) + test, { flag: 'wx' })
  const result = spawnSync(process.execPath, ['--import', './test/harness-resolve.mjs', '--test', '--test-timeout=15000', '--test-force-exit', path], { cwd: join(testDir, '..'), encoding: 'utf8', timeout: 30000 })
  if (result.status === 1 && result.stdout.includes('message must remain in inbox when state save fails')) {
    console.log('REPRODUCED: a running round removed an inbox message and called its recipient despite a failed save.')
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
