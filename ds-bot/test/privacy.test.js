import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeApproval, fakeContext } from './fake-ctx.js'

// A Bot's id is a Session id, which a path may hold.
const P = 'd1a40000-1111-4222-8333-444444444444'

// Chief (Main), Writer in the group Ops, and Diary, a Bot with a folder of its own.
function seed({ diary, privateBot }) {
  return {
    version: 1,
    mainBotIds: ['a'],
    workspaceId: 'w1',
    bots: {
      a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1 },
      b: { id: 'b', name: 'Writer', role: 'Write', sessionId: 'b', createdAt: 2 },
      [P]: { id: P, name: 'Diary', role: 'Notes', sessionId: P, createdAt: 3, instructions: 'Keep the diary of the user.', workDir: diary, ...(privateBot ? { private: true } : {}) },
    },
    rooms: { r1: { id: 'r1', name: 'Ops', members: ['a', 'b'], mode: 'admin', admin: 'a', named: true, sessions: { b: 'gb' } } },
    agents: {},
    exchanges: [],
    exchangeTurns: {},
    questions: {},
    prefs: {},
    revision: 0,
  }
}

async function start({ services = {}, privateBot = true } = {}) {
  // The native realpath, as fs/promises uses: on Windows the JS one keeps 8.3 short names.
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'ds-bot-privacy-')))
  const dsh = join(root, 'dsh')
  const home = join(dsh, 'bot')
  const team = join(home, 'workspace')
  const project = join(root, 'project')
  const diary = join(root, 'diary')
  for (const dir of [team, project, diary]) mkdirSync(dir, { recursive: true })
  writeFileSync(join(diary, 'notes.txt'), 'secret')
  writeFileSync(join(home, 'state.json'), JSON.stringify(seed({ diary, privateBot })))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = dsh

  const ctx = fakeContext({ services })
  const agents = new Map()
  const agentOf = (sessionId) => {
    if (!agents.has(sessionId)) {
      agents.set(sessionId, {
        id: sessionId,
        session: { id: sessionId, header: { cwd: sessionId === P ? diary : team }, requestHeader: () => undefined, deriveMessages: () => [] },
        status: 'idle',
        followup() {},
        steer() {},
        inject() {},
        cancel() {},
        async whenIdle() {},
        async runMaintenance(fn) { return fn(AbortSignal.timeout(60_000)) },
        inbox: { nextStep: [], nextTurn: [], remove() {} },
      })
    }
    return agents.get(sessionId)
  }
  const registry = new Map([['w1', { id: 'w1', path: team, title: 'DS Bot' }]])
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: {
      get: id => registry.get(id),
      list: () => [...registry.values()],
      resolveByPath: async path => [...registry.values()].find(workspace => workspace.path === path),
      create: async (path) => {
        const workspace = { id: 'w-new', path, title: 'DS Bot' }
        registry.set(workspace.id, workspace)
        return workspace
      },
      archiveSession: async () => {},
    },
    sessionController: {
      create: async () => ({ sessionId: 's1' }),
      resolveAgent: async sessionId => ({ agent: agentOf(sessionId) }),
      selectModel: async () => {},
      page: async () => ({ records: [], hasMore: false }),
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => {
    route = options
    return register(options)
  }
  const rt = createRuntime(ctx, { home, github: false, diagnosticsFile: false })
  const call = async (endpoint, payload) => (await route.fetch(new Request('http://localhost/api/bot', {
    method: 'POST', body: JSON.stringify({ endpoint, payload }),
  }))).json()
  const state = () => JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
  const tool = (name, args, sessionId) => ctx.registeredTools.get(name).execute(args, { agent: agentOf(sessionId), name, callId: 'c1' })
  // The privacy listener alone, which runs first; the last step stands for the tool.
  const guard = ctx.listeners.get('tools/execute')[0]
  const run = async (name, args, sessionId, agent = agentOf(sessionId)) => {
    let ran = false
    const exec = { name, arguments: args, agent, callId: 'c1', signal: AbortSignal.timeout(60_000) }
    try {
      await guard(exec, async () => { ran = true })
      return { ran }
    } catch (error) {
      return { ran, error: error.message }
    }
  }
  const stop = async () => {
    await ctx.dispose()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    rmSync(root, { recursive: true, force: true, maxRetries: 5 })
  }
  // Loading once fills the Session-owner indexes.
  await tool('list_bots', {}, 'a')
  return { rt, ctx, root, dsh, home, team, project, diary, agentOf, call, tool, run, state, stop }
}

const CLOSED = /private Bot/

