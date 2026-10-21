import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../index.js'
import { fakeContext } from './fake-ctx.js'

const TEAM = {
  version: 1,
  mainBotId: 'm1',
  revision: 1,
  bots: {
    m1: { id: 'm1', sessionId: 'm1', name: 'Chief', role: 'Chief of Staff', lab: 'deepseek', instructions: '', createdAt: 1 },
    b2: { id: 'b2', sessionId: 'b2', name: 'Writer', role: '写作', instructions: '', createdAt: 2 },
  },
  rooms: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
}

function start(config) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-browser-plugin-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))
  const ctx = fakeContext()
  apply(ctx, { home, ...config })
  return {
    ctx,
    stop: () => {
      rmSync(home, { recursive: true, force: true })
    },
  }
}

test('no browser plugin is mounted unless one is selected for the team', (t) => {
  const { ctx, stop } = start({})
  t.after(stop)
  assert.equal(ctx.calls.includes('effect ds-bot: browser plugin'), false)
  assert.equal(ctx.registeredTools.has('browser_open'), false)
  assert.equal(ctx.registeredTools.has('browser_exec'), false)
  assert.equal(ctx.registeredTools.has('browser_task'), false)
})

test('the selected plugin is the same for every Bot, and profiles stay apart', async (t) => {
  const seen = []
  const { ctx, stop } = start({
    browserPlugin: 'refs',
    browserPluginApi: {
      id: 'refs',
      tools: [
        {
          name: 'browser_snapshot',
          description: 'Read the page',
          parameters: {},
          async execute(_args, toolCtx) {
            seen.push(toolCtx.botId)
            return toolCtx.profileDir
          },
        },
      ],
    },
  })
  t.after(stop)
  assert.ok(ctx.calls.includes('effect ds-bot: browser plugin'))
  const tool = ctx.registeredTools.get('browser_snapshot')
  const writer = await tool.execute({}, { agent: { id: 'b2' } })
  const chief = await tool.execute({}, { agent: { id: 'm1' } })
  assert.deepEqual(seen, ['b2', 'm1'])
  assert.match(writer, /browser-profiles\/b2$/)
  assert.match(chief, /browser-profiles\/m1$/)
  assert.equal(await tool.execute({}, { agent: { id: 'stranger' } }), 'Only Bots on the team have a browser.')
})

test('an unknown browser plugin is refused', () => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-browser-plugin-'))
  try {
    assert.throws(() => apply(fakeContext(), { home, browserPlugin: 'devtools' }), /Choose refs, script, task/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
