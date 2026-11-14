import { mkdirSync, lstatSync } from 'node:fs'
import { link, open, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { openTaskStore } from './task-store.mjs'
import { createBoardApi } from './board-api.js'
import { readBoardImage } from './board-images.js'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { isDeepStrictEqual } from 'node:util'
import { installHostWorkflow } from './host-workflow.mjs'
import { createTaskDriver } from './task-driver.mjs'
import { createTaskActionContext } from './task-action-context.mjs'
import { createTaskHostAuthority } from './task-host-authority.mjs'
import { createV5GuardedAdmission } from './task-admission.mjs'
import { createTaskTurnCompletion } from './task-turn-completion.mjs'
import { attachTaskCooperativeGate, createTaskCooperativeGate } from './task-cooperative-gate.mjs'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

export const BOARD_UPLOAD_PATH = '/api/bot-board-upload'
export const BOARD_UPLOAD_MAX_BYTES = Math.ceil(20 * 1024 * 1024 / 3) * 4 + 1024 * 1024
const principal = Object.freeze({ kind: 'user', id: 'user' })
const fail = (message, code = 'bot/invalid') => ({ ok: false, error: { code, message, details: {} } })
const ok = value => ({ ok: true, value })
const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } })
const rejectedMessages = new Set(['revision conflict', 'operation id conflict', 'task id exists', 'task limit reached', 'unknown task', 'unknown dependency', 'dependency cycle', 'dependency graph too large', 'reviewer must be independent', 'invalid fields', 'invalid dependencies', 'invalid dependency grants', 'dependency grant unavailable', 'invalid attachments', 'invalid attachment reference', 'attachment unverified', 'attachment id conflict', 'too many attachments', 'unknown attachment', 'empty edit', 'responsibility or acceptance change requires separate reconciliation', 'share not authorized', 'share unavailable', 'share already exists or limit reached', 'personal progress unavailable', 'invalid personal progress'])
const rejected = error => error?.code === 'bot/invalid' || (!error?.code && typeof error?.message === 'string' && (rejectedMessages.has(error.message) || /^invalid (task id|operation id|actor|owner|reviewer|scope|title|acceptance|attachment id|image id|revision)$/.test(error.message)))
const requestKey = (endpoint, payload) => {
  if (endpoint !== 'board-upload' || !Array.isArray(payload?.images)) return { endpoint, payload }
  return { endpoint, payload: { ...payload, images: payload.images.map(image => image && typeof image === 'object' && typeof image.data === 'string'
    ? { ...image, data: { sha256: createHash('sha256').update(image.data).digest('hex') } } : image) } }
}

function privateDirectory(path, assertWritable) {
  try { lstatSync(path) } catch (error) {
    if (error.code !== 'ENOENT') throw error
    assertWritable()
    try { mkdirSync(path, { mode: 0o700 }) } catch (e) { if (e.code !== 'EEXIST') throw e }
  }
  const stat = lstatSync(path)
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw new Error('Board directory is not private')
}

