import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import { mountBrowserPlugin } from '../src/host/browser/mount.js'
import { toolDefs as refsTools } from '../src/host/browser/refs.js'

test('browser handoff and resume return valid DSH outputs and clear the Bot hold', async t => {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  t.after(async () => ctx.fiber.dispose())

  let hold = null
  const plugin = inner => mountBrowserPlugin(inner, {
    toolDefs: refsTools.filter(tool => ['browser_handoff', 'browser_resume', 'browser_screenshot'].includes(tool.name)),
    defineTool,
    keyOf: async () => 'bot-1',
    profileRoot: '/tmp/browser-profiles',
    headless: true,
    openSession: async ({ getHold, onHold }) => ({
      handoff(reason, note) {
        const safeNote = String(note ?? '').slice(0, 300)
        onHold({ by: 'bot', reason, note: safeNote })
        return `Waiting for the user (${reason}). ${safeNote || 'Ask them to take over.'} Call browser_resume when they have finished.`
      },
      resume() {
        if (getHold()?.by === 'user') throw new Error('The user has taken over this browser. Only the user can give it back.')
        onHold(null)
        return 'The browser is yours again.'
      },
      async shot() {
        return { text: 'Screenshot of https://example.com/.', image: 'AAAA' }
      },
      async close() {},
    }),
    getHold: () => hold,
    onHold: (botId, value) => { hold = value },
  })
  plugin.inject = ['tools']
  await ctx.plugin(plugin)

  const execute = (name, args) => ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId(name),
    name,
    arguments: args,
  })

  const handoff = await execute('browser_handoff', { reason: 'other', note: 'Please take over.' })
  assert.equal(handoff.isError, false, handoff.error?.message)
  assert.deepEqual(handoff.value, {
    text: 'Waiting for the user (other). Please take over. Call browser_resume when they have finished.',
  })
  assert.deepEqual(handoff.content, [{
    type: 'text',
    text: 'Waiting for the user (other). Please take over. Call browser_resume when they have finished.',
  }])
  assert.deepEqual(hold, { by: 'bot', reason: 'other', note: 'Please take over.' })

  const resume = await execute('browser_resume', {})
  assert.equal(resume.isError, false, resume.error?.message)
  assert.deepEqual(resume.value, { text: 'The browser is yours again.' })
  assert.deepEqual(resume.content, [{ type: 'text', text: 'The browser is yours again.' }])
  assert.equal(hold, null)

  const screenshot = await execute('browser_screenshot', {})
  assert.equal(screenshot.isError, false, screenshot.error?.message)
  assert.deepEqual(screenshot.value, { text: 'Screenshot of https://example.com/.', image: 'AAAA' })
  assert.deepEqual(screenshot.content, [
    { type: 'text', text: 'Screenshot of https://example.com/.' },
    { type: 'image', data: 'AAAA', mediaType: 'image/jpeg' },
  ])
})
