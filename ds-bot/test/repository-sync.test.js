import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { syncSharedRepository } from '../src/host/repository-sync.mjs'

const headA = 'a'.repeat(40), headB = 'b'.repeat(40)

function fixture({ ahead = 0, behind = 1, dirty = '', remoteUrl = 'https://github.com/acme/project.git', fetchCode = 0 } = {}) {
  let head = headA, fetches = 0, merges = 0
  const calls = []
  const runGit = async (cwd, args) => {
    calls.push({ cwd, args })
    const key = args.join(' ')
    if (key === 'rev-parse --show-toplevel') return { code: 0, stdout: '/work/project\n' }
    if (key === 'branch --show-current') return { code: 0, stdout: 'feature/slice\n' }
    if (key === 'rev-parse --abbrev-ref --symbolic-full-name @{upstream}') return { code: 0, stdout: 'origin/main\n' }
    if (key === 'check-ref-format refs/heads/main') return { code: 0, stdout: '' }
    if (key === 'remote get-url origin') return { code: 0, stdout: `${remoteUrl}\n` }
    if (key === 'rev-parse --verify HEAD') return { code: 0, stdout: `${head}\n` }
    if (key === 'status --porcelain=v1 -z --untracked-files=all') return { code: 0, stdout: dirty }
    if (key === 'fetch --no-tags --no-recurse-submodules origin refs/heads/main:refs/remotes/origin/main') { fetches++; return { code: fetchCode, stdout: '' } }
    if (key === 'rev-parse --verify refs/remotes/origin/main') return { code: 0, stdout: `${headB}\n` }
    if (key === `rev-list --left-right --count ${head}...${headB}`) return { code: 0, stdout: `${ahead}\t${behind}\n` }
    if (key === `merge-base --is-ancestor ${head} ${headB}`) return { code: 0, stdout: '' }
    if (key.includes('merge --ff-only')) { merges++; head = headB; return { code: 0, stdout: '' } }
    throw new Error(`unexpected git call: ${key}`)
  }
  return { runGit, calls, get head() { return head }, get fetches() { return fetches }, get merges() { return merges } }
}

test('repository check fetches only the configured GitHub branch and reports behind without updating files', async () => {
  const f = fixture()
  const result = await syncSharedRepository({ cwd: '/work/project', action: 'check', runGit: f.runGit })
  assert.equal(result.status, 'behind')
  assert.equal(result.head, headA)
  assert.equal(result.target, headB)
  assert.equal(f.fetches, 1)
  assert.equal(f.merges, 0)
  assert.ok(f.calls.some(call => call.args.join(' ') === 'fetch --no-tags --no-recurse-submodules origin refs/heads/main:refs/remotes/origin/main'))
})

test('fast-forward updates only a clean strictly-behind branch and suppresses repository hooks', async () => {
  const f = fixture()
  const result = await syncSharedRepository({ cwd: '/work/project', action: 'fast_forward', runGit: f.runGit, canFastForward: async () => true })
  assert.equal(result.status, 'fast-forwarded')
  assert.equal(result.previousHead, headA)
  assert.equal(result.head, headB)
  assert.equal(f.head, headB)
  assert.equal(f.merges, 1)
  const merge = f.calls.find(call => call.args.includes('merge'))
  assert.ok(merge.args.includes('--ff-only'))
  assert.ok(merge.args.some(arg => arg.startsWith('core.hooksPath=')))
})

test('dirty, ahead or diverged work is preserved', async () => {
  for (const options of [{ dirty: ' M file.txt\0' }, { ahead: 1, behind: 0 }, { ahead: 1, behind: 1 }]) {
    const f = fixture(options)
    const result = await syncSharedRepository({ cwd: '/work/project', action: 'fast_forward', runGit: f.runGit })
    assert.notEqual(result.status, 'fast-forwarded')
    assert.equal(f.merges, 0)
    assert.equal(f.head, headA)
  }
})

