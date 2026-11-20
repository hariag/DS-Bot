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

function runtimeInfo() {
  const bin = process.argv[1] ?? ''
  const match = /[\\/]dsh-runtime[\\/]([^\\/]+)[\\/]/.exec(bin)
  return {
    runtime: match?.[1] ?? null,
    node: process.version,
    pid: process.pid,
    uptimeSeconds: Math.round(process.uptime()),
  }
}

export function versionInfo(state, home) {
  return { ...readManifest(), ...runtimeInfo(), stateRevision: state?.revision, home, readAt: new Date().toISOString() }
}