test('only the user makes a Bot private, and the Bot needs a folder of its own', async (t) => {
  const { rt, project, team, state, stop } = await start({ privateBot: false })
  t.after(stop)
  await assert.rejects(rt.updateBot(P, { private: true }, 'a'), /Only the user can make Diary private/)
  await assert.rejects(rt.updateBot('b', { private: true }), /needs a folder of its own/)
  await assert.rejects(rt.updateBot('b', { private: true, workDir: team }), /needs a folder of its own/)
  await assert.rejects(rt.updateBot('a', { private: true, workDir: project }), /Main Bot/)
  // Writer is in the group Ops, where every member reads what is said.
  await assert.rejects(rt.updateBot('b', { private: true, workDir: project }), /group chat/)
  assert.equal(state().bots.b.private, undefined)
  await rt.updateBot(P, { private: true })
  assert.equal(state().bots.p, undefined)
  assert.equal(state().bots[P].private, true)
  await rt.updateBot(P, { private: false })
  assert.equal(state().bots[P].private, undefined)
})

test('the user makes a Bot private through the client channel', async (t) => {
  const { call, state, stop } = await start({ privateBot: false })
  t.after(stop)
  await call('update-bot', { id: P, private: true })
  assert.equal(state().bots[P].private, true)
  await call('update-bot', { id: P, private: false })
  assert.equal(state().bots[P].private, undefined)
})

test('a private Bot has a folder that no other folder is in or around', async (t) => {
  const { rt, team, project, diary, state, stop } = await start({ privateBot: false })
  t.after(stop)
  mkdirSync(join(team, 'inside'))
  mkdirSync(join(diary, 'inside'))
  await rt.updateBot(P, { workDir: join(team, 'inside') })
  await assert.rejects(rt.updateBot(P, { private: true }), /team workspace/)
  await rt.updateBot(P, { workDir: diary })
  // Writer's folder lies in Diary's, so Diary cannot be private there.
  await rt.updateBot('b', { workDir: join(diary, 'inside') })
  await assert.rejects(rt.updateBot(P, { private: true }), /folder of Writer/)
  await rt.updateBot('b', { workDir: project })
  await rt.updateBot(P, { private: true })
  assert.equal(state().bots[P].private, true)
  // Once Diary is private, no other Bot, group or team workspace goes in or around its folder.
  await assert.rejects(rt.updateBot('b', { workDir: diary }), CLOSED)
  await assert.rejects(rt.updateBot('b', { workDir: join(diary, 'inside') }), CLOSED)
  await assert.rejects(rt.updateRoom('r1', { workDir: join(diary, 'inside') }), CLOSED)
  await assert.rejects(rt.createBot({ name: 'Third', workDir: diary }), CLOSED)
  await assert.rejects(rt.setTeamWorkspace(diary), CLOSED)
  await assert.rejects(rt.updateBot(P, { workDir: project }), /folder of Writer/)
  assert.equal(state().bots.b.workDir, project)
})

test('a private Bot is no Main Bot, no member of a group and no copy', async (t) => {
  const { rt, stop } = await start()
  t.after(stop)
  await assert.rejects(rt.setMain(P, true), /private/)
  await assert.rejects(rt.createRoom({ members: ['a', P], createdBy: 'a' }), /cannot be in a group chat/)
  await assert.rejects(rt.updateRoom('r1', { add: [P] }, 'a'), /cannot be in a group chat/)
  await assert.rejects(rt.duplicateBot(P), /cannot be copied/)
})

test('the others only see the name and role of a private Bot', async (t) => {
  const { tool, stop } = await start()
  t.after(stop)
  const others = await tool('list_bots', {}, 'b')
  assert.match(others, /- Diary \(Notes, private Bot, closed to other Bots\)/)
  assert.doesNotMatch(others, /Keep the diary|works in/)
  assert.doesNotMatch(others, /Diary[^\n]*\n\s+now:/)
  const own = await tool('list_bots', {}, P)
  assert.match(own, /Diary \(Notes, .*private, you\) — Keep the diary of the user\./)
})

