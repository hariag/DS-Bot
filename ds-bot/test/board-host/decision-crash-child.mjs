import { openTaskStore } from '../../src/host/task-store.mjs'
const store = openTaskStore(process.argv[2], { assertWriteLock() {}, authorize() { return true }, verifyRegistration() { return true }, verifyAdmission() { return true } })
store.create({ operationId:'create', actor:'user', task:{ id:'t', title:'Task', owner:'bot', reviewer:'reviewer', scope:'personal:user', acceptance:'review', dependencies:[] } })
store.command({ operationId:'register', taskId:'t', expectedRevision:1, actor:'user', type:'register', value:{ kind:'personal', reference:'test approval' } })
const action = store.listActions('t')[0]
store.claimAction({ actionId:action.id, actor:'scheduler', intent:{ admissionId:'admission-1', messageId:'message-1', targetBotId:'bot', targetSessionId:'session-1', payload:{ id:'message-1', role:'user', content:[{type:'text',text:'work'}], source:{kind:'bot',exchangeId:'admission-1'} } } })
store.cancelAction({ operationId:'cancel-1', actor:'user', actionId:action.id, expectedTaskRevision:store.get('t').revision, expectedActionState:'claimed', expectedAdmissionId:'admission-1', reason:'user stopped work' })
process.kill(process.pid, 'SIGKILL')
