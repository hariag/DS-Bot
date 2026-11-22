// The DSH slash commands do not run in a Bot's chat or in a group chat.
//
// DSH's command registry has no "remove for this Session" call: it offers register,
// list, find and execute only. An agent-scoped registration, though, shadows the global
// definition of the same name for that agent alone (see the host `commands` package:
// "A command-producing plugin mounted beneath an agent's own context declares its
// commands injection and registers an exact agent-scoped command, which shadows the
// global definition of the same name for that agent only"). This module mounts one small
// plugin under each agent, reads the commands service through reflection, and — once the
// Session is known to be a Bot chat or a group's own Session — registers a same-name
// shadow for every command that agent currently sees. The set is kept current on
// `commands/change`, and a Bot whose agent arrives before its state entry is caught up on
// the next save. A typed `/name args` in those Sessions then reaches this error
// result instead of the DSH command.
//
// What it cannot do, by design of the documented API: take the rows out of the `/` menu.
// The menu rows remain (first-party rows keep their own localized copy; the shadow carries
// the host descriptor's identity and input hint so the client still claims them); only
// execution is stopped here. Skills are a separate `/` source and are not touched.
//
// The whole shield is one module and one switch: `config.commandShield: false` in the
// host config turns it off, and removing this module (and its MODULES entry in index.js)
// removes it entirely — expected when DSH enables session-scoped trigger sources upstream.
export function install(rt) {
  if (rt.config?.commandShield === false) return
  const { ctx } = rt
  // Which Sessions are a Bot's own chat or a group's own relay Session. A Bot's group
  // member Sessions are not either: the group's own Session is the one whose `/` menu
  // the user sees in a group chat.
  // A Bot created moments ago may not be indexed in chatOwners yet when its first agent
  // is created, so also match the Session in the saved state.
  const botChat = sessionId => Object.values(rt.state?.bots ?? {}).some(bot => rt.chatOf?.(bot.id) === sessionId)
  const roomChat = sessionId => rt.roomOf?.(sessionId) !== undefined
    || Object.values(rt.state?.rooms ?? {}).some(room => rt.sessionOfRoom?.(room) === sessionId)
  const coverageKind = sessionId => roomChat(sessionId)
    ? 'group'
    : rt.chatOwners?.has?.(sessionId) === true || botChat(sessionId) ? 'bot' : undefined
  const isGroup = sessionId => roomChat(sessionId)
  const refusal = (sessionId, name) => {
    const where = isGroup(sessionId) ? 'a group chat' : "a Bot's chat"
    const goal = name === 'goal' && isGroup(sessionId) ? ' Use the group Goal in the group details panel instead.' : ''
    return `The DSH /${name} command does not run in ${where}.${goal}`
  }
  const rowCopy = sessionId => isGroup(sessionId)
    ? 'Not available in a group chat — use the group’s own controls'
    : 'Not available in a Bot chat — use the Bot’s own controls'
  // Session id → the shield mounted under that Session's agent.
  const shields = new Map()
  // Cordis returns a context-bound service proxy per agent. Resolve its original
  // service before coalescing notifications: CommandRuntime's registration callback
  // calls notifyChange() on that root instance, so overriding the proxy is ineffective.
  const originalService = Symbol.for('cordis.original')
  let commandService
  let originalNotify
  let notifierWrapper
  let notifierDescriptor
  let notificationTimer
  let pendingInternal = false
  let pendingExternal = false
  let internalDispatch = false
  let warnedNotifier = false
  // Suppress re-entrant command changes while this module is editing its own shadows.
  let applying = false
  let batching = false

  const dispatchQueuedNotification = () => {
    notificationTimer = undefined
    const notifyExternal = pendingExternal
    const notifyInternal = pendingInternal && !notifyExternal
    pendingExternal = false
    pendingInternal = false
    if (typeof originalNotify !== 'function' || commandService === undefined) return
    // An external registry event has already begun a real DSH change and must run
    // the normal resync path. Our own event only refreshes the client catalog; do
    // not feed it back into another full shadow rebuild.
    internalDispatch = notifyInternal
    try { originalNotify.call(commandService) } catch { /* the UI can relist on its next visit */ }
    finally { internalDispatch = false }
  }

  const scheduleNotification = (kind) => {
    if (kind === 'external') pendingExternal = true
    else pendingInternal = true
    if (notificationTimer !== undefined) return
    notificationTimer = setTimeout(dispatchQueuedNotification, 50)
    notificationTimer.unref?.()
  }

  const ensureNotificationBatch = commands => {
    if (commands === undefined || commands === null) return false
    const service = commands[originalService] ?? commands
    if (service === commandService && typeof originalNotify === 'function') return true
    if (commandService !== undefined) return false
    const notify = service?.notifyChange
    if (typeof notify !== 'function') return false
    const ownDescriptor = Object.getOwnPropertyDescriptor(service, 'notifyChange')
    const wrapper = function () {
      // Registration/removal inside sync() is folded into its one explicit client
      // refresh. All other registry changes are debounced as one host event.
      if (applying) return
      scheduleNotification('external')
    }
    try {
      Object.defineProperty(service, 'notifyChange', {
        configurable: true,
        enumerable: ownDescriptor?.enumerable ?? false,
        writable: true,
        value: wrapper,
      })
    } catch {
      return false
    }
    if (service.notifyChange !== wrapper) return false
    commandService = service
    originalNotify = notify
    notifierWrapper = wrapper
    notifierDescriptor = ownDescriptor
    return true
  }

  const queueNotification = () => scheduleNotification('internal')

  const restoreNotificationBatch = ({ flush = false } = {}) => {
    if (notificationTimer !== undefined) clearTimeout(notificationTimer)
    notificationTimer = undefined
    if (flush && (pendingInternal || pendingExternal)) {
      const notify = originalNotify
      const service = commandService
      pendingInternal = false
      pendingExternal = false
      if (typeof notify === 'function' && service !== undefined) {
        internalDispatch = true
        try { notify.call(service) } catch { /* the next generation will refresh */ }
        finally { internalDispatch = false }
      }
    } else {
      pendingInternal = false
      pendingExternal = false
    }
    if (commandService !== undefined && commandService.notifyChange === notifierWrapper) {
      if (notifierDescriptor === undefined) delete commandService.notifyChange
      else Object.defineProperty(commandService, 'notifyChange', notifierDescriptor)
    }
    commandService = undefined
    originalNotify = undefined
    notifierWrapper = undefined
    notifierDescriptor = undefined
  }

  const sync = (shield, force = false) => {
    const commands = shield.commands
    if (commands === undefined) return false
    if (!ensureNotificationBatch(commands)) {
      if (!warnedNotifier) {
        warnedNotifier = true
        rt.warn?.('ds-bot: command shielding is inactive because the DSH command registry cannot safely batch change notifications')
      }
      return false
    }
    const nextCoverage = coverageKind(shield.sessionId)
    if (!force && nextCoverage === shield.coverage) return false
    shield.coverage = nextCoverage
    let changed = false
    // Every event makes the Web UI refetch /api/commands/list across all cached
    // Sessions. The root registry notifier is suppressed during these mutations.
    try {
    for (const lift of shield.lifts) {
      try { lift(); changed = true } catch { /* already lifted */ }
    }
    shield.lifts = []
    // The agent can arrive before its Bot or group is in the state (a Bot created a
    // moment ago); the shield mounts for every agent and waits for that Session to
    // become known, then registers its shadows on the next sync.
    if (nextCoverage === undefined) return changed
    // Lift first: `list(agent)` is the merged view, so only after our shadows are gone
    // does it answer what the host currently serves this agent.
    const definitions = commands.list(shield.agent)
    for (const definition of definitions) {
      try {
        // Keep the host descriptor's identity and input hint: the client uses them to
        // claim a typed line with arguments and to keep the row's first-party face.
        // Dropping them would leave `/name args` as a plain prompt.
        const lift = commands.register({
          name: definition.name,
          description: rowCopy(shield.sessionId),
          ...(definition.definitionId === undefined ? {} : { definitionId: definition.definitionId }),
          ...(definition.input === undefined ? {} : { input: definition.input }),
          handler: () => ({ kind: 'error', text: refusal(shield.sessionId, definition.name) }),
        })
        if (typeof lift === 'function') shield.lifts.push(lift)
        changed = true
      } catch (error) {
        // A same-name command already in this exact agent scope keeps its own handler.
        rt.warn?.('ds-bot: the DSH /%s command could not be shadowed for %s: %s', definition.name, shield.sessionId, error?.message ?? error)
      }
    }
    } finally {
      if (changed && !batching) queueNotification()
    }
    return changed
  }
  const resync = (force = false, notifyClient = false) => {
    if (applying || internalDispatch) return
    applying = true
    batching = true
    let changed = false
    try { for (const shield of shields.values()) changed = sync(shield, force) || changed } finally { applying = false; batching = false }
    if (!notifyClient || !changed) return
    queueNotification()
  }

  const mount = (agent) => {
    const sessionId = agent?.session?.id
    if (typeof sessionId !== 'string' || shields.has(sessionId)) return undefined
    // Test doubles and non-interactive hosts have no plugin seam; a Bot without it simply
    // keeps the DSH commands.
    if (typeof agent.ctx?.plugin !== 'function') return undefined
    const shield = { sessionId, agent, child: undefined, lifts: [] }
    shield.ready = new Promise((resolve) => { shield.resolveReady = resolve })
    shields.set(sessionId, shield)
    try {
      // The plugin must be mounted beneath the agent's context: reading
      // `agent.ctx.commands` directly throws "cannot get property commands without
      // inject", and only a registration from inside this plugin belongs to the agent's
      // scope (its fiber goes with the agent). It reads the service through reflection
      // rather than `inject: ['commands']`: in a spike the injection resolved under the
      // first agent but stayed undefined for the agents mounted after it, while `get`
      // answers on every child context.
      shield.fiber = agent.ctx.plugin({
        name: 'ds-bot-command-shield',
        inject: [],
        apply(child) {
          shield.child = child
          shield.commands = child.get?.('commands')
          applying = true
          try { if (shield.commands !== undefined) sync(shield) } finally {
            applying = false
            shield.resolveReady?.()
          }
        },
      })
    } catch (error) {
      shields.delete(sessionId)
      shield.resolveReady?.()
      rt.warn?.('ds-bot: the DSH command shield could not mount for %s: %s', sessionId, error?.message ?? error)
    }
    return shield
  }
  // `agent/created` is serial: wait for the injected plugin to register its shadows, so
  // the first command a fresh chat can send already meets the shield. The cap keeps a
  // host without the commands service from holding agent creation open.
  const mountReady = async (agent) => {
    const shield = mount(agent)
    if (shield === undefined) return
    let timer
    await Promise.race([
      shield.ready,
      new Promise((resolve) => { timer = setTimeout(resolve, 2_000); timer.unref?.() }),
    ])
    clearTimeout(timer)
  }
  const unmount = (sessionId) => {
    const shield = shields.get(sessionId)
    if (shield === undefined) return
    shields.delete(sessionId)
    const wasApplying = applying
    applying = true
    try {
      for (const lift of shield.lifts) { try { lift() } catch { /* already lifted */ } }
    } finally {
      applying = wasApplying
      if (shield.lifts.length > 0) queueNotification()
    }
    shield.lifts = []
    try { shield.fiber?.dispose?.() } catch { /* already gone */ }
  }

  ctx.on('agent/created', ({ agent }) => mountReady(agent))
  ctx.on('agent/disposed', ({ agent }) => { unmount(agent?.session?.id) })
  ctx.on('commands/change', () => resync(true))
  const offSaved = rt.onSaved?.(() => resync(false, true))
  ctx.effect(() => () => {
    applying = true
    offSaved?.()
    for (const sessionId of [...shields.keys()]) unmount(sessionId)
    restoreNotificationBatch({ flush: true })
  }, 'ds-bot: command shield cleanup')
  // A reload can inherit live agents; agent/created will not fire for them again.
  for (const agent of ctx.get?.('agents')?.list?.() ?? []) void mountReady(agent)
}
