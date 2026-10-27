// The Bot shell's frame geometry: the left column (open, avatar rail or drawer),
// the Bot panel and the conversation share the window. The conversation keeps at
// least MIN_CHAT px; the column folds to a rail of avatars before the chat is
// squeezed, and an open panel that no longer fits folds away or covers the chat.
// These rules are pure so tests can drive them; the DOM side lives in
// frame-watch.js.
import { STORAGE } from './storage.js'

export const MIN_CHAT = 420
export const RAIL_WIDTH = 88
export const PANEL_MIN = { details: 320, browser: 360, side: 320 }
// The shell collapses its own sidebar below this width; our column takes over
// from there, and its toggleSidebar flips narrow-expanded state instead.
export const DSH_NARROW = 1024
// The shell column's width when it was never measured (its own default is 280).
export const FALLBACK_SIDEBAR_WIDTH = 280

/**
 * @param {{viewport: number, sidebarWidth: number,
 *   pref: 'open'|'rail', drawer?: boolean,
 *   panel: null | {view: string, yielded: boolean}}} input
 * @returns {{left: 'open'|'rail'|'drawer', panel: 'none'|'shown'|'folded'|'overlay', room: number}}
 *   `room` is the width the panel and the conversation share: the viewport minus
 *   what the left column occupies (its full width when open, else the rail's —
 *   a drawer floats over the rail's place, so the chat does not move under it).
 */
export function frameLayout({ viewport, sidebarWidth, pref, drawer = false, panel = null }) {
  const fits = pref === 'open' && viewport >= sidebarWidth + MIN_CHAT
  let left = fits ? 'open' : drawer && pref === 'open' ? 'drawer' : 'rail'
  let occupied = left === 'open' ? sidebarWidth : RAIL_WIDTH
  let panelState = 'none'
  if (panel !== null) {
    const need = (PANEL_MIN[panel.view] ?? PANEL_MIN.details) + MIN_CHAT
    if (occupied + need <= viewport) panelState = 'shown'
    else if (panel.yielded === true) {
      // A panel the user asks to see takes the column's room: it falls back to
      // the rail, and covers the conversation only when even that is not enough.
      left = 'rail'
      occupied = RAIL_WIDTH
      panelState = RAIL_WIDTH + need <= viewport ? 'shown' : 'overlay'
    } else panelState = 'folded'
  }
  return { left, panel: panelState, room: Math.max(0, viewport - occupied) }
}

// The shell sidebar stays expanded only for our 'open' column at a wide-enough
// window; under DSH_NARROW it is always collapsed and our own column draws.
export const dshExpandedFor = (viewport, left) => viewport >= DSH_NARROW && left === 'open'

// The shell measures the window on its own frame, a beat apart from us, and
// re-applies its own rule when it does: a flip this soon after a width change is
// the shell settling, not a gesture.
export const RESIZE_SETTLE_MS = 500
// A flip of the shell's collapsed flag counts as the user's own switch gesture
// only when we did not request it, the width has settled, and it stayed on one
// side of the auto-collapse line (a crossing is the shell's own rule firing).
export const userSidebarToggle = ({ before, after, requested = false, sinceResize = Infinity }) =>
  before.collapsed !== after.collapsed && !requested && sinceResize >= RESIZE_SETTLE_MS
  && (before.viewport < DSH_NARROW) === (after.viewport < DSH_NARROW)

// The user's sidebar preference survives restarts: 'open' by default, 'rail'
// after they collapse the column themselves.
export function readSidebarPref(storage = globalThis.localStorage) {
  try { return storage.getItem(STORAGE.sidebar) === 'rail' ? 'rail' : 'open' } catch { return 'open' }
}
export function writeSidebarPref(pref, storage = globalThis.localStorage) {
  try { storage.setItem(STORAGE.sidebar, pref === 'rail' ? 'rail' : 'open') } catch { /* storage unavailable */ }
}
