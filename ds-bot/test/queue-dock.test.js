import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// jsdom comes from the harness that test/harness-resolve.mjs found, like the dsh packages.
const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
const { JSDOM } = createRequire(join(process.env.DSH_HARNESS ?? join(PLUGIN, '..', 'deepseek-harness'), 'package.json'))('jsdom')

const { outputFiles } = await build({
  stdin: {
    contents: "export { QueueDock } from './src/client/queue-dock.js'",
    resolveDir: PLUGIN,
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
let firstState
let stateIndex = 0
const react = {
  createElement: (type, props, ...children) => ({ type, props: { ...props, children } }), Fragment: Symbol('Fragment'),
  useEffect() {}, useLayoutEffect() {}, useState: (initial) => [stateIndex++ === 0 && firstState !== undefined ? firstState : initial, () => {}],
  useMemo: make => make(), useRef: current => ({ current }), useId: () => 'id',
}
const dom = new JSDOM('<!doctype html><body></body>')
const module = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports,
  document: dom.window.document,
  window: { matchMedia: () => ({ matches: false }) },
  require: name => (name === 'react' ? react : {}),
})
const { QueueDock } = module.exports

const row = (id, kind, text) => ({ id, source: { kind }, content: [{ type: 'text', text }] })

const dock = (nextTurn, { running = false, pendingSubmissions = [], nextStep = [], botOpen = false } = {}) => {
  const sessionId = 'session-a'
  stateIndex = 0
  firstState = botOpen ? sessionId : undefined
  return QueueDock({
    sessionId,
    useSession: selector => selector({ running, pendingSubmissions, subagent: null }),
    useProjection: () => ({ 'next-turn': nextTurn, 'next-step': nextStep }),
    updateQueue: async () => ({ ok: true }),
    loadImage: async () => 'about:blank',
    actions: { reportError: () => {} },
  })
}

// The stub tree holds element objects, function components unevaluated; walk it
// for one class or text leaf.
function collect(node, found = { rows: [], texts: [], labels: [] }) {
  if (node === null || node === undefined || typeof node === 'boolean') return found
  if (typeof node === 'string' || typeof node === 'number') { found.texts.push(String(node)); return found }
  if (Array.isArray(node)) { for (const item of node) collect(item, found); return found }
  if (typeof node !== 'object') return found
  if (typeof node.type === 'function') { collect(node.type(node.props), found); return found }
  if (typeof node.props?.className === 'string' && node.props.className.split(' ').includes('bt-queue-row')) found.rows.push(node)
  if (typeof node.props?.['aria-label'] === 'string') found.labels.push(node.props['aria-label'])
  collect(node.props?.children, found)
  return found
}

test('team deliveries in the queue never draw as the user’s own rows (#663)', () => {
  const tree = dock([
    row('u1', 'user', 'ship it when you can'),
    row('b1', 'bot', '[Reply from Writer]\ndone'),
    row('b2', 'bot', '[Group post from Tester]\nlooks fine'),
  ])
  const { rows, texts } = collect(tree)
  assert.equal(rows.length, 1)
  assert.ok(texts.includes('ship it when you can'))
  assert.ok(!texts.some(text => text.includes('[Reply from') || text.includes('[Group post from')))
})

test('a queue of only Bot mail renders a collapsed separate count', () => {
  const tree = dock([row('b1', 'bot', '[Reply from Writer]\ndone')])
  const { rows, texts } = collect(tree)
  assert.equal(rows.length, 0)
  assert.ok(texts.includes('1 Bot messages waiting'))
  assert.ok(!texts.some(text => text.includes('[Reply from')))
})

test('expanded Bot mail shows both placements without edit or delete controls', () => {
  const nextStep = [{ ...row('b1', 'bot', 'step message'), source: { kind: 'bot', senderName: 'Writer' } }]
  const nextTurn = [{ ...row('b2', 'bot', 'turn message'), source: { kind: 'bot', senderName: 'Tester' } }]
  const tree = dock(nextTurn, { nextStep, botOpen: true })
  const { rows, texts, labels } = collect(tree)
  assert.equal(rows.length, 0)
  assert.ok(texts.includes('Writer'))
  assert.ok(texts.includes('Tester'))
  assert.ok(texts.includes('Next step'))
  assert.ok(texts.includes('Next turn'))
  assert.ok(texts.includes('step message'))
  assert.ok(texts.includes('turn message'))
  assert.ok(!labels.includes('Edit queued message'))
  assert.ok(!labels.includes('Delete queued message'))
  assert.ok(!labels.includes('Steer queued message'))
})

test('an entirely empty queue renders nothing', () => {
  assert.equal(dock([]), null)
})

test('the count names only the user’s queued sends', () => {
  const tree = dock([
    row('u1', 'user', 'first'),
    row('u2', 'schedule', 'second, scheduled'),
    row('b1', 'bot', '[Message from Writer]\nnew task'),
  ])
  const { texts } = collect(tree)
  assert.ok(texts.includes('2 queued messages'))
})

test('a user send still in flight shows as sending', () => {
  const tree = dock([], { pendingSubmissions: [{ requestId: 'r1', placement: 'queued', text: 'on its way', attachments: [] }] })
  const { rows, texts } = collect(tree)
  assert.equal(rows.length, 1)
  assert.ok(texts.includes('Sending…'))
})