test('other Bots cannot reach a private Bot through the tools between Bots', async (t) => {
  const { run, stop } = await start()
  t.after(stop)
  for (const [name, args, from] of [
    ['message_bot', { to: 'Diary', message: 'hi' }, 'a'],
    ['message_bot', { to: '@diary', message: 'hi' }, 'b'],
    ['message_bot', { to: P, message: 'hi' }, 'b'],
    ['stop_bot', { bot: 'Diary' }, 'a'],
    ['update_bot', { bot: 'Diary', instructions: 'x' }, 'a'],
    ['recall', { scope: 'Diary', query: 'x' }, 'a'],
    ['recall', { scope: '"Diary"' }, 'b'],
    ['remember', { scope: 'Diary', text: 'x' }, 'a'],
    ['forget', { scope: 'Diary', entry: 'x' }, 'a'],
  ]) {
    const result = await run(name, args, from)
    assert.equal(result.ran, false, `${name} from ${from}`)
    assert.match(result.error, CLOSED)
  }
  // The others still reach each other and the shared scopes.
  assert.deepEqual(await run('message_bot', { to: 'Writer', message: 'hi' }, 'a'), { ran: true })
  assert.deepEqual(await run('recall', { scope: 'team', query: 'x' }, 'b'), { ran: true })
  assert.deepEqual(await run('recall', { scope: 'own' }, P), { ran: true })
  assert.deepEqual(await run('update_bot', { bot: 'Diary', role: 'x' }, P), { ran: true })
})

test('other Bots cannot read, write or search what a private Bot keeps', async (t) => {
  const { run, root, home, diary, team, project, stop } = await start()
  t.after(stop)
  const notes = join(diary, 'notes.txt')
  const posix = path => path.replace(/\\/g, '/')
  const gitBash = /^[a-z]:/i.test(diary) ? `/${diary[0].toLowerCase()}${posix(diary).slice(2)}` : posix(diary)
  const refused = async (name, args, from = 'b') => {
    const result = await run(name, args, from)
    assert.equal(result.ran, false, `${name} ${JSON.stringify(args)}`)
    assert.match(result.error, CLOSED)
  }
  await refused('read', { file_path: notes })
  await refused('read', { file_path: relative(team, notes) })
  if (process.platform !== 'linux') await refused('read', { file_path: notes.toUpperCase() })
  await refused('write', { file_path: notes, content: 'x' })
  await refused('edit', { file_path: join(diary, 'new.txt'), old_string: 'a', new_string: 'b' })
  await refused('str_replace_editor', { command: 'view', path: notes })
  await refused('read_image', { file_path: join(diary, 'a.png') })
  await refused('read', { file_path: join(home, 'memory', 'bots', P, 'MEMORY.md') })
  await refused('read', { file_path: join(home, 'memory', 'journal.jsonl') })
  await refused('read', { file_path: join(home, 'state.json') })
  await refused('glob', { pattern: '**/*', path: diary })
  await refused('glob', { pattern: '**/*.txt', path: root })
  await refused('grep', { pattern: 'secret', path: root })
  await refused('glob', { pattern: `${posix(diary)}/**` })
  await refused('glob', { pattern: '**/*', path: home })
  await refused('bash', { command: `cat ${posix(notes)}` })
  await refused('bash', { command: `cat ${gitBash}/notes.txt` })
  await refused('pwsh', { command: `Get-Content '${notes}'`, workdir: project })
  await refused('bash', { command: 'ls', workdir: diary })
  await refused('bash', { command: `cat ${posix(join(home, 'state.json'))}` })
  await refused('working_directory', { cd: diary })
  await refused('working_directory', { cd: root })
  await refused('session_search', { query: 'x', session_id: P })
  await refused('session_trace', { session_ids: ['b', P] })
  await refused('session_event_read', { parent_session_ids: [P] })
  // What is open stays open.
  for (const [name, args] of [
    ['read', { file_path: join(project, 'a.txt') }],
    ['read', { file_path: 'a.txt' }],
    ['write', { file_path: join(team, 'a.txt'), content: 'x' }],
    ['glob', { pattern: '**/*', path: project }],
    ['glob', { pattern: '**/*', path: team }],
    ['grep', { pattern: 'x' }],
    ['bash', { command: 'ls', workdir: project }],
    ['working_directory', { cd: join(team, 'sub') }],
    ['session_search', { query: 'x', session_id: 'b' }],
  ]) {
    assert.deepEqual(await run(name, args, 'b'), { ran: true }, `${name} ${JSON.stringify(args)}`)
  }
})

test('a link into the folder of a private Bot is closed too', async (t) => {
  const { run, project, diary, stop } = await start()
  t.after(stop)
  try {
    symlinkSync(diary, join(project, 'link'), 'junction')
  } catch {
    t.skip('no links here')
    return
  }
  const result = await run('read', { file_path: join(project, 'link', 'notes.txt') }, 'b')
  assert.equal(result.ran, false)
  assert.match(result.error, CLOSED)
})

