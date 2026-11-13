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
    contents: "export { QueueDock, combineRoomPosts } from './src/client/queue-dock.js'",
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
const { QueueDock, combineRoomPosts } = module.exports

const row = (id, kind, text) => ({ id, source: { kind }, content: [{ type: 'text', text }] })

const dock = (nextTurn, { running = false, pendingSubmissions = [], nextStep = [], botOpen = false, groupQueue = [], earlierPrivate = [], missingInbox = false, isRoom = false, roomPosts = [], roomCurrentPosts, roomUnknown = false, pending = { relay: 0, next: 0 } } = {}) => {
  const sessionId = 'session-a'
  stateIndex = 0
  firstState = botOpen ? sessionId : undefined
  const currentPosts = roomCurrentPosts ?? [...nextStep, ...nextTurn].filter(item => item.source?.kind === 'bot' && item.source?.role === 'post').map(item => ({ id: item.id, messageId: item.id, sessionId, exchangeId: item.source.exchangeId }))
  return QueueDock({
    sessionId,
    useSession: selector => selector({ running, pendingSubmissions, subagent: null }),
    useProjection: () => missingInbox ? {} : ({ 'next-turn': nextTurn, 'next-step': nextStep }),
    useRoster: selector => selector({ byId: isRoom ? {} : { [sessionId]: { id: 'bot-a' } }, roomsById: isRoom ? { [sessionId]: { id: 'room-a' } } : {} }),
    useWork: selector => selector({ groupQueues: { 'bot-a': groupQueue }, earlierPrivateQueues: { 'bot-a': earlierPrivate }, roomPostQueues: { 'room-a': { rows: [...currentPosts, ...roomPosts], unavailable: roomUnknown } }, roomPending: { 'room-a': pending } }),
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
  assert.ok(texts.includes('Bot private 1'))
  assert.ok(!texts.some(text => text.includes('[Reply from')))
})

test('group mail appears with private mail and also when the private queue is empty', () => {
  const groupQueue = [{ id: 'g1', roomId: 'room', roomName: 'Team', senderName: 'Writer', text: 'Please decide' }]
  const { texts } = collect(dock([], { groupQueue, botOpen: true }))
  assert.ok(texts.includes('Group 1'))
  assert.ok(texts.includes('Team'))
  assert.ok(texts.includes('Writer'))
  assert.ok(texts.includes('Please decide'))
  assert.ok(collect(dock([row('b1', 'bot', 'private')], { groupQueue })).texts.includes('Bot private 1 + Group 1'))
})

test('room posts are shown separately without assigning a recipient', () => {
  const post = { ...row('post', 'bot', '@Writer review'), source: { kind: 'bot', role: 'post', senderName: 'Tester' } }
  const { texts } = collect(dock([post], { isRoom: true, botOpen: true }))
  assert.ok(texts.includes('Group posts awaiting dispatch: 1'))
  assert.ok(texts.includes('Tester'))
  assert.ok(texts.includes('@Writer review'))
  assert.ok(!texts.some(text => text.startsWith('Bot private')))
  assert.equal(collect(dock([], { isRoom: true })).texts.length, 0)
  assert.equal(collect(dock([], { isRoom: true, missingInbox: true })).texts.length, 0)
})

test('an unavailable group inbox does not create an empty queue; its warning remains visible with known work', () => {
  const groupQueue = [{ id: 'unavailable:g', roomId: 'room', roomName: 'Team', unavailable: true }]
  assert.equal(collect(dock([], { groupQueue, botOpen: true })).texts.length, 0)
  const { texts } = collect(dock([row('b1', 'bot', 'private')], { groupQueue, botOpen: true }))
  assert.ok(texts.includes('Bot private 1'))
  assert.ok(texts.includes('Group inbox unavailable'))
})

test('known group rows with an unavailable snapshot never display an exact number', () => {
  const groupQueue = [
    { id: 'g1', roomId: 'r1', roomName: 'Team', text: 'work' },
    { id: 'unknown', roomId: 'r2', roomName: 'Other', unavailable: true },
  ]
  const { texts } = collect(dock([], { groupQueue, botOpen: true }))
  assert.ok(texts.includes('Group messages waiting; count unavailable'))
  assert.ok(texts.includes('Group inbox unavailable'))
  assert.ok(!texts.some(text => text.includes('+?')))
})

test('only positive group scheduling stages appear in the header', () => {
  assert.ok(collect(dock([], { isRoom: true, pending: { relay: 2, next: 0 } })).texts.includes('Relay waiting items: 2'))
  assert.ok(collect(dock([], { isRoom: true, pending: { relay: 0, next: 3 } })).texts.includes('Next-round items: 3'))
  assert.equal(collect(dock([], { isRoom: true, roomUnknown: true, pending: { relay: 0, next: 0 } })).texts.length, 0)
})

test('earlier private inbox entries and unknowns are included in the private count', () => {
  const earlierPrivate = [{ id: 'old', senderName: 'Writer', text: 'earlier' }, { id: 'missing', unavailable: true }]
  const { texts } = collect(dock([row('new', 'bot', 'current')], { earlierPrivate, botOpen: true }))
  assert.ok(texts.includes('Bot private messages waiting; count unavailable'))
  assert.ok(texts.includes('Private inbox unavailable'))
  assert.ok(texts.includes('earlier'))
})

test('a missing private inbox alone does not create a queue and remains visible alongside group work', () => {
  assert.equal(collect(dock([], { missingInbox: true, botOpen: true })).texts.length, 0)
  const groupQueue = [{ id: 'g1', roomId: 'room', roomName: 'Team', text: 'work' }]
  const { texts } = collect(dock([], { missingInbox: true, groupQueue, botOpen: true }))
  assert.ok(texts.includes('Group 1'))
  assert.ok(texts.includes('Private inbox unavailable'))
})

test('the same exchange in current and earlier private inboxes counts once', () => {
  const current = { ...row('current', 'bot', 'new'), source: { kind: 'bot', exchangeId: 'same' } }
  const earlierPrivate = [{ id: 'old', exchangeId: 'same', text: 'old' }]
  const { texts } = collect(dock([current], { earlierPrivate, botOpen: true }))
  assert.ok(texts.includes('Bot private 1'))
  assert.ok(!texts.includes('old'))
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


test('room history and relay stages are distinct, with unknown inbox explicit', () => {
  const current = { ...row('current', 'bot', 'current'), source: { kind: 'bot', role: 'post', exchangeId: 'same' } }
  const roomPosts = [{ id: 'dup', messageId: 'dup', sessionId: 'old', exchangeId: 'same', text: 'duplicate' }, { id: 'old', messageId: 'old', sessionId: 'old', exchangeId: 'other', text: 'history', attachments: 1 }]
  const { texts } = collect(dock([current], { isRoom: true, roomPosts, roomUnknown: true, pending: { relay: 2, next: 3 }, botOpen: true }))
  assert.ok(texts.includes('Group posts awaiting dispatch; count unavailable · Relay waiting items: 2 · Next-round items: 3'))
  assert.ok(texts.includes('Relay waiting items: 2 · Next-round items: 3'))
  assert.ok(texts.includes('Counts exclude items in transfer and may include control events.'))
  assert.ok(texts.includes('history'))
  assert.ok(texts.includes('Attachments: 1'))
  assert.ok(!texts.includes('duplicate'))
})


test('host and projection disagreements remain visible with unknown count', () => {
  const post = { ...row('one', 'bot', 'projection only'), source: { kind: 'bot', role: 'post', exchangeId: 'ex1' } }
  let result = collect(dock([post], { isRoom: true, roomCurrentPosts: [], botOpen: true }))
  assert.ok(result.texts.includes('Group posts awaiting dispatch; count unavailable'))
  assert.ok(result.texts.includes('projection only'))
  result = collect(dock([], { isRoom: true, roomCurrentPosts: [{ id: 'two', messageId: 'two', sessionId: 'session-a', exchangeId: 'ex2', text: 'host only' }], botOpen: true }))
  assert.ok(result.texts.includes('Group posts awaiting dispatch; count unavailable'))
  assert.ok(result.texts.includes('host only'))
})

test('matched current IDs produce a precise count; absent IDs and cross-part ambiguity remain unknown', () => {
  const post = { ...row('one', 'bot', 'same'), source: { kind: 'bot', role: 'post', exchangeId: 'ex1' } }
  let result = collect(dock([post], { isRoom: true, botOpen: true }))
  assert.ok(result.texts.includes('Group posts awaiting dispatch: 1'))
  result = collect(dock([post], { isRoom: true, roomCurrentPosts: [{ id: 'fallback', sessionId: 'session-a', text: 'unidentified' }], botOpen: true }))
  assert.ok(result.texts.includes('Group posts awaiting dispatch; count unavailable'))
  const noExchange = { ...post, source: { kind: 'bot', role: 'post' } }
  result = collect(dock([noExchange], { isRoom: true, roomPosts: [{ id: 'old', messageId: 'old', sessionId: 'old', text: 'historic' }], botOpen: true }))
  assert.ok(result.texts.includes('Group posts awaiting dispatch; count unavailable'))
})

test('collapsed group heading exposes each stage with qualification', () => {
  const result = collect(dock([], { isRoom: true, pending: { relay: 2, next: 3 } }))
  assert.ok(result.texts.includes('Relay waiting items: 2 · Next-round items: 3'))
  assert.ok(result.texts.includes('Counts exclude items in transfer and may include control events.'))
})

test('stable current message IDs and cross-part exchange IDs deduplicate when snapshots agree', () => {
  const post = { ...row('one', 'bot', 'current'), source: { kind: 'bot', role: 'post', exchangeId: 'ex1' } }
  const old = [{ id: 'old-one', messageId: 'old-one', sessionId: 'old', exchangeId: 'ex1', text: 'duplicate' }, { id: 'old-two', messageId: 'old-two', sessionId: 'old', exchangeId: 'ex2', text: 'historic' }]
  const result = collect(dock([post, post], { isRoom: true, roomPosts: old, botOpen: true }))
  assert.ok(result.texts.includes('Group posts awaiting dispatch: 2'))
  assert.equal(result.texts.filter(text => text === 'current').length, 1)
  assert.ok(result.texts.includes('historic'))
  assert.ok(!result.texts.includes('duplicate'))
})

test('conflicting source identity is not reported as an exact count', () => {
  const post = { ...row('one', 'bot', 'current'), source: { kind: 'bot', role: 'post', exchangeId: 'ex1' } }
  const current = [{ id: 'one', messageId: 'one', sessionId: 'session-a', exchangeId: 'changed' }]
  const result = collect(dock([post], { isRoom: true, roomCurrentPosts: current }))
  assert.ok(result.texts.includes('Group posts awaiting dispatch; count unavailable'))
})


test('same-session IDs and cross-session exchange IDs have separate matching scope', () => {
  const make = (id, exchangeId) => ({ row: { id, source: { exchangeId } } })
  const host = { unavailable: false, rows: [
    { sessionId: 'a', id: 'one', messageId: 'one', exchangeId: 'shared' },
    { sessionId: 'a', id: 'two', messageId: 'two', exchangeId: 'shared' },
    { sessionId: 'b', id: 'three', messageId: 'three', exchangeId: 'shared' },
    { sessionId: 'c', id: 'four', messageId: 'four', exchangeId: 'shared' },
  ] }
  const result = combineRoomPosts([make('one', 'shared'), make('two', 'shared')], host, 'a', true)
  assert.equal(result.uncertain, false)
  assert.equal(result.rows.length, 2)
  assert.equal(result.rows[0].messageId, 'one')
  assert.equal(result.rows[1].messageId, 'two')
  const missing = combineRoomPosts([], { unavailable: false, rows: [{ sessionId: 'a' }, { sessionId: 'b' }] }, 'a', true)
  assert.equal(missing.uncertain, true)
  assert.equal(missing.rows.length, 2)
})

test('large group inbox reconciliation uses a linear number of row accesses', () => {
  const count = 5000
  let reads = 0
  const rows = Array.from({ length: count }, (_, i) => new Proxy({ sessionId: 'a', id: `m${i}`, messageId: `m${i}`, exchangeId: `e${i}` }, {
    get(target, key) { reads += 1; return target[key] },
  }))
  const result = combineRoomPosts([], { rows, unavailable: false }, 'a', true)
  assert.equal(result.rows.length, count)
  assert.equal(result.uncertain, true)
  assert.ok(reads < count * 80, `row property reads ${reads} exceed a linear bound`)
})
