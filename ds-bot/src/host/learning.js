// Learning from work. After a long turn a Bot's chat is marked for review. When the
// team has been idle for a while, and at most every few hours, one background pass
// reads what was said since the last pass and asks the Bot's model whether the work
// taught a skill worth keeping. Most work teaches nothing, so most passes propose
// nothing. A proposal never takes effect by itself: it waits as a card in the Bot's
// chat until the user approves it, and a declined one is remembered so the same idea
// does not come back.
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { replaceFile } from './files.js'
import { looksLikeKey, looksSecret, writtenIn } from './memory.js'
import { validateCapabilityName } from './capabilities.js'

export const LEARNING = {
  minTurnMs: 3 * 60_000,
  idleMs: 10 * 60_000,
  intervalMs: 12 * 60 * 60_000,
  tickMs: 60_000,
  readMs: 15_000,
  textMax: 24_000,
  userLineMax: 2_000,
  botLineMax: 1_200,
  learnedMax: 5,
  descriptionMax: 300,
  contentMax: 8_000,
  declinedMax: 20,
}

const clip = (text, max) => (text.length > max ? `${text.slice(0, max)} […]` : text)
export const hashOf = text => createHash('sha256').update(String(text ?? '')).digest('hex').slice(0, 16)

// The answer of the review's model: one JSON object, perhaps in a code fence.
export function parseJson(text) {
  const raw = String(text ?? '').trim()
  // A skill's content may hold code fences of its own, so read the whole answer first
  // and fall back to a fenced block only when that fails.
  const fenced = /^```(?:json)?\s*([\s\S]*?)```\s*$/.exec(raw)?.[1]
  for (const candidate of [raw, fenced]) {
    if (candidate === undefined) continue
    const start = candidate.indexOf('{')
    const end = candidate.lastIndexOf('}')
    if (start === -1 || end < start) continue
    try {
      const value = JSON.parse(candidate.slice(start, end + 1))
      if (value && typeof value === 'object' && !Array.isArray(value)) return value
    } catch {}
  }
  return undefined
}

// ---------------------------------------------------------------------------
// The skill review.

export function skillSystem() {
  return [
    'You review a stretch of finished work by an AI Bot and decide whether it taught a skill worth keeping.',
    'A skill is a short document that a future Bot loads when a task of the same class comes up. Strong models already do most tasks well without one, so a weak or narrow skill only adds noise. Most work teaches nothing new: answer "none" unless every test below passes.',
    '',
    'Tests:',
    '1. Reusable: tasks of this class will come up again in later, different work. A rule that only fits this task, file, bug, or pull request fails.',
    '2. Missing knowledge: it gives constraints or context that a capable model does not have or gets wrong: requirements and corrections the user stated, project or tool conventions found by trial and error, pitfalls that cost time, how this user wants the result checked or delivered. General know-how fails, and so does anything that reading the code or the docs shows at once.',
    '3. Earned: the work shows it. The user asked for it or corrected the Bot, or a non-obvious way was found after one that failed. Never invent rules the work did not show.',
    '4. Not covered: no listed skill already says it. When a learned skill of this Bot covers the class, update that skill instead of making a new one. Also update a learned skill that the work showed to be wrong, outdated, or missing a step.',
    '',
    'Never put in a skill: one-off facts, task progress, file lists, dates, version, pull request or issue numbers, pasted errors or logs, facts about the user that are not about how to work (memory keeps those), or keys, passwords, and tokens.',
    'Write rules that stand alone, not the story of this work: a reason says why the rule matters, never when or how it was broken ("the user corrected this before", "version 1.2 missed it"). Examples must be general, not the files, values, or fixes of this task.',
    '',
    'Form:',
    '- name: the class of task, lowercase letters, digits, and single hyphens, 32 characters at most, e.g. "release-checks", never "fix-login-bug".',
    '- description: one sentence, 200 characters at most, that says when to use the skill. Be concrete about the trigger.',
    '- content: Markdown, 600 words at most. The rules as short imperative lines, each with a brief reason when it is not obvious; numbered steps only where order matters; how to check the work is done. Keep what is still true when you update, and remove what the work showed to be wrong.',
    '',
    'Answer with one JSON object only, one of:',
    '{"action":"none","reason":"<one sentence>"}',
    '{"action":"create","name":"…","description":"…","content":"…","why":"<one sentence: what in this work shows the skill is needed>"}',
    '{"action":"update","name":"<a learned skill listed>","description":"…","content":"<the whole new content>","why":"<one sentence>"}',
  ].join('\n')
}