test('fast-forward pauses when another local session uses the checkout or the checkout changes during fetch', async () => {
  const busy = fixture()
  const blocked = await syncSharedRepository({ cwd: '/work/project', action: 'fast_forward', runGit: busy.runGit, canFastForward: async () => false })
  assert.equal(blocked.status, 'active-session-uses-checkout')
  assert.equal(busy.merges, 0)

  const changing = fixture()
  let firstHeadRead = true
  const runGit = async (cwd, args) => {
    const result = await changing.runGit(cwd, args)
    if (args.join(' ') === 'fetch --no-tags --no-recurse-submodules origin refs/heads/main:refs/remotes/origin/main' && firstHeadRead) {
      firstHeadRead = false
    }
    if (args.join(' ') === 'rev-parse --verify HEAD' && !firstHeadRead) return { code: 0, stdout: `${headB}\n` }
    return result
  }
  const raced = await syncSharedRepository({ cwd: '/work/project', action: 'fast_forward', runGit })
  assert.equal(raced.status, 'checkout-changed-during-fetch')
  assert.equal(changing.merges, 0)
})

test('non-GitHub remotes and failed fetches are reported without checkout changes', async () => {
  const unsupported = fixture({ remoteUrl: 'https://gitlab.com/acme/project.git' })
  assert.equal((await syncSharedRepository({ cwd: '/work/project', action: 'fast_forward', runGit: unsupported.runGit })).status, 'unsupported-upstream')
  assert.equal(unsupported.fetches, 0)

  const unavailable = fixture({ fetchCode: 128 })
  assert.equal((await syncSharedRepository({ cwd: '/work/project', action: 'fast_forward', runGit: unavailable.runGit })).status, 'remote-unavailable')
  assert.equal(unavailable.merges, 0)
  assert.equal(unavailable.head, headA)
})

