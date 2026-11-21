import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { goalReviewGuard } from '../src/host/goals.js'

test('a later allow policy cannot bypass the real inspection tool guard', async t => {
  let NativeToolExecutor
  try {
    NativeToolExecutor = await import('@deepseek-ai/dsh-tool-executor-native')
  } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND' && error.message.includes('@deepseek-ai/dsh-tool-executor-native')) {
      t.skip('this DSH version does not include the native tool executor')
      return
    }
    throw error
  }
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
    assert.match(blocked.results[0].result.content[0].text, /delivery inspection/i)
    assert.match(blocked.results[0].result.content[0].text, /Allowed now: read, glob, grep/)
    assert.equal(writes, 0)
    const allowed = await call('ordinary-agent')
    assert.equal(allowed.results[0].result.isError, false)
    assert.equal(writes, 1)
  } finally {
    await ctx.fiber.dispose()
  }
})

test('inspection allows the evidence reads its prompt names and still refuses writes', () => {
  const live = new Map([['review-admin', { info: { reviewInspect: true, reviewId: 'review-1' } }]])
  const guard = goalReviewGuard(live, () => undefined, () => undefined, () => false)
  const call = name => guard({ agent: { id: 'review-admin' }, name, arguments: {} })
  assert.equal(call('read'), undefined)
  assert.equal(call('glob'), undefined)
  assert.equal(call('grep'), undefined)
  assert.match(call('write'), /delivery inspection/)
})
