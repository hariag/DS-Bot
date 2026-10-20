import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, parse } from 'node:path'
import { test } from 'node:test'
import { copyData, moveProblem } from '../src/move-data.mjs'

const write = (path, text) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

// The app's data with a team, a chat and a key, plus what stays behind: the engine's lock and
// the temporary folders of a first-run copy and check that were cut short.
function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'ds-bot-move-'))
  t.after(() => { rmSync(root, { recursive: true, force: true, maxRetries: 5 }) })
  const from = join(root, 'data')
  write(join(from, 'bot', 'state.json'), '{"bots":{"a":{}}}')
  write(join(from, 'bot', 'state.lock'), '{}')
  write(join(from, 'sessions', 'g', 's1', 'log.jsonl'), 'chat')
  write(join(from, '.credentials.yaml'), 'key: test')
  write(join(from, '.import-12', 'bot', 'state.json'), '{}')
  write(join(from, '.import-check-34', 'check.json'), '[]')
  return { root, from }
}

const files = (dir) => {
  const found = []
  const walk = (at, prefix) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(at, entry.name), `${prefix}${entry.name}/`)
      else found.push(`${prefix}${entry.name}`)
    }
  }
  walk(dir, '')
  return found.sort()
}

test('the new data location is an empty or new folder apart from the data, the team workspace, DSH and the program', (t) => {
  const { root, from } = setup(t)
  const places = { from, workspace: join(root, 'work'), dshHome: join(root, 'dsh'), program: join(root, 'program') }
  const problem = to => moveProblem({ ...places, to })
  assert.equal(problem(join(root, 'new')), undefined)
  mkdirSync(join(root, 'empty'))
  assert.equal(problem(join(root, 'empty')), undefined)
  assert.equal(problem(parse(root).root), 'drive')
  assert.equal(problem(from), 'nested')
  assert.equal(problem(join(from, 'inside')), 'nested')
  assert.equal(problem(root), 'nested')
  assert.equal(problem(join(root, 'work', 'data')), 'workspace')
  assert.equal(moveProblem({ ...places, workspace: join(root, 'new', 'work'), to: join(root, 'new') }), 'workspace')
  assert.equal(problem(join(root, 'dsh', 'data')), 'dsh')
  assert.equal(moveProblem({ ...places, dshHome: join(root, 'new', '.dsh'), to: join(root, 'new') }), 'dsh')
  assert.equal(problem(join(root, 'program', 'data')), 'program')
  write(join(root, 'full', 'note.txt'), 'x')
  assert.equal(problem(join(root, 'full')), 'notEmpty')
  assert.equal(problem(join(root, 'full', 'note.txt')), 'notEmpty')
})

test('the data is copied whole, without the lock and the temporary folders, and the old folder stays', async (t) => {
  const { root, from } = setup(t)
  const before = files(from)
  for (const to of [join(root, 'new', 'data'), join(root, 'empty')]) {
    mkdirSync(join(root, 'empty'), { recursive: true })
    await copyData(from, to)
    assert.deepEqual(files(to), ['.credentials.yaml', 'bot/state.json', 'sessions/g/s1/log.jsonl'])
    assert.equal(readFileSync(join(to, 'sessions', 'g', 's1', 'log.jsonl'), 'utf8'), 'chat')
    assert.deepEqual(readdirSync(dirname(to)).filter(name => name.includes('.moving-')), [])
  }
  assert.deepEqual(files(from), before)
})

test('a copy that is stopped or fails leaves no new folder and no staging folder', async (t) => {
  const { root, from } = setup(t)
  const to = join(root, 'new')
  const stopped = new AbortController()
  stopped.abort()
  await assert.rejects(copyData(from, to, stopped.signal), { name: 'AbortError' })
  // Stopped part way through, after some files are copied.
  let seen = 0
  const midway = new AbortController()
  const signal = { throwIfAborted: () => { if (++seen === 4) midway.abort(); midway.signal.throwIfAborted() } }
  await assert.rejects(copyData(from, to, signal), { name: 'AbortError' })
  assert.ok(seen >= 4)
  assert.equal(existsSync(to), false)
  assert.deepEqual(readdirSync(root).filter(name => name.includes('.moving-')), [])
})

test('a staging folder that a killed copy left behind goes before the next copy', async (t) => {
  const { root, from } = setup(t)
  write(join(root, '.new.moving-1', 'bot', 'state.json'), '{}')
  await copyData(from, join(root, 'new'))
  assert.deepEqual(readdirSync(root).sort(), ['data', 'new'])
})