test('fast-forward updates a real Git checkout to the fetched upstream commit', async t => {
  const root = mkdtempSync(join(tmpdir(), 'repo-sync-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  git('init', '-b', 'main')
  git('config', 'user.name', 'DS Bot tests')
  git('config', 'user.email', 'ds-bot-tests@example.invalid')
  writeFileSync(join(root, 'version.txt'), 'one\n')
  git('add', 'version.txt'); git('commit', '-m', 'one')
  git('branch', 'feature/slice')
  writeFileSync(join(root, 'version.txt'), 'two\n')
  git('commit', '-am', 'two')
  const target = git('rev-parse', 'HEAD')
  git('remote', 'add', 'origin', 'https://github.com/acme/project.git')
  git('update-ref', 'refs/remotes/origin/main', target)
  git('config', 'branch.feature/slice.remote', 'origin')
  git('config', 'branch.feature/slice.merge', 'refs/heads/main')
  git('checkout', 'feature/slice')

  const runGit = async (cwd, args) => {
    if (args[0] === 'fetch') return { code: 0, stdout: '' }
    try { return { code: 0, stdout: execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) } }
    catch (error) { return { code: Number.isInteger(error.status) ? error.status : 127, stdout: error.stdout?.toString() ?? '' } }
  }
  const result = await syncSharedRepository({ cwd: root, action: 'fast_forward', runGit })
  assert.equal(result.status, 'fast-forwarded')
  assert.equal(result.head, target)
  assert.equal(git('rev-parse', 'HEAD'), target)
  assert.equal(readFileSync(join(root, 'version.txt'), 'utf8').replaceAll('\r\n', '\n'), 'two\n')
})

test('check_commit verifies the sole parent and exact NUL-safe path set without changing a detached checkout', async t => {
  const root = mkdtempSync(join(tmpdir(), 'repo-check-commit-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  git('init', '-b', 'main')
  git('config', 'user.name', 'DS Bot tests')
  git('config', 'user.email', 'ds-bot-tests@example.invalid')
  writeFileSync(join(root, 'kept.txt'), 'one\n')
  writeFileSync(join(root, 'old name.txt'), 'rename me\n')
  git('add', 'kept.txt', 'old name.txt')
  git('commit', '-m', 'base')
  const base = git('rev-parse', 'HEAD')
  writeFileSync(join(root, 'kept.txt'), 'two\n')
  renameSync(join(root, 'old name.txt'), join(root, 'new\nname.txt'))
  git('add', '-u')
  git('add', 'new\nname.txt')
  git('commit', '-m', 'candidate')
  const candidate = git('rev-parse', 'HEAD')
  git('checkout', '--detach')
  writeFileSync(join(root, 'untracked.txt'), 'preserve me\n')
  const input = { cwd: root, action: 'check_commit', baseSha: base, candidateSha: candidate }

  const good = await syncSharedRepository({ ...input, paths: ['kept.txt', 'old name.txt', 'new\nname.txt'] })
  assert.equal(good.status, 'commit-verified')
  assert.equal(good.pathCount, 3)
  assert.equal(good.remoteFreshness, 'not-checked')
  const bad = await syncSharedRepository({ ...input, paths: ['kept.txt', 'new\nname.txt'] })
  assert.equal(bad.status, 'path-mismatch')
  assert.deepEqual(bad.unexpected, ['old name.txt'])
  assert.equal(bad.unexpectedCount, 1)
  assert.equal(git('rev-parse', 'HEAD'), candidate)
  assert.equal(git('branch', '--show-current'), '')
  assert.equal(readFileSync(join(root, 'untracked.txt'), 'utf8'), 'preserve me\n')

  const tree = git('rev-parse', `${candidate}^{tree}`)
  const merge = git('commit-tree', tree, '-p', base, '-p', candidate, '-m', 'merge')
  assert.equal((await syncSharedRepository({ ...input, candidateSha: merge, paths: ['kept.txt'] })).status, 'parent-mismatch')
  assert.equal((await syncSharedRepository({ ...input, baseSha: candidate, candidateSha: base, paths: ['kept.txt'] })).status, 'parent-mismatch')
  assert.equal((await syncSharedRepository({ ...input, candidateSha: 'f'.repeat(40), paths: ['kept.txt'] })).status, 'commit-unavailable')
  // A local replacement ref must not hide an extra parent from the validator.
  git('replace', merge, candidate)
  assert.equal((await syncSharedRepository({ ...input, candidateSha: merge, paths: ['kept.txt'] })).status, 'parent-mismatch')
})

test('check_commit rejects ambiguous IDs and invalid or duplicate path declarations before running Git', async () => {
  const failIfCalled = async () => { throw new Error('invalid input must not invoke git') }
  const valid = { cwd: '/work', action: 'check_commit', baseSha: headA, candidateSha: headB, paths: ['ok'] }
  const cases = [
    { baseSha: 'main' }, { candidateSha: headB.slice(0, 8) }, { baseSha: headB },
    { paths: [] }, { paths: ['ok', 'ok'] }, { paths: ['/absolute'] },
    { paths: ['../escape'] }, { paths: ['a/./b'] }, { paths: ['a//b'] },
    { paths: ['a\0b'] }, { paths: ['a/'] }, { paths: ['x'.repeat(4097)] },
    { paths: Array.from({ length: 257 }, (_, i) => `file-${i}`) },
  ]
  for (const item of cases) {
    const result = await syncSharedRepository({ ...valid, ...item, runGit: failIfCalled })
    assert.equal(result.status, 'invalid-commit-request')
    assert.equal(result.remoteFreshness, 'not-checked')
  }
})

test('check_commit fails closed on malformed or undecodable Git path output', async () => {
  for (const output of [Buffer.from([0xff, 0]), Buffer.from('not-nul-terminated')]) {
    const runGit = async (_cwd, args) => {
      if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return { code: 0, stdout: '/work\n' }
      if (args[0] === 'rev-parse' && args[1] === '--show-object-format') return { code: 0, stdout: 'sha1\n' }
      if (args[0] === 'cat-file' && args[1] === '-t') return { code: 0, stdout: 'commit\n' }
      if (args[0] === 'cat-file' && args[1] === '-p') return { code: 0, stdout: `tree ${'c'.repeat(40)}\nparent ${headA}\n\nmessage\n` }
      if (args[0] === 'diff-tree') return { code: 0, stdout: output }
      throw new Error(`unexpected git call ${args}`)
    }
    const result = await syncSharedRepository({ cwd: '/work', action: 'check_commit', baseSha: headA, candidateSha: headB, paths: ['expected'], runGit })
    assert.ok(['unrepresentable-path', 'diff-unavailable'].includes(result.status))
  }
})
