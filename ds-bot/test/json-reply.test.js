// Memory replies keep their JSON even when the model wraps it in prose or fences.
import { readChanges } from '../src/host/json-reply.mjs'
import { parseReview } from '../src/host/memory-entries.js'
import { ROOM_NOTICE_MAX } from '../src/host/constants.js'
import { readFileSync } from 'node:fs'

let failures = 0
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); if (!ok) failures += 1 }

const change = { op: 'add', text: 'the user prefers plain replies' }
check('plain object', JSON.stringify(readChanges(JSON.stringify({ changes: [change] }))) === JSON.stringify([change]))
check('fenced json', JSON.stringify(readChanges('```json\n{"changes":[' + JSON.stringify(change) + ']}\n```')) === JSON.stringify([change]))
check('prose before and after', JSON.stringify(readChanges('Let me think.\n{"changes":[' + JSON.stringify(change) + ']}\nThat is all.')) === JSON.stringify([change]))
check('multiple objects, last wins', JSON.stringify(readChanges('{"changes":[]}\nnote\n{"changes":[' + JSON.stringify(change) + ']}')) === JSON.stringify([change]))
check('bare array', JSON.stringify(readChanges('[' + JSON.stringify(change) + ']')) === JSON.stringify([change]))
check('braces inside strings', JSON.stringify(readChanges('{"changes":[{"op":"add","text":"uses {braces} in text"}]}')) === JSON.stringify([{ op: 'add', text: 'uses {braces} in text' }]))
check('prose only refused', readChanges('Let me analyze the messages. Nothing worth keeping.') === undefined)
check('truncated json refused', readChanges('{"changes":[{"op":"add","text":"cut') === undefined)
check('empty object refused', readChanges('{"other":1}') === undefined)

const review = parseReview('Let me review.\n{"changes":[' + JSON.stringify(change) + ',{"op":"remove","entry":3},{"op":"nonsense"}]}')
check('parseReview keeps valid, sets aside invalid', review?.changes.length === 2 && review?.leftOut.length === 1, JSON.stringify(review))
check('parseReview prose undefined', parseReview('Nothing to keep.') === undefined)
check('notice limit is 4000', ROOM_NOTICE_MAX === 4000, String(ROOM_NOTICE_MAX))
const bundle = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
check('client input allows 4000', bundle.includes('maxLength: 4e3'))
process.exit(failures ? 1 : 0)