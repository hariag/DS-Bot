import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { realpath } from 'node:fs/promises'
import { defineTool } from '@deepseek-ai/dsh-tools'

const output = { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] }

const execFileAsync = promisify(execFile)
const REMOTE_NAME = /^[A-Za-z0-9._-]+$/
const UPSTREAM = /^([A-Za-z0-9._-]+)\/(.+)$/

async function git(cwd, args, timeout = 15_000, { binary = false, localObjectsOnly = false } = {}) {
  try {
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' }
    for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CEILING_DIRECTORIES', 'GIT_PREFIX']) delete env[name]
    if (localObjectsOnly) {
      env.GIT_NO_REPLACE_OBJECTS = '1'
      // An object lookup in a partial clone must not implicitly fetch from a promisor.
      env.GIT_NO_LAZY_FETCH = '1'
    }
    const noHooks = join(tmpdir(), `.ds-bot-no-hooks-${randomUUID()}`)
    const result = await execFileAsync('git', ['-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${noHooks}`, ...args], {
      cwd,
      encoding: binary ? 'buffer' : 'utf8',
      timeout,
      maxBuffer: 256 * 1024,
      windowsHide: true,
      env,
    })
    return { code: 0, stdout: result.stdout }
  } catch (error) {
    return { code: Number.isInteger(error?.code) ? error.code : 127, stdout: typeof error?.stdout === 'string' ? error.stdout : '' }
  }
}

const FULL_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const MAX_DECLARED_PATHS = 256
const MAX_DECLARED_BYTES = 32 * 1024
const MAX_PATH_BYTES = 4096
const MAX_DIFF_REPORT = 8

// A tree path is a literal repository-relative path, not a pathspec or directory.
// Newlines and tabs are legal filenames; NUL, invalid components and undecodable
// bytes are not accepted. The diff is read with -z and compared as a set.
function validTreePath(path) {
  return typeof path === 'string' && path.length > 0 && !path.includes('\0')
    && !path.includes('\ufffd') && !path.startsWith('/') && !path.endsWith('/')
    && !path.split('/').some(part => part === '' || part === '.' || part === '..')
    && Buffer.byteLength(path, 'utf8') <= MAX_PATH_BYTES
}

