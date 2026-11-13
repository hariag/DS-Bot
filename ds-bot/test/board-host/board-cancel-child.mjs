import { openTaskStore } from '../../src/host/task-store.mjs'
const store = openTaskStore(process.argv[2], { assertWriteLock() {}, authorize() { return true } })
store.cancelRequest({ operationId:'cancel-crash', actor:'user' })
process.kill(process.pid, 'SIGKILL')
