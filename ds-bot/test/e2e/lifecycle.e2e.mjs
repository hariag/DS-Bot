#!/usr/bin/env node
// End-to-end lifecycle sample: a student grade management system driven from
// the Trello-style board through a DS-Bot release group, lifecycle tasks,
// independent review, release gates and a generated summary report.
//
//   $env:MOCK_BOARD_AUTORUN='1'; node test/e2e/lifecycle.e2e.mjs --fresh
import { existsSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { execFileSync, spawn } from 'node:child_process'
import { join } from 'node:path'
import { REPO, boardApi, loginToken, startBench, stopBench } from './bench.mjs'

const HOME = process.env.BOARD_E2E_HOME || join(REPO, '.dsh-test-lifecycle-e2e')
const WEB_PORT = Number(process.env.BOARD_E2E_WEB_PORT || 3098)
const MOCK_PORT = Number(process.env.BOARD_E2E_MOCK_PORT || 8798)
const FRESH = process.argv.includes('--fresh')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const ROLE_BOTS = [
  ['pm', 'Project Manager', 'Project Manager'],
  ['product', 'Product Manager', 'Product Manager'],
  ['architect', 'Architect', 'Architect'],
  ['ui', 'UI Designer', 'UI Designer'],
  ['ux', 'UX Designer', 'UX Designer'],
  ['frontend', 'Frontend Developer', 'Frontend Developer'],
  ['backend', 'Backend Developer', 'Backend Developer'],
  ['tester', 'Test Engineer', 'Test Engineer'],
  ['reviewer', 'Independent Reviewer', 'Independent Reviewer'],
  ['ops', 'Operations Engineer', 'Operations Engineer'],
]
const ROLE_MAP = { pm:'projectManager', product:'productManager', architect:'architect', ui:'uiDesigner', ux:'uxDesigner', frontend:'frontend', backend:'backend', tester:'tester', reviewer:'reviewer', ops:'ops' }

function log(line) { console.log(line) }
function fail(message, evidence) { throw Object.assign(new Error(message), { evidence }) }
async function waitFor(label, fn, timeout = 60_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = await fn().catch(() => undefined)
    if (value) return value
    await sleep(500)
  }
  throw new Error('timed out waiting for ' + label)
}

