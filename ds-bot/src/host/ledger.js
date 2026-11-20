// The ledger: what is said in a conversation between Bots, kept by DS Bot itself. Each
// conversation has one book, a file that is only ever appended to, one record per line,
// oldest first. A record is written to its book before anything reads or delivers it; a
// change to it (delivered, answered) is a record of its own, so no line is rewritten.
//
//   <home>/ledger/<book>.jsonl
//
// A book is read whole the first time it is used and then kept in memory, so the
// readers that draw a conversation can stay synchronous. Writes go out in order, one
// queue per book. A window that only reads the team follows the file another host
// writes: it reads a book again when the file has grown.
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { appendFile, mkdir, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

const SEARCH_MAX = 20

// A file name for a book: readable when the id is plain, hashed when it is not.
export const bookFile = (book) => {
  const safe = /^[\w-]{1,160}$/.test(book) ? book : createHash('sha256').update(String(book)).digest('hex').slice(0, 32)
  return `${safe}.jsonl`
}

// Records oldest first. A line cut by an interruption is not a record.
export const parseBook = (text, invalid) => {
  const records = []
  for (const row of String(text ?? '').split('\n')) {
    if (row === '') continue
    try {
      const record = JSON.parse(row)
      if (record !== null && typeof record === 'object') records.push(record)
      else invalid?.()
    } catch { invalid?.() }
  }
  return records
}

export function install(rt) {
  const dir = join(rt.home, 'ledger')
  const pathOf = book => join(dir, bookFile(book))
  const writes = () => rt.readOnly?.() === undefined

  const books = new Map()
  /** @type {Map<string, Promise<unknown>>} */
  const writing = new Map()
  // A later append must not silently write past a missing earlier record.
  const writeFailures = new Map()
  const skippedWrites = new Set()
  const noteWriteFailure = (book, error) => {
    if (writeFailures.has(book)) return
    writeFailures.set(book, error)
    rt.warn('ds-bot: a record of %s was not written: %s', book, error?.message ?? error)
  }
  /** @type {Map<string, (book: string) => object[] | undefined>} */
  const importers = new Map()

  const seqOf = record => record.seq
  const identity = value => value
  const bound = (items, value, key, after = false) => {
    let lo = 0, hi = items.length
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2)
      const item = key(items[mid])
      if (item < value || (after && item === value)) lo = mid + 1
      else hi = mid
    }
    return lo
  }
  const addToIndex = (entry, record) => {
    if (Number.isInteger(record.seq)) {
      entry.bySeq.set(record.seq, record)
      const at = entry.sequenced.length
      // Ordinary books need no second sequence index. For an out-of-order
      // import retain physical positions so duplicate seqs still read in file order.
      if (!entry.positions && at && entry.sequenced[at - 1].seq > record.seq) {
        entry.positions = Array.from({ length: at }, (_, index) => index)
      }
      entry.sequenced.push(record)
      if (entry.positions) {
        const pos = bound(entry.positions, record.seq, index => entry.sequenced[index].seq, true)
        entry.positions.splice(pos, 0, at)
      }
      entry.lastSeq = Math.max(entry.lastSeq, record.seq)
    }
    if (record.event !== 'anchor') return
    if (!entry.byAnchor.has(record.id)) entry.byAnchor.set(record.id, entry.anchors.length)
    entry.anchors.push(record)
    const from = Number(record.from)
    if (Number.isNaN(from)) return
    const starts = entry.anchorStarts
    if (!starts.length || starts.at(-1) <= from) starts.push(from)
    else starts.splice(bound(starts, from, identity), 0, from)
  }
  const reindex = entry => {
    Object.assign(entry, { bySeq: new Map(), sequenced: [], positions: null, lastSeq: 0, anchors: [], byAnchor: new Map(), anchorStarts: [] })
    for (const record of entry.records) addToIndex(entry, record)
  }
  const diskKey = book => {
    try {
      const info = statSync(pathOf(book), { bigint: true })
      return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':')
    } catch { return '-' }
  }
  const versions = new Map()
  let serial = 0
  const changed = (book, reset = false) => {
    const current = versions.get(book)
    const version = ++serial
    versions.set(book, { epoch: reset ? version : current?.epoch ?? 0, version })
  }

  // The first use of a book reads it. A book that does not exist yet starts from what
  // an importer finds of its conversation from before the ledger (writing hosts only).
  function open(book) {
    const known = books.get(book)
    // A copy read while another host wrote is stale once this host writes.
    const reading = !writes()
    const disk = reading ? diskKey(book) : undefined
    if (known !== undefined && known.readOnly === reading && (!reading || disk === known.disk)) return known
    let text
    let readFailed = false
    try {
      text = readFileSync(pathOf(book), 'utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        readFailed = true
        noteWriteFailure(book, error)
      }
    }
    let size = text === undefined ? -1 : Buffer.byteLength(text)
    let complete = !readFailed
    let records = text === undefined ? [] : parseBook(text, () => { complete = false })
    if (text === undefined && !readFailed) {
      const prefix = book.slice(0, book.indexOf('-') + 1)
      const imported = importers.get(prefix)?.(book)
      if (imported !== undefined && imported.length > 0) {
        records = imported
        if (writes()) {
          try {
            mkdirSync(dir, { recursive: true })
            const temp = `${pathOf(book)}.${process.pid}.tmp`
            writeFileSync(temp, records.map(record => `${JSON.stringify(record)}\n`).join(''), 'utf8')
            renameSync(temp, pathOf(book))
            size = statSync(pathOf(book)).size
          } catch (error) {
            noteWriteFailure(book, error)
          }
        }
      }
    }
    // An interruption can leave the last line without its end; the next record starts on a
    // line of its own, or it would join the cut one and be lost with it.
    const entry = { records, complete, size, disk, readOnly: reading, torn: text !== undefined && text !== '' && !text.endsWith('\n') }
    reindex(entry)
    books.set(book, entry)
    return entry
  }

  // Appends a record: in memory at once, on disk in order.
  function append(book, record) {
    const entry = open(book)
    entry.records.push(record)
    addToIndex(entry, record)
    // A terminal recovery extends an already closed group range; invalidate its settled UI reads.
    changed(book, book.startsWith('group-') && record.completedRoomReply !== undefined)
    if (!writes()) { skippedWrites.add(book); return record }
    const line = `${entry.torn ? '\n' : ''}${JSON.stringify(record)}\n`
    entry.torn = false
    entry.size = Math.max(entry.size, 0) + Buffer.byteLength(line)
    const run = (writing.get(book) ?? Promise.resolve()).then(async () => {
      if (writeFailures.has(book)) throw writeFailures.get(book)
      if (skippedWrites.has(book)) throw new Error('The ledger has writes that were not persisted')
      await mkdir(dir, { recursive: true })
      await appendFile(pathOf(book), line, 'utf8')
    })
    writing.set(book, run.catch((error) => {
      noteWriteFailure(book, error)
      // Memory holds only what the disk has, so a record that did not land is written again
      // when it is sent again. Part of its line may have landed: the next one starts anew.
      if (books.get(book) !== entry) return
      const at = entry.records.indexOf(record)
      if (at !== -1) entry.records.splice(at, 1)
      reindex(entry)
      changed(book, true)
      entry.torn = true
    }))
    return record
  }

  // The queued writes completed; this does not imply an fsync durability barrier.
  const flush = async (book) => {
    if (book !== undefined) {
      await writing.get(book)
      if (writeFailures.has(book)) throw writeFailures.get(book)
      return
    }
    await Promise.all(writing.values())
    if (writeFailures.size > 0) throw new AggregateError([...writeFailures.values()], 'One or more ledger writes failed')
  }

  // A read-only append exists only in memory; regaining the lock does not make
  // that missing prefix durable. Only an explicit successful drop clears it.
  const flushRequired = async (book) => {
    await flush(book)
    if (!writes()) throw new Error('The ledger is read-only')
    if (book === undefined ? skippedWrites.size > 0 : skippedWrites.has(book)) {
      throw new Error('The ledger has writes that were not persisted')
    }
  }

  function drop(book) {
    books.delete(book)
    changed(book, true)
    if (!writes()) { skippedWrites.add(book); return }
    const run = (writing.get(book) ?? Promise.resolve()).then(async () => {
      await rm(pathOf(book), { force: true })
      writeFailures.delete(book)
      skippedWrites.delete(book)
    })
    writing.set(book, run.catch(error => noteWriteFailure(book, error)))
  }

  function range(book, from, to, after = false) {
    const { sequenced, positions } = open(book)
    from = Number(from)
    if (to !== undefined) to = Number(to)
    if (Number.isNaN(from) || Number.isNaN(to)) return []
    const items = positions ?? sequenced
    const key = positions ? index => sequenced[index].seq : seqOf
    const start = bound(items, from, key, after)
    const end = to === undefined ? items.length : bound(items, to, key, true)
    if (!positions) return items.slice(start, end)
    if (end - start === items.length) return sequenced.slice()
    return items.slice(start, end).sort((a, b) => a - b).map(index => sequenced[index])
  }

  const ledger = {
    open,
    append,
    flush,
    flushRequired,
    // A caller must not deliver when any earlier record is missing either.
    written: flushRequired,
    drop,
    records: book => open(book).records,
    record: (book, seq) => open(book).bySeq.get(seq),
    after: (book, since) => since === undefined ? open(book).records.slice() : range(book, since, undefined, true),
    range,
    lastSeq: book => open(book).lastSeq,
    nextAnchor: (book, from, id) => {
      const { byAnchor, anchors, anchorStarts } = open(book)
      const at = id === undefined ? undefined : byAnchor.get(id)
      if (at !== undefined) return anchors[at + 1]?.from
      return anchorStarts[bound(anchorStarts, from, identity, true)]
    },
    // Reading a roster never opens or imports a book. A read-only window
    // observes the actual writer's file, including same-size replacements.
    cursor: book => {
      const value = versions.get(book)
      const source = writes() ? 'w' : diskKey(book)
      return { epoch: source + ':' + (value?.epoch ?? 0), version: value?.version ?? 0 }
    },
    // Newest first: every word has to be in the record's text.
    search: (book, query, pick = record => record.text) => {
      const words = String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean)
      if (words.length === 0) return []
      return open(book).records.filter((record) => {
        const text = pick(record)
        return typeof text === 'string' && words.every(word => text.toLowerCase().includes(word))
      }).slice(-SEARCH_MAX).reverse()
    },
    // How a kind of book is started from what was kept before the ledger: `prefix`
    // is the start of its name, up to and with the first "-".
    importer: (prefix, read) => { importers.set(prefix, read) },
  }
  rt.ledger = ledger
  // What is still on its way to disk lands before the plugin goes.
  rt.ctx?.effect?.(() => () => flush(), 'ds-bot: ledger')
}
