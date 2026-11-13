import { parentPort, workerData } from 'node:worker_threads'
import { createHash } from 'node:crypto'
import { lstatSync } from 'node:fs'
import { join } from 'node:path'
import { boardImageName, readBoardImage, stageBoardImages } from './board-images.js'

const stat = path => {
  const value = lstatSync(path)
  if (!value.isFile() || value.isSymbolicLink() || (value.mode & 0o077) || value.uid !== process.getuid()) throw new Error('Image file is unavailable')
  return { dev:value.dev, ino:value.ino, size:value.size, mtimeMs:value.mtimeMs }
}
let identity, meta
try {
  const body = JSON.parse(new TextDecoder('utf-8', { fatal:true }).decode(workerData.bytes))
  const payload = body?.payload
  if (body?.endpoint !== 'board-upload' || !payload || typeof payload !== 'object' || typeof payload.taskId !== 'string' || !payload.taskId || payload.taskId.length > 256 || /[\x00-\x1f]/.test(payload.taskId)) throw new Error('Invalid image request')
  const identityPayload = { ...payload }
  if (Array.isArray(payload.images)) identityPayload.images = payload.images.map(image => image && typeof image === 'object' && typeof image.data === 'string'
    ? { ...image, data:{ sha256:createHash('sha256').update(image.data).digest('hex') } } : image)
  identity = { endpoint:'board-upload', payload:identityPayload }
  const { images: _, ...rest } = payload; meta = rest
  const references = stageBoardImages({ directory:workerData.stagingDir, taskId:payload.taskId, images:payload.images, assertWriteLock() {} })
  const files = references.map(reference => {
    const name = boardImageName(payload.taskId, reference.id)
    const staged = stat(join(workerData.stagingDir, name)); let existing
    try {
      const path = join(workerData.imageDir, name)
      readBoardImage({ directory:workerData.imageDir, taskId:payload.taskId, reference })
      existing = stat(path)
    } catch (error) { if (error.code !== 'ENOENT') throw error }
    return { name, staged, ...(existing ? { existing } : {}) }
  })
  parentPort.postMessage({ ok:true, identity, meta, references, files })
} catch (error) {
  if (error?.code === 'bot/invalid' && identity && meta) parentPort.postMessage({ ok:false, rejected:true, identity, meta, message:String(error.message).slice(0, 500) })
  else parentPort.postMessage({ ok:false, message:'Image preparation failed', stack:String(error?.stack ?? '').slice(0, 2000) })
}