async function checkCommit({ cwd, baseSha, candidateSha, paths, runGit }) {
  const validIds = typeof baseSha === 'string' && FULL_OBJECT_ID.test(baseSha)
    && typeof candidateSha === 'string' && FULL_OBJECT_ID.test(candidateSha)
    && baseSha.length === candidateSha.length && baseSha !== candidateSha
  if (!validIds || !Array.isArray(paths) || paths.length === 0 || paths.length > MAX_DECLARED_PATHS
    || !paths.every(validTreePath) || new Set(paths).size !== paths.length
    || paths.reduce((sum, path) => sum + Buffer.byteLength(path, 'utf8'), 0) > MAX_DECLARED_BYTES) {
    return { status: 'invalid-commit-request', remoteFreshness: 'not-checked' }
  }
  const root = await repositoryRoot(cwd, runGit)
  if (!root) return { status: 'not-a-git-repository', remoteFreshness: 'not-checked' }
  const localValue = async args => {
    const result = await runGit(cwd, args, 15_000, { localObjectsOnly: true })
    return result.code === 0 && typeof result.stdout === 'string' ? result.stdout.trim() : undefined
  }
  const objectFormat = await localValue(['rev-parse', '--show-object-format'])
  if ((objectFormat === 'sha1' && baseSha.length !== 40) || (objectFormat === 'sha256' && baseSha.length !== 64)
    || !['sha1', 'sha256'].includes(objectFormat)) return { status: 'object-format-mismatch', remoteFreshness: 'not-checked' }
  const evidence = { base: baseSha, candidate: candidateSha, remoteFreshness: 'not-checked' }
  const [baseType, candidateType] = await Promise.all([
    localValue(['cat-file', '-t', baseSha]),
    localValue(['cat-file', '-t', candidateSha]),
  ])
  if (baseType !== 'commit' || candidateType !== 'commit') return { status: 'commit-unavailable', ...evidence }
  const rawCommit = await runGit(cwd, ['cat-file', '-p', candidateSha], 15_000, { localObjectsOnly: true })
  if (rawCommit.code !== 0 || typeof rawCommit.stdout !== 'string') return { status: 'commit-unavailable', ...evidence }
  const headerEnd = rawCommit.stdout.indexOf('\n\n')
  if (headerEnd === -1) return { status: 'commit-unavailable', ...evidence }
  const parents = rawCommit.stdout.slice(0, headerEnd).split('\n')
    .filter(line => line.startsWith('parent ')).map(line => line.slice(7))
  if (parents.length !== 1 || parents[0] !== baseSha) return { status: 'parent-mismatch', ...evidence, parentCount: parents.length }

  // Disable rename/copy detection so a rename is two literal changes. The explicit
  // submodule setting avoids hiding a changed gitlink through repository config.
  const diff = await runGit(cwd, ['diff-tree', '-r', '--no-commit-id', '--name-only', '-z', '--no-renames', '--no-ext-diff', '--ignore-submodules=none', baseSha, candidateSha, '--'], 15_000, { binary: true, localObjectsOnly: true })
  if (diff.code !== 0) return { status: 'diff-unavailable', ...evidence }
  let text
  try {
    text = Buffer.isBuffer(diff.stdout) ? new TextDecoder('utf-8', { fatal: true }).decode(diff.stdout)
      : typeof diff.stdout === 'string' ? diff.stdout : undefined
  } catch { return { status: 'unrepresentable-path', ...evidence } }
  if (text === undefined || (text !== '' && !text.endsWith('\0'))) return { status: 'diff-unavailable', ...evidence }
  const actual = text === '' ? [] : text.slice(0, -1).split('\0')
  if (!actual.every(validTreePath) || new Set(actual).size !== actual.length) return { status: 'unrepresentable-path', ...evidence }
  const expectedSet = new Set(paths), actualSet = new Set(actual)
  const missing = paths.filter(path => !actualSet.has(path))
  const unexpected = actual.filter(path => !expectedSet.has(path))
  if (missing.length === 0 && unexpected.length === 0) return { status: 'commit-verified', ...evidence, pathCount: actual.length }
  // Never return an unbounded diff or full large path list to a model.
  const sample = entries => entries.slice(0, MAX_DIFF_REPORT).map(path => path.length > 256 ? `${path.slice(0, 256)}…` : path)
  return { status: 'path-mismatch', ...evidence, expectedCount: paths.length, actualCount: actual.length,
    missingCount: missing.length, unexpectedCount: unexpected.length, missing: sample(missing), unexpected: sample(unexpected) }
}

const value = async (cwd, args, runGit = git) => {
  const result = await runGit(cwd, args)
  return result.code === 0 ? result.stdout.trim() : undefined
}

function githubRepository(url) {
  if (typeof url !== 'string') return undefined
  const text = url.trim()
  const matches = [
    /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/i,
    /^ssh:\/\/git@github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/i,
    /^git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/i,
  ]
  for (const pattern of matches) {
    const found = pattern.exec(text)
    if (found && !['.', '..'].includes(found[1]) && !['.', '..'].includes(found[2])) return `${found[1]}/${found[2]}`
  }
  return undefined
}

export async function repositoryRoot(cwd, runGit = git) {
  if (typeof cwd !== 'string' || !cwd) return undefined
  const result = await runGit(cwd, ['rev-parse', '--show-toplevel'])
  return result.code === 0 ? result.stdout.trim() : undefined
}

