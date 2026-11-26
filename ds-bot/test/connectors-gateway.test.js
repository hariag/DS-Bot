import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { createGateway } from '../src/host/connectors/gateway.js'

test('all gateway callers wait for the same bound port', async (t) => {
  const gateway = createGateway({ credential: () => undefined })
  t.after(() => gateway.close())
  const ports = await Promise.all(Array.from({ length: 12 }, async () => {
    await gateway.listen()
    return new URL(gateway.urlFor('linear')).port
  }))
  assert.match(ports[0], /^[1-9]\d+$/)
  assert.deepEqual(new Set(ports), new Set([ports[0]]))
  const response = await fetch(gateway.urlFor('linear'), { headers: gateway.headers(), signal: AbortSignal.timeout(1000) })
  assert.equal(response.status, 404)
  assert.deepEqual(await response.json(), { error: 'connector not connected' })
})

test('disposing a gateway aborts held streams and cannot publish a stale listener', async (t) => {
  let upstreamClosed
  const upstream = createServer((_req, res) => {
    upstreamClosed = once(res, 'close')
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: {}\n\n')
  })
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
  t.after(() => upstream.closeAllConnections())
  t.after(() => upstream.close())
  const gateway = createGateway({
    credential: () => ({ url: `http://127.0.0.1:${upstream.address().port}`, headers: {} }),
    readOnly: () => false,
    onUnauthorized: async () => false,
  })
  await gateway.listen()
  const url = gateway.urlFor('linear')
  const response = await fetch(url, { headers: gateway.headers(), signal: AbortSignal.timeout(1500) })
  assert.equal(response.status, 200)
  const reader = response.body.getReader()
  await reader.read()
  await gateway.close()
  await upstreamClosed
  await assert.rejects(reader.read())
  assert.equal(gateway.port, 0)
  await assert.rejects(gateway.listen(), /gateway is closed/)

  const starting = createGateway({ credential: () => undefined })
  await Promise.all([starting.listen(), starting.close()])
  assert.equal(starting.port, 0)
  await assert.rejects(starting.listen(), /gateway is closed/)
})

test('gateway forwards routing headers for modern MCP without bypassing read-only tool checks', async (t) => {
  const requests = []
  const upstream = createServer((req, res) => {
    requests.push(req.headers)
    req.resume()
    const discover = req.headers['mcp-method'] === 'server/discover'
    res.writeHead(discover ? 200 : 400, { 'content-type': 'application/json' })
    res.end('{}')
  })
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
  t.after(() => upstream.close())
  let limited = false
  const gateway = createGateway({
    credential: () => ({ url: `http://127.0.0.1:${upstream.address().port}`, headers: { Authorization: 'Bearer remote' } }),
    readOnly: () => limited,
    onUnauthorized: async () => false,
  })
  await gateway.listen()
  t.after(() => gateway.close())
  const call = (method, wireMethod = method) => fetch(gateway.urlFor('service'), {
    method: 'POST',
    headers: {
      ...gateway.headers(), 'content-type': 'application/json', 'mcp-protocol-version': '2026-07-28',
      'mcp-method': wireMethod, 'mcp-name': 'search', 'mcp-param-project': 'roadmap', 'x-local-key': 'local-only',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { name: 'search', arguments: { project: 'roadmap' } } }),
  })
  assert.deepEqual(await (await call('server/discover')).json(), {})
  assert.equal(requests[0]['mcp-method'], 'server/discover')
  assert.equal(requests[0]['mcp-protocol-version'], '2026-07-28')
  assert.equal(requests[0]['mcp-param-project'], undefined)
  assert.equal(requests[0].authorization, 'Bearer remote')
  assert.equal(requests[0]['x-local-key'], undefined)
  assert.deepEqual(await (await call('tools/call')).json(), {})
  assert.equal(requests[1]['mcp-name'], 'search')
  assert.equal(requests[1]['mcp-param-project'], 'roadmap')
  limited = true
  const mismatch = await call('tools/list', 'tools/call')
  assert.equal(mismatch.status, 400)
  assert.match((await mismatch.json()).error, /do not match/)
  assert.equal(requests.length, 2)
})

