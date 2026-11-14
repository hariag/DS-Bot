import { test } from 'node:test'
import assert from 'node:assert/strict'
import { install as installFeed } from '../../src/host/feed.js'
import { install as installMobile } from '../../src/host/mobile.js'
import { install as installIm } from '../../src/host/im/index.js'
import { userRedoIdentity } from '../../src/host/user-redo-journal.mjs'

// Exercise real DS Bot listeners with an intentionally incorrect ordinary-chat
// index. No network transports are started. This is one defensive boundary,
// not proof that all Harness projections or external-effect paths are safe.
test('reserved redo output does not enter chat feed, mobile notices or IM projection', () => {
  const { sessionId } = userRedoIdentity('bb5b1723-7063-4e3e-b27e-12f44dd0033d')
  const ordinary = 'ordinary-session', listeners = new Map(), events = [], projected = []
  const ctx = {
    on(name, callback) { const list = listeners.get(name) ?? []; list.push(callback); listeners.set(name, list) },
    effect() {},
  }
  const emit = (name, ...args) => { for (const fn of listeners.get(name) ?? []) fn(...args) }
  const bot = { id:'b', name:'Bot' }
  const rt = { ctx, home:'/test-only-never-opened', state:{ revision:1, exchangeTurns:{} },
    chatOwners:new Map([[ordinary, bot.id], [sessionId, bot.id]]),
    selfOf:() => undefined, botOf:id => id === bot.id ? bot : undefined, roomOf:() => undefined,
    onSaved:() => () => {}, onRoomLine:() => {}, onApproval:() => {},
    displayItems(id) { projected.push(id); return [{ kind:'bot', text:'hello' }] },
  }
  installFeed(rt)
  installMobile(rt)
  installIm(rt)
  const stop = rt.subscribeFeed((event, data) => events.push({ event, data }))
  const reply = { type:'assistant/message', data:{ turn:1, message:{ content:[{ type:'text', text:'secret' }] } } }
  emit('session/event', { id:sessionId }, reply)
  emit('agent/assistant-stream', { agent:{ id:sessionId }, frame:{ type:'start', turn:1, attemptId:'redo-a' } })
  emit('agent/assistant-stream', { agent:{ id:sessionId }, frame:{ type:'chunk', attemptId:'redo-a', chunk:{ type:'text-delta', text:'secret' } } })
  rt.cardShown(sessionId, 'question', 'secret')
  rt.approvalWaiting({ sessionId, botId:'b', tool:'secret' })
  assert.deepEqual(projected, [])
  assert.equal(events.filter(({ event }) => ['message', 'notice', 'stream'].includes(event)).length, 0)

  // Positive control proves the same real listeners still process a normal
  // indexed chat message, stream and mobile notice.
  emit('session/event', { id:ordinary }, reply)
  emit('agent/assistant-stream', { agent:{ id:ordinary }, frame:{ type:'start', turn:1, attemptId:'normal-a' } })
  emit('agent/assistant-stream', { agent:{ id:ordinary }, frame:{ type:'chunk', attemptId:'normal-a', chunk:{ type:'text-delta', text:'hello' } } })
  assert.equal(projected.filter(id => id === ordinary).length, 2)
  assert.ok(events.some(({ event }) => event === 'message'))
  assert.ok(events.some(({ event }) => event === 'notice'))
  assert.ok(events.some(({ event, data }) => event === 'stream' && data.text === 'hello'))
  stop()
})
