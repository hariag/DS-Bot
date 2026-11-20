// Evidence verifier: only objects the repository actually holds verify.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { verifyGitEvidence, evidenceShas, auditReports } from '../src/host/evidence-verify.mjs'

const git = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim()
let failures = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  if (!ok) failures += 1
}

const repo = mkdtempSync(join(tmpdir(), 'ev-repo-'))
git(repo, 'init', '-q')
git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't')
writeFileSync(join(repo, 'a.txt'), 'hello\n')
git(repo, 'add', 'a.txt'); git(repo, 'commit', '-q', '-m', 'x')
const commit = git(repo, 'rev-parse', 'HEAD')
const blob = git(repo, 'rev-parse', 'HEAD:a.txt')

check('commit object verifies', verifyGitEvidence(repo, { kind: 'git', targetCommit: commit }) === true)
check('blob object verifies', verifyGitEvidence(repo, { kind: 'git', targetBlob: blob }) === true)
check('missing object rejected', verifyGitEvidence(repo, { kind: 'git', targetCommit: 'a'.repeat(40) }) === false)
check('personal never verifies as git', verifyGitEvidence(repo, { kind: 'personal', targetCommit: commit }) === false)
check('no repo rejected', verifyGitEvidence('', { kind: 'git', targetCommit: commit }) === false)
check('empty identity rejected', evidenceShas({ kind: 'git', targetCommit: 'not-a-sha' }).length === 0)

const audit = auditReports(repo, [
  { id: 't1', status: 'reported', evidence: { kind: 'git', targetCommit: commit } },
  { id: 't2', status: 'reported', evidence: { kind: 'git', targetCommit: 'b'.repeat(40) } },
  { id: 't3', status: 'reported', evidence: { kind: 'personal', evidence: 'prose only' } },
  { id: 't4', status: 'working' },
])
check('audit counts', audit.summary.git === 2 && audit.summary.verifiedGit === 1 && audit.summary.personal === 1 && audit.summary.unstructured === 1,
  JSON.stringify(audit.summary))
check('audit rows', audit.rows.find(r => r.id === 't1').verified === true && audit.rows.find(r => r.id === 't2').verified === false)

rmSync(repo, { recursive: true, force: true })
process.exit(failures === 0 ? 0 : 1)