for (const refreshing of [false, true]) {
  test(`an upstream stream error cannot crash the engine${refreshing ? ' during refresh' : ''}`, () => {
    const script = `
      import assert from 'node:assert/strict'
      import { createServer } from 'node:http'
      import { createGateway } from ${JSON.stringify(new URL('../src/host/connectors/gateway.js', import.meta.url).href)}
      const upstream = createServer((req, res) => {
        res.writeHead(${refreshing ? 401 : 200}, { 'content-type': 'text/event-stream' })
        res.write('data: {}\\n\\n')
        setTimeout(() => res.destroy(), 10)
      })
      await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
      const gw = createGateway({
        credential: () => ({ url: 'http://127.0.0.1:' + upstream.address().port, headers: {} }),
        readOnly: () => false,
        onUnauthorized: async () => { await new Promise(resolve => setTimeout(resolve, 30)); return false },
      })
      await gw.listen()
      try {
        const response = await fetch(gw.urlFor('svc'), { headers: gw.headers(), signal: AbortSignal.timeout(1000) })
        ${refreshing ? `// Two legal timings for the destroy: inside the refresh the gateway
        // already saw the stream error and answers 502 itself; after it, the
        // 401 headers were already forwarded and the piped body then breaks.
        // Either way the engine must answer without hanging or crashing.
        if (response.status === 502) {
          assert.match(await response.text(), /connector upstream failed/)
        } else {
          assert.equal(response.status, 401)
          await assert.rejects(response.text(), error => error.name !== 'TimeoutError' && error.name !== 'AbortError')
        }` : "await assert.rejects(response.text(), error => error.name !== 'TimeoutError' && error.name !== 'AbortError')"}
      } finally { await gw.close(); await new Promise(resolve => upstream.close(resolve)) }
    `
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 5000 })
    assert.equal(result.status, 0, result.stderr || result.error?.message)
  })
}

for (const [limited, needsSignIn] of [[false, false], [false, true], [true, false], [true, true]]) {
  test(`a 401 with ${needsSignIn ? 'rejected authorization' : 'a transient refresh error'} returns actionable status${limited ? ' (read-only list)' : ''}`, async (t) => {
    let hits = 0
    const upstream = createServer((req, res) => {
      hits += 1
      req.resume()
      req.on('end', () => { res.writeHead(401, { 'www-authenticate': 'Bearer' }); res.end() })
    })
    await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
    t.after(() => upstream.close())
    let refreshes = 0
    const gw = createGateway({
      credential: () => ({ url: `http://127.0.0.1:${upstream.address().port}/mcp`, headers: {} }),
      readOnly: () => limited,
      onUnauthorized: async () => { refreshes += 1; return false },
      needsSignIn: () => needsSignIn,
    })
    await gw.listen()
    t.after(() => gw.close())
    const method = limited ? 'tools/list' : 'tools/call'
    const response = await fetch(gw.urlFor('notion'), {
      method: 'POST',
      headers: { ...gw.headers(), accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 7, method, params: { name: 'notion-search' } }),
    })
    const answer = await response.json()
    if (needsSignIn) {
      assert.equal(response.status, 200)
      assert.equal(answer.id, 7)
      assert.match(answer.error.message, /notion connector needs sign-in again.*request_connector/)
    } else {
      assert.equal(response.status, 503)
      assert.match(answer.error, /temporarily unavailable/)
    }
    assert.equal(refreshes, 1)
    assert.equal(hits, 1)
  })
}

test('gateway preserves MCP POST headers and bodies and reports expired sessions without replaying calls', async (t) => {
  const seen = []
  const upstream = createServer((req, res) => {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      seen.push({ headers: req.headers, body: Buffer.concat(chunks).toString(), url: req.url })
      res.writeHead(seen.length === 1 ? 200 : 404, {
        'content-type': seen.length === 1 ? 'text/event-stream' : 'application/json',
        'mcp-session-id': 'private-session',
      })
      res.end(seen.length === 1 ? 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{}}\n\n' : '{"error":"Session not found"}')
    })
  })
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
  t.after(() => upstream.close())
  const logs = []
  let refreshes = 0
  const gw = createGateway({
    credential: () => ({ url: `http://127.0.0.1:${upstream.address().port}/mcp?key=private-key`, headers: { Authorization: 'Bearer private-token' } }),
    readOnly: () => false,
    onUnauthorized: async () => { refreshes += 1; return false },
    log: (...args) => logs.push(args),
  })
  await gw.listen()
  t.after(() => gw.close())
  const headers = { ...gw.headers(), accept: 'application/json, text/event-stream', 'content-type': 'application/json', 'mcp-protocol-version': '2025-03-26' }
  const body = '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'
  const response = await fetch(gw.urlFor('notion'), { method: 'POST', headers, body })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('mcp-session-id'), 'private-session')
  assert.equal(response.headers.get('content-type'), 'text/event-stream')
  assert.match(await response.text(), /event: message/)
  assert.equal(seen[0].body, body)
  assert.equal(seen[0].headers.accept, headers.accept)
  assert.equal(seen[0].headers['mcp-protocol-version'], headers['mcp-protocol-version'])
  assert.equal(seen[0].headers.authorization, 'Bearer private-token')
  const expired = await fetch(gw.urlFor('notion'), {
    method: 'POST', headers: { ...headers, 'mcp-session-id': 'private-session' },
    body: '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"write"}}',
  })
  assert.equal(expired.status, 404)
  assert.equal((await expired.json()).error, 'Session not found')
  assert.equal(seen[1].headers['mcp-session-id'], 'private-session')
  assert.equal(seen.length, 2)
  assert.equal(refreshes, 0)
  assert.match(JSON.stringify(logs), /notion.*POST.*404/)
  assert.equal(JSON.stringify(logs).includes('private-'), false)
})
