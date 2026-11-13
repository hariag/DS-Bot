import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stageBoardImages, readBoardImage } from '../../src/host/board-images.js'
import pngjs from 'pngjs'
import jpeg from 'jpeg-js'

const makePng = color => pngjs.PNG.sync.write({ width:1, height:1, data:Buffer.from(color) }).toString('base64')
const png = makePng([0,0,0,255])
const photo = id => ({ uploadId: id, name: 'one.png', mediaType: 'image/png', data: png })
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'dsbot-board-image-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return { directory, taskId: 'task-1', assertWriteLock() {} }
}

test('multiple immutable images can be read only through their task references', t => {
  const f = fixture(t), refs = stageBoardImages({ ...f, images: [photo('first'), photo('second')] })
  assert.equal(refs.length, 2)
  assert.equal(readBoardImage({ ...f, reference: refs[1] }).data, png)
  assert.throws(() => readBoardImage({ ...f, taskId: 'different', reference: refs[1] }))
  assert.deepEqual(stageBoardImages({ ...f, images: [photo('first'), photo('second')] }), refs)
})

test('different bytes for an existing upload ID are rejected and original survives', t => {
  const f = fixture(t), [ref] = stageBoardImages({ ...f, images: [photo('first')] })
  assert.throws(() => stageBoardImages({ ...f, images: [{ ...photo('first'), data: makePng([255,0,0,255]) }] }), /different content/)
  assert.equal(readBoardImage({ ...f, reference: ref }).data, png)
})

test('PNG and JPEG are decoded; truncated, oversized, GIF and WebP are rejected', t => {
  const f = fixture(t), jpg = jpeg.encode({ width:1, height:1, data:Buffer.from([10,20,30,255]) }, 80).data.toString('base64')
  assert.equal(stageBoardImages({ ...f, images:[{ uploadId:'jpeg', name:'one.jpg', mediaType:'image/jpeg', data:jpg }] })[0].mediaType, 'image/jpeg')
  assert.throws(() => stageBoardImages({ ...f, images:[{ ...photo('truncated'), data:Buffer.from(png,'base64').subarray(0,8).toString('base64') }] }), /invalid/i)
  const oversized = Buffer.from(png, 'base64'); oversized.writeUInt32BE(5000,16)
  assert.throws(() => stageBoardImages({ ...f, images:[{ ...photo('large'), data:oversized.toString('base64') }] }), /dimension/i)
  const interlaced = Buffer.from(png, 'base64'); interlaced[28] = 1
  assert.throws(() => stageBoardImages({ ...f, images:[{ ...photo('interlaced'), data:interlaced.toString('base64') }] }), /interlaced/i)
  assert.throws(() => stageBoardImages({ ...f, images:[{ ...photo('gif'), mediaType:'image/gif', data:Buffer.from('GIF89a').toString('base64') }] }), /format/i)
  assert.throws(() => stageBoardImages({ ...f, images:[{ ...photo('webp'), mediaType:'image/webp', data:Buffer.from('RIFF0000WEBP').toString('base64') }] }), /format/i)
})

test('invalid MIME, duplicate IDs and malformed batches are refused before writing', t => {
  const f = fixture(t)
  assert.throws(() => stageBoardImages({ ...f, images: [photo('one'), { ...photo('two'), mediaType: 'image/jpeg' }] }), /format/)
  assert.throws(() => stageBoardImages({ ...f, images: [photo('one'), photo('one')] }), /Duplicate/)
  assert.throws(() => stageBoardImages({ ...f, images: [{ ...photo('one'), data: 'bad!' }] }), /Invalid/)
  assert.deepEqual(readdirSync(f.directory), [])
})

test('writer lock loss never returns a positive attachment reference', t => {
  const f = fixture(t); let calls = 0
  assert.throws(() => stageBoardImages({ ...f, assertWriteLock() { if (++calls === 2) throw new Error('lock lost') }, images: [photo('one')] }), /lock lost/)
  assert.deepEqual(readdirSync(f.directory), [])
})

test('a replaced or corrupt stored image cannot be read as a valid reference', t => {
  const f = fixture(t), [ref] = stageBoardImages({ ...f, images: [photo('one')] })
  const target = join(f.directory, readdirSync(f.directory)[0]); writeFileSync(target, 'broken')
  assert.throws(() => readBoardImage({ ...f, reference: ref }), /does not match/)
  rmSync(target); symlinkSync('/etc/passwd', target)
  assert.throws(() => readBoardImage({ ...f, reference: ref }))
})
