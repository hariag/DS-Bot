import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createGroupRowsReader, groupReads } from '../src/client/group-reads.js'

test('overlapping cells share the read and newer cursors share one fresh follow-up', async () => {
  const reads = groupReads({})
  const first = Promise.withResolvers()
  let calls = 0
  const fetch = () => ++calls === 1 ? first.promise : 'new rows'
  const a = reads.read('room/range', 'old', fetch)
  assert.equal(reads.read('room/range', 'old', fetch), a)
  const b = reads.read('room/range', 'new', fetch)
  assert.equal(reads.read('room/range', 'newer', fetch), b)
  assert.equal(await reads.read('other room/range', 'old', () => 'separate'), 'separate')
  assert.equal(calls, 1)
  first.resolve('old rows')
  assert.equal(await a, 'old rows')
  assert.equal(await b, 'new rows')
  assert.equal(await reads.read('room/range', 'newer', fetch), 'new rows')
  assert.equal(calls, 2)
})

test('errors can retry the same cursor and caches belong to one host', async () => {
  const first = groupReads({}), next = groupReads({})
  assert.equal(await first.read('key', 'cursor', () => { throw Error('offline') }), null)
  assert.deepEqual(await first.read('key', 'cursor', () => []), [])
  first.settle('closed', { rows: [] })
  assert.equal(next.closed('closed'), undefined)
  assert.equal(await next.read('key', 'cursor', () => 'another host'), 'another host')
})

test('a feed pass shares bounded requests while preserving range order and room boundaries', async () => {
  const batches = []
  const read = createGroupRowsReader(async (path, body) => {
    assert.equal(path, 'group-rows')
    batches.push(body)
    return body.ranges.map(range => body.roomId + ':' + range.from)
  }, () => 3)
  const reads = [read('a', 10), read('b', 1), read('a', 11), read('a', 12), read('a', 13)]
  assert.deepEqual(await Promise.all(reads), ['a:10','b:1','a:11','a:12','a:13'])
  assert.deepEqual(batches.find(batch => batch.ranges.length === 3).ranges.map(item => item.from), [10,11,12])
  assert.equal(batches.length, 3)
})

test('old hosts keep single reads and unavailable batch results can be retried', async () => {
  const read = createGroupRowsReader(async (path, body) => body, () => undefined)
  assert.deepEqual(await read('a', 1, 5, 'x'), { roomId: 'a', from: 1, to: 5, anchor: 'x' })
  let calls = 0
  const retry = createGroupRowsReader(async () => {
    if (++calls === 1) throw new Error('offline')
    return calls === 2 ? [] : ['recovered']
  }, () => 4)
  assert.equal(await retry('a', 1), null)
  assert.equal(await retry('a', 1), null)
  assert.equal(await retry('a', 1), 'recovered')
})
