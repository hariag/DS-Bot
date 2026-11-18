import assert from 'node:assert/strict'
import { test } from 'node:test'
import { groupReads } from '../src/client/group-reads.js'

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