// `learned`: this Bot's learned skills, in full. `library`: every other skill on the
// team, by name and description. `declined`: proposals the user turned down.
export function skillRequest({ bot, lines, learned = [], library = [], declined = [], language, limit = LEARNING.learnedMax }) {
  const parts = [`The Bot: ${bot.name}${bot.role ? `, ${bot.role}` : ''}.`]
  parts.push(learned.length === 0
    ? 'This Bot has no learned skills yet.'
    : `This Bot's learned skills (${learned.length} of ${limit}${learned.length >= limit ? '; at the limit, only update one' : ''}):\n${learned.map(skill => `<skill name="${skill.name}">\ndescription: ${skill.description}\n${skill.content}\n</skill>`).join('\n')}`)
  if (library.length > 0) parts.push(`Other skills on the team:\n${library.map(skill => `- ${skill.name}: ${skill.description}`).join('\n')}`)
  if (declined.length > 0) parts.push(`Proposals the user declined. Do not propose them again unless this work shows something new:\n${declined.map(entry => `- ${entry.name}: ${entry.description}`).join('\n')}`)
  if (language) parts.push(`Write the description and the content in ${language}.`)
  parts.push(`The work, oldest first ("User:" lines are the user's own words):\n<work>\n${lines.join('\n')}\n</work>`)
  return parts.join('\n\n')
}

// What keeps a proposal from the user, or undefined when it may be shown.
// `skills`: the team's skills by name; `learned`: names this Bot learned.
// Skills often talk about code such as `password == input`; read keys everywhere, but
// password wording only outside code.
const holdsSecret = text => looksLikeKey(text) || looksSecret(text.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' '))

export function skillProblem(proposal, { skills, learned, limit = LEARNING.learnedMax }) {
  if (proposal === undefined) return 'the answer is not a JSON object'
  const { action } = proposal
  if (action === 'none') return undefined
  if (action !== 'create' && action !== 'update') return `unknown action ${String(action)}`
  let name
  try {
    name = validateCapabilityName(proposal.name)
  } catch (error) {
    return error.message
  }
  const description = typeof proposal.description === 'string' ? proposal.description.trim() : ''
  const content = typeof proposal.content === 'string' ? proposal.content.trim() : ''
  if (description === '' || description.length > LEARNING.descriptionMax) return `the description must have 1 to ${LEARNING.descriptionMax} characters`
  if (content === '' || content.length > LEARNING.contentMax) return `the content must have 1 to ${LEARNING.contentMax} characters`
  if (holdsSecret(description) || holdsSecret(content)) return 'it looks like it holds a secret'
  const existing = Object.hasOwn(skills, name) ? skills[name] : undefined
  if (action === 'create') {
    if (existing !== undefined) return `${name} already exists`
    if (learned.length >= limit) return `the Bot already keeps ${limit} learned skills`
  } else {
    if (existing === undefined || existing.kind !== 'skill' || !learned.includes(name)) return `${name} is not a learned skill of this Bot`
    if (existing.content.trim() === content && existing.description.trim() === description) return 'the update changes nothing'
  }
  return undefined
}

// ---------------------------------------------------------------------------

