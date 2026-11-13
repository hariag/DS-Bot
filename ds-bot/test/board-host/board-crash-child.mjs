import { openTaskStore } from '../../src/host/task-store.mjs'
const store = openTaskStore(process.argv[2], { assertWriteLock() {}, authorize() { return true } })
store.request({ operationId:'crash-op', actor:'user', taskId:'crash-task', payload:{ title:'x' }, isRejection() { return false } }, () => {
  store.create({ operationId:'crash-op', actor:'user', task:{ id:'crash-task', scope:'personal:user', title:'x', owner:'user', reviewer:'reviewer', acceptance:'review', dependencies:[] } })
  process.kill(process.pid, 'SIGKILL')
})
