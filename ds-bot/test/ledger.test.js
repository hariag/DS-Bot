import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { install, bookFile, parseBook } from '../src/host/ledger.js'
import { writeManifestAtomic } from '../src/host/sqlite-shard-store.mjs'
import { relayRange } from '../src/shared/group-replies.js'

const host = (t, { home = mkdtempSync(join(tmpdir(), 'ds-bot-ledger-')), readOnly, config } = {}) => {
  const warnings = []
  const rt = { home, config, readOnly: () => readOnly?.(), warn: (...args) => warnings.push(args) }
  install(rt)
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))
  return { rt, home, warnings, file: book => join(home, 'ledger', bookFile(book)) }
}

test('a record is in memory at once and on disk in order, one line each', async (t) => {
  const { rt, file } = host(t)
  for (let seq = 1; seq <= 50; seq += 1) rt.ledger.append('group-r1', { seq, text: `line ${seq}` })
  assert.equal(rt.ledger.record('group-r1', 50).text, 'line 50')
  await rt.ledger.flush('group-r1')
  assert.deepEqual(parseBook(readFileSync(file('group-r1'), 'utf8')).map(record => record.seq), Array.from({ length: 50 }, (_, at) => at + 1))
})

test('reads by range, after a seq, and by words, newest first', (t) => {
  const { rt } = host(t)
  for (const [seq, text] of [[1, 'plan the launch'], [2, 'launch notes'], [3, 'lunch'], [4, 'Launch day']]) rt.ledger.append('group-r1', { seq, text })
  assert.deepEqual(rt.ledger.range('group-r1', 2, 3).map(record => record.seq), [2, 3])
  assert.deepEqual(rt.ledger.range('group-r1', 3).map(record => record.seq), [3, 4])
  assert.deepEqual(rt.ledger.after('group-r1', 2).map(record => record.seq), [3, 4])
  assert.deepEqual(rt.ledger.search('group-r1', 'launch').map(record => record.seq), [4, 2, 1])
  assert.equal(rt.ledger.lastSeq('group-r1'), 4)
})

test('range reads the same records as a scan, and anchors are found by id as the book grows', (t) => {
  const { rt } = host(t)
  const scan = (book, from, to) => rt.ledger.records(book).filter(record => Number.isInteger(record.seq) && record.seq >= from && (to === undefined || record.seq <= to))
  rt.ledger.append('group-r1', { event: 'anchor', id: 'a', from: 1 })
  for (const seq of [1, 2, 3]) rt.ledger.append('group-r1', { seq, text: `${seq}` })
  assert.equal(rt.ledger.anchorAt('group-r1', 'a'), 0)
  assert.equal(rt.ledger.anchorAt('group-r1', 'b'), -1)
  rt.ledger.append('group-r1', { event: 'anchor', id: 'b', from: 4 })
  rt.ledger.append('group-r1', { event: 'anchor', id: 'a', from: 9 })
  for (const seq of [4, 5]) rt.ledger.append('group-r1', { seq, text: `${seq}` })
  assert.equal(rt.ledger.anchorAt('group-r1', 'b'), 4)
  assert.equal(rt.ledger.anchorAt('group-r1', 'a'), 0)
  for (const [from, to] of [[1, 5], [2, 4], [0, undefined], [3.5, 9], [6, undefined], [5, 2], [Number.NaN, 3]]) {
    assert.deepEqual(rt.ledger.range('group-r1', from, to), scan('group-r1', from, to), `${from}..${to}`)
  }
  assert.deepEqual(rt.ledger.range('group-r2', 1, 3), [])

  // A seq out of order or twice: the same records a scan finds, duplicates included.
  for (const seq of [1, 3, 2, 3, 1000]) rt.ledger.append('group-r3', { seq })
  for (const [from, to] of [[1, 3], [2, undefined], [1, 1000]]) {
    assert.deepEqual(rt.ledger.range('group-r3', from, to), scan('group-r3', from, to))
  }
})

