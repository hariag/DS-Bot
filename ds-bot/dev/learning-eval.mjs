// Real-model check of the skill review in src/host/learning.js, on an OpenAI-compatible
// endpoint. Two stages per case in learning-eval/skill-cases.json:
//   decide: does the review propose the expected action (none, create, update) with the
//           rules the work showed and none of the one-off details?
//   effect: for the skills it creates, do held-out tasks of the same class come out
//           better with the skill than without, and does an unrelated task stay clean?
// Usage (no defaults; nothing is saved but the report):
//   LEARN_EVAL_BASE_URL=… LEARN_EVAL_MODEL=… LEARN_EVAL_KEY=… \
//   node --import ./test/harness-resolve.mjs dev/learning-eval.mjs [--reps 3] [--cases skill-cases.json] [--only id,id] [--out report.json]
import { readFileSync, writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { parseJson, skillProblem, skillRequest, skillSystem, LEARNING } from '../src/host/learning.js'
import { writtenIn } from '../src/host/memory.js'

const { values: args } = parseArgs({ options: { reps: { type: 'string', default: '3' }, only: { type: 'string' }, cases: { type: 'string', default: 'skill-cases.json' }, out: { type: 'string' }, stage: { type: 'string', default: 'decide,effect' } } })
const base = process.env.LEARN_EVAL_BASE_URL
const model = process.env.LEARN_EVAL_MODEL
const key = process.env.LEARN_EVAL_KEY
if (!base || !model || !key) throw new Error('Set LEARN_EVAL_BASE_URL, LEARN_EVAL_MODEL and LEARN_EVAL_KEY.')
const reps = Number(args.reps)
const stages = new Set(args.stage.split(','))
const cases = JSON.parse(readFileSync(new URL(`./learning-eval/${args.cases}`, import.meta.url), 'utf8')).cases
  .filter(entry => !args.only || args.only.split(',').includes(entry.id))

async function chat(system, user) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const response = await fetch(`${base.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], max_tokens: 8192, reasoning_effort: 'none' }),
        signal: AbortSignal.timeout(180_000),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const body = await response.json()
      return { text: body.choices?.[0]?.message?.content ?? '', tokens: body.usage?.total_tokens ?? 0 }
    } catch (error) {
      if (attempt >= 4) throw error
      await new Promise(resolve => setTimeout(resolve, 2000 * attempt))
    }
  }
}

const re = source => new RegExp(source, 'i')
let tokens = 0

async function decide(entry) {
  const learned = entry.learned ?? []
  const skills = Object.fromEntries([...learned, ...(entry.library ?? [])].map(skill => [skill.name, { kind: 'skill', content: '', ...skill }]))
  const user = entry.lines.filter(line => line.startsWith('User: ')).map(line => line.slice(6))
  const request = skillRequest({ bot: entry.bot, lines: entry.lines, learned, library: entry.library ?? [], declined: entry.declined ?? [], language: writtenIn(user, 'English') })
  const reply = await chat(skillSystem(), request)
  tokens += reply.tokens
  const proposal = parseJson(reply.text)
  const problem = skillProblem(proposal, { skills, learned: learned.map(skill => skill.name), limit: LEARNING.learnedMax })
  const action = problem === undefined ? proposal.action : 'invalid'
  const text = `${proposal?.description ?? ''}\n${proposal?.content ?? ''}`
  const misses = []
  if (action !== entry.expect) misses.push(`action ${action}${problem ? ` (${problem})` : ''}, expected ${entry.expect}`)
  if (action === entry.expect && action !== 'none') {
    if (entry.target && proposal.name !== entry.target) misses.push(`updated ${proposal.name}, expected ${entry.target}`)
    for (const must of entry.must ?? []) if (!re(must).test(text)) misses.push(`missing /${must}/`)
    for (const bad of entry.mustNot ?? []) if (re(bad).test(text)) misses.push(`has /${bad}/`)
  }
  return { pass: misses.length === 0, action, misses, proposal: action === 'invalid' ? reply.text : proposal }
}

const withSkill = skill => `You are a capable assistant.\n\nA skill applies to this kind of task; follow it:\n<skill name="${skill.name}">\ndescription: ${skill.description}\n${skill.content}\n</skill>`
const plain = 'You are a capable assistant.'
function gradeTask(task, answer) {
  const misses = []
  for (const must of task.expect ?? []) if (!re(must).test(answer)) misses.push(`missing /${must}/`)
  for (const bad of task.mustNot ?? []) if (re(bad).test(answer)) misses.push(`has /${bad}/`)
  const kept = answer.split('\n').filter(line => line.trim() !== '')
  if (task.lastLine && !re(task.lastLine).test(kept.at(-1) ?? '')) misses.push(`last line lacks /${task.lastLine}/`)
  if (task.maxLines && answer.split('\n').filter(line => line.trim() !== '').length > task.maxLines) misses.push(`more than ${task.maxLines} lines`)
  return misses
}

async function effect(entry, skill) {
  const arms = { without: plain, with: withSkill(skill) }
  const rows = []
  for (const [arm, system] of Object.entries(arms)) {
    for (const task of [...entry.heldOut, { ...entry.unrelated, unrelated: true }]) {
      for (let rep = 0; rep < reps; rep += 1) {
        const reply = await chat(system, task.task)
        tokens += reply.tokens
        const misses = gradeTask(task, reply.text)
        rows.push({ arm, unrelated: task.unrelated === true, task: task.task.slice(0, 40), pass: misses.length === 0, misses })
      }
    }
  }
  const rate = (arm, unrelated) => {
    const picked = rows.filter(row => row.arm === arm && row.unrelated === unrelated)
    return `${picked.filter(row => row.pass).length}/${picked.length}`
  }
  return { heldOut: { without: rate('without', false), with: rate('with', false) }, unrelated: { without: rate('without', true), with: rate('with', true) }, rows }
}

const report = { model, reps, cases: [] }
for (const entry of cases) {
  const result = { id: entry.id, expect: entry.expect, decide: [] }
  if (stages.has('decide')) for (let rep = 0; rep < reps; rep += 1) result.decide.push(await decide(entry))
  const made = result.decide.find(run => run.pass && run.action !== 'none')?.proposal
  if (stages.has('effect') && made && entry.heldOut) result.effect = await effect(entry, made)
  report.cases.push(result)
  const passed = result.decide.filter(run => run.pass).length
  console.log(`${entry.id.padEnd(22)} decide ${passed}/${result.decide.length}${result.effect ? `  held-out without ${result.effect.heldOut.without} with ${result.effect.heldOut.with}  unrelated with ${result.effect.unrelated.with}` : ''}`)
  for (const run of result.decide.filter(item => !item.pass)) console.log(`  - ${run.misses.join('; ')}`)
}
const all = report.cases.flatMap(entry => entry.decide)
const quiet = report.cases.filter(entry => entry.expect === 'none').flatMap(entry => entry.decide)
console.log(`decide total ${all.filter(run => run.pass).length}/${all.length}; restraint ${quiet.filter(run => run.pass).length}/${quiet.length}; tokens ${tokens}`)
if (args.out) writeFileSync(args.out, JSON.stringify(report, null, 1))