/** Fetch the current Session's configured GitHub upstream and optionally fast-forward a clean branch. */
export async function syncSharedRepository({ cwd, action = 'check', baseSha, candidateSha, paths, runGit = git, canFastForward = async () => true } = {}) {
  if (action === 'check_commit') return checkCommit({ cwd, baseSha, candidateSha, paths, runGit })
  if (!['check', 'fast_forward'].includes(action)) return { status: 'invalid-action' }
  const root = await repositoryRoot(cwd, runGit)
  if (!root) return { status: 'not-a-git-repository' }

  const branch = await value(cwd, ['branch', '--show-current'], runGit)
  if (!branch) return { status: 'detached-head' }
  const upstream = await value(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], runGit)
  const match = UPSTREAM.exec(upstream ?? '')
  if (!match || match[1] === '.') return { status: 'upstream-not-configured', branch }
  const [, remote, remoteBranch] = match
  if (!REMOTE_NAME.test(remote)) return { status: 'upstream-not-configured', branch }
  const checkedRef = await runGit(cwd, ['check-ref-format', `refs/heads/${remoteBranch}`])
  if (checkedRef.code !== 0) return { status: 'upstream-not-configured', branch }

  const url = await value(cwd, ['remote', 'get-url', remote], runGit)
  const repository = githubRepository(url)
  if (!repository) return { status: 'unsupported-upstream', branch, upstream }

  const originalHead = await value(cwd, ['rev-parse', '--verify', 'HEAD'], runGit)
  const originalStatus = await value(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], runGit)
  if (!originalHead || originalStatus === undefined) return { status: 'repository-unavailable', branch, upstream, repository }

  const fetched = await runGit(cwd, ['fetch', '--no-tags', '--no-recurse-submodules', remote, `refs/heads/${remoteBranch}:refs/remotes/${remote}/${remoteBranch}`], 60_000)
  if (fetched.code !== 0) return { status: 'remote-unavailable', branch, upstream, repository, head: originalHead }

  const head = await value(cwd, ['rev-parse', '--verify', 'HEAD'], runGit)
  const target = await value(cwd, ['rev-parse', '--verify', `refs/remotes/${remote}/${remoteBranch}`], runGit)
  const status = await value(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], runGit)
  if (!head || !target || status === undefined) return { status: 'repository-unavailable', branch, upstream, repository }
  if (head !== originalHead) return { status: 'checkout-changed-during-fetch', branch, upstream, repository, head, target }

  const counts = await value(cwd, ['rev-list', '--left-right', '--count', `${head}...${target}`], runGit)
  const countMatch = /^(\d+)\s+(\d+)$/.exec(counts ?? '')
  if (!countMatch) return { status: 'history-unavailable', branch, upstream, repository, head, target }
  const ahead = Number(countMatch[1]), behind = Number(countMatch[2])
  if (status !== '') return { status: 'dirty', branch, upstream, repository, head, target, ahead, behind }
  if (ahead === 0 && behind === 0) return { status: 'up-to-date', branch, upstream, repository, head, target, ahead, behind }
  if (action === 'check' || behind === 0 || ahead !== 0) return { status: ahead && behind ? 'diverged' : ahead ? 'ahead' : 'behind', branch, upstream, repository, head, target, ahead, behind }

  const beforeMergeHead = await value(cwd, ['rev-parse', '--verify', 'HEAD'], runGit)
  const beforeMergeStatus = await value(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], runGit)
  const beforeMergeBranch = await value(cwd, ['branch', '--show-current'], runGit)
  if (beforeMergeHead !== head || beforeMergeStatus !== '' || beforeMergeBranch !== branch) return { status: 'checkout-changed-before-sync', branch, upstream, repository, head: beforeMergeHead, target, ahead, behind }
  const isAncestor = await runGit(cwd, ['merge-base', '--is-ancestor', head, target])
  if (isAncestor.code !== 0) return { status: 'history-changed-before-sync', branch, upstream, repository, head, target, ahead, behind }
  if (!await canFastForward({ cwd, root, branch, upstream, head, target })) {
    return { status: 'active-session-uses-checkout', branch, upstream, repository, head, target, ahead, behind }
  }

  // Suppress repository-defined hooks: this operation only moves a clean branch and must
  // not execute arbitrary code as a side effect of refreshing the checkout.
  const noHooks = join(tmpdir(), `.ds-bot-no-hooks-${randomUUID()}`)
  const merged = await runGit(cwd, ['-c', `core.hooksPath=${noHooks}`, 'merge', '--ff-only', target], 60_000)
  if (merged.code !== 0) return { status: 'fast-forward-failed', branch, upstream, repository, head, target, ahead, behind }
  const finalHead = await value(cwd, ['rev-parse', '--verify', 'HEAD'], runGit)
  const finalBranch = await value(cwd, ['branch', '--show-current'], runGit)
  const finalStatus = await value(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], runGit)
  if (finalHead !== target || finalBranch !== branch) return { status: 'sync-result-uncertain', branch, upstream, repository, previousHead: head, head: finalHead, target, ahead, behind }
  return finalStatus === ''
    ? { status: 'fast-forwarded', branch, upstream, repository, previousHead: head, head: finalHead, target, ahead, behind }
    : { status: 'fast-forwarded-with-new-work', branch, upstream, repository, previousHead: head, head: finalHead, target, ahead, behind }
}

