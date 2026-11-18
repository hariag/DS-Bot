import test from 'node:test'
import assert from 'node:assert/strict'
import { rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { openTaskStore } from '../../src/host/task-store.mjs'
import { describePrivateTempAcl, privateTempDir } from '../private-temp.mjs'
import { stoppedBeforeSuccess } from '../process-stop.mjs'

const hex = 'a'.repeat(40)
const opts = { assertWriteLock() {}, authorize() { return true }, verifyRegistration() { return true }, verifyEvidence() { return true }, verifyReceipt() { return true }, verifyInvalidation() { return true }, verifyAttachment() { return true }, verifyAdmission() { return true } }
function managedTempDir(t, prefix) {
  const dir = privateTempDir(join(tmpdir(), prefix)), stores = []
  t.after(() => {
    const closeErrors = []
    for (const store of stores.reverse()) { try { store.close() } catch (error) { closeErrors.push(error.message) } }
    try { rmSync(dir, { recursive:true, force:true }) }
    catch (error) { error.message += `\n${describePrivateTempAcl(dir)}\nclose errors: ${closeErrors.join(' | ') || 'none'}`; throw error }
  })
  return { dir, trackStore:store => { stores.push(store); return store } }
}
function fixture(t, options = opts) {
  const { dir, trackStore } = managedTempDir(t, 'dsbot-task-test-')
  const path = join(dir, 'store.sqlite')
  const store = trackStore(openTaskStore(path, options))
  return { path, store, trackStore }
}
const task = (id, dependencies = []) => ({ id, title: `task ${id}`, scope: 'personal:user', owner: 'owner', reviewer: 'reviewer', acceptance: 'independent acceptance', dependencies })
const create = (s, id, deps = []) => s.create({ operationId: `create-${id}`, actor: 'user', task: task(id, deps) })
const command = (s, id, type, actor, value, op = `${type}-${id}`) => s.command({ operationId: op, taskId: id, expectedRevision: s.get(id).revision, actor, type, ...(value !== undefined ? { value } : {}) })
const register = (s, id) => command(s, id, 'register', 'user', { kind: 'personal', reference: 'owner approval' })
const evidence = { kind: 'git', evidence: 'artifact', targetCommit: hex, targetBlob: hex, acceptanceBlob: hex, environment: 'test' }

test('version history preserves before and after across restart without exposing unrelated metadata', t => {
  const {store, path, trackStore} = fixture(t)
  create(store, 'history')
  command(store, 'history', 'card-details', 'user', {description:'Original'})
  command(store, 'history', 'card-details', 'user', {description:'Changed'}, 'changed')
  store.close(); const reopened = trackStore(openTaskStore(path, opts))
  const history = reopened.history('history')
  assert.equal(history.entries[0].before.description, 'Original')
  assert.equal(history.entries[0].after.description, 'Changed')
  assert.equal(history.entries[0].after.revision, 3)
  assert.equal(history.entries[0].after.authority, undefined)
  assert.equal(history.truncated, false)
})

test('card details persist with CAS and idempotency without completing dependencies', t => {
  const { store, path, trackStore } = fixture(t)
  create(store, 'card'); create(store, 'dependent', ['card']); register(store, 'dependent')
  const value = { description:'Notes\nwith details', dueDate:'2028-02-29', labels:['Urgent', '后端'], checklist:[{id:'item-1', text:'Verify', checked:true}] }
  const input = { operationId:'details-1', taskId:'card', expectedRevision:1, actor:'user', type:'card-details', value }
  const result = store.command(input)
  assert.equal(result.status, 'proposed'); assert.deepEqual(result.checklist, value.checklist)
  assert.deepEqual(store.command(input), result)
  assert.throws(() => store.command({ ...input, value:{ ...value, description:'changed' } }), /operation id conflict/)
  assert.throws(() => store.command({ ...input, operationId:'stale' }), /revision conflict/)
  assert.equal(store.get('dependent').status, 'waiting')
  assert.equal(store.listActions('card').length, 0)
  command(store, 'card', 'card-details', 'user', { dueDate:null, labels:[] }, 'details-2')
  store.close(); const reopened = trackStore(openTaskStore(path, opts))
  const saved = reopened.get('card')
  assert.equal(saved.description, value.description); assert.equal(saved.dueDate, null)
  assert.deepEqual(saved.labels, []); assert.deepEqual(saved.checklist, value.checklist)
  assert.equal(reopened.get('dependent').status, 'waiting')
})

test('card details reject malformed or oversized fields without partial writes', t => {
  const { store } = fixture(t); create(store, 'card')
  const bad = [
    {}, { dueDate:'2027-02-29' }, { dueDate:'tomorrow' }, { description:'x'.repeat(8193) },
    { labels:['same', 'same'] }, { labels:Array(21).fill('a') }, { labels:['x'.repeat(41)] },
    { checklist:[{id:'x',text:'a',checked:true},{id:'x',text:'b',checked:false}] },
    { checklist:[{id:'x',text:'a',checked:'yes'}] }, { checklist:[{id:'x',text:' ',checked:false}] },
    { description:'would save', unrelated:true },
  ]
  for (const [index, value] of bad.entries()) assert.throws(() => command(store, 'card', 'card-details', 'user', value, `bad-details-${index}`))
  assert.equal(store.get('card').revision, 1)
  assert.equal(store.get('card').description, undefined)
})

test('personal progress is durable, scoped and never completes a dependency', t => {
  const { store, path, trackStore } = fixture(t)
  const mine = { ...task('mine'), owner:'user', reviewer:'reviewer' }
  store.create({ operationId:'create-mine', actor:'user', task:mine })
  create(store, 'dependent', ['mine']); register(store, 'dependent')
  const input = { operationId:'move-mine', taskId:'mine', expectedRevision:1, actor:'user', type:'personal-progress', value:{progress:'finished'} }
  const result = store.command(input)
  assert.equal(result.personalProgress, 'finished'); assert.equal(result.status, 'proposed')
  assert.deepEqual(store.command(input), result)
  assert.throws(() => store.command({ ...input, value:{progress:'doing'} }), /operation id conflict/)
  assert.equal(store.get('dependent').status, 'waiting')
  assert.equal(store.listActions('mine').length, 0)
  assert.throws(() => store.command({ ...input, operationId:'stale', value:{progress:'doing'} }), /revision conflict/)
  assert.throws(() => command(store, 'mine', 'personal-progress', 'reviewer', {progress:'doing'}), /personal progress unavailable/)
  create(store, 'bot')
  assert.throws(() => command(store, 'bot', 'personal-progress', 'user', {progress:'doing'}), /personal progress unavailable/)
  assert.throws(() => command(store, 'mine', 'personal-progress', 'user', {progress:'done'}), /invalid personal progress/)
  store.close(); const reopened = trackStore(openTaskStore(path, opts))
  assert.equal(reopened.get('mine').personalProgress, 'finished'); assert.equal(reopened.get('mine').status, 'proposed')
  assert.equal(reopened.get('dependent').status, 'waiting')
})

test('personal progress can be selected atomically at creation without scheduling work', t => {
  const {store, path, trackStore} = fixture(t)
  const input = {operationId:'create-doing', actor:'user', task:{...task('doing'), owner:'user', personalProgress:'doing'}}
  const created = store.create(input)
  assert.equal(created.personalProgress, 'doing'); assert.equal(created.status, 'proposed')
  assert.deepEqual(store.create(input), created); assert.equal(store.listActions(created.id).length, 0)
  assert.throws(() => store.create({...input, operationId:'bad', task:{...input.task, id:'bad', scope:'room:group'}}), /personal progress/)
  assert.throws(() => store.create({...input, operationId:'bad2', task:{...input.task, id:'bad2', owner:'bot'}}), /personal progress/)
  store.close(); const reopened = trackStore(openTaskStore(path, opts))
  assert.equal(reopened.get('doing').personalProgress, 'doing')
})
const intentFor = action => ({ admissionId:`admission-${action.id}`, messageId:`message-${action.id}`, targetBotId:action.actor, targetSessionId:`session-${action.actor}`, payload:{ id:`message-${action.id}`, role:'user', content:[{type:'text',text:'work'}], source:{kind:'bot',exchangeId:`admission-${action.id}`} } })
const claim = (store, action, intent = intentFor(action)) => store.claimAction({ actionId:action.id, actor:'scheduler', intent })
function accept(s, id, kind) {
  const a = s.listActions(id).find(x => x.kind === kind && x.state === 'pending')
  assert.ok(a); claim(s, a); s.markAction({ actionId: a.id, actor: 'host', expectedState: 'claimed', state: 'accepted', receipt: 'verified' })
  return a
}
function finish(s, id) {
  accept(s, id, 'execute'); command(s, id, 'start', 'owner'); command(s, id, 'report', 'owner', evidence)
  accept(s, id, 'review'); command(s, id, 'review', 'reviewer', { evidence: 'independent review', result: 'pass' })
}

test('card details do not disrupt an already accepted work and its independent review', t => {
  const { store } = fixture(t); create(store, 'active'); register(store, 'active')
  accept(store, 'active', 'execute'); command(store, 'active', 'start', 'owner')
  const before = store.get('active')
  const updated = command(store, 'active', 'card-details', 'user', { checklist:[{id:'check',text:'Review facts',checked:true}] })
  assert.equal(updated.status, 'working'); assert.equal(updated.actionRevision, before.actionRevision)
  command(store, 'active', 'report', 'owner', evidence)
  accept(store, 'active', 'review'); command(store, 'active', 'review', 'reviewer', { evidence:'independent review', result:'pass' })
  assert.equal(store.get('active').status, 'done')
})

test('editing running work creates one separate change proposal with an immutable baseline', t => {
  const {store, path, trackStore} = fixture(t); create(store, 'active'); register(store, 'active')
  accept(store, 'active', 'execute'); command(store, 'active', 'start', 'owner')
  const old = store.get('active')
  const value = {title:'Changed', owner:old.owner, reviewer:old.reviewer, acceptance:'New acceptance', dependencies:[], dependencyGrants:[], description:'New description'}
  const input = {operationId:'change-op', actor:'user', taskId:old.id, expectedRevision:old.revision, value}
  const proposal = store.proposeChange(input)
  assert.deepEqual(store.proposeChange(input), proposal)
  assert.equal(store.get('active').title, old.title)
  assert.equal(store.get('active').status, 'working')
  assert.equal(proposal.status, 'waiting'); assert.deepEqual(proposal.dependencies, ['active'])
  assert.equal(typeof proposal.position, 'string'); assert.ok(proposal.position > store.get('active').position)
  assert.equal(proposal.change.before.acceptance, old.acceptance); assert.equal(proposal.change.after.acceptance, 'New acceptance')
  assert.equal(proposal.change.before.description, ''); assert.equal(proposal.change.after.description, 'New description')
  assert.equal(store.listActions(proposal.id).length, 0)
  assert.throws(() => command(store, proposal.id, 'edit', 'user', {title:'Overwrite'}), /immutable/)
  assert.throws(() => command(store, proposal.id, 'card-details', 'user', {description:'Overwrite'}), /immutable/)
  assert.throws(() => store.proposeChange({...input, operationId:'duplicate'}), /already exists/)
  assert.throws(() => store.proposeChange({...input, operationId:'stale', expectedRevision:old.revision-1}), /revision conflict/)
  command(store, 'active', 'report', 'owner', evidence)
  accept(store, 'active', 'review'); command(store, 'active', 'review', 'reviewer', {evidence:'independent',result:'pass'})
  assert.equal(store.get(proposal.id).status, 'ready')
  assert.equal(store.listActions(proposal.id).filter(action=>action.state==='pending').length, 1)
  store.close(); const reopened = trackStore(openTaskStore(path, opts))
  assert.deepEqual(reopened.get(proposal.id).change, proposal.change)
  assert.deepEqual(reopened.proposeChange(input), proposal)
})

test('delivery and independent review drive dependencies immediately and survive restart', t => {
  const { store, path, trackStore } = fixture(t)
  create(store, 'a'); create(store, 'b', ['a']); register(store, 'a'); register(store, 'b')
  assert.equal(store.get('a').status, 'ready'); assert.equal(store.get('b').status, 'waiting')
  assert.throws(() => command(store, 'a', 'start', 'owner'), /receipt/)
  finish(store, 'a'); assert.equal(store.get('a').status, 'done'); assert.equal(store.get('b').status, 'ready')
  assert.equal(store.listActions('b').filter(x => x.state === 'pending').length, 1)
  const restarted = trackStore(openTaskStore(path, opts))
  assert.equal(restarted.get('a').status, 'done'); assert.equal(restarted.get('b').status, 'ready')
  assert.equal(restarted.operation('review-a').status, 'committed')
})

test('operation id is idempotent, payload conflicts and graph cycles are rejected', t => {
  const { store } = fixture(t)
  const input = { operationId: 'first', actor: 'user', task: task('a') }
  assert.deepEqual(store.create(input), store.create(input))
  assert.throws(() => store.create({ ...input, task: { ...input.task, title: 'changed' } }), /operation id conflict/)
  create(store, 'b', ['a'])
  assert.throws(() => command(store, 'a', 'dependencies', 'user', ['b']), /cycle/)
  assert.equal(store.get('a').revision, 1)
})

test('refresh version advances only for committed changes and survives reopening', t => {
  const { store, path, trackStore } = fixture(t)
  assert.equal(store.version(), 0)
  const input = { operationId: 'versioned-create', actor: 'user', task: task('a') }
  store.create(input)
  const created = store.version(); assert.ok(created > 0)
  store.create(input); assert.equal(store.version(), created)
  assert.throws(() => store.create({ ...input, task: { ...input.task, title: 'conflict' } }), /operation id conflict/)
  assert.equal(store.version(), created)
  register(store, 'a'); assert.ok(store.version() > created)
  const beforeClaim = store.version(), a = store.listActions('a')[0]
  claim(store, a); assert.ok(store.version() > beforeClaim)
  const reopened = trackStore(openTaskStore(path, opts))
  assert.equal(reopened.version(), store.version())
})

test('admission intent is immutable and repeated claim is lookup-only', t => {
  const { store } = fixture(t)
  create(store, 'a'); register(store, 'a')
  const a = store.listActions('a')[0], intent = intentFor(a), first = claim(store, a, intent)
  assert.equal(first.claimedNow, true)
  const version = store.version(), saved = store.admission(a.id)
  assert.equal(saved.messageId, intent.messageId); assert.equal(saved.targetSessionId, intent.targetSessionId); assert.deepEqual(saved.payload, intent.payload)
  assert.equal(claim(store, a, intent).claimedNow, false); assert.equal(store.version(), version)
  assert.throws(() => claim(store, a, { ...intent, targetSessionId:'different-session' }), /intent conflict/)
  assert.throws(() => claim(store, a, { ...intent, payload:{ ...intent.payload, content:[{type:'text',text:'different'}] } }), /intent conflict/)
  assert.throws(() => claim(store, a, { ...intent, messageId:'other-message' }), /invalid admission payload/)
  assert.deepEqual(store.admission(a.id), saved)
  create(store, 'b'); register(store, 'b')
  const b = store.listActions('b')[0]
  const duplicateMessage = intentFor(b); duplicateMessage.messageId = intent.messageId; duplicateMessage.payload.id = intent.messageId
  assert.throws(() => claim(store, b, duplicateMessage), /UNIQUE/)
  assert.equal(store.listActions('b')[0].state, 'pending'); assert.equal(store.admission(b.id), undefined)
})

test('process death after admission intent commit preserves original identity without replay', t => {
  const { dir, trackStore } = managedTempDir(t, 'dsbot-admission-crash-')
  const path = join(dir, 'tasks.sqlite')
  const child = spawnSync(process.execPath, [fileURLToPath(new URL('./admission-crash-child.mjs', import.meta.url)), path], { encoding:'utf8' })
  assert.equal(stoppedBeforeSuccess(child), true, child.stderr)
  const store = trackStore(openTaskStore(path, opts))
  const action = store.listActions('t')[0], saved = store.admission(action.id)
  assert.equal(saved.state, 'claimed'); assert.equal(saved.admissionId, 'admission-1'); assert.equal(saved.targetSessionId, 'session-1')
  const intent = { admissionId:'admission-1', messageId:'message-1', targetBotId:'bot', targetSessionId:'session-1', payload:{ id:'message-1', role:'user', content:[{type:'text',text:'work'}], source:{kind:'bot',exchangeId:'admission-1'} } }
  assert.equal(store.claimAction({ actionId:action.id, actor:'scheduler', intent }).claimedNow, false)
  assert.throws(() => store.claimAction({ actionId:action.id, actor:'scheduler', intent:{ ...intent, targetSessionId:'session-2' } }), /intent conflict/)
})

test('startup converts interrupted admissions to durable uncertainty exactly once', t => {
  const {store,path,trackStore}=fixture(t);create(store,'restart');register(store,'restart')
  const action=store.listActions('restart')[0],intent=intentFor(action);claim(store,action,intent)
  store.markAction({actionId:action.id,actor:'host',expectedState:'claimed',state:'accepted',receipt:'verified'})
  store.close()
  const reopened=trackStore(openTaskStore(path,opts))
  assert.equal(reopened.holdInterruptedAdmissions(),1)
  const held=reopened.admission(action.id)
  assert.equal(held.state,'uncertain');assert.equal(held.admissionId,intent.admissionId);assert.equal(held.messageId,intent.messageId)
  assert.match(held.receipt??reopened.listActions('restart')[0].receipt,/delivery outcome unknown/)
  assert.equal(reopened.holdInterruptedAdmissions(),0)
  assert.equal(reopened.listActions('restart')[0].state,'uncertain')
})

test('pending cancellation is durable, idempotent and does not claim delivery', t => {
  const { store } = fixture(t); create(store, 'a'); register(store, 'a')
  const action = store.listActions('a')[0], before = store.get('a')
  const input = { operationId:'cancel-action-1', actor:'user', actionId:action.id, expectedTaskRevision:before.revision, expectedActionState:'pending', expectedAdmissionId:null, reason:'user stopped work' }
  const result = store.cancelAction(input)
  assert.equal(store.listActions('a')[0].state, 'cancelled'); assert.equal(store.admission(action.id), undefined)
  assert.deepEqual(store.cancelAction(input), result)
  assert.throws(() => store.cancelAction({ ...input, reason:'different' }), /operation id conflict/)
  assert.throws(() => claim(store, action), /unavailable/)
})

test('cancelling a claimed message preserves intent and exact lookup remains unknown', t => {
  const { store } = fixture(t); create(store, 'a'); register(store, 'a')
  const action = store.listActions('a')[0]; claim(store, action)
  const intent = store.admission(action.id), before = store.get('a')
  store.cancelAction({ operationId:'cancel-claimed', actor:'user', actionId:action.id, expectedTaskRevision:before.revision, expectedActionState:'claimed', expectedAdmissionId:intent.admissionId, reason:'user stopped work' })
  const held = store.admission(action.id)
  assert.equal(held.state, 'uncertain'); assert.deepEqual(held.payload, intent.payload)
  const criteria = { admissionId:intent.admissionId, messageId:intent.messageId, targetSessionId:intent.targetSessionId, payloadHash:intent.payloadHash }
  assert.deepEqual(store.inspectAdmission(criteria), { decision:'unknown', actionId:action.id, actionRevision:intent.actionRevision, state:'uncertain' })
  assert.deepEqual(store.inspectAdmission({ ...criteria, targetSessionId:'different' }), { decision:'unknown' })
  assert.deepEqual(store.inspectAdmission({}), { decision:'unknown' })
  assert.equal(claim(store, action).claimedNow, false)
  assert.throws(() => store.markAction({ actionId:action.id, actor:'host', expectedState:'claimed', state:'accepted', receipt:'late' }), /conflict/)
})

test('cancellation and action state roll back together if the home lock is lost', t => {
  let checks = 0, fail = false
  const { store } = fixture(t, { ...opts, assertWriteLock() { if (fail && ++checks === 2) throw new Error('lock lost') } })
  create(store, 'a'); register(store, 'a'); const action = store.listActions('a')[0]
  const input = { operationId:'cancel-failed', actor:'user', actionId:action.id, expectedTaskRevision:store.get('a').revision, expectedActionState:'pending', expectedAdmissionId:null, reason:'user stopped' }
  fail = true; assert.throws(() => store.cancelAction(input), /lock lost/)
  assert.equal(store.listActions('a')[0].state, 'pending'); assert.equal(store.operation('cancel-failed'), undefined)
})

test('process death after cancellation commit retains uncertain intent and decision', t => {
  const { dir, trackStore } = managedTempDir(t, 'dsbot-decision-crash-')
  const path = join(dir, 'tasks.sqlite'), child = spawnSync(process.execPath, [fileURLToPath(new URL('./decision-crash-child.mjs', import.meta.url)), path], { encoding:'utf8' })
  assert.equal(stoppedBeforeSuccess(child), true, child.stderr)
  const store = trackStore(openTaskStore(path, opts))
  const action = store.listActions('t')[0], intent = store.admission(action.id)
  assert.equal(action.state, 'uncertain'); assert.equal(intent.admissionId, 'admission-1'); assert.equal(store.operation('cancel-1').status, 'committed')
  assert.equal(store.inspectAdmission({ admissionId:intent.admissionId, messageId:intent.messageId, targetSessionId:intent.targetSessionId, payloadHash:intent.payloadHash }).decision, 'unknown')
})

test('default host denies authorization and receipt verification', t => {
  const { store } = fixture(t, { assertWriteLock() {} })
  assert.throws(() => create(store, 'a'), /not authorized/)
  assert.equal(store.list().length, 0)
})

test('unverified receipt cannot start work; unknown outcome is never reclaimed', t => {
  const { store } = fixture(t, { ...opts, verifyReceipt(_row, state) { return state === 'uncertain' } })
  create(store, 'a'); register(store, 'a')
  const a = store.listActions('a')[0]; claim(store, a)
  assert.throws(() => store.markAction({ actionId: a.id, actor: 'host', expectedState: 'claimed', state: 'accepted', receipt: 'unverified' }), /unverified/)
  store.markAction({ actionId: a.id, actor: 'host', expectedState: 'claimed', state: 'uncertain', receipt: 'unknown' })
  assert.equal(claim(store, a).claimedNow, false)
  assert.throws(() => command(store, 'a', 'block', 'user', { reason: 'wait', condition: 'resolve', owner: 'owner' }), /unresolved/)
  create(store, 'independent'); assert.equal(register(store, 'independent').status, 'ready')
})

test('stale evidence prevents further dependency work without retrying claimed actions', t => {
  const { store } = fixture(t)
  create(store, 'a'); create(store, 'b', ['a']); register(store, 'a'); register(store, 'b'); finish(store, 'a')
  const action = store.listActions('b')[0]; claim(store, action)
  command(store, 'a', 'invalidate', 'user', { reason: 'target changed', evidence: 'new revision' })
  assert.equal(store.get('a').stale, true); assert.equal(store.get('b').stale, true)
  assert.equal(store.listActions('b')[0].state, 'uncertain')
  assert.equal(claim(store, action).claimedNow, false)
  assert.throws(() => store.markAction({ actionId:action.id, actor:'host', expectedState:'claimed', state:'accepted', receipt:'late' }), /conflict/)
  assert.throws(() => command(store, 'b', 'revalidate', 'reviewer', { evidence: 'updated' }), /cannot revalidate/)
})

test('invalidating a reported task holds its accepted review without deleting its intent', t => {
  const { store } = fixture(t)
  create(store, 'a'); register(store, 'a'); accept(store, 'a', 'execute'); command(store, 'a', 'start', 'owner'); command(store, 'a', 'report', 'owner', evidence)
  const review = accept(store, 'a', 'review'), before = store.admission(review.id)
  command(store, 'a', 'invalidate', 'user', { reason:'target changed', evidence:'new revision' })
  const after = store.admission(review.id)
  assert.equal(after.state, 'uncertain'); assert.equal(after.messageId, before.messageId); assert.deepEqual(after.payload, before.payload)
  assert.throws(() => store.markAction({ actionId:review.id, actor:'host', expectedState:'accepted', state:'uncertain', receipt:'late' }), /conflict/)
})

test('SIGKILL after upstream invalidation preserves uncertain downstream intent', t => {
  const { dir, trackStore } = managedTempDir(t, 'dsbot-invalidate-crash-')
  const path = join(dir, 'tasks.sqlite'), child = spawnSync(process.execPath, [fileURLToPath(new URL('./invalidation-crash-child.mjs', import.meta.url)), path], { encoding:'utf8' })
  assert.equal(stoppedBeforeSuccess(child), true, child.stderr)
  const store = trackStore(openTaskStore(path, opts))
  const action = store.listActions('b')[0], intent = store.admission(action.id)
  assert.equal(action.state, 'uncertain'); assert.equal(store.get('b').stale, true)
  assert.equal(intent.state, 'uncertain'); assert.equal(intent.payload.id, intent.messageId)
  assert.equal(claim(store, action).claimedNow, false)
  assert.throws(() => store.markAction({ actionId:action.id, actor:'host', expectedState:'claimed', state:'accepted', receipt:'late' }), /conflict/)
})

test('malformed payloads are rejected before hashing', t => {
  const { store } = fixture(t)
  assert.throws(() => store.create({ operationId: 'nan', actor: 'user', task: { ...task('a'), extra: NaN } }), /invalid/)
  const cyclic = task('b'); cyclic.extra = cyclic
  assert.throws(() => store.create({ operationId: 'cycle', actor: 'user', task: cyclic }), /invalid/)
  assert.throws(() => store.create({ operationId: 'large', actor: 'user', task: { ...task('c'), title: 'a'.repeat(9000) } }), /too long/)
  assert.equal(store.list().length, 0)
})

test('home lock loss before commit rolls back task and operation together', t => {
  let checks = 0, fail = false
  const { store } = fixture(t, { ...opts, assertWriteLock() { if (fail && ++checks === 2) throw new Error('lock lost') } })
  fail = true
  assert.throws(() => create(store, 'a'), /lock lost/)
  assert.equal(store.get('a'), undefined); assert.equal(store.operation('create-a'), undefined)
  fail = false; assert.equal(create(store, 'a').id, 'a')
})

test('unknown database is never overwritten', t => {
  const { dir } = managedTempDir(t, 'dsbot-task-unknown-')
  const path = join(dir, 'unknown.sqlite'); writeFileSync(path, 'not sqlite', { mode: 0o600 })
  assert.throws(() => openTaskStore(path, opts))
})

test('edits use CAS, preserve admitted work, and responsibility changes require registration', t => {
  const { store } = fixture(t)
  create(store, 'a'); register(store, 'a')
  const initial = store.get('a')
  const fullEdit = { operationId: 'full-edit-a', taskId: 'a', expectedRevision: initial.revision, actor: 'user', type: 'edit', value: { title: 'new full title', owner: initial.owner, reviewer: initial.reviewer, acceptance: initial.acceptance, dependencies: initial.dependencies } }
  const fullResult = store.command(fullEdit)
  assert.equal(fullResult.status, 'ready'); assert.deepEqual(fullResult.authority, initial.authority)
  assert.equal(store.listActions('a').filter(x => x.state === 'pending').length, 1)
  assert.deepEqual(store.command(fullEdit), fullResult)
  const a = accept(store, 'a', 'execute'), before = store.get('a')
  const renamed = command(store, 'a', 'edit', 'user', { title: 'new title' })
  assert.equal(renamed.actionRevision, before.actionRevision)
  assert.equal(store.listActions('a').find(x => x.id === a.id).state, 'accepted')
  assert.throws(() => store.command({ operationId: 'stale-edit', taskId: 'a', expectedRevision: before.revision, actor: 'user', type: 'edit', value: { title: 'stale' } }), /revision conflict/)
  assert.throws(() => command(store, 'a', 'edit', 'user', { owner: 'other' }, 'owner-change'), /reconciliation/)
  assert.equal(command(store, 'a', 'start', 'owner').status, 'working')
  create(store, 'b'); register(store, 'b')
  const changed = command(store, 'b', 'edit', 'user', { owner: 'other' }, 'owner-b')
  assert.equal(changed.status, 'proposed'); assert.equal(changed.authority, null)
  assert.equal(store.listActions('b')[0].state, 'cancelled')
  assert.throws(() => command(store, 'b', 'edit', 'user', { reviewer: 'other' }, 'conflict-b'), /independent/)
})

test('multiple image references require host validation, revision and idempotent operations', t => {
  const { store } = fixture(t, { ...opts, verifyAttachment(_task, item) { return item.id !== 'denied' } })
  create(store, 'a'); register(store, 'a')
  const before = store.get('a'), images = [{ id: 'photo-1', sha256: '1'.repeat(64), mediaType: 'image/png', size: 10, name: 'a.png' }, { id: 'photo-2', sha256: '2'.repeat(64), mediaType: 'image/png', size: 20, name: 'b.png' }]
  const op = { operationId: 'images', taskId: 'a', expectedRevision: before.revision, actor: 'user', type: 'attach', value: { images } }
  assert.equal(store.command(op).attachments.length, 2)
  assert.deepEqual(store.command(op).attachments, images)
  assert.throws(() => store.command({ ...op, value: { images: images.slice(0, 1) } }), /operation id conflict/)
  assert.throws(() => command(store, 'a', 'attach', 'user', { images: [{ ...images[0], id: 'denied' }] }, 'bad-image'), /unverified/)
  assert.throws(() => command(store, 'a', 'attach', 'user', { images: [{ ...images[0], id: 'photo-3', path: '/etc/passwd' }] }, 'bad-path'), /invalid fields/)
  const pending = store.listActions('a').find(x => x.state === 'pending')
  assert.equal(claim(store, pending).targetId, 'owner')
  assert.equal(command(store, 'a', 'remove-image', 'user', { imageId: images[0].id }, 'remove-image').attachments.length, 1)
  assert.equal(command(store, 'a', 'detach', 'user', { ids: [images[1].id] }, 'remove-images').attachments.length, 0)
})

test('a card cover names an attached image, persists and shows in card history', t => {
  const { store, path, trackStore } = fixture(t); create(store, 'card')
  const images = [{ id:'cover-1', sha256:'1'.repeat(64), mediaType:'image/png', size:10, name:'cover.png' }, { id:'photo-2', sha256:'2'.repeat(64), mediaType:'image/png', size:20, name:'other.png' }]
  command(store, 'card', 'attach', 'user', { images })
  const covered = command(store, 'card', 'card-details', 'user', { coverImageId:'cover-1' })
  assert.equal(covered.coverImageId, 'cover-1')
  const history = store.history('card')
  assert.equal(history.entries[0].after.coverImageId, 'cover-1')
  assert.equal(history.entries[0].before.coverImageId, undefined)
  store.close(); const reopened = trackStore(openTaskStore(path, opts))
  assert.equal(reopened.get('card').coverImageId, 'cover-1')
  const cleared = command(reopened, 'card', 'card-details', 'user', { coverImageId:null }, 'clear-cover')
  assert.equal(cleared.coverImageId, null)
  assert.equal(reopened.history('card').entries[0].before.coverImageId, 'cover-1')
  assert.equal(reopened.history('card').entries[0].after.coverImageId, null)
})

test('a card cover must name an image already on the card and only after an upload', t => {
  const { store } = fixture(t); create(store, 'empty')
  const image = { id:'photo-1', sha256:'1'.repeat(64), mediaType:'image/png', size:10, name:'a.png' }
  for (const [index, coverImageId] of ['photo-1', '', 7, ['photo-1']].entries()) {
    assert.throws(() => command(store, 'empty', 'card-details', 'user', { coverImageId }, 'bad-cover-' + index), /invalid card details/)
  }
  command(store, 'empty', 'attach', 'user', { images:[image] })
  assert.throws(() => command(store, 'empty', 'card-details', 'user', { coverImageId:'missing' }, 'unknown-cover'), /invalid card details/)
  assert.throws(() => command(store, 'empty', 'card-details', 'user', { coverImageId:'missing', description:'note' }, 'mixed-cover'), /invalid card details/)
  assert.equal(store.get('empty').coverImageId, undefined)
  assert.equal(store.get('empty').description, undefined)
  const created = store.create({ operationId:'create-null-cover', actor:'user', task:{ ...task('null-cover'), coverImageId:null } })
  assert.equal(created.coverImageId, null)
  assert.throws(() => store.create({ operationId:'create-cover', actor:'user', task:{ ...task('cover'), coverImageId:'photo-1' } }), /invalid card details/)
})

test('removing the image used as a card cover clears the cover and leaves other covers alone', t => {
  const { store, path, trackStore } = fixture(t); create(store, 'card')
  const images = ['photo-1', 'photo-2', 'photo-3'].map((id, index) => ({ id, sha256:String(index + 1).repeat(64), mediaType:'image/png', size:10 + index, name:id + '.png' }))
  command(store, 'card', 'attach', 'user', { images })
  command(store, 'card', 'card-details', 'user', { coverImageId:'photo-1' })
  const removedCover = command(store, 'card', 'remove-image', 'user', { imageId:'photo-1' })
  assert.equal(removedCover.coverImageId, null); assert.deepEqual(removedCover.attachments.map(item => item.id), ['photo-2', 'photo-3'])
  command(store, 'card', 'card-details', 'user', { coverImageId:'photo-2' }, 'cover-two')
  const removedOther = command(store, 'card', 'remove-image', 'user', { imageId:'photo-3' }, 'remove-other')
  assert.equal(removedOther.coverImageId, 'photo-2')
  const detached = command(store, 'card', 'detach', 'user', { ids:['photo-2'] }, 'detach-cover')
  assert.equal(detached.coverImageId, null); assert.deepEqual(detached.attachments, [])
  store.close(); const reopened = trackStore(openTaskStore(path, opts))
  assert.equal(reopened.get('card').coverImageId, null)
  create(reopened, 'plain'); command(reopened, 'plain', 'attach', 'user', { images:[images[0]] })
  command(reopened, 'plain', 'remove-image', 'user', { imageId:'photo-1' })
  assert.equal(Object.hasOwn(reopened.get('plain'), 'coverImageId'), false)
})

test('cross-room grant revocation cancels pending and holds claimed work and transitive dependents', t => {
  const { store } = fixture(t, { ...opts, verifyShare() { return true }, verifyDependency() { return true } })
  const scoped = (id, scope, dependencies = [], dependencyGrants = []) => store.create({ operationId:`create-${id}`, actor:'user', task:{ ...task(id, dependencies), scope, dependencyGrants } })
  scoped('source', 'room:source'); register(store, 'source'); finish(store, 'source')
  const shared = command(store, 'source', 'share', 'user', { targetRoomId:'target', fields:['status'] }), grantId = shared.shares[0].id
  for (const id of ['pending','claimed','done']) { scoped(id, 'room:target', ['source'], [{ taskId:'source', grantId }]); register(store, id) }
  const claimed = store.listActions('claimed').find(action => action.state === 'pending')
  claim(store, claimed)
  finish(store, 'done'); scoped('downstream', 'room:target', ['done']); register(store, 'downstream')
  assert.equal(store.get('downstream').status, 'ready')
  command(store, 'source', 'unshare', 'user', { shareId:grantId })
  assert.equal(store.listActions('pending')[0].state, 'cancelled')
  assert.equal(store.listActions('claimed')[0].state, 'uncertain')
  assert.equal(store.get('done').stale, true); assert.equal(store.get('downstream').stale, true)
  assert.equal(store.listActions('downstream')[0].state, 'cancelled')
  assert.throws(() => store.markAction({ actionId:claimed.id, actor:'host', expectedState:'claimed', state:'accepted', receipt:'late' }), /conflict/)
  assert.equal(claim(store, claimed).claimedNow, false)
})

test('cards receive stable fractional positions and reorder inside one lane', t => {
  const { store, path, trackStore } = fixture(t)
  create(store, 'one'); create(store, 'two'); create(store, 'three')
  const position = id => store.get(id).position
  assert.equal(typeof position('one'), 'string')
  assert.ok(position('one') < position('two') && position('two') < position('three'))
  const moved = command(store, 'three', 'reorder', 'user', { afterId:'one' })
  assert.equal(moved.revision, 2)
  assert.equal(moved.boardActivity.at(-1).type, 'reorder')
  assert.ok(position('one') < moved.position && moved.position < position('two'))
  const input = { operationId:'reorder-three', taskId:'three', expectedRevision:1, actor:'user', type:'reorder', value:{afterId:'one'} }
  assert.deepEqual(store.command(input), moved)
  assert.throws(() => store.command({ ...input, value:{afterId:'two'} }), /operation id conflict/)
  const first = command(store, 'two', 'reorder', 'user', { afterId:null }, 'reorder-two')
  assert.ok(first.position < position('one'))
  assert.throws(() => command(store, 'three', 'reorder', 'user', { afterId:'missing' }, 'bad-after'), /unavailable/)
  assert.throws(() => command(store, 'three', 'reorder', 'user', {}, 'missing-after'), /invalid reorder/)
  assert.throws(() => command(store, 'three', 'reorder', 'user', { afterId:'three' }, 'self-after'), /invalid reorder/)
  create(store, 'ready'); register(store, 'ready')
  assert.throws(() => command(store, 'three', 'reorder', 'user', { afterId:'ready' }, 'cross-lane'), /same lane/)
  assert.equal(store.get('three').revision, 2)
  store.close(); const reopened = trackStore(openTaskStore(path, opts))
  assert.equal(reopened.get('two').position, first.position)
})

test('personal progress accepts afterId and updates order atomically', t => {
  const { store, path, trackStore } = fixture(t)
  const personal = (id, progress) => store.create({ operationId:'create-' + id, actor:'user', task:{ ...task(id), owner:'user', personalProgress:progress } })
  personal('a', 'todo'); personal('b', 'todo'); personal('c', 'doing')
  const moved = command(store, 'b', 'personal-progress', 'user', { progress:'doing', afterId:'c' })
  assert.equal(moved.personalProgress, 'doing')
  assert.ok(moved.position > store.get('c').position)
  assert.equal(moved.boardActivity.at(-1).type, 'personal-progress')
  const first = command(store, 'b', 'personal-progress', 'user', { progress:'doing', afterId:null }, 'personal-first')
  assert.ok(first.position < store.get('c').position)
  assert.throws(() => command(store, 'a', 'personal-progress', 'user', { progress:'finished', afterId:'b' }, 'personal-cross'), /same lane/)
  assert.throws(() => command(store, 'a', 'personal-progress', 'user', { progress:'doing', afterId:'a' }, 'personal-self'), /invalid personal progress/)
  assert.equal(store.get('a').revision, 1)
  store.close(); const reopened = trackStore(openTaskStore(path, opts))
  assert.equal(reopened.get('b').personalProgress, 'doing'); assert.equal(reopened.get('b').position, first.position)
})

test('card due dates accept an optional local time and completion mark', t => {
  const { store } = fixture(t); create(store, 'card')
  const timed = command(store, 'card', 'card-details', 'user', { dueDate:'2028-02-29T23:59', dueComplete:true })
  assert.equal(timed.dueDate, '2028-02-29T23:59'); assert.equal(timed.dueComplete, true)
  const dated = command(store, 'card', 'card-details', 'user', { dueDate:'2028-02-29' }, 'date-only')
  assert.equal(dated.dueDate, '2028-02-29')
  const cleared = command(store, 'card', 'card-details', 'user', { dueDate:null, dueComplete:false }, 'clear-due')
  assert.equal(cleared.dueDate, null); assert.equal(cleared.dueComplete, false)
  const history = store.history('card')
  assert.equal(history.entries[0].after.dueComplete, false)
  assert.equal(history.entries[2].after.dueComplete, true)
  assert.equal(history.entries[2].before.dueComplete, undefined)
  const bad = ['2027-02-29', '2028-02-30', '2028-00-01', '2028-13-01', '2028-01-00', '2028-02-29T24:00', '2028-02-29T12:60', '2028-02-29T1:00', '2028-2-9', 'tomorrow', '2028-02-29T12:00:00', '']
  for (const [index, dueDate] of bad.entries()) assert.throws(() => command(store, 'card', 'card-details', 'user', { dueDate }, 'bad-due-' + index), /invalid card details/)
  assert.throws(() => command(store, 'card', 'card-details', 'user', { dueComplete:'yes' }, 'bad-complete'), /invalid card details/)
  assert.equal(store.get('card').revision, 4)
})

test('create accepts card presentation fields with card-details validation', t => {
  const { store } = fixture(t)
  const value = { ...task('card'), description:'Prefilled', dueDate:'2028-02-29T09:30', dueComplete:true, labels:[' Urgent '], checklist:[{id:'check', text:' Inspect ', checked:true}] }
  const created = store.create({ operationId:'create-card', actor:'user', task:value })
  assert.equal(created.description, 'Prefilled'); assert.equal(created.dueDate, '2028-02-29T09:30'); assert.equal(created.dueComplete, true)
  assert.deepEqual(created.labels, ['Urgent']); assert.deepEqual(created.checklist, [{ id:'check', text:'Inspect', checked:true }])
  assert.equal(typeof created.position, 'string')
  const invalid = [
    { ...value, id:'bad-date', dueDate:'2027-02-29' },
    { ...value, id:'bad-time', dueDate:'2028-02-29T24:00' },
    { ...value, id:'bad-complete', dueComplete:'yes' },
    { ...value, id:'bad-labels', labels:['same','same'] },
    { ...value, id:'bad-checklist', checklist:[{ id:'x', text:'a', checked:'yes' }] },
  ]
  for (const [index, taskValue] of invalid.entries()) assert.throws(() => store.create({ operationId:'create-bad-' + index, actor:'user', task:taskValue }), /invalid card details/)
  assert.equal(store.list().length, 1)
})

test('card comments can be edited and deleted within the comment limit', t => {
  const { store, path, trackStore } = fixture(t); create(store, 'card')
  const added = command(store, 'card', 'card-comment', 'user', { text:' First note ' }, 'comment-one')
  assert.equal(added.comments.length, 1)
  const comment = added.comments[0]
  assert.equal(comment.text, 'First note'); assert.equal(comment.author, 'user')
  const edited = command(store, 'card', 'card-comment-edit', 'user', { commentId:comment.id, text:' Edited note ' }, 'comment-edit')
  assert.equal(edited.comments.length, 1); assert.equal(edited.comments[0].text, 'Edited note')
  assert.equal(edited.comments[0].id, comment.id); assert.equal(edited.comments[0].at, comment.at)
  assert.equal(edited.boardActivity.at(-1).type, 'card-comment-edit')
  const deleted = command(store, 'card', 'card-comment-delete', 'user', { commentId:comment.id }, 'comment-delete')
  assert.deepEqual(deleted.comments, [])
  assert.equal(deleted.boardActivity.at(-1).type, 'card-comment-delete')
  assert.throws(() => command(store, 'card', 'card-comment-edit', 'user', { commentId:'missing', text:'x' }, 'comment-missing'), /unknown card comment/)
  assert.throws(() => command(store, 'card', 'card-comment-delete', 'user', { commentId:'missing' }, 'comment-missing-delete'), /unknown card comment/)
  assert.throws(() => command(store, 'card', 'card-comment-edit', 'owner', { commentId:comment.id, text:'x' }, 'comment-actor'), /invalid card comment/)
  assert.throws(() => command(store, 'card', 'card-comment-edit', 'user', { commentId:comment.id, text:'   ' }, 'comment-blank'), /invalid card comment/)
  assert.throws(() => command(store, 'card', 'card-comment-edit', 'user', { commentId:comment.id, text:'x'.repeat(2049) }, 'comment-long'), /invalid card comment/)
  assert.equal(store.get('card').revision, 4)
  for (let index = 0; index < 100; index += 1) command(store, 'card', 'card-comment', 'user', { text:'note ' + index }, 'fill-' + index)
  assert.equal(store.get('card').comments.length, 100)
  assert.throws(() => command(store, 'card', 'card-comment', 'user', { text:'overflow' }, 'comment-overflow'), /card comment limit reached/)
  const removed = command(store, 'card', 'card-comment-delete', 'user', { commentId:store.get('card').comments[0].id }, 'comment-remove-one')
  assert.equal(removed.comments.length, 99)
  const readded = command(store, 'card', 'card-comment', 'user', { text:'replacement' }, 'comment-replace')
  assert.equal(readded.comments.length, 100)
  store.close(); const reopened = trackStore(openTaskStore(path, opts))
  assert.equal(reopened.get('card').comments.length, 100)
})
test('dependency index follows edits atomically and mismatches are rejected on reopen', t => {
  const { store, path } = fixture(t)
  create(store, 'a'); create(store, 'b', ['a'])
  command(store, 'b', 'edit', 'user', { dependencies:[] })
  const db = new DatabaseSync(path)
  assert.equal(db.prepare("SELECT count(*) AS n FROM task_dependencies WHERE task_id='b'").get().n, 0)
  db.close()
  command(store, 'b', 'edit', 'user', { dependencies:['a'] }, 'restore-dep')
  store.close()
  const corrupt = new DatabaseSync(path); corrupt.exec("DELETE FROM task_dependencies WHERE task_id='b'"); corrupt.close()
  assert.throws(() => openTaskStore(path, opts), /dependency index/)
  const after = new DatabaseSync(path); assert.equal(after.prepare("SELECT count(*) AS n FROM task_dependencies WHERE task_id='b'").get().n, 0); after.close()
})

test('task types, draft submit, cancel and restore are durable and valid', t => {
  const { store, path, trackStore } = fixture(t)
  const typed = { ...task('typed'), type:'requirement', draft:true }
  store.create({ operationId:'create-typed', actor:'user', task:typed })
  assert.equal(store.get('typed').type, 'requirement')
  assert.equal(store.get('typed').status, 'draft')
  assert.throws(() => command(store, 'typed', 'card-details', 'user', { type:'not-a-type' }, 'bad-type'))
  assert.equal(command(store, 'typed', 'submit', 'user').status, 'proposed')
  assert.equal(command(store, 'typed', 'cancel', 'user', { reason:'duplicate' }).status, 'cancelled')
  assert.equal(command(store, 'typed', 'restore', 'user').status, 'proposed')
  store.close()
  const reopened = trackStore(openTaskStore(path, opts))
  assert.equal(reopened.get('typed').type, 'requirement')
  assert.equal(reopened.get('typed').status, 'proposed')
})

test('release items keep an explicit order, start one running release and prioritize its scheduling', t => {
  const { store } = fixture(t)
  create(store, 'a'); create(store, 'b'); create(store, 'c')
  const one = store.createRelease({ operationId:'release-one', actor:'user', release:{ id:'r1', scope:'personal:user', name:'Release one', version:'1.0.0' } })
  const two = store.createRelease({ operationId:'release-two', actor:'user', release:{ id:'r2', scope:'personal:user', name:'Release two', version:'1.1.0' } })
  assert.ok(one.position < two.position)
  const assignedA = store.assignRelease({ operationId:'assign-a', actor:'user', releaseId:'r1', expectedReleaseRevision:one.revision, taskId:'a', expectedTaskRevision:1 })
  store.assignRelease({ operationId:'assign-b', actor:'user', releaseId:'r1', expectedReleaseRevision:one.revision, taskId:'b', expectedTaskRevision:1 })
  assert.equal(assignedA.releaseId, 'r1')
  const started = store.startRelease({ operationId:'start-r1', actor:'user', releaseId:'r1', expectedRevision:one.revision })
  assert.equal(started.status, 'running')
  assert.equal(store.get('a').status, 'ready')
  assert.equal(store.get('b').status, 'ready')
  assert.deepEqual(store.listSchedule().slice(0,2).map(task => task.id), ['a','b'])
  assert.equal(store.listSchedule().at(-1).id, 'c')
  assert.throws(() => store.startRelease({ operationId:'start-r2', actor:'user', releaseId:'r2', expectedRevision:two.revision }), /another release/)
  const cancelled = store.cancelRelease({ operationId:'cancel-r1', actor:'user', releaseId:'r1', expectedRevision:started.revision })
  assert.equal(cancelled.status, 'cancelled')
  assert.equal(store.get('a').status, 'proposed')
  assert.equal(store.get('a').releaseId, null)
})

test('a proposal is durable, user-confirmed and applied against its base revision', t => {
  const { store, path, trackStore } = fixture(t)
  create(store, 'card')
  const proposal = store.createProposal({ operationId:'proposal-create', actor:'owner', proposal:{
    id:'proposal-1', scope:'personal:user', taskId:'card', kind:'update', baseRevision:1,
    command:{ type:'card-details', value:{ description:'Bot draft' } }, before:{ description:'' }, after:{ description:'Bot draft' }, note:'Bot suggestion',
  } })
  assert.equal(proposal.status, 'pending')
  assert.equal(store.get('card').description, undefined)
  assert.throws(() => store.decideProposal({ operationId:'proposal-stale', actor:'user', proposalId:'proposal-1', expectedRevision:1, decision:'confirm',
    apply: () => { throw new Error('should not run') } }), /should not run/)
  const decided = store.decideProposal({ operationId:'proposal-confirm', actor:'user', proposalId:'proposal-1', expectedRevision:1, decision:'confirm',
    apply: current => store.command({ operationId:'proposal-apply', taskId:current.taskId, expectedRevision:current.baseRevision, actor:'user', type:current.command.type, value:current.command.value }) })
  assert.equal(decided.proposal.status, 'confirmed')
  assert.equal(store.get('card').description, 'Bot draft')
  assert.equal(store.listProposals('personal:user')[0].status, 'confirmed')
  store.close()
  const reopened = trackStore(openTaskStore(path, opts))
  assert.equal(reopened.get('card').description, 'Bot draft')
  assert.equal(reopened.listProposals('personal:user')[0].status, 'confirmed')
})

test('schema v5 is migrated in place without touching existing tasks', t => {
  const { store, path, trackStore } = fixture(t)
  create(store, 'kept')
  store.close()
  const old = new DatabaseSync(path)
  old.exec('DROP TABLE operations; DROP TABLE proposals; DROP TABLE releases; PRAGMA user_version=5')
  old.close()
  const reopened = trackStore(openTaskStore(path, opts))
  assert.equal(reopened.get('kept').title, 'task kept')
  const db = new DatabaseSync(path)
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 6)
  for (const table of ['operations','proposals','releases']) assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name=?").get(table).n, 1)
  db.close()
})

