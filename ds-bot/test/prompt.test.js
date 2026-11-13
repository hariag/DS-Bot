import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs, { chmodSync, constants, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { install } from '../src/host/prompt.js'
import { fakeContext } from './fake-ctx.js'

function start(config = {}) {
  const ctx = fakeContext()
  const bots = new Map([
    ['main', { name: 'Chief' }],
    ['worker', { name: 'Dev', instructions: 'Check files.' }],
  ])
  install({
    ctx,
    config,
    selfOf: id => id === 'group-worker' ? 'worker' : id,
    botOf: id => bots.get(id),
    roomOf: id => id === 'room' ? {} : undefined,
    isMain: id => id === 'main',
  })
  const prompt = id => ctx.sections.get('bot-identity').text({ agent: { id } })
  return { ctx, prompt }
}

test('deployment instructions apply to all Bot sessions after restart', (t) => {
  const marker = 'A private deployment rule provided by the operator.'
  const make = () => {
    const ctx = fakeContext()
    const bots = new Map(Array.from({ length: 13 }, (_, i) => [`bot-${i}`, { name: `Bot ${i}` }]))
    install({
      ctx,
      config: { operatorInstructions: marker },
      selfOf: id => id?.startsWith('group:') ? id.slice(6) : id,
      botOf: id => bots.get(id),
      roomOf: id => id === 'relay' ? {} : undefined,
      isMain: id => id === 'bot-0',
    })
    return ctx
  }
  for (const ctx of [make(), make()]) {
    t.after(() => ctx.dispose())
    const prompt = id => ctx.sections.get('bot-identity').text({ agent: { id } })
    for (let i = 0; i < 13; i++) {
      const privatePrompt = prompt(`bot-${i}`)
      assert.equal(privatePrompt.split(marker).length - 1, 1)
      assert.equal(prompt(`group:bot-${i}`), privatePrompt)
    }
    assert.doesNotMatch(prompt('relay'), /private deployment rule/)
    assert.equal(prompt('outside'), '')
  }
})

test('deployment instructions are optional and reject invalid values', (t) => {
  for (const config of [{}, { operatorInstructions: '' }, { operatorInstructions: '  ' }]) {
    const { ctx, prompt } = start(config)
    t.after(() => ctx.dispose())
    assert.doesNotMatch(prompt('main'), /## Deployment instructions/)
  }
  assert.throws(() => start({ operatorInstructions: 42 }), /operatorInstructions must be a string/)
})

test('private deployment file applies to each Bot and survives a runtime restart', { skip: process.platform !== 'linux' || typeof constants.O_NOFOLLOW !== 'number' }, (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ds-bot-instructions-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, 'instructions')
  const marker = 'A private deployment rule provided by the operator.'
  writeFileSync(path, marker, { mode: 0o600 })
  for (let restart = 0; restart < 2; restart++) {
    const ctx = fakeContext()
    t.after(() => ctx.dispose())
    const bots = new Map(Array.from({ length: 13 }, (_, i) => [`bot-${i}`, { name: `Bot ${i}` }]))
    install({ ctx, config: { operatorInstructionsFile: path }, selfOf: id => id?.startsWith('group:') ? id.slice(6) : id,
      botOf: id => bots.get(id), roomOf: id => id === 'relay' ? {} : undefined, isMain: id => id === 'bot-0' })
    const prompt = id => ctx.sections.get('bot-identity').text({ agent: { id } })
    for (let i = 0; i < 13; i++) {
      assert.equal(prompt(`bot-${i}`).split(marker).length - 1, 1)
      assert.equal(prompt(`group:bot-${i}`), prompt(`bot-${i}`))
    }
    assert.doesNotMatch(prompt('relay'), /private deployment rule/)
  }
})

test('private deployment files reject unsafe or ambiguous configuration without exposing the path', { skip: process.platform !== 'linux' || typeof constants.O_NOFOLLOW !== 'number' }, (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ds-bot-instructions-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, 'instructions')
  const link = join(dir, 'link')
  writeFileSync(path, 'A private rule', { mode: 0o600 })
  assert.throws(() => start({ operatorInstructions: 'a', operatorInstructionsFile: path }), /cannot be combined/)
  symlinkSync(path, link)
  for (const bad of [link, join(dir, 'missing'), dir]) {
    assert.throws(() => start({ operatorInstructionsFile: bad }), error => /unavailable or insecure/.test(error.message) && !error.message.includes(bad))
  }
  chmodSync(path, 0o644)
  assert.throws(() => start({ operatorInstructionsFile: path }), /unavailable or insecure/)
  chmodSync(path, 0o600)
  writeFileSync(path, '  ')
  assert.throws(() => start({ operatorInstructionsFile: path }), /unavailable or insecure/)
  writeFileSync(path, 'x'.repeat(65537))
  assert.throws(() => start({ operatorInstructionsFile: path }), /unavailable or insecure/)
  const nested = join(dir, 'nested')
  const parentLink = join(dir, 'parent-link')
  mkdirSync(nested, { mode: 0o700 })
  writeFileSync(join(nested, 'instructions'), 'A private rule', { mode: 0o600 })
  symlinkSync(nested, parentLink)
  assert.throws(() => start({ operatorInstructionsFile: join(parentLink, 'instructions') }), /unavailable or insecure/)
  chmodSync(nested, 0o777)
  assert.throws(() => start({ operatorInstructionsFile: join(nested, 'instructions') }), /unavailable or insecure/)
  assert.throws(() => start({ operatorInstructionsFile: 'relative-path' }), /unavailable or insecure/)
})

