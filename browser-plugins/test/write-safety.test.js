import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { gateScope } from '../../ds-bot/src/host/browser/gate.js'
import { mountBrowserPlugin } from '../../ds-bot/src/host/browser/mount.js'
import { openBotBrowser } from '../../ds-bot/src/host/browser/session.js'
import { toolDefs as taskTools } from '../../ds-bot/src/host/browser/task.js'

const playwrightUrl = new URL('../node_modules/playwright/index.mjs', import.meta.url).href

function pageHtml() {
  return `
      <form method="post" action="/submit">
        <input name="message" aria-label="Post message">
        <button type="submit">Publish</button>
      </form>
      <form method="get" action="/filter">
        <input name="query" aria-label="Filter query">
        <button type="submit">Filter</button>
      </form>
      <a href="/link">Read link</a>
      <button type="button" onclick="document.querySelector('#status').textContent = 'Deleted'">Delete</button>
      <form method="post" action="/hang">
        <button type="submit">Publish delayed</button>
      </form>
      <p id="status"></p>
    `
}

async function fixtureServer() {
  const counters = { submit: 0, filter: 0, hang: 0 }
  const sockets = new Set()
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', `http://${request.headers.host}`).pathname
    const html = (title, body = '') => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      response.end(`<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`)
    }
    if (path === '/') {
      html('Write safety', pageHtml())
    } else if (path === '/submit' && request.method === 'POST') {
      counters.submit += 1
      request.resume()
      request.on('end', () => html('Submitted', '<p>Saved</p>'))
    } else if (path === '/filter') {
      counters.filter += 1
      html('Filtered', '<p>Filtered</p>')
    } else if (path === '/link') {
      html('Link target', '<p>Link opened</p>')
    } else if (path === '/hang' && request.method === 'POST') {
      counters.hang += 1
      request.resume()
      request.on('end', () => {
        response.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'content-length': '1000',
        })
        response.write('<!doctype html><html><body>Still waiting', () => request.socket.destroy())
      })
    } else {
      response.writeHead(404)
      response.end()
    }
  })
  server.on('connection', socket => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const url = `http://127.0.0.1:${address.port}/`
  return {
    url,
    counters,
    async close() {
      for (const socket of sockets) socket.destroy()
      await new Promise(resolve => server.close(resolve))
    },
  }
}

function findRef(snapshot, label) {
  const line = snapshot.split('\n').find(value => value.match(/"([^"]*)"/)?.[1] === label && /\[ref=e\d+\]/.test(value))
  const match = line?.match(/\[ref=(e\d+)\]/)
  assert.ok(match, `no snapshot ref for ${label}`)
  return match[1]
}

