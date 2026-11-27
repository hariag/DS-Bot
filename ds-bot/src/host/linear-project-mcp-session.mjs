import { LinearProjectReadError } from './linear-project-api.mjs'

const READ_TOOLS = new Set(['list_issues', 'list_issue_statuses', 'get_issue'])
const WRITE_TOOLS = new Set(['save_issue', 'create_comment', 'save_comment'])
const nonempty = value => typeof value === 'string' && value.trim().length > 0

function validateWriteArgs(name, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw new LinearProjectReadError('Linear MCP write arguments invalid')
  }
  const keys = Object.keys(args)
  if (name === 'save_issue') {
    if (keys.length !== 2 || !keys.includes('id') || !keys.includes('state')
      || !nonempty(args.id) || args.id.length > 160 || !nonempty(args.state) || args.state.length > 100) {
      throw new LinearProjectReadError('Linear MCP save_issue outside allowed fields')
    }
    return
  }
  if (name === 'create_comment' || name === 'save_comment') {
    const allowed = new Set(['issueId', 'id', 'body'])
    const target = args.issueId ?? args.id
    if (keys.some(k => !allowed.has(k)) || (args.issueId !== undefined && args.id !== undefined)
      || !nonempty(target) || target.length > 160 || typeof args.body !== 'string' || !args.body.trim() || args.body.length > 1500) {
      throw new LinearProjectReadError('Linear MCP comment outside allowed fields')
    }
    return
  }
  throw new LinearProjectReadError('Linear MCP tool outside write scope')
}

export function createLinearProjectMcpSession({ getGateway, assertActive, signal, request = fetch, allowWrite = false, timeoutMs = 15_000 }) {
  let client, writeTools = new Set(), retryAt = 0
  const options = { signal, timeout: timeoutMs }

  async function close() {
    const previous = client
    client = undefined
    writeTools = new Set()
    await previous?.close().catch(() => {})
  }

  async function connect() {
    const { url, headers } = await getGateway()
    const target = new URL(url)
    if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1' || target.pathname !== '/c/linear') {
      throw new LinearProjectReadError('Linear MCP gateway unavailable')
    }
    const { Client, StreamableHTTPClientTransport } = await import('@modelcontextprotocol/client')
    const transport = new StreamableHTTPClientTransport(target, {
      requestInit: { headers, redirect: 'error' },
      async fetch(input, init) {
        assertActive()
        if (String(input) !== target.href) throw new Error('Linear MCP gateway scope changed')
        const response = await request(input, init)
        if (response.status === 429) {
          const value = response.headers.get('retry-after')
          const seconds = value === null ? NaN : Number(value)
          const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now()
          retryAt = Date.now() + (Number.isFinite(delay) ? Math.max(5_000, delay) : 10_000)
        }
        return response
      },
    })
    client = new Client({ name: 'DS Bot Linear project watcher', version: '1.0.0' })
    await client.connect(transport, options)
    const supported = new Set()
    const supportedWrite = new Set()
    const cursors = new Set()
    let cursor
    do {
      const page = await client.listTools(cursor === undefined ? undefined : { cursor }, options)
      for (const tool of page.tools) {
        if (tool.annotations?.readOnlyHint !== false && READ_TOOLS.has(tool.name)) supported.add(tool.name)
        if (WRITE_TOOLS.has(tool.name)) supportedWrite.add(tool.name)
      }
      cursor = page.nextCursor
      if (cursor !== undefined && cursors.has(cursor)) throw new Error('Linear MCP tool list did not advance')
      cursors.add(cursor)
    } while (cursor && (![...READ_TOOLS].every(name => supported.has(name)) || (allowWrite && supportedWrite.size === 0)))
    if (![...READ_TOOLS].every(name => supported.has(name))) throw new LinearProjectReadError('Linear MCP read tools unavailable')
    writeTools = supportedWrite
    return client
  }

  async function invokeTool(name, args, { retryOnSessionError = false } = {}) {
    assertActive()
    if (retryAt > Date.now()) throw new LinearProjectReadError('rate limited', retryAt - Date.now())
    const reused = client !== undefined
    try {
      const active = client ?? await connect()
      assertActive()
      const result = await active.callTool({ name, arguments: args }, options)
      if (result.isError) throw new LinearProjectReadError('Linear MCP read rejected')
      if (result.structuredContent !== undefined && result.structuredContent !== null) return result.structuredContent
      const [entry] = result.content ?? []
      if (result.content?.length !== 1 || entry?.type !== 'text') throw new Error('Linear MCP result unavailable')
      return JSON.parse(entry.text)
    } catch (error) {
      await close()
      assertActive()
      if (retryAt > Date.now()) throw new LinearProjectReadError('rate limited', retryAt - Date.now())
      if (error instanceof LinearProjectReadError) throw error
      if (error?.code === -32001) throw new LinearProjectReadError('Linear authorization unavailable')
      if (retryOnSessionError && reused && !signal?.aborted) {
        return invokeTool(name, args, { retryOnSessionError: false })
      }
      throw new LinearProjectReadError('Linear MCP unavailable')
    }
  }

  return {
    async call(name, args) {
      if (!READ_TOOLS.has(name)) throw new LinearProjectReadError('Linear MCP tool outside read scope')
      return invokeTool(name, args, { retryOnSessionError: true })
    },
    async callWrite(name, args) {
      if (allowWrite !== true) throw new LinearProjectReadError('Linear MCP write disabled')
      if (!WRITE_TOOLS.has(name)) throw new LinearProjectReadError('Linear MCP tool outside write scope')
      validateWriteArgs(name, args)
      return invokeTool(name, args, { retryOnSessionError: false })
    },
    async ensureConnected() {
      assertActive()
      if (retryAt > Date.now()) throw new LinearProjectReadError('rate limited', retryAt - Date.now())
      if (!client) await connect()
    },
    hasWriteTool: name => allowWrite === true && writeTools.has(name),
    close,
  }
}
