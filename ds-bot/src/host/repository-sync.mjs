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

async function git(cwd, args, timeout = 15_000) {
  try {
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' }
    for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CEILING_DIRECTORIES', 'GIT_PREFIX']) delete env[name]
    const noHooks = join(tmpdir(), `.ds-bot-no-hooks-${randomUUID()}`)
    const result = await execFileAsync('git', ['-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${noHooks}`, ...args], {
      cwd,
      encoding: 'utf8',
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
export async function syncSharedRepository({ cwd, action = 'check', runGit = git, canFastForward = async () => true } = {}) {
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
    description: 'At a shared-repository task boundary, fetch the configured GitHub upstream for your current Session and report whether this checkout is fresh. Use fast_forward only before starting work, when the workspace is clean and no other local Bot Session is using the same checkout. It never commits, pushes, rebases, resets or overwrites dirty/diverged work.',
    parameters: {
      action: { type: 'string', required: true, enum: ['check', 'fast_forward'], description: 'check fetches and reports freshness; fast_forward also updates a clean, strictly behind branch when safe' },
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
        const result = await syncSharedRepository({ cwd, action: args.action, canFastForward })
        return JSON.stringify({ ...result, checkedAt: new Date().toISOString() })
      } catch {
        return JSON.stringify({ status: 'repository-unavailable', checkedAt: new Date().toISOString() })
      }
    },
  })
  if (typeof rt.addTeamTool === 'function') rt.addTeamTool(tool)
  else rt.teamTools.push(tool)
}
