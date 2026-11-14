import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { openTaskStore } from '../../src/host/task-store.mjs'

const hex = 'a'.repeat(40)
const opts = { assertWriteLock() {}, authorize() { return true }, verifyRegistration() { return true }, verifyEvidence() { return true }, verifyReceipt() { return true }, verifyInvalidation() { return true }, verifyAttachment() { return true }, verifyAdmission() { return true } }
function fixture(t, options = opts) {
  const dir = mkdtempSync(join(tmpdir(), 'dsbot-task-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, 'store.sqlite'), store = openTaskStore(path, options)
  t.after(() => { try { store.close() } catch {} })
  return { path, store }
}
const task = (id, dependencies = []) => ({ id, title: `task ${id}`, scope: 'personal:user', owner: 'owner', reviewer: 'reviewer', acceptance: 'independent acceptance', dependencies })
const create = (s, id, deps = []) => s.create({ operationId: `create-${id}`, actor: 'user', task: task(id, deps) })
const command = (s, id, type, actor, value, op = `${type}-${id}`) => s.command({ operationId: op, taskId: id, expectedRevision: s.get(id).revision, actor, type, ...(value !== undefined ? { value } : {}) })
const register = (s, id) => command(s, id, 'register', 'user', { kind: 'personal', reference: 'owner approval' })
const evidence = { kind: 'git', evidence: 'artifact', targetCommit: hex, targetBlob: hex, acceptanceBlob: hex, environment: 'test' }

test('version history preserves before and after across restart without exposing unrelated metadata', t => {
  const {store, path} = fixture(t)
  create(store, 'history')
  command(store, 'history', 'card-details', 'user', {description:'Original'})
  command(store, 'history', 'card-details', 'user', {description:'Changed'}, 'changed')
  store.close(); const reopened = openTaskStore(path, opts); t.after(() => reopened.close())
  const history = reopened.history('history')
  assert.equal(history.entries[0].before.description, 'Original')
  assert.equal(history.entries[0].after.description, 'Changed')
  assert.equal(history.entries[0].after.revision, 3)
  assert.equal(history.entries[0].after.authority, undefined)
  assert.equal(history.truncated, false)
})

test('card details persist with CAS and idempotency without completing dependencies', t => {
  const { store, path } = fixture(t)
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
  store.close(); const reopened = openTaskStore(path, opts); t.after(() => reopened.close())
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
  const { store, path } = fixture(t)
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
  store.close(); const reopened = openTaskStore(path, opts); t.after(() => reopened.close())
  assert.equal(reopened.get('mine').personalProgress, 'finished'); assert.equal(reopened.get('mine').status, 'proposed')
  assert.equal(reopened.get('dependent').status, 'waiting')
})

test('personal progress can be selected atomically at creation without scheduling work', t => {
  const {store, path} = fixture(t)
  const input = {operationId:'create-doing', actor:'user', task:{...task('doing'), owner:'user', personalProgress:'doing'}}
  const created = store.create(input)
  assert.equal(created.personalProgress, 'doing'); assert.equal(created.status, 'proposed')
  assert.deepEqual(store.create(input), created); assert.equal(store.listActions(created.id).length, 0)
  assert.throws(() => store.create({...input, operationId:'bad', task:{...input.task, id:'bad', scope:'room:group'}}), /personal progress/)
  assert.throws(() => store.create({...input, operationId:'bad2', task:{...input.task, id:'bad2', owner:'bot'}}), /personal progress/)
  store.close(); const reopened = openTaskStore(path, opts); t.after(() => reopened.close())
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
  const {store, path} = fixture(t); create(store, 'active'); register(store, 'active')
  accept(store, 'active', 'execute'); command(store, 'active', 'start', 'owner')
  const old = store.get('active')
  const value = {title:'Changed', owner:old.owner, reviewer:old.reviewer, acceptance:'New acceptance', dependencies:[], dependencyGrants:[], description:'New description'}
  const input = {operationId:'change-op', actor:'user', taskId:old.id, expectedRevision:old.revision, value}
  const proposal = store.proposeChange(input)
  assert.deepEqual(store.proposeChange(input), proposal)
  assert.equal(store.get('active').title, old.title)
  assert.equal(store.get('active').status, 'working')
  assert.equal(proposal.status, 'waiting'); assert.deepEqual(proposal.dependencies, ['active'])
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
  store.close(); const reopened = openTaskStore(path, opts); t.after(() => reopened.close())
  assert.deepEqual(reopened.get(proposal.id).change, proposal.change)
  assert.deepEqual(reopened.proposeChange(input), proposal)
})

test('delivery and independent review drive dependencies immediately and survive restart', t => {
  const { store, path } = fixture(t)
  create(store, 'a'); create(store, 'b', ['a']); register(store, 'a'); register(store, 'b')
  assert.equal(store.get('a').status, 'ready'); assert.equal(store.get('b').status, 'waiting')
  assert.throws(() => command(store, 'a', 'start', 'owner'), /receipt/)
  finish(store, 'a'); assert.equal(store.get('a').status, 'done'); assert.equal(store.get('b').status, 'ready')
  assert.equal(store.listActions('b').filter(x => x.state === 'pending').length, 1)
  const restarted = openTaskStore(path, opts); t.after(() => restarted.close())
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
  const { store, path } = fixture(t)
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
  const reopened = openTaskStore(path, opts); t.after(() => reopened.close())
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
  const dir = mkdtempSync(join(tmpdir(), 'dsbot-admission-crash-')); t.after(() => rmSync(dir, { recursive:true, force:true }))
  const path = join(dir, 'tasks.sqlite')
  const child = spawnSync(process.execPath, [fileURLToPath(new URL('./admission-crash-child.mjs', import.meta.url)), path], { encoding:'utf8' })
  assert.equal(child.signal, 'SIGKILL')
  const store = openTaskStore(path, opts); t.after(() => store.close())
  const action = store.listActions('t')[0], saved = store.admission(action.id)
  assert.equal(saved.state, 'claimed'); assert.equal(saved.admissionId, 'admission-1'); assert.equal(saved.targetSessionId, 'session-1')
  const intent = { admissionId:'admission-1', messageId:'message-1', targetBotId:'bot', targetSessionId:'session-1', payload:{ id:'message-1', role:'user', content:[{type:'text',text:'work'}], source:{kind:'bot',exchangeId:'admission-1'} } }
  assert.equal(store.claimAction({ actionId:action.id, actor:'scheduler', intent }).claimedNow, false)
  assert.throws(() => store.claimAction({ actionId:action.id, actor:'scheduler', intent:{ ...intent, targetSessionId:'session-2' } }), /intent conflict/)
})

test('startup converts interrupted admissions to durable uncertainty exactly once', t => {
  const {store,path}=fixture(t);create(store,'restart');register(store,'restart')
  const action=store.listActions('restart')[0],intent=intentFor(action);claim(store,action,intent)
  store.markAction({actionId:action.id,actor:'host',expectedState:'claimed',state:'accepted',receipt:'verified'})
  store.close()
  const reopened=openTaskStore(path,opts);t.after(()=>reopened.close())
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
  const dir = mkdtempSync(join(tmpdir(), 'dsbot-decision-crash-')); t.after(() => rmSync(dir, { recursive:true, force:true }))
  const path = join(dir, 'tasks.sqlite'), child = spawnSync(process.execPath, [fileURLToPath(new URL('./decision-crash-child.mjs', import.meta.url)), path], { encoding:'utf8' })
  assert.equal(child.signal, 'SIGKILL')
  const store = openTaskStore(path, opts); t.after(() => store.close())
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
  const dir = mkdtempSync(join(tmpdir(), 'dsbot-invalidate-crash-')); t.after(() => rmSync(dir, { recursive:true, force:true }))
  const path = join(dir, 'tasks.sqlite'), child = spawnSync(process.execPath, [fileURLToPath(new URL('./invalidation-crash-child.mjs', import.meta.url)), path], { encoding:'utf8' })
  assert.equal(child.signal, 'SIGKILL')
  const store = openTaskStore(path, opts); t.after(() => store.close())
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
  const dir = mkdtempSync(join(tmpdir(), 'dsbot-task-unknown-')); t.after(() => rmSync(dir, { recursive: true, force: true }))
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
