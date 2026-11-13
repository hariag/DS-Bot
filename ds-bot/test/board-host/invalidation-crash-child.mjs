import { openTaskStore } from '../../src/host/task-store.mjs'
const opts = { assertWriteLock() {}, authorize() { return true }, verifyRegistration() { return true }, verifyAdmission() { return true }, verifyEvidence() { return true }, verifyReceipt() { return true }, verifyInvalidation() { return true } }
const store = openTaskStore(process.argv[2], opts)
const task = (id, dependencies = []) => ({ id, title:id, owner:'owner', reviewer:'reviewer', scope:'personal:user', acceptance:'review', dependencies })
const command = (id, type, actor, value) => store.command({ operationId:`${type}-${id}`, taskId:id, expectedRevision:store.get(id).revision, actor, type, ...(value === undefined ? {} : { value }) })
const claim = (id, kind) => {
  const action = store.listActions(id).find(item => item.kind === kind && item.state === 'pending')
  const admissionId = `admission-${action.id}`, messageId = `message-${action.id}`
  store.claimAction({ actionId:action.id, actor:'scheduler', intent:{ admissionId, messageId, targetBotId:action.actor, targetSessionId:`session-${action.actor}`, payload:{ id:messageId, role:'user', content:[{type:'text',text:'work'}], source:{kind:'bot',exchangeId:admissionId} } } })
  return action
}
store.create({ operationId:'create-a', actor:'user', task:task('a') })
command('a', 'register', 'user', { kind:'personal', reference:'test' })
let a = claim('a','execute'); store.markAction({ actionId:a.id, actor:'host', expectedState:'claimed', state:'accepted', receipt:'accepted' })
command('a','start','owner')
const h = 'a'.repeat(40)
command('a','report','owner',{ kind:'git', evidence:'artifact', targetCommit:h, targetBlob:h, acceptanceBlob:h, environment:'test' })
a = claim('a','review'); store.markAction({ actionId:a.id, actor:'host', expectedState:'claimed', state:'accepted', receipt:'accepted' })
command('a','review','reviewer',{ result:'pass', evidence:'review' })
store.create({ operationId:'create-b', actor:'user', task:task('b',['a']) })
command('b','register','user',{ kind:'personal', reference:'test' })
claim('b','execute')
command('a','invalidate','user',{ reason:'target changed', evidence:'new revision' })
process.kill(process.pid, 'SIGKILL')
