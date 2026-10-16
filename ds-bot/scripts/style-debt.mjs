// Finds the colors, corner radii and springs in src/client that skip the shared ones.
// test/style-debt.json lists the ones written before the check; the test fails when a
// file gets one more, and when one is gone but still listed.
//
//   node scripts/style-debt.mjs           prints what it finds now
//   node scripts/style-debt.mjs --write   lowers test/style-debt.json to what is left
//
// --write only lowers counts. A new entry is added by hand, so it shows in review.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN = resolve(import.meta.dirname, '..')
const CLIENT = join(PLUGIN, 'src', 'client')
export const DEBT = join(PLUGIN, 'test', 'style-debt.json')

// The theme colors, the Bot colors and the generated characters.
const PALETTES = new Set(['themes.js', 'inks.js', 'characters.js'])
export const RADII = ['0', '4px', '6px', '8px', '10px', '12px', '16px', '18px', '20px', '22px', '999px', '50%', 'inherit']

const COLOR = /#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})\b|\b(?:rgba?|hsla?)\([^)]*\)/gi
const RADIUS = /border(?:-[a-z]+)*-radius\s*:\s*((?:\$\{[^}]*\}|[^;{}`'"])+)|border\w*Radius\s*:\s*['"]?((?:\$\{[^}]*\}|[^,}'"])+)/g
const SPRING = /\bspringEasing\([^)]*\)|\blinear\([^)]*\)/g

// The gradient(…) that holds `index`, or ''.
function gradientAround(line, index) {
  const start = line.lastIndexOf('gradient(', index)
  if (start < 0) return ''
  let depth = 0
  for (let at = start; at < line.length; at += 1) {
    if (line[at] === '(') depth += 1
    else if (line[at] === ')' && --depth === 0) return at > index ? line.slice(start, at + 1) : ''
  }
  return ''
}

// A literal color that is not a hard-coded one: the value of a variable, or black used
// for its alpha (shadows, scrims, and masks, whose ramps run to transparent).
function exempt(value, line, index) {
  const before = line.slice(0, index)
  if (/--[\w-]+['"]?\s*:[^;{}]*$/.test(before) || value.startsWith('rgba(0,0,0,')) return true
  if (!/^#000(?:000)?$/.test(value)) return false
  return /<mask\b(?!.*<\/mask>)/.test(before) || gradientAround(line, index).includes('transparent')
}

const plain = value => value.toLowerCase().replace(/\s+/g, '')

// A step is one corner of a border-radius value; a bare number in a React style is px.
const steps = value => value.replace(/!important/g, '').replace(/\([^)]*\)/g, group => group.replace(/\s+/g, '')).trim().split(/\s*\/\s*|\s+/)
  .map(step => (/^\d*\.?\d+$/.test(step) && step !== '0' ? `${step}px` : step))

export const checks = {
  colors: (file, line) => (PALETTES.has(file) ? [] : [...line.matchAll(COLOR)]
    .map(({ 0: value, index }) => ({ value: plain(value), index }))
    .filter(({ value, index }) => !exempt(value, line, index))
    .map(({ value }) => value)),
  radii: (file, line) => [...line.matchAll(RADIUS)]
    .flatMap(match => steps(match[1] ?? match[2]))
    .filter(step => !RADII.includes(step) && !step.startsWith('var(')),
  springs: (file, line) => (file === 'motion.js' ? [] : [...line.matchAll(SPRING)].map(({ 0: call }) => call.replace(/\s+/g, ''))),
}

// Comments are not styles. A trailing comment follows a space, which a URL's `://` lacks.
const code = text => text.split(/\r?\n/)
  .map(line => (/^\s*(\/\/|\/\*|\*\/|\*\s|\*$)/.test(line) ? '' : line.replace(/\s\/\/\s.*$/, '')))

export function findStyles(dir = CLIENT) {
  const found = Object.fromEntries(Object.keys(checks).map(kind => [kind, {}]))
  for (const file of readdirSync(dir, { recursive: true }).filter(name => name.endsWith('.js')).map(name => name.replaceAll('\\', '/'))) {
    for (const line of code(readFileSync(join(dir, file), 'utf8'))) {
      for (const [kind, check] of Object.entries(checks)) {
        for (const value of check(file, line)) {
          const counts = (found[kind][file] ??= {})
          counts[value] = (counts[value] ?? 0) + 1
        }
      }
    }
  }
  return found
}

export const readDebt = () => JSON.parse(readFileSync(DEBT, 'utf8'))

// Each listed entry keeps the smaller of its listed and its found count.
export function lowered(debt, found) {
  return Object.fromEntries(Object.entries(debt).map(([kind, files]) => [kind, Object.fromEntries(Object.entries(files)
    .map(([file, values]) => [file, Object.fromEntries(Object.entries(values)
      .map(([value, count]) => [value, Math.min(count, found[kind]?.[file]?.[value] ?? 0)])
      .filter(([, count]) => count > 0))])
    .filter(([, values]) => Object.keys(values).length > 0))]))
}

const sorted = item => (typeof item === 'object'
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, value]) => [key, sorted(value)]))
  : item)
const format = debt => `${JSON.stringify(sorted(debt), null, 2)}\n`

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const found = findStyles()
  if (process.argv.includes('--write')) writeFileSync(DEBT, format(lowered(readDebt(), found)))
  else process.stdout.write(format(found))
}
