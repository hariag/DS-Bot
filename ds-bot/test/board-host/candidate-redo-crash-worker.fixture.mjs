import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createIsolatedCandidateRedoJournal } from '../../src/host/original-redo-journal.mjs'
import { createLegacyRedoCandidate } from '../../src/host/user-redo-legacy-candidate.mjs'
import { candidateRedoConfirmation } from '../../src/host/candidate-redo-confirmation.mjs'

const [home, stage] = process.argv.slice(2), statePath = join(home, 'state.json')
const operationId = 'bb5b1723-7063-4e3e-b27e-12f44dd0033d', recoveryId = 'a'.repeat(64)
const scope = { kind:'room', id:'room' }, principal = { kind:'user', id:'user' }, target = { cwd:home, provider:'p', model:'m' }
const message = { id:'msg', role:'user', source:{ kind:'bot', role:'request', exchangeId:'ex', senderSessionId:'sender', roomId:'room' }, content:[{ type:'text', text:'private synthetic candidate' }] }
const event = (seq, type, data, time) => ({ seq, type, data, ...(time === undefined ? {} : { time }) })
const events = [event(0,'agent/inbox/spliced',{ target:'next-turn', start:0, removedCount:0, inserted:[message] }),
  event(1,'turn/start',{ turn:5 },123456), event(2,'agent/inbox/spliced',{ target:'next-turn', start:0, removedCount:1, inserted:[] }),
  event(3,'user/message',message), event(4,'turn/end',{ turn:5, reason:{ kind:'interrupted' } })]
const session = { id:'source', seq:events.length, header:{ id:'source', version:4 }, inheritedEventCount:0, eventAt:i => events[i] }
const reader = { id:'source', header:{ ...session.header, delegationDepth:0 }, inheritedEventCount:0,
  read:async () => ({ events:structuredClone(events) }), close:async () => {} }
const writer = { flushLiveSession:async () => {}, open:async () => reader }
const record = { botId:'bot', since:123456, roomId:'room', trigger:{ role:'request', exchangeId:'ex', senderSessionId:'sender', roomId:'room' } }
const state = JSON.parse(await readFile(statePath, 'utf8'))
const rt = { home, statePath, state, ctx:{ sessions:{ get:() => session }, get:() => writer },
  requireHomeLock() {}, homeLockVersion:() => 1, async save() { await writeFile(statePath, JSON.stringify(state)) },
  recoveryHeldOriginal:async () => ({ sessionId:'source', record, isCurrent:() => true }) }
const candidateReader = createLegacyRedoCandidate(rt)
const journal = createIsolatedCandidateRedoJournal(rt, { candidateReader, authorize:() => true, validateBinding:() => true })
if (stage === 'prepare') {
  const evidence = await candidateReader.inspectEvidence(scope, recoveryId)
  const confirmationDigest = candidateRedoConfirmation(scope, recoveryId, evidence, { principal, operationId, target })
  await journal.prepare({ operationId, recoveryId, scope, principal, target, confirmationDigest, acknowledged:true })
  process.stdout.write('prepared\n')
} else if (stage === 'dispatch' || stage === 'claim') {
  const dispatched = await journal.beginDispatch(operationId, principal)
  if (dispatched.perform !== true) process.exit(7)
  if (stage === 'claim') journal.markClaimingSync(dispatched.binding, { turn:1, turnStartSeq:9 }, principal)
  process.kill(process.pid, 'SIGKILL')
} else if (stage === 'recover') {
  const result = await journal.beginDispatch(operationId, principal)
  process.stdout.write(`${result.state}\n`)
} else process.exit(8)