test('prepend moves the anchors it finds', (t) => {
  const { rt } = host(t)
  rt.ledger.append('group-r1', { seq: 3 })
  rt.ledger.append('group-r1', { event: 'anchor', id: 'a', from: 4 })
  assert.equal(rt.ledger.anchorAt('group-r1', 'a'), 1)
  rt.ledger.prepend('group-r1', [{ seq: 1 }, { seq: 2 }])
  assert.equal(rt.ledger.anchorAt('group-r1', 'a'), 3)
  assert.deepEqual(rt.ledger.range('group-r1', 1, 3).map(record => record.seq), [1, 2, 3])
})

test('a line cut by an interruption is left out, and the book goes on after it', async (t) => {
  const { rt, home, file } = host(t)
  mkdirSync(join(home, 'ledger'), { recursive: true })
  writeFileSync(file('group-r1'), `${JSON.stringify({ seq: 1, text: 'whole' })}\n{"seq":2,"text":"cu`)
  assert.deepEqual(rt.ledger.records('group-r1').map(record => record.seq), [1])
  rt.ledger.append('group-r1', { seq: 2, text: 'again' })
  await rt.ledger.flush('group-r1')
  const again = host(t, { home })
  assert.deepEqual(again.rt.ledger.records('group-r1').map(record => record.text), ['whole', 'again'])
})

test('a book that does not exist yet starts from its importer, once, and only a writing host keeps it', async (t) => {
  const { rt, home, file } = host(t)
  let asked = 0
  rt.ledger.importer('group-', () => { asked += 1; return [{ seq: 1, text: 'from before' }] })
  assert.deepEqual(rt.ledger.records('group-r1').map(record => record.text), ['from before'])
  assert.equal(existsSync(file('group-r1')), true)
  const reader = host(t, { home, readOnly: () => 'another dsh holds the team' })
  reader.rt.ledger.importer('group-', () => { asked += 1; return [{ seq: 1, text: 'from before' }] })
  assert.deepEqual(reader.rt.ledger.records('group-r1').map(record => record.text), ['from before'])
  assert.equal(asked, 1)
  const fresh = host(t, { readOnly: () => 'read only' })
  fresh.rt.ledger.importer('group-', () => [{ seq: 1, text: 'old' }])
  assert.equal(fresh.rt.ledger.records('group-r2').length, 1)
  assert.equal(existsSync(fresh.file('group-r2')), false)
})

test('a window that only reads follows the book another host writes', async (t) => {
  const writer = host(t)
  writer.rt.ledger.append('group-r1', { seq: 1, text: 'one' })
  await writer.rt.ledger.flush()
  const reader = host(t, { home: writer.home, readOnly: () => 'read only' })
  assert.equal(reader.rt.ledger.lastSeq('group-r1'), 1)
  writer.rt.ledger.append('group-r1', { seq: 2, text: 'two' })
  await writer.rt.ledger.flush()
  assert.equal(reader.rt.ledger.lastSeq('group-r1'), 2)
  // It writes nothing of its own.
  reader.rt.ledger.append('group-r1', { seq: 3, text: 'not kept' })
  await reader.rt.ledger.flush()
  assert.equal(parseBook(readFileSync(writer.file('group-r1'), 'utf8')).length, 2)
})

test('dropping a book removes its file after the writes before it', async (t) => {
  const { rt, file } = host(t)
  rt.ledger.append('group-r1', { seq: 1, text: 'one' })
  rt.ledger.drop('group-r1')
  await rt.ledger.flush('group-r1')
  assert.equal(existsSync(file('group-r1')), false)
  assert.deepEqual(rt.ledger.records('group-r1'), [])
})

