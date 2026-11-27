import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { test } from 'node:test'
import { createGateway } from '../../src/host/connectors/gateway.js'
import { createLinearProjectMcpSession } from '../../src/host/linear-project-mcp-session.mjs'

test('the existing connector gateway supplies auth while the watcher can only call listed Linear read tools', async () => {
  const allowed = ['list_issues', 'list_issue_statuses', 'get_issue']
  const called = []
  const methods = []
  const mock = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, 'Bearer test-upstream-credential')
    if (request.method !== 'POST') {
      response.writeHead(405).end()
      return
    }
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const rpc = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    methods.push(rpc.method)
    if (rpc.id === undefined) {
      response.writeHead(202).end()
      return
    }
    let result = {}
    if (rpc.method === 'initialize') result = { protocolVersion: rpc.params.protocolVersion, capabilities: { tools: {} },
      serverInfo: { name: 'Test connector', version: '1' } }
    if (rpc.method === 'tools/list') result = { tools: [...allowed, 'save_issue'].map(name => ({ name,
      inputSchema: { type: 'object' }, annotations: { readOnlyHint: allowed.includes(name) } })) }
    if (rpc.method === 'tools/call') {
      called.push(rpc.params.name)
      result = { content: [{ type: 'text', text: '{"issues":[],"hasNextPage":false}' }] }
    }
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }))
  })
  mock.listen(0, '127.0.0.1')
  await once(mock, 'listening')
  const gateway = createGateway({ credential: id => id === 'linear' ? {
    url: `http://127.0.0.1:${mock.address().port}/mcp`, headers: { authorization: 'Bearer test-upstream-credential' },
  } : undefined, readOnly: () => true, onUnauthorized: async () => false })
  const gatewayRw = createGateway({ credential: id => id === 'linear' ? {
    url: `http://127.0.0.1:${mock.address().port}/mcp`, headers: { authorization: 'Bearer test-upstream-credential' },
  } : undefined, readOnly: () => false, onUnauthorized: async () => false })
  await gateway.listen()
  await gatewayRw.listen()
  let granted = true
  const mcp = createLinearProjectMcpSession({ getGateway: async () => ({ url: gateway.urlFor('linear'), headers: gateway.headers() }),
    assertActive() { if (!granted) throw new Error('grant revoked') } })
  const rwReadOnlyGw = createLinearProjectMcpSession({ getGateway: async () => ({ url: gateway.urlFor('linear'), headers: gateway.headers() }),
    assertActive() { if (!granted) throw new Error('grant revoked') }, allowWrite: true })
  const rw = createLinearProjectMcpSession({ getGateway: async () => ({ url: gatewayRw.urlFor('linear'), headers: gatewayRw.headers() }),
    assertActive() { if (!granted) throw new Error('grant revoked') }, allowWrite: true })
  try {
    await assert.rejects(mcp.call('save_issue', {}), /outside read scope/)
    await assert.rejects(mcp.callWrite('save_issue', { id: 'i1', state: 'Done' }), /write disabled/)
    assert.deepEqual(await mcp.call('list_issues', { project: 'test' }), { issues: [], hasNextPage: false })
    assert.deepEqual(called, ['list_issues'])
    assert.ok(methods.includes('tools/list'))
    await assert.rejects(rwReadOnlyGw.callWrite('save_issue', { id: 'i1', state: 'In Progress' }), /Linear MCP unavailable/)
    await assert.rejects(rw.call('save_issue', { id: 'i1', state: 'Done' }), /outside read scope/)
    await assert.rejects(rw.callWrite('save_issue', { id: 'i1', state: 'Done', title: 'overwrite plan' }), /outside allowed fields/)
    await assert.rejects(rw.callWrite('create_issue', { title: 'new' }), /outside write scope/)
    assert.deepEqual(await rw.callWrite('save_issue', { id: 'i1', state: 'In Progress' }), { issues: [], hasNextPage: false })
    assert.equal(rw.hasWriteTool('save_issue'), true)
    granted = false
    await assert.rejects(mcp.call('list_issues', {}), /grant revoked/)
    assert.equal(called.length, 2)
  } finally {
    await rw.close()
    await rwReadOnlyGw.close()
    await mcp.close()
    await gatewayRw.close()
    await gateway.close()
    mock.close()
    mock.closeAllConnections()
  }
})

test('read calls reconnect once on stale session errors while write calls never auto-retry', async () => {
  const allowed = ['list_issues', 'list_issue_statuses', 'get_issue']
  let failNextToolCall = false
  let initializeCount = 0
  let callCount = 0
  const mock = createServer(async (request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(405).end()
      return
    }
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const rpc = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (rpc.id === undefined) {
      response.writeHead(202).end()
      return
    }
    let result = {}
    if (rpc.method === 'initialize') {
      initializeCount += 1
      result = { protocolVersion: rpc.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'Test connector', version: '1' } }
    } else if (rpc.method === 'tools/list') {
      result = { tools: [...allowed, 'save_issue'].map(name => ({ name, inputSchema: { type: 'object' }, annotations: { readOnlyHint: allowed.includes(name) } })) }
    } else if (rpc.method === 'tools/call') {
      callCount += 1
      if (failNextToolCall) {
        failNextToolCall = false
        response.writeHead(500, { 'content-type': 'text/plain' }).end('session expired')
        return
      }
      result = { content: [{ type: 'text', text: '{"issues":[],"hasNextPage":false}' }] }
    }
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }))
  })
  mock.listen(0, '127.0.0.1')
  await once(mock, 'listening')
  const gateway = createGateway({
    credential: id => id === 'linear' ? { url: `http://127.0.0.1:${mock.address().port}/mcp`, headers: { authorization: 'Bearer test-token' } } : undefined,
    readOnly: () => false,
    onUnauthorized: async () => false,
  })
  await gateway.listen()
  const session = createLinearProjectMcpSession({
    getGateway: async () => ({ url: gateway.urlFor('linear'), headers: gateway.headers() }),
    assertActive() {},
    allowWrite: true,
  })
  try {
    assert.deepEqual(await session.call('list_issues', {}), { issues: [], hasNextPage: false })
    assert.equal(initializeCount, 1)
    assert.equal(callCount, 1)

    // Reused session fails once -> closes, reconnects once, and read succeeds.
    failNextToolCall = true
    assert.deepEqual(await session.call('list_issues', {}), { issues: [], hasNextPage: false })
    assert.equal(initializeCount, 2)
    assert.equal(callCount, 3)

    // Reused session fails on write -> closes and surfaces unavailable without auto-retrying write.
    failNextToolCall = true
    await assert.rejects(session.callWrite('save_issue', { id: 'i1', state: 'Done' }), /Linear MCP unavailable/)
    assert.equal(callCount, 4)
  } finally {
    await session.close()
    await gateway.close()
    mock.close()
    mock.closeAllConnections()
  }
})

test('unexpected MCP errors preserve sanitized non-secret details while stripping secret-like strings', async () => {
  const cleanSession = createLinearProjectMcpSession({
    getGateway: async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:9999') },
    assertActive() {},
  })
  await assert.rejects(cleanSession.call('list_issues', {}), /Linear MCP unavailable \(connect ECONNREFUSED 127\.0\.0\.1:9999\)/)

  const leakySession = createLinearProjectMcpSession({
    getGateway: async () => { throw new Error('Authorization: Bearer lin_api_secret_token_value') },
    assertActive() {},
  })
  await assert.rejects(leakySession.call('list_issues', {}), err => err.message === 'Linear MCP unavailable')
})
