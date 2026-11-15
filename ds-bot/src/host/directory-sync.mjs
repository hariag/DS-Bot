import { closeSync, constants, fsyncSync, openSync } from 'node:fs'
import { open } from 'node:fs/promises'

// Node exposes file flushes on Windows, but opening a directory and calling fsync
// is not supported there. Keep the stronger directory-entry flush on POSIX; callers
// still flush each data file on Windows before publishing it.
export function syncDirectorySync(path, platform = process.platform) {
  if (platform === 'win32') return false
  const fd = openSync(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0))
  try { fsyncSync(fd) } finally { closeSync(fd) }
  return true
}

export async function syncDirectory(path, platform = process.platform) {
  if (platform === 'win32') return false
  const directory = await open(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0))
  try { await directory.sync() } finally { await directory.close() }
  return true
}