test('a release publishes when all items complete and starts the next queued release', t => {
  const { store } = fixture(t)
  create(store, 'a'); create(store, 'b')
  const r1 = store.createRelease({ operationId:'rel-a', actor:'user', release:{ id:'r1', scope:'personal:user', name:'v1', version:'1.0.0' } })
  const r2 = store.createRelease({ operationId:'rel-b', actor:'user', release:{ id:'r2', scope:'personal:user', name:'v2', version:'1.1.0' } })
  store.assignRelease({ operationId:'assign-a', actor:'user', releaseId:'r1', expectedReleaseRevision:r1.revision, taskId:'a', expectedTaskRevision:1 })
  store.assignRelease({ operationId:'assign-b', actor:'user', releaseId:'r2', expectedReleaseRevision:r2.revision, taskId:'b', expectedTaskRevision:1 })
  store.queueRelease({ operationId:'queue-b', actor:'user', releaseId:'r2', expectedRevision:r2.revision })
  store.startRelease({ operationId:'start-a', actor:'user', releaseId:'r1', expectedRevision:r1.revision })
  for (const gate of ['docs','artifacts','environment','summary']) {
    const current = store.getRelease('r1')
    store.setReleaseGate({ operationId:`gate-${gate}`, actor:'user', releaseId:'r1', expectedRevision:current.revision, gate, status:'passed', evidence:`${gate} checked` })
  }
  const accept = (taskId, actor, admission) => {
    const action = store.listActions(taskId).find(item => item.state === 'pending')
    const messageId = `msg-${admission}`, intent = { admissionId:`adm-${admission}`, messageId, targetBotId:actor, targetSessionId:`sess-${actor}`,
      payload:{ id:messageId, role:'user', content:[{ type:'text', text:'go' }], source:{ kind:'bot' } } }
    store.claimAction({ operationId:`claim-${admission}`, actor:'scheduler', actionId:action.id, intent })
    store.markAction({ actionId:action.id, actor:'scheduler', expectedState:'claimed', state:'accepted', receipt:'ok' })
    return action
  }
  accept('a', 'owner', 'a-exec')
  store.command({ operationId:'start-work-a', taskId:'a', expectedRevision:store.get('a').revision, actor:'owner', type:'start' })
  store.command({ operationId:'report-a', taskId:'a', expectedRevision:store.get('a').revision, actor:'owner', type:'report',
    value:{ kind:'personal', evidence:'done', environment:'test' } })
  accept('a', 'reviewer', 'a-review')
  store.command({ operationId:'review-a', taskId:'a', expectedRevision:store.get('a').revision, actor:'reviewer', type:'review',
    value:{ evidence:'accepted', result:'pass' } })
  assert.equal(store.get('a').status, 'done')
  assert.equal(store.getRelease('r1').status, 'published')
  assert.equal(store.getRelease('r2').status, 'running')
  assert.equal(store.get('b').status, 'ready')
})

