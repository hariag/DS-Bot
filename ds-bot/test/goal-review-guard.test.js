import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { goalReviewGuard } from '../src/host/goals.js'

test('a later allow policy cannot bypass the real inspection tool guard', async () => {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  const live = new Map([['review-admin', { info: { reviewInspect: true, reviewId: 'review-1' } }]])
  let writes = 0
  try {
    ctx.tools.guard(goalReviewGuard(live))
    ctx.on('tools/pre-execute', () => Promise.resolve({ kind: 'allow' }), { prepend: true })
    ctx.tools.register({
      name: 'write_fixture', description: 'test write guard',
      parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: async () => { writes += 1; return 'wrote' },
    })
    const call = async id => ctx.tools.execute({
      agent: { id }, signal: AbortSignal.timeout(5000),
      calls: [{ type: 'tool-call', id: `call-${id}`, name: 'write_fixture', arguments: '{}' }],
    })
    const blocked = await call('review-admin')
    assert.equal(blocked.results[0].result.isError, true)
    assert.match(blocked.results[0].result.content[0].text, /inspection only/)
    assert.equal(writes, 0)
    const allowed = await call('ordinary-agent')
    assert.equal(allowed.results[0].result.isError, false)
    assert.equal(writes, 1)
  } finally {
    await ctx.fiber.dispose()
  }
})
