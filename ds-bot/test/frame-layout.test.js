import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  RAIL_WIDTH, DSH_NARROW,
  frameLayout, dshExpandedFor, userSidebarToggle,
} from '../src/client/frame-layout.js'

// The window, the shell sidebar's track width and what is open decide which left
// column shows and how the Bot panel sits; the chat keeps MIN_CHAT.
const at = (viewport, sidebarWidth, { pref = 'open', drawer = false, panel = null, collapsedWidth = 0 } = {}) =>
  frameLayout({ viewport, sidebarWidth, pref, drawer, panel, collapsedWidth })
const details = (yielded = false) => ({ view: 'details', yielded })
const browser = (yielded = false) => ({ view: 'browser', yielded })

test('a wide window keeps the open column and a shown panel', () => {
  const layout = at(1400, 280, { panel: details() })
  assert.deepEqual({ left: layout.left, panel: layout.panel }, { left: 'open', panel: 'shown' })
  assert.equal(layout.room, 1400 - 280)
})

test('the panel folds when column, panel and chat together do not fit', () => {
  // 280 + 320 + 420 = 1020 > 1000.
  const layout = at(1000, 280, { panel: details() })
  assert.deepEqual({ left: layout.left, panel: layout.panel }, { left: 'open', panel: 'folded' })
})

test('a yielded panel gets its room back from the rail', () => {
  // 88 + 320 + 420 = 828 <= 1000.
  const layout = at(1000, 280, { panel: details(true) })
  assert.deepEqual({ left: layout.left, panel: layout.panel }, { left: 'rail', panel: 'shown' })
  assert.equal(layout.room, 1000 - RAIL_WIDTH)
})

test('a yielded browser panel shows beside the rail, and only covers the chat below its minimum', () => {
  // 88 + 360 + 420 = 868.
  assert.equal(at(1000, 280, { panel: browser(true) }).panel, 'shown')
  const layout = at(760, 280, { panel: browser(true) })
  assert.deepEqual({ left: layout.left, panel: layout.panel }, { left: 'rail', panel: 'overlay' })
})

test('without a panel the column stays open while the chat fits, then folds to the rail', () => {
  // 280 + 420 = 700 <= 800, > 690.
  assert.equal(at(800, 280).left, 'open')
  assert.equal(at(800, 280).room, 800 - 280)
  assert.equal(at(690, 280).left, 'rail')
  assert.equal(at(690, 280).room, 690 - RAIL_WIDTH)
  assert.equal(at(690, 280, { drawer: true }).left, 'drawer')
  // A drawer floats over the chat: the room loses only the shell's collapsed track.
  assert.equal(at(690, 280, { drawer: true, collapsedWidth: 56 }).room, 690 - 56)
})

test('a rail preference keeps the rail beside a shown panel', () => {
  const layout = at(1400, 280, { pref: 'rail', panel: details() })
  assert.deepEqual({ left: layout.left, panel: layout.panel }, { left: 'rail', panel: 'shown' })
  assert.equal(layout.room, 1400 - RAIL_WIDTH)
})

test('a sidebar widened in Agent mode still folds the panel first', () => {
  // 420 + 320 + 420 = 1160 > 1100.
  const layout = at(1100, 420, { panel: details() })
  assert.deepEqual({ left: layout.left, panel: layout.panel }, { left: 'open', panel: 'folded' })
})

test('a folded panel in a drawer window keeps the drawer until the panel yields it', () => {
  const layout = at(690, 280, { drawer: true, panel: details() })
  assert.deepEqual({ left: layout.left, panel: layout.panel }, { left: 'drawer', panel: 'folded' })
  assert.equal(at(690, 280, { drawer: true, panel: details(true) }).left, 'rail')
})

test('an unknown panel view folds by the details minimum', () => {
  assert.equal(at(1000, 280, { panel: { view: 'mystery', yielded: false } }).panel, 'folded')
})

// The shell's own sidebar is expanded only for our open column above DSH_NARROW.
test('the shell sidebar stays expanded only for the open column on a wide window', () => {
  assert.equal(dshExpandedFor(DSH_NARROW, 'open'), true)
  assert.equal(dshExpandedFor(1400, 'open'), true)
  assert.equal(dshExpandedFor(DSH_NARROW - 1, 'open'), false)
  assert.equal(dshExpandedFor(1400, 'rail'), false)
  assert.equal(dshExpandedFor(1400, 'drawer'), false)
})

// A flip of the shell's collapsed flag is the user's switch gesture only when we
// did not request it and the window stayed on one side of the auto-collapse line.
test('a sidebar flip we requested is not a user toggle', () => {
  const before = { collapsed: false, viewport: 1400 }
  assert.equal(userSidebarToggle({ before, after: { collapsed: true, viewport: 1400 }, requested: true }), false)
})

test('a flip across the auto-collapse line is the shell rule, not a gesture', () => {
  const before = { collapsed: false, viewport: 1100 }
  assert.equal(userSidebarToggle({ before, after: { collapsed: true, viewport: 1000 } }), false)
})

test('an unrequested flip on one side of the line is the user', () => {
  const before = { collapsed: false, viewport: 1400 }
  assert.equal(userSidebarToggle({ before, after: { collapsed: true, viewport: 1300 } }), true)
  assert.equal(userSidebarToggle({ before: { collapsed: true, viewport: 800 }, after: { collapsed: false, viewport: 700 } }), true)
})
