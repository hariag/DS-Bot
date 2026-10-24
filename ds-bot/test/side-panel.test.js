import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { drawerMenuKeys, panelHasStrip, stripMenuKeys } from '../src/client/side-model.js'

// The strip shows whenever the Bot has a browser tab or a side chat; side chats
// need no browser bridge, so DSH Web gets them too.
test('the strip shows with only side chats and no browser', () => {
  assert.equal(panelHasStrip(false, 0, 1), true)
  assert.equal(panelHasStrip(false, 0, 0), false)
  assert.equal(panelHasStrip(true, 0, 0), false)
  assert.equal(panelHasStrip(true, 1, 0), true)
  assert.equal(panelHasStrip(true, 0, 2), true)
})

test('the strip `···` offers a browser tab only where the browser works', () => {
  assert.deepEqual(stripMenuKeys({ canBrowse: true, canTerminal: true, canFiles: true }),
    ['new-tab', 'side', 'sep', 'terminal', 'files'])
  assert.deepEqual(stripMenuKeys({ canBrowse: false, canTerminal: false, canFiles: false }), ['side'])
  assert.deepEqual(stripMenuKeys({ canBrowse: false, canTerminal: true, canFiles: false }),
    ['side', 'sep', 'terminal'])
})

test('the details `···` hides when it would be empty', () => {
  assert.deepEqual(drawerMenuKeys({ bot: true, canBrowse: true, canTerminal: true, canFiles: true }),
    ['browser', 'side', 'sep', 'terminal', 'files'])
  assert.deepEqual(drawerMenuKeys({ bot: true, canBrowse: false, canTerminal: false, canFiles: false }), ['side'])
  assert.deepEqual(drawerMenuKeys({ bot: false, room: true, canBrowse: false, canTerminal: true, canFiles: true }),
    ['terminal', 'files'])
  assert.deepEqual(drawerMenuKeys({ bot: false, room: true, canBrowse: false, canTerminal: false, canFiles: false }), [])
  assert.deepEqual(drawerMenuKeys({ bot: false, room: false, canBrowse: false, canTerminal: true, canFiles: true }), [])
})

// The `···` popover, bundled once and rendered with a minimal React stand-in;
// the useState for `open` starts true so the items are on the tree.
const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/browser-pane.js', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'node', write: false,
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const module = { exports: {} }
runInNewContext(bundle.outputFiles[0].text, {
  module, exports: module.exports, URL, URLSearchParams, setTimeout, clearTimeout,
  window: { addEventListener() {}, removeEventListener() {}, innerWidth: 1280 },
  require: (name) => {
    const platform = {
      react: {
        createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
        useState: () => [true, () => {}], useEffect: () => {}, useRef: () => ({ current: null }),
        useLayoutEffect: () => {}, useMemo: make => make(), useCallback: fn => fn,
        useSyncExternalStore: (_subscribe, get) => get(), Fragment: 'fragment',
      },
      'react-dom': { createPortal: node => node },
      '@deepseek-ai/dsh-client-ui-primitives': { MarkdownText: () => null },
    }
    if (!(name in platform)) throw new Error(`no platform module ${name}`)
    return platform[name]
  },
})
const { PanelMenu, menuItemFor } = module.exports

const find = (node, match, out = []) => {
  if (Array.isArray(node)) node.forEach(child => find(child, match, out))
  else if (node !== null && typeof node === 'object') {
    if (match(node)) out.push(node)
    for (const child of node.children ?? []) find(child, match, out)
  }
  return out
}

test('the `···` button opens the menu with an item per entry', () => {
  const actions = { openBrowser: () => {}, browserNewTab: () => {}, newSideChat: () => {}, newTerminal: () => {}, openFiles: () => {} }
  const items = stripMenuKeys({ canBrowse: true, canTerminal: true, canFiles: true }).map(key => menuItemFor(key, actions, 's'))
  const tree = PanelMenu({ items, className: 'bt-ptab-new', 'aria-label': 'More' })
  const [button] = find(tree, node => node.type === 'button' && node.props?.className === 'bt-ptab-new')
  assert.equal(button.props['aria-label'], 'More')
  assert.equal(button.props['aria-haspopup'], 'menu')
  const labels = find(tree, node => node.props?.role === 'menuitem').map(node => node.children.flat(Infinity).at(-1)?.children?.[0])
  assert.deepEqual([...labels], ['New browser tab', 'Side chat', 'Terminal', 'Files'])
  assert.equal(find(tree, node => node.props?.className === 'bt-pmenu-sep').length, 1)
})

test('an empty list renders no button', () => {
  assert.equal(PanelMenu({ items: [], className: 'bt-round', 'aria-label': 'More' }), null)
})