async function waitFor(check) {
  const deadline = Date.now() + 3_000
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('fixture did not observe the expected request')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

async function setup(t, actionTimeout = 500) {
  const fixture = await fixtureServer()
  let profileRoot
  let session
  t.after(async () => {
    await session?.close().catch(() => {})
    try {
      await fixture.close()
    } finally {
      if (profileRoot) await rm(profileRoot, { recursive: true, force: true })
    }
  })
  profileRoot = await mkdtemp(join(tmpdir(), 'browser-write-safety-'))
  session = await openBotBrowser({
    botId: `test-${process.pid}-${Date.now()}`,
    profileRoot,
    playwrightUrl,
    actionTimeout,
  })
  return { fixture, profileRoot, session }
}

test('GET forms and links are not gated; risky buttons are gated', async (t) => {
  const { fixture, session } = await setup(t)
  const actions = []
  const gate = action => { actions.push(action) }

  let snapshot = await session.open(fixture.url)
  await gateScope.run(gate, () => session.click(findRef(snapshot, 'Filter')))
  await waitFor(() => fixture.counters.filter === 1)
  assert.equal(actions.length, 0)

  snapshot = await session.open(fixture.url)
  await gateScope.run(gate, () => session.click(findRef(snapshot, 'Read link')))
  assert.equal(actions.length, 0)

  snapshot = await session.open(fixture.url)
  await gateScope.run(gate, () => session.click(findRef(snapshot, 'Delete')))
  assert.equal(actions.length, 1)
  assert.equal(actions[0].kind, 'delete')
  assert.equal(actions[0].label, 'Delete')
})

test('POST submit clicks are gated before the server receives them', async (t) => {
  const { fixture, session } = await setup(t)
  let allowed = true
  const actions = []
  const gate = action => {
    actions.push(action)
    if (!allowed) throw new Error('approval denied')
  }

  let snapshot = await session.open(fixture.url)
  await gateScope.run(gate, () => session.click(findRef(snapshot, 'Publish')))
  await waitFor(() => fixture.counters.submit === 1)
  assert.equal(actions.length, 1)
  assert.equal(actions[0].kind, 'submit')

  allowed = false
  snapshot = await session.open(fixture.url)
  await assert.rejects(
    gateScope.run(gate, () => session.click(findRef(snapshot, 'Publish'))),
    /approval denied/,
  )
  assert.equal(fixture.counters.submit, 1)
  assert.equal(actions.length, 2)

  snapshot = await session.open(fixture.url)
  await session.click(findRef(snapshot, 'Publish'))
  await waitFor(() => fixture.counters.submit === 2)
  assert.equal(actions.length, 2)
})

test('type with submit gates POST forms but not GET forms', async (t) => {
  const { fixture, session } = await setup(t)
  const actions = []
  const gate = action => { actions.push(action) }

  let snapshot = await session.open(fixture.url)
  await gateScope.run(gate, () => session.type(findRef(snapshot, 'Post message'), 'hello', true))
  await waitFor(() => fixture.counters.submit === 1)
  assert.equal(actions.length, 1)
  assert.equal(actions[0].kind, 'submit')

  snapshot = await session.open(fixture.url)
  await session.type(findRef(snapshot, 'Post message'), 'hello')
  await gateScope.run(gate, () => session.press('Enter'))
  await waitFor(() => fixture.counters.submit === 2)
  assert.equal(actions.length, 2)

  snapshot = await session.open(fixture.url)
  await gateScope.run(gate, () => session.type(findRef(snapshot, 'Filter query'), 'lamp', true))
  await waitFor(() => fixture.counters.filter === 1)
  assert.equal(actions.length, 2)
})

test('unknown POST results block repeats until the page is observed', { timeout: 15_000 }, async (t) => {
  const { fixture, session } = await setup(t, 300)
  const actions = []
  const gate = action => { actions.push(action) }
  const snapshot = await session.open(fixture.url)
  const ref = findRef(snapshot, 'Publish delayed')

  const result = await gateScope.run(gate, () => session.click(ref))
  assert.match(result, /was sent, but its result is unknown/)
  assert.match(result, /Do not repeat it/)
  assert.equal(fixture.counters.hang, 1)
  assert.equal(actions.length, 1)

  await assert.rejects(
    gateScope.run(gate, () => session.click(ref)),
    /An earlier "Publish delayed" action.*Do not repeat it unless the page shows it did not go through/,
  )
  assert.equal(fixture.counters.hang, 1)
  assert.equal(actions.length, 1)

  await session.snapshotText()
  await session.open(fixture.url)
  const nextSnapshot = await session.snapshotText()
  await gateScope.run(gate, () => session.click(findRef(nextSnapshot, 'Publish delayed')))
  assert.equal(actions.length, 2)
  assert.equal(fixture.counters.hang, 2)
})

test('browser_task driver tools inherit the outer authorization gate', async (t) => {
  const fixture = await fixtureServer()
  let profileRoot
  const registered = new Map()
  const disposers = []
  t.after(async () => {
    try {
      await Promise.all(disposers.map(dispose => dispose?.()))
    } finally {
      try {
        await fixture.close()
      } finally {
        if (profileRoot) await rm(profileRoot, { recursive: true, force: true })
      }
    }
  })
  profileRoot = await mkdtemp(join(tmpdir(), 'browser-write-task-'))
  const gateActions = []
  const ctx = {
    effect(effect) {
      disposers.push(effect())
    },
    tools: { register(tool) { registered.set(tool.name, tool) } },
  }
  let modelStep = 0
  const complete = async request => {
    modelStep += 1
    const message = (toolCalls = [], content = '') => ({
      choices: [{ message: { content, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) } }],
    })
    const call = (id, name, args) => ({
      id,
      function: { name, arguments: JSON.stringify(args) },
    })
    if (modelStep === 1) return message([call('open', 'browser_open', { url: fixture.url })])
    if (modelStep === 2) {
      const page = request.messages.filter(entry => entry.role === 'tool').at(-1).content
      return message([call('publish', 'browser_click', { ref: findRef(page, 'Publish') })])
    }
    return message([], 'Published')
  }

  mountBrowserPlugin(ctx, {
    toolDefs: taskTools,
    defineTool: spec => spec,
    keyOf: async exec => exec.botId,
    profileRoot,
    headless: true,
    playwrightUrl,
    actionTimeout: 500,
    complete,
    authorize: async (_exec, _botId, action) => { gateActions.push(action) },
  })
  const tool = registered.get('browser_task')
  const result = await tool.execute({ goal: 'publish a post' }, {
    botId: 'task-bot',
    name: 'browser_task',
  })

  assert.match(result.text, /Published/)
  assert.equal(gateActions.length, 1)
  assert.equal(gateActions[0].kind, 'submit')
  await waitFor(() => fixture.counters.submit === 1)
})
