import assert from 'node:assert/strict'
import test from 'node:test'
import { installScheduledPatrol } from '../src/host/scheduled-patrol.js'

const time = '2026-11-18T15:00:00.000Z'
const templated = '你是项目经理。这是项目 aios 的定时兜底，不是全量重复巡检。核对待办。'
const release = '【v4 发版追踪 · 定时唤醒】核对交付，巡检发现的事项由已认领人更新。'
const item = (schedule_id, reminder_prompt) => ({ schedule_id, occurrence_at: time, reminder_prompt })
function single(entry) {
  return { id: 'delivery-id', source: { kind: 'schedule' }, content: [{ type: 'text', text: `[SCHEDULE REMINDER]\nschedule_id_json: ${JSON.stringify(entry.schedule_id)}\noccurrence_at: ${time}\nreminder_prompt_json: ${JSON.stringify(entry.reminder_prompt)}` }] }
}
function batch(entries) {
  return { id: 'batch-id', source: { kind: 'schedule' }, content: [{ type: 'text', text: `[SCHEDULE REMINDER BATCH]\nframing\nreminders_json: ${JSON.stringify(entries)}` }] }
}
function fixture(service) {
  const a = { id: 'a', members: ['both', 'a-only'] }, b = { id: 'b', members: ['both', 'b-only'] }
  const busy = new Set(), audit = [], hooks = new Map(), received = []
  const rt = { ctx: { on: (name, cb) => hooks.set(name, cb) }, state: { rooms: { a, b } }, roomOf: id => ({ a, b })[id],
    chatOwners: new Map([['p','both'], ['b-private','b-only']]), groupOwners: new Map([['member-a', { roomId: 'a', botId: 'both' }]]),
    pastOwners: new Map([['past-a', { roomId: 'a', botId: 'both' }]]), load: async () => {},
    roomBusyForPatrol: (room, ignored, opening) => busy.has(room.id) || (opening === 'wrong'), noteFailure: e => audit.push(e) }
  const refresh = installScheduledPatrol(rt, () => service)
  async function target(id) {
    const session = { id }
    const agent = { id, session, followup(msg) { assert.equal(this, agent); received.push(msg) }, whenIdle() { assert.equal(this, agent); return 'wait' }, get status() { assert.equal(this, agent); return 'idle' } }
    return hooks.get('schedule/resolve-agent')(id, async () => agent)
  }
  async function step(id, messages, extra = {}, admitted = [...messages, { id: 'context', source: { kind: 'runtime-context', form: 'snapshot' } }]) {
    return hooks.get('agent/pre-step')({ agent: { id }, messages, step: 1, turn: 4, ...extra }, async () => ({ kind: 'enter', messages: admitted }))
  }
  return { busy, rt, target, step, received, audit, refresh }
}

test('a fired patrol is consumed before wake, audited, and the next idle occurrence still runs', async () => {
  const stalled = new Promise(() => {})
  const { target, busy, received, audit, refresh } = fixture({ catalog: () => stalled }); refresh()
  const agent = await target('p'); busy.add('a')
  for (const prompt of ['巡检', '群巡检', templated, '你是 UI 设计师。此定时回合作为交接与设计质量的兜底，不是全量重复巡检。', '你是 BOSS 老板。此定时回合仅作为未闭环事项的低频兜底，不做全量角色巡检。', '【reviews 增量巡检】核对变更']) {
    agent.followup(single(item('patrol',prompt)))
  }
  assert.equal(received.length, 0); assert.equal(audit.length, 6)
  assert.deepEqual([audit[0].code, audit[0].roomId, audit[0].scheduleId, audit[0].messageId, audit[0].occurrenceAt], ['SCHEDULE_PATROL_SKIPPED','a','patrol','delivery-id',time])
  await agent.whenIdle(); assert.equal(agent.status, 'idle')
  busy.clear(); const message = single(item('patrol', templated)); agent.followup(message)
  assert.deepEqual(received, [message]); assert.equal(agent.whenIdle(), 'wait')
})

test('room root, member, archived member and private schedules are scoped to their groups', async () => {
  const { target, busy, received, audit } = fixture(); busy.add('b')
  for (const id of ['a', 'member-a', 'past-a', 'p', 'b-private', 'outside']) (await target(id)).followup(single(item('guard',templated)))
  assert.equal(received.length, 4); assert.deepEqual(audit.map(a => a.sessionId), ['p','b-private'])
})

test('mixed batches preserve the original ID, order and ordinary business items without a second send', async () => {
  const { target, busy, received, audit } = fixture(); busy.add('b'); const agent = await target('p')
  const before = item('do-first','Deploy build'), after = item('do-last',release)
  const original = batch([before, item('guard',templated), after]); agent.followup(original)
  assert.equal(agent.whenIdle(), 'wait')
  const sent = received[0]; assert.equal(sent.id, original.id); assert.equal(sent.source, original.source)
  assert.deepEqual(JSON.parse(sent.content[0].text.split('reminders_json: ')[1]), [before, after]); assert.equal(received.length, 1); assert.equal(audit.length, 1)
  const user = { ...original, source: { kind: 'user' } }, malformed = { ...original, content: [{ type: 'text', text: '[SCHEDULE REMINDER BATCH]\nreminders_json: []invalid' }] }
  agent.followup(user); agent.followup(malformed); assert.equal(received[1], user); assert.equal(received[2], malformed)
})

test('catalog-only titles are bound to the target and exact prompt and invalidated by edits', async () => {
  const rows = [{ id: 'n', prompt: 'Read updates', title: 'DSBOT-PATROL/project/role', target: { kind: 'session', sessionId: 'p' } }]
  const { target, busy, received, audit, refresh } = fixture({ catalog: async () => rows }); refresh(); await new Promise(setImmediate)
  busy.add('a'); const agent = await target('p'); agent.followup(single(item('n','Read updates')))
  ;(await target('member-a')).followup(single(item('n','Read updates'))); agent.followup(single(item('n',release)))
  rows[0] = { ...rows[0], title: 'Release follow-up' }; refresh(); await new Promise(setImmediate); agent.followup(single(item('n','Read updates')))
  assert.equal(audit.length, 1); assert.equal(received.length, 3)
})

test('a queued patrol rechecks activity at its first step and only a wholly skipped input marks an empty turn', async () => {
  const { target, busy, step, received, rt } = fixture(); const agent = await target('member-a'); const patrol = single(item('n',templated))
  agent.followup(patrol); assert.equal(received.length, 1); busy.add('a')
  assert.deepEqual((await step('member-a', [patrol])).messages, []); assert.equal(rt.consumeSkippedPatrolTurn('member-a',5), false); assert.equal(rt.consumeSkippedPatrolTurn('member-a',4), true); assert.equal(rt.consumeSkippedPatrolTurn('member-a',4), false)
  const user = { id: 'user', source: { kind: 'user' } }; assert.deepEqual((await step('member-a', [user, patrol])).messages.map(m=>m.id), ['user','context']); assert.equal(rt.consumeSkippedPatrolTurn('member-a',4), false)
  const addition = { id: 'reply', source: { kind: 'user' } }
  assert.deepEqual((await step('member-a', [patrol], {}, [patrol, addition])).messages, [addition]); assert.equal(rt.consumeSkippedPatrolTurn('member-a',4), false)
  const changed = { ...patrol, source: { kind: 'user' } }; assert.deepEqual((await step('member-a', [patrol], {}, [changed])).messages, [changed]); assert.equal(rt.consumeSkippedPatrolTurn('member-a',4), false)
  busy.clear(); assert.equal((await step('member-a', [patrol])).messages[0], patrol)
})
