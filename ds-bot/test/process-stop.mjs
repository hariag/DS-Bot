import { writeSync } from 'node:fs'

const killMarker = 'DSBOT_TEST_KILL_REQUESTED\n'

export function killProcessForTest() {
  writeSync(1, killMarker)
  process.kill(process.pid, 'SIGKILL')
}

export function stoppedBeforeSuccess(child) {
  if (child.error || !child.stdout?.includes(killMarker)) return false
  if (process.platform === 'win32') return child.signal === null && (child.status === null || child.status === 1) && !/\b(?:Error|TypeError|RangeError|ReferenceError):/.test(child.stderr ?? '')
  return child.status === null && child.signal === 'SIGKILL'
}
