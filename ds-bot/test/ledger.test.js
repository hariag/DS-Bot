import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { install, bookFile, parseBook } from '../src/host/ledger.js'
import { relayRange } from '../src/shared/group-replies.js'

const host = (t, { home = mkdtempSync(join(tmpdir(), 'ds-bot-ledger-')), readOnly } = {}) => {
  const warnings = []
  const rt = { home, readOnly: () => readOnly?.(), warn: (...args) => warnings.push(args) }
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

test('failed writes are reported and later records never skip over the missing record', async (t) => {
  const { rt, home, file, warnings } = host(t)
  // A regular file in place of the ledger directory makes mkdir fail without
  // depending on permissions, even when the test runner is root.
  rt.ledger.open('group-r1')
  writeFileSync(join(home, 'ledger'), 'not a directory')
  rt.ledger.append('group-r1', { seq: 1, text: 'first' })
  rt.ledger.append('group-r1', { seq: 2, text: 'second' })
  await assert.rejects(rt.ledger.flush('group-r1'))
  assert.equal(warnings.length, 1)

  rmSync(join(home, 'ledger'))
  mkdirSync(join(home, 'ledger'))
  rt.ledger.append('group-r1', { seq: 3, text: 'third' })
  await assert.rejects(rt.ledger.flush('group-r1'))
  assert.equal(existsSync(file('group-r1')), false)

  // An unrelated book still writes, while a global flush reports the failure.
  rt.ledger.append('group-r2', { seq: 1, text: 'independent' })
  await rt.ledger.flush('group-r2')
  assert.deepEqual(parseBook(readFileSync(file('group-r2'), 'utf8')).map(record => record.text), ['independent'])
  await assert.rejects(rt.ledger.flush(), AggregateError)

  // Explicitly dropping a book discards its failed sequence and permits a new one.
  rt.ledger.drop('group-r1')
  await rt.ledger.flush('group-r1')
  rt.ledger.append('group-r1', { seq: 1, text: 'new book' })
  await rt.ledger.flush('group-r1')
  assert.deepEqual(parseBook(readFileSync(file('group-r1'), 'utf8')).map(record => record.text), ['new book'])
})

test('required flush refuses read-only writes even after the host becomes writable', async (t) => {
  let readOnly = 'another host owns the team'
  const { rt, file } = host(t, { readOnly: () => readOnly })
  rt.ledger.append('group-r1', { seq: 1, text: 'memory only' })
  await rt.ledger.flush('group-r1')
  await assert.rejects(rt.ledger.flushRequired('group-r1'), /read-only/)
  readOnly = undefined
  rt.ledger.append('group-r1', { seq: 2, text: 'must not skip the first' })
  await assert.rejects(rt.ledger.flushRequired('group-r1'), /not persisted/)
  assert.equal(existsSync(file('group-r1')), false)
  rt.ledger.drop('group-r1')
  await rt.ledger.flushRequired('group-r1')
  rt.ledger.append('group-r1', { seq: 1, text: 'new book' })
  await rt.ledger.flushRequired('group-r1')
  assert.deepEqual(parseBook(readFileSync(file('group-r1'), 'utf8')).map(record => record.text), ['new book'])
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

test('a failed ledger write blocks later deliveries and removes unwritten records from memory', async (t) => {
  const { rt, home } = host(t)
  rt.ledger.open('pair-a-b')
  writeFileSync(join(home, 'ledger'), 'not a directory')
  rt.ledger.append('pair-a-b', { id: 'x', text: 'hello' })
  rt.ledger.append('pair-a-b', { id: 'y', text: 'later' })
  await assert.rejects(rt.ledger.written('pair-a-b'))
  assert.deepEqual(rt.ledger.records('pair-a-b'), [])
  rmSync(join(home, 'ledger'))
  mkdirSync(join(home, 'ledger'))
  rt.ledger.append('pair-a-b', { id: 'z', text: 'retry' })
  await assert.rejects(rt.ledger.written('pair-a-b'))
  assert.deepEqual(rt.ledger.records('pair-a-b'), [])
  assert.equal(existsSync(join(home, 'ledger', 'pair-a-b.jsonl')), false)
})

test('written refuses an in-memory-only append even if the host becomes writable', async (t) => {
  let readOnly = 'another host owns the team'
  const { rt } = host(t, { readOnly: () => readOnly })
  rt.ledger.append('pair-a-b', { id: 'x', text: 'hello' })
  await assert.rejects(rt.ledger.written('pair-a-b'), /read-only/)
  readOnly = undefined
  await assert.rejects(rt.ledger.written('pair-a-b'), /not persisted/)
})

test('a failed import is not accepted as a persisted delivery record', async (t) => {
  const { rt, home } = host(t)
  rt.ledger.importer('pair-', () => {
    writeFileSync(join(home, 'ledger'), 'not a directory')
    return [{ id: 'x', text: 'old' }]
  })
  assert.equal(rt.ledger.records('pair-a-b')[0].id, 'x')
  await assert.rejects(rt.ledger.written('pair-a-b'))
})

test('an unreadable book is not replaced by an importer', async (t) => {
  const { rt, home } = host(t)
  writeFileSync(join(home, 'ledger'), 'not a directory')
  let imported = false
  rt.ledger.importer('pair-', () => { imported = true; return [{ id: 'x' }] })
  assert.deepEqual(rt.ledger.records('pair-a-b'), [])
  assert.equal(imported, false)
  await assert.rejects(rt.ledger.written('pair-a-b'))
  assert.equal(readFileSync(join(home, 'ledger'), 'utf8'), 'not a directory')
})
