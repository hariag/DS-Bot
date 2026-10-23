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
