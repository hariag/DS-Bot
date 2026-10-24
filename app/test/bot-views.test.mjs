import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { WebSocket } from 'ws'
import { BotViews } from '../src/bot-views.mjs'

function fixture() {
  const changes = []
  const handlers = new Map()
  const views = []
  class WebContents extends EventEmitter {
    constructor() {
      super()
      this.url = 'about:blank'
      this.debugger = Object.assign(new EventEmitter(), {
        attach() {},
        async sendCommand(method) {
          if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'frame-a', url: 'https://example.com/' } } }
          return { method }
        },
      })
    }
    getURL() { return this.url }
    getTitle() { return this.url }
    isLoading() { return false }
    canGoBack() { return false }
    canGoForward() { return false }
    isDestroyed() { return false }
    async loadURL(url) { this.url = url }
    async executeJavaScript(script) { return script }
    setWindowOpenHandler(handler) { this.windowOpenHandler = handler }
    close() {}
    focus() {}
  }
  class WebContentsView {
    constructor(options) {
      this.options = options
      this.webContents = new WebContents()
      views.push(this)
    }
    setBounds(bounds) { this.bounds = bounds }
    setVisible(visible) { this.visible = visible }
  }
  const guests = {
    storageFor(key) { return { partition: `persist:${key}` } },
    setDownloadHandler(key, handler) { handlers.set(key, handler) },
  }
  const window = { contentView: { addChildView() {} } }
  const manager = new BotViews({ window: () => window, WebContentsView, guests, origin: () => 'http://127.0.0.1:43117' , onChange: change => changes.push(change) })
  return { manager, handlers, views, changes }
}

function openSocket(url, options) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, options)
    socket.once('open', () => resolve(socket))
    socket.once('error', reject)
  })
}

function closed(socket) {
  return new Promise(resolve => {
    socket.on('error', () => {})
    socket.once('close', resolve)
  })
}

function request(socket, id, method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${method}`)), 1000)
    const onMessage = raw => {
      const message = JSON.parse(raw.toString())
      if (message.id !== id) return
      clearTimeout(timer)
      socket.off('message', onMessage)
      resolve(message)
    }
    socket.on('message', onMessage)
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
  })
}

test('CDP relay limits targets and created tabs to the token Bot', async t => {
  const { manager, views } = fixture()
  t.after(() => manager.dispose())
  manager.create('a')
  manager.create('b')
  const [a, b] = await Promise.all([manager.endpoint('a'), manager.endpoint('b')])
  const socketA = await openSocket(a)
  const socketB = await openSocket(b)
  t.after(() => { socketA.close(); socketB.close() })
  const targetsA = await request(socketA, 1, 'Target.getTargets')
  const targetsB = await request(socketB, 2, 'Target.getTargets')
  assert.equal(targetsA.result.targetInfos.length, 1)
  assert.equal(targetsA.result.targetInfos[0].browserContextId, 'bot:a')
  assert.equal(targetsB.result.targetInfos.length, 1)
  assert.equal(targetsB.result.targetInfos[0].browserContextId, 'bot:b')
  const rootInfo = await request(socketA, 3, 'Target.getTargetInfo')
  assert.equal(rootInfo.result.targetInfo.targetId, targetsA.result.targetInfos[0].targetId)
  const foreignInfo = await request(socketA, 4, 'Target.getTargetInfo', { targetId: targetsB.result.targetInfos[0].targetId })
  assert.equal(foreignInfo.error.message, 'Browser tab does not belong to this Bot')
  const attached = await request(socketA, 5, 'Target.attachToTarget', { targetId: targetsA.result.targetInfos[0].targetId, flatten: true })
  const sessionId = attached.result.sessionId
  const pageEnabled = await request(socketA, 6, 'Page.enable', {}, sessionId)
  assert.equal(pageEnabled.sessionId, sessionId)
  assert.deepEqual(pageEnabled.result, { method: 'Page.enable' })
  const frameTree = await request(socketA, 7, 'Page.getFrameTree', {}, sessionId)
  assert.equal(frameTree.result.frameTree.frame.id, targetsA.result.targetInfos[0].targetId)
  const created = await request(socketA, 8, 'Target.createTarget', { url: 'about:blank' })
  assert.equal(created.result.targetId, manager.sync('a')[1].tabId)
  assert.equal(manager.sync('a').length, 2)
  assert.equal(manager.sync('b').length, 1)
})

test('CDP relay rejects invalid paths and Origin headers', async t => {
  const { manager } = fixture()
  t.after(() => manager.dispose())
  const endpoint = await manager.endpoint('a')
  const valid = await openSocket(endpoint)
  t.after(() => valid.close())
  const originSocket = new WebSocket(endpoint, { headers: { Origin: 'https://example.com' } })
  await closed(originSocket)
  const badPath = new WebSocket(endpoint.replace(/\/devtools\/browser\/[^/]+$/u, '/invalid'))
  await closed(badPath)
})

test('CDP download behavior saves to the Bot path and emits download events', async t => {
  const { manager, handlers, views } = fixture()
  t.after(() => manager.dispose())
  const downloadPath = mkdtempSync(join(tmpdir(), 'bot-views-download-'))
  t.after(() => rmSync(downloadPath, { recursive: true, force: true }))
  const entry = manager.create('a')
  const socket = await openSocket(await manager.endpoint('a'))
  t.after(() => socket.close())
  const discovered = await request(socket, 1, 'Target.attachToTarget', { targetId: entry.tabId, flatten: true })
  assert.ok(discovered.result.sessionId)
  const sessionId = discovered.result.sessionId
  await request(socket, 2, 'Browser.setDownloadBehavior', { behavior: 'allow', downloadPath })
  const events = []
  let resolveEvents
  const eventsReady = new Promise(resolve => { resolveEvents = resolve })
  socket.on('message', raw => {
    const message = JSON.parse(raw.toString())
    if (message.method?.startsWith('Browser.download')) {
      events.push(message)
      if (events.length === 3) resolveEvents()
    }
  })
  const saved = []
  const item = Object.assign(new EventEmitter(), {
    setSavePath(path) { saved.push(path) },
    getURL() { return 'https://example.com/file' },
    getFilename() { return 'report.pdf' },
    getReceivedBytes() { return 3 },
    getTotalBytes() { return 3 },
  })
  const event = { preventDefault() { throw new Error('download was unexpectedly prevented') } }
  handlers.get('bot:a')(event, item, views[0].webContents)
  item.emit('updated', {}, 'progressing')
  item.emit('done', {}, 'completed')
  await Promise.race([eventsReady, new Promise((_, reject) => setTimeout(() => reject(new Error('download events were not relayed')), 1000))])
  assert.equal(saved.length, 1)
  assert.match(saved[0], new RegExp(`^${downloadPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[/\\\\]`, 'u'))
  assert.equal(events[0].params.suggestedFilename, 'report.pdf')
  assert.equal(events.some(message => message.method === 'Browser.downloadProgress' && message.params.state === 'completed'), true)
  assert.equal(sessionId.length > 0, true)
})
