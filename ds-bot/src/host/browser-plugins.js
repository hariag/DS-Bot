// The whole team uses one browser plugin. Each Bot still gets its own profile
// directory, including the group Sessions where that Bot speaks.
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { completeDeepseek } from './browser/deepseek.js'
import { mountBrowserPlugin } from './browser/mount.js'
import * as refs from './browser/refs.js'
import * as script from './browser/script.js'
import * as task from './browser/task.js'

export const browserPlugins = { refs, script, task }

const NAMES = Object.keys(browserPlugins)

function optionalString(config, key) {
  const value = config[key]
  if (value !== undefined && typeof value !== 'string') throw new TypeError(`${key} must be a string`)
  return value
}

function grantAllows(bot, action) {
  return (Array.isArray(bot.browserGrants) ? bot.browserGrants : []).some(grant => {
    if (!grant || typeof grant.site !== 'string' || !Array.isArray(grant.kinds)) return false
    const site = grant.site.toLowerCase()
    const host = action.host.toLowerCase()
    const siteMatches = site === '*' || host === site || host.endsWith(`.${site}`)
    return siteMatches && (grant.kinds.includes('*') || grant.kinds.includes(action.kind))
  })
}

async function authorizeBrowserAction(rt, exec, botId, action) {
  await rt.load()
  const bot = rt.botOf(botId)
  if (bot === undefined) throw new Error('Unknown Bot')
  const sessionId = exec.agent?.session?.header?.id ?? exec.agent?.id
  const permission = rt.permissionOf(botId, sessionId)
  if (permission === 'read-only') {
    throw new Error(`This Bot has read-only permissions, so it cannot ${action.label} on ${action.host}. Nothing was done.`)
  }
  if (permission === 'danger-full-access' || grantAllows(bot, action)) return

  const approval = rt.ctx.get?.('approval')
  const agent = exec.agent
  if (approval === undefined || agent?.session === undefined) {
    throw new Error(`This action needs the user's approval, and there is no way to ask here, so nothing was done.`)
  }
  const verbs = {
    submit: { en: 'submit', zh: '提交' },
    purchase: { en: 'make a purchase', zh: '购买' },
    delete: { en: 'delete something', zh: '删除内容' },
  }
  const verb = verbs[action.kind]
  const reason = `Let ${bot.name} ${verb.en} on ${action.host}: "${action.label}"?`
  const displayReason = {
    en: reason,
    zh: `允许${bot.name}在 ${action.host} 上${verb.zh}“${action.label}”吗？`,
  }
  let outcome
  try {
    outcome = await approval.request({
      agent,
      toolName: exec.name,
      ...(exec.callId !== undefined ? { callId: exec.callId } : {}),
      reason,
      displayReason,
      ...(exec.signal ? { signal: exec.signal } : {}),
    })
  } catch {
    throw new Error('The approval service was unavailable. Nothing was done.')
  }
  if (outcome === 'allowed-once') return
  if (outcome === 'rejected') {
    throw new Error(`The user did not approve ${action.label} on ${action.host}. Do not try this action again unless the user asks. Nothing was done.`)
  }
  if (outcome === 'cancelled') throw new Error('The approval was cancelled. Nothing was done.')
  throw new Error('The approval could not be obtained. Nothing was done.')
}

export function install(rt) {
  const name = rt.config.browserPlugin
  const injected = rt.config.browserPluginApi
  if (!name && !injected) return
  const plugin = injected ?? browserPlugins[name]
  if (!plugin) throw new Error(`Unknown browser plugin "${name}". Choose ${NAMES.join(', ')}.`)
  const playwrightUrl = optionalString(rt.config, 'playwrightUrl')
  const executablePath = optionalString(rt.config, 'browserExecutablePath')
  const headless = typeof rt.config.browserHeadless === 'boolean'
    ? rt.config.browserHeadless
    : !process.env.DISPLAY
  mountBrowserPlugin(rt.ctx, {
    toolDefs: plugin.tools ?? plugin.toolDefs,
    defineTool,
    profileRoot: join(rt.home, 'browser-profiles'),
    headless,
    playwrightUrl,
    executablePath,
    authorize: (exec, botId, action) => authorizeBrowserAction(rt, exec, botId, action),
    complete: rt.config.browserComplete ?? completeDeepseek,
    async keyOf(exec) {
      await rt.load()
      const id = rt.selfOf(exec.agent?.session?.header?.id ?? exec.agent?.id)
      if (id === undefined || rt.botOf(id) === undefined) return undefined
      return id
    },
  })
  rt.browserPlugin = plugin.id ?? name
}
