// RED/GREEN harness for the group_goal pass gate.
// Run from /tmp/dsbot-fix-test with: node pass-gate.test.mjs
import { passGoal } from '../src/host/goals.js'

const task = (id, status, extra = {}) => ({ id, botId: 'bot-' + id, task: 'T-' + id, status, ...extra })
const room = tasks => ({
  id: 'room-1',
  name: '研发协作群',
  goal: {
    status: 'active',
    current: 0,
    revision: 1,
    updatedAt: Date.now(),
    stages: [{
      id: 's1',
      title: '阶段1',
      acceptance: '每项都有可查证据',
      status: 'active',
      tasks,
    }],
  },
})

let failures = 0
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  if (!ok) failures += 1
}

// A: a stage with unreported work must not be passed.
const mixed = room([
  task('t1', 'pending'),
  task('t2', 'reported', { goalBoardReplies: [{ id: 'r1', text: '证据：blob abc123' }] }),
])
const a = passGoal(mixed, { evidence: '阶段验收：t1/t2 完成' }, 'admin-1')
check('A unreported task blocks pass', typeof a.error === 'string' && a.error.length > 0,
  JSON.stringify(a.error ?? { passed: mixed.goal.stages[0].status, t1: mixed.goal.stages[0].tasks[0].status }))

// B: reported but with no evidence note must not be passed either.
const noEvidence = room([
  task('t1', 'reported'),
])
const b = passGoal(noEvidence, { evidence: '阶段验收' }, 'admin-1')
check('B reported-without-evidence blocks pass', typeof b.error === 'string' && b.error.length > 0,
  JSON.stringify(b.error ?? { passed: noEvidence.goal.stages[0].status }))

// C: every task reported with evidence passes and marks the stage done.
const good = room([
  task('t1', 'reported', { goalBoardReplies: [{ id: 'r1', text: '证据：hidden 8 passed' }] }),
  task('t2', 'done', { goalBoardReplies: [{ id: 'r2', text: '证据：QA 独立复核' }] }),
])
const c = passGoal(good, { evidence: '阶段验收：见各自证据' }, 'admin-1')
check('C reported tasks still pass', c.error === undefined && c.goal.stages[0].status === 'passed' && c.goal.current === 1,
  JSON.stringify(c.error ?? { stage: c.goal.stages[0].status, current: c.goal.current }))

process.exit(failures === 0 ? 0 : 1)