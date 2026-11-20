// The build identity must identify this exact local release, not only "0.3.8".
import { versionInfo } from '../src/host/version-info.mjs'
import pkg from '../package.json' with { type: 'json' }
let failures = 0
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); if (!ok) failures += 1 }
const info = versionInfo({ revision: 292460 }, '/root/.dsh/bot')
check('name', info.name === 'ds-bot', info.name)
check('version matches manifest', info.version === pkg.version, info.version)
check('build present', typeof info.build === 'string' && info.build.length > 0, String(info.build))
check('fork commit', /^[0-9a-f]{40}$/.test(info.forkCommit ?? ''))
check('changes include all', ['goal-pass-gate','git-evidence-verifier','review-inspection-ledger-bound','version-endpoint'].every(c => info.changes.includes(c)), JSON.stringify(info.changes))
check('state revision passthrough', info.stateRevision === 292460)
check('readAt is ISO', !Number.isNaN(Date.parse(info.readAt)))
check('runtime is a name or null', info.runtime === null || typeof info.runtime === 'string', String(info.runtime))
check('node version is recorded', /^v\d+\./.test(info.node ?? ''), String(info.node))
check('pid is recorded', Number.isInteger(info.pid) && info.pid > 0)
process.exit(failures ? 1 : 0)