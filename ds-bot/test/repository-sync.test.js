import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
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
