import { createHash } from 'node:crypto'
import { closeSync, lstatSync, mkdirSync, openSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const SHA = /^[a-f0-9]{40}$/
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/
const MAX_COMMITS = 1000
const COMMITS_PER_BATCH = 20
const MAX_FILES = 3000
const INTERVAL = 15 * 60_000
const MAX_EVENTS = 5000

function configOf(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const { repository, branch, ownerBotId, initialCursor } = value
  if (typeof repository !== 'string' || !REPO.test(repository) || repository.split('/').some(part=>part==='.' || part==='..') || typeof branch !== 'string' || !REF.test(branch) || branch.includes('..') || branch.includes('//')
    || typeof ownerBotId !== 'string' || !ownerBotId || (initialCursor !== undefined && (typeof initialCursor !== 'string' || !SHA.test(initialCursor)))) return undefined
  return { repository, branch, ownerBotId, initialCursor }
}

const isPatrol = file => typeof file === 'string' && file.startsWith('team/patrol/')
export function classifyFiles(files) {
  if (!Array.isArray(files) || files.length === 0) return 'unknown'
  for (const file of files) {
    if (!file || typeof file.filename !== 'string' || !file.filename) return 'unknown'
    if (file.status === 'renamed' && typeof file.previous_filename !== 'string') return 'unknown'
    if (!isPatrol(file.filename) || (file.previous_filename !== undefined && !isPatrol(file.previous_filename))) return 'relevant'
  }
  return 'patrol-only'
}

function privateDirectory(path) {
  try { mkdirSync(path, { mode: 0o700 }) } catch (e) { if (e.code !== 'EEXIST') throw e }
  const s = lstatSync(path)
  if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== process.getuid() || (s.mode & 0o077)) throw new Error('private storage unavailable')
}