export function install(rt) {
  const { ctx, config, home, state } = rt
  const settings = { ...LEARNING, ...(config.learningTimes ?? {}) }
  const on = config.learning !== false && config.memory !== false
  const view = () => ({})
  if (!on) {
    Object.assign(rt, { learningView: view, learningEndpoint: async () => { throw new Error('Learning is turned off on this host') }, learningRun: async () => 0 })
    return
  }

  const root = join(home, 'learning')
  const path = join(root, 'state.json')
  // `pending`: Bot id → the chat Sessions with a long turn since the last pass.
  // `cursors`: Session id → the newest line a pass has read. `proposals`: waiting
  // for the user, by id. `declined`: the latest proposals the user turned down.
  let saved
  const data = () => {
    if (saved !== undefined) return saved
    try {
      saved = JSON.parse(readFileSync(path, 'utf8'))
    } catch (error) {
      if (error?.code !== 'ENOENT') rt.warn('ds-bot: unreadable learning state %s: %s', path, error?.message ?? error)
      saved = {}
    }
    saved.pending ??= {}
    saved.cursors ??= {}
    saved.proposals ??= {}
    saved.declined ??= []
    return saved
  }
  let writing = Promise.resolve()
  const persist = () => {
    const text = JSON.stringify(data(), null, 1)
    writing = writing.then(async () => {
      await mkdir(dirname(path), { recursive: true })
      const temp = `${path}.${process.pid}.tmp`
      await writeFile(temp, text, 'utf8')
      await replaceFile(temp, path)
    }).catch(error => rt.warn('ds-bot: saving the learning state failed: %s', error?.message ?? error))
    return writing
  }

  // A turn in a Bot's own chat that ran long marks the chat for the next pass.
  const started = new Map()
  let lastActivity = Date.now()
  ctx.on('agent/status', ({ agent, status }) => {
    const id = agent?.id
    if (id === undefined || !rt.isBotSession(id)) return
    lastActivity = Date.now()
    if (status !== 'idle') {
      if (!started.has(id)) started.set(id, Date.now())
      return
    }
    const since = started.get(id)
    started.delete(id)
    const botId = rt.chatOwners.get(id)
    if (since === undefined || botId === undefined || Date.now() - since < settings.minTurnMs) return
    const pending = data().pending
    pending[botId] = [...new Set([...(pending[botId] ?? []), id])]
    void persist()
  })

  // What was said in a chat since the last pass, newest lines first until the budget.
  async function linesSince(sessionId) {
    const cursor = data().cursors[sessionId]
    const kept = []
    let used = 0
    let through
    for await (const line of rt.partLines(sessionId, AbortSignal.timeout(settings.readMs), { pages: Infinity })) {
      through ??= line.seq
      if (cursor !== undefined && line.seq <= cursor) break
      const text = clip(line.text, line.who === 'user' ? settings.userLineMax : settings.botLineMax)
      if (kept.length > 0 && used + text.length > settings.textMax) break
      kept.push(text)
      used += text.length
    }
    return { lines: kept.reverse(), through }
  }

  const skillsOf = () => Object.fromEntries(Object.entries(state.capabilities?.items ?? {}).filter(([, item]) => item.kind === 'skill'))
  const learnedOf = bot => (bot.capabilities ?? []).filter(name => skillsOf()[name]?.learned === true)
  const waitingFor = botId => Object.values(data().proposals).filter(entry => entry.botId === botId)

  async function reviewSkill(bot, lines) {
    const skills = skillsOf()
    const learned = learnedOf(bot)
    const library = Object.values(skills).filter(item => !learned.includes(item.name)).map(item => ({ name: item.name, description: item.description }))
    const text = skillRequest({
      bot,
      lines,
      learned: learned.map(name => skills[name]),
      library,
      declined: data().declined,
      language: writtenIn(lines.filter(line => line.startsWith('User: ')).map(line => line.slice(6)), rt.uiLanguage?.()),
      limit: settings.learnedMax,
    })
    const reply = await rt.botShot(bot, skillSystem(), text, { sessionId: rt.chatOf(bot.id), kind: 'memory' })
    const proposal = parseJson(reply)
    const problem = skillProblem(proposal, { skills, learned, limit: settings.learnedMax })
    if (problem !== undefined) {
      rt.warn('ds-bot: the skill review of %s proposed nothing usable: %s', bot.name, problem)
      return undefined
    }
    if (proposal.action === 'none') return undefined
    const name = proposal.name.trim()
    const previous = proposal.action === 'update' ? skills[name] : undefined
    return {
      id: randomUUID(),
      kind: 'skill',
      action: proposal.action,
      botId: bot.id,
      at: Date.now(),
      name,
      description: proposal.description.trim(),
      content: proposal.content.trim(),
      why: typeof proposal.why === 'string' ? clip(proposal.why.trim(), 300) : '',
      ...(previous ? { previous: { description: previous.description, content: previous.content }, base: hashOf(previous.content) } : {}),
    }
  }

  // One pass over every Bot with a long turn since the last one. A Bot with a
  // proposal still waiting is skipped: its chat is read again in the next pass.
  let running
  async function run() {
    if (running) return running
    running = (async () => {
      const store = data()
      store.lastRun = Date.now()
      let made = 0
      for (const [botId, sessions] of Object.entries(store.pending)) {
        const bot = rt.botOf(botId)
        if (bot === undefined) {
          delete store.pending[botId]
          continue
        }
        if (waitingFor(botId).length > 0) continue
        const read = []
        for (const sessionId of sessions) read.push({ sessionId, ...await linesSince(sessionId) })
        const lines = read.flatMap(entry => entry.lines)
        try {
          const proposal = lines.length === 0 ? undefined : await reviewSkill(bot, lines)
          if (proposal !== undefined) {
            store.proposals[proposal.id] = proposal
            made += 1
          }
        } catch (error) {
          rt.warn('ds-bot: the skill review of %s failed: %s', bot.name, error?.message ?? error)
          continue
        }
        for (const entry of read) if (entry.through !== undefined) store.cursors[entry.sessionId] = entry.through
        delete store.pending[botId]
      }
      await persist()
      return made
    })().finally(() => { running = undefined })
    return running
  }

  const due = () => {
    const store = data()
    if (Object.keys(store.pending).length === 0 || rt.readOnly() !== undefined) return false
    if (Object.keys(rt.workView()).length > 0 || Date.now() - lastActivity < settings.idleMs) return false
    return store.lastRun === undefined || Date.now() - store.lastRun >= settings.intervalMs
  }
  ctx.effect(() => {
    const timer = setInterval(() => {
      if (due()) void run().catch(error => rt.warn('ds-bot: learning pass failed: %s', error?.message ?? error))
    }, settings.tickMs)
    timer.unref?.()
    return () => clearInterval(timer)
  }, 'ds-bot: learning')

  // The user's answer to a card.
  async function answer({ id, approve }) {
    const store = data()
    const proposal = Object.hasOwn(store.proposals, id) ? store.proposals[id] : undefined
    if (proposal === undefined) throw Object.assign(new Error('This proposal is no longer open'), { code: 'bot/stale' })
    delete store.proposals[id]
    if (approve !== true) {
      store.declined = [...store.declined, { name: proposal.name, description: proposal.description, at: Date.now() }].slice(-settings.declinedMax)
      await persist()
      return { applied: false }
    }
    try {
      await applySkill(proposal)
    } finally {
      await persist()
    }
    return { applied: true }
  }

  async function applySkill(proposal) {
    const bot = rt.botOf(proposal.botId)
    if (bot === undefined) throw new Error('The Bot that learned this skill is gone')
    const current = skillsOf()[proposal.name]
    if (proposal.action === 'create' && current !== undefined) throw new Error(`A skill named ${proposal.name} exists now`)
    if (proposal.action === 'update' && (current === undefined || hashOf(current.content) !== proposal.base)) throw new Error(`${proposal.name} changed since this was proposed`)
    const item = await rt.capabilitySave({ name: proposal.name, kind: 'skill', description: proposal.description, content: proposal.content }, { botId: bot.id, ui: false })
    item.learned = true
    await rt.save()
    if (!(bot.capabilities ?? []).includes(item.name)) await rt.capabilityEndpoint('bot-capability', { botId: bot.id, name: item.name, attached: true })
  }

  async function learningEndpoint(endpoint, body) {
    if (endpoint === 'learning-answer') return answer({ id: String(body.id ?? ''), approve: body.approve === true })
    throw new Error(`Unknown endpoint ${endpoint}`)
  }

  // Per Bot, its proposals waiting for the user.
  const learningView = () => {
    const byBot = {}
    for (const entry of Object.values(data().proposals)) (byBot[entry.botId] ??= []).push(entry)
    return byBot
  }

  Object.assign(rt, { learningView, learningEndpoint, learningRun: run })
}
