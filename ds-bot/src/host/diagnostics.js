// Diagnostics: what went wrong on this host, kept where the user can see it and report it.
// DSH mounts no exporter for ctx.logger once it has started, so warnings would otherwise
// reach only stderr. Entries are kept in memory and in <home>/logs/diagnostics.jsonl, so
// a report written after a restart still has them. Every text is cleaned of saved keys,
// credential-like strings and the home folder before it is kept and again before it is
// shown, because the report is meant for a public issue.
import { readFileSync } from 'node:fs'
import { appendFile, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { arch, homedir, platform, release } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { format, promisify } from 'node:util'
import { gunzip as gunzipCb, gzip as gzipCb } from 'node:zlib'

const gzip = promisify(gzipCb)
const gunzip = promisify(gunzipCb)

export const KEEP = 200
const LOG_MAX_BYTES = 1 << 20
const LOG_MAX_FILES = 7
const LOG_MAX_AGE_DAYS = 14
const STACK_LINES = 8
const TEXT_MAX = 2000
export const REPORT_ENTRIES = 20
export const ISSUES_URL = 'https://github.com/Fei2411/DS-Bot/issues/new'

const quote = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Shapes of credentials that are not saved keys: provider keys, bearer tokens, and
// token or key parameters in addresses (the Web login address carries one).
const CREDENTIALS = [
  [/\bsk-[A-Za-z0-9_*.-]{6,}/g, 'sk-[hidden]'],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}/g, '[hidden]'],
  [/\bgithub_pat_[A-Za-z0-9_]{16,}/g, '[hidden]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[hidden]'],
  [/\bxox[baprs]-[A-Za-z0-9-]{8,}/g, '[hidden]'],
  [/\bAIza[A-Za-z0-9_-]{20,}/g, '[hidden]'],
  // JSON web tokens: three base64url parts, the first always starting eyJ.
  [/\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g, '[hidden]'],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=*-]{8,}/gi, '$1 [hidden]'],
  [/([?&#](?:token|access_token|api_key|apikey|key|secret|password)=)[^&\s"']+/gi, '$1[hidden]'],
  [/(["']?(?:api[_-]?key|authorization|x-api-key|password|secret)["']?\s*[:=]\s*["']?)[^\s"',}]{6,}/gi, '$1[hidden]'],
]

export function cleanText(text, { redact = value => value, home = homedir() } = {}) {
  let out = redact(String(text ?? ''))
  for (const [pattern, replacement] of CREDENTIALS) out = out.replace(pattern, replacement)
  if (home && home.length > 1) {
    out = out.replace(new RegExp(quote(home), 'g'), '~')
    // JSON and Windows paths spell the same folder with doubled or forward slashes.
    const slashes = home.replace(/\\/g, '/')
    if (slashes !== home) out = out.replace(new RegExp(quote(slashes), 'g'), '~')
    const doubled = home.replace(/\\/g, '\\\\')
    if (doubled !== home) out = out.replace(new RegExp(quote(doubled), 'g'), '~')
  }
  return out.length > TEXT_MAX ? `${out.slice(0, TEXT_MAX)}…` : out
}

const errorText = error => `${error.name && error.name !== 'Error' ? `${error.name}: ` : ''}${error.message}`

// One log line, as the downloaded log and the report show it.
export function entryLine(entry) {
  const where = [entry.bot, entry.where].filter(Boolean).join(' · ')
  const code = entry.code ? ` [${entry.code}${entry.status ? ` ${entry.status}` : ''}]` : ''
  return `${new Date(entry.time).toISOString()} ${entry.level.toUpperCase()} ${entry.source}${where ? ` (${where})` : ''}${code} ${entry.text}`
}

// The Markdown block for an issue. `facts` come from this host, `client` from the
// browser that asked; `entries` are already cleaned.
export function reportMarkdown({ facts, client = {}, entries = [], clientEntries = [] }) {
  const row = (label, value) => (value === undefined || value === null || value === '' ? null : `| ${label} | ${String(value).replace(/\|/g, '\\|')} |`)
  const lines = [
    '| | |',
    '|---|---|',
    row('DS Bot', facts.botVersion),
    row('DSH', facts.dshVersion),
    row('Surface', client.surface),
    row('OS', facts.os),
    row('Node', facts.node),
    row('Browser', client.userAgent),
    row('Language', client.language),
    row('Team', facts.team),
    row('Models', facts.models),
    row('Read-only', facts.readOnly),
  ].filter(Boolean)
  const recent = entries.slice(-REPORT_ENTRIES)
  const out = [...lines, '']
  out.push(recent.length === 0 ? 'No host errors recorded.' : `Recent host errors (${recent.length} of ${entries.length}, oldest first):`)
  if (recent.length > 0) out.push('```', ...recent.map(entryLine), '```')
  const stacks = recent.filter(entry => entry.stack).slice(-3)
  for (const entry of stacks) out.push('', `<details><summary>Stack: ${entry.text.slice(0, 80).replace(/</g, '&lt;')}</summary>`, '', '```', entry.stack, '```', '</details>')
  if (clientEntries.length > 0) {
    out.push('', `Recent browser errors (${Math.min(clientEntries.length, 10)}):`, '```', ...clientEntries.slice(-10).map(entryLine), '```')
  }
  return out.join('\n')
}

const ownVersion = () => {
  try {
    const version = JSON.parse(readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8')).version
    // The local build adds a +aios.<stamp> suffix; the report table keeps the semver.
    return version.split('+')[0]
  } catch {
    return undefined
  }
}

// DSH packages share one version; the LLM package is always beside the plugin.
export const dshVersion = () => {
  try {
    let dir = dirname(fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-llm')))
    for (let depth = 0; depth < 5; depth += 1, dir = dirname(dir)) {
      try {
        const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
        if (manifest.name === '@deepseek-ai/dsh-llm') return manifest.version
      } catch {}
    }
  } catch {}
  return undefined
}

export function install(rt) {
  const { ctx, home, config } = rt
  const logDir = join(home, 'logs')
  const logPath = join(logDir, 'diagnostics.jsonl')
  const toFile = config.diagnosticsFile !== false
  const maxBytes = config.diagnosticsMaxBytes ?? LOG_MAX_BYTES
  const maxFiles = config.diagnosticsMaxFiles ?? LOG_MAX_FILES
  const maxAgeDays = config.diagnosticsMaxAgeDays ?? LOG_MAX_AGE_DAYS
  let fresh = []
  let writing = Promise.resolve()
  let fileFailed = false
  let stopped = false
  let rotateSeq = 0

  // The log is written in the background. A stop waits for what is queued and writes
  // nothing after it, so nothing changes in `home` once the plugin has stopped.
  ctx.effect(() => () => {
    stopped = true
    return writing
  }, 'ds-bot: diagnostics log')

  const clean = text => cleanText(text, { redact: rt.redactSecrets })

  const archivePattern = /^diagnostics\.jsonl\.(\d{8}-\d{6}-\d{3})\.(\d+)\.(gz|raw)$/
  const isArchiveName = name => name === 'diagnostics.jsonl.1' || archivePattern.test(name)
  const sortNewestFirst = (a, b) => {
    if (a === 'diagnostics.jsonl.1') return 1
    if (b === 'diagnostics.jsonl.1') return -1
    return b.localeCompare(a)
  }
  const parseEntries = (text) => String(text ?? '').split('\n').filter(Boolean).flatMap((line) => {
    try {
      const entry = JSON.parse(line)
      return typeof entry?.time === 'number' && typeof entry.text === 'string' ? [entry] : []
    } catch {
      return []
    }
  })

  const loadEarlier = async () => {
    const collected = []
    const active = await readFile(logPath, 'utf8').then(parseEntries, () => [])
    collected.push(...active.slice(-KEEP))
    if (collected.length >= KEEP) return collected.slice(-KEEP)
    const names = await readdir(logDir).catch(() => [])
    const archives = names.filter(isArchiveName).sort(sortNewestFirst)
    for (const name of archives) {
      if (collected.length >= KEEP) break
      const filePath = join(logDir, name)
      const text = name.endsWith('.gz')
        ? await readFile(filePath).then(buf => gunzip(buf)).then(buf => buf.toString('utf8')).catch(() => '')
        : await readFile(filePath, 'utf8').catch(() => '')
      const parsed = parseEntries(text)
      if (parsed.length > 0) {
        const needed = KEEP - collected.length
        collected.unshift(...parsed.slice(-needed))
      }
    }
    return collected.slice(-KEEP)
  }

  // Entries from earlier runs, read once; new ones are kept apart until then.
  const earlier = toFile ? loadEarlier() : Promise.resolve([])
  let cleared = 0

  const pruneArchives = async () => {
    const names = await readdir(logDir).catch(() => [])
    const archives = names.filter(isArchiveName).sort(sortNewestFirst)
    const cutoffMs = Date.now() - maxAgeDays * 86_400_000
    for (let i = 0; i < archives.length; i += 1) {
      const filePath = join(logDir, archives[i])
      if (i >= maxFiles) {
        await unlink(filePath).catch(() => {})
        continue
      }
      const st = await stat(filePath).catch(() => null)
      if (st !== null && st.mtimeMs < cutoffMs) {
        await unlink(filePath).catch(() => {})
      }
    }
  }

  const formatStamp = (now) => {
    const d = new Date(now)
    const pad = (n, width = 2) => String(n).padStart(width, '0')
    return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}-${pad(d.getUTCMilliseconds(), 3)}`
  }

  const append = (entry) => {
    if (!toFile || stopped) return
    writing = writing.then(async () => {
      await mkdir(logDir, { recursive: true })
      const size = await stat(logPath).then(info => info.size, () => 0)
      if (size >= maxBytes) {
        rotateSeq += 1
        const stamp = `${formatStamp(Date.now())}.${String(rotateSeq).padStart(6, '0')}`
        const rawPath = `${logPath}.${stamp}.raw`
        const gzPath = `${logPath}.${stamp}.gz`
        await rename(logPath, rawPath)
        await appendFile(logPath, `${JSON.stringify(entry)}\n`, 'utf8')
        try {
          const rawBuf = await readFile(rawPath)
          const gzBuf = await gzip(rawBuf)
          const tmpGz = `${gzPath}.tmp`
          await writeFile(tmpGz, gzBuf)
          await rename(tmpGz, gzPath)
          await unlink(rawPath)
        } catch {
          // Keep raw rotated file if gzip fails; active logging remains unaffected.
        }
        await pruneArchives()
        return
      }
      await appendFile(logPath, `${JSON.stringify(entry)}\n`, 'utf8')
    }).catch((error) => {
      if (fileFailed) return
      fileFailed = true
      console.error('[ds-bot] diagnostics log not written:', error?.code ?? clean(error?.message ?? String(error)))
    })
  }

  // `fields`: source ('host', 'turn', 'api'), level, code, status, bot, where, sessionId, stack.
  const note = ({ level = 'error', source = 'host', text, stack, ...fields }) => {
    const entry = { time: Date.now(), level, source, text: clean(text) }
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined && value !== null && value !== '') entry[key] = typeof value === 'string' ? clean(value) : value
    }
    // Frames only: the first line repeats the message, which is already the text.
    const frames = typeof stack === 'string' ? stack.split('\n').filter(line => /^\s+at /.test(line)).slice(0, STACK_LINES).map(line => line.trim()) : []
    if (frames.length > 0) entry.stack = clean(frames.join('\n'))
    fresh.push(entry)
    if (fresh.length > KEEP) fresh = fresh.slice(-KEEP)
    append(entry)
    return entry
  }

  const warn = (template, ...args) => {
    const error = args.find(arg => arg instanceof Error)
    const line = clean(format(template, ...args.map(arg => (arg instanceof Error ? errorText(arg) : arg))))
    const frames = typeof error?.stack === 'string' ? error.stack.split('\n').filter(item => /^\s+at /.test(item)).slice(0, STACK_LINES).map(item => item.trim()) : []
    ctx.logger.warn('%s', line)
    console.error(`[ds-bot] ${line}${frames.length > 0 ? `\n${clean(frames.join('\n'))}` : ''}`)
    note({
      level: 'warn',
      source: 'host',
      text: line.replace(/^ds-bot: /, ''),
      code: typeof error?.code === 'string' ? error.code : undefined,
      stack: error?.stack,
    })
  }

  const entries = async () => {
    const old = (await earlier).filter(entry => entry.time > cleared)
    return [...old, ...fresh].slice(-KEEP).map(entry => ({
      ...entry,
      text: clean(entry.text),
      ...(entry.stack ? { stack: clean(entry.stack) } : {}),
    }))
  }

  const facts = () => {
    const bots = Object.values(rt.state.bots)
    const models = [...new Set(bots.map(bot => bot.model ?? bot.appliedModel).filter(Boolean))]
    const count = (n, one, many) => `${n} ${n === 1 ? one : many}`
    const groups = Object.keys(rt.state.rooms).length
    return {
      botVersion: ownVersion(),
      dshVersion: dshVersion(),
      os: `${platform()} ${release()} ${arch()}`,
      node: process.version,
      team: `${count(bots.length, 'Bot', 'Bots')}, ${rt.state.mainBotIds.length} Main, ${count(groups, 'group chat', 'group chats')}`,
      models: models.length > 0 ? models.join(', ') : undefined,
      readOnly: rt.readOnly?.() ? 'yes, another dsh holds the team' : undefined,
    }
  }

  const sanitizeClient = (client) => {
    const pick = (value, max) => (typeof value === 'string' ? clean(value.slice(0, max)) : undefined)
    return {
      surface: pick(client?.surface, 40),
      language: pick(client?.language, 20),
      userAgent: pick(client?.userAgent, 200),
    }
  }
  const sanitizeClientEntries = list => (Array.isArray(list) ? list : []).slice(-20).flatMap((item) => {
    if (typeof item?.text !== 'string' || typeof item.time !== 'number') return []
    return [{ time: item.time, level: item.level === 'warn' ? 'warn' : 'error', source: 'browser', text: clean(item.text.slice(0, 500)), ...(typeof item.code === 'string' ? { code: clean(item.code.slice(0, 40)) } : {}) }]
  })

  async function report(body = {}) {
    await rt.loadSecrets?.().catch(() => {})
    const list = await entries()
    const client = sanitizeClient(body.client)
    const clientEntries = sanitizeClientEntries(body.clientErrors)
    const hostFacts = facts()
    return {
      facts: hostFacts,
      entries: list.slice(-50).reverse(),
      total: list.length,
      markdown: reportMarkdown({ facts: hostFacts, client, entries: list, clientEntries }),
      issuesUrl: ISSUES_URL,
    }
  }

  async function logText() {
    await rt.loadSecrets?.().catch(() => {})
    const list = await entries()
    return list.map(entry => (entry.stack ? `${entryLine(entry)}\n${entry.stack.replace(/^/gm, '    ')}` : entryLine(entry))).join('\n')
  }

  async function clear() {
    cleared = Date.now()
    fresh = []
    if (!toFile || stopped) return
    writing = writing.then(async () => {
      await writeFile(logPath, '', 'utf8')
      const names = await readdir(logDir).catch(() => [])
      for (const name of names) {
        if (isArchiveName(name) || name.endsWith('.gz.tmp')) {
          await unlink(join(logDir, name)).catch(() => {})
        }
      }
    }).catch(() => {})
    await writing
  }

  const issueFacts = () => {
    const { botVersion, dshVersion, os } = facts()
    return [botVersion && `DS Bot: ${botVersion}`, dshVersion && `DSH: ${dshVersion}`, `OS: ${os}`].filter(Boolean).join('\n')
  }
  Object.assign(rt, { warn, noteFailure: note, diagnostics: { report, logText, clear, entries, issueFacts } })
}
