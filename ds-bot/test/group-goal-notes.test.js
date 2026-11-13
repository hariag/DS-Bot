import assert from 'node:assert/strict'
import { test } from 'node:test'
import { markTasks, passGoal, reworkGoal, taskGoal, taskNoteText } from '../src/host/goals.js'

const makeRoom = (note) => ({
  name: 'Ops',
  goal: { status: 'active', current: 0, revision: 0, nudges: 0, events: [], stages: [{ id: 's1', status: 'active', tasks: [{ id: 't1', botId: 'b', task: 'check', status: 'pending', ...(note === undefined ? {} : { note }) }] }] },
})
const member = name => name === 'Writer' ? { id: 'b', name } : undefined
const update = (room, args, now) => taskGoal(room, { bot: 'Writer', ...args }, 'a', member, ['Writer'], now)
const item = room => room.goal.stages[0].tasks[0]

test('automatic status changes retain notes, but status cycles do not make them current again', () => {
  const room = makeRoom()
  update(room, { note: 'blocked on evidence' }, 1_000)
  assert.deepEqual([item(room).statusVersion, item(room).noteStatusVersion, item(room).noteStatus, item(room).noteAt], [0, 0, 'pending', 1_000])
  assert.match(taskNoteText(item(room), 2_000), /note recorded for this status/)
  assert.equal(markTasks(room, 'b', 'pending', 'working', undefined, 2_000), true)
  assert.equal(item(room).note, 'blocked on evidence')
  assert.deepEqual([item(room).statusVersion, item(room).noteStatusVersion, item(room).statusUpdatedAt], [1, 0, 2_000])
  markTasks(room, 'b', 'working', 'reported', undefined, 3_000)
  markTasks(room, 'b', 'reported', 'pending', undefined, 4_000)
  assert.deepEqual([item(room).status, item(room).statusVersion, item(room).noteStatusVersion], ['pending', 3, 0])
  assert.match(taskNoteText(item(room), 5_000), /historical note from an earlier status/)
  update(room, { note: 'evidence received' }, 5_000)
  assert.deepEqual([item(room).noteStatusVersion, item(room).noteStatus, item(room).noteAt], [3, 'pending', 5_000])
})

test('automatic failure replaces the current note without losing its previous evidence', () => {
  const room = makeRoom()
  update(room, { status: 'working', note: 'evidence: team/events/check.json' }, 1_000)
  markTasks(room, 'b', 'working', 'pending', 'Could not finish', 2_000)
  assert.equal(item(room).note, 'Could not finish')
  assert.deepEqual(item(room).noteHistory, [{ text: 'evidence: team/events/check.json', status: 'working', statusVersion: 1, at: 1_000, supersededAt: 2_000 }])
  assert.deepEqual([item(room).statusVersion, item(room).noteStatusVersion, item(room).noteStatus], [2, 2, 'pending'])
  assert.match(taskNoteText(item(room), 3_000), /latest historical: evidence: team\/events\/check.json/)
})

test('unknown, inconsistent and future note metadata are not presented as current', () => {
  const base = { status: 'working', statusVersion: 2, note: 'evidence', noteStatus: 'working', noteStatusVersion: 2, noteAt: 2_000 }
  assert.match(taskNoteText({ status: 'working', note: 'legacy' }, 3_000), /provenance\/time unknown/)
  assert.match(taskNoteText({ ...base, noteAt: 4_000 }, 3_000), /provenance\/time unknown/)
  assert.match(taskNoteText({ ...base, noteStatusVersion: 3 }, 3_000), /provenance\/time unknown/)
  assert.match(taskNoteText({ ...base, noteStatus: 'pending' }, 3_000), /provenance\/time unknown/)
  assert.match(taskNoteText({ ...base, status: 'unexpected', noteStatus: 'unexpected' }, 3_000), /provenance\/time unknown/)
  for (const invalid of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, '2', null]) {
    assert.match(taskNoteText({ ...base, noteStatusVersion: invalid }, 3_000), /provenance\/time unknown/)
    assert.match(taskNoteText({ ...base, statusVersion: invalid }, 3_000), /provenance\/time unknown/)
  }
})

test('a conflict between task versions and same-task timestamps is marked for review', () => {
  const base = { status: 'working', statusVersion: 3, note: 'evidence', noteStatus: 'pending', noteStatusVersion: 2, noteAt: 2_000, statusUpdatedAt: 1_000 }
  assert.match(taskNoteText(base, 3_000), /time conflict.*unknown|unknown.*time conflict/)
  assert.match(taskNoteText({ ...base, noteAt: 1_000 }, 3_000), /historical note from an earlier status/)
  assert.match(taskNoteText({ ...base, noteStatus: 'working', noteStatusVersion: 3, noteAt: 500 }, 3_000), /time conflict.*unknown|unknown.*time conflict/)
  assert.match(taskNoteText({ ...base, noteStatus: 'working', noteStatusVersion: 3, noteAt: 1_000 }, 3_000), /note recorded for this status/)
  assert.match(taskNoteText({ ...base, statusUpdatedAt: 4_000 }, 3_000), /provenance\/time unknown/)
  assert.match(taskNoteText({ ...base, statusUpdatedAt: undefined }, 3_000), /status change time unknown/)
})

test('repeating a status does not invent a new status transition time', () => {
  const room = makeRoom()
  update(room, { status: 'working', note: 'first' }, 1_000)
  update(room, { status: 'working', note: 'confirmed later' }, 2_000)
  assert.deepEqual([item(room).statusVersion, item(room).statusUpdatedAt, item(room).noteAt], [1, 1_000, 2_000])
  const legacy = makeRoom('legacy')
  update(legacy, { status: 'pending' }, 3_000)
  assert.equal(item(legacy).statusUpdatedAt, undefined)
})

test('legacy notes remain identifiable as unknown and automatic history remains bounded', () => {
  const room = makeRoom('legacy evidence')
  markTasks(room, 'b', 'pending', 'working', 'first failure', 1_000)
  assert.deepEqual(item(room).noteHistory[0], { text: 'legacy evidence', supersededAt: 1_000 })
  for (let i = 0; i < 7; i++) {
    const from = item(room).status
    markTasks(room, 'b', from, from === 'working' ? 'pending' : 'working', `failure-${i}`, 2_000 + i)
  }
  assert.equal(item(room).noteHistory.length, 5)
  assert.equal(item(room).noteHistory.at(-1).text, 'failure-5')
})

test('explicit note clear and rework clear the current note and its metadata', () => {
  const room = makeRoom('old')
  markTasks(room, 'b', 'pending', 'working', 'failure', 1_000)
  update(room, { note: '' }, 2_000)
  for (const key of ['note', 'noteAt', 'noteStatus', 'noteStatusVersion', 'noteHistory']) assert.equal(item(room)[key], undefined)
  update(room, { note: 'retry evidence' }, 3_000)
  reworkGoal(room, { reason: 'retry' }, 'a', member, ['Writer'], 4_000)
  assert.equal(item(room).status, 'pending')
  for (const key of ['note', 'noteAt', 'noteStatus', 'noteStatusVersion', 'noteHistory']) assert.equal(item(room)[key], undefined)
})

test('passing a stage changes the task version without representing an old note as current', () => {
  const room = makeRoom()
  update(room, { status: 'reported', note: 'reported, awaiting acceptance' }, 1_000)
  const before = item(room).statusVersion
  passGoal(room, { evidence: 'verified' }, 'a', 2_000)
  assert.deepEqual([item(room).status, item(room).statusVersion, item(room).noteStatusVersion], ['done', before + 1, before])
})