test('a record that fails to write leaves an earlier one with the same seq in range', async (t) => {
  const { rt, file } = host(t)
  mkdirSync(join(file('group-r1'), '..'), { recursive: true })
  writeFileSync(file('group-r1'), `${JSON.stringify({ seq: 1, text: 'kept' })}
`)
  assert.deepEqual(rt.ledger.range('group-r1', 1, 1).map(record => record.text), ['kept'])
  // A folder where the file was makes the next append fail on every platform.
  rmSync(file('group-r1'))
  mkdirSync(file('group-r1'))
  rt.ledger.append('group-r1', { seq: 1, text: 'lost' })
  await rt.ledger.flush('group-r1')
  assert.deepEqual(rt.ledger.range('group-r1', 1, 1).map(record => record.text), ['kept'])
})

test('a book with an id that is not a plain name gets a file name of its own', () => {
  assert.equal(bookFile('group-r1'), 'group-r1.jsonl')
  assert.match(bookFile('group-../x'), /^[0-9a-f]{32}\.jsonl$/)
  assert.notEqual(bookFile('group-../x'), bookFile('group-../y'))
})

test("a round's result names its rows; a result from before the ledger does not", () => {
  assert.deepEqual(relayRange('{"from":3,"to":9,"passed":[]}'), { from: 3, to: 9 })
  assert.equal(relayRange('{"replies":[],"passed":[]}'), undefined)
  assert.equal(relayRange('{"replies":[{"botId":"a","text":"cu'), undefined)
})

// A window that only read a book takes over writing when the other host goes: what that
// host wrote meanwhile is read again before anything new is added.
test('a reader that takes over writing reads the book again first', async (t) => {
  const writer = host(t)
  writer.rt.ledger.append('group-r1', { seq: 1, text: 'one' })
  await writer.rt.ledger.flush()
  let reading = 'another dsh holds the team'
  const reader = host(t, { home: writer.home, readOnly: () => reading })
  assert.equal(reader.rt.ledger.lastSeq('group-r1'), 1)
  writer.rt.ledger.append('group-r1', { seq: 2, text: 'two' })
  await writer.rt.ledger.flush()
  reading = undefined
  reader.rt.ledger.append('group-r1', { seq: 3, text: 'three' })
  await reader.rt.ledger.flush()
  assert.deepEqual(reader.rt.ledger.records('group-r1').map(record => record.seq), [1, 2, 3])
  assert.deepEqual(parseBook(readFileSync(writer.file('group-r1'), 'utf8')).map(record => record.seq), [1, 2, 3])
})

test('a write that does not reach the disk is reported to whoever waits for it', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async (t) => {
  const { rt, home } = host(t)
  mkdirSync(join(home, 'ledger'), { recursive: true })
  chmodSync(join(home, 'ledger'), 0o500)
  try {
    rt.ledger.append('pair-a-b', { id: 'x', text: 'hello' })
    await assert.rejects(rt.ledger.written('pair-a-b'))
    // The queue goes on for the next record, and memory holds only what landed.
    await rt.ledger.flush('pair-a-b')
    assert.deepEqual(rt.ledger.records('pair-a-b'), [])
  } finally {
    chmodSync(join(home, 'ledger'), 0o700)
  }
  // Sent again, it is written again.
  rt.ledger.append('pair-a-b', { id: 'x', text: 'hello' })
  await rt.ledger.written('pair-a-b')
  assert.deepEqual(parseBook(readFileSync(join(home, 'ledger', 'pair-a-b.jsonl'), 'utf8')).map(record => record.id), ['x'])
})

test('prepend puts recovered records before existing ones and keeps concurrent appends in order', async (t) => {
  const writer = host(t)
  writer.rt.ledger.append('group-r1', { seq: 3, text: 'three' })
  writer.rt.ledger.append('group-r1', { seq: 4, text: 'four' })
  await writer.rt.ledger.flush('group-r1')

  const reader = host(t, { home: writer.home, readOnly: () => 'read only' })
  assert.deepEqual(reader.rt.ledger.records('group-r1').map(record => record.seq), [3, 4])

  // Prepend 1..2 and append 5 without awaiting between them.
  const added = writer.rt.ledger.prepend('group-r1', [{ seq: 2, text: 'two' }, { seq: 1, text: 'one' }, { seq: 3, text: 'dup' }])
  assert.equal(added, 2)
  writer.rt.ledger.append('group-r1', { seq: 5, text: 'five' })
  await writer.rt.ledger.flush('group-r1')

  assert.deepEqual(parseBook(readFileSync(writer.file('group-r1'), 'utf8')).map(record => [record.seq, record.text]), [
    [1, 'one'], [2, 'two'], [3, 'three'], [4, 'four'], [5, 'five'],
  ])
  assert.deepEqual(reader.rt.ledger.records('group-r1').map(record => record.seq), [1, 2, 3, 4, 5])
})

