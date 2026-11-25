import test from 'node:test'
import assert from 'node:assert/strict'
import { createPersonalBoardSchedule, PERSONAL_POLL_SECONDS, PERSONAL_SCHEDULE_TITLE } from '../src/host/personal-board-schedule.mjs'
import { install as installSchedules } from '../src/host/schedules.js'
import { fakeContext } from './fake-ctx.js'

test('personal board schedule binds to active Main Bot, tracks part moves and preserves pauses', async t => {
  const rows = new Map()
  let seq = 0, revision = 0
  const host = {
    async create(request) {
      const id = 'sched-' + ++seq
      const row = { id, title: request.title, prompt: request.prompt, target: request.target,
        kind: request.timing.kind, everySeconds: request.timing.every_seconds, status: 'active', updatedAt: String(++revision) }
      rows.set(id, row)
      return structuredClone(row)
    },
    catalog: async () => structuredClone([...rows.values()]),
    async edit({ id, action, expectedUpdatedAt, patch }) {
      const row = rows.get(id)
      if (row?.updatedAt !== expectedUpdatedAt) return { code: 'schedule_conflict' }
      if (action === 'delete') { rows.delete(id); return { id, deleted: true } }
      Object.assign(row, Object.fromEntries(Object.entries(patch).filter(([k]) => k !== 'timing' && k !== 'active')))
      if (patch.timing) Object.assign(row, { kind: patch.timing.kind, everySeconds: patch.timing.every_seconds })
      if (patch.active !== undefined) row.status = patch.active ? 'active' : 'paused'
      row.updatedAt = String(++revision)
      return structuredClone(row)
    },
  }
  let currentChat = 'chat-pm-1'
  const drains = []
  const rt = {
    state: { mainBotIds: ['pm'], bots: { pm: { id: 'pm', private: false }, alt: { id: 'alt', private: false } }, rooms: {} },
    load: async () => {},
    readOnly: () => undefined,
    homeLockVersion: () => 1,
    botOf: id => rt.state.bots[id],
    chatOf: id => id === 'pm' ? currentChat : 'chat-alt',
    save: async () => {},
    onSaved: () => () => {},
    onHomeDrain: fn => drains.push(fn),
    warn: () => {},
  }
  const mgr = createPersonalBoardSchedule(rt, () => host)
  t.after(async () => { for (const fn of drains) await fn() })
  await mgr.reconcile()
  assert.equal(rows.size, 1)
  const [row] = rows.values()
  assert.equal(row.title, PERSONAL_SCHEDULE_TITLE)
  assert.equal(row.everySeconds, PERSONAL_POLL_SECONDS)
  assert.equal(row.target.sessionId, 'chat-pm-1')
  assert.match(row.prompt, /每 30 分钟回看一次用户个人任务看板/)
  assert.match(row.prompt, /简体中文.*UTF-8.*CST（Asia\/Shanghai，UTC\+08:00）/)
  assert.match(row.prompt, /子任务与父任务联动状态/)

  currentChat = 'chat-pm-2'
  await mgr.reconcile()
  assert.equal(row.target.sessionId, 'chat-pm-2')
  row.status = 'paused'
  row.prompt = [
    '主机器人每 30 分钟回看一次用户个人任务看板（board_task list/show，涵盖 personal:user 及指派给用户的待办或待验收项）。用简体中文沟通与记录，文本采用 UTF-8，时间用北京时间 CST（Asia/Shanghai，UTC+08:00）。',
    '核对每张未结卡的编号唯一性、负责人、状态、阻碍、子任务与父任务联动状态及截止时间；未在看板注册的任务不得推进，完成前必须同步最新状态回原卡。',
    '对已分派给机器人且条件齐全的任务，通过 message_bot 推动责任人执行或独立验收并在原卡 board_task comment 留痕；对受阻、逾期或需要用户本人确认与决断的卡片，按优先级汇总清单（任务编号、状态、待决点与建议选项）提醒用户推进。无未结事项或无新增变化时静默结束。',
  ].join('\n') + ` [DS-Bot personal board timer ${rt.state.personalBoardSchedule.token}]\n自定义说明`
  await mgr.reconcile()
  assert.equal(row.status, 'paused')
  assert.equal(rt.state.personalBoardSchedule.paused, true)
  assert.equal(rt.state.personalBoardSchedule.id, row.id)
  assert.match(row.prompt, /稳定 request_id/)
  assert.ok(row.prompt.endsWith('\n自定义说明'))
  const updated = row.updatedAt
  await mgr.reconcile()
  assert.equal(row.updatedAt, updated)

  rt.state.mainBotIds = []
  await mgr.reconcile()
  assert.equal(rows.size, 0)
  assert.equal(rt.state.personalBoardSchedule, undefined)
})

test('schedules hook skips DSBOT-PERSONAL/user tick when personal board has no open tasks and delivers when open', async t => {
  const drains = new Set(), delivered = []
  let hasOpen = false
  const row = { id: 'sched-p', title: PERSONAL_SCHEDULE_TITLE, prompt: 'review [DS-Bot personal board timer tok]',
    target: { kind: 'session', sessionId: 'chat-main' }, kind: 'every', everySeconds: 1800, status: 'active', updatedAt: '1' }
  const ctx = fakeContext({ services: { schedule: {
    catalog: async () => [structuredClone(row)],
    create: async () => { throw new Error('unexpected create') },
    edit: async () => ({ id: row.id }),
  } } })
  const rt = {
    ctx,
    state: { mainBotIds: ['main'], bots: { main: { id: 'main', private: false } }, rooms: {},
      personalBoardSchedule: { id: row.id, token: 'tok', target: 'chat-main' } },
    chatOwners: new Map([['chat-main', 'main']]),
    groupOwners: new Map(), pastOwners: new Map(),
    roomOf: () => undefined,
    botOf: id => rt.state.bots[id],
    chatOf: () => 'chat-main',
    isBotSession: () => true,
    load: async () => {}, save: async () => {}, readOnly: () => undefined, homeLockVersion: () => 1,
    onSaved: () => () => {},
    onHomeDrain: fn => { drains.add(fn); return () => drains.delete(fn) },
    warn: () => {},
    hasOpenPersonalBoardTasks: () => hasOpen,
  }
  installSchedules(rt)
  t.after(async () => { await Promise.all([...drains].map(fn => fn())); await ctx.dispose() })
  const agent = { followup: msg => delivered.push(msg), whenIdle: async () => {} }
  const reminder = {
    source: { kind: 'schedule' },
    content: [{ type: 'text', text: `[SCHEDULE REMINDER]\nschedule_id_json: ${JSON.stringify(row.id)}\noccurrence_at: 2026-11-25T14:00:00+08:00\nreminder_prompt_json: ${JSON.stringify(row.prompt)}` }],
  }
  const [resolve] = ctx.listeners.get('schedule/resolve-agent')
  const wrappedEmpty = await resolve('chat-main', async () => agent)
  wrappedEmpty.followup(reminder)
  assert.equal(delivered.length, 0)
  hasOpen = true
  const wrappedOpen = await resolve('chat-main', async () => agent)
  wrappedOpen.followup(reminder)
  assert.equal(delivered.length, 1)
})
