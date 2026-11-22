// The room timer is a ten-minute heartbeat; a goal review must wait for its own
// stored next-review time, or every heartbeat becomes an administrator turn.
import { reviewIsDue } from '../src/host/goals.js'
let failures = 0
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); if (!ok) failures += 1 }

const now = 1_000_000
check('waits for reviewAt', reviewIsDue({ reviewAt: now + 1 }, now) === false)
check('waits for ownerReviewAt', reviewIsDue({ ownerReviewAt: now + 60_000 }, now) === false)
check('due exactly at reviewAt', reviewIsDue({ reviewAt: now }, now) === true)
check('due after reviewAt', reviewIsDue({ reviewAt: now - 1 }, now) === true)
check('no stored time is due (legacy)', reviewIsDue({}, now) === true)
check('non-finite times are ignored', reviewIsDue({ reviewAt: NaN, ownerReviewAt: Infinity }, now) === true)
check('the earlier clock wins', reviewIsDue({ reviewAt: now + 5_000, ownerReviewAt: now - 5_000 }, now) === true)
check('later of two future clocks still waits', reviewIsDue({ reviewAt: now + 5_000, ownerReviewAt: now + 9_000 }, now) === false)
process.exit(failures ? 1 : 0)