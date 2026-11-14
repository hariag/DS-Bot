import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

function worker(home, stage) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', './test/harness-resolve.mjs', './test/board-host/redo-crash-worker.fixture.mjs', home, stage], { cwd:process.cwd(), env:process.env })
    let stdout = '', stderr = ''
    child.stdout.on('data', data => { stdout += data })
    child.stderr.on('data', data => { stderr += data })
    child.once('error', reject)
    child.once('exit', (code, signal) => resolve({ code, signal, stdout, stderr }))
  })
}
for (const stage of ['dispatch', 'claim']) {
  test(`actual process death after durable ${stage} is not retried`, async t => {
    const home = await mkdtemp(join(tmpdir(), 'redo-process-crash-'))
    t.after(() => rm(home, { recursive:true, force:true }))
    await writeFile(join(home, 'state.json'), JSON.stringify({ version:1 }), { mode:0o600 })
    const prepared = await worker(home, 'prepare')
    assert.equal(prepared.code, 0, prepared.stderr)
    assert.equal(prepared.stdout.trim(), 'prepared')
    const died = await worker(home, stage)
    assert.equal(died.signal, 'SIGKILL', died.stderr)
    const recovery = await worker(home, 'recover')
    assert.equal(recovery.code, 0, recovery.stderr)
    assert.equal(recovery.stdout.trim(), 'unknown')
    const state = await readFile(join(home, 'state.json'), 'utf8')
    assert.doesNotMatch(state, /private synthetic task/)
  })
}
