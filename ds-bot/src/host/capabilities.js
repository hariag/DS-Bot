import { createHash } from 'node:crypto'

const MCP_CLIENT = '@deepseek-ai/dsh-mcp-client'
const NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
const SECRET_REFERENCE = /\$DSH_SECRET_([A-Z][A-Z0-9_]*)/g
const ENSURE_TIMEOUT_MS = 15_000

export function validateCapabilityName(value) {
  const name = String(value ?? '').trim()
  if (name.length > 32 || !NAME.test(name) || name === 'github') {
    throw new Error('Use a capability name with lowercase letters, digits, and single hyphens; "github" is reserved.')
  }
  return name
}

export function expandCapabilityNames(capabilities, library) {
  const expanded = new Set()
  for (const name of capabilities ?? []) {
    const item = library[name]
    if (!item) throw new Error(`No capability named ${name}.`)
    if (item.kind === 'pack') {
      for (const childName of item.items ?? []) {
        const child = library[childName]
        if (!child || !['mcp', 'skill'].includes(child.kind)) throw new Error(`Pack ${name} refers to an unavailable capability ${childName}.`)
        expanded.add(childName)
      }
    } else if (item.kind === 'mcp' || item.kind === 'skill') {
      expanded.add(name)
    } else {
      throw new Error(`Capability ${name} has an unknown kind.`)
    }
  }
  return expanded
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const strings = value => {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) throw new Error('Arguments must be a list of text values.')
  return [...value]
}
const stringMap = (value, label) => {
  if (value === undefined) return {}
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.values(value).some(item => typeof item !== 'string')) throw new Error(`${label} must contain text values.`)
  return Object.fromEntries(Object.entries(value))
}

