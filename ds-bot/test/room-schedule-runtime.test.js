import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fakeContext } from './fake-ctx.js'
import { install as installSchedules } from '../src/host/schedules.js'
import * as roomScheduleDelivery from '../src/host/room-schedule-delivery.js'

const token = 'migration-test-token'
const oldPrompt = [
  'Every 10 minutes, inspect this group’s goal and original task board. Stay silent while the group is actively progressing.',
  'If the goal is active and incomplete while this group is idle, take a concrete authorized step now; do not say only “waiting” or reply [PASS] because a task is blocked.',
  'Identify the highest-priority unfinished task, its exact owner, the next action or evidence, and who can clear any blocker. Follow up in the group using a plain-text @Name for the one person who must act; never put the mention in backticks, code, or a link, and never use @all. Include the task ID, requested action/evidence, feedback deadline, and next check. Make at most one effective follow-up per owner for the same task in this cycle and record progress on the original board item.',
  'For an uncertain handoff, inspect its original receipt and ask the known recipient only to confirm receipt and current status; explicitly do not repeat or restart the work. Do not send another assignment or change its request ID to bypass uncertainty.',
  'Do not repeat a follow-up while its stated deadline is still open. Use that time for independent authorized work and record the next check. If a deadline is missed or two scheduled checks pass without confirmation, escalate with a plain-text @Name to the specific authorized person who can unblock or decide; do not leave an ownerless or open-ended wait.',
  'If a shared lock is held, verify the current holder, ask that person to finish/report/release, and do not dispatch conflicting work. Once the lock is verified idle, continue the queued task. Honor an explicit user pause or stop and never mark reported work done without acceptance evidence.',
].join(' ') + ' [DS-Bot room timer ' + token + '] Keep the signed release milestone.'

test('schedule service startup applies managed room prompt migrations', async t => {
  const room = { id:'g1', name:'Launch', members:['admin'], admin:'admin', sessionId:'g1' }
  const record = { id:'schedule-1', kind:'every', title:'DSBOT-GROUP/g1', prompt:oldPrompt,
    target:{kind:'session',sessionId:'g1'}, everySeconds:600, status:'active', updatedAt:'1' }
  const task = { record, target:record.target, status:'active', updatedAt:'1' }
  const schedule = {
    async create() { throw new Error('startup should adopt the existing managed task') },
    async catalog() { return [{ ...task.record, target:task.target, status:task.status, updatedAt:task.updatedAt }] },
    async edit({ id, expectedUpdatedAt, action, patch }) {
      if (id !== task.record.id || expectedUpdatedAt !== task.updatedAt) return { code:'schedule_conflict' }
      if (action === 'delete') return { code:'unexpected_delete' }
      Object.assign(task.record, patch)
      task.updatedAt = String(Number(task.updatedAt) + 1)
      return { id }
    },
  }
  const ctx = fakeContext({ services:{ schedule } })
  const saved = new Set(), drains = new Set()
  const rt = {
    ctx,
    state:{ rooms:{g1:room}, roomSchedules:{g1:{id:record.id,token,target:'g1'}} },
    chatOwners:new Map(), groupOwners:new Map(), pastOwners:new Map(),
    roomOf: id => id === 'g1' ? room : undefined,
    botOf: id => id === 'admin' ? { id, private:false } : undefined,
    chatOf: id => id,
    sessionOfRoom: value => value.sessionId ?? value.id,
    isBotSession: () => false,
    load: async () => {},
    save: async () => { for (const listener of saved) listener() },
    readOnly: () => undefined,
    homeLockVersion: () => 'lock-1',
    onSaved: listener => { saved.add(listener); return () => saved.delete(listener) },
    onHomeDrain: listener => { drains.add(listener); return () => drains.delete(listener) },
    warn: () => {},
  }
  installSchedules(rt)
  t.after(async () => {
    await Promise.all([...drains].map(drain => drain()))
    await ctx.dispose()
  })
  for (let i=0; i<100 && task.record.prompt===oldPrompt; i++) await new Promise(resolve=>setTimeout(resolve,10))
  assert.equal(task.record.prompt.includes('Stay silent while the group is actively progressing'),false)
  assert.match(task.record.prompt,/A live turn, queued message, chat activity/)
  assert.match(task.record.prompt,/the group administrator reports the exact decision needed/)
  assert.ok(task.record.prompt.endsWith('Keep the signed release milestone.'))
})

test('the plugin runtime composes the managed room schedule delivery module', () => {
  assert.equal(typeof roomScheduleDelivery.install, 'function')
  const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  assert.match(source, /import \* as roomScheduleDelivery from '\.\/src\/host\/room-schedule-delivery\.js'/)
  const modules = /const MODULES = \[(.*?)\]/s.exec(source)?.[1]
  assert.ok(modules)
  assert.match(modules, /schedules, roomScheduleDelivery, browser/)
})
