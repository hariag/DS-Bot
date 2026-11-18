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
  const coverage = (sessionId) => {
    if (roomChat(sessionId)) return 'group'
    if (rt.chatOwners?.has?.(sessionId) === true || botChat(sessionId)) return 'bot'
    return undefined
  }
  const refusal = (kind, name) => {
    const where = kind === 'group' ? 'a group chat' : "a Bot's chat"
    const goal = name === 'goal' && kind === 'group' ? ' Use the group Goal in the group details panel instead.' : ''
    return `The DSH /${name} command does not run in ${where}.${goal}`
  }
  const rowCopy = kind => kind === 'group'
    ? 'Not available in a group chat — use the group’s own controls'
    : 'Not available in a Bot chat — use the Bot’s own controls'
  // Session id → the shield mounted under that Session's agent.
  const shields = new Map()
  // Our own registrations notify `commands/change` too; skip the echo while applying.
  let applying = false

  let notifications = 0
  let retryTimer
  const legacyInterval = 30_000

  const lift = (shield, name) => {
    const shadow = shield.shadows.get(name)
    if (!shadow) return
    shield.shadows.delete(name)
    shadow.dispose()
  }
  const add = (shield, row) => {
    if (shield.shadows.has(row.name)) return false
    // An exact-scope plugin may already own this name. Retry only after its
    // definition changes or disappears, keeping that plugin's handler intact.
    const current = shield.commands.find(shield.agent, row.name)
    if (current && shield.conflicts.get(row.name) === current) return false
    shield.conflicts.delete(row.name)
    const kind = shield.kind
    try {
      const dispose = shield.commands.register({
        name: row.name, description: rowCopy(kind),
        ...(row.definitionId === undefined ? {} : { definitionId: row.definitionId }),
        ...(row.input === undefined ? {} : { input: row.input }),
        handler: () => ({ kind: 'error', text: refusal(kind, row.name) }),
      })
      shield.shadows.set(row.name, { kind, row, dispose })
      return true
    } catch (error) {
      if (current) shield.conflicts.set(row.name, current)
      rt.warn?.('ds-bot: the DSH /%s command could not be shadowed for %s: %s', row.name, shield.sessionId, error?.message ?? error)
      return false
    }
  }
  const sameRow = (left, right) => left.definitionId === right.definitionId
    && left.input?.hint === right.input?.hint && left.input?.attachments === right.input?.attachments

  const sync = (shield, reason) => {
    const commands = shield.commands
    if (!commands) return
    const kind = coverage(shield.sessionId)
    if (reason === 'saved' && kind === shield.kind) return
    const changedKind = kind !== shield.kind
    shield.kind = kind
    if (!kind) {
      for (const name of shield.shadows.keys()) lift(shield, name)
      shield.conflicts.clear()
      return
    }

    if (typeof commands.listInherited === 'function') {
      const wanted = new Map(commands.listInherited(shield.agent).map(row => [row.name, row]))
      for (const [name, shadow] of shield.shadows) {
        const row = wanted.get(name)
        if (!row || kind !== shadow.kind || !sameRow(row, shadow.row)) lift(shield, name)
      }
      for (const name of shield.conflicts.keys()) if (!wanted.has(name)) shield.conflicts.delete(name)
      for (const row of wanted.values()) add(shield, row)
      return
    }

    // Earlier stock hosts only expose the merged view and notify synchronously.
    // An intermediate host may defer our own writes into a later event. On
    // those hosts pick up visible additions now, and bound expensive audits
    // of deletions/metadata hidden beneath a shadow to one per interval.
    if (!changedKind && Date.now() < shield.legacyNext) {
      for (const row of commands.list(shield.agent)) add(shield, row)
      if (retryTimer === undefined) {
        retryTimer = setTimeout(() => {
          retryTimer = undefined
          resync('catalog')
        }, shield.legacyNext - Date.now())
        retryTimer.unref?.()
      }
      return
    }
    const before = notifications
    let writes = shield.shadows.size
    for (const name of shield.shadows.keys()) lift(shield, name)
    for (const row of commands.list(shield.agent)) if (add(shield, row)) writes++
    shield.legacyNext = writes > notifications - before ? Date.now() + legacyInterval : 0
  }
  const resync = (reason) => {
    if (applying) return
    applying = true
    try { for (const shield of shields.values()) sync(shield, reason) } finally { applying = false }
  }

  const mount = (agent) => {
    const sessionId = agent?.session?.id
    if (typeof sessionId !== 'string' || shields.has(sessionId)) return undefined
    // Test doubles and non-interactive hosts have no plugin seam; a Bot without it simply
    // keeps the DSH commands.
    if (typeof agent.ctx?.plugin !== 'function') return undefined
    const shield = { sessionId, agent, shadows: new Map(), conflicts: new Map(), legacyNext: 0 }
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
    for (const name of shield.shadows.keys()) lift(shield, name)
    try { shield.fiber?.dispose?.() } catch { /* already gone */ }
  }

  ctx.on('agent/created', ({ agent }) => mountReady(agent))
  ctx.on('agent/disposed', ({ agent }) => { unmount(agent?.session?.id) })
  ctx.on('commands/change', () => { notifications++; resync('catalog') })
  ctx.on('agent-preset/selected', () => resync('catalog'))
  const offSaved = rt.onSaved?.(() => resync('saved'))
  ctx.effect(() => () => {
    applying = true
    clearTimeout(retryTimer)
    offSaved?.()
    for (const sessionId of [...shields.keys()]) unmount(sessionId)
  }, 'ds-bot: command shield cleanup')
  // A reload can inherit live agents; agent/created will not fire for them again.
  for (const agent of ctx.get?.('agents')?.list?.() ?? []) void mountReady(agent)
}