async function main() {
  if (FRESH) {
    await stopBench({ home:HOME, webPort:WEB_PORT, mockPort:MOCK_PORT })
    rmSync(HOME, { recursive:true, force:true })
  }
  process.env.MOCK_BOARD_AUTORUN = '1'
  process.env.DS_BOT_RELEASE_MONITOR_MS = '1000'
  const bench = await startBench({ home:HOME, webPort:WEB_PORT, mockPort:MOCK_PORT })
  log('bench ' + bench.base)
  let cookie
  const api = async (endpoint, payload = {}) => boardApi(bench.base, cookie, endpoint, payload)
  try {
    cookie = (await loginToken(bench.loginUrl)).cookie
    let state
    for (let attempt = 0; attempt < 20; attempt++) {
      try { state = await api('state'); break }
      catch (error) {
        if (attempt === 19) throw error
        if (!/HTTP 404/.test(error.message)) throw error
        await sleep(500)
      }
    }
    const bot = async (name, role) => {
      let found = Object.values(state.bots).find(item => item.name === name)
      if (!found) {
        await api('create-bot', { name, role, instructions:`You are the ${role} on a software release team. Work only on assigned board tasks and record evidence.` })
        state = await api('state')
        found = Object.values(state.bots).find(item => item.name === name)
      }
      if (!found) fail('bot was not created: ' + name)
      return found
    }
    const bots = {}
    for (const [key, name, role] of ROLE_BOTS) bots[key] = await bot(name, role)
    await waitFor('bot kickoff turns to settle', async () => {
      state = await api('state')
      return Object.keys(state.activity ?? {}).length === 0 ? true : undefined
    }, 60_000)
    const allMembers = Object.values(bots).map(item => item.id)
    let room = Object.values(state.rooms).find(item => item.name === 'Student Grades Project')
    if (!room) {
      room = await api('create-room', { name:'Student Grades Project', members:allMembers, admin:bots.pm.id, greet:false })
      state = await api('state')
      room = Object.values(state.rooms).find(item => item.id === room.id) ?? room
    }
    const scope = { kind:'room', id:room.id }
    const roles = Object.fromEntries(Object.entries(bots).map(([key, item]) => [ROLE_MAP[key], item.id]))
    const team = { projectManagerId:bots.pm.id, roles }
    const release = await api('board-release-create', { scope, operationId:'lifecycle-release', team,
      release:{ id:'student-grades-1', name:'Student Grades', version:'1.0.0' } })
    if (release.groupId !== room.id) fail('release is outside the major-version group', { release })
    state = await api('state')
    const group = Object.values(state.rooms).find(item => item.id === release.groupId)
    if (!group) fail('release group is missing from state', { groupId:release.groupId })
    if (group.admin !== bots.pm.id) fail('project manager is not the group admin', { admin:group.admin, pm:bots.pm.id })
    for (const member of allMembers) if (!group.members.includes(member)) fail('release group is missing a role', { member })
    log('group: PM admin + ' + group.members.length + ' members')

    const requirementText = 'Build a student grade management system with students, courses, grades, GPA and reports, including tests, review, deployment and production checks.'
    await api('send', { sessionId:room.id, text:`调用 board_task ${JSON.stringify({ action:'plan', release_id:release.id, requirement:requirementText })}` })
    const releaseTasks = tasks => {
      const cardIds = new Set(tasks.filter(task => !task.parentTaskId && task.releaseId === release.id).map(task => task.id))
      return tasks.filter(task => cardIds.has(task.id) || cardIds.has(task.parentTaskId))
    }
    const planned = await waitFor('the DS-Bot project manager to import its decomposition as board tasks', async () => {
      const list = await api('board-list', { scope })
      const current = releaseTasks(list.tasks)
      return current.length ? { tasks:current.map(task => ({ taskId:task.id, title:task.title })) } : undefined
    }, 45_000)
    if (planned.tasks.length < 8) fail('lifecycle plan is incomplete', { planned })
    let board = await api('board-list', { scope })
    const items = releaseTasks(board.tasks)
    if (items.length !== planned.tasks.length) fail('planned tasks are not on the release board', { items:items.length, planned:planned.tasks.length })
    const cards = items.filter(task => !task.parentTaskId)
    if (cards.length !== 1 || cards[0].type !== 'feature' || items.some(task => task !== cards[0] && task.parentTaskId !== cards[0].id)) fail('lifecycle must use one feature card with deliverable items')
    const types = new Set(items.map(task => task.type))
    for (const type of ['requirement','design','test','development','deployment','operations']) if (!types.has(type)) fail('lifecycle type is missing', { type, types:[...types] })
    log('plan: ' + items.length + ' typed tasks')

    const design = items.find(task => task.title.startsWith('Technical'))
    const edited = await api('board-command', { scope, operationId:'lifecycle-board-edit', taskId:design.id, expectedRevision:design.revision,
      type:'card-details', value:{ description:'Board edit sync check: the release group must see this change.' } })
    if (edited.description !== 'Board edit sync check: the release group must see this change.') fail('board edit did not persist')
    await sleep(1200)
    const rows = await api('group-search', { roomId:release.groupId, query:'Board change' })
    const rowText = JSON.stringify(rows)
    if (!/Board change|Board edit sync check/.test(rowText)) fail('board edit was not synchronized to the release group', { rows:rowText.slice(0, 1500) })
    log('sync: board edit reached the release group')

    const started = await api('board-release-start', { scope, operationId:'lifecycle-start', releaseId:release.id, expectedRevision:release.revision })
    if (started.status !== 'running') fail('release did not start', { started })
    const finished = await waitFor('all lifecycle tasks to complete', async () => {
      const list = await api('board-list', { scope })
      const active = releaseTasks(list.tasks)
      if (active.some(task => ['cancelled','blocked','failed'].includes(task.status))) fail('lifecycle task entered a terminal failure', { active })
      return active.length && active.every(task => task.status === 'done') ? list : undefined
    }, 240_000)
    log('lifecycle: ' + releaseTasks(finished.tasks).filter(task => task.status === 'done').length + ' done')

    const projectDir = join(HOME, 'workspace', 'student-grades')
    const appDir = join(projectDir, 'app')
    mkdirSync(join(appDir, 'src'), { recursive:true })
    mkdirSync(join(appDir, 'test'), { recursive:true })
    writeFileSync(join(appDir, 'package.json'), JSON.stringify({ name:'student-grades', version:'1.0.0', type:'module', scripts:{ test:'node --test' } }, null, 2) + '\n')
    writeFileSync(join(appDir, 'src', 'grades.mjs'), `export const gradePoint = score => {
  if (!Number.isFinite(score) || score < 0 || score > 100) throw new Error('score must be 0..100')
  if (score >= 90) return 4
  if (score >= 80) return 3
  if (score >= 70) return 2
  if (score >= 60) return 1
  return 0
}
export const gpa = scores => {
  if (!Array.isArray(scores) || scores.length === 0) throw new Error('scores required')
  return scores.reduce((sum, score) => sum + gradePoint(score), 0) / scores.length
}
`)
    writeFileSync(join(appDir, 'test', 'grades.test.mjs'), `import test from 'node:test'
import assert from 'node:assert/strict'
import { gpa, gradePoint } from '../src/grades.mjs'
test('grade points and GPA', () => {
  assert.equal(gradePoint(95), 4)
  assert.equal(gradePoint(85), 3)
  assert.equal(gradePoint(59), 0)
  assert.equal(gpa([90, 80, 70, 60]), 2.5)
  assert.throws(() => gradePoint(101))
})
`)
    writeFileSync(join(appDir, 'src', 'server.mjs'), `import http from 'node:http'
import { gpa } from './grades.mjs'
const server = http.createServer((request, response) => {
  if (request.url === '/health') { response.writeHead(200); response.end('ok'); return }
  if (request.url?.startsWith('/gpa')) { response.writeHead(200, {'content-type':'application/json'}); response.end(JSON.stringify({ gpa:gpa([90, 80, 70, 60]) })); return }
  response.writeHead(404); response.end('not found')
})
server.listen(0, '127.0.0.1', () => console.log('PORT:' + server.address().port))
`)
    execFileSync(process.execPath, ['--test'], { cwd:appDir, encoding:'utf8', timeout:30_000 })
    const server = spawn(process.execPath, [join(appDir, 'src', 'server.mjs')], { cwd:appDir, stdio:['ignore', 'pipe', 'pipe'] })
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('student-grades server did not start')), 10_000)
      server.stdout.on('data', chunk => { const match = /PORT:(\d+)/.exec(String(chunk)); if (match) { clearTimeout(timer); resolve(Number(match[1])) } })
      server.on('error', error => { clearTimeout(timer); reject(error) })
    })
    try {
      const health = await fetch(`http://127.0.0.1:${port}/health`)
      const grades = await fetch(`http://127.0.0.1:${port}/gpa`)
      if (!health.ok || !grades.ok) fail('student-grades online checks failed', { health:health.status, grades:grades.status })
      if ((await grades.json()).gpa !== 2.5) fail('student-grades GPA endpoint is wrong')
    } finally { server.kill() }
    log('app: TDD tests pass, online health and GPA endpoints pass')

    mkdirSync(join(projectDir, 'docs'), { recursive:true })
    mkdirSync(join(projectDir, 'artifacts'), { recursive:true })
    const docsPath = join(projectDir, 'docs', 'design-and-acceptance.md')
    const artifactPath = join(projectDir, 'artifacts', 'student-grades-1.0.0.txt')
    writeFileSync(docsPath, '# Student Grades 1.0.0\n\nRequirements, API contract, schema and test evidence are reviewed.\n')
    writeFileSync(artifactPath, 'student-grades-1.0.0 build artifact\n')
    const health = await fetch(bench.base + '/', { redirect:'manual' })
    if (health.status >= 500) fail('target environment health check failed', { status:health.status })
    if (!existsSync(docsPath) || !existsSync(artifactPath)) fail('document or artifact evidence is missing')

    let latest = finished.releases.find(item => item.id === release.id)
    const gateEvidence = {
      docs: 'Reviewed ' + docsPath,
      artifacts: 'Archived ' + artifactPath,
      environment: 'Target environment health check HTTP ' + health.status + ' and smoke test passed',
      summary: 'Project summary meeting completed with PM, product, engineering, test, review and operations',
    }
    for (const gate of ['docs','artifacts','environment','summary']) {
      board = await api('board-list', { scope })
      latest = board.releases.find(item => item.id === release.id)
      const result = await api('board-release-gate', { scope, operationId:'lifecycle-gate-' + gate, releaseId:release.id, expectedRevision:latest.revision, gate, status:'passed', evidence:gateEvidence[gate] })
      if (result.gates[gate].status !== 'passed') fail('gate did not pass', { gate })
    }
    const checked = await waitFor('the periodic release monitor to publish the release', async () => {
      const list = await api('board-list', { scope })
      const current = list.releases.find(item => item.id === release.id)
      return current?.status === 'published' ? current : undefined
    }, 20_000)
    const report = await waitFor('the periodic monitor to write the summary report', async () => api('board-release-report', { scope, releaseId:release.id }).catch(() => undefined), 15_000)
    if (!/Student Grades/.test(report.markdown) || !/Project summary meeting completed/.test(report.markdown)) fail('summary report is incomplete', { markdown:report.markdown.slice(0, 500) })
    if (!report.markdown.includes(design.title)) fail('summary report omits work items from the feature card')
    if (!/<html>/.test(report.html)) fail('HTML summary report is missing', { html:report.html.slice(0, 200) })
    const reportPath = join(HOME, 'bot', 'board-v1', 'release-reports', release.id, 'summary.md')
    const htmlReportPath = join(HOME, 'bot', 'board-v1', 'release-reports', release.id, 'summary.html')
    if (!existsSync(reportPath)) fail('summary report file is missing', { reportPath })
    if (!existsSync(htmlReportPath)) fail('HTML summary report file is missing', { htmlReportPath })
    if (!readFileSync(reportPath, 'utf8').includes('Student Grades')) fail('summary report file is incomplete')
    log('published: ' + checked.name + ' ' + checked.version + ' · report ' + reportPath)
    log('PASS lifecycle sample: group/roles, typed plan, TDD chain, reviews, release gates, summary report')
  } finally {
    await stopBench({ home:HOME, webPort:WEB_PORT, mockPort:MOCK_PORT }).catch(() => {})
  }
}

main().catch(error => {
  console.error('FAIL lifecycle sample: ' + error.message)
  if (error.evidence) console.error(JSON.stringify(error.evidence, null, 2).slice(0, 4000))
  process.exit(1)
})