export function openRemoteChangeStore(path, spec, assertOwner) {
  if (path !== ':memory:') {
    try { closeSync(openSync(path, 'wx', 0o600)) } catch (e) { if (e.code !== 'EEXIST') throw e }
    const s = lstatSync(path)
    if (!s.isFile() || s.isSymbolicLink() || s.uid !== process.getuid() || (s.mode & 0o077)) throw new Error('private storage unavailable')
  }
  const db = new DatabaseSync(path)
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK(id=1), repository TEXT NOT NULL, branch TEXT NOT NULL, cursor TEXT, earlier_unknown INTEGER NOT NULL, checked_at TEXT);
    CREATE TABLE IF NOT EXISTS changes (sha TEXT PRIMARY KEY, title TEXT NOT NULL, author TEXT NOT NULL, committed_at TEXT NOT NULL, kind TEXT NOT NULL, paths TEXT NOT NULL, total_files INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS pending (id INTEGER PRIMARY KEY CHECK(id=1), base TEXT NOT NULL, head TEXT NOT NULL, commits TEXT NOT NULL, next_index INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS staged (sha TEXT PRIMARY KEY, title TEXT NOT NULL, author TEXT NOT NULL, committed_at TEXT NOT NULL, kind TEXT NOT NULL, paths TEXT NOT NULL, total_files INTEGER NOT NULL);`)
  const state = () => db.prepare('SELECT * FROM state WHERE id=1').get()
  const pending = () => {const row=db.prepare('SELECT * FROM pending WHERE id=1').get();return row ? {...row,commits:JSON.parse(row.commits)} : undefined}
  const rows = () => {
    const seen=new Set()
    return [...db.prepare('SELECT sha,title,author,committed_at,kind,paths,total_files,1 AS pending FROM staged ORDER BY rowid DESC LIMIT 30').all(),...db.prepare('SELECT sha,title,author,committed_at,kind,paths,total_files,0 AS pending FROM changes ORDER BY rowid DESC LIMIT 30').all()].filter(row=>{if(seen.has(row.sha))return false;seen.add(row.sha);return true}).slice(0,30).map(row => ({ ...row, pending:row.pending===1, paths:JSON.parse(row.paths) }))
  }
  const tx = fn => {
    db.exec('BEGIN IMMEDIATE')
    try { assertOwner(); const value=fn(); assertOwner(); db.exec('COMMIT'); return value }
    catch (e) { try { db.exec('ROLLBACK') } catch {}; throw e }
  }
  tx(() => {
    const row=state()
    if (!row) db.prepare('INSERT INTO state VALUES (1,?,?,?,?,NULL)').run(spec.repository,spec.branch,spec.initialCursor ?? null,1)
    else if (row.repository!==spec.repository || row.branch!==spec.branch) throw new Error('monitor configuration changed')
  })
  return {
    state,
    pending,
    rows,
    totalEvents: () => db.prepare('SELECT count(*) AS n FROM (SELECT sha FROM changes UNION SELECT sha FROM staged)').get().n,
    close: () => db.close(),
    bootstrap(head, at) { return tx(() => {
      const current=state(); if (current.cursor !== null) throw new Error('monitor changed')
      db.prepare('UPDATE state SET cursor=?,checked_at=? WHERE id=1').run(head,at)
    }) },
    commit(expected, head, events, at) { return tx(() => {
      if (state().cursor !== expected) throw new Error('monitor changed')
      const count=db.prepare('SELECT count(*) AS n FROM changes').get().n
      if (count + events.length > MAX_EVENTS) throw new Error('monitor capacity reached')
      const put=db.prepare('INSERT OR IGNORE INTO changes (sha,title,author,committed_at,kind,paths,total_files) VALUES (?,?,?,?,?,?,?)')
      for (const e of events) put.run(e.sha,e.title,e.author,e.committedAt,e.kind,JSON.stringify(e.paths),e.totalFiles)
      db.prepare('UPDATE state SET cursor=?,checked_at=? WHERE id=1').run(head,at)
    }) },
    begin(expected, head, commits) { return tx(() => {
      if (state().cursor!==expected || pending()) throw new Error('monitor changed')
      db.prepare('INSERT INTO pending VALUES (1,?,?,?,0)').run(expected,head,JSON.stringify(commits))
    }) },
    advance(base, head, index, next, events, at) { return tx(() => {
      const work=pending()
      if (!work || work.base!==base || work.head!==head || work.next_index!==index || state().cursor!==base) throw new Error('monitor changed')
      const count=db.prepare('SELECT (SELECT count(*) FROM changes)+(SELECT count(*) FROM staged) AS n').get().n
      if (count+events.length>MAX_EVENTS) throw new Error('monitor capacity reached')
      const put=db.prepare('INSERT OR IGNORE INTO staged (sha,title,author,committed_at,kind,paths,total_files) VALUES (?,?,?,?,?,?,?)')
      for (const e of events) put.run(e.sha,e.title,e.author,e.committedAt,e.kind,JSON.stringify(e.paths),e.totalFiles)
      if (next===work.commits.length) {
        db.exec('INSERT OR IGNORE INTO changes SELECT * FROM staged; DELETE FROM staged; DELETE FROM pending')
        db.prepare('UPDATE state SET cursor=?,checked_at=? WHERE id=1').run(head,at)
      } else db.prepare('UPDATE pending SET next_index=? WHERE id=1').run(next)
    }) },
  }
}

const nextLink = value => typeof value === 'string' && /(?:^|,)\s*<[^>]+>;\s*rel="next"/.test(value)
export function createRemoteChangePoller({ spec, store, authorize, request = fetch, clock = () => new Date() }) {
  async function get(path, signal) {
    const token=await authorize()
    const response=await request(`https://api.github.com/repos/${spec.repository}/${path}`, {
      method:'GET', redirect:'error', signal,
      headers:{ Authorization:`Bearer ${token}`, Accept:'application/vnd.github+json', 'User-Agent':'ds-bot-remote-watch', 'X-GitHub-Api-Version':'2022-11-28' },
    })
    if (!response.ok) throw new Error(response.status===429 || (response.status===403 && response.headers?.get?.('x-ratelimit-remaining')==='0') ? 'rate limited' : response.status===401 || response.status===403 ? 'authorization unavailable' : 'remote unavailable')
    const body=await response.json()
    return { body, more:nextLink(response.headers?.get?.('link')) }
  }
  return async function poll() {
    const signal=AbortSignal.timeout(60_000), at=()=>clock().toISOString()
    await authorize()
    const current=store.state(), cursor=current.cursor
    let work=store.pending()
    if (!work) {
      const tip=await get(`commits?sha=${encodeURIComponent(spec.branch)}&per_page=1`,signal)
      const head=Array.isArray(tip.body) ? tip.body[0]?.sha : undefined
      if (!SHA.test(head ?? '')) throw new Error('remote response incomplete')
      if (cursor===null) { store.bootstrap(head,at()); return { status:'ok', head, earlierUnknown:true } }
      if (!SHA.test(cursor)) throw new Error('local cursor unavailable')
      if (cursor===head) { store.commit(cursor,head,[],at()); return { status:'ok', head, earlierUnknown:!!current.earlier_unknown } }
      let commits=[],page=1,more=true,total
      while (more) {
        if (page>10) throw new Error('history requires reconciliation')
        const compare=await get(`compare/${cursor}...${head}?per_page=100&page=${page}`,signal),c=compare.body
        if (c?.status!=='ahead' || c?.merge_base_commit?.sha!==cursor || !Number.isSafeInteger(c?.total_commits)
          || c.total_commits<1 || c.total_commits>MAX_COMMITS || (total!==undefined && total!==c.total_commits) || !Array.isArray(c.commits)) throw new Error('history requires reconciliation')
        total=c.total_commits;commits.push(...c.commits);more=compare.more;page++
      }
      if (commits.length!==total || new Set(commits.map(commit=>commit?.sha)).size!==total || commits.some(commit=>!SHA.test(commit?.sha ?? ''))) throw new Error('remote response incomplete')
      commits=commits.map(commit=>({sha:commit.sha,title:String(commit?.commit?.message ?? '').split('\n',1)[0].slice(0,300),author:String(commit?.commit?.author?.name ?? '').slice(0,120),committedAt:String(commit?.commit?.committer?.date ?? '').slice(0,40)}))
      await authorize();store.begin(cursor,head,commits);work=store.pending()
    }
    if (!work || work.base!==cursor || !SHA.test(work.head) || !Array.isArray(work.commits)
      || !Number.isSafeInteger(work.next_index) || work.next_index<0 || work.next_index>=work.commits.length) throw new Error('history requires reconciliation')
    const events=[],deadline=Date.now()+40_000
    let end=work.next_index
    for (const commit of work.commits.slice(work.next_index,work.next_index+COMMITS_PER_BATCH)) {
      if (end>work.next_index && Date.now()>=deadline) break
      const sha=commit?.sha
      if (!SHA.test(sha ?? '')) throw new Error('remote response incomplete')
      let files=[], page=1, more=true
      while (more) {
        if (page>30) throw new Error('history requires reconciliation')
        const detail=await get(`commits/${sha}?per_page=100&page=${page}`,signal)
        if (detail.body?.sha!==sha || !Array.isArray(detail.body?.files)) throw new Error('remote response incomplete')
        files.push(...detail.body.files); more=detail.more; page++
        if (files.length>=MAX_FILES) throw new Error('history requires reconciliation')
      }
      end++
      const kind=classifyFiles(files)
      if (kind==='patrol-only') continue
      const paths=files.flatMap(file => [file.filename, file.previous_filename].filter(path=>typeof path==='string' && !isPatrol(path))).slice(0,20)
      events.push({sha,title:commit.title,author:commit.author,committedAt:commit.committedAt,kind,paths,totalFiles:files.length})
    }
    // The branch may have been force-pushed while a large comparison was being
    // scanned. Only commit a pinned head that is still on the observed branch.
    const latest=await get(`commits?sha=${encodeURIComponent(spec.branch)}&per_page=1`,signal)
    const observed=Array.isArray(latest.body) ? latest.body[0]?.sha : undefined
    if (!SHA.test(observed ?? '')) throw new Error('remote response incomplete')
    if (observed!==work.head) {
      const proof=await get(`compare/${work.head}...${observed}?per_page=1&page=1`,signal)
      if (proof.body?.status!=='ahead' || proof.body?.merge_base_commit?.sha!==work.head || proof.body?.behind_by!==0) throw new Error('history requires reconciliation')
    }
    await authorize()
    store.advance(work.base,work.head,work.next_index,end,events,at())
    return { status:end===work.commits.length && observed===work.head ? 'ok' : 'catching up', head:work.head, earlierUnknown:!!current.earlier_unknown, recorded:events.length }
  }
}

