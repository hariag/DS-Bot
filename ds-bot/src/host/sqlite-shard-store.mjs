// Shared SQLite shard store & crash-safe log compaction helpers for DS Bot.
// Keeps hot JSONL tails small on disk while archiving older prefix records into
// bounded, read-friendly SQLite shard files with zero -wal/-shm sidecars.
import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const MANIFEST_FILE = 'manifest.json'

export function readManifest(shardsDir) {
  try {
    return JSON.parse(readFileSync(join(shardsDir, MANIFEST_FILE), 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null
    throw error
  }
}

export function writeManifestAtomic(shardsDir, manifest) {
  mkdirSync(shardsDir, { recursive: true })
  const target = join(shardsDir, MANIFEST_FILE)
  const temp = `${target}.${process.pid}.tmp`
  writeFileSync(temp, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  renameSync(temp, target)
}

export function manifestStamp(shardsDir) {
  try {
    const st = statSync(join(shardsDir, MANIFEST_FILE))
    return `${st.ino}:${st.size}:${st.mtimeMs}`
  } catch {
    return ''
  }
}

export function sliceAfterLines(text, count) {
  if (!count || count <= 0) return text
  let pos = 0
  let remaining = count
  while (remaining > 0) {
    const nl = text.indexOf('\n', pos)
    if (nl === -1) return ''
    pos = nl + 1
    remaining -= 1
  }
  return text.slice(pos)
}

// Reads up to the last `maxBytes` of a file, dropping any partial leading line
// when starting mid-file.
export function readTailBytes(filePath, maxBytes) {
  let fd
  try {
    fd = openSync(filePath, 'r')
  } catch (error) {
    if (error?.code === 'ENOENT') return ''
    throw error
  }
  try {
    const size = fstatSync(fd).size
    if (size === 0) return ''
    const start = Math.max(0, size - maxBytes)
    const buffer = Buffer.alloc(size - start)
    for (let at = 0; at < buffer.length;) {
      const read = readSync(fd, buffer, at, buffer.length - at, start + at)
      if (read === 0) break
      at += read
    }
    const text = buffer.toString('utf8')
    if (start === 0) return text
    const firstNl = text.indexOf('\n')
    return firstNl === -1 ? '' : text.slice(firstNl + 1)
  } finally {
    closeSync(fd)
  }
}

// Parse JSON lines and locate character offsets so compaction can split cleanly
// between `prefixRecords` and the exact surviving `remainingTailText`.
export function scanJsonLines(text) {
  const entries = []
  let lineStart = 0
  let lineNumber = 0
  for (let i = 0; i <= text.length; i += 1) {
    if (i < text.length && text.charCodeAt(i) !== 10) continue
    const rawLine = text.slice(lineStart, i)
    if (rawLine !== '') {
      try {
        const record = JSON.parse(rawLine)
        if (record !== null && typeof record === 'object') {
          entries.push({ record, startChar: lineStart, startLine: lineNumber })
        }
      } catch {
        // Half-written or foreign line.
      }
    }
    lineStart = i + 1
    lineNumber += 1
  }
  return entries
}

export function createShardPool({ maxOpen = 4 } = {}) {
  const handles = new Map()

  const closeDb = (db) => {
    try { db?.close() } catch {}
  }

  const openReadOnly = (filePath) => {
    const db = new DatabaseSync(filePath, { readOnly: true })
    try {
      db.exec('PRAGMA query_only = ON')
      return db
    } catch (error) {
      closeDb(db)
      throw error
    }
  }

  const getReadOnly = (filePath) => {
    const existing = handles.get(filePath)
    if (existing !== undefined) {
      handles.delete(filePath)
      handles.set(filePath, existing)
      return existing
    }
    const db = openReadOnly(filePath)
    handles.set(filePath, db)
    while (handles.size > maxOpen) {
      const oldestKey = handles.keys().next().value
      const oldestDb = handles.get(oldestKey)
      handles.delete(oldestKey)
      closeDb(oldestDb)
    }
    return db
  }

  return {
    getReadOnly,
    read(filePath, query, retain = true) {
      if (retain) return query(getReadOnly(filePath))
      const db = openReadOnly(filePath)
      try { return query(db) } finally { closeDb(db) }
    },
    closeFile(filePath) {
      const db = handles.get(filePath)
      if (db === undefined) return
      handles.delete(filePath)
      closeDb(db)
    },
    closeUnder(dirPrefix) {
      const prefix = dirPrefix.endsWith('/') || dirPrefix.endsWith('\\') ? dirPrefix : `${dirPrefix}`
      for (const [key, db] of [...handles.entries()]) {
        if (key === prefix || key.startsWith(`${prefix}/`) || key.startsWith(`${prefix}\\`)) {
          handles.delete(key)
          closeDb(db)
        }
      }
    },
    closeAll() {
      for (const db of handles.values()) closeDb(db)
      handles.clear()
    },
  }
}

export function recoverPendingTrim(hotPath, shardsDir, { writable = true } = {}) {
  const manifest = readManifest(shardsDir)
  if (!manifest?.pendingTrim) return { manifest, skipLines: 0 }
  let st = null
  try { st = statSync(hotPath) } catch {}
  if (!st || String(st.ino) !== String(manifest.pendingTrim.oldInode)) {
    if (writable) {
      manifest.pendingTrim = null
      writeManifestAtomic(shardsDir, manifest)
    }
    return { manifest, skipLines: 0 }
  }
  if (!writable) return { manifest, skipLines: manifest.pendingTrim.prefixLines }
  const text = readFileSync(hotPath, 'utf8')
  const tail = sliceAfterLines(text, manifest.pendingTrim.prefixLines)
  const temp = `${hotPath}.${process.pid}.trim.tmp`
  writeFileSync(temp, tail, 'utf8')
  renameSync(temp, hotPath)
  manifest.pendingTrim = null
  writeManifestAtomic(shardsDir, manifest)
  return { manifest, skipLines: 0 }
}

function openWritableShard(filePath, schemaSql) {
  const db = new DatabaseSync(filePath)
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;')
  db.exec(schemaSql)
  return db
}

function finalizeShardClose(db) {
  db.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode = DELETE;')
  db.close()
}

export function compactRecordsToShards({
  hotPath,
  shardsDir,
  prefixRecords,
  prefixRawLines,
  remainingTailText,
  oldInode,
  maxShardBytes,
  maxShardRows,
  schemaSql,
  tableName,
  insertRows,
  updateMeta,
  pool,
}) {
  if (!Array.isArray(prefixRecords) || prefixRecords.length === 0) {
    return readManifest(shardsDir)
  }
  mkdirSync(shardsDir, { recursive: true })
  const manifest = readManifest(shardsDir) ?? { version: 1, nextShard: 1, pendingTrim: null, shards: [] }

  let cursor = 0
  while (cursor < prefixRecords.length) {
    let target = manifest.shards.at(-1)
    let isNew = false
    if (!target || target.sealed || target.bytes >= maxShardBytes || target.count >= maxShardRows) {
      const id = manifest.nextShard
      manifest.nextShard += 1
      target = {
        id,
        file: `shard-${String(id).padStart(6, '0')}.sqlite`,
        count: 0,
        committedIdx: 0,
        bytes: 0,
        sealed: false,
      }
      isNew = true
    }

    const shardPath = join(shardsDir, target.file)
    pool?.closeFile(shardPath)
    const capacity = Math.max(1, maxShardRows - target.count)
    const batch = prefixRecords.slice(cursor, cursor + capacity)
    cursor += batch.length

    const db = openWritableShard(shardPath, schemaSql)
    try {
      db.exec('BEGIN IMMEDIATE')
      try {
        if (!isNew) {
          db.prepare(`DELETE FROM ${tableName} WHERE idx > ?`).run(target.committedIdx ?? 0)
        }
        insertRows(db, batch)
        const maxRow = db.prepare(`SELECT COALESCE(MAX(idx), 0) AS m FROM ${tableName}`).get()
        target.committedIdx = maxRow?.m ?? 0
        updateMeta(db, target, batch)
        db.exec('COMMIT')
      } catch (error) {
        try { db.exec('ROLLBACK') } catch {}
        throw error
      }
      finalizeShardClose(db)
    } catch (error) {
      try { db.close() } catch {}
      throw error
    }

    target.bytes = statSync(shardPath).size
    if (target.bytes >= maxShardBytes || target.count >= maxShardRows) {
      target.sealed = true
    }
    if (isNew) manifest.shards.push(target)
  }

  manifest.pendingTrim = { prefixLines: prefixRawLines, oldInode: String(oldInode) }
  writeManifestAtomic(shardsDir, manifest)

  const tempHot = `${hotPath}.${process.pid}.compact.tmp`
  writeFileSync(tempHot, remainingTailText, 'utf8')
  renameSync(tempHot, hotPath)

  manifest.pendingTrim = null
  writeManifestAtomic(shardsDir, manifest)
  return manifest
}

export function prependRecordsToShards({
  shardsDir,
  records,
  schemaSql,
  tableName = 'records',
  insertRows,
  updateMeta,
}) {
  mkdirSync(shardsDir, { recursive: true })
  const manifest = readManifest(shardsDir) ?? { version: 1, nextShard: 1, pendingTrim: null, shards: [] }
  const id = manifest.nextShard
  manifest.nextShard += 1
  const shard = {
    id,
    file: `shard-${String(id).padStart(6, '0')}.sqlite`,
    count: 0,
    committedIdx: 0,
    bytes: 0,
    sealed: true,
  }
  const shardPath = join(shardsDir, shard.file)
  const db = openWritableShard(shardPath, schemaSql)
  try {
    db.exec('BEGIN IMMEDIATE')
    try {
      insertRows(db, records)
      const maxRow = db.prepare(`SELECT COALESCE(MAX(idx), 0) AS m FROM ${tableName}`).get()
      shard.committedIdx = maxRow?.m ?? 0
      updateMeta(db, shard, records)
      db.exec('COMMIT')
    } catch (error) {
      try { db.exec('ROLLBACK') } catch {}
      throw error
    }
    finalizeShardClose(db)
  } catch (error) {
    try { db.close() } catch {}
    throw error
  }
  shard.bytes = statSync(shardPath).size
  manifest.shards.unshift(shard)
  writeManifestAtomic(shardsDir, manifest)
  return manifest
}
