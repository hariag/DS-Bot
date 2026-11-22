// The DeepSeek Harness the tests, fixtures and dev scripts run against is the official
// one: `DSH_HARNESS` may name an official source checkout, otherwise the packages
// `npm run harness` installs from npm in dev/harness are used, then a `deepseek-harness/`
// checkout beside this one (or beside the main worktree of a git worktree).
//
// A personal fork is not a supported harness: it may carry patches the official release
// does not have, and the plugin is only tested against the official packages.
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PLUGIN = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const installed = join(PLUGIN, 'dev', 'harness')

const above = start => {
  for (let dir = start; ; dir = dirname(dir)) {
    if (existsSync(join(dir, 'deepseek-harness'))) return join(dir, 'deepseek-harness')
    if (dirname(dir) === dir) return undefined
  }
}

/** Absolute path of the harness root, or undefined when none is installed. */
export function harnessRoot() {
  if (process.env.DSH_HARNESS) return process.env.DSH_HARNESS
  if (existsSync(join(installed, 'node_modules'))) return installed
  const near = above(dirname(PLUGIN))
  if (near) return near
  const beside = resolve(PLUGIN, '..', 'deepseek-harness')
  try {
    const git = (...args) => execFileSync('git', ['-C', dirname(PLUGIN), 'rev-parse', ...args], { encoding: 'utf8' }).trim()
    return above(join(dirname(git('--path-format=absolute', '--git-common-dir')), git('--show-prefix'))) ?? beside
  } catch {
    return beside
  }
}

/**
 * A require anchored at the harness root. A source checkout keeps its packages in the
 * workspace, an npm install in `node_modules`; resolving from the root reaches both.
 * Returns undefined when no harness is installed, so a browser fixture can fall back
 * to its own packages and `BOARD_REACT_DIR`.
 */
export function harnessRequire() {
  const root = harnessRoot()
  return root === undefined ? undefined : createRequire(join(root, 'package.json'))
}

/** React 18 with UMD builds: `BOARD_REACT_DIR` first, else the harness install. */
export function reactDirOf(req) {
  if (process.env.BOARD_REACT_DIR) return process.env.BOARD_REACT_DIR
  try { return dirname(req.resolve('react')) } catch { return '' }
}

/** Playwright from the harness, else the plugin's own playwright-core. */
export function playwrightOf(req) {
  try { return req('playwright') } catch { return createRequire(join(PLUGIN, 'package.json'))('playwright-core') }
}