export function install(rt) {
  const { ctx, state } = rt
  const agents = new Map()
  const mounts = new WeakMap()
  const sessionStatuses = new Map()
  let pluginPromise
  let queue = Promise.resolve()
  let scheduled = null
  let loadingSecrets = false

  const library = () => state.capabilities.items
  const ensureLibrary = () => {
    state.capabilities ??= { items: {} }
    state.capabilities.items ??= {}
    return library()
  }
  const writeCheck = () => {
    const readOnly = rt.readOnly()
    if (readOnly !== undefined) throw new Error(readOnly)
  }
  const allowedToEdit = (item, botId) => rt.isMain(botId) || item.createdBy === botId
  const itemInput = (body, { botId, ui }) => {
    const name = validateCapabilityName(body.name)
    const kind = body.kind
    if (!['mcp', 'skill', 'pack'].includes(kind)) throw new Error('Choose an MCP server, skill, or pack.')
    const items = ensureLibrary()
    const previous = items[name]
    if (previous && !ui && !allowedToEdit(previous, botId)) throw new Error(`Only ${previous.createdBy ? 'its creator or a Main Bot' : 'a Main Bot'} can change ${name}.`)
    if (previous && previous.kind !== kind) throw new Error('A capability cannot change its kind. Delete it and save a new one.')
    const now = Date.now()
    const item = {
      name,
      kind,
      description: String(body.description ?? '').trim().slice(0, 2000),
      createdBy: previous?.createdBy ?? (ui ? null : botId),
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    }
    if (kind === 'mcp') {
      const transport = body.transport === 'streamable-http' ? 'streamable-http' : 'stdio'
      if (transport === 'stdio') {
        const command = String(body.command ?? '').trim()
        if (command === '') throw new Error('Enter a command for the MCP server.')
        const args = strings(body.args)
        const env = stringMap(body.env, 'Environment variables')
        const changed = !previous || previous.kind !== 'mcp' || previous.transport !== 'stdio'
          || previous.command !== command || !same(previous.args ?? [], args) || !same(previous.env ?? {}, env)
        Object.assign(item, { transport, command, args, env, approved: ui ? true : changed ? false : previous.approved === true })
      } else {
        const url = String(body.url ?? '').trim()
        try {
          const parsed = new URL(url)
          if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error()
        } catch { throw new Error('Enter a valid HTTP or HTTPS URL.') }
        Object.assign(item, { transport, url, headers: stringMap(body.headers, 'Headers'), approved: true })
      }
    } else if (kind === 'skill') {
      item.content = String(body.content ?? '').trim()
    } else {
      const names = [...new Set(strings(body.items))]
      for (const childName of names) {
        const child = items[childName]
        if (!child || !['mcp', 'skill'].includes(child.kind)) throw new Error(`Packs can include only saved MCP servers and skills. ${childName} is not one.`)
      }
      item.items = names
    }
    items[name] = item
    return item
  }
  const capabilitySave = async (body, options = {}) => {
    await rt.load()
    writeCheck()
    const item = itemInput(body ?? {}, options)
    await rt.save()
    return item
  }
  const capabilityDelete = async (name, { botId, ui } = {}) => {
    await rt.load()
    writeCheck()
    const items = ensureLibrary()
    const item = items[String(name ?? '')]
    if (!item) throw new Error(`No capability named ${name}.`)
    if (!ui && !allowedToEdit(item, botId)) throw new Error(`Only its creator or a Main Bot can delete ${name}.`)
    delete items[item.name]
    for (const pack of Object.values(items)) if (pack.kind === 'pack') pack.items = (pack.items ?? []).filter(child => child !== item.name)
    for (const bot of Object.values(state.bots)) bot.capabilities = (bot.capabilities ?? []).filter(attached => attached !== item.name)
    await rt.save()
    return true
  }
  const changeAttachment = async (endpoint, { name, bot: targetRef }, callerId) => {
    await rt.load()
    writeCheck()
    const caller = rt.botOf(callerId)
    if (!caller) throw new Error('Only Bots on the team can change capabilities.')
    const target = targetRef ? rt.findBot(targetRef) : caller
    if (!target) throw new Error(`No Bot named ${targetRef}.`)
    if (target.id !== caller.id && !rt.isMain(callerId)) throw new Error('Only a Main Bot can change another Bot’s capabilities.')
    const item = ensureLibrary()[String(name ?? '')]
    if (!item) throw new Error(`No capability named ${name}.`)
    target.capabilities ??= []
    const wasEmpty = target.capabilities.length === 0
    if (endpoint === 'attach') {
      if (!target.capabilities.includes(item.name)) target.capabilities.push(item.name)
    } else {
      target.capabilities = target.capabilities.filter(attached => attached !== item.name)
    }
    await rt.save()
    if (endpoint === 'attach' && wasEmpty && target.capabilities.length > 0) {
      await trackBotAgents(target)
      void scheduleReconcile()
    }
    return { bot: target.name, attached: endpoint === 'attach' }
  }

  const statusSet = (botId, itemName, sessionId, status) => {
    let byItem = sessionStatuses.get(botId)
    if (!byItem) sessionStatuses.set(botId, byItem = new Map())
    let bySession = byItem.get(itemName)
    if (!bySession) byItem.set(itemName, bySession = new Map())
    bySession.set(sessionId, status)
  }
  const clearStatus = (botId, itemName, sessionId) => {
    const byItem = sessionStatuses.get(botId)
    const bySession = byItem?.get(itemName)
    bySession?.delete(sessionId)
    if (bySession?.size === 0) byItem.delete(itemName)
    if (byItem?.size === 0) sessionStatuses.delete(botId)
  }
  const clearSession = sessionId => {
    for (const [botId, byItem] of sessionStatuses) {
      for (const [name, bySession] of byItem) {
        bySession.delete(sessionId)
        if (bySession.size === 0) byItem.delete(name)
      }
      if (byItem.size === 0) sessionStatuses.delete(botId)
    }
  }
  const statusFor = (botId, name) => {
    const values = [...(sessionStatuses.get(botId)?.get(name)?.values() ?? [])]
    if (values.some(status => status.state === 'error')) return values.find(status => status.state === 'error')
    if (values.some(status => status.state === 'needs-approval')) return { state: 'needs-approval' }
    if (values.some(status => status.state === 'connecting')) return { state: 'connecting' }
    return values.length > 0 ? { state: 'ready' } : undefined
  }
  const capabilityStatusesView = () => {
    const result = {}
    for (const bot of Object.values(state.bots)) {
      const statuses = {}
      for (const name of bot.capabilities ?? []) {
        const item = library()[name]
        if (!item) continue
        if (item.kind !== 'pack') {
          const status = statusFor(bot.id, name)
          if (status) statuses[name] = status
          continue
        }
        const children = (item.items ?? []).map(child => statusFor(bot.id, child)).filter(Boolean)
        const status = children.find(status => status.state === 'error')
          ?? children.find(status => status.state === 'needs-approval')
          ?? children.find(status => status.state === 'connecting')
          ?? children[0]
        if (status) statuses[name] = status
      }
      result[bot.id] = statuses
    }
    return result
  }
  const libraryView = () => Object.values(library()).map(item => ({
    ...item,
    ...(item.env ? { env: { ...item.env } } : {}),
    ...(item.headers ? { headers: { ...item.headers } } : {}),
    ...(item.items ? { items: [...item.items] } : {}),
  }))

  async function loadMcpPlugin() {
    if (!pluginPromise) {
      pluginPromise = (async () => {
        const loader = ctx.get?.('loader')
        if (typeof loader?.import !== 'function') throw new Error('This DSH cannot load MCP servers.')
        const exports = await loader.import(MCP_CLIENT)
        return loader.unwrapExports?.(exports) ?? exports?.default ?? exports
      })()
    }
    return pluginPromise
  }
  function resolveValues(values, botId) {
    const resolved = {}
    for (const [key, raw] of Object.entries(values ?? {})) {
      resolved[key] = String(raw).replace(SECRET_REFERENCE, (_match, name) => {
        if (!rt.canUseSecret(name, botId)) throw new Error(`Secret ${name} is missing or unavailable for this Bot.`)
        const value = rt.secretValue(name)
        if (value === undefined) throw new Error(`Secret ${name} is missing or unavailable for this Bot.`)
        return value
      })
    }
    return resolved
  }
  const configFor = (item, botId) => {
    if (item.kind === 'skill') return { name: item.name, description: item.description, content: item.content }
    if (item.transport === 'stdio') return { transport: 'stdio', serverName: item.name, command: item.command, args: item.args ?? [], env: resolveValues(item.env, botId), failOnStartupError: true }
    return { transport: 'streamable-http', serverName: item.name, url: item.url, headers: resolveValues(item.headers, botId), failOnStartupError: true }
  }
  const disposeMount = async mount => {
    if (mount?.fiber) await Promise.resolve().then(() => mount.fiber.dispose()).catch(() => {})
  }
  const reconcileAgent = async (agent, bot) => {
    const sessionId = agent.session.id
    const agentMounts = mounts.get(agent) ?? new Map()
    mounts.set(agent, agentMounts)
    const desired = expandCapabilityNames(bot.capabilities, library())
    for (const name of sessionStatuses.get(bot.id)?.keys() ?? []) {
      if (!desired.has(name)) clearStatus(bot.id, name, sessionId)
    }
    for (const [name, mount] of agentMounts) {
      if (desired.has(name)) continue
      await disposeMount(mount)
      agentMounts.delete(name)
    }
    for (const name of desired) {
      const item = library()[name]
      if (item.kind === 'mcp' && item.transport === 'stdio' && item.approved !== true) {
        await disposeMount(agentMounts.get(name))
        agentMounts.delete(name)
        statusSet(bot.id, name, sessionId, { state: 'needs-approval' })
        continue
      }
      let config
      try {
        config = configFor(item, bot.id)
      } catch (error) {
        await disposeMount(agentMounts.get(name))
        agentMounts.delete(name)
        statusSet(bot.id, name, sessionId, { state: 'error', error: rt.redactSecrets(error.message).slice(0, 300) })
        continue
      }
      const key = `${name}:${createHash('sha256').update(JSON.stringify(config)).digest('hex')}`
      const current = agentMounts.get(name)
      if (current?.key === key) continue
      await disposeMount(current)
      statusSet(bot.id, name, sessionId, { state: 'connecting' })
      try {
        const fiber = item.kind === 'skill'
          ? agent.ctx.plugin({
            name: `ds-bot-capability-skill-${name}`,
            inject: ['skills'],
            apply(c) {
              c.effect(() => c.skills.register({ name: config.name, description: config.description, source: 'runtime', content: config.content }))
            },
          })
          : agent.ctx.plugin(await loadMcpPlugin(), config)
        agentMounts.set(name, { key, fiber })
        await fiber.await()
        if (agents.get(sessionId)?.deref() !== agent) continue
        statusSet(bot.id, name, sessionId, { state: 'ready' })
      } catch (error) {
        await disposeMount(agentMounts.get(name))
        agentMounts.delete(name)
        const message = rt.redactSecrets([error, error?.cause].filter(Boolean).map(part => String(part?.message ?? part)).join(': ') || 'Connection failed').slice(0, 300)
        statusSet(bot.id, name, sessionId, { state: 'error', error: message })
      }
    }
  }
  async function reconcile() {
    await rt.load()
    loadingSecrets = true
    try {
      await rt.loadSecrets()
    } finally {
      loadingSecrets = false
    }
    for (const [sessionId, reference] of agents) {
      const agent = reference.deref()
      if (!agent) {
        agents.delete(sessionId)
        clearSession(sessionId)
        continue
      }
      if (!rt.isBotSession(sessionId)) {
        clearSession(sessionId)
        continue
      }
      const bot = rt.botOf(rt.selfOf(sessionId))
      if (!bot) {
        clearSession(sessionId)
        continue
      }
      try {
        await reconcileAgent(agent, bot)
      } catch (error) {
        rt.warn('ds-bot: capability reconcile for %s failed: %s', sessionId, error)
      }
    }
  }
  const scheduleReconcile = () => {
    if (!scheduled) {
      scheduled = new Promise(resolve => queueMicrotask(() => {
        const current = queue = queue.then(reconcile).catch(error => rt.warn('ds-bot: capability reconcile failed: %s', error))
        scheduled = null
        resolve(current)
      }))
    }
    return scheduled
  }
  async function ensureCapabilities(sessionId) {
    await rt.load()
    if (!rt.isBotSession(sessionId)) return
    const bot = rt.botOf(rt.selfOf(sessionId))
    if (!bot || (bot.capabilities ?? []).length === 0) return
    try {
      trackAgent(await rt.resolveAgent(sessionId))
    } catch (error) {
      rt.warn('ds-bot: capability Agent for %s could not be resolved: %s', sessionId, rt.redactSecrets(String(error)))
      return
    }
    const timeoutMs = rt.capabilityEnsureTimeoutMs ?? ENSURE_TIMEOUT_MS
    let timer
    const completed = await Promise.race([
      scheduleReconcile().then(() => true),
      new Promise(resolve => { timer = setTimeout(() => resolve(false), timeoutMs) }),
    ])
    clearTimeout(timer)
    if (!completed) rt.warn('ds-bot: capability mount for %s did not finish within %dms; continuing', sessionId, timeoutMs)
  }
  const trackAgent = agent => {
    const sessionId = agent?.session?.id
    if (typeof sessionId !== 'string' || !agent.ctx) return
    if (agents.get(sessionId)?.deref() === agent) return
    agents.set(sessionId, new WeakRef(agent))
    agent.ctx.effect(() => () => {
      if (agents.get(sessionId)?.deref() === agent) agents.delete(sessionId)
      clearSession(sessionId)
      for (const mount of mounts.get(agent)?.values() ?? []) void disposeMount(mount)
      mounts.delete(agent)
    }, `ds-bot: capabilities ${sessionId}`)
  }
  const trackBotAgents = async bot => {
    const sessionIds = new Set()
    try {
      const sessionId = rt.chatOf(bot.id)
      if (typeof sessionId === 'string') sessionIds.add(sessionId)
    } catch (error) {
      rt.warn('ds-bot: capability chat session for %s could not be read: %s', bot.id, error)
    }
    try {
      for (const sessionId of rt.groupSessionsOf(bot.id) ?? []) {
        if (typeof sessionId === 'string') sessionIds.add(sessionId)
      }
    } catch (error) {
      rt.warn('ds-bot: capability group sessions for %s could not be read: %s', bot.id, error)
    }
    for (const sessionId of sessionIds) {
      try {
        trackAgent(await rt.resolveAgent(sessionId))
      } catch (error) {
        rt.warn('ds-bot: capability Agent for %s could not be resolved: %s', sessionId, error)
      }
    }
  }

  async function capabilityEndpoint(endpoint, body = {}) {
    if (endpoint === 'capability-save') return capabilitySave(body, { ui: true })
    if (endpoint === 'capability-delete') return capabilityDelete(body.name, { ui: true })
    if (endpoint === 'capability-approve') {
      await rt.load()
      writeCheck()
      const item = library()[String(body.name ?? '')]
      if (!item || item.kind !== 'mcp' || item.transport !== 'stdio') throw new Error(`No unapproved stdio MCP named ${body.name}.`)
      item.approved = true
      item.updatedAt = Date.now()
      await rt.save()
      return item
    }
    if (endpoint === 'bot-capabilities') {
      await rt.load()
      writeCheck()
      const bot = rt.botOf(String(body.botId ?? ''))
      if (!bot) throw new Error('Unknown Bot')
      if (!Array.isArray(body.capabilities) || body.capabilities.some(name => typeof name !== 'string' || !library()[name])) throw new Error('Choose saved capabilities.')
      const wasEmpty = (bot.capabilities ?? []).length === 0
      bot.capabilities = [...new Set(body.capabilities)]
      await rt.save()
      if (wasEmpty && bot.capabilities.length > 0) {
        await trackBotAgents(bot)
        void scheduleReconcile()
      }
      return bot.capabilities
    }
    throw new Error('Unknown capability operation.')
  }
  const secretsChanged = rt.secretsChanged
  rt.secretsChanged = () => {
    secretsChanged?.()
    if (!loadingSecrets) void scheduleReconcile()
  }
  rt.capabilitiesStateSaved = () => { void scheduleReconcile() }
  ctx.on('agent/pre-step', async function ensureCapabilitiesBeforeStep({ agent }, next) {
    await ensureCapabilities(agent.session.id)
    return next()
  })
  ctx.on('agent/created', ({ agent }) => {
    trackAgent(agent)
    void rt.load().then(scheduleReconcile).catch(error => rt.warn('ds-bot: capability load failed: %s', error))
  })
  ctx.effect(() => {
    void rt.load().then(async () => {
      for (const bot of Object.values(state.bots)) {
        if ((bot.capabilities ?? []).length > 0) await trackBotAgents(bot)
      }
      await scheduleReconcile()
    }).catch(error => rt.warn('ds-bot: capability startup failed: %s', error))
    return () => { agents.clear() }
  }, 'ds-bot: capabilities')
  Object.assign(rt, {
    capabilitySave,
    capabilityDelete,
    capabilityEndpoint,
    capabilityLibraryView: libraryView,
    capabilityStatusesView,
    reconcileCapabilities: reconcile,
    scheduleCapabilitiesReconcile: scheduleReconcile,
    ensureCapabilities,
    expandCapabilities: names => expandCapabilityNames(names, library()),
    changeCapabilityAttachment: changeAttachment,
  })
}
