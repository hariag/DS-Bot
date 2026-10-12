import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { expandCapabilityNames, validateCapabilityName } from '../src/host/capabilities.js'
import { fakeContext } from './fake-ctx.js'

const makeHome = state => {
  const home = mkdtempSync(join(tmpdir(), 'dsb-capabilities-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(state))
  return home
}
const team = () => ({
  version: 1,
  mainBotIds: ['chief'],
  bots: {
    chief: { id: 'chief', sessionId: 'chief', name: 'Chief', capabilities: [], createdAt: 1 },
    worker: { id: 'worker', sessionId: 'worker', name: 'Worker', capabilities: [], createdAt: 2 },
    helper: { id: 'helper', sessionId: 'helper', name: 'Helper', capabilities: [], createdAt: 3 },
  },
  rooms: { room: { id: 'room', members: ['chief'], sessions: { chief: 'room-chief' }, admin: 'chief', mode: 'everyone' } },
  agents: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
  revision: 1,
})
const mcp = (name, command = 'node') => ({ name, kind: 'mcp', description: 'Echo service', transport: 'stdio', command, args: [], env: {} })

function testAgent(id, mounts, skillsBySession, { awaitMount = async () => {} } = {}) {
  const disposers = []
  const skills = new Map()
  skillsBySession.set(id, skills)
  const agentCtx = {
    effect(execute) {
      const dispose = execute()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
    plugin(plugin, config) {
      const record = { plugin, config, sessionId: id, disposed: false }
      mounts.push(record)
      if (plugin.inject?.includes('skills')) {
        const c = {
          skills: { register(skill) { skills.set(skill.name, skill); return () => skills.delete(skill.name) } },
          effect: execute => { record.cleanup = execute() },
        }
        plugin.apply(c)
      }
      return {
        await: () => awaitMount(record),
        dispose: () => { record.disposed = true; record.cleanup?.() },
      }
    },
    dispose() { for (const dispose of disposers.reverse()) dispose() },
  }
  return { id, session: { id }, ctx: agentCtx }
}

async function setup({ state = team(), secret, beforeLoad } = {}) {
  const home = makeHome(state)
  if (secret) writeFileSync(join(home, 'secrets.json'), JSON.stringify({ secrets: [secret] }))
  const mounts = []
  const skills = new Map()
  const mcpPlugin = { name: 'mcp-client', apply() {} }
  const loader = { import: async () => ({ default: mcpPlugin }), unwrapExports: exports => exports.default }
  const ctx = fakeContext({ services: { loader } })
  const rt = createRuntime(ctx, { home, github: false })
  beforeLoad?.({ ctx, rt, mounts, skills, mcpPlugin })
  await rt.load()
  return { home, ctx, rt, mounts, skills, mcpPlugin, dispose() { ctx.dispose(); rmSync(home, { recursive: true, force: true }) } }
}

test('capability names use the MCP and skill validator intersection', () => {
  assert.equal(validateCapabilityName('a'), 'a')
  assert.equal(validateCapabilityName('web-search-1'), 'web-search-1')
  for (const name of ['github', 'with_underscore', 'with--dash', '1tool', 'A', 'a'.repeat(33)]) assert.throws(() => validateCapabilityName(name))
})

test('packs expand only to MCP and skill items', () => {
  const items = { server: { kind: 'mcp' }, guide: { kind: 'skill' }, team: { kind: 'pack', items: ['server', 'guide'] } }
  assert.deepEqual(expandCapabilityNames(['team', 'server'], items), new Set(['server', 'guide']))
  assert.throws(() => expandCapabilityNames(['missing'], items), /No capability/)
  assert.throws(() => expandCapabilityNames(['bad'], { ...items, bad: { kind: 'pack', items: ['team'] } }), /unavailable capability/)
})

test('state migration adds an empty library and Bot attachment lists', async t => {
  const old = team()
  delete old.capabilities
  for (const bot of Object.values(old.bots)) delete bot.capabilities
  const env = await setup({ state: old })
  t.after(() => env.dispose())
  await env.rt.load()
  assert.deepEqual(env.rt.state.capabilities, { items: {} })
  assert.deepEqual(env.rt.state.bots.chief.capabilities, [])
  const saved = JSON.parse(await (await import('node:fs/promises')).readFile(join(env.home, 'state.json'), 'utf8'))
  assert.deepEqual(saved.capabilities, { items: {} })
  assert.deepEqual(saved.bots.chief.capabilities, [])
})

test('Bot saves enforce approval and ownership, and deletion cascades', async t => {
  const env = await setup()
  t.after(() => env.dispose())
  const { rt } = env
  const { state } = rt
  const created = await rt.capabilitySave(mcp('echo'), { botId: 'worker' })
  assert.equal(created.approved, false)
  const description = await rt.capabilitySave({ ...mcp('echo'), description: 'Updated' }, { botId: 'worker' })
  assert.equal(description.approved, false)
  await rt.capabilityEndpoint('capability-approve', { name: 'echo' })
  const approved = await rt.capabilitySave({ ...mcp('echo'), description: 'Another description' }, { botId: 'worker' })
  assert.equal(approved.approved, true)
  const changed = await rt.capabilitySave(mcp('echo', 'node-new'), { botId: 'worker' })
  assert.equal(changed.approved, false)
  await assert.rejects(
    rt.capabilitySave({ name: 'echo', kind: 'skill', description: 'Other kind', content: 'Instructions' }, { botId: 'worker' }),
    error => error.message === 'A capability cannot change its kind. Delete it and save a new one.',
  )
  await assert.rejects(rt.capabilitySave(mcp('echo'), { botId: 'helper' }), /creator or a Main Bot/)
  await assert.rejects(rt.capabilityDelete('echo', { botId: 'helper' }), /creator or a Main Bot/)
  await rt.capabilitySave({ name: 'guide', kind: 'skill', description: 'Guide', content: 'Do the work.' }, { botId: 'worker' })
  await rt.capabilitySave({ name: 'team', kind: 'pack', items: ['echo', 'guide'] }, { botId: 'worker' })
  state.bots.worker.capabilities = ['echo', 'team']
  await rt.capabilityDelete('echo', { botId: 'worker' })
  assert.equal(state.capabilities.items.echo, undefined)
  assert.deepEqual(state.capabilities.items.team.items, ['guide'])
  assert.deepEqual(state.bots.worker.capabilities, ['team'])
})

test('capability Bot tools refuse DSH Agent sessions', async t => {
  const env = await setup()
  t.after(() => env.dispose())
  const list = env.ctx.registeredTools.get('list_capabilities')
  assert.ok(list)
  assert.match(await list.execute({}, { agent: { id: 'outside' } }), /Only Bots on the team/)
})

test('capability tool descriptions and attach results explain approval', async t => {
  const env = await setup()
  t.after(() => env.dispose())
  const parameters = env.ctx.registeredTools.get('save_capability').parameters.properties
  assert.deepEqual(
    Object.fromEntries(['transport', 'command', 'args', 'env', 'url', 'headers', 'content'].map(name => [name, parameters[name].description])),
    {
      transport: 'How to reach an MCP server: a local command or an HTTP URL',
      command: 'Program that starts a local MCP server',
      args: 'Arguments for command',
      env: 'Environment variables for command; write $DSH_SECRET_<NAME> to insert a saved secret instead of the value',
      url: 'MCP server URL',
      headers: 'HTTP headers; write $DSH_SECRET_<NAME> to insert a saved secret instead of the value',
      content: 'Skill instructions',
    },
  )
  await env.rt.capabilitySave(mcp('blocked'), { botId: 'worker' })
  const attached = await env.ctx.registeredTools.get('attach_capability').execute(
    { name: 'blocked' },
    { agent: { id: 'worker' } },
  )
  assert.ok(attached.endsWith(' The user must allow blocked in DS Bot settings before it can work.'))
})

test('read-only secret reload does not requeue capability reconciliation', async t => {
  const env = await setup()
  t.after(() => env.dispose())
  await env.rt.loadSecrets()
  await env.rt.scheduleCapabilitiesReconcile()
  env.rt.readOnly = () => 'The Bot team is open in another dsh.'
  let loads = 0
  const loadSecrets = env.rt.loadSecrets
  env.rt.loadSecrets = async () => {
    loads += 1
    return loadSecrets()
  }
  await env.rt.reconcileCapabilities()
  assert.equal(loads, 1)
})

test('startup and empty-to-nonempty attachments track existing Bot Agents', async t => {
  const state = team()
  state.capabilities = { items: { echo: { ...mcp('echo'), approved: true, createdBy: 'chief', createdAt: 1, updatedAt: 1 } } }
  state.bots.chief.capabilities = ['echo']
  const resolved = []
  const env = await setup({
    state,
    beforeLoad: ({ rt, mounts, skills }) => {
      const existing = Object.fromEntries(['chief', 'room-chief', 'worker', 'helper'].map(id => [id, testAgent(id, mounts, skills)]))
      rt.chatOf = botId => botId
      rt.groupSessionsOf = botId => botId === 'chief' ? ['room-chief', 'room-chief'] : []
      rt.resolveAgent = async sessionId => {
        if (Object.hasOwn(existing, sessionId)) resolved.push(sessionId)
        return existing[sessionId]
      }
    },
  })
  t.after(() => env.dispose())
  await new Promise(resolve => setImmediate(resolve))
  await env.rt.scheduleCapabilitiesReconcile()
  assert.deepEqual(resolved, ['chief', 'room-chief'])
  assert.deepEqual(env.mounts.map(mount => mount.sessionId), ['chief', 'room-chief'])

  await env.rt.changeCapabilityAttachment('attach', { name: 'echo' }, 'worker')
  await env.rt.capabilityEndpoint('bot-capabilities', { botId: 'helper', capabilities: ['echo'] })
  await env.rt.scheduleCapabilitiesReconcile()
  assert.deepEqual(resolved, ['chief', 'room-chief', 'worker', 'helper'])
  assert.deepEqual(env.mounts.filter(mount => !mount.disposed).map(mount => mount.sessionId), ['chief', 'room-chief', 'worker', 'helper'])
})

test('a Bot turn waits for a slow capability mount before its first model step', async t => {
  const state = team()
  state.capabilities = { items: { echo: { ...mcp('echo'), approved: true, createdBy: 'chief', createdAt: 1, updatedAt: 1 } } }
  state.bots.chief.capabilities = ['echo']
  let startMount
  let releaseMount
  const mountStarted = new Promise(resolve => { startMount = resolve })
  const mountGate = new Promise(resolve => { releaseMount = resolve })
  let startRequest = false
  const env = await setup({
    state,
    beforeLoad: ({ rt, mounts, skills }) => {
      const agent = testAgent('chief', mounts, skills, { awaitMount: async () => { startMount(); await mountGate } })
      rt.chatOf = () => 'chief'
      rt.groupSessionsOf = () => []
      rt.resolveAgent = async () => agent
    },
  })
  const agent = await env.rt.resolveAgent('chief')
  t.after(async () => {
    releaseMount()
    agent.ctx.dispose()
    await env.rt.scheduleCapabilitiesReconcile()
    await new Promise(resolve => setImmediate(resolve))
    env.dispose()
  })
  const beforeStep = env.ctx.listeners.get('agent/pre-step').find(listener => listener.name === 'ensureCapabilitiesBeforeStep')
  const turn = beforeStep({ agent, messages: [], step: 1 }, () => { startRequest = true })
  await mountStarted
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(startRequest, false)
  releaseMount()
  await turn
  assert.equal(startRequest, true)
  assert.equal(env.rt.capabilityStatusesView().chief.echo.state, 'ready')
})

test('a hung capability mount releases the Bot turn after its readiness timeout', async t => {
  const state = team()
  state.capabilities = { items: { echo: { ...mcp('echo'), approved: true, createdBy: 'chief', createdAt: 1, updatedAt: 1 } } }
  state.bots.chief.capabilities = ['echo']
  const warnings = []
  let startMount
  let releaseMount
  const mountStarted = new Promise(resolve => { startMount = resolve })
  const mountGate = new Promise(resolve => { releaseMount = resolve })
  let startRequest = false
  const env = await setup({
    state,
    beforeLoad: ({ ctx, rt, mounts, skills }) => {
      ctx.logger.warn = (...args) => warnings.push(args.join(' '))
      const agent = testAgent('chief', mounts, skills, { awaitMount: async () => { startMount(); await mountGate } })
      rt.chatOf = () => 'chief'
      rt.groupSessionsOf = () => []
      rt.resolveAgent = async () => agent
      rt.capabilityEnsureTimeoutMs = 10
    },
  })
  const agent = await env.rt.resolveAgent('chief')
  t.after(async () => {
    releaseMount()
    agent.ctx.dispose()
    await env.rt.scheduleCapabilitiesReconcile()
    await new Promise(resolve => setImmediate(resolve))
    env.dispose()
  })
  const beforeStep = env.ctx.listeners.get('agent/pre-step').find(listener => listener.name === 'ensureCapabilitiesBeforeStep')
  const turn = beforeStep({ agent, messages: [], step: 1 }, () => { startRequest = true })
  await mountStarted
  await turn
  assert.equal(startRequest, true)
  assert.equal(env.rt.capabilityStatusesView().chief.echo.state, 'connecting')
  assert.match(warnings.join('\n'), /capability mount for chief did not finish within 10ms; continuing/)
  releaseMount()
  await env.rt.scheduleCapabilitiesReconcile()
})

test('unset capability statuses are omitted from the view and tool listing', async t => {
  const env = await setup()
  t.after(() => env.dispose())
  const { rt, ctx } = env
  await rt.capabilitySave({ ...mcp('echo'), approved: true }, { botId: 'chief' })
  await rt.capabilitySave({ name: 'guide', kind: 'skill', description: 'Guide', content: 'Instructions' }, { botId: 'chief' })
  await rt.capabilitySave({ name: 'team', kind: 'pack', items: ['echo', 'guide'] }, { botId: 'chief' })
  rt.state.bots.chief.capabilities = ['echo', 'team']
  await rt.save()
  assert.deepEqual(rt.capabilityStatusesView().chief, {})
  const listed = await ctx.registeredTools.get('list_capabilities').execute({}, { agent: { id: 'chief' } })
  assert.match(listed, /echo \(mcp\).*; attached to you(?:\n|$)/)
  assert.doesNotMatch(listed, /attached to you \(connecting\)/)
})

test('mounts agent-only MCP and skills, remounts changed config, resolves scoped secrets and reports missing secrets', async t => {
  const env = await setup({ secret: { name: 'TOKEN', value: 'fake-secret-value', purpose: '', scope: ['chief'], requestedBy: null, createdAt: 1, updatedAt: 1 } })
  t.after(() => env.dispose())
  const { ctx, rt, mounts, skills, mcpPlugin } = env
  await rt.capabilitySave({ ...mcp('echo'), transport: 'streamable-http', url: 'https://example.test/mcp', headers: { Authorization: 'Bearer $DSH_SECRET_TOKEN' } }, { botId: 'chief' })
  await rt.capabilitySave({ name: 'guide', kind: 'skill', description: 'How to work', content: 'Capability marker.' }, { botId: 'chief' })
  await rt.capabilitySave({ name: 'team', kind: 'pack', items: ['echo', 'guide'] }, { botId: 'chief' })
  await rt.changeCapabilityAttachment('attach', { name: 'team' }, 'chief')
  await rt.changeCapabilityAttachment('attach', { name: 'team', bot: 'Worker' }, 'chief')
  await assert.rejects(rt.changeCapabilityAttachment('attach', { name: 'team', bot: 'Chief' }, 'worker'), /Main Bot/)
  await assert.rejects(rt.changeCapabilityAttachment('detach', { name: 'team', bot: 'Chief' }, 'worker'), /Main Bot/)
  await rt.capabilitySave(mcp('blocked'), { botId: 'worker' })
  await rt.changeCapabilityAttachment('attach', { name: 'blocked' }, 'worker')
  const chief = testAgent('chief', mounts, skills)
  const room = testAgent('room-chief', mounts, skills)
  const worker = testAgent('worker', mounts, skills)
  const dsh = testAgent('outside', mounts, skills)
  for (const agent of [chief, room, worker, dsh]) ctx.emit('agent/created', { agent })
  await rt.scheduleCapabilitiesReconcile()
  assert.equal(mounts.filter(mount => mount.plugin === mcpPlugin).length, 2)
  assert.equal(mounts.find(mount => mount.config.serverName === 'echo').config.headers.Authorization, 'Bearer fake-secret-value')
  assert.equal(skills.get('chief').has('guide'), true)
  assert.deepEqual(mounts.filter(mount => mount.plugin === mcpPlugin).map(mount => mount.sessionId), ['chief', 'room-chief'])
  assert.equal(JSON.stringify(rt.state.capabilities).includes('fake-secret-value'), false)
  assert.equal(JSON.stringify(rt.capabilityLibraryView()).includes('fake-secret-value'), false)
  assert.equal(rt.capabilityStatusesView().chief.team.state, 'ready')
  assert.equal(rt.capabilityStatusesView().worker.team.state, 'error')
  assert.equal(rt.capabilityStatusesView().worker.blocked.state, 'needs-approval')
  assert.equal(mounts.some(mount => mount.config?.serverName === 'blocked'), false)
  await rt.capabilityEndpoint('capability-approve', { name: 'blocked' })
  await rt.scheduleCapabilitiesReconcile()
  assert.equal(mounts.some(mount => mount.config?.serverName === 'blocked' && mount.sessionId === 'worker'), true)
  const first = mounts.find(mount => mount.config.serverName === 'echo')
  const firstSkill = mounts.find(mount => mount.sessionId === 'chief' && mount.plugin.inject?.includes('skills'))
  await rt.capabilitySave({ ...mcp('echo'), transport: 'streamable-http', url: 'https://example.test/mcp', headers: { Authorization: 'Bearer changed' } }, { botId: 'chief' })
  await rt.capabilitySave({ name: 'guide', kind: 'skill', description: 'How to work', content: 'Changed capability marker.' }, { botId: 'chief' })
  await rt.scheduleCapabilitiesReconcile()
  assert.equal(first.disposed, true)
  assert.equal(firstSkill.disposed, true)
  assert.equal(skills.get('chief').get('guide').content, 'Changed capability marker.')
  assert.equal(mounts.filter(mount => mount.plugin === mcpPlugin && mount.config.serverName === 'echo').length, 5)
  assert.equal(rt.capabilityStatusesView().worker.team.state, 'ready')
  await rt.capabilitySave({ ...mcp('missing-secret'), transport: 'streamable-http', url: 'https://example.test/mcp', headers: { Authorization: '$DSH_SECRET_TOKEN' } }, { botId: 'worker' })
  await rt.changeCapabilityAttachment('attach', { name: 'missing-secret' }, 'worker')
  await rt.scheduleCapabilitiesReconcile()
  assert.equal(rt.capabilityStatusesView().worker['missing-secret'].state, 'error')
  assert.match(rt.capabilityStatusesView().worker['missing-secret'].error, /TOKEN/)
  await rt.changeCapabilityAttachment('detach', { name: 'team' }, 'chief')
  await rt.scheduleCapabilitiesReconcile()
  assert.equal(first.disposed, true)
  assert.equal(mounts.findLast(mount => mount.sessionId === 'chief' && mount.plugin.inject?.includes('skills')).disposed, true)
  assert.equal(rt.capabilityStatusesView().chief.team, undefined)
})