export function install(rt) {
  const configured=rt.config?.remoteChangeWatch
  if (configured===undefined || configured===false) return
  const spec=configOf(configured)
  if (!spec) { rt.remoteChangeView=()=>({status:'invalid configuration',events:[]}); return }
  let store, timer, pending, stopped=false, status='waiting'
  const authorize=async()=>{
    if (stopped || rt.stopping) throw new Error('monitor stopped')
    await rt.load(); await rt.loadSecrets()
    if (!rt.state.bots?.[spec.ownerBotId] || rt.canUseSecret?.('GITHUB_TOKEN',spec.ownerBotId)!==true) throw new Error('authorization unavailable')
    rt.requireHomeLock()
    const token=rt.secretValue?.('GITHUB_TOKEN')
    if (typeof token!=='string' || !token) throw new Error('authorization unavailable')
    return token
  }
  const assertOwner=()=>{
    if (stopped || rt.stopping || !rt.state.bots?.[spec.ownerBotId] || rt.canUseSecret?.('GITHUB_TOKEN',spec.ownerBotId)!==true) throw new Error('authorization unavailable')
    rt.requireHomeLock()
  }
  const open=()=>{
    if (store) return store
    assertOwner()
    const dir=join(rt.home,'remote-change-watch-v1'); privateDirectory(dir)
    const id=createHash('sha256').update(JSON.stringify([spec.repository,spec.branch])).digest('hex')
    return store=openRemoteChangeStore(join(dir,`${id}.sqlite`),spec,assertOwner)
  }
  rt.remoteChangeView=()=>{
    if (stopped) return {status:'unavailable',events:[]}
    try { assertOwner(); const s=open(), row=s.state(); return {status, repository:spec.repository, branch:spec.branch, checkedAt:row.checked_at, earlierUnknown:!!row.earlier_unknown, totalEvents:s.totalEvents(), events:s.rows()} }
    catch (error) { return {status:error?.message==='authorization unavailable' ? 'authorization unavailable' : 'unavailable',events:[]} }
  }
  const tick=()=>{
    if (stopped || pending) return
    let delay=INTERVAL
    pending=(async()=>{ try { await authorize(); const result=await createRemoteChangePoller({spec,store:open(),authorize})();status=result.status;if(status==='catching up')delay=3000 }
      catch (error) { status=['authorization unavailable','history requires reconciliation','monitor capacity reached','rate limited'].includes(error?.message) ? error.message : 'unavailable' }
      finally { pending=undefined; if (!stopped) { timer=setTimeout(tick,delay);timer.unref?.() } } })()
  }
  rt.ctx.effect(()=>{
    timer=setTimeout(tick,15_000);timer.unref?.()
    return async()=>{stopped=true;clearTimeout(timer);await pending;store?.close();store=undefined}
  },'ds-bot: remote change watch')
}
