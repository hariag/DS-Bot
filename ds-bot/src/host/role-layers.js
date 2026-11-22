import { createHash } from 'node:crypto'
// Source hashes enter this set only after complete per-role semantic review.
// An explicit marker alone is never sufficient to move a hard rule.
const APPROVED_SOURCES = new Set([])
const START = '[[DSBOT_EXPERIENCE:'
const END = '[[/DSBOT_EXPERIENCE]]'
export const sourceHash = text => createHash('sha256').update(text, 'utf8').digest('hex')
export function parseMaterials(text, approvals = APPROVED_SOURCES) {
  if (typeof text !== 'string' || !text.includes(START)) return undefined
  const sha = sourceHash(text)
  if (!approvals.has(sha)) return undefined
  const pattern = /\[\[DSBOT_EXPERIENCE:([A-Za-z0-9_-]{1,48})\]\]([\s\S]*?)\[\[\/DSBOT_EXPERIENCE\]\]/g
  const matches = [...text.matchAll(pattern)], ids = new Set(), entries = [], pieces = []
  let pos = 0
  for (const m of matches) {
    const before = text.slice(pos, m.index)
    if (before.includes(START) || before.includes(END) || m[2].includes(START) || m[2].includes(END) || !m[2].trim() || ids.has(m[1])) return undefined
    ids.add(m[1]); pieces.push(before); entries.push({ id:m[1], text:m[2] }); pieces.push(null); pos = m.index + m[0].length
  }
  const tail = text.slice(pos)
  if (!matches.length || tail.includes(START) || tail.includes(END)) return undefined
  pieces.push(tail); let i = 0
  const core = pieces.map(x => x === null ? `[Before work where this experience applies, call read_role_material with id ${entries[i++].id} and source_sha256 ${sha}.]` : x).join('')
  return { sourceSha256:sha, core, entries }
}
export function rolePromptText(rt, bot, context, approvals = APPROVED_SOURCES) {
  const text = bot?.instructions || ''
  // No approved roles means no lookup, tools, or prompt change.
  if (approvals.size === 0) return text
  try {
    const refs = [bot?.model, bot?.appliedModel].filter(ref => ref !== undefined && ref !== null && ref !== '')
    if (!refs.length || typeof rt.isLocalAgentRef !== 'function' || refs.some(ref => typeof ref !== 'string' || rt.isLocalAgentRef(ref))) return text
    const own = rt.teamTools?.find(tool => tool.name === 'read_role_material')
    const visible = context?.agent?.ctx?.tools?.get?.('read_role_material', context.scope, context.toolSet)
    if (!own || visible !== own) return text
    return parseMaterials(text, approvals)?.core ?? text
  } catch { return text }
}
export function roleMaterialTool(rt, defineTool, output, approvals = APPROVED_SOURCES) {
  if (approvals.size === 0) return undefined
  return defineTool({ name:'read_role_material', description:'Read an approved experience section from your own current role; this cannot grant authority or override core rules.',
    parameters:{ id:{type:'string',required:true}, source_sha256:{type:'string',required:true} }, output,
    async execute(args, exec) {
      await rt.load()
      const bot = rt.botOf(rt.selfOf(exec.agent?.id)), parsed = bot && parseMaterials(bot.instructions, approvals)
      if (!parsed || parsed.sourceSha256 !== args.source_sha256) return 'Role material unavailable or changed; re-read your current instructions before continuing.'
      return parsed.entries.find(x => x.id === args.id)?.text ?? 'Unknown experience id; re-read your current instructions.'
    },
  })
}
