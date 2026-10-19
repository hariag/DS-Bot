// electron-builder's beforePack hook. The native modules go into the package as npm installed them
// (npmRebuild: false), so they fit only the architecture of the Node that ran npm. An app built for
// another architecture would carry them and not start, so such a build stops here.
import { Arch } from 'electron-builder'

const WHERE = {
  darwin: { x64: 'on an Intel Mac, or under Rosetta with an x64 Node', arm64: 'on a Mac with Apple silicon' },
}

/** @returns {string | undefined} why this Node cannot build an app for `target` */
export function archProblem({ target, platform, host = process.arch }) {
  if (target === host) return undefined
  if (target === 'universal') return 'A universal app would need the native modules of both architectures. Build one app per architecture.'
  const where = WHERE[platform]?.[target] ?? `with an ${target} Node`
  return `This Node runs on ${host}, so npm installed ${host} native modules, and an ${target} app with them would not start. Install the dependencies and build ${where}.`
}

export async function beforePack(context) {
  const problem = archProblem({ target: Arch[context.arch], platform: context.electronPlatformName })
  if (problem !== undefined) throw new Error(problem)
}
