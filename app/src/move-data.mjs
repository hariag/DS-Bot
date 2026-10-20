// Moving the app's data to another folder. The copy is put together in a folder beside the new
// one and takes its name only once it is whole, so a copy that stopped or failed leaves nothing
// that looks like data. The old folder stays as it was.
import { existsSync, readdirSync, statSync } from 'node:fs'
import { cp, mkdir, rename, rm, rmdir } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { within } from './import.mjs'

// The engine's lock on the team belongs to the old folder; the first-run copy and its check
// leave their temporary folders only when they were cut short.
const LEFT_BEHIND = [/^bot[\\/]state\.lock$/u, /^\.import(-check)?-\d+$/u]

/**
 * What keeps `to` from being the new data location, or undefined.
 * @param {{ from: string, to: string, workspace?: string, dshHome: string, program?: string }} places
 * @returns {'drive' | 'nested' | 'workspace' | 'dsh' | 'program' | 'notEmpty' | undefined}
 */
export function moveProblem({ from, to, workspace, dshHome, program }) {
  if (dirname(resolve(to)) === resolve(to)) return 'drive'
  if (within(to, from) || within(from, to)) return 'nested'
  if (workspace !== undefined && (within(to, workspace) || within(workspace, to))) return 'workspace'
  if (within(to, dshHome) || within(dshHome, to)) return 'dsh'
  if (program !== undefined && within(to, program)) return 'program'
  if (existsSync(to) && (!statSync(to).isDirectory() || readdirSync(to).length > 0)) return 'notEmpty'
  return undefined
}

const stagePrefix = to => `.${basename(to)}.moving-`

/**
 * Copy the data in `from` to `to`, an empty or new folder. The signal stops it between files.
 * @param {string} from @param {string} to @param {AbortSignal} [signal]
 */
export async function copyData(from, to, signal) {
  const parent = dirname(resolve(to))
  await mkdir(parent, { recursive: true })
  // A run that was killed can leave its staging folder behind.
  for (const name of readdirSync(parent).filter(entry => entry.startsWith(stagePrefix(to)))) {
    await rm(join(parent, name), { recursive: true, force: true, maxRetries: 5 })
  }
  const stage = join(parent, `${stagePrefix(to)}${String(Date.now())}`)
  try {
    await cp(from, stage, {
      recursive: true,
      filter: (source) => {
        signal?.throwIfAborted()
        const path = relative(from, source)
        return !LEFT_BEHIND.some(pattern => pattern.test(path))
      },
    })
    signal?.throwIfAborted()
    if (existsSync(to)) await rmdir(to)
    await rename(stage, to)
  } catch (error) {
    await rm(stage, { recursive: true, force: true, maxRetries: 5 })
    throw error
  }
}