export function install(rt) {
  const tool = defineTool({
    name: 'sync_shared_repository',
    description: 'At a shared-repository task boundary, fetch the configured GitHub upstream and report checkout freshness. check_commit instead inspects local commit objects only: verify exactly one direct parent and the complete changed-path set before integrating; it does not fetch or establish remote freshness. fast_forward updates only a clean checkout that no other local Bot Session is using. Never commits, pushes, rebases or resets.',
    parameters: {
      action: { type: 'string', required: true, enum: ['check', 'fast_forward', 'check_commit'], description: 'check fetches and reports freshness; fast_forward may update a clean, strictly behind branch; check_commit checks a candidate and declared paths locally without network' },
      base_sha: { type: 'string', description: 'For check_commit: complete SHA of the independently verified intended base commit' },
      candidate_sha: { type: 'string', description: 'For check_commit: complete SHA of the candidate commit' },
      paths: { type: 'array', items: { type: 'string' }, description: 'For check_commit: exact changed repository-relative file paths, including both old and new paths for renames' },
    },
    output,
    async execute(args, exec) {
      await rt.load()
      const self = rt.selfOf(exec.agent?.id)
      if (!rt.botOf(self)) return JSON.stringify({ status: 'bot-session-required' })
      const cwd = rt.sessionFolder(exec.agent?.session)
      if (typeof cwd !== 'string' || !cwd) return JSON.stringify({ status: 'working-folder-unavailable' })
      const canFastForward = async ({ root }) => {
        for (const [sessionId, live] of rt.live ?? []) {
          if (sessionId === exec.agent?.id || live?.turn === undefined || !rt.isBotSession(sessionId)) continue
          let agent
          try { agent = await rt.resolveAgent(sessionId) } catch { return false }
          const otherFolder = rt.sessionFolder(agent?.session)
          const otherRoot = await repositoryRoot(otherFolder)
          if (otherRoot) {
            const [actualRoot, actualOtherRoot] = await Promise.all([
              realpath(root).catch(() => resolve(root)),
              realpath(otherRoot).catch(() => resolve(otherRoot)),
            ])
            const normalize = path => process.platform === 'win32' ? path.replaceAll('/', '\\').toLowerCase() : path
            if (normalize(actualRoot) === normalize(actualOtherRoot)) return false
          }
        }
        return true
      }
      try {
        const result = await syncSharedRepository({ cwd, action: args.action, baseSha: args.base_sha, candidateSha: args.candidate_sha, paths: args.paths, canFastForward })
        return JSON.stringify({ ...result, checkedAt: new Date().toISOString() })
      } catch {
        return JSON.stringify({ status: 'repository-unavailable', checkedAt: new Date().toISOString() })
      }
    },
  })
  if (typeof rt.addTeamTool === 'function') rt.addTeamTool(tool)
  else rt.teamTools.push(tool)
}
