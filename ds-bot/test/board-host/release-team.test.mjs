import test from 'node:test'
import assert from 'node:assert/strict'
import { RELEASE_ROLES, resolveReleaseTeam } from '../../src/host/release-team.mjs'

const bots = Object.fromEntries([
  ['pm', { id:'pm', name:'PM', role:'Project Manager' }],
  ['product', { id:'product', name:'Product', role:'Product Manager' }],
  ['arch', { id:'arch', name:'Architect', role:'Architect' }],
  ['fe', { id:'fe', name:'Frontend', role:'Frontend Developer' }],
  ['be', { id:'be', name:'Backend', role:'Backend Developer' }],
  ['test', { id:'test', name:'Tester', role:'Test Engineer' }],
  ['review', { id:'review', name:'Reviewer', role:'Independent Reviewer' }],
  ['ops', { id:'ops', name:'Ops', role:'Operations Engineer' }],
].map(([id, bot]) => [id, bot]))

test('release team resolves required roles, keeps the manager as admin member and rejects missing roles', () => {
  const team = resolveReleaseTeam({ bots, projectManagerId:'pm' })
  assert.equal(team.projectManagerId, 'pm')
  assert.equal(team.roles.projectManager, 'pm')
  assert.equal(team.members.includes('pm'), true)
  assert.equal(team.members.length, new Set(team.members).size)
  assert.equal(team.roles.frontend, 'fe')
  assert.equal(team.roles.tester, 'test')
  assert.equal(team.roles.ops, 'ops')
  assert.throws(() => resolveReleaseTeam({ bots:{ ...bots, test:{ ...bots.test, private:true } }, projectManagerId:'pm' }))
  assert.throws(() => resolveReleaseTeam({ bots, projectManagerId:'missing' }))
})

test('release team accepts explicit role assignments and ignores optional roles that are absent', () => {
  const team = resolveReleaseTeam({ bots, projectManagerId:'pm', roles:{ tester:'test', reviewer:'review' } })
  assert.equal(team.roles.tester, 'test')
  assert.equal(team.roles.reviewer, 'review')
  assert.equal(team.roles.uiDesigner, undefined)
  assert.equal(RELEASE_ROLES.some(role => role.key === 'projectManager' && role.required), true)
})
test('release summary report contains items, gates and the summary meeting evidence', async () => {
  const { buildReleaseReport } = await import('../../src/host/release-team.mjs')
  const report = buildReleaseReport({ name:'Student grades', version:'1.0.0', status:'published', groupId:'g1', projectManagerId:'pm', gates:{ docs:{status:'passed',evidence:'README'}, artifacts:{status:'passed',evidence:'build.zip'}, environment:{status:'passed',evidence:'health 200'}, summary:{status:'passed',evidence:'summary meeting done'} }, startedAt:1, publishedAt:2 }, [
    { title:'Requirement', type:'requirement', owner:'product', reviewer:'pm', status:'done' },
    { title:'Deploy', type:'deployment', owner:'ops', reviewer:'pm', status:'done' },
  ])
  assert.match(report.markdown, /Student grades 1.0.0/)
  assert.match(report.markdown, /\| Deploy \| deployment \| ops \| pm \| done \|/)
  assert.match(report.markdown, /summary meeting done/)
  assert.match(report.html, /<html>/)
  assert.match(report.html, /Student grades/)
})
