import { createHash, randomUUID } from 'node:crypto'
import { closeSync, fstatSync, fsyncSync, linkSync, lstatSync, openSync, readFileSync, unlinkSync, writeFileSync, constants } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import pngjs from 'pngjs'
import jpeg from 'jpeg-js'

const MAX_BYTES = 5 * 1024 * 1024
const MAX_BATCH = 10
const MAX_DIMENSION = 4096
const MAX_PIXELS = 16_000_000
const idPattern = /^[A-Za-z0-9_-]{1,128}$/
const digest = value => createHash('sha256').update(value).digest('hex')
const invalid = message => Object.assign(new Error(message), { code: 'bot/invalid' })
const nameOf = (taskId, uploadId) => digest(`${taskId}\0${uploadId}`)
export const boardImageName = nameOf

function typeOf(data) {
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png'
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg'
  return undefined
}

// Called in an isolated worker, never on the DSH event loop. Interlaced PNG is
// rejected because this pngjs version inflates it without a decoded-size limit.
function validateImage(bytes, mediaType) {
  try {
    let width, height
    if (mediaType === 'image/png') {
      if (bytes.length < 33 || bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii',12,16) !== 'IHDR') throw new Error('unsupported PNG')
      if (bytes[28] !== 0) throw invalid('Interlaced PNG is not supported; use non-interlaced PNG or JPEG')
      width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20)
      if (!width || !height || width > MAX_DIMENSION || height > MAX_DIMENSION || width * height > MAX_PIXELS) throw new Error('image dimensions')
      const decoded = pngjs.PNG.sync.read(bytes, { checkCRC:true })
      if (decoded.width !== width || decoded.height !== height || decoded.data.length !== width * height * 4) throw new Error('invalid PNG')
    } else if (mediaType === 'image/jpeg') {
      const decoded = jpeg.decode(bytes, { useTArray:true, tolerantDecoding:false, maxResolutionInMP:16, maxMemoryUsageInMB:128 })
      width = decoded.width; height = decoded.height
      if (!width || !height || width > MAX_DIMENSION || height > MAX_DIMENSION || width * height > MAX_PIXELS || decoded.data.length !== width * height * 4) throw new Error('image dimensions')
    } else throw new Error('unsupported image')
  } catch (error) { if (error?.code === 'bot/invalid') throw error; throw invalid('Image is invalid, unsupported, or exceeds dimension limits') }
}

function checkDir(dir) {
  if (!isAbsolute(dir)) throw invalid('Image directory must be absolute')
  const stat = lstatSync(dir)
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) || stat.uid !== process.getuid()) throw invalid('Image directory is not private')
  return stat
}

function decode(image) {
  if (!image || !idPattern.test(image.uploadId ?? '') || typeof image.data !== 'string'
    || image.data.length > Math.ceil(MAX_BYTES / 3) * 4 || image.data.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(image.data)) throw invalid('Invalid image data')
  const bytes = Buffer.from(image.data, 'base64')
  if (!bytes.length || bytes.length > MAX_BYTES || bytes.toString('base64') !== image.data) throw invalid('Image size or encoding is invalid')
  const mediaType = typeOf(bytes)
  if (!mediaType || image.mediaType !== mediaType) throw invalid('Image format does not match its content')
  validateImage(bytes, mediaType)
  if (typeof image.name !== 'string' || !image.name.trim() || Buffer.byteLength(image.name) > 255 || /[\\/\x00-\x1f\x7f]/.test(image.name)) throw invalid('Invalid image name')
  return { bytes, id: image.uploadId, sha256: digest(bytes), mediaType, size: bytes.length, name: image.name }
}

function readFileExact(path, limit = MAX_BYTES) {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const stat = fstatSync(fd), pathStat = lstatSync(path)
    if (!stat.isFile() || pathStat.isSymbolicLink() || pathStat.dev !== stat.dev || pathStat.ino !== stat.ino
      || (stat.mode & 0o077) || stat.uid !== process.getuid() || stat.size > limit) throw invalid('Image file is unavailable')
    return readFileSync(fd)
  } finally { closeSync(fd) }
}

/** Persist immutable image bytes before a single task-journal attachment commit. */
export function stageBoardImages({ directory, taskId, images, assertWriteLock }) {
  if (typeof taskId !== 'string' || !taskId || taskId.length > 256 || typeof assertWriteLock !== 'function') throw invalid('Invalid image request')
  if (!Array.isArray(images) || !images.length || images.length > MAX_BATCH) throw invalid('Choose 1 to 10 images')
  if (images.reduce((total, image) => total + (typeof image?.data === 'string' ? image.data.length : 0), 0) > Math.ceil(20 * 1024 * 1024 / 3) * 4 + MAX_BATCH * 4) throw invalid('Images exceed the 20 MiB batch limit')
  const entries = images.map(decode)
  if (entries.reduce((total, entry) => total + entry.size, 0) > 20 * 1024 * 1024) throw invalid('Images exceed the 20 MiB batch limit')
  if (new Set(entries.map(image => image.id)).size !== entries.length) throw invalid('Duplicate upload ID')
  const directoryIdentity = checkDir(directory)
  for (const entry of entries) {
    assertWriteLock()
    const now = checkDir(directory)
    if (now.dev !== directoryIdentity.dev || now.ino !== directoryIdentity.ino) throw invalid('Image directory changed')
    const destination = join(directory, nameOf(taskId, entry.id))
    const temporary = join(directory, `.upload-${randomUUID()}`)
    let fd
    try {
      fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
      writeFileSync(fd, entry.bytes); fsyncSync(fd); closeSync(fd); fd = undefined
      assertWriteLock()
      try { linkSync(temporary, destination) } catch (error) {
        if (error.code !== 'EEXIST') throw error
        const existing = readFileExact(destination)
        if (digest(existing) !== entry.sha256 || existing.length !== entry.size) throw invalid('Upload ID already belongs to different content')
      }
      const dfd = openSync(directory, constants.O_RDONLY)
      try { fsyncSync(dfd) } finally { closeSync(dfd) }
    } finally {
      if (fd !== undefined) closeSync(fd)
      try { unlinkSync(temporary) } catch (error) { if (error.code !== 'ENOENT') throw error }
    }
  }
  return entries.map(({ bytes: _, ...reference }) => reference)
}

/** Read bytes only after the host has authorized and resolved a journal reference. */
export function readBoardImage({ directory, taskId, reference }) {
  checkDir(directory)
  if (typeof taskId !== 'string' || !taskId || !reference || !idPattern.test(reference.id ?? '') || !/^[a-f0-9]{64}$/.test(reference.sha256 ?? '')) throw invalid('Invalid image reference')
  const bytes = readFileExact(join(directory, nameOf(taskId, reference.id)))
  if (bytes.length !== reference.size || digest(bytes) !== reference.sha256 || typeOf(bytes) !== reference.mediaType) throw invalid('Image content does not match the task record')
  return { mediaType: reference.mediaType, data: bytes.toString('base64') }
}
