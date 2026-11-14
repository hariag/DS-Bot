import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

function worker(home, stage, candidate = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', './test/harness-resolve.mjs', candidate ? './test/board-host/candidate-redo-crash-worker.fixture.mjs' : './test/board-host/redo-crash-worker.fixture.mjs', home, stage], { cwd:process.cwd(), env:process.env })
    let stdout = '', stderr = ''
    child.stdout.on('data', data => { stdout += data })
    child.stderr.on('data', data => { stderr += data })
    child.once('error', reject)
    child.once('exit', (code, signal) => resolve({ code, signal, stdout, stderr }))
  })
}
for (const candidate of [false, true]) for (const stage of ['dispatch', 'claim']) {
  test(`actual process death after ${candidate ? 'candidate ' : ''}durable ${stage} is not retried`, async t => {
    const home = await mkdtemp(join(tmpdir(), 'redo-process-crash-'))
    t.after(() => rm(home, { recursive:true, force:true }))
    await writeFile(join(home, 'state.json'), JSON.stringify({ version:1 }), { mode:0o600 })
    const prepared = await worker(home, 'prepare', candidate)
    assert.equal(prepared.code, 0, prepared.stderr)
    assert.equal(prepared.stdout.trim(), 'prepared')
    const died = await worker(home, stage, candidate)
    assert.equal(died.signal, 'SIGKILL', died.stderr)
    const recovery = await worker(home, 'recover', candidate)
    assert.equal(recovery.code, 0, recovery.stderr)
    assert.equal(recovery.stdout.trim(), 'unknown')
    const state = await readFile(join(home, 'state.json'), 'utf8')
    assert.doesNotMatch(state, /private synthetic (task|candidate)/)
  })
}


for (const candidate of [false, true]) {
  test(`durable ${candidate ? 'candidate ' : ''}result survives actual process death without replay`, async t => {
    const home = await mkdtemp(join(tmpdir(), 'redo-result-crash-'))
    t.after(() => rm(home, { recursive:true, force:true }))
    await writeFile(join(home, 'state.json'), JSON.stringify({ version:1 }), { mode:0o600 })
    const prepared = await worker(home, 'prepare', candidate)
    assert.equal(prepared.code, 0, prepared.stderr)
    const died = await worker(home, 'completed', candidate)
    assert.equal(died.signal, 'SIGKILL', died.stderr)
    const result = await worker(home, 'recover-result', candidate)
    assert.equal(result.code, 0, result.stderr)
    assert.equal(result.stdout.trim(), 'synthetic result')
    const again = await worker(home, 'recover', candidate)
    assert.equal(again.stdout.trim(), 'unknown')
  })
}
