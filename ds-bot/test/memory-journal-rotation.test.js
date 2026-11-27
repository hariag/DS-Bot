import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

async function setupTeam(t, config = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-mem-rotate-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))
  writeFileSync(join(home, 'state.json'), JSON.stringify({
    version: 1,
    mainBotIds: ['b1'],
    bots: {
      b1: { id: 'b1', name: 'Writer', sessionId: 'b1', model: 'deepseek/v4' },
      p1: { id: 'p1', name: 'Secret', sessionId: 'p1', private: true, workDir: join(home, 'priv-p1'), model: 'deepseek/v4' },
    },
    privateArchives: [],
    rooms: {},
    agents: {},
    exchanges: [],
    exchangeTurns: {},
    questions: {},
    prefs: {},
    revision: 0,
  }))

  const ctx = fakeContext()
  Object.assign(ctx, {
    llm: {
      listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
      listModels: async () => [{ id: 'v4' }],
      resolveModelInfo: async () => ({}),
    },
    sessionController: {
      resolveAgent: async sessionId => ({ agent: { session: { id: sessionId, seq: 1 } } }),
      selectModel: async () => {},
      page: async () => ({ records: [], hasMore: false }),
    },
    sessions: { messageProjections: [], get: () => undefined },
    workspaceRegistry: { archiveSession: async () => {} },
  })

  const rt = createRuntime(ctx, {
    home,
    memoryReview: false,
    memoryJournalMaxActiveBytes: 400,
    memoryJournalKeepTailRows: 2,
    memoryJournalMaxShardRows: 6,
    ...config,
  })
  await rt.load()
  t.after(() => ctx.dispose())
  return { home, rt, execute: ctx.listeners.get('tools/execute')[0] }
}

test('memory journal rotates into SQLite shards, supports paginated memoryHistory and memoryRestore across shards', async (t) => {
  const { home, rt } = await setupTeam(t)
  for (let i = 1; i <= 15; i += 1) {
    await rt.memoryAdd({ botId: 'b1', text: `Fact number ${i} with enough detail for rotation testing ${'a'.repeat(40)}` })
  }

  const hotPath = join(home, 'memory', 'journal.jsonl')
  const shardsDir = `${hotPath}.shards`
  const hotLines = readFileSync(hotPath, 'utf8').trim().split('\n').filter(Boolean)
  assert.equal(hotLines.length, 2)
  const shardFiles = readdirSync(shardsDir).filter(name => name.endsWith('.sqlite'))
  assert.ok(shardFiles.length >= 2)

  // Verify sharded SQLite rows have no -wal/-shm sidecars.
  assert.equal(readdirSync(shardsDir).some(n => n.endsWith('-wal') || n.endsWith('-shm')), false)

  // Inspect oldest row in first shard to verify persistence.
  const firstDb = new DatabaseSync(join(shardsDir, shardFiles.sort()[0]), { readOnly: true })
  const count = firstDb.prepare('SELECT count(*) AS n FROM rows').get().n
  firstDb.close()
  assert.ok(count > 0)

  // History lists newest-first across hot tail + shards, even past shard boundaries.
  const page1 = await rt.memoryEndpoint('memory-history', { botId: 'b1' })
  assert.equal(page1.rows.length, 15)
  assert.match(page1.rows[0].text, /^Fact number 15/)
  assert.match(page1.rows.at(-1).text, /^Fact number 1 /)

  // Restore (undo) an entry stored inside the oldest SQLite shard.
  const oldestId = page1.rows.at(-1).id
  await rt.memoryEndpoint('memory-restore', { botId: 'b1', id: oldestId })

  const afterRestore = await rt.memoryEndpoint('memory-history', { botId: 'b1' })
  assert.equal(afterRestore.rows.find(r => r.id === oldestId)?.restored, true)
  await assert.rejects(rt.memoryEndpoint('memory-restore', { botId: 'b1', id: oldestId }), /already restored/)
})

test('private Bot journal rotates strictly inside its own folder and remains blocked from other Bots by privacy guard', async (t) => {
  const { home, rt, execute } = await setupTeam(t)
  for (let i = 1; i <= 8; i += 1) {
    await rt.memoryAdd({ botId: 'p1', text: `Private secret fact ${i} ${'z'.repeat(60)}` })
  }
  const privShardsDir = join(home, 'memory', 'bots', 'p1', 'journal.jsonl.shards')
  assert.ok(readdirSync(privShardsDir).some(n => n.endsWith('.sqlite')))

  // Non-private Bot b1 cannot read p1's private journal shards or shared journal shards.
  const sharedShard = join(home, 'memory', 'journal.jsonl.shards', 'manifest.json')
  await assert.rejects(
    execute({ name: 'read', agent: { id: 'b1', session: { id: 'b1' } }, arguments: { file_path: join(privShardsDir, 'manifest.json') } }, async () => ({ ran: true })),
    /private Bot/,
  )
  await assert.rejects(
    execute({ name: 'read', agent: { id: 'b1', session: { id: 'b1' } }, arguments: { file_path: sharedShard } }, async () => ({ ran: true })),
    /private Bot/,
  )
})
