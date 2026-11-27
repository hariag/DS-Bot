// The ledger: what is said in a conversation between Bots, kept by DS Bot itself. Each
// conversation has one book: a hot JSONL tail (`<home>/ledger/<book>.jsonl`) backed by
// bounded SQLite shards (`<home>/ledger/<book>.jsonl.shards/`). A record is written in order;
// updates (delivered, answered) append a record of their own, so historical lines stay immutable.
import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { appendFile, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { searchTextFor } from './search-text.js'
import {
  compactRecordsToShards,
  createShardPool,
  manifestStamp,
  prependRecordsToShards,
  recoverPendingTrim,
  scanJsonLines,
  sliceAfterLines,
} from './sqlite-shard-store.mjs'

const SEARCH_MAX = 20
const GROUP_SEARCH_MAX = 20
const GROUP_TERMS_MAX = 8
const GROUP_QUERY_MAX = 200
const DEFAULT_MAX_ACTIVE_BYTES = 4 * 1024 * 1024
const DEFAULT_MAX_ACTIVE_RECORDS = 2_000
const DEFAULT_MAX_SHARD_BYTES = 16 * 1024 * 1024
const DEFAULT_MAX_SHARD_ROWS = 10_000

const LEDGER_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS records (
  idx INTEGER PRIMARY KEY AUTOINCREMENT,
  seq INTEGER,
  event TEXT,
  record_id TEXT,
  anchor_id TEXT,
  anchor_from INTEGER,
  time INTEGER,
  text_lower TEXT,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_records_seq ON records(seq);
CREATE INDEX IF NOT EXISTS idx_records_anchor ON records(anchor_id) WHERE anchor_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_records_record_id ON records(record_id) WHERE record_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_records_time ON records(time);
`

// A file name for a book: readable when the id is plain, hashed when it is not.
export const bookFile = (book) => {
  const safe = /^[\w-]{1,160}$/.test(book) ? book : createHash('sha256').update(String(book)).digest('hex').slice(0, 32)
  return `${safe}.jsonl`
}

// Records oldest first. A line cut by an interruption is not a record.
export const parseBook = (text) => {
  const records = []
  for (const row of String(text ?? '').split('\n')) {
    if (row === '') continue
    try {
      const record = JSON.parse(row)
      if (record !== null && typeof record === 'object') records.push(record)
    } catch { /* half-written */ }
  }
  return records
}

function escapeLike(term) {
  return term.replace(/[\\%_]/g, ch => `\\${ch}`)
}

function groupLineOf(record) {
  if (typeof record?.text !== 'string' || record.text.trim() === '') return undefined
  const line = { seq: record.seq, time: record.time, text: record.text }
  if (record.botId !== undefined) line.botId = record.botId
  if (record.who !== undefined) line.name = record.who
  return line
}

export function install(rt) {
  const dir = join(rt.home, 'ledger')
  const pathOf = book => join(dir, bookFile(book))
  const shardsDirOf = book => `${pathOf(book)}.shards`
  const writes = () => rt.readOnly?.() === undefined

  const maxActiveBytes = rt.config?.ledgerMaxActiveBytes ?? DEFAULT_MAX_ACTIVE_BYTES
  const maxActiveRecords = rt.config?.ledgerMaxActiveRecords ?? DEFAULT_MAX_ACTIVE_RECORDS
  const defaultTail = maxActiveRecords >= 2 ? Math.max(1, Math.min(500, Math.floor(maxActiveRecords / 4))) : 1
  const keepTailRecords = rt.config?.ledgerKeepTailRecords ?? defaultTail
  const maxShardBytes = rt.config?.ledgerMaxShardBytes ?? DEFAULT_MAX_SHARD_BYTES
  const maxShardRows = rt.config?.ledgerMaxShardRows ?? DEFAULT_MAX_SHARD_ROWS

  const pool = createShardPool({ maxOpen: 4 })

  /** @type {Map<string, any>} */
  const books = new Map()
  /** @type {Map<string, Promise<unknown>>} */
  const writing = new Map()
  // The last write of each book as it went, failure included, for a caller that must not
  // go on when its record is not on disk.
  /** @type {Map<string, Promise<unknown>>} */
  const lastWrite = new Map()
  /** @type {Map<string, (book: string) => object[] | undefined>} */
  const importers = new Map()

  const index = (records) => {
    const bySeq = new Map()
    for (const record of records) if (Number.isInteger(record.seq)) bySeq.set(record.seq, record)
    return bySeq
  }
  // What range and anchorAt look up, built on first use. An append adds to it; anything
  // else that changes the records drops it.
  const note = (view, record, at) => {
    if (Number.isInteger(record.seq)) {
      if (record.seq <= view.last) view.ascending = false
      view.first = Math.min(view.first, record.seq)
      view.last = Math.max(view.last, record.seq)
    }
    if (record.event === 'anchor' && !view.anchors.has(record.id)) view.anchors.set(record.id, at)
  }
  const viewOf = (entry) => {
    if (entry.view !== undefined) return entry.view
    const view = { ascending: true, first: Infinity, last: -Infinity, anchors: new Map() }
    entry.records.forEach((record, at) => note(view, record, at))
    entry.view = view
    return view
  }
  const statOf = (filePath) => {
    try { return statSync(filePath) } catch { return null }
  }

  function insertLedgerRows(db, batch) {
    const stmt = db.prepare('INSERT INTO records(seq, event, record_id, anchor_id, anchor_from, time, text_lower, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    for (const record of batch) {
      stmt.run(
        Number.isInteger(record.seq) ? record.seq : null,
        typeof record.event === 'string' ? record.event : null,
        typeof record.id === 'string' && record.event === undefined ? record.id : null,
        record.event === 'anchor' && typeof record.id === 'string' ? record.id : null,
        record.event === 'anchor' && Number.isInteger(record.from) ? record.from : null,
        typeof record.time === 'number' && Number.isFinite(record.time) ? Math.trunc(record.time) : null,
        typeof record.text === 'string' ? record.text.toLowerCase() : '',
        JSON.stringify(record),
      )
    }
  }

  function updateLedgerShardMeta(db, shard, batch) {
    shard.count += batch.length
    const stats = db.prepare('SELECT MIN(seq) AS minSeq, MAX(seq) AS maxSeq, MIN(time) AS minTime, MAX(time) AS maxTime FROM records').get()
    shard.minSeq = stats?.minSeq ?? null
    shard.maxSeq = stats?.maxSeq ?? null
    shard.minTime = stats?.minTime ?? null
    shard.maxTime = stats?.maxTime ?? null
    const anchorRows = db.prepare("SELECT idx, anchor_id, anchor_from FROM records WHERE event = 'anchor' ORDER BY idx ASC").all()
    if (anchorRows.length === 0) {
      shard.anchors = []
      return
    }
    const idxOffset = new Map()
    const allIdx = db.prepare('SELECT idx FROM records ORDER BY idx ASC').all()
    allIdx.forEach((row, offset) => idxOffset.set(row.idx, offset))
    shard.anchors = anchorRows.map(row => ({
      id: row.anchor_id,
      ...(row.anchor_from !== null ? { from: row.anchor_from } : {}),
      offset: idxOffset.get(row.idx) ?? 0,
    }))
  }

  function shouldCompact(entry) {
    return (entry.size >= maxActiveBytes || entry.records.length >= maxActiveRecords)
      && entry.records.length > keepTailRecords
  }

  function compactBookSync(book, entry) {
    const hotPath = pathOf(book)
    const shardsDir = shardsDirOf(book)
    const st = statOf(hotPath)
    if (!st) return
    const rawText = readFileSync(hotPath, 'utf8')
    const scanned = scanJsonLines(rawText)
    if (scanned.length <= keepTailRecords) return
    const splitAt = scanned.length - keepTailRecords
    const splitItem = scanned[splitAt]
    const remainingTailText = rawText.slice(splitItem.startChar)
    const prefixRecords = scanned.slice(0, splitAt).map(item => item.record)
    const manifest = compactRecordsToShards({
      hotPath,
      shardsDir,
      prefixRecords,
      prefixRawLines: splitItem.startLine,
      remainingTailText,
      oldInode: st.ino,
      maxShardBytes,
      maxShardRows,
      schemaSql: LEDGER_SCHEMA_SQL,
      tableName: 'records',
      insertRows: insertLedgerRows,
      updateMeta: updateLedgerShardMeta,
      pool,
    })
    const tailRecords = scanned.slice(splitAt).map(item => item.record)
    entry.records = tailRecords
    entry.bySeq = index(tailRecords)
    entry.view = undefined
    entry.torn = remainingTailText !== '' && !remainingTailText.endsWith('\n')
    const nextStat = statOf(hotPath)
    entry.size = nextStat ? nextStat.size : Buffer.byteLength(remainingTailText)
    entry.ino = nextStat?.ino
    entry.shards = manifest?.shards ?? []
    entry.mStamp = manifestStamp(shardsDir)
  }

  function readAppendedTail(hotPath, fromOffset) {
    let fd
    try {
      fd = openSync(hotPath, 'r')
    } catch {
      return null
    }
    try {
      const size = fstatSync(fd).size
      if (size <= fromOffset) return { records: [], size, addedText: '' }
      const buffer = Buffer.alloc(size - fromOffset)
      for (let at = 0; at < buffer.length;) {
        const read = readSync(fd, buffer, at, buffer.length - at, fromOffset + at)
        if (read === 0) break
        at += read
      }
      const addedText = buffer.toString('utf8')
      return { records: parseBook(addedText), size, addedText }
    } finally {
      closeSync(fd)
    }
  }

  function shardRecords(shardsDir, shard) {
    const db = pool.getReadOnly(join(shardsDir, shard.file))
    return db.prepare('SELECT payload FROM records ORDER BY idx ASC').all().map(row => JSON.parse(row.payload))
  }

  function allRecords(book, entry) {
    const shardsDir = shardsDirOf(book)
    const pre = entry.pendingPrepends ?? []
    if (entry.shards.length === 0 && pre.length === 0) return entry.records
    const combined = [...pre]
    for (const shard of entry.shards) {
      combined.push(...shardRecords(shardsDir, shard))
    }
    combined.push(...entry.records)
    return combined
  }

  // The first use of a book reads it (shards metadata + active JSONL tail).
  // A book that does not exist yet starts from what an importer finds (writing hosts only).
  function open(book) {
    const hotPath = pathOf(book)
    const shardsDir = shardsDirOf(book)
    const known = books.get(book)
    const isWriter = writes()

    if (known !== undefined) {
      if (isWriter && !known.readOnly) return known
      if (!isWriter && known.readOnly) {
        const currentMStamp = manifestStamp(shardsDir)
        const hotStat = statOf(hotPath)
        if (currentMStamp === known.mStamp) {
          if (hotStat === null && known.size === -1) return known
          if (hotStat !== null && known.ino !== undefined && hotStat.ino === known.ino) {
            if (hotStat.size === known.size) return known
            if (hotStat.size > known.size) {
              const delta = readAppendedTail(hotPath, known.size)
              if (delta !== null) {
                for (const rec of delta.records) {
                  known.records.push(rec)
                  if (Number.isInteger(rec.seq)) known.bySeq.set(rec.seq, rec)
                  if (known.view !== undefined) note(known.view, rec, known.records.length - 1)
                }
                known.size = delta.size
                known.torn = delta.addedText !== '' ? !delta.addedText.endsWith('\n') : known.torn
                return known
              }
            }
          }
        }
        pool.closeUnder(shardsDir)
      }
    }

    const { manifest, skipLines } = recoverPendingTrim(hotPath, shardsDir, { writable: isWriter })
    const shards = manifest?.shards ?? []
    const mStamp = manifestStamp(shardsDir)

    let text
    let size = -1
    let ino
    try {
      const st = statSync(hotPath)
      ino = st.ino
      text = readFileSync(hotPath, 'utf8')
      size = Buffer.byteLength(text)
    } catch (error) {
      if (error?.code !== 'ENOENT') rt.warn('ds-bot: ledger %s could not be read: %s', book, error?.message ?? error)
    }

    const effectiveText = text === undefined ? undefined : (skipLines > 0 ? sliceAfterLines(text, skipLines) : text)
    let records = effectiveText === undefined ? [] : parseBook(effectiveText)
    if (text === undefined && shards.length === 0) {
      const prefix = book.slice(0, book.indexOf('-') + 1)
      const imported = importers.get(prefix)?.(book)
      if (imported !== undefined && imported.length > 0) {
        records = imported
        if (isWriter) {
          try {
            mkdirSync(dir, { recursive: true })
            const temp = `${hotPath}.${process.pid}.tmp`
            writeFileSync(temp, records.map(record => `${JSON.stringify(record)}\n`).join(''), 'utf8')
            renameSync(temp, hotPath)
            const st = statOf(hotPath)
            size = st ? st.size : -1
            ino = st?.ino
          } catch (error) {
            rt.warn('ds-bot: ledger %s could not be started from earlier messages: %s', book, error?.message ?? error)
          }
        }
      }
    }

    // An interruption can leave the last line without its end; the next record starts on a
    // line of its own, or it would join the cut one and be lost with it.
    const entry = {
      records,
      bySeq: index(records),
      size,
      ino,
      shards,
      mStamp,
      pendingWrites: 0,
      pendingPrepends: [],
      readOnly: !isWriter,
      torn: effectiveText !== undefined && effectiveText !== '' && !effectiveText.endsWith('\n'),
    }
    books.set(book, entry)

    if (isWriter && skipLines === 0 && shouldCompact(entry)) {
      try {
        compactBookSync(book, entry)
      } catch (error) {
        rt.warn('ds-bot: ledger %s could not be compacted: %s', book, error?.message ?? error)
      }
    }

    return entry
  }

  // Appends a record: in memory at once, on disk in order.
  function append(book, record) {
    const entry = open(book)
    entry.records.push(record)
    if (Number.isInteger(record.seq)) entry.bySeq.set(record.seq, record)
    if (entry.view !== undefined) note(entry.view, record, entry.records.length - 1)
    if (!writes()) return record
    const line = `${entry.torn ? '\n' : ''}${JSON.stringify(record)}\n`
    entry.torn = false
    entry.size += Buffer.byteLength(line)
    entry.pendingWrites += 1
    const run = (writing.get(book) ?? Promise.resolve()).then(async () => {
      try {
        await mkdir(dir, { recursive: true })
        await appendFile(pathOf(book), line, 'utf8')
        if (entry.ino === undefined) entry.ino = statOf(pathOf(book))?.ino
      } finally {
        entry.pendingWrites = Math.max(0, entry.pendingWrites - 1)
      }
      if (books.get(book) === entry && entry.pendingWrites === 0 && shouldCompact(entry)) {
        compactBookSync(book, entry)
      }
    })
    lastWrite.set(book, run)
    writing.set(book, run.catch((error) => {
      rt.warn('ds-bot: a record of %s was not written: %s', book, error?.message ?? error)
      // Memory holds only what the disk has, so a record that did not land is written again
      // when it is sent again. Part of its line may have landed: the next one starts anew.
      if (books.get(book) !== entry) return
      const at = entry.records.indexOf(record)
      if (at !== -1) entry.records.splice(at, 1)
      entry.view = undefined
      // An earlier record may hold the same seq; range walks bySeq, so it must find that one.
      if (Number.isInteger(record.seq) && entry.bySeq.get(record.seq) === record) entry.bySeq = index(entry.records)
      entry.torn = true
    }))
    return record
  }

  // Everything appended so far is on disk.
  const flush = async (book) => {
    if (book !== undefined) return writing.get(book)
    await Promise.all(writing.values())
  }

  function hasSeqInShards(book, entry, seq) {
    if (!Number.isInteger(seq)) return false
    const shardsDir = shardsDirOf(book)
    for (const shard of entry.shards) {
      if (shard.minSeq !== null && shard.maxSeq !== null && (seq < shard.minSeq || seq > shard.maxSeq)) continue
      const db = pool.getReadOnly(join(shardsDir, shard.file))
      if (db.prepare('SELECT 1 FROM records WHERE seq = ? LIMIT 1').get(seq) !== undefined) return true
    }
    return false
  }

  // Prepends earlier records before what the book already holds, once, oldest first.
  function prepend(book, records) {
    const entry = open(book)
    const added = []
    const seen = new Set()
    const preSeqs = new Set((entry.pendingPrepends ?? []).map(r => r.seq).filter(Number.isInteger))
    for (const record of records) {
      if (!Number.isInteger(record?.seq) || entry.bySeq.has(record.seq) || preSeqs.has(record.seq) || seen.has(record.seq)) continue
      if (entry.shards.length > 0 && hasSeqInShards(book, entry, record.seq)) continue
      seen.add(record.seq)
      added.push(record)
    }
    if (added.length === 0) return 0
    added.sort((a, b) => a.seq - b.seq)
    if (!writes()) {
      entry.records = [...added, ...entry.records]
      entry.view = undefined
      for (const record of added) entry.bySeq.set(record.seq, record)
      return added.length
    }

    if (entry.shards.length === 0 && (entry.pendingPrepends?.length ?? 0) === 0) {
      entry.records = [...added, ...entry.records]
      entry.view = undefined
      for (const record of added) entry.bySeq.set(record.seq, record)
      const wasTorn = entry.torn
      const snapshot = entry.records.map(record => `${JSON.stringify(record)}\n`).join('')
      entry.torn = false
      entry.size = Buffer.byteLength(snapshot)
      const run = (writing.get(book) ?? Promise.resolve()).then(async () => {
        await mkdir(dir, { recursive: true })
        const temp = `${pathOf(book)}.${process.pid}.tmp`
        await writeFile(temp, snapshot, 'utf8')
        await rename(temp, pathOf(book))
        entry.ino = statOf(pathOf(book))?.ino
      })
      lastWrite.set(book, run)
      writing.set(book, run.catch((error) => {
        rt.warn('ds-bot: earlier records of %s were not written: %s', book, error?.message ?? error)
        if (books.get(book) !== entry) return
        const dropped = new Set(added)
        entry.records = entry.records.filter(record => !dropped.has(record))
        entry.view = undefined
        for (const record of added) if (entry.bySeq.get(record.seq) === record) entry.bySeq.delete(record.seq)
        if (wasTorn) entry.torn = true
      }))
      return added.length
    }

    entry.pendingPrepends = [...added, ...(entry.pendingPrepends ?? [])]
    const run = (writing.get(book) ?? Promise.resolve()).then(async () => {
      const manifest = prependRecordsToShards({
        shardsDir: shardsDirOf(book),
        records: added,
        schemaSql: LEDGER_SCHEMA_SQL,
        tableName: 'records',
        insertRows: insertLedgerRows,
        updateMeta: updateLedgerShardMeta,
      })
      entry.shards = manifest.shards
      entry.mStamp = manifestStamp(shardsDirOf(book))
      const dropped = new Set(added)
      entry.pendingPrepends = (entry.pendingPrepends ?? []).filter(record => !dropped.has(record))
    })
    lastWrite.set(book, run)
    writing.set(book, run.catch((error) => {
      rt.warn('ds-bot: earlier records of %s were not written: %s', book, error?.message ?? error)
      if (books.get(book) !== entry) return
      const dropped = new Set(added)
      entry.pendingPrepends = (entry.pendingPrepends ?? []).filter(record => !dropped.has(record))
    }))
    return added.length
  }

  function drop(book) {
    books.delete(book)
    pool.closeUnder(shardsDirOf(book))
    if (!writes()) return
    const run = (writing.get(book) ?? Promise.resolve()).then(async () => {
      pool.closeUnder(shardsDirOf(book))
      await rm(pathOf(book), { force: true })
      await rm(shardsDirOf(book), { recursive: true, force: true })
    })
    writing.set(book, run.catch(() => {}))
  }

  function hotRange(entry, from, to) {
    const view = viewOf(entry)
    const start = Math.max(Math.ceil(from), view.first)
    const end = to === undefined ? view.last : Math.min(to, view.last)
    if (!view.ascending || end - start > entry.records.length) {
      return entry.records.filter(record => Number.isInteger(record.seq) && record.seq >= from && (to === undefined || record.seq <= to))
    }
    const rows = []
    for (let seq = start; seq <= end; seq += 1) {
      const record = entry.bySeq.get(seq)
      if (record !== undefined) rows.push(record)
    }
    return rows
  }

  const allAnchorsOf = (entry) => {
    const list = []
    for (const shard of entry.shards) {
      for (const anchor of shard.anchors ?? []) list.push(anchor)
    }
    for (const record of entry.records) {
      if (record.event === 'anchor') list.push({ id: record.id, ...(record.from !== undefined ? { from: record.from } : {}) })
    }
    return list
  }

  const ledger = {
    open,
    append,
    prepend,
    flush,
    // Rejects when the last record of the book did not reach the disk.
    written: book => lastWrite.get(book) ?? Promise.resolve(),
    drop,
    records: (book) => {
      const entry = open(book)
      return allRecords(book, entry)
    },
    record: (book, seq) => {
      const entry = open(book)
      const hot = entry.bySeq.get(seq)
      if (hot !== undefined) return hot
      if (Number.isInteger(seq) && entry.shards.length > 0) {
        const shardsDir = shardsDirOf(book)
        for (let i = entry.shards.length - 1; i >= 0; i -= 1) {
          const shard = entry.shards[i]
          if (shard.minSeq !== null && shard.maxSeq !== null && (seq < shard.minSeq || seq > shard.maxSeq)) continue
          const db = pool.getReadOnly(join(shardsDir, shard.file))
          const row = db.prepare('SELECT payload FROM records WHERE seq = ? ORDER BY idx DESC LIMIT 1').get(seq)
          if (row !== undefined) return JSON.parse(row.payload)
        }
      }
      return (entry.pendingPrepends ?? []).findLast(record => record.seq === seq)
    },
    hasMessageId: (book, id) => {
      const entry = open(book)
      if (entry.records.some(record => record.event === undefined && record.id === id)) return true
      if ((entry.pendingPrepends ?? []).some(record => record.event === undefined && record.id === id)) return true
      const shardsDir = shardsDirOf(book)
      for (let i = entry.shards.length - 1; i >= 0; i -= 1) {
        const db = pool.getReadOnly(join(shardsDir, entry.shards[i].file))
        if (db.prepare('SELECT 1 FROM records WHERE event IS NULL AND record_id = ? LIMIT 1').get(id) !== undefined) return true
      }
      return false
    },
    after: (book, since) => {
      const entry = open(book)
      if (entry.shards.length === 0 && (entry.pendingPrepends?.length ?? 0) === 0) {
        return entry.records.filter(record => since === undefined || (Number.isInteger(record.seq) && record.seq > since))
      }
      const out = []
      for (const record of entry.pendingPrepends ?? []) {
        if (since === undefined || (Number.isInteger(record.seq) && record.seq > since)) out.push(record)
      }
      const shardsDir = shardsDirOf(book)
      for (const shard of entry.shards) {
        if (since !== undefined && (shard.maxSeq === null || shard.maxSeq <= since)) continue
        const db = pool.getReadOnly(join(shardsDir, shard.file))
        const rows = since === undefined
          ? db.prepare('SELECT payload FROM records ORDER BY idx ASC').all()
          : db.prepare('SELECT payload FROM records WHERE seq > ? ORDER BY idx ASC').all(since)
        for (const row of rows) out.push(JSON.parse(row.payload))
      }
      for (const record of entry.records) {
        if (since === undefined || (Number.isInteger(record.seq) && record.seq > since)) out.push(record)
      }
      return out
    },
    range: (book, from, to) => {
      const entry = open(book)
      if (Number.isNaN(from) || (to !== undefined && Number.isNaN(to))) return []
      if (entry.shards.length === 0 && (entry.pendingPrepends?.length ?? 0) === 0) {
        return hotRange(entry, from, to)
      }
      const rows = []
      for (const record of entry.pendingPrepends ?? []) {
        if (Number.isInteger(record.seq) && record.seq >= from && (to === undefined || record.seq <= to)) rows.push(record)
      }
      const shardsDir = shardsDirOf(book)
      const ceilFrom = Math.ceil(from)
      for (const shard of entry.shards) {
        if (shard.minSeq === null || shard.maxSeq === null) continue
        if (shard.maxSeq < ceilFrom) continue
        if (to !== undefined && shard.minSeq > to) continue
        const db = pool.getReadOnly(join(shardsDir, shard.file))
        const matched = to === undefined
          ? db.prepare('SELECT payload FROM records WHERE seq >= ? ORDER BY idx ASC').all(ceilFrom)
          : db.prepare('SELECT payload FROM records WHERE seq >= ? AND seq <= ? ORDER BY idx ASC').all(ceilFrom, to)
        for (const row of matched) rows.push(JSON.parse(row.payload))
      }
      rows.push(...hotRange(entry, from, to))
      return rows
    },
    // Where the anchor record with this id is in records(book), or -1.
    anchorAt: (book, id) => {
      const entry = open(book)
      let base = entry.pendingPrepends?.length ?? 0
      for (const record of entry.pendingPrepends ?? []) {
        if (record.event === 'anchor' && record.id === id) return entry.pendingPrepends.indexOf(record)
      }
      for (const shard of entry.shards) {
        const found = (shard.anchors ?? []).find(anchor => anchor.id === id)
        if (found !== undefined) return base + found.offset
        base += shard.count
      }
      const hotAt = viewOf(entry).anchors.get(id)
      return hotAt === undefined ? -1 : base + hotAt
    },
    nextAnchorFrom: (book, from, anchorId) => {
      const entry = open(book)
      const anchors = allAnchorsOf(entry)
      const at = anchorId === undefined ? -1 : anchors.findIndex(item => item.id === anchorId)
      if (at === -1) {
        const next = anchors.filter(item => item.from !== undefined && item.from > from).map(item => item.from)
        return next.length > 0 ? Math.min(...next) - 1 : undefined
      }
      if (at + 1 < anchors.length && anchors[at + 1].from !== undefined) {
        return anchors[at + 1].from - 1
      }
      return undefined
    },
    lastSeq: (book) => {
      const entry = open(book)
      let last = 0
      for (const record of entry.pendingPrepends ?? []) if (Number.isInteger(record.seq) && record.seq > last) last = record.seq
      for (const shard of entry.shards) if (Number.isInteger(shard.maxSeq) && shard.maxSeq > last) last = shard.maxSeq
      for (const record of entry.records) if (Number.isInteger(record.seq) && record.seq > last) last = record.seq
      return last
    },
    firstSeq: (book) => {
      const entry = open(book)
      let first
      for (const record of entry.pendingPrepends ?? []) {
        if (Number.isInteger(record.seq) && (first === undefined || record.seq < first)) first = record.seq
      }
      for (const shard of entry.shards) {
        if (Number.isInteger(shard.minSeq) && (first === undefined || shard.minSeq < first)) first = shard.minSeq
      }
      for (const record of entry.records) {
        if (Number.isInteger(record.seq) && (first === undefined || record.seq < first)) first = record.seq
      }
      return first
    },
    // Newest first: every word has to be in the record's text.
    search: (book, query, pick = record => record.text) => {
      const words = String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean)
      if (words.length === 0) return []
      const entry = open(book)
      if (entry.shards.length === 0 && (entry.pendingPrepends?.length ?? 0) === 0) {
        const records = entry.records
        const lower = searchTextFor(records)
        return records.filter((record, at) => {
          const text = pick(record)
          const value = lower(at, text)
          return typeof text === 'string' && words.every(word => value.includes(word))
        }).slice(-SEARCH_MAX).reverse()
      }

      const out = []
      const lowerHot = searchTextFor(entry.records)
      for (let at = entry.records.length - 1; at >= 0 && out.length < SEARCH_MAX; at -= 1) {
        const record = entry.records[at]
        const text = pick(record)
        const value = lowerHot(at, text)
        if (typeof text === 'string' && words.every(word => value.includes(word))) out.push(record)
      }
      const isDefaultPick = String(pick) === String(record => record.text)
      const shardsDir = shardsDirOf(book)
      for (let s = entry.shards.length - 1; s >= 0 && out.length < SEARCH_MAX; s -= 1) {
        const db = pool.getReadOnly(join(shardsDir, entry.shards[s].file))
        if (isDefaultPick) {
          const need = SEARCH_MAX - out.length
          const where = words.map(() => "text_lower LIKE ? ESCAPE '\\'").join(' AND ')
          const params = words.map(word => `%${escapeLike(word)}%`)
          const rows = db.prepare(`SELECT payload FROM records WHERE ${where} ORDER BY idx DESC LIMIT ?`).all(...params, need)
          for (const row of rows) out.push(JSON.parse(row.payload))
        } else {
          const rows = db.prepare('SELECT payload FROM records ORDER BY idx DESC').all()
          for (const row of rows) {
            const record = JSON.parse(row.payload)
            const text = pick(record)
            if (typeof text === 'string' && words.every(word => text.toLowerCase().includes(word))) {
              out.push(record)
              if (out.length >= SEARCH_MAX) break
            }
          }
        }
      }
      for (let at = (entry.pendingPrepends?.length ?? 0) - 1; at >= 0 && out.length < SEARCH_MAX; at -= 1) {
        const record = entry.pendingPrepends[at]
        const text = pick(record)
        if (typeof text === 'string' && words.every(word => text.toLowerCase().includes(word))) out.push(record)
      }
      return out
    },
    searchGroup: (book, query, options) => {
      const entry = open(book)
      if (entry.shards.length === 0 && (entry.pendingPrepends?.length ?? 0) === 0) {
        return searchGroupBook(entry.records, query, options)
      }
      const terms = [...new Set(String(query ?? '').toLowerCase().slice(0, GROUP_QUERY_MAX).split(/\s+/).filter(Boolean))].slice(0, GROUP_TERMS_MAX)
      if (terms.length === 0) return { results: [], hasMore: false }
      const page = options ?? {}
      const offset = Number.isInteger(page.offset) && page.offset > 0 ? page.offset : 0
      const before = Number.isInteger(page.before) ? page.before : undefined
      const results = []
      let skipped = 0
      let hasMore = false
      const shardsDir = shardsDirOf(book)

      const shardEdgeRow = (shardIndex, edge) => {
        if (shardIndex < 0) return entry.pendingPrepends?.at(-1)
        if (shardIndex >= entry.shards.length) return entry.records[0]
        const db = pool.getReadOnly(join(shardsDir, entry.shards[shardIndex].file))
        const row = db.prepare(`SELECT payload FROM records ORDER BY idx ${edge === 'last' ? 'DESC' : 'ASC'} LIMIT 1`).get()
        return row ? JSON.parse(row.payload) : undefined
      }

      const tryPush = (hit, prevRecord, nextRecord) => {
        if (skipped < offset) {
          skipped += 1
          return false
        }
        if (results.length === GROUP_SEARCH_MAX) {
          hasMore = true
          return true
        }
        results.push({
          ...hit,
          before: prevRecord ? groupLineOf(prevRecord) : undefined,
          after: nextRecord ? groupLineOf(nextRecord) : undefined,
        })
        return false
      }

      // 1. Hot records newest-first.
      const lowerHot = searchTextFor(entry.records)
      for (let at = entry.records.length - 1; at >= 0; at -= 1) {
        const record = entry.records[at]
        if (before !== undefined && !(Number.isInteger(record?.seq) && record.seq < before)) continue
        const text = lowerHot(at, record?.text)
        if (text === '' || !terms.every(term => text.includes(term))) continue
        const hit = groupLineOf(record)
        if (hit === undefined) continue
        const prev = at > 0 ? entry.records[at - 1] : shardEdgeRow(entry.shards.length - 1, 'last')
        const next = at + 1 < entry.records.length ? entry.records[at + 1] : undefined
        if (tryPush(hit, prev, next)) return { results, hasMore }
      }

      // 2. SQLite shards newest-first.
      const termSql = terms.map(() => "text_lower LIKE ? ESCAPE '\\'").join(' AND ')
      const termParams = terms.map(term => `%${escapeLike(term)}%`)
      for (let s = entry.shards.length - 1; s >= 0; s -= 1) {
        const shard = entry.shards[s]
        if (before !== undefined && shard.minSeq !== null && shard.minSeq >= before) continue
        const db = pool.getReadOnly(join(shardsDir, shard.file))
        const sql = before !== undefined
          ? `SELECT idx, payload FROM records WHERE seq IS NOT NULL AND seq < ? AND ${termSql} ORDER BY idx DESC`
          : `SELECT idx, payload FROM records WHERE ${termSql} ORDER BY idx DESC`
        const matched = before !== undefined ? db.prepare(sql).all(before, ...termParams) : db.prepare(sql).all(...termParams)
        for (const row of matched) {
          const record = JSON.parse(row.payload)
          const hit = groupLineOf(record)
          if (hit === undefined) continue
          const prevRow = db.prepare('SELECT payload FROM records WHERE idx < ? ORDER BY idx DESC LIMIT 1').get(row.idx)
          const nextRow = db.prepare('SELECT payload FROM records WHERE idx > ? ORDER BY idx ASC LIMIT 1').get(row.idx)
          const prev = prevRow ? JSON.parse(prevRow.payload) : shardEdgeRow(s - 1, 'last')
          const next = nextRow ? JSON.parse(nextRow.payload) : shardEdgeRow(s + 1, 'first')
          if (tryPush(hit, prev, next)) return { results, hasMore }
        }
      }

      // 3. Pending prepends newest-first (if any).
      const pre = entry.pendingPrepends ?? []
      for (let at = pre.length - 1; at >= 0; at -= 1) {
        const record = pre[at]
        if (before !== undefined && !(Number.isInteger(record?.seq) && record.seq < before)) continue
        if (typeof record?.text !== 'string') continue
        const lower = record.text.toLowerCase()
        if (!terms.every(term => lower.includes(term))) continue
        const hit = groupLineOf(record)
        if (hit === undefined) continue
        const prev = at > 0 ? pre[at - 1] : undefined
        const next = at + 1 < pre.length ? pre[at + 1] : (entry.shards.length > 0 ? shardEdgeRow(0, 'first') : entry.records[0])
        if (tryPush(hit, prev, next)) return { results, hasMore }
      }

      return { results, hasMore }
    },
    // How a kind of book is started from what was kept before the ledger: `prefix`
    // is the start of its name, up to and with the first "-".
    importer: (prefix, read) => { importers.set(prefix, read) },
  }
  rt.ledger = ledger
  const teardown = async () => {
    await flush()
    pool.closeAll()
  }
  rt.onHomeDrain?.(() => teardown())
  // What is still on its way to disk lands before the plugin goes.
  rt.ctx?.effect?.(() => () => teardown(), 'ds-bot: ledger')
}

// Re-export searchGroupBook locally to avoid circular import between ledger.js and group-search.js.
function searchGroupBook(records, query, options) {
  const terms = [...new Set(String(query ?? '').toLowerCase().slice(0, GROUP_QUERY_MAX).split(/\s+/).filter(Boolean))].slice(0, GROUP_TERMS_MAX)
  if (terms.length === 0) return { results: [], hasMore: false }
  const lower = searchTextFor(records)
  const page = options ?? {}
  const offset = Number.isInteger(page.offset) && page.offset > 0 ? page.offset : 0
  const before = Number.isInteger(page.before) ? page.before : undefined
  const results = []
  let skipped = 0
  let hasMore = false
  for (let at = records.length - 1; at >= 0; at -= 1) {
    const record = records[at]
    if (before !== undefined && !(Number.isInteger(record?.seq) && record.seq < before)) continue
    const text = lower(at, record?.text)
    if (text === '' || !terms.every(term => text.includes(term))) continue
    const hit = groupLineOf(record)
    if (hit === undefined) continue
    if (skipped < offset) {
      skipped += 1
      continue
    }
    if (results.length === GROUP_SEARCH_MAX) {
      hasMore = true
      break
    }
    results.push({
      ...hit,
      before: at > 0 ? groupLineOf(records[at - 1]) : undefined,
      after: at + 1 < records.length ? groupLineOf(records[at + 1]) : undefined,
    })
  }
  return { results, hasMore }
}