test('private deployment file replacement during read fails closed', { skip: process.platform !== 'linux' || typeof constants.O_NOFOLLOW !== 'number' }, (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ds-bot-instructions-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, 'instructions')
  writeFileSync(path, 'Original private rule', { mode: 0o600 })
  const read = fs.readSync
  let replaced = false
  try {
    fs.readSync = (...args) => {
      const count = read(...args)
      if (!replaced) {
        replaced = true
        renameSync(path, join(dir, 'old'))
        writeFileSync(path, 'Replacement private rule', { mode: 0o600 })
      }
      return count
    }
    syncBuiltinESMExports()
    assert.throws(() => start({ operatorInstructionsFile: path }), /unavailable or insecure/)
    assert.equal(replaced, true)
  } finally {
    fs.readSync = read
    syncBuiltinESMExports()
  }
})

test('turn budget reminders preserve the admitted messages and identify the last step', async (t) => {
  const { ctx } = start()
  t.after(() => ctx.dispose())
  const hook = ctx.listeners.get('agent/pre-step')[0]
  const signal = new AbortController().signal
  const original = { kind: 'enter', messages: [{ content: 'original' }] }
  const run = (id, step) => hook({ agent: { id }, step, signal }, async () => original)
  assert.equal(await run('worker', 24), original)
  const warning = await run('group-worker', 25)
  assert.equal(warning.messages[0], original.messages[0])
  assert.match(warning.messages[1].content[0].text, /step 25.*limit is 30/)
  const final = await run('worker', 30)
  assert.match(final.messages[1].content[0].text, /without starting another tool call/)
  assert.equal(await run('room', 30), original)
})

test('Bots get a scoped progress rule without changing the private/group prompt prefix', (t) => {
  const { ctx, prompt } = start()
  t.after(() => ctx.dispose())
  const rules = [
    '- Only for a direct user request in your own chat that needs several steps: write one short sentence of normal reply text before your first tool call, and make that tool call in the same response. Never start such a task with tools alone or end it with a promise. On long tasks, give brief factual updates only at meaningful milestones, then keep working.',
    '- For "[Message from …]" or "[Reply from …]" messages, do not write plans or progress updates: use tools silently, then reply with the answer. Simple answers do not need progress messages.',
    '- In a group chat, the group sees what you write while you work, not only your final reply. For work that takes more than a quick look, start with one short sentence on what you will do, in the same response as your first tool call. After that, write only when you find something the group should know or finish a part of the work, in a sentence or two, not at every step. End with the result. Simple answers need no updates.',
  ]
  for (const id of ['main', 'worker']) {
    for (const rule of rules) {
      assert.ok(prompt(id).split('\n').includes(rule))
      assert.equal(prompt(id).split(rule).length - 1, 1)
    }
  }
  assert.equal(prompt('group-worker'), prompt('worker'))
})

test('the group relay and non-Bot sessions do not get progress instructions', (t) => {
  const { ctx, prompt } = start()
  t.after(() => ctx.dispose())
  assert.match(prompt('room'), /end your turn with an empty reply/)
  assert.doesNotMatch(prompt('room'), /progress|milestone/)
  assert.equal(prompt('outside'), '')
})