test('oversized ledger books compact older records into sealed SQLite shards and preserve every query API', async (t) => {
  const config = { ledgerMaxActiveBytes: 512, ledgerMaxActiveRecords: 20, ledgerKeepTailRecords: 5, ledgerMaxShardRows: 10 }
  const { rt, home, file } = host(t, { config })
  for (let seq = 5; seq <= 44; seq += 1) {
    if (seq === 15) rt.ledger.append('group-s1', { event: 'anchor', id: 'anc-1', from: 15, time: seq })
    if (seq === 35) rt.ledger.append('group-s1', { event: 'anchor', id: 'anc-2', from: 35, time: seq })
    rt.ledger.append('group-s1', {
      id: `msg-${seq}`,
      seq,
      botId: seq % 2 === 0 ? 'b1' : undefined,
      who: seq % 2 === 0 ? 'Coder' : 'User',
      text: seq % 5 === 0 ? `milestone launch item ${seq}` : `ordinary chatter ${seq}`,
      time: 1000 + seq,
    })
  }
  await rt.ledger.flush('group-s1')

  // Hot JSONL tail is bounded to keepTailRecords while shards hold sealed SQLite archives without -wal/-shm sidecars.
  const hotRows = parseBook(readFileSync(file('group-s1'), 'utf8'))
  assert.equal(hotRows.length, 5)
  const shardsDir = `${file('group-s1')}.shards`
  const shardEntries = readdirSync(shardsDir)
  assert.ok(shardEntries.includes('manifest.json'))
  assert.equal(shardEntries.filter(n => n.endsWith('-wal') || n.endsWith('-shm')).length, 0)
  assert.ok(shardEntries.filter(n => n.endsWith('.sqlite')).length >= 3)

  // Every query works across shards + hot tail identically from both fresh writer and read-only reader.
  const reader = host(t, { home, config, readOnly: () => 'read only' })
  for (const l of [rt.ledger, reader.rt.ledger]) {
    assert.equal(l.firstSeq('group-s1'), 5)
    assert.equal(l.lastSeq('group-s1'), 44)
    assert.equal(l.record('group-s1', 8)?.text, 'ordinary chatter 8')
    assert.equal(l.record('group-s1', 44)?.text, 'ordinary chatter 44')
    assert.equal(l.hasMessageId('group-s1', 'msg-6'), true)
    assert.equal(l.hasMessageId('group-s1', 'msg-999'), false)
    assert.deepEqual(l.range('group-s1', 14, 17).map(r => r.seq), [14, 15, 16, 17])
    assert.deepEqual(l.after('group-s1', 41).map(r => r.seq), [42, 43, 44])
    assert.equal(l.anchorAt('group-s1', 'anc-1'), 10)
    assert.equal(l.anchorAt('group-s1', 'anc-2'), 31)
    assert.equal(l.nextAnchorFrom('group-s1', 15, 'anc-1'), 34)
    assert.equal(l.nextAnchorFrom('group-s1', 35, 'anc-2'), undefined)
    assert.deepEqual(l.search('group-s1', 'milestone').map(r => r.seq), [40, 35, 30, 25, 20, 15, 10, 5])
    const grouped = l.searchGroup('group-s1', 'launch', {})
    assert.deepEqual(grouped.results.map(r => r.seq), [40, 35, 30, 25, 20, 15, 10, 5])
    assert.equal(grouped.results[0].before.seq, 39)
    assert.equal(grouped.results[0].after.seq, 41)
  }

  // Incremental tail append after rotation is seen by read-only reader without manifest rewrite.
  rt.ledger.append('group-s1', { id: 'msg-45', seq: 45, text: 'milestone launch item 45', time: 1045 })
  await rt.ledger.flush('group-s1')
  assert.equal(reader.rt.ledger.lastSeq('group-s1'), 45)
  assert.equal(reader.rt.ledger.search('group-s1', 'launch')[0].seq, 45)

  // Prepend on a sharded book creates an earlier shard without touching existing shards.
  const added = rt.ledger.prepend('group-s1', [{ seq: 3, text: 'early 3' }, { seq: 4, text: 'early 4' }, { seq: 5, text: 'dup 5' }])
  assert.equal(added, 2)
  await rt.ledger.flush('group-s1')
  assert.equal(rt.ledger.firstSeq('group-s1'), 3)
  assert.deepEqual(reader.rt.ledger.range('group-s1', 3, 6).map(r => r.seq), [3, 4, 5, 6])

  // Drop removes both hot file and shards directory.
  rt.ledger.drop('group-s1')
  await rt.ledger.flush('group-s1')
  assert.equal(existsSync(file('group-s1')), false)
  assert.equal(existsSync(shardsDir), false)
})

