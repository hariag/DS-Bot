import test from 'node:test'
import assert from 'node:assert/strict'
import { closeSync, mkdtempSync, openSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isPrivateDirectory, isPrivateFile, isPrivatePath } from '../src/host/private-storage.mjs'
import { syncDirectory, syncDirectorySync } from '../src/host/directory-sync.mjs'

const stat = ({ directory = false, file = false, symlink = false, mode = 0o100600, uid = 1000, dev = 1, ino = 1 } = {}) => ({
  isDirectory: () => directory, isFile: () => file, isSymbolicLink: () => symlink, mode, uid, dev, ino,
})

test('POSIX private storage checks owner, mode, type and absolute path', () => {
  assert.equal(isPrivatePath('/tmp/private', stat({ directory: true, mode: 0o40700, uid: 42 }), 'directory', { platform: 'linux', uid: 42 }), true)
  assert.equal(isPrivatePath('/tmp/private', stat({ directory: true, mode: 0o40750, uid: 42 }), 'directory', { platform: 'linux', uid: 42 }), false)
  assert.equal(isPrivatePath('/tmp/private', stat({ directory: true, mode: 0o40700, uid: 43 }), 'directory', { platform: 'linux', uid: 42 }), false)
  assert.equal(isPrivatePath('relative', stat({ directory: true, mode: 0o40700, uid: 42 }), 'directory', { platform: 'linux', uid: 42 }), false)
  assert.equal(isPrivatePath('/tmp/private', stat({ directory: true, mode: 0o40700, uid: 42, symlink: true }), 'directory', { platform: 'linux', uid: 42 }), false)
})

test('Windows privacy comes from the ACL verifier, not POSIX uid or group mode bits', () => {
  const path = 'C:\\Users\\runner\\AppData\\Local\\Temp\\private'
  const file = stat({ file: true, mode: 0o100666, uid: undefined })
  const dir = stat({ directory: true, mode: 0o40777, uid: undefined })
  let observed = file
  const inspectPath = candidate => candidate === path ? observed : undefined
  assert.equal(isPrivateFile(path, file, { platform: 'win32', checkWindowsAcl: candidate => candidate === path, inspectPath }), true)
  assert.equal(isPrivateFile(path, file, { platform: 'win32', checkWindowsAcl: () => false }), false)
  observed = dir
  assert.equal(isPrivatePath(path, dir, 'directory', { platform: 'win32', checkWindowsAcl: () => true, inspectPath }), true)
  assert.equal(isPrivatePath(path, stat({ directory: true, symlink: true }), 'directory', { platform: 'win32', checkWindowsAcl: () => true, inspectPath }), false)
})

test('Windows directory flushes are skipped while POSIX directory flushes remain', async t => {
  const path = mkdtempSync(join(tmpdir(), 'ds-bot-sync-'))
  t.after(() => rmSync(path, { recursive: true, force: true }))
  assert.equal(syncDirectorySync('C:\\temp\\directory', 'win32'), false)
  assert.equal(await syncDirectory('C:\\temp\\directory', 'win32'), false)
  if (process.platform !== 'win32') {
    assert.equal(syncDirectorySync(path), true)
    assert.equal(await syncDirectory(path), true)
  }
})

test('exported storage helpers inspect real POSIX temporary directories and files', t => {
  if (process.platform === 'win32') return t.skip('This test checks POSIX mode bits')
  const root = mkdtempSync(join(tmpdir(), 'ds-bot-private-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  assert.equal(isPrivateDirectory(root), true)
  const file = join(root, 'private')
  const fd = openSync(file, 'wx', 0o600)
  closeSync(fd)
  assert.equal(isPrivateFile(file), true)
})
