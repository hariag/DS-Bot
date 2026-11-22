import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { createQueueInspector } from '../src/host/queue-inspect.mjs'

const roster = () => ({
  bots: {
    a:{id:'a', sessionId:'current', segments:[{sessionId:'old'}], openParts:[{sessionId:'background', segments:[{sessionId:'older-background'}]}]},
    b:{id:'b', sessionId:'other'},
  },
  rooms: {
    r:{id:'r', name:'Room', sessionId:'root', parts:[{sessionId:'old-root'}], members:['a','b'],
      sessions:{a:'group-a',b:'group-b'}, segments:{a:[{sessionId:'old-group-a'}]}},
    s:{id:'s', name:'Elsewhere', members:['b'], sessions:{a:'former-member'}},
  },
})
const reading = () => ({ status:'ready', nextTurn:[], nextStep:[] })

test('private source discovery follows each thread and current group membership; room reads contain only posts', async () => {
  const state = roster(), seen = []
  const row = (role, kind = 'bot') => ({id:role, source:{kind,role,exchangeId:'ex-'+role,senderName:'Sender'}, content:[
    {type:'text',text:'x'.repeat(500)}, {type:'file',attachment:{name:'private file name'}},
  ]})
  const inspect = createQueueInspector({state,ctx:{}}, async (_ctx,id) => {
    seen.push(id)
    return {status:'ready',nextStep:[],nextTurn:[row('USER', 'user'),row('request'),row('post')]}
  })
  const privatePage = await inspect({ sessionId:'background' })
  assert.equal(privatePage.sources[0].sessionId, 'background')
  assert.equal(privatePage.total, 6)
  assert.equal(privatePage.nextCursor, null)
  assert.ok(Number.isSafeInteger(privatePage.readAt))
  assert.deepEqual(new Set(seen), new Set(['current','background','old','older-background','group-a','old-group-a']))
  assert.ok(privatePage.sources.find(s => s.sessionId === 'older-background').earlier)
  assert.equal(privatePage.sources[0].earlier, false)
  assert.deepEqual(privatePage.sources[0].rows.map(item => item.id), ['request','post'])
  assert.deepEqual(privatePage.sources[0].rows[0], {id:'request',messageId:'request',exchangeId:'ex-request',senderName:'Sender',text:'x'.repeat(400)+'…',attachments:1})
  seen.length = 0
  const roomPage = await inspect({sessionId:'old-root'})
  assert.deepEqual(new Set(seen), new Set(['root','old-root']))
  assert.ok(roomPage.sources.every(s => s.kind === 'post' && s.roomId === 'r' && s.roomName === 'Room' && s.rows.length === 1 && s.rows[0].id === 'post'))
  await assert.rejects(inspect({sessionId:'group-b'}), /uniquely owned/)
  await assert.rejects(inspect({sessionId:'not-in-roster'}), /uniquely owned/)
  await assert.rejects(inspect({sessionId:'current', source:'other'}), /displayed chat/)
})

test('ambiguous and unavailable sources are distinguishable from verified empty queues', async () => {
  const state = roster(), reads = []
  state.agents = {local:{id:'local',sessions:['old']}}
  const status = {background:'missing','older-background':'migration','group-a':'unavailable'}
  const inspect = createQueueInspector({state,ctx:{}}, async (_ctx,id) => {
    reads.push(id)
    if (id === 'old-group-a') throw new Error('read failed')
    return status[id] ? {status:status[id]} : reading()
  })
  const first = await inspect({sessionId:'current'})
  const byId = Object.fromEntries(first.sources.map(s => [s.sessionId,s.status]))
  assert.deepEqual(byId, {current:'ready',old:'ambiguous',background:'missing','older-background':'migration','group-a':'unavailable','old-group-a':'unavailable'})
  assert.ok(first.sources.every(s => s.rows.length === 0))
  assert.ok(!reads.includes('old'))
  await assert.rejects(inspect({sessionId:'old'}), /uniquely owned/)
  state.bots.a.private = true
  assert.ok((await inspect({sessionId:'current'})).sources.every(s => s.kind === 'private'))
})

test('the bounded cursor belongs to the shown Session and the same source identities', async () => {
  const state = roster()
  for (let i=0; i<12; i++) state.bots.a.segments.push({sessionId:'extra-'+i})
  const inspect = createQueueInspector({state,ctx:{}}, reading)
  const first = await inspect({sessionId:'current'})
  assert.ok(first.nextCursor)
  assert.equal(first.sources.length, 8)
  const second = await inspect({sessionId:'current', cursor:first.nextCursor})
  const third = await inspect({sessionId:'current', cursor:second.nextCursor})
  assert.equal(third.nextCursor, null)
  assert.equal(new Set([...first.sources,...second.sources,...third.sources].map(s => s.sessionId)).size, first.total)
  await assert.rejects(inspect({sessionId:'background', cursor:first.nextCursor}), /scope changed/)
  await assert.rejects(inspect({sessionId:'current', cursor:'bad'}), /scope changed/)
  await assert.rejects(inspect({sessionId:'current', cursor:first.nextCursor.replace(/^8\./, '16.')}), /scope changed/)
  state.rooms.r.members = ['b']
  await assert.rejects(inspect({sessionId:'current', cursor:first.nextCursor}), /scope changed/)
})

test('archived sources are ordered by recorded end time across both private and group conversations', async () => {
  const state = roster()
  state.bots.a.segments[0].endedAt = 1000
  state.bots.a.openParts[0].segments[0].endedAt = Date.now() + 3600000
  state.rooms.r.segments.a[0].endedAt = 2000
  state.rooms.r.parts[0].endedAt = 1500
  const inspect = createQueueInspector({state,ctx:{}}, reading)
  const page = await inspect({sessionId:'current'})
  assert.deepEqual(page.sources.filter(s => s.earlier).map(s => [s.sessionId, s.endedAt]), [
    ['old-group-a',2000], ['old',1000], ['older-background',undefined],
  ])
  assert.equal((await inspect({sessionId:'root'})).sources[1].endedAt, 1500)
})

test('concurrent inspections share three read slots and cancelling one reader leaves the other intact', async () => {
  const state = roster(), releases = [], calls = []
  let active = 0, peak = 0
  const inspect = createQueueInspector({state,ctx:{}}, async (_ctx,id,signal) => {
    calls.push(id)
    peak = Math.max(peak, ++active)
    await new Promise(resolve => releases.push(resolve))
    active--
    assert.equal(signal.aborted, false)
    return reading()
  })
  const first = new AbortController()
  const one = inspect({sessionId:'current'}, first.signal)
  const two = inspect({sessionId:'current'})
  assert.equal(calls.length,3)
  first.abort()
  await assert.rejects(one)
  while (releases.length) { for (const release of releases.splice(0)) release(); await setImmediate() }
  const result = await two
  assert.equal(calls.length,6)
  assert.equal(peak,3)
  assert.ok(result.sources.every(source => source.status === 'ready'))
})

test('changing membership during a read refuses the page and skips queued reads from the old scope', async () => {
  const state = roster(), releases = [], seen = []
  const inspect = createQueueInspector({state,ctx:{}}, async (_ctx,id) => {
    seen.push(id)
    await new Promise(resolve => releases.push(resolve))
    return reading()
  })
  const page = inspect({sessionId:'current'})
  assert.equal(seen.length,3)
  state.rooms.r.members = ['b']
  for (const release of releases.splice(0)) release()
  await assert.rejects(page, /scope changed/)
  await setImmediate()
  assert.equal(seen.length,3)
})