test('archive and unarchive are revision-bound and reversible', t => {
  const { store } = fixture(t)
  create(store, 'archive-me')
  const archived = store.command({ operationId:'archive-1', actor:'user', taskId:'archive-me', expectedRevision:1, type:'archive' })
  assert.ok(archived.archivedAt)
  assert.throws(() => store.command({ operationId:'archive-2', actor:'user', taskId:'archive-me', expectedRevision:archived.revision, type:'archive' }), /already archived/)
  const restored = store.command({ operationId:'unarchive-1', actor:'user', taskId:'archive-me', expectedRevision:archived.revision, type:'unarchive' })
  assert.equal(restored.archivedAt, undefined)
  assert.throws(() => store.command({ operationId:'unarchive-2', actor:'user', taskId:'archive-me', expectedRevision:restored.revision, type:'unarchive' }), /not archived/)
})

test('archived cards leave the scheduler and active work cannot be archived', t => {
  const { store } = fixture(t)
  create(store, 'active'); register(store, 'active')
  const ready = command(store, 'active', 'schedule', 'user', { kind:'personal', reference:'owner approval' })
  assert.equal(ready.status, 'ready')
  assert.equal(store.listSchedule().some(task => task.id === 'active'), true)
  assert.throws(() => command(store, 'active', 'archive', 'user'), /finish or cancel active work/)
  const undone = command(store, 'active', 'unschedule', 'user')
  assert.equal(undone.status, 'waiting')
  assert.equal(store.listActions('active').filter(action => action.state === 'pending').length, 0)
  const proposedAgain = store.command({ operationId:'unschedule-again', actor:'user', taskId:'active', expectedRevision:undone.revision, type:'unschedule' })
  assert.equal(proposedAgain.status, 'proposed')
  assert.equal(proposedAgain.authority, null)
  assert.throws(() => store.command({ operationId:'unschedule-third', actor:'user', taskId:'active', expectedRevision:proposedAgain.revision, type:'unschedule' }), /not scheduled/)
  create(store, 'archived-card')
  command(store, 'archived-card', 'archive', 'user')
  assert.equal(store.listSchedule().some(task => task.id === 'archived-card'), false)
  // Scheduling a card outside the workflow would create an action the scheduler never
  // lists, leaving it ready but undeliverable.
  assert.throws(() => command(store, 'archived-card', 'schedule', 'user', { kind:'personal', reference:'owner approval' }), /not schedulable/)
})

test('a release item cannot be archived while the release is active', t => {
  const { store } = fixture(t)
  create(store, 'release-card')
  const release = store.createRelease({ operationId:'archive-release', actor:'user', release:{ id:'archive-r1', scope:'personal:user', name:'v1', version:'1.0.0' } })
  store.assignRelease({ operationId:'archive-assign', actor:'user', releaseId:'archive-r1', expectedReleaseRevision:release.revision, taskId:'release-card', expectedTaskRevision:1 })
  assert.throws(() => command(store, 'release-card', 'archive', 'user'), /remove the card from its release/)
})
