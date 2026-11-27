// The ledger: what is said in a conversation between Bots, kept by DS Bot itself. Each
// conversation has one book: a hot JSONL tail (`<home>/ledger/<book>.jsonl`) backed by
// bounded SQLite shards (`<home>/ledger/<book>.jsonl.shards/`). A record is written in order;
// updates (delivered, answered) append a record of their own, so historical lines stay immutable.
import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { appendFile, mkdir, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { replaceFile } from './files.js'
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
const MAX_BOOKS = 32
const MAX_BYTES = 32 * 1024 * 1024
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

  /** @type {Map<string, { records: object[], bySeq: Map<number, object>, size: number, bytes: number, ino: number, dev: number, shards: object[], mStamp: string, pendingWrites: number, pendingPrepends: object[], readOnly: boolean, torn: boolean, view?: object }>} */
  const books = new Map()
  let totalBytes = 0
  /** @type {Map<string, Promise<unknown>>} */
  const writing = new Map()
  // The last write of each book as it went, failure included, for a caller that must not
  // go on when its record is not on disk.
  /** @type {Map<string, Promise<unknown>>} */
  const lastWrite = new Map()
  /** @type {Map<string, number>} */
  const dropGen = new Map()
  /** @type {Map<string, Set<object[]>>} */
  const activeMerges = new Map()
  /** @type {Map<string, (book: string) => object[] | undefined>} */
  const importers = new Map()

  const evict = (keepBook) => {
    if (books.size <= MAX_BOOKS && totalBytes <= MAX_BYTES) return
    for (const [key, entry] of books) {
      if (books.size <= MAX_BOOKS && totalBytes <= MAX_BYTES) break
      if (key === keepBook || writing.has(key)) continue
      books.delete(key)
      totalBytes -= entry.bytes
      pool.closeUnder(shardsDirOf(key))
    }
  }
  const touch = (book, entry) => {
    books.delete(book)
    books.set(book, entry)
  }
  const setBook = (book, entry) => {
    const prev = books.get(book)
    if (prev !== undefined) totalBytes -= prev.bytes
    books.delete(book)
    books.set(book, entry)
    totalBytes += entry.bytes
    evict(book)
  }

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
    if (record.event === 'anchor') {
      if (!view.anchors.has(record.id)) view.anchors.set(record.id, { at, index: view.anchorEntries.length })
      view.anchorEntries.push({ at, id: record.id, from: record.from })
    }
  }
  const viewOf = (entry) => {
    if (entry.view !== undefined) return entry.view
    const view = { ascending: true, first: Infinity, last: -Infinity, anchors: new Map(), anchorEntries: [] }
    entry.records.forEach((record, at) => note(view, record, at))
    entry.view = view
    return view
  }
  const statFile = (filePath) => {
    try { return statSync(filePath) } catch { return null }
  }
  const statOf = (book) => {
    try {
      const stat = statSync(pathOf(book))
      return { size: stat.size, ino: stat.ino, dev: stat.dev }
    } catch {
      return undefined
    }
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
    const st = statFile(hotPath)
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
    const nextStat = statFile(hotPath)
    entry.size = nextStat ? nextStat.size : Buffer.byteLength(remainingTailText)
    const nextBytes = Math.max(entry.size, 0)
    if (books.get(book) === entry) totalBytes += nextBytes - (entry.bytes ?? 0)
    entry.bytes = nextBytes
    entry.ino = nextStat?.ino ?? 0
    entry.dev = nextStat?.dev ?? entry.dev ?? 0
    entry.shards = manifest?.shards ?? []
    entry.mStamp = manifestStamp(shardsDir)
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
    const canWrite = writes()
    // A copy read while another host wrote is stale once this host writes.
    if (known !== undefined && canWrite && !known.readOnly) {
      touch(book, known)
      evict(book)
      return known
    }
    const stat = !canWrite ? statOf(book) : undefined
    if (known !== undefined && !canWrite) {
      const currentMStamp = manifestStamp(shardsDir)
      if (currentMStamp === known.mStamp) {
        const currentSize = stat?.size ?? -1
        const sameFile = stat !== undefined && stat.ino !== 0 && stat.ino === known.ino && stat.dev === known.dev
        if ((stat === undefined && known.size === -1) || (!known.torn && sameFile && currentSize === known.size)) {
          touch(book, known)
          evict(book)
          return known
        }
        // Incremental read-only tail: when the same file grew and ended cleanly, read only the appended bytes.
        if (sameFile && currentSize > known.size && known.size > 0 && !known.torn) {
          let fd
          let validTail = false
          try {
            fd = openSync(pathOf(book), 'r')
            const fdStat = fstatSync(fd)
            if (fdStat.ino !== 0 && fdStat.ino === known.ino && fdStat.dev === known.dev && fdStat.size >= known.size) {
              const length = fdStat.size - known.size
              if (length === 0) {
                validTail = true
              } else {
                const tailBuf = Buffer.alloc(length)
                let offset = 0
                while (offset < length) {
                  const bytesRead = readSync(fd, tailBuf, offset, length - offset, known.size + offset)
                  if (bytesRead === 0) break
                  offset += bytesRead
                }
                const chunk = tailBuf.subarray(0, offset)
                const tailText = chunk.toString('utf8')
                const added = parseBook(tailText)
                for (const record of added) {
                  known.records.push(record)
                  if (Number.isInteger(record.seq)) known.bySeq.set(record.seq, record)
                  if (known.view !== undefined) note(known.view, record, known.records.length - 1)
                }
                known.size += offset
                known.bytes += offset
                totalBytes += offset
                if (offset > 0 && chunk[offset - 1] !== 0x0a) known.torn = true
                validTail = true
              }
            }
          } catch {
            // Fall back to a full read below.
          } finally {
            if (fd !== undefined) try { closeSync(fd) } catch {}
          }
          if (validTail) {
            touch(book, known)
            evict(book)
            return known
          }
        }
      }
      pool.closeUnder(shardsDir)
    }

    const { manifest, skipLines } = recoverPendingTrim(hotPath, shardsDir, { writable: canWrite })
    const shards = manifest?.shards ?? []
    const mStamp = manifestStamp(shardsDir)

    let buf
    let text
    let size = -1
    let ino = 0
    let dev = 0
    let fd
    try {
      fd = openSync(pathOf(book), 'r')
      const fileStat = fstatSync(fd)
      ino = fileStat.ino
      dev = fileStat.dev
      buf = readFileSync(fd)
      size = buf.length
      text = buf.toString('utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT') rt.warn('ds-bot: ledger %s could not be read: %s', book, error?.message ?? error)
    } finally {
      if (fd !== undefined) try { closeSync(fd) } catch {}
    }

    const effectiveText = text === undefined ? undefined : (skipLines > 0 ? sliceAfterLines(text, skipLines) : text)
    let records = effectiveText === undefined ? [] : parseBook(effectiveText)
    if (text === undefined && shards.length === 0) {
      const prefix = book.slice(0, book.indexOf('-') + 1)
      const imported = importers.get(prefix)?.(book)
      if (imported !== undefined && imported.length > 0) {
        records = imported
        if (canWrite) {
          try {
            mkdirSync(dir, { recursive: true })
            const temp = `${hotPath}.${process.pid}.tmp`
            writeFileSync(temp, records.map(record => `${JSON.stringify(record)}\n`).join(''), 'utf8')
            renameSync(temp, pathOf(book))
            const writtenStat = statOf(book)
            size = writtenStat?.size ?? -1
            ino = writtenStat?.ino ?? 0
            dev = writtenStat?.dev ?? 0
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
      bytes: Math.max(size, 0),
      ino,
      dev,
      shards,
      mStamp,
      pendingWrites: 0,
      pendingPrepends: [],
      readOnly: !canWrite,
      torn: effectiveText !== undefined && effectiveText !== '' && !effectiveText.endsWith('\n'),
    }
    setBook(book, entry)
    if (canWrite && skipLines === 0 && shouldCompact(entry)) {
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
    const merging = activeMerges.get(book)
    if (merging !== undefined) {
      for (const bucket of merging) bucket.push(record)
    }
    if (Number.isInteger(record.seq)) entry.bySeq.set(record.seq, record)
    if (entry.view !== undefined) note(entry.view, record, entry.records.length - 1)
    if (!writes()) return record
    let addedBytes = 0
    entry.pendingWrites += 1
    const run = (writing.get(book) ?? Promise.resolve()).then(async () => {
      try {
        // Construct the line inside the serialized queue so if a prior write failed
        // and set `entry.torn = true`, this write prepends `\n` instead of fusing lines.
        const line = `${entry.torn ? '\n' : ''}${JSON.stringify(record)}\n`
        entry.torn = false
        addedBytes = Buffer.byteLength(line)
        entry.size = (entry.size < 0 ? 0 : entry.size) + addedBytes
        entry.bytes += addedBytes
        if (books.get(book) === entry) totalBytes += addedBytes
        await mkdir(dir, { recursive: true })
        await appendFile(pathOf(book), line, 'utf8')
        if (entry.ino === 0) {
          const st = statOf(book)
          if (st !== undefined) { entry.ino = st.ino; entry.dev = st.dev }
        }
      } finally {
        entry.pendingWrites = Math.max(0, entry.pendingWrites - 1)
      }
      if (books.get(book) === entry && entry.pendingWrites === 0 && shouldCompact(entry)) {
        compactBookSync(book, entry)
      }
    })
    const current = run.catch((error) => {
      rt.warn('ds-bot: a record of %s was not written: %s', book, error?.message ?? error)
      // Memory holds only what the disk has, so a record that did not land is written again
      // when it is sent again. Part of its line may have landed: the next one starts anew.
      if (books.get(book) !== entry) return
      // Replace the array reference on rollback so incremental readers (`delivery.js`) can
      // detect mutations in O(1) via reference identity.
      entry.records = entry.records.filter(item => item !== record)
      entry.view = undefined
      // An earlier record may hold the same seq; range walks bySeq, so it must find that one.
      if (Number.isInteger(record.seq) && entry.bySeq.get(record.seq) === record) entry.bySeq = index(entry.records)
      entry.torn = true
      entry.size = -1
      const nextBytes = Math.max(0, entry.bytes - addedBytes)
      totalBytes += nextBytes - entry.bytes
      entry.bytes = nextBytes
    }).finally(() => {
      if (writing.get(book) === current) {
        writing.delete(book)
        evict()
      }
      if (lastWrite.get(book) === run) lastWrite.delete(book)
    })
    lastWrite.set(book, run)
    writing.set(book, current)
    evict(book)
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
    if (entry.shards.length === 0 && (entry.pendingPrepends?.length ?? 0) === 0) {
      entry.records = [...added, ...entry.records]
      entry.view = undefined
      for (const record of added) entry.bySeq.set(record.seq, record)
      if (!writes()) return added.length
      // Snapshot membership synchronously so later queued appends are NOT included twice,
      // while reading `entry.records` inside the serialized queue excludes any earlier
      // queued append that failed and rolled itself out of memory before this rewrite ran.
      const included = new Set(entry.records)
      let wasTorn = false
      let deltaBytes = 0
      const run = (writing.get(book) ?? Promise.resolve()).then(async () => {
        wasTorn = entry.torn
        const snapshot = entry.records.filter(record => included.has(record)).map(record => `${JSON.stringify(record)}\n`).join('')
        entry.torn = false
        const nextBytes = Buffer.byteLength(snapshot)
        deltaBytes = nextBytes - entry.bytes
        if (books.get(book) === entry) totalBytes += deltaBytes
        entry.size = nextBytes
        entry.bytes = nextBytes
        await mkdir(dir, { recursive: true })
        const temp = `${pathOf(book)}.${process.pid}.tmp`
        await writeFile(temp, snapshot, 'utf8')
        await rename(temp, pathOf(book))
        const st = statOf(book)
        if (st !== undefined) { entry.ino = st.ino; entry.dev = st.dev }
      })
      const current = run.catch((error) => {
        rt.warn('ds-bot: earlier records of %s were not written: %s', book, error?.message ?? error)
        if (books.get(book) !== entry) return
        const dropped = new Set(added)
        entry.records = entry.records.filter(record => !dropped.has(record))
        entry.view = undefined
        for (const record of added) if (entry.bySeq.get(record.seq) === record) entry.bySeq.delete(record.seq)
        if (wasTorn) entry.torn = true
        entry.size = -1
        const rolledBytes = Math.max(0, entry.bytes - deltaBytes)
        totalBytes += rolledBytes - entry.bytes
        entry.bytes = rolledBytes
      }).finally(() => {
        if (writing.get(book) === current) {
          writing.delete(book)
          evict()
        }
        if (lastWrite.get(book) === run) lastWrite.delete(book)
      })
      lastWrite.set(book, run)
      writing.set(book, current)
      evict(book)
      return added.length
    }

    if (!writes()) {
      entry.pendingPrepends = [...added, ...(entry.pendingPrepends ?? [])]
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
    const current = run.catch((error) => {
      rt.warn('ds-bot: earlier records of %s were not written: %s', book, error?.message ?? error)
      if (books.get(book) !== entry) return
      const dropped = new Set(added)
      entry.pendingPrepends = (entry.pendingPrepends ?? []).filter(record => !dropped.has(record))
    }).finally(() => {
      if (writing.get(book) === current) {
        writing.delete(book)
        evict()
      }
      if (lastWrite.get(book) === run) lastWrite.delete(book)
    })
    lastWrite.set(book, run)
    writing.set(book, current)
    evict(book)
    return added.length
  }

  // Durably merges legacy records (e.g. from state.exchanges) ahead of any newer records
  // in `book`, deduplicating by record.id. Returns true only when every incoming record
  // is confirmed on disk (either already present on an existing book file or atomically
  // written); returns false on write failure, read-only transition, or concurrent drop(book).
  async function mergeRecords(book, incoming) {
    if (!writes()) return false
    const list = Array.isArray(incoming) ? incoming.filter(record => record !== null && typeof record === 'object') : []
    if (list.length === 0) return true
    // Snapshot drop generation and pre-existing in-memory membership synchronously at call time,
    // and track any synchronous `append()` calls queued after this run so they are never written
    // twice on disk and concurrent cold `open()` never duplicates existing disk events in RAM.
    const gen = dropGen.get(book) ?? 0
    const initialKnown = books.get(book)
    const preIncluded = initialKnown !== undefined && !initialKnown.readOnly ? new Set(initialKnown.records) : undefined
    const appendedAfter = []
    let mergeSet = activeMerges.get(book)
    if (mergeSet === undefined) {
      mergeSet = new Set()
      activeMerges.set(book, mergeSet)
    }
    mergeSet.add(appendedAfter)
    const untrack = () => {
      mergeSet.delete(appendedAfter)
      if (mergeSet.size === 0 && activeMerges.get(book) === mergeSet) activeMerges.delete(book)
    }
    const run = (writing.get(book) ?? Promise.resolve()).then(async () => {
      try {
        if (!writes() || (dropGen.get(book) ?? 0) !== gen) return false
        let diskText
        try {
          diskText = readFileSync(pathOf(book), 'utf8')
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error
        }
        const existingOnDisk = diskText !== undefined
        const current = preIncluded !== undefined
          ? initialKnown.records.filter(record => preIncluded.has(record))
          : (diskText === undefined ? [] : parseBook(diskText))
        const existingIds = new Set()
        for (const record of current) {
          if (record?.event === undefined && typeof record?.id === 'string' && record.id !== '') {
            existingIds.add(record.id)
          }
        }
        const deduped = []
        const seenIncoming = new Map()
        for (const record of list) {
          if (typeof record.id === 'string' && record.id !== '') {
            if (existingIds.has(record.id)) continue
            const prevAt = seenIncoming.get(record.id)
            if (prevAt !== undefined) deduped[prevAt] = record
            else {
              seenIncoming.set(record.id, deduped.length)
              deduped.push(record)
            }
          } else {
            deduped.push(record)
          }
        }
        if (existingOnDisk && deduped.length === 0) return true
        const merged = deduped.length > 0 ? [...deduped, ...current] : [...current]
        if (merged.length === 0) return true
        const snapshot = merged.map(record => `${JSON.stringify(record)}\n`).join('')
        await mkdir(dir, { recursive: true })
        if (!writes() || (dropGen.get(book) ?? 0) !== gen) return false
        const temp = `${pathOf(book)}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`
        try {
          await writeFile(temp, snapshot, 'utf8')
          if (!writes() || (dropGen.get(book) ?? 0) !== gen) {
            await unlink(temp).catch(() => {})
            return false
          }
          await replaceFile(temp, pathOf(book))
        } catch (error) {
          await unlink(temp).catch(() => {})
          throw error
        }
        if ((dropGen.get(book) ?? 0) !== gen) return false
        // Combine merged disk records with only the appends queued synchronously after this
        // call, keeping the existing entry object (replacing only its array ref) so queued
        // appends still update size/rollback on the live entry while pairCache detects the
        // new ref in O(1).
        const records = appendedAfter.length > 0 ? [...merged, ...appendedAfter] : merged
        const nextBytes = Buffer.byteLength(snapshot)
        const live = books.get(book)
        if (live !== undefined && !live.readOnly) {
          totalBytes += nextBytes - live.bytes
          live.records = records
          live.bySeq = index(records)
          live.view = undefined
          live.size = nextBytes
          live.bytes = nextBytes
          live.torn = false
          touch(book, live)
          evict(book)
        } else {
          setBook(book, {
            records,
            bySeq: index(records),
            size: nextBytes,
            bytes: nextBytes,
            ino: 0,
            dev: 0,
            shards: live?.shards ?? [],
            mStamp: live?.mStamp ?? '',
            pendingWrites: live?.pendingWrites ?? 0,
            pendingPrepends: live?.pendingPrepends ?? [],
            readOnly: false,
            torn: false,
          })
        }
        return true
      } finally {
        untrack()
      }
    })
    const current = run.catch((error) => {
      rt.warn('ds-bot: legacy records of %s were not migrated: %s', book, error?.message ?? error)
    }).finally(() => {
      if (writing.get(book) === current) {
        writing.delete(book)
        evict()
      }
      if (lastWrite.get(book) === run) lastWrite.delete(book)
    })
    lastWrite.set(book, run)
    writing.set(book, current)
    try {
      return await run
    } catch {
      return false
    }
  }

  function drop(book) {
    dropGen.set(book, (dropGen.get(book) ?? 0) + 1)
    const prev = books.get(book)
    if (prev !== undefined) {
      books.delete(book)
      totalBytes -= prev.bytes
    }
    lastWrite.delete(book)
    pool.closeUnder(shardsDirOf(book))
    if (!writes()) return
    const run = (writing.get(book) ?? Promise.resolve()).then(async () => {
      pool.closeUnder(shardsDirOf(book))
      await rm(pathOf(book), { force: true })
      await rm(shardsDirOf(book), { recursive: true, force: true })
    })
    const current = run.catch(() => {}).finally(() => {
      if (writing.get(book) === current) {
        writing.delete(book)
        evict()
      }
    })
    writing.set(book, current)
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
    hasBook: book => books.has(book) || statOf(book) !== undefined || statFile(shardsDirOf(book)) !== null,
    append,
    prepend,
    mergeRecords,
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
        return since === undefined ? [...entry.records] : ledger.range(book, Math.floor(since) + 1)
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
      const hotHit = viewOf(entry).anchors.get(id)
      return hotHit === undefined ? -1 : base + hotHit.at
    },
    // The `from` seq of the next anchor after `anchor` (or after `from` when unanchored), or undefined.
    nextAnchor: (book, from, anchor) => {
      const entry = open(book)
      const anchors = allAnchorsOf(entry)
      const at = anchor === undefined ? -1 : anchors.findIndex(item => item.id === anchor)
      if (at !== -1) return anchors[at + 1]?.from
      let min
      for (const item of anchors) {
        if (item.from > from && (min === undefined || item.from < min)) min = item.from
      }
      return min
    },
    nextAnchorFrom: (book, from, anchorId) => {
      const next = ledger.nextAnchor(book, from, anchorId)
      return next === undefined ? undefined : next - 1
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
    lastSeq: (book) => {
      const entry = open(book)
      let last = 0
      for (const record of entry.pendingPrepends ?? []) if (Number.isInteger(record.seq) && record.seq > last) last = record.seq
      for (const shard of entry.shards) if (Number.isInteger(shard.maxSeq) && shard.maxSeq > last) last = shard.maxSeq
      for (const record of entry.records) if (Number.isInteger(record.seq) && record.seq > last) last = record.seq
      return last
    },
    // Newest first: every word has to be in the record's text. Accepts either a `pick`
    // function or `{ pick, filter, limit }`; checks `filter` before lowercasing and stops
    // as soon as `limit` hits are collected from the tail.
    search: (book, query, pickOrOptions) => {
      const words = String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean)
      if (words.length === 0) return []
      const pick = typeof pickOrOptions === 'function' ? pickOrOptions : (pickOrOptions?.pick ?? (record => record.text))
      const filter = typeof pickOrOptions === 'object' && typeof pickOrOptions?.filter === 'function' ? pickOrOptions.filter : undefined
      const limit = typeof pickOrOptions === 'object' && Number.isInteger(pickOrOptions?.limit) && pickOrOptions.limit > 0 ? pickOrOptions.limit : SEARCH_MAX
      const entry = open(book)
      if (entry.shards.length === 0 && (entry.pendingPrepends?.length ?? 0) === 0) {
        const records = entry.records
        const lower = searchTextFor(records)
        const hits = []
        for (let at = records.length - 1; at >= 0; at -= 1) {
          const record = records[at]
          if (filter !== undefined && !filter(record)) continue
          const text = pick(record)
          if (typeof text !== 'string' || text === '') continue
          const value = lower(at, text)
          if (words.every(word => value.includes(word))) {
            hits.push(record)
            if (hits.length === limit) break
          }
        }
        return hits
      }

      const out = []
      const lowerHot = searchTextFor(entry.records)
      for (let at = entry.records.length - 1; at >= 0 && out.length < limit; at -= 1) {
        const record = entry.records[at]
        if (filter !== undefined && !filter(record)) continue
        const text = pick(record)
        if (typeof text !== 'string' || text === '') continue
        const value = lowerHot(at, text)
        if (words.every(word => value.includes(word))) out.push(record)
      }
      const isDefaultPick = filter === undefined && typeof pickOrOptions !== 'object' && String(pick) === String(record => record.text)
      const shardsDir = shardsDirOf(book)
      for (let s = entry.shards.length - 1; s >= 0 && out.length < limit; s -= 1) {
        const db = pool.getReadOnly(join(shardsDir, entry.shards[s].file))
        if (isDefaultPick) {
          const need = limit - out.length
          const where = words.map(() => "text_lower LIKE ? ESCAPE '\\'").join(' AND ')
          const params = words.map(word => `%${escapeLike(word)}%`)
          const rows = db.prepare(`SELECT payload FROM records WHERE ${where} ORDER BY idx DESC LIMIT ?`).all(...params, need)
          for (const row of rows) out.push(JSON.parse(row.payload))
        } else {
          const rows = db.prepare('SELECT payload FROM records ORDER BY idx DESC').all()
          for (const row of rows) {
            const record = JSON.parse(row.payload)
            if (filter !== undefined && !filter(record)) continue
            const text = pick(record)
            if (typeof text === 'string' && text !== '' && words.every(word => text.toLowerCase().includes(word))) {
              out.push(record)
              if (out.length >= limit) break
            }
          }
        }
      }
      for (let at = (entry.pendingPrepends?.length ?? 0) - 1; at >= 0 && out.length < limit; at -= 1) {
        const record = entry.pendingPrepends[at]
        if (filter !== undefined && !filter(record)) continue
        const text = pick(record)
        if (typeof text === 'string' && text !== '' && words.every(word => text.toLowerCase().includes(word))) out.push(record)
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
    // Exposed for diagnostics/tests.
    cachedBooks: () => books.size,
    cachedBytes: () => totalBytes,
  }
  rt.ledger = ledger
  const teardown = async () => {
    await flush()
    pool.closeAll()
  }
  rt.onHomeDrain?.(() => teardown())
  // What is still on its way to disk lands before the plugin goes.
  rt.ctx?.effect?.(() => () => teardown().finally(() => {
    books.clear()
    totalBytes = 0
  }), 'ds-bot: ledger')
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
