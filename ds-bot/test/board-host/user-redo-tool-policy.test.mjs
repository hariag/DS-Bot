import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { userRedoConfirmation, userRedoIdentity } from '../../src/host/user-redo-journal.mjs'
import { sameRedoToolRuntime } from '../../src/host/user-redo-tool-policy.mjs'

function fixture() {
  const operationId = 'de5b1723-7063-4e3e-b27e-12f44dd0033d', recoveryId = 'a'.repeat(64)
  const scope = { kind:'room', id:'r' }, identity = userRedoIdentity(operationId)
  const message = { id:'m', role:'user', content:[{ type:'text', text:'task' }], source:{ kind:'bot' } }
  const proof = { complete:true, durability:'target-writer-v1', recoveryId, botId:'b', sessionId:'old', turn:1, messageSeq:3, message, isCurrent:() => true }
  const confirmationDigest = userRedoConfirmation(scope, recoveryId, proof)
  const row = { operationId, identity, recoveryId, scope, acknowledged:true, confirmationDigest,
    original:{ botId:'b', sessionId:'old', turn:1, messageSeq:3, messageId:'m', messageHash:createHash('sha256').update(JSON.stringify(message)).digest('hex') } }
  const original = { id:'old', session:{ id:'old', header:{ cwd:'/workspace' } } }
  const target = { id:identity.sessionId, session:{ id:identity.sessionId, header:{ cwd:'/workspace' } } }
  const agents = new Map([[original.id, original], [target.id, target]])
  const sessions = new Map([[original.id, original.session], [target.id, target.session]])
  const definition = { name:'read' }, definitions = new Map([[original, [definition]], [target, [definition]]])
  let allowed = true, targetPreset = 'workspace-write', targetMode = 'workspace-write'
  const presets = { current:session => session === target.session ? targetPreset : 'workspace-write',
    resolve:() => ({ sandbox:'workspace-write', approval:'ask' }) }
  const sandbox = { resolve:({ session }) => ({ mode:session === target.session ? targetMode : 'workspace-write', workspaceRoot:'/workspace', sessionId:session.id }) }
  const ctx = { agents:{ get:id => agents.get(id) }, sessions:{ get:id => sessions.get(id) },
    tools:{ executable:(name, agent) => (definitions.get(agent) ?? []).find(def => def.name === name) }, get:name => name === 'permissionPresets' ? presets : name === 'sandboxPolicy' ? sandbox : undefined }
  const rt = { ctx, state:{ userRedos:{ [operationId]:row } }, userRedoOwner:() => allowed ? { id:'b' } : undefined }
  const input = { operationId, target, sourceProof:proof, confirmationDigest, exec:{ agent:target, name:'read', toolSet:{} } }
  return { rt, input, proof, target, original, definition, definitions, agents, row,
    setAllowed:x => { allowed = x }, setPreset:x => { targetPreset = x }, setMode:x => { targetMode = x } }
}

test('diagnostic detects different mocked preset, sandbox or tool definition', () => {
  const f = fixture()
  assert.equal(sameRedoToolRuntime(f.rt, f.input), true)
  f.setPreset('danger-full-access')
  assert.equal(sameRedoToolRuntime(f.rt, f.input), false)
  f.setPreset('workspace-write'); f.setMode('danger-full-access')
  assert.equal(sameRedoToolRuntime(f.rt, f.input), false)
  f.setMode('workspace-write'); f.definitions.set(f.target, [{ name:'read' }])
  assert.equal(sameRedoToolRuntime(f.rt, f.input), false)
})

test('scope revocation, different workspace, tool, source or consent all fail closed', () => {
  const f = fixture()
  f.setAllowed(false); assert.equal(sameRedoToolRuntime(f.rt, f.input), false)
  f.setAllowed(true); f.target.session.header.cwd = '/elsewhere'; assert.equal(sameRedoToolRuntime(f.rt, f.input), false)
  f.target.session.header.cwd = '/workspace'; f.input.exec.name = 'run_code'; assert.equal(sameRedoToolRuntime(f.rt, f.input), false)
  f.input.exec.name = 'read'; f.proof.isCurrent = () => false; assert.equal(sameRedoToolRuntime(f.rt, f.input), false)
  f.proof.isCurrent = () => true; f.input.confirmationDigest = 'f'.repeat(64); assert.equal(sameRedoToolRuntime(f.rt, f.input), false)
})