test('the private Bot reads its own and the team\'s files; a Session it starts speaks for it', async (t) => {
  const { run, diary, project, team, home, stop } = await start()
  t.after(stop)
  assert.deepEqual(await run('read', { file_path: join(diary, 'notes.txt') }, P), { ran: true })
  assert.deepEqual(await run('glob', { pattern: '**/*', path: diary }, P), { ran: true })
  // Its own data is no secret from it: with no other private Bot, the data folder is open to a search.
  assert.deepEqual(await run('glob', { pattern: '**/*', path: home }, P), { ran: true })
  assert.deepEqual(await run('read', { file_path: join(project, 'a.txt') }, P), { ran: true })
  assert.deepEqual(await run('glob', { pattern: '**/*', path: team }, P), { ran: true })
  const sub = parent => ({ id: 'sub1', session: { id: 'sub1', header: { cwd: team, parentSession: parent } } })
  const fromWriter = await run('read', { file_path: join(diary, 'notes.txt') }, 'b', sub('b'))
  assert.equal(fromWriter.ran, false)
  assert.match(fromWriter.error, CLOSED)
  assert.deepEqual(await run('read', { file_path: join(diary, 'notes.txt') }, P, sub(P)), { ran: true })
})

test('what a private Bot sends to the others waits for the user', async (t) => {
  const approval = fakeApproval('allowed-once')
  const { run, stop } = await start({ services: { approval } })
  t.after(stop)
  assert.deepEqual(await run('message_bot', { to: 'Writer', message: 'My secret plan' }, P), { ran: true })
  assert.equal(approval.requests.length, 1)
  assert.equal(approval.requests[0].toolName, 'message_bot')
  assert.match(approval.requests[0].reason, /Diary[\s\S]*Writer[\s\S]*My secret plan/)
  assert.match(approval.requests[0].displayReason.zh, /My secret plan/)
  // The Bots that are not private send as before.
  await run('message_bot', { to: 'Chief', message: 'hi' }, 'b')
  assert.equal(approval.requests.length, 1)
  assert.deepEqual(await run('save_capability', { name: 'plan', kind: 'skill', content: 'steps' }, P), { ran: true })
  assert.equal(approval.requests.length, 2)
  assert.match(approval.requests[1].reason, /share this with the team[\s\S]*steps/)
})

test('a message of a private Bot that the user does not allow is not sent', async (t) => {
  for (const outcome of ['rejected', 'cancelled']) {
    const { run, stop } = await start({ services: { approval: fakeApproval(outcome) } })
    t.after(stop)
    const result = await run('message_bot', { to: 'Writer', message: 'My secret plan' }, P)
    assert.equal(result.ran, false, outcome)
    assert.match(result.error, /not done/)
  }
  // With no way to ask, nothing goes either.
  const { run, stop } = await start()
  t.after(stop)
  const result = await run('message_bot', { to: 'Writer', message: 'x' }, P)
  assert.equal(result.ran, false)
  assert.match(result.error, /no way to ask/)
})

test('a private Bot changes files outside its folder only with the user\'s approval', async (t) => {
  const approval = fakeApproval('allowed-once')
  const { run, diary, project, stop } = await start({ services: { approval } })
  t.after(stop)
  assert.deepEqual(await run('write', { file_path: join(diary, 'today.txt'), content: 'x' }, P), { ran: true })
  assert.deepEqual(await run('write', { file_path: 'today.txt', content: 'x' }, P), { ran: true })
  assert.equal(approval.requests.length, 0)
  assert.deepEqual(await run('edit', { file_path: join(project, 'a.txt'), old_string: 'a', new_string: 'b' }, P), { ran: true })
  assert.equal(approval.requests.length, 1)
  assert.match(approval.requests[0].reason, /outside its own folder/)
  // A path that leaves the folder by `..` is outside it.
  assert.deepEqual(await run('write', { file_path: join(diary, '..', 'project', 'b.txt'), content: 'x' }, P), { ran: true })
  assert.equal(approval.requests.length, 2)
  // Reading is free.
  assert.deepEqual(await run('read', { file_path: join(project, 'a.txt') }, P), { ran: true })
  assert.equal(approval.requests.length, 2)
})

test('a write of a private Bot outside its folder that the user does not allow is not made', async (t) => {
  const { run, project, stop } = await start({ services: { approval: fakeApproval('rejected') } })
  t.after(stop)
  const result = await run('write', { file_path: join(project, 'a.txt'), content: 'x' }, P)
  assert.equal(result.ran, false)
  assert.match(result.error, /not done/)
})

test('with no private Bot the tools run as they did', async (t) => {
  const { run, diary, stop } = await start({ privateBot: false })
  t.after(stop)
  assert.deepEqual(await run('read', { file_path: join(diary, 'notes.txt') }, 'b'), { ran: true })
  assert.deepEqual(await run('message_bot', { to: 'Diary', message: 'hi' }, 'a'), { ran: true })
  assert.deepEqual(await run('glob', { pattern: '*', path: join(diary, '..') }, 'b'), { ran: true })
})
