// The build identity an operator needs to tell one local release from another.
// The version alone does not: a fork build and the upstream release can both be
// 0.3.8, so the build stamp, fork commit and changed-feature list travel with it.
import { readFileSync } from 'node:fs'

let manifest
function readManifest() {
  if (manifest === undefined) {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
    manifest = {
      name: pkg.name,
      version: pkg.version,
      build: pkg.dsBot?.build,
      fork: pkg.dsBot?.fork,
      forkCommit: pkg.dsBot?.forkCommit,
      upstreamCommit: pkg.dsBot?.upstreamCommit,
      changes: Array.isArray(pkg.dsBot?.changes) ? pkg.dsBot.changes : [],
    }
  }
  return manifest
}

export function versionInfo(state, home) {
  return { ...readManifest(), stateRevision: state?.revision, home, readAt: new Date().toISOString() }
}