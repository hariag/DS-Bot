import { parentPort, workerData } from 'node:worker_threads'
import { readBoardImage } from './board-images.js'
try {
  const value = readBoardImage(workerData)
  parentPort.postMessage({ ok:true, value })
} catch (error) { parentPort.postMessage({ ok:false, message:String(error?.message ?? 'Image unavailable').slice(0, 500) }) }
