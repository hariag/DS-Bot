import {test} from 'node:test'
import assert from 'node:assert/strict'
import {collectRecoveryOrigins as collect, collectRecoveryCandidates as candidates} from '../src/host/recovery-observation.mjs'
test('finds exact work in queue, old part, in-flight turn, and held turn',()=>{const inflight={queued:{queue:[{args:{exchangeId:'w',sessionId:'original'},resumeOrigins:['old']}]},turns:{running:{trigger:{work:'w'}}},heldTurns:{a:{sessionId:'held',record:{trigger:{exchangeId:'w'}}},b:{sessionId:'other',record:{trigger:{exchangeId:'different'}}}}};assert.deepEqual(collect({workId:'w',inflight}),['queue','original','old','running','held'])})
test('missing or ambiguous sources do not become inferred matches',()=>{assert.deepEqual(collect({workId:'w',inflight:{queued:{},turns:{running:{}},heldTurns:{a:{sessionId:'held',record:{}}}}}),[]);assert.equal(collect({workId:'w',inflight:{queued:{bad:{}},turns:{},heldTurns:{}}}),undefined)})
test('oversized histories fail closed',()=>assert.equal(collect({workId:'w',maxRecords:1,inflight:{queued:{q:[{args:{exchangeId:'other'}},{args:{exchangeId:'w'}}]},turns:{},heldTurns:{}}}),undefined))

test('candidate list finds request work once and marks unlinked held items incomplete',()=>assert.deepEqual(candidates({queued:{q:[{args:{role:'request',exchangeId:'w'}},{args:{role:'request',exchangeId:'w'}}]},turns:{},heldTurns:{a:{record:{}}}}),{ids:['w'],incomplete:true}))
