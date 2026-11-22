import {test} from 'node:test'
import assert from 'node:assert/strict'
import {inboxGroups, keepInboxPageOnRetry, stampInboxGroups} from '../src/client/inbox-groups.js'

const message = (id, exchangeId, text = id) => ({id, messageId:id, exchangeId, text})
const group = (key, rows, extra) => ({key, name:key, rows, partial:true, ...extra})
const source = (sessionId, rows, extra) => ({sessionId, kind:'private', earlier:false, status:'ready', rows, ...extra})
const page = (sources, extra, cursor = null) => ({
  cursor, page:{sources, readAt:1750, nextCursor:null, total:sources.length, ...extra},
})

test('a live Session always supersedes its sample, even after consumption', () => {
  const earlier = source('old', [message('old-1', 'relay')], {earlier:true, endedAt:1700})
  const sampled = [page([source('now', [message('consumed', 'retired')]), earlier])]
  const durable = {id:'live', content:[{type:'file', attachment:{attachmentId:'file'}}], source:{exchangeId:'relay'}}
  const current = {...message('live', 'relay'), sessionId:'now', row:durable, placement:'next-step', attachments:[{attachmentId:'file'}]}
  const [first] = inboxGroups([group('private', [current], {liveSessionIds:['now']})], sampled)
  assert.equal(first.count, 1)
  assert.equal(first.rows[0], current)
  assert.equal(first.sources[1].sampledCount, 1)
  assert.equal(first.sources[1].endedAt, 1700)
  assert.equal(first.sources[1].readAt, 1750)
  assert.ok(!('rows' in first.sources[1]))
  const [after] = inboxGroups([group('private', [], {liveSessionIds:['now']})], [page([sampled[0].page.sources[0]])])
  assert.deepEqual(after.rows, [])
  assert.equal(after.count, 0)
})

test('ready read replaces its own stale rows; failed and unvisited Sessions keep warm observations', () => {
  const warm = ['ready','failed','later'].map(sid => ({...message(sid), sessionId:sid}))
  const partial = page([source('ready', []), source('failed', [], {status:'migration'})], {nextCursor:'more', total:3})
  const [g] = inboxGroups([group('private', warm)], [partial])
  assert.deepEqual(g.rows.map(row => row.id), ['failed','later'])
  assert.equal(g.count, null)
  assert.equal(g.knownCount, 2)
  assert.equal(g.sources[0].sampledCount, 0)
  assert.equal(g.sources[1].sampledCount, undefined)
  const [empty] = inboxGroups([group('private', [])], [partial])
  assert.equal(empty.knownCount, 0)
  assert.equal(empty.count, null)
})

test('separate rooms with the same name and exchange retain independent counts', () => {
  const room = (sid, roomId) => source(sid, [message('shared','exchange')], {kind:'group', roomId, roomName:'QA'})
  const groups = inboxGroups([], [page([room('a','alpha'), room('b','beta')])])
  assert.deepEqual(groups.map(({key, name, count}) => [key,name,count]), [['alpha','QA',1], ['beta','QA',1]])
})

test('only a contiguous, complete paging scope resolves unknown totals', () => {
  const first = page([source('a', [])], {total:2, nextCursor:'more'})
  const second = page([source('b', [])], {total:2, readAt:1800}, 'more')
  const base = [group('private', [])]
  assert.equal(inboxGroups(base, [first])[0].count, null)
  assert.equal(inboxGroups(base, [first, {...second, cursor:'wrong'}])[0].count, null)
  assert.equal(inboxGroups(base, [first, {...second, page:{...second.page, total:3}}])[0].count, null)
  assert.equal(inboxGroups(base, [first, page([source('a', [])], {total:2}, 'more')])[0].count, null)
  const [full] = inboxGroups(base, [first, second])
  assert.equal(full.count, 0)
  assert.deepEqual(full.sources.map(s => s.readAt), [1750, 1800])
  assert.equal(inboxGroups([group('private', [], {partial:false})], [first])[0].count, 0)
})

test('old host row with unknown Session matches unique sampled message or exchange within its group', () => {
  const warm = [{id:'one', text:'host-1'}, {id:'exchange-two', text:'host-2'}, {id:'queued', text:'unread part'}]
  const partial = page([source('one-sid', [message('one', 'exchange-one'), message('two', 'exchange-two')])], {total:2, nextCursor:'more'})
  const [g] = inboxGroups([group('private', warm)], [partial])
  assert.deepEqual(g.rows.map(row => row.id), ['one','two','queued'])
  assert.equal(g.count, null)
  const [complete] = inboxGroups([group('private', warm)], [partial, page([source('new', [])], {total:2}, 'more')])
  assert.deepEqual(complete.rows.map(row => row.id), ['one','two'])
  assert.equal(complete.count, 2)
})

test('same message ID from two Sessions does not prove they are the same delivery', () => {
  const rows = [source('first', [message('same','one','same text')]), source('second', [message('same','two','same text')])]
  const [g] = inboxGroups([group('private', [{id:'same'}])], [page(rows, {nextCursor:'more', total:3})])
  assert.equal(g.knownCount, 3)
  assert.equal(g.count, null)
  const [full] = inboxGroups([], [page(rows)])
  assert.equal(full.count, 2)
})

