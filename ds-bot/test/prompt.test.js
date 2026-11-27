import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import { manualDirectory } from '../src/host/manual-skills.js'
import { install } from '../src/host/prompt.js'
import { fakeContext } from './fake-ctx.js'
import { install as installBuiltinPacks, BUILTIN_PACKS } from '../src/host/builtin-packs.js'

function start(instructions) {
  const ctx = fakeContext()
  const bots = new Map([
    ['main', { name: 'Chief', instructions }],
    ['worker', { name: 'Dev', instructions: instructions ?? 'Check files.' }],
  ])
  install({
    ctx,
    selfOf: id => id === 'group-worker' ? 'worker' : id,
    botOf: id => bots.get(id),
    roomOf: id => id === 'room' ? {} : undefined,
    isMain: id => id === 'main',
  })
  const prompt = id => [
    ctx.sections.get('bot-team-rules').text({ agent: { id } }),
    ctx.sections.get('bot-identity').text({ agent: { id } }),
  ].filter(Boolean).join('\n\n')
  return { ctx, prompt }
}

test('v1.2 roles keep their full instructions once and receive only their available team powers', t => {
  const instructions = '团队章程 v1.2\n全员使用中文、UTF-8 和 CST（Asia/Shanghai）。\n角色附加规则：部署前回读版本。'
  const { ctx, prompt } = start(instructions)
  t.after(() => ctx.dispose())
  assert.equal(prompt('group-worker'), prompt('worker'))
  for (const id of ['main', 'worker']) {
    const text = prompt(id)
    assert.equal(text.split(instructions).length - 1, 1)
    assert.doesNotMatch(text, /How your Bot team works|Chief of Staff|^You are |\[PASS\]/m)
    for (const token of ['[Work #W… from …]', 'delegate_work', 'deliver_to="user"', '!card <code>', 'request_secret',
      'read_own_chat', 'update_bot', 'update_group', 'task_start', 'office_render', 'ds-bot-manual']) assert.ok(text.includes(token), token)
    assert.match(text, /保持 team\/ 仅用于跨项目可复用的通用提示词、规则与模板/)
    for (const name of BUILTIN_PACKS['team-admin'].tools) assert.equal(text.includes(name), id === 'main', name)
  }
  assert.match(prompt('main'), /^## 主 Bot 职责$/m)
  assert.doesNotMatch(prompt('worker'), /^## 主 Bot 职责$/m)
})

test('dated Chinese charter selects the same runtime rules; unrelated profiles keep their current language', t => {
  for (const [instructions, chinese] of [
    ['你是开发。\n团队章程 v1.2｜2026-11-05｜适用于全部角色\n附加规则', true],
    ['Please translate the phrase 团队章程 v1.2 into English.', false],
  ]) {
    const { ctx, prompt } = start(instructions)
    t.after(() => ctx.dispose())
    assert.equal(prompt('worker').includes('## 会话与工具'), chinese)
    assert.equal(prompt('worker').includes('## How your Bot team works'), !chinese)
  }
})

test('Bots get a scoped progress rule without changing the private/group prompt prefix', (t) => {
  const { ctx, prompt } = start()
  t.after(() => ctx.dispose())
  const rules = [
    '- Only for a direct user request in your own chat that needs several steps: write one short sentence of normal reply text before your first tool call, and make that tool call in the same response. Never start such a task with tools alone or end it with a promise. On long tasks, give brief factual updates only at meaningful milestones, then keep working.',
    '- For "[Work …]" or "[Reply from …]" messages, do not write plans or progress updates: use tools silently, then reply with the answer (or [PASS] when a completed work needs nothing told to the user). Simple answers do not need progress messages.',
    '- In a group chat, the group sees what you write while you work, not only your final reply. For work that takes more than a quick look, start with one short sentence on what you will do, in the same response as your first tool call. After that, write only when you find something the group should know or finish a part of the work, in a sentence or two, not at every step. End with the result. Simple answers need no updates.',
  ]
  for (const id of ['main', 'worker']) {
    for (const rule of rules) {
      assert.ok(prompt(id).split('\n').includes(rule))
      assert.equal(prompt(id).split(rule).length - 1, 1)
    }
  }
  assert.equal(prompt('group-worker'), prompt('worker'))
})

// 公开#1499: a Bot that is handed a saved path and finds `read` closed to a PDF has to know where to go next.
test('Bots are told how to open a PDF the user attached, once, in the shared prefix', (t) => {
  const { ctx, prompt } = start()
  t.after(() => ctx.dispose())
  for (const id of ['main', 'worker']) {
    const rule = prompt(id).split('\n').filter(line => line.startsWith('- A file the user attaches reaches you as a saved path'))
    assert.equal(rule.length, 1)
    assert.match(rule[0], /read tool opens text files only/)
    assert.match(rule[0], /scanned or not/)
    assert.match(rule[0], /office skill/)
    assert.match(rule[0], /office_render/)
    assert.match(rule[0], /never answer only that the file cannot be read/)
  }
  assert.equal(prompt('group-worker'), prompt('worker'))
})

test('every Bot can read the manual directly when no skill loader is available', (t) => {
  const { ctx, prompt } = start()
  t.after(() => ctx.dispose())
  for (const id of ['main', 'worker', 'group-worker']) {
    assert.ok(prompt(id).includes(JSON.stringify(join(manualDirectory(), 'SKILL.md'))))
    assert.match(prompt(id), /if you have no skill loader, use your read tool/)
    assert.match(prompt(id), /linked references directly/)
  }
})

test('the group relay and non-Bot sessions do not get progress instructions', (t) => {
  const { ctx, prompt } = start()
  t.after(() => ctx.dispose())
  assert.match(prompt('room'), /end your turn with an empty reply/)
  assert.doesNotMatch(prompt('room'), /progress|milestone/)
  assert.equal(prompt('outside'), '')
})

test('only Main Bot gets the ds-bot-maintenance and ds-bot-plugin-dev rules while worker and group-worker stay unchanged', (t) => {
  const { ctx, prompt } = start()
  t.after(() => ctx.dispose())
  const maintenanceRule = '- When the user asks to inspect, diagnose, update, back up, migrate, or repair DS Bot itself, load the ds-bot-maintenance skill before acting, and never edit live team state or DSH files behind a running host.'
  const pluginDevRule = '- When the user asks to build, install, or attach a plugin, MCP server, reusable skill, capability pack, or extension for DS Bot, load the ds-bot-plugin-dev skill before acting.'
  const main = prompt('main')
  assert.equal(main.split(maintenanceRule).length - 1, 1)
  assert.equal(main.split(pluginDevRule).length - 1, 1)
  const worker = prompt('worker')
  assert.doesNotMatch(worker, /ds-bot-maintenance/)
  assert.doesNotMatch(worker, /ds-bot-plugin-dev/)
  assert.equal(prompt('group-worker'), worker)
})

test('ordinary Bot prompts never direct calls to team-admin tools', (t) => {
  const { ctx, prompt } = start()
  t.after(() => ctx.dispose())
  for (const id of ['worker', 'group-worker']) {
    for (const name of BUILTIN_PACKS['team-admin'].tools) assert.ok(!prompt(id).includes(name), name)
    assert.match(prompt(id), /update_bot changes your own settings/)
    assert.match(prompt(id), /change the group with update_group/)
  }
  for (const name of BUILTIN_PACKS['team-admin'].tools) assert.ok(prompt('main').includes(name), name)
})

test('role-dependent prompt guidance stays frozen until the next turn in both directions', (t) => {
  const ctx = fakeContext()
  t.after(() => ctx.dispose())
  let main = false
  const rt = { ctx, selfOf: id => id, botOf: () => ({ name: 'Writer' }), roomOf: () => undefined, isMain: () => main, isBotSession: () => true }
  installBuiltinPacks(rt)
  install(rt)
  const prompt = () => [
    ctx.sections.get('bot-team-rules').text({ agent: { id: 'worker' } }),
    ctx.sections.get('bot-identity').text({ agent: { id: 'worker' } }),
  ].filter(Boolean).join('\n\n')
  const emit = type => ctx.listeners.get('session/event')[0]({ id: 'worker' }, { type })
  for (const initial of [false, true]) {
    main = initial
    emit('turn/start')
    const before = prompt()
    main = !initial
    assert.equal(prompt(), before)
    emit('turn/end')
    emit('turn/start')
    assert.notEqual(prompt(), before)
    assert.equal(prompt().includes('create_bot'), !initial)
    emit('turn/end')
  }
})

test('TEAM_RULES lets Bot instructions override casual texting and global style defaults', (t) => {
  const { ctx, prompt } = start()
  t.after(() => ctx.dispose())
  for (const id of ['main', 'worker', 'group-worker']) {
    assert.match(prompt(id), /Follow any stricter delivery format or single-message summary rules in your instructions/)
    assert.match(prompt(id), /following any stricter language, encoding, timezone, board, Git\/workflow, or delivery rules set in your instructions/)
    assert.match(prompt(id), /Keep team\/ strictly for generic, cross-project reusable prompts, rules, and templates: never write project-specific constraints/)
  }
})
