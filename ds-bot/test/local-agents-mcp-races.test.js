import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { LoopbackMcp } from '../src/host/local-agents/mcp.js'

const deferred = () => {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

const call = (mcp, signal) => fetch(mcp.url, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${mcp.token}` },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'work' } }),
  signal,
})

const eventFrom = async response => {
  const body = await response.text()
  const events = body.split('\n').filter(line => line.startsWith('data: '))
  assert.equal(events.length, 1)
  return JSON.parse(events[0].slice(6))
}

test('MCP: failing a call and then receiving its result answers once', async t => {
  const started = deferred()
  const result = deferred()
  const mcp = new LoopbackMcp(() => [], () => { started.resolve(); return result.promise })
  t.after(() => mcp.close())
  await mcp.listen()
  const response = call(mcp)
  await started.promise
  mcp.failAll(new Error('session closed'))
  const event = await eventFrom(await response)
  assert.equal(event.result.isError, true)
  assert.equal(event.result.content[0].text, 'session closed')
  result.resolve({ text: 'late result' })
  await delay(25)
  assert.equal(mcp.calls.size, 0)
})

test('MCP: a disconnected client removes the call and ignores a late result', async t => {
  const started = deferred()
  const result = deferred()
  const controller = new AbortController()
  const mcp = new LoopbackMcp(() => [], () => { started.resolve(); return result.promise })
  t.after(() => mcp.close())
  await mcp.listen()
  const response = call(mcp, controller.signal).catch(error => error)
  await started.promise
  controller.abort()
  assert.equal((await response).name, 'AbortError')
  for (let i = 0; i < 100 && mcp.calls.size > 0; i += 1) await delay(10)
  assert.equal(mcp.calls.size, 0)
  result.resolve({ text: 'late result' })
  await delay(25)
})

test('MCP: a synchronous tool error returns an error and clears the call', async t => {
  const mcp = new LoopbackMcp(() => [], () => { throw new Error('tool failed') })
  t.after(() => mcp.close())
  await mcp.listen()
  const event = await eventFrom(await call(mcp))
  assert.equal(event.result.isError, true)
  assert.equal(event.result.content[0].text, 'tool failed')
  assert.equal(mcp.calls.size, 0)
})