test('duplicate message IDs within a Session and equal exchange IDs across Sessions match', () => {
  const [g] = inboxGroups([], [page([
    source('first', [message('a','one'), message('a','one'), message('b','two')]),
    source('second', [message('other','one'), message('c','three')]),
  ])])
  assert.deepEqual(g.rows.map(r => r.id), ['a','b','c'])
  assert.equal(g.count, 3)
})

test('a failed sample alone cannot establish an exact zero; a complete live projection can', () => {
  const sample = [page([source('only', [], {status:'unavailable'})])]
  assert.equal(inboxGroups([], sample)[0].count, null)
  assert.equal(inboxGroups([group('private', [], {liveSessionIds:['only']})], sample)[0].count, 0)
})

test('room roots group by room id and keep separately addressed rows in one Session', () => {
  const [g] = inboxGroups([], [page([source('root', [message('one','shared'), message('two','shared')], {roomId:'room-a', kind:'post', roomName:'Release'})])])
  assert.equal(g.key, 'room-a')
  assert.equal(g.count, 2)
})

test('repeated unlocated IDs cannot both be attributed to one warm/cold match', () => {
  const live = [group('private', [{id:'x'}, {id:'x'}], {partial:false})]
  const known = page([source('part', [message('x','delivery')])], {total:2, nextCursor:'more'})
  const [partial] = inboxGroups(live, [known])
  assert.equal(partial.knownCount, 2)
  assert.equal(partial.count, null)
  assert.equal(inboxGroups(live, [])[0].count, null)
  assert.equal(inboxGroups(live, [page(known.page.sources)])[0].count, 1)
})

test('legacy ID match with conflicting known exchanges keeps both observations', () => {
  const [g] = inboxGroups([group('private', [{id:'one', exchangeId:'different'}], {partial:false})],
    [page([source('part', [message('one','first')])], {nextCursor:'more', total:2})])
  assert.equal(g.knownCount, 2)
  assert.equal(g.count, null)
})

test('missing cross-part exchange identity precludes a precise logical count', () => {
  const [g] = inboxGroups([], [page([source('one', [message('one')]), source('two', [message('two')])])])
  assert.equal(g.knownCount, 2)
  assert.equal(g.count, null)
})

test('retries retain last successful observations and time across repeated read failures', () => {
  const prior = page([source('cold', [message('before','relay')], {earlier:true})]).page
  const failure = time => page([source('cold', [], {earlier:true, status:'unavailable'})], {readAt:time}).page
  const first = keepInboxPageOnRetry(prior, failure(2000))
  const retry = keepInboxPageOnRetry(first, failure(3000))
  const [g] = inboxGroups([group('private', [])], [{page:retry}])
  assert.equal(g.sources[0].status, 'unavailable')
  assert.equal(g.sources[0].readAt, 3000)
  assert.equal(g.sources[0].sampledCount, undefined)
  assert.equal(g.sources[0].rowsReadAt, 1750)
  assert.equal(g.rows[0].readAt, 1750)
  assert.equal(g.rows[0].text, 'before')
  assert.equal(g.count, null)
  const [current] = inboxGroups([group('private', [], {liveSessionIds:['cold']})], [{page:retry}])
  assert.equal(current.count, 0)
  const empty = page([source('cold', [], {earlier:true})], {readAt:4000}).page
  const recovered = keepInboxPageOnRetry(retry, empty)
  assert.deepEqual(recovered, empty)
  assert.equal(inboxGroups([], [{page:recovered}])[0].count, 0)
})

test('retry observations never carry over to another roster range or ambiguous source', () => {
  const from = page([source('cold', [message('private','x')])]).page
  const failed = page([source('cold', [], {status:'unavailable'})]).page
  for (const changed of [
    {...failed, total:2}, {...failed, nextCursor:'elsewhere'},
    page([source('other', [], {status:'unavailable'})]).page,
    page([source('cold', [], {status:'unavailable', kind:'group', roomId:'room'})]).page,
    page([source('cold', [], {status:'ambiguous'})]).page,
  ]) assert.deepEqual(keepInboxPageOnRetry(from, changed), changed)
})

test('ambiguous exchange spanning rotations never collapses separately addressed rows in the later Session', () => {
  const first = source('first', [message('a','exchange')])
  const second = source('second', [message('b','exchange'), message('c','exchange')])
  for (const sources of [[first, second], [second, first]]) {
    const [g] = inboxGroups([], [page(sources)])
    assert.deepEqual(g.rows.map(row => row.id).sort(), ['a','b','c'])
    assert.equal(g.count, null)
  }
})

