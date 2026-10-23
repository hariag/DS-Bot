// Registers one browser plugin's tools. ds-bot passes a key function that resolves
// the Bot; a standalone package can pass the Session id instead.
import { join } from 'node:path'
import { openBotBrowser } from './session.js'

export const browserOutput = {
  schema: { type: 'string' },
  render(_args, value) {
    if (value && typeof value === 'object') {
      const blocks = [{ type: 'text', text: String(value.text ?? '') }]
      if (value.image) blocks.push({ type: 'image', data: value.image, mediaType: 'image/jpeg' })
      return blocks
    }
    return [{ type: 'text', text: String(value) }]
  },
}

/**
 * @param {any} ctx
 * @param {{ toolDefs: any[], defineTool: Function, keyOf: (exec: any) => Promise<string|undefined>, profileRoot: string, headless: boolean, playwrightUrl?: string, executablePath?: string, complete?: Function }} options
 */
export function mountBrowserPlugin(ctx, { toolDefs, defineTool, keyOf, profileRoot, headless, playwrightUrl, executablePath, complete }) {
  const sessions = new Map()
  ctx.effect(() => async () => {
    const open = [...sessions.values()]
    sessions.clear()
    await Promise.all(open.map(session => session.close()))
  }, 'ds-bot: browser plugin')

  for (const spec of toolDefs) {
    ctx.tools.register(defineTool({
      name: spec.name,
      description: spec.description,
      parameters: spec.parameters ?? {},
      output: browserOutput,
      async execute(args, exec) {
        const botId = await keyOf(exec)
        if (!botId) return 'Only Bots on the team have a browser.'
        let session = sessions.get(botId)
        if (spec.needsBrowser && session === undefined) {
          session = await openBotBrowser({ botId, profileRoot, headless, playwrightUrl, executablePath })
          sessions.set(botId, session)
        }
        return spec.execute(args ?? {}, {
          botId,
          profileDir: join(profileRoot, botId),
          session,
          complete,
        })
      },
    }))
  }
}
