import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(new URL('../../package.json', import.meta.url))
const { build } = require('esbuild')
const boardPath = fileURLToPath(new URL('../../src/client/task-board.js', import.meta.url))

const loadTaskBoardHelpers = async () => {
  const shim = {
    name: 'board-unit-shim',
    setup(b) {
      b.onResolve({ filter: /^(react|react-dom|\.\/api\.js|\.\/i18n\.js)$/ }, args => ({ path: args.path, namespace: 'shim' }))
      b.onLoad({ filter: /.*/, namespace: 'shim' }, args => {
        if (args.path === 'react') {
          return { contents: 'export const createElement = () => null; export function useEffect() {} export function useLayoutEffect() {} export function useCallback(fn) { return fn } export function useRef() { return { current: null } } export function useState(v) { return [typeof v === "function" ? v() : v, () => {}] }' }
        }
        if (args.path === 'react-dom') return { contents: 'export const createPortal = () => null; export const flushSync = fn => fn()' }
        if (args.path.endsWith('i18n.js')) return { contents: 'export const dateLocale = () => "zh-CN"; export const hostText = x => x; export const t = x => x' }
        return { contents: 'export const call = async () => ({})' }
      })
    },
  }
  const bundled = await build({
    entryPoints: [boardPath],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    plugins: [shim],
  })
  const encoded = Buffer.from(bundled.outputFiles[0].text, 'utf8').toString('base64')
  return import(`data:text/javascript;base64,${encoded}`)
}

test('task-board mention helpers match bot candidates, extract segments and ignore email addresses', async () => {
  const { mentionableActors, activeMentionQuery, filterMentionCandidates, commentTextSegments, TASK_BOARD_CSS } = await loadTaskBoardHelpers()
  const actors = [
    { id: 'user', name: 'You' },
    { id: 'fe', name: '前端开发', role: 'Frontend' },
    { id: 'api', name: 'API中间件工程师', role: 'API' },
    { id: 'qa', name: '测试工程师', role: 'QA' },
  ]
  assert.deepEqual(mentionableActors(actors).map(a => a.id), ['fe', 'api', 'qa'])

  assert.deepEqual(activeMentionQuery('请 @前', 4), { start: 2, end: 4, query: '前' })
  assert.equal(activeMentionQuery('test@example.com ', 17), null)
  assert.equal(activeMentionQuery('hello', 5), null)

  assert.deepEqual(filterMentionCandidates(actors, 'api').map(a => a.id), ['api'])
  assert.deepEqual(filterMentionCandidates(actors, 'frontend').map(a => a.id), ['fe'])
  assert.deepEqual(filterMentionCandidates(actors, '').map(a => a.id), ['fe', 'api', 'qa'])
  // Completed "@Name " closes popup when no candidate matches the trailing space.
  assert.deepEqual(filterMentionCandidates(actors, '前端开发 '), [])

  const segs = commentTextSegments('请 @API中间件工程师 看一下，顺便同步 @前端开发', actors)
  assert.deepEqual(segs.map(s => [s.type, s.text, s.bot?.id]), [
    ['text', '请 ', undefined],
    ['mention', '@API中间件工程师', 'api'],
    ['text', ' 看一下，顺便同步 ', undefined],
    ['mention', '@前端开发', 'fe'],
  ])

  assert.match(TASK_BOARD_CSS, /\.bt-board-mention/)
  assert.match(TASK_BOARD_CSS, /\.bt-mention-menu/)
})
