import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { createIsolatedRedoJournal } from '../../src/host/original-redo-journal.mjs'
import { isolatedRedoConfirmation, userRedoIdentity } from '../../src/host/user-redo-journal.mjs'

const [home, stage] = process.argv.slice(2), statePath = join(home, 'state.json')
const operationId = 'bb5b1723-7063-4e3e-b27e-12f44dd0033d', recoveryId = 'a'.repeat(64)
const scope = { kind:'room', id:'room' }, principal = { kind:'user', id:'user' }, target = { cwd:home, provider:'p', model:'m' }
const original = { id:'source', role:'user', source:{ kind:'bot', role:'request' }, content:[{ type:'text', text:'private synthetic task' }] }
const proof = { complete:true, durability:'target-writer-v1', recoveryId, botId:'bot', sessionId:'old', turn:4, messageSeq:12,
  message:original, isCurrent:() => true }
const state = JSON.parse(await readFile(statePath, 'utf8'))
const rt = { home, statePath, state, requireHomeLock() {}, homeLockVersion:() => 1, async save() { await writeFile(statePath, JSON.stringify(state)) } }
let resultEvidence
const journal = createIsolatedRedoJournal(rt, { authorize:() => true, proveOriginal:async () => proof, validateBinding:() => true, verifyResult:async () => resultEvidence })
if (stage === 'prepare') {
  const confirmationDigest = isolatedRedoConfirmation(scope, recoveryId, proof, { principal, operationId, target })
  await journal.prepare({ operationId, recoveryId, scope, principal, target, confirmationDigest, acknowledged:true })
  process.stdout.write('prepared\n')
} else if (stage === 'dispatch' || stage === 'claim' || stage === 'completed') {
  const dispatched = await journal.beginDispatch(operationId, principal)
  if (dispatched.perform !== true) process.exit(7)
  const turn = { turn:1, turnStartSeq:9 }
  if (stage === 'claim' || stage === 'completed') journal.markClaimingSync(dispatched.binding, turn, principal)
  if (stage === 'completed') {
    const identity = userRedoIdentity(operationId), text = 'synthetic result'
    resultEvidence = { durability:'target-writer-v1', sessionId:identity.sessionId, messageId:identity.messageId,
      admissionId:identity.admissionId, turn, throughSeq:20, text, resultDigest:createHash('sha256').update(text).digest('hex'),
      resultRef:{ kind:'session-events', sessionId:identity.sessionId, firstSeq:12, lastSeq:12 }, isCurrent:() => true }
    await journal.recordResult(operationId, principal)
  }
  process.kill(process.pid, 'SIGKILL')
} else if (stage === 'recover-result') {
  const result = await journal.readResult(operationId, principal)
  process.stdout.write(`${result.text}\n`)
} else if (stage === 'recover') {
  const result = await journal.beginDispatch(operationId, principal)
  process.stdout.write(`${result.state}\n`)
} else process.exit(8)