// User requests and scoped Bot tools share one journal and transaction authority.
export function install(rt) {
  const { ctx } = rt
  // Experimental integration remains opt-in until real Host and crash tests
  // pass. A v5 journal is never upgraded without a separate lifecycle fence.
  const guarded = rt.config?.experimentalGuardedBoard === true
  const active = new Set(), readers = new Set(), workers = new Set(), imageWaiters = [], uploadWaiters = []
  let imageReads = 0, uploads = 0
  let closing = false, closePromise, instance
  ctx.on?.('session/event', (session, event) => {
    instance?.finisher?.observe(session,event)
    instance?.actionContext.observe(session, event)
  })
  const writable = () => {
    if (closing || rt.stopping) throw new Error('Board service is closing')
    if (rt.readOnly() !== undefined) throw new Error('Board is read-only')
    rt.requireHomeLock()
  }
  const run = fn => {
    if (closing || rt.stopping) return Promise.reject(new Error('Board service is closing'))
    const pending = (async () => { await rt.load(); if (closing || rt.stopping) throw new Error('Board service is closing'); return fn() })()
    active.add(pending); return pending.finally(() => active.delete(pending))
  }
  const botWorkflow = installHostWorkflow(rt, {
    defineTool, run, getStore: () => service().store,
    wake: () => instance?.driver.wake(),
    verifyActionContext: (task, caller, action, exec) => instance?.actionContext.verify(task, caller, action, exec) === true,
    // Binding, receipt and evidence have no production verifier yet. Fail closed.
    verifyShare: (task, grant, target) => {
      const current = instance?.store.get(task.id)
      const saved = current?.shares?.find(item => item.id === grant?.id)
      return !!saved && current.revision === task.revision && isDeepStrictEqual(saved, grant)
        && instance.shareAllowed(current, target?.id)
    },
  })
  const service = () => {
    if (instance) return instance
    const root = join(rt.home, 'board-v1'), imageDir = join(root, 'images')
    privateDirectory(root, writable); privateDirectory(imageDir, writable)
    const shareAllowed = (task, target) => {
      if (!task || !task.scope.startsWith('room:') || typeof target !== 'string') return false
      const source = task.scope.slice(5), rooms = rt.state.rooms, bots = rt.state.bots
      if (source === target || !Object.hasOwn(rooms, source) || !Object.hasOwn(rooms, target) || !Array.isArray(rooms[source].members) || !Array.isArray(rooms[target].members)) return false
      const member = id => id === 'user' || (Object.hasOwn(bots, id) && bots[id]?.private !== true && rooms[source].members?.includes(id))
      return member(task.owner) && member(task.reviewer)
    }
    const dependencyAllowed = (task, dependency, grant) => {
      if (!task?.scope.startsWith('room:') || !grant || grant.revoked || grant.taskId !== dependency?.id || grant.grantedBy !== 'user') return false
      const target = task.scope.slice(5), room = rt.state.rooms[target], bots = rt.state.bots
      if (grant.targetRoomId !== target || !shareAllowed(dependency, target) || !Array.isArray(room?.members)) return false
      const member = id => id === 'user' || (Object.hasOwn(bots, id) && bots[id]?.private !== true && room.members.includes(id))
      return member(task.owner) && member(task.reviewer)
    }
    const proofs = new Map()
    const taskBriefs = new Map()
    const authority = guarded ? createTaskHostAuthority({rt,assertLease:writable}) : undefined
    let admission, gate, finisher, driver, dropGate
    const store = openTaskStore(join(root, 'tasks.sqlite'), {
      assertWriteLock: writable,
      enableExplicitTasks:guarded,
      // Upgrading an existing v5 database still requires an independent
      // lifecycle fence for old connections; fail closed until supplied.
      assertExclusiveUpgrade: () => { throw new Error('board lifecycle upgrade fence unavailable') },
      authorize: input => {
        if(input.actor==='user' && ['create','create-explicit','edit','attach','remove-image','cancel','share','unshare','personal-progress'].includes(input.type))return true
        if(input.actor==='host' && input.type==='guarded-recovery') {writable();return guarded}
        if(finisher?.authorize(input)===true)return true
        if(input.actor==='scheduler' && input.type==='receipt') {writable();return guarded}
        if(input.actor==='scheduler' && ['claim','guarded-claim'].includes(input.type)) {
          return guarded && gate?.mayClaim()===true && authority.verify(input.task) && !!authority.target(input.action,input.task)
        }
        return botWorkflow.authorize(input)
      },
      verifyUserTask:(task,execution,actor)=>{try{return !!authority?.capture(task,execution,actor)}catch{return false}},
      captureUserAuthority:guarded ? (task,execution,actor)=>authority.capture(task,execution,actor) : undefined,
      verifyEvidence:(task,value,actor,phase)=>authority?.verifyEvidence(task,value,actor,phase)===true,
      verifyAdmission:(task,action,intent)=>admission?.verifyAdmission(task,action,intent)===true,
      verifyReceipt:(action,state,receipt,intent)=>admission?.verifyReceipt(action,state,receipt,intent)===true,
      verifyTurnCompletion:(task,action,proof,actor)=>finisher?.verify(task,action,proof,actor)===true,
      verifyShare: (task, value, actor) => actor === 'user' && shareAllowed(task, value.targetRoomId),
      verifyDependency: dependencyAllowed,
      verifyAttachment: (task, item, actor) => {
        if (actor !== 'user') return false
        const proof = proofs.get(item.id)
        if (!proof || proof.taskId !== task.id || JSON.stringify(proof.reference) !== JSON.stringify(item)) return false
        try {
          const s = lstatSync(join(imageDir, proof.name))
          return s.isFile() && !s.isSymbolicLink() && s.uid === process.getuid() && !(s.mode & 0o077)
            && s.dev === proof.stat.dev && s.ino === proof.stat.ino && s.size === proof.stat.size && s.mtimeMs === proof.stat.mtimeMs
        } catch { return false }
      },
    })
    const images = {
      read: (taskId, reference) => readBoardImage({ directory: imageDir, taskId, reference }),
    }
    const api = createBoardApi({ store, images, assertWritable: writable, roster: () => rt.state, verifyDependency: dependencyAllowed,
      explicitRequired:()=>guarded, explicitAvailable:()=>instance?.guardedReady===true,
      workspaces:()=>ctx.workspaceRegistry.list().map(item=>({id:item.id,name:item.title})),
      defaultExecution:(scope,actor)=>{
        const sid=scope.kind==='room' ? rt.roomOf(scope.id)?.sessions?.[actor] : rt.chatOf(actor)
        const ws=ctx.workspaceRegistry.list().find(item=>item.sessionIds.includes(sid))
        return ws ? {workspace:ws.id,mode:'write',paths:['.']} : undefined
      },
      shareTargets: task => Object.entries(rt.state.rooms).filter(([id]) => shareAllowed(task, id)).map(([id, room]) => ({ id, name:typeof room.name === 'string' && room.name ? room.name : id })),
      verifyShare: (task, grant, scope, viewer) => grant?.taskId === task.id && grant.grantedBy === 'user' && !grant.revoked && grant.targetRoomId === scope.id
        && Array.isArray(grant.fields) && grant.fields.includes('status') && grant.fields.every(field => ['status','title'].includes(field))
        && shareAllowed(task, scope.id) && (viewer.kind === 'user' || (viewer.kind === 'bot' && rt.state.rooms[scope.id].members?.includes(viewer.id))) })
    try {
      botWorkflow.bind(store)
      const actionContext = createTaskActionContext(store)
      if(guarded) {
        gate=createTaskCooperativeGate({store,actionContext,resolveBot:sid=>rt.isBotSession(sid)?rt.selfOf(sid):undefined,assertLease:writable})
        dropGate=attachTaskCooperativeGate(ctx,gate)
        finisher=createTaskTurnCompletion({store,actionContext,assertLease:writable,
          beginReceipt:(sid,type)=>ctx.sessionPersistence.beginLiveEventReceipt(sid,type),wake:()=>driver?.wake(),
          onError:error=>rt.warn?.('ds-bot: task turn completion: %s',error?.message||'unknown error')})
        admission=createV5GuardedAdmission({store,enabled:true,noAgentsResolved:()=>ctx.agents.list().length===0,
          isActive:()=>{try{writable();return true}catch{return false}},resolveTarget:(action,task)=>authority.target(action,task),
          resolveAgent:sid=>rt.resolveAgent(sid),authorize:(task,action)=>authority.verify(task)&&!!authority.target(action,task),
          sessionGeneration:agent=>actionContext.generation(agent),activateTurn:(agent,position)=>finisher.activate(agent,position),
          makeMessage:(action,task)=>{
            const target=authority.target(action,task),room=task.scope.startsWith('room:')?rt.roomOf(task.scope.slice(5)):undefined
            const context=[taskBriefs.get(target?.sessionId),room?.name?`Group: ${room.name}`:'',room?.notice].filter(Boolean).join('\n\n')
            return createUserMessage({source:{kind:'bot'},content:[{type:'text',text:
              `${context}${context?'\n\n':''}[Board task ${task.id}] You are the ${action.kind==='review'?'independent reviewer':'owner'}. Call board_task show first; follow its current revision and acceptance criteria. Respect its workspace and paths. Use sha256:<digest>:<relative path> for file evidence. Reviewer turns are read-only. Submit the result with board_task and finish the turn.`}]})
          }})
        const admit=admission.admit.bind(admission)
        admission.admit=async input=>{const result=await admit(input);taskBriefs.delete(input.intent.targetSessionId);return result}
      }
      driver = createTaskDriver({ store, admission, authorized:async(action,task)=>{
        if(!guarded||gate?.mayClaim()!==true||!authority.verify(task))return false
        if(!authority.target(action,task)&&task.scope.startsWith('room:')&&action.actor!=='user') {
          const session=await rt.prepareTaskGroupSession?.(task.scope.slice(5),action.actor)
          if(session?.brief)taskBriefs.set(session.id,session.brief)
        }
        return gate.mayClaim()===true&&authority.verify(task)&&!!authority.target(action,task)
      },
        onError: error => rt.warn?.('ds-bot: board scheduler: %s', error?.message || 'unknown error') })
      instance = { store, api, root, imageDir, proofs, shareAllowed, driver, actionContext, admission, gate, finisher, dropGate, guardedReady:false }
      queueMicrotask(notifyDriver)
      return instance
    } catch (error) { store.close(); throw error }
  }
  const notifyDriver = () => {
    if (!instance || closing || rt.stopping) return
    void run(() => instance?.driver.wake()).catch(error => rt.warn?.('ds-bot: board scheduler: %s', error?.message || 'unknown error'))
  }
  let providerDispose, bootPromise, bootReady
  if(guarded) {
    if(typeof ctx.agents?.registerGuardedClaimProvider!=='function' || typeof ctx.sessionPersistence?.beginLiveEventReceipt!=='function') throw Error('guarded board requires durable Agent and session persistence')
    bootReady=Promise.withResolvers()
    void bootReady.promise.catch(()=>{})
    // Install the provider publication barrier synchronously before any
    // asynchronously restored Agent can begin an unguarded claim.
    const registered=ctx.agents.registerGuardedClaimProvider(async agent=>{
      const inst=await bootReady.promise
      return inst.admission.coordinatorFor(agent)
    })
    void registered.catch(()=>{})
    bootPromise=(async()=>{
      try {
        await rt.load();writable()
        const inst=service()
        inst.admission.startBeforeRestore()
        bootReady.resolve(inst)
        providerDispose=await registered
        if(closing||rt.stopping)throw Error('board service is closing')
        inst.guardedReady=true
        notifyDriver()
      }catch(error){
        bootReady.reject(error)
        const release=await registered.catch(()=>undefined)
        release?.();providerDispose=undefined
        instance?.admission?.close()
        instance?.dropGate?.()
        rt.warn?.('ds-bot: guarded board unavailable: %s',error?.message||'unknown error')
      }
    })()
  }
  const mutate = (endpoint, payload) => {
    const { api, store } = service(), scope = payload.scope
    const outcome = store.request({ operationId: payload.operationId, actor: 'user', taskId: payload.taskId, payload: requestKey(endpoint, payload), isRejection: rejected }, () => {
      if (payload.type === 'create') {
        if (!payload.value || typeof payload.value !== 'object' || Array.isArray(payload.value)) throw Object.assign(new Error('Invalid task proposal'), { code: 'bot/invalid' })
        return api.create(scope, principal, { ...payload.value, operationId: payload.operationId, taskId: payload.taskId })
      }
      return api.command(scope, principal, payload)
    })
    if (outcome.state === 'rejected') throw Object.assign(new Error(outcome.message), { code: 'bot/invalid' })
    return outcome.value
  }
  const boardCall = (endpoint, payload = {}) => endpoint === 'board-image' ? imageCall(payload) : run(async () => {
    const { api, store } = service(), scope = payload.scope
    switch (endpoint) {
      case 'board-list': {
        // A concurrent DB writer may commit between projection and version
        // reads; never label an older list as the current snapshot.
        for (let i = 0; i < 3; i += 1) {
          const before = store.version(), rosterRevision = rt.state.revision
          const view = api.list(scope, principal)
          const recovery = await rt.recoveryHeldView?.(scope) ?? { available: false, incomplete: true, items: [] }
          if (before === store.version() && rosterRevision === rt.state.revision) return { ...view,
            recovery,
            revision: `${rosterRevision}:${before}` }
        }
        throw new Error('Board changed; refresh the board')
      }
      case 'board-operation': return api.operation(scope, principal, payload.operationId)
      case 'board-operation-cancel': {
        api.list(scope, principal)
        return store.cancelRequest({ operationId: payload.operationId, actor: 'user' })
      }
      case 'board-command': { const result = mutate(endpoint, payload); notifyDriver(); return result }
      default: throw new Error('Unknown board endpoint')
    }
  })
  async function readBody(request) {
    if (!request.body) throw new Error('Missing upload body')
    const reader = request.body.getReader(); readers.add(reader)
    const chunks = []; let length = 0, timedOut = false
    const timeout = setTimeout(() => { timedOut = true; void reader.cancel().catch(() => {}) }, 60_000)
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (timedOut) throw Object.assign(new Error('Image request timed out'), { status:408 })
        if (done) break
        length += value.byteLength
        if (length > BOARD_UPLOAD_MAX_BYTES) { void reader.cancel(); throw Object.assign(new Error('Image request exceeds the allowed size'), { status: 413 }) }
        chunks.push(value)
      }
      const bytes = new Uint8Array(length); let offset = 0
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
      return bytes
    } finally { clearTimeout(timeout); readers.delete(reader); reader.releaseLock() }
  }
  const workerJob = (path, data, transferList = []) => new Promise((resolve, reject) => {
    const worker = new Worker(new URL(path, import.meta.url), {
      workerData: data, transferList, resourceLimits: { maxOldGenerationSizeMb:128 },
    })
    workers.add(worker); let settled = false
    const timer = setTimeout(() => { void worker.terminate(); finish(new Error('Image preparation timed out')) }, 30_000)
    const finish = (error, value) => {
      if (settled) return
      settled = true; clearTimeout(timer); workers.delete(worker)
      if (error) reject(error); else resolve(value)
    }
    worker.once('message', value => {
      if (value?.ok || value?.rejected) return finish(null, value)
      const error = new Error(value?.message || 'Invalid image request')
      if (value?.stack) error.stack = value.stack
      finish(error)
    })
    worker.once('error', error => finish(error))
    worker.once('exit', () => { if (!settled) finish(new Error('Image operation stopped')) })
  })
  const prepare = (bytes, stagingDir, imageDir) => workerJob('./board-image-worker.mjs', { bytes, stagingDir, imageDir }, [bytes.buffer])
  const enterImageRead = () => {
    if (closing || rt.stopping) return Promise.reject(new Error('Board service is closing'))
    if (imageReads < 2) { imageReads += 1; return Promise.resolve() }
    if (imageWaiters.length >= 20) return Promise.reject(new Error('Too many image requests'))
    return new Promise((resolve, reject) => imageWaiters.push({ resolve, reject }))
  }
  const leaveImageRead = () => {
    const next = imageWaiters.shift()
    if (next) next.resolve(); else imageReads -= 1
  }
  const imageCall = payload => run(async () => {
    const inst = service(), before = inst.api.imageReference(payload.scope, principal, payload.taskId, payload.imageId)
    await enterImageRead()
    try {
      const result = await workerJob('./board-image-read-worker.mjs', { directory:inst.imageDir, taskId:before.taskId, reference:before.reference })
      const after = inst.api.imageReference(payload.scope, principal, payload.taskId, payload.imageId)
      if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('Image permission or reference changed')
      return result.value
    } finally { leaveImageRead() }
  })
  const enterUpload = signal => {
    if (closing || rt.stopping || signal?.aborted) return Promise.reject(new Error('Board service is closing'))
    if (uploads < 2) { uploads += 1; return Promise.resolve() }
    if (uploadWaiters.length >= 4) return Promise.reject(Object.assign(new Error('Too many image uploads'), { status:429 }))
    return new Promise((resolve, reject) => {
      const item = { resolve:() => { signal?.removeEventListener('abort', aborted); resolve() }, reject:error => { signal?.removeEventListener('abort', aborted); reject(error) } }
      const aborted = () => { const at = uploadWaiters.indexOf(item); if (at !== -1) uploadWaiters.splice(at, 1); item.reject(new Error('Image upload cancelled')) }
      uploadWaiters.push(item); signal?.addEventListener('abort', aborted, { once:true })
      if (signal?.aborted) aborted()
    })
  }
  const leaveUpload = () => {
    const next = uploadWaiters.shift()
    if (next) next.resolve(); else uploads -= 1
  }
  const sameStat = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs
  async function publishImages(prepared, stagingDir, inst) {
    const { meta, references, files } = prepared, proofs = new Map()
    for (let i = 0; i < references.length; i += 1) {
      writable()
      const entry = files[i], source = join(stagingDir, entry.name), destination = join(inst.imageDir, entry.name)
      const staged = lstatSync(source)
      if (!staged.isFile() || staged.isSymbolicLink() || !sameStat(staged, entry.staged)) throw new Error('Prepared image changed')
      if (entry.existing) {
        const found = lstatSync(destination)
        if (!found.isFile() || found.isSymbolicLink() || !sameStat(found, entry.existing)) throw new Error('Existing image changed')
      } else {
        await link(source, destination)
      }
      writable()
      const final = lstatSync(destination)
      if (!final.isFile() || final.isSymbolicLink() || (entry.existing ? !sameStat(final, entry.existing) : !sameStat(final, entry.staged))) throw new Error('Image identity changed')
      proofs.set(references[i].id, { taskId:meta.taskId, reference:references[i], name:entry.name, stat:{ dev:final.dev, ino:final.ino, size:final.size, mtimeMs:final.mtimeMs } })
    }
    const dir = await open(inst.imageDir, 'r')
    try { await dir.sync() } finally { await dir.close() }
    return proofs
  }
  const upload = request => run(async () => {
    let stagingDir, inst, admitted = false
    try {
      await enterUpload(request.signal); admitted = true
      const bytes = await readBody(request)
      if (closing || rt.stopping) return response(fail('Board service is closing'))
      inst = service(); writable()
      stagingDir = join(inst.root, `.staging-${randomUUID()}`); mkdirSync(stagingDir, { mode:0o700 })
      const prepared = await prepare(bytes, stagingDir, inst.imageDir)
      if (closing || rt.stopping) throw new Error('Board service is closing')
      const { meta, identity, references } = prepared
      const options = { operationId:meta.operationId, actor:'user', taskId:meta.taskId, payload:identity, isRejection:rejected }
      if (prepared.rejected) {
        const outcome = inst.store.request(options, () => {
          inst.api.list(meta.scope, principal)
          throw Object.assign(new Error(prepared.message), { code:'bot/invalid' })
        })
        return response(outcome.state === 'committed' ? ok(outcome.value) : fail(outcome.message))
      }
      const existing = inst.store.operation(meta.operationId)
      if (existing) {
        const outcome = inst.store.request(options, () => { throw new Error('Unexpected duplicate execution') })
        return response(outcome.state === 'committed' ? ok(outcome.value) : fail(outcome.message))
      }
      // Check visibility and revision before linking; the journal checks again
      // after the asynchronous file operations and before metadata commit.
      const board = inst.api.list(meta.scope, principal), task = inst.store.get(meta.taskId)
      if (!task || !board.tasks.some(item => item.id === meta.taskId) || task.revision !== meta.expectedRevision) {
        const outcome = inst.store.request(options, () => { throw Object.assign(new Error('Task changed; refresh the board'), { code:'bot/invalid' }) })
        return response(fail(outcome.message))
      }
      const proofs = await publishImages(prepared, stagingDir, inst)
      writable()
      inst.proofs.clear(); for (const [key, value] of proofs) inst.proofs.set(key, value)
      let outcome
      try { outcome = inst.store.request(options, () => inst.api.uploadPrepared(meta.scope, principal, meta, references)) }
      finally { inst.proofs.clear() }
      return response(outcome.state === 'committed' ? ok(outcome.value) : fail(outcome.message))
    } catch (error) {
      const frames = typeof error?.stack === 'string' ? error.stack.split('\n').slice(1, 9).join('\n') : ''
      rt.warn?.('ds-bot: board image upload failed: %s', frames || error?.name || 'unknown error')
      const status = [408, 413, 429].includes(error?.status) ? error.status : 200
      const message = status === 413 ? 'Image request exceeds the allowed size' : status === 429 ? 'Too many image uploads; try again' : status === 408 ? 'Image request timed out' : 'Could not upload image'
      return response(fail(message, status === 429 ? 'bot/busy' : 'bot/invalid'), status)
    } finally {
      if (stagingDir) await rm(stagingDir, { recursive:true, force:true }).catch(() => {})
      if (admitted) leaveUpload()
    }
  })
  const stop = () => closePromise ??= (async () => {
    closing = true
    bootReady?.reject(new Error('board service is closing'))
    for (const waiter of imageWaiters.splice(0)) waiter.reject(new Error('Board service is closing'))
    for (const waiter of uploadWaiters.splice(0)) waiter.reject(new Error('Board service is closing'))
    for (const reader of readers) void reader.cancel().catch(() => {})
    for (const worker of workers) void worker.terminate()
    await Promise.allSettled([...active])
    await instance?.driver.close()
    await bootPromise
    await instance?.finisher?.close()
    instance?.admission?.close();instance?.dropGate?.();providerDispose?.()
    botWorkflow.close(); instance?.store.close(); instance = undefined
  })()
  rt.boardCall = boardCall
  rt.onHomeDrain(stop)
  ctx.effect(() => ctx.connection.fetch.register({ path: BOARD_UPLOAD_PATH, methods: ['POST'], requestBody: 'streaming', fetch: upload }), 'ds-bot: board streaming upload')
  ctx.effect(() => stop, 'ds-bot: board service')
}
