// Moving the app's data to another folder. The copy is put together in a folder beside the new
// one and takes its name only once it is whole, so a copy that stopped or failed leaves nothing
// that looks like data. The old folder stays as it was.
import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { cp, lstat, mkdir, readlink, realpath, rename, rm, rmdir, stat, symlink, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { within } from './import.mjs'

// The engine's lock on the team belongs to the old folder; the first-run copy and its check
// leave their temporary folders only when they were cut short.
const LEFT_BEHIND = [/^bot[\\/]state\.lock$/u, /^\.import(-check)?-\d+$/u]
// Marks a staging folder as this app's, so that only those are removed.
const MARK = '.ds-bot-moving'

// The path as the file system has it: through links and junctions, from the deepest part that
// exists. A link can make a path that looks apart from a folder lead into it.
function real(path) {
  const rest = []
  let at = resolve(path)
  while (!existsSync(at)) {
    const up = dirname(at)
    if (up === at) return resolve(path)
    rest.unshift(basename(at))
    at = up
  }
  return join(realpathSync.native(at), ...rest)
}

/** The folder that an update or uninstall replaces: on macOS the whole .app bundle. */
export function installFolder(exe, platform = process.platform) {
  if (platform === 'darwin') {
    for (let at = dirname(exe); dirname(at) !== at; at = dirname(at)) if (at.endsWith('.app')) return at
  }
  return dirname(exe)
}

/**
 * What keeps `to` from being the new data location, or undefined.
 * @param {{ from: string, to: string, workspace?: string, dshHome: string, program?: string }} places
 * @returns {'drive' | 'nested' | 'workspace' | 'dsh' | 'program' | 'notEmpty' | undefined}
 */
export function moveProblem(places) {
  const [from, to, dshHome] = [places.from, places.to, places.dshHome].map(real)
  const workspace = places.workspace === undefined ? undefined : real(places.workspace)
  const program = places.program === undefined ? undefined : real(places.program)
  if (dirname(to) === to) return 'drive'
  if (within(to, from) || within(from, to)) return 'nested'
  if (workspace !== undefined && (within(to, workspace) || within(workspace, to))) return 'workspace'
  if (within(to, dshHome) || within(dshHome, to)) return 'dsh'
  if (program !== undefined && within(to, program)) return 'program'
  if (existsSync(to) && (!statSync(to).isDirectory() || readdirSync(to).length > 0)) return 'notEmpty'
  return undefined
}

const escaped = text => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')

// A link that leads inside the old folder leads to the same place inside the copy: a relative
// one keeps its text, an absolute one is moved over. One that leads outside keeps leading
// there, as an absolute link. Windows gives a junction's target with \\?\, and makes only
// junctions, which hold absolute paths, without special rights.
async function relink(source, path, roots, to) {
  const text = (await readlink(source)).replace(/^\\\\\?\\UNC\\/u, '\\\\').replace(/^\\\\\?\\/u, '')
  const written = resolve(dirname(source), text)
  // Through another link the target can lead inside the old folder too.
  const physical = await realpath(written).catch(() => written)
  const direct = roots.some(folder => within(written, folder))
  const target = direct ? written : physical
  const root = roots.find(folder => within(target, folder))
  const folder = (await stat(source).catch(() => undefined))?.isDirectory() === true
  const windows = process.platform === 'win32'
  const inside = root === undefined ? written : join(to, relative(root, target))
  await symlink(direct && !isAbsolute(text) && !(windows && folder) ? text : inside, path, folder ? (windows ? 'junction' : 'dir') : 'file')
}

/**
 * Copy the data in `from` to `to`, an empty or new folder. The signal stops it between files.
 * @param {string} from @param {string} to @param {AbortSignal} [signal]
 */
export async function copyData(from, to, signal) {
  const parent = dirname(resolve(to))
  await mkdir(parent, { recursive: true })
  // A run that was killed can leave its staging folder behind.
  const staging = new RegExp(`^\\.${escaped(basename(to))}\\.moving-\\d+$`, 'u')
  for (const name of readdirSync(parent).filter(entry => staging.test(entry) && existsSync(join(parent, entry, MARK)))) {
    await rm(join(parent, name), { recursive: true, force: true, maxRetries: 5 })
  }
  const stage = join(parent, `.${basename(to)}.moving-${String(Date.now())}`)
  await mkdir(stage)
  try {
    await writeFile(join(stage, MARK), '')
    const links = []
    // The data folder can itself be a link; its contents are what moves.
    const origin = real(from)
    await cp(origin, stage, {
      recursive: true,
      filter: async (source) => {
        signal?.throwIfAborted()
        const path = relative(origin, source)
        if (LEFT_BEHIND.some(pattern => pattern.test(path))) return false
        if (path === '' || !(await lstat(source)).isSymbolicLink()) return true
        links.push(path)
        return false
      },
    })
    const roots = [...new Set([resolve(from), origin])]
    for (const path of links) {
      signal?.throwIfAborted()
      await relink(join(origin, path), join(stage, path), roots, resolve(to))
    }
    signal?.throwIfAborted()
    if (existsSync(to)) await rmdir(to)
    await rename(stage, to)
  } catch (error) {
    await rm(stage, { recursive: true, force: true, maxRetries: 5 })
    throw error
  }
  // Only now: a staging folder cut short before its rename keeps the mark that lets it go.
  await rm(join(to, MARK), { force: true })
}