test('startup auto-compacts legacy oversized jsonl and recovers pendingTrim cleanly', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-ledger-legacy-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))
  const config = { ledgerMaxActiveBytes: 300, ledgerMaxActiveRecords: 12, ledgerKeepTailRecords: 4, ledgerMaxShardRows: 10 }
  const dir = join(home, 'ledger')
  mkdirSync(dir, { recursive: true })
  const bookPath = join(dir, 'group-legacy.jsonl')
  const rows = Array.from({ length: 20 }, (_, i) => ({ seq: i + 1, text: `legacy row ${i + 1}`, time: 100 + i }))
  writeFileSync(bookPath, rows.map(r => `${JSON.stringify(r)}\n`).join(''), 'utf8')

  const writer = host(t, { home, config })
  assert.equal(writer.rt.ledger.lastSeq('group-legacy'), 20)
  assert.equal(parseBook(readFileSync(bookPath, 'utf8')).length, 4)
  assert.equal(writer.rt.ledger.records('group-legacy').length, 20)

  // Simulate crash after pendingTrim recorded in manifest but before hot rename happened.
  const shardsDir = `${bookPath}.shards`
  const manifest = JSON.parse(readFileSync(join(shardsDir, 'manifest.json'), 'utf8'))
  const oldSt = statSync(bookPath)
  const untouched = [rows[16], rows[17], rows[18], rows[19], { seq: 21, text: 'tail survived crash', time: 121 }]
  writeFileSync(bookPath, untouched.map(r => `${JSON.stringify(r)}\n`).join(''), 'utf8')
  const crashedIno = statSync(bookPath).ino
  // Pretend first 2 lines of the current hot file were already compacted into shards and pendingTrim stayed active.
  writeManifestAtomic(shardsDir, { ...manifest, pendingTrim: { prefixLines: 2, oldInode: String(crashedIno || oldSt.ino) } })

  // Read-only host honors pendingTrim without mutating disk.
  const ro = host(t, { home, config, readOnly: () => 'read only' })
  assert.deepEqual(ro.rt.ledger.after('group-legacy', 18).map(r => r.seq), [19, 20, 21])

  // Writable host finishes trimming the prefix and clears pendingTrim.
  const recovered = host(t, { home, config })
  assert.deepEqual(recovered.rt.ledger.after('group-legacy', 18).map(r => r.seq), [19, 20, 21])
  assert.equal(JSON.parse(readFileSync(join(shardsDir, 'manifest.json'), 'utf8')).pendingTrim, null)
  assert.equal(parseBook(readFileSync(bookPath, 'utf8')).length, 3)
})
