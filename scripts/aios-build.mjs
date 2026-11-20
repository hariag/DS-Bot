#!/usr/bin/env node
// Build one AIOS-stamped ds-bot artifact with its provenance record.
//
//   node scripts/aios-build.mjs --build aios-YYYYMMDD.N [--out DIR] [--no-commit]
//
// The stamp edits ds-bot/package.json (version and dsBot build fields) and commits
// it unless --no-commit is given, then packs the plugin and writes
// <tarball>.provenance.json next to it. Pass --build-client to rebuild the bundles
// first; without it the committed bundles ship, so a machine without the client's
// dev dependencies can still produce a byte-identical release artifact. It never installs or restarts
// anything: deployment stays an explicit step whose result is written into the same
// provenance file. Every build therefore leaves one auditable record naming the
// source commit, the artifact hash and the file count.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dsBot = join(root, 'ds-bot')
const args = process.argv.slice(2)
const value = name => {
  const at = args.indexOf(`--${name}`)
  return at === -1 ? undefined : args[at + 1]
}
const fail = message => {
  console.error(`aios-build: ${message}`)
  process.exit(1)
}
const git = (...line) => execFileSync('git', ['-C', root, ...line], { encoding: 'utf8' }).trim()

const build = value('build')
if (!build || !/^aios-\d{8}\.\d+$/.test(build)) fail('--build aios-YYYYMMDD.N is required')
const out = resolve(value('out') ?? join(root, 'artifacts'))
const commit = !args.includes('--no-commit')
if (git('status', '--porcelain', '--untracked-files=no') !== '') fail('commit or stash tracked changes first')

const head = git('rev-parse', 'HEAD')
const pkgPath = join(dsBot, 'package.json')
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
// Build metadata keeps the dotted form used by earlier artifacts: 0.3.8+aios.20261120.7,
// while the build field keeps the dashed one: aios-20261120.7.
pkg.version = `${String(pkg.version).split('+')[0]}+${build.replace(/^aios-/, 'aios.')}`
pkg.dsBot = { ...pkg.dsBot, build, fork: 'hariag/DS-Bot', forkCommit: head, upstreamCommit: pkg.dsBot?.upstreamCommit ?? '' }
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`)
if (commit) {
  execFileSync('git', ['-C', root, 'add', 'ds-bot/package.json'])
  execFileSync('git', ['-C', root, 'commit', '-m', `chore: stamp fork commit ${head.slice(0, 12)} for build ${build}`])
}

if (args.includes('--build-client')) execFileSync('npm', ['run', 'build'], { cwd: dsBot, stdio: 'inherit' })
else console.log('aios-build: packing the committed client bundles (pass --build-client to rebuild first)')
mkdirSync(out, { recursive: true })
const stamped = JSON.parse(readFileSync(pkgPath, 'utf8'))
const packed = execFileSync('npm', ['pack', '--pack-destination', out], { cwd: dsBot, encoding: 'utf8' }).trim().split('\n').pop()
// Match the artifact naming earlier deploys used, and keep '+' out of file names.
const tarball = join(out, `ds-bot-${String(stamped.version).split('+')[0]}-${build}.tgz`)
renameSync(join(out, packed), tarball)
const bytes = readFileSync(tarball)
const sha256 = createHash('sha256').update(bytes).digest('hex')
const files = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).length

const offset = -new Date().getTimezoneOffset()
const pad = number => String(Math.abs(number)).padStart(2, '0')
const now = new Date()
const recordedAt = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  + `T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
  + `${offset >= 0 ? '+' : '-'}${pad(offset / 60)}:${pad(offset % 60)}`
const provenance = {
  kind: 'ds-bot-build-deploy',
  recordedAt,
  build: {
    version: stamped.version,
    build,
    fork: 'hariag/DS-Bot',
    commit: head.slice(0, 12),
    stampCommit: git('rev-parse', 'HEAD'),
    upstreamCommit: stamped.dsBot.upstreamCommit,
    changes: stamped.dsBot.changes ?? [],
  },
  artifact: {
    path: tarball,
    sha256,
    size: statSync(tarball).size,
    files,
  },
  install: {
    note: 'Install this file into the profile, restart dsh-web, then record installedVersion, service pid and the version endpoint result here.',
  },
}
writeFileSync(tarball.replace(/\.tgz$/, '.provenance.json'), `${JSON.stringify(provenance, null, 2)}\n`)
console.log(JSON.stringify({ version: stamped.version, tarball, sha256, files, recordedAt }, null, 1))