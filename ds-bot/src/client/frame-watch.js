// The DOM side of the frame layout in frame-layout.js: measuring the shell's
// sidebar track, and the one CSS rule that writes the conversation column's
// margins (our own column on the left, the Bot panel on the right).
import { installStyles } from './styles.js'
import { nextCollapsedWidth, trackRoom } from './frame-layout.js'

export const sidebarTrackWidth = () => {
  const box = typeof document === 'undefined' ? undefined : document.querySelector('[class*="_sidebarCol"]')?.getBoundingClientRect()
  return box === undefined ? null : trackRoom(box)
}

// The shell frame marks itself [data-sidebar-collapsed]; null when no frame is found.
export const dshCollapsed = () => {
  if (typeof document === 'undefined') return null
  const column = document.querySelector('[class*="_sidebarCol"]')
  return column ? column.closest('[data-sidebar-collapsed]') !== null : null
}

// The track the collapsed shell sidebar keeps: nothing under a frameless window
// (Windows title bar, macOS desktop), its icon rail elsewhere.
export const collapsedTrackWidth = () =>
  document.documentElement.hasAttribute('data-windows-titlebar') || document.documentElement.dataset.platform === 'darwin' ? 0 : 56

// The conversation column's margins live in one rule of our own, matched on the
// column's exact class. A custom property on <body> would restyle the whole page,
// tens of milliseconds a write. A changed rule still restyles the column's
// subtree, so a drag writes the column's own inline style each frame and the
// rule once, on release.
const room = { rule: null, selector: '' }
const roomRule = () => {
  const live = room.rule?.parentStyleSheet?.ownerNode?.isConnected
  if (live && room.selector) return room.rule
  const column = document.querySelector('[class*="_centerCol"]')
  const selector = column ? [...column.classList].filter(name => name.includes('_centerCol')).map(name => `.${CSS.escape(name)}`).join(',') : ''
  if (live && !selector) return room.rule
  const declarations = room.rule?.style.cssText ?? ''
  room.rule?.parentStyleSheet?.ownerNode?.remove()
  const style = installStyles(`${selector || '[class*="_centerCol"]'}{${declarations}}`, 'chat-room')
  room.rule = style.sheet.cssRules[0]
  room.selector = selector
  return room.rule
}
const margin = (side, width, style) => {
  if (width === null) style.removeProperty(`margin-${side}`)
  else style.setProperty(`margin-${side}`, `${width}px`, 'important')
}
let roomHold = 0
export const chatRoom = {
  /** The margin the Bot panel takes on the right, in px, or null for the shell's own. */
  setRight(width) { margin('right', width, roomRule().style) },
  /** The margin our own left column takes while the shell sidebar is collapsed. */
  setLeft(width) { margin('left', width, roomRule().style) },
  /** While on, a margin change lands at once instead of gliding. */
  hold(on) {
    cancelAnimationFrame(roomHold)
    if (on) { roomRule().style.setProperty('transition', 'none', 'important'); return }
    // Two frames, so the last held write is on screen before the glide comes back.
    roomHold = requestAnimationFrame(() => { roomHold = requestAnimationFrame(() => roomRule().style.removeProperty('transition')) })
  },
  /** The columns themselves, for a drag's per-frame writes. */
  columns() {
    roomRule()
    return room.selector ? [...document.querySelectorAll(room.selector)] : []
  },
}

// Feeds the frame source the geometry the layout rules read: viewport, the
// shell sidebar's collapsed track width, and its collapsed flag. A resize or a
// sidebar slide does not always come with a window event, so the track width
// comes off a ResizeObserver and the flag off a MutationObserver.
export function installFrameWatch(frame) {
  let collapsedWidth = collapsedTrackWidth()
  let raf = 0
  const selector = '[class*="_sidebarCol"],[class*="_centerCol"]'
  let sidebar = null
  let columns = []
  let rescan = true
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(() => schedule()) : null
  const measure = () => {
    if (rescan) {
      rescan = false
      const next = [...document.querySelectorAll(selector)]
      for (const column of columns) if (!next.includes(column)) observer?.unobserve(column)
      for (const column of next) if (!columns.includes(column)) observer?.observe(column)
      columns = next
      sidebar = columns.find(column => column.matches('[class*="_sidebarCol"]')) ?? null
    }
    const animating = sidebar?.closest('[data-animating]') != null
    const width = !sidebar || animating ? null : trackRoom(sidebar.getBoundingClientRect())
    const collapsed = sidebar?.closest('[data-sidebar-collapsed]') != null
    collapsedWidth = nextCollapsedWidth({ measured: width, collapsed: sidebar ? collapsed : null, animating, last: collapsedWidth })
    frame.set(state => {
      const viewport = window.innerWidth
      if (state.viewport === viewport && state.collapsedWidth === collapsedWidth && state.collapsed === collapsed) return state
      return { ...state, viewport, collapsedWidth, collapsed }
    })
  }
  const schedule = () => {
    if (raf === 0) raf = requestAnimationFrame(() => { raf = 0; measure() })
  }
  measure()
  const mutations = new MutationObserver(records => {
    for (const record of records) {
      if (record.type === 'attributes') {
        if (sidebar && record.target.contains(sidebar)) schedule()
        continue
      }
      // Streaming text inside the conversation cannot replace its shell column.
      if (columns.some(column => !column.isConnected)) rescan = true
      else if (columns.some(column => column.contains(record.target))) continue
      else if ([...record.addedNodes].some(node => node.nodeType === 1 && (node.matches(selector) || node.querySelector(selector)))) rescan = true
      if (rescan) { schedule(); break }
    }
  })
  mutations.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-sidebar-collapsed', 'data-animating'] })
  window.addEventListener('resize', schedule)
  return () => {
    cancelAnimationFrame(raf)
    mutations.disconnect()
    observer?.disconnect()
    window.removeEventListener('resize', schedule)
  }
}