test('legacy group and background private mail arriving after a complete read remains visible', () => {
  for (const key of ['private','room']) {
    const kind = key === 'private' ? 'private' : 'group'
    const old = {id:'prior', text:'already consumed'}
    const before = [group(key, [old])]
    const read = {...page([source('cold', [], {kind, roomId:key})]), liveGroups:before}
    const current = group(key, [old, {id:'new', text:'just arrived'}])
    const [g] = inboxGroups([current], [read])
    assert.deepEqual(g.rows.map(r => r.id), ['new'])
    assert.equal(g.count, 1)
  }
})

test('a complete later aggregate supersedes previously sampled mail after consumption', () => {
  const old = {id:'prior', text:'was queued'}
  const before = [group('private', [old], {partial:false})]
  const read = {...page([source('cold', [message('prior','relay')])]), liveGroups:before}
  assert.equal(inboxGroups(before, [read])[0].count, 1)
  const [now] = inboxGroups([group('private', [{id:'new', text:'live'}], {partial:false})], [read])
  assert.deepEqual(now.rows.map(row => row.id), ['new'])
  assert.equal(now.count, 1)
})

test('a legacy arrival between page reads survives when the first source may own it', () => {
  const before = [group('private', [])]
  const after = [group('private', [{id:'between'}])]
  const part = source('one', [])
  const first = {...page([part], {total:2, nextCursor:'more'}), liveGroups:before}
  const last = {...page([source('two', [])], {total:2}, 'more'), liveGroups:after}
  assert.deepEqual(inboxGroups(after, [first, last])[0].rows.map(r => r.id), ['between'])
})

test('a new warm row with a known session survives an earlier successful cold read', () => {
  const before = [group('private', [{...message('old','a'), sessionId:'part'}])]
  const read = {...page([source('part', [])]), liveGroups:before}
  const after = [group('private', [...before[0].rows, {...message('next','b'), sessionId:'part'}])]
  assert.deepEqual(inboxGroups(after, [read])[0].rows.map(r => r.id), ['next'])
})

test('failed inspection overrides a complete aggregate unless the failed Session is explicitly live', () => {
  const groupState = group('private', [], {partial:false})
  const failed = {...page([source('cold', [], {status:'missing'})]), liveGroups:[groupState]}
  assert.equal(inboxGroups([groupState], [failed])[0].count, null)
  assert.equal(inboxGroups([{...groupState, liveSessionIds:['cold']}], [failed])[0].count, 0)
})

test('live revisions distinguish a complete host that returned to its old empty state after consumption', () => {
  const before = [group('private', [], {partial:false, liveRevision:3})]
  const read = {...page([source('cold', [message('in-flight','x')])]), liveGroups:before}
  assert.equal(inboxGroups(before, [read])[0].count, 1)
  const during = [group('private', [{id:'in-flight'}], {partial:false, liveRevision:4})]
  assert.equal(inboxGroups(during, [read])[0].count, 1)
  const after = [group('private', [], {partial:false, liveRevision:5})]
  assert.equal(inboxGroups(after, [read])[0].count, 0)
})

test('committed per-group revisions capture empty → pending → empty without affecting another room', () => {
  const open = (...rows) => group('private', rows, {partial:false, liveSessionIds:['main']})
  const room = (...rows) => group('room', rows, {partial:false})
  const initial = stampInboxGroups([open(), room()])
  const snapshot = {...page([source('background', [message('in-flight','x')])]), liveGroups:initial}
  const pending = stampInboxGroups([open({id:'in-flight'}), room()], initial)
  const consumed = stampInboxGroups([open(), room()], pending)
  assert.deepEqual(initial.map(g => g.liveRevision), [1,1])
  assert.deepEqual(pending.map(g => g.liveRevision), [2,1])
  assert.deepEqual(consumed.map(g => g.liveRevision), [3,1])
  assert.equal(inboxGroups(consumed, [snapshot])[0].count, 0)
})

test('reorder, presentation, and immutable rerender keep a stamp; identity multiplicity and coverage change it', () => {
  const before = group('room', [{id:'a'}, {id:'b'}], {
    name:'before', partial:false, liveSessionIds:['one','two'], sources:[{sessionId:'old', status:'ready'}],
  })
  const [first] = stampInboxGroups([before])
  const presentation = {...before, name:'after', rows:[{id:'b', text:'new preview'}, {id:'a', senderName:'display name'}],
    sources:[{sessionId:'old', status:'ready', readAt:42}], liveSessionIds:['two','one']}
  const [same] = stampInboxGroups([presentation], [first])
  assert.equal(same.liveRevision, first.liveRevision)
  assert.equal(same.rows[0].text, 'new preview')
  for (const changed of [
    {...presentation, rows:[{id:'b'}, {id:'a'}, {id:'a'}]},
    {...presentation, rows:[{id:'b'}, {id:'c'}]},
    {...presentation, rows:[{id:'b'}, {id:'a',sessionId:'other'}]},
    {...presentation, partial:true}, {...presentation, liveSessionIds:['two']},
    {...presentation, sources:[{sessionId:'old', status:'unavailable'}]},
  ]) assert.equal(stampInboxGroups([changed], [same])[0].liveRevision, first.liveRevision + 1)
})
