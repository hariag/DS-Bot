import { createElement as h, useEffect, useRef, useState } from 'react'
import { createPortal, flushSync } from 'react-dom'
import { call } from './api.js'
import { hostText, t } from './i18n.js'

// The server supplies already-authorized tasks; never infer membership or filter
// another actor's private tasks in the browser.
const COLUMNS = [
  ['proposed', 'Preparing'], ['waiting', 'Waiting'], ['ready', 'Ready'],
  ['legacy-pending', 'Not started'], ['working', 'In progress'], ['reported', 'Awaiting review'], ['done', 'Done'], ['legacy-done','Goal marked done'],
]
const PERSONAL_COLUMNS = [['todo', 'To do'], ['doing', 'Doing'], ['finished', 'Personally finished']]
const KNOWN = new Set(COLUMNS.map(([status]) => status))
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg'])
const IMAGE_MAX_BYTES = 5 * 1024 * 1024
const IMAGE_BATCH_MAX_COUNT = 10
const IMAGE_TASK_MAX_COUNT = 20
const IMAGE_BATCH_MAX_BYTES = 20 * 1024 * 1024
const finalOperation = status => status === 'committed' || status === 'rejected'
const storageKey = scope => `ds-bot:board-pending:${scope.kind}:${scope.id}`
const textValue = value => typeof value === 'string' ? value : ''
const cardStamp = task => ({revision:task.revision,...(task.legacy?.useOverlay?{boardRevision:task.legacy.boardRevision,position:task.legacy.position}:{})})
const sameCardStamp = (task,stamp) => JSON.stringify(cardStamp(task))===JSON.stringify(stamp)
const stampedTask = (task,stamp) => ({...task,revision:stamp.revision,...(task.legacy?{legacy:{...task.legacy,useOverlay:stamp.position!==undefined,boardRevision:stamp.boardRevision,position:stamp.position}}:{})})

/** Group task cards into display columns without inferring completion. */
export function boardColumns(tasks) {
  const columns = new Map(COLUMNS.map(([key]) => [key, []]))
  columns.set('unknown', [])
  const seen = new Set()
  for (const task of Array.isArray(tasks) ? tasks : []) {
    if (!task || typeof task.id !== 'string' || !task.id || seen.has(task.id)) throw new Error('Invalid or duplicate task ID')
    seen.add(task.id)
    columns.get(KNOWN.has(task.status) ? task.status : 'unknown').push(task)
  }
  return columns
}

// Session storage retains only the operation ID, never task data. If unavailable,
// commands stay disabled: a lost response must remain queryable across reloads.
function pendingStore(scope) {
  try {
    const key = storageKey(scope)
    const storage = window.sessionStorage
    const current = storage.getItem(key)
    return {
      current,
      put: id => storage.setItem(key, id),
      clear: () => storage.removeItem(key),
    }
  } catch {
    return null
  }
}

function asText(value) {
  if (typeof value === 'string') return value
  if (!value || typeof value !== 'object') return ''
  return textValue(value.reason) || textValue(value.title) || textValue(value.id) || textValue(value.ref) || textValue(value.commit)
}

// Names are supplied by the authorized board view; identity values remain IDs.
function actorLabel(value, actors) {
  const id = asText(value)
  if (id === 'user') return t('You')
  if (!id || !Array.isArray(actors)) return id
  const actor = actors.find(item => item?.id === id)
  return textValue(actor?.name) || id
}

function Fact({ label, value }) {
  if (!value) return null
  return h('div', { className: 'bt-board-fact' }, h('span', null, label), h('span', null, value))
}

function RemoteChanges({ monitor }) {
  if (!monitor) return null
  const states = { waiting:'Waiting for first check', ok:'Monitor active', 'catching up':'Monitor catching up', unavailable:'Monitor unavailable',
    'authorization unavailable':'Monitor authorization unavailable', 'history requires reconciliation':'Monitor history requires review',
    'monitor capacity reached':'Monitor capacity reached', 'rate limited':'Monitor rate limited', 'invalid configuration':'Monitor configuration invalid' }
  const events=Array.isArray(monitor.events) ? monitor.events : []
  return h('details', { className:'bt-board-held' },
    h('summary', null, t('Remote code changes'), Number.isSafeInteger(monitor.totalEvents) && monitor.totalEvents ? ` (${monitor.totalEvents})` : ''),
    h('p', { role:'status' }, `${t('Status')}: ${t(states[monitor.status] ?? 'Monitor unavailable')}`),
    monitor.repository && monitor.branch ? h('p', null, `${monitor.repository} · ${monitor.branch}`) : null,
    monitor.checkedAt ? h('p', null, `${t('Last checked (UTC)')}: ${monitor.checkedAt}`) : null,
    monitor.earlierUnknown ? h('p', { role:'status' }, t('Earlier history before the first checkpoint was not verified.')) : null,
    events.length===0 ? h('p', null, t('No relevant changes recorded.')) : null,
    events.map(event=>h('article', { key:event.sha, className:'bt-board-held-record' },
      h('a', { href:`https://github.com/${monitor.repository}/commit/${event.sha}`, target:'_blank', rel:'noopener noreferrer' }, event.sha.slice(0,8)),
      h('span', null, event.title), h('span', null, event.author), h('span', null, event.committed_at), event.pending ? h('span', null, t('Change awaiting checkpoint')) : null,
      h('span', null, event.kind==='unknown' ? t('Change requires review') : (event.paths ?? []).join(', ')))))
}

const snapshotTime = value => Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000
  ? new Date(value).toISOString() : t('Unknown')
const shortIdentity = value => typeof value !== 'string' ? t('Unknown') : value.length > 32 ? `${value.slice(0, 20)}…${value.slice(-8)}` : value
const matchesRecovery = (needle, values) => !needle || values.some(value => textValue(value).toLocaleLowerCase().includes(needle))

function recoveryGroups(rows, idOf, nameOf) {
  const groups = new Map()
  for (const item of rows) {
    const id = idOf(item) || ''
    if (!groups.has(id)) groups.set(id, { id, name: nameOf(item) || id || t('Unknown'), rows: [] })
    groups.get(id).rows.push(item)
  }
  return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name))
}

// The host provides scoped metadata only. This view never replays or closes work.
function HeldTurns({ recovery, scope, request, onRefresh }) {
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(''), [error, setError] = useState('')
  const inFlight = useRef(false)
  const decide = async (item, choice) => {
    if (inFlight.current || !Number.isSafeInteger(item.decisionRevision)) return
    inFlight.current = true; setBusy(item.recoveryId); setError('')
    try {
      await request('board-held-decision', { scope, recoveryId:item.recoveryId, expectedRevision:item.decisionRevision, choice })
      await onRefresh()
    } catch { setError(t('Decision outcome is unknown. Refresh before trying again.')) }
    finally { inFlight.current = false; setBusy('') }
  }
  if (!recovery || recovery.available !== true) return h('p', { className: 'bt-board-pending', role: 'status' }, t('Recovery records are unavailable or incomplete.'))
  const rows = Array.isArray(recovery.items) ? recovery.items : []
  const needle = query.trim().toLocaleLowerCase()
  const filtered = rows.filter(item => matchesRecovery(needle, [item.botName, item.botId, item.sessionId, item.exchangeId, item.recoveryId]))
  const pendingRows = filtered.filter(item => item.decision !== 'ignored')
  const ignoredRows = filtered.filter(item => item.decision === 'ignored')
  const groups = recoveryGroups(pendingRows, item => item.botId, item => item.botName)
  const renderRows = list => h('div', { className: 'bt-recovery-groups' }, recoveryGroups(list, item => item.botId, item => item.botName).map(group => h('section', { key: group.id, className: 'bt-recovery-group' },
    h('div', { className: 'bt-recovery-group-title' }, h('strong', null, group.name), h('span', null, group.rows.length)),
    group.rows.map(item => h('details', { key: item.recoveryId, className: 'bt-board-held-record bt-recovery-record' },
      h('summary', { className: 'bt-recovery-record-summary' }, h('span', { className: 'bt-recovery-record-id', title: item.sessionId }, shortIdentity(item.sessionId)),
        h('span', { className: 'bt-recovery-record-time' }, Number.isSafeInteger(item.startedAt) ? snapshotTime(item.startedAt) : t('Unknown')),
        h('span', { className: 'bt-recovery-badge' }, t(item.decision === 'ignored' ? 'Ignored' : 'Status unknown'))),
      h('div', { className: 'bt-recovery-facts' }, h(Fact, { label: t('Session ID'), value: item.sessionId }),
        h(Fact, { label: t('Original turn'), value: Number.isSafeInteger(item.turn) ? String(item.turn) : t('Unknown') }),
        h(Fact, { label: t('Exchange ID'), value: item.exchangeId || t('Unknown') }), h(Fact, { label: t('Recovery ID'), value: item.recoveryId })),
      h('p', { className:'bt-recovery-note' }, t('Ignoring keeps the record and does not complete the work.')),
      item.decision !== 'ignored' ? h('p', { className:'bt-recovery-note' }, t('Redo is unavailable because the original input cannot be verified.')) : null,
      h('button', { type:'button', disabled:!!busy, onClick:() => void decide(item, item.decision === 'ignored' ? 'open' : 'ignored') }, t(item.decision === 'ignored' ? 'Undo ignore' : 'Ignore')))))))
  return h('details', { className: 'bt-recovery-panel' },
    h('summary', { className: 'bt-recovery-summary' },
      h('span', { className: 'bt-recovery-icon', 'aria-hidden': true }, '↻'),
      h('span', { className: 'bt-recovery-summary-text' }, h('strong', null, t('Interrupted work')),
        h('small', null, t(rows.length ? 'Choose what to do with each item' : recovery.incomplete ? 'Recovery records are unavailable or incomplete.' : 'No items'))),
      h('span', { className: 'bt-recovery-count' }, recovery.incomplete && !rows.length ? '—' : String(rows.filter(item => item.decision !== 'ignored').length))),
    h('div', { className: 'bt-recovery-body' },
      error ? h('p', { role:'alert', className:'bt-recovery-warning' }, error) : null,
      h('div', { className: 'bt-recovery-intro' },
        h('p', null, t('The outcome is unknown. Your choice does not mark the work complete.')),
        h('span', null, t('Snapshot time (UTC)'), ': ', snapshotTime(recovery.sampledAt))),
      recovery.incomplete ? h('p', { className: 'bt-recovery-warning', role: 'status' }, t('Recovery records are unavailable or incomplete.')) : null,
      rows.length ? h('label', { className: 'bt-recovery-search' }, h('span', { className: 'bt-recovery-sr' }, t('Filter by Bot or ID')),
        h('input', { type: 'search', value: query, placeholder: t('Filter by Bot or ID'), onChange: event => setQuery(event.target.value) })) : null,
      !rows.length && !recovery.incomplete ? h('p', { className: 'bt-recovery-empty', role: 'status' }, t('No interrupted turns in this snapshot.')) : null,
      rows.length && !filtered.length ? h('p', { className: 'bt-recovery-empty', role: 'status' }, t('No matching records.')) : null,
      groups.length ? renderRows(pendingRows) : null,
      ignoredRows.length ? h('details', null, h('summary', null, `${t('Ignored')} (${ignoredRows.length})`), renderRows(ignoredRows)) : null))
}

// Owner-only manual notes on an existing work. This never dispatches or closes it.
const recoveryObservationText = value => value === 'observed-present' ? t('Observed in snapshot')
  : value === 'observed-absent' ? t('Not observed in snapshot') : t('Not known')
const legacyReviewStateText = value => value === 'needs-review' ? t('Needs manual review')
  : value === 'evidence-needed' ? t('Evidence still needed')
    : value === 'identity-unverified' ? t('Work identity unverified') : t('Not known')
const reviewMarkerPrefix = 'ds-bot:legacy-review-pending:'
const reviewOperationPattern = /^manual-review:[a-f0-9]{64}$/
function reviewMarkers(workId) {
  const storage = globalThis.localStorage
  if (!storage) throw new Error('Review storage unavailable')
  const prefix = `${reviewMarkerPrefix}${encodeURIComponent(workId)}:`
  const markers = []
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index)
    if (!key?.startsWith(prefix)) continue
    const marker = JSON.parse(storage.getItem(key))
    if (!marker || marker.workId !== workId || !reviewOperationPattern.test(marker.operationId)
      || key !== `${prefix}${marker.operationId}` || !['create', 'finding'].includes(marker.kind)
      || !['personal', 'room'].includes(marker.scope?.kind) || typeof marker.scope.id !== 'string' || !marker.scope.id) throw new Error('Invalid review marker')
    markers.push({ key, ...marker })
    if (markers.length > 100) throw new Error('Too many review markers')
  }
  return markers
}
function putReviewMarker(marker) {
  const key = `${reviewMarkerPrefix}${encodeURIComponent(marker.workId)}:${marker.operationId}`
  globalThis.localStorage.setItem(key, JSON.stringify(marker))
  if (globalThis.localStorage.getItem(key) !== JSON.stringify(marker)) throw new Error('Review storage unavailable')
  return key
}
function WorkDecisions({ scope, request, actors }) {
  const [items,setItems]=useState(null), [selected,setSelected]=useState(''), [error,setError]=useState(''), [busy,setBusy]=useState(false)
  const [incomplete,setIncomplete]=useState(false), [query,setQuery]=useState('')
  const active=useRef(false), epoch=useRef(0), requested=useRef(false)
  useEffect(()=>()=>{epoch.current+=1},[])
  const fetchItems=async current=>{
    const result=await request('legacy-review-list',{scope}), ids=new Set()
    if(!result||!Array.isArray(result.items)||result.items.some(item=>!item||typeof item.workId!=='string'||!item.workId||ids.has(item.workId)||!['open','ignored','user-accepted'].includes(item.choice)||!Number.isSafeInteger(item.revision)||item.revision<0||typeof item.owner!=='string'||typeof item.sender!=='string'||(ids.add(item.workId),false)))throw Error('Invalid work decisions')
    if(current===epoch.current){setItems(result.items);setIncomplete(result.incomplete!==false)}
  }
  const refresh=async()=>{
    if(active.current)return
    const current=epoch.current;active.current=true;requested.current=true;setBusy(true);setError('')
    try{await fetchItems(current)}catch{if(current===epoch.current){setItems(null);setError(t('Work decisions are unavailable.'))}}
    finally{active.current=false;if(current===epoch.current)setBusy(false)}
  }
  const decide=async(item,choice)=>{
    if(active.current||item.canDecide!==true)return
    if(choice==='user-accepted'&&!globalThis.confirm(t('Record your acceptance of work {id} in {scope}? This does not complete the task or replace independent acceptance.',{id:item.workId,scope:scope.id})))return
    const current=epoch.current;active.current=true;setBusy(true);setError('')
    try{await request('legacy-review-decision',{scope,workId:item.workId,expectedRevision:item.revision,choice});await fetchItems(current)}
    catch{try{await fetchItems(current)}catch{if(current===epoch.current)setItems(null)}if(current===epoch.current)setError(t('Decision outcome may be unknown. Refresh to verify it.'))}
    finally{active.current=false;if(current===epoch.current)setBusy(false)}
  }
  const rows=Array.isArray(items)?items:[], needle=query.trim().toLocaleLowerCase()
  const filtered=rows.filter(item=>matchesRecovery(needle,[item.workId,item.owner,item.sender,actorLabel(item.owner,actors),actorLabel(item.sender,actors)]))
  const open=filtered.filter(item=>item.choice==='open'), handled=filtered.filter(item=>item.choice!=='open'), item=rows.find(row=>row.workId===selected)
  const render=list=>h('div',{className:'bt-recovery-work-groups'},list.map(row=>h('button',{key:row.workId,type:'button',className:'bt-recovery-work-choice',disabled:busy,'aria-pressed':selected===row.workId,onClick:()=>setSelected(row.workId),title:row.workId},`${actorLabel(row.owner,actors)} · ${shortIdentity(row.workId)}`)))
  return h('details',{className:'bt-recovery-panel',onToggle:event=>{if(event.target===event.currentTarget&&event.currentTarget.open&&!requested.current)void refresh()}},
    h('summary',{className:'bt-recovery-summary'},h('span',{className:'bt-recovery-icon','aria-hidden':true},'✓'),h('span',{className:'bt-recovery-summary-text'},h('strong',null,t('Work decisions')),h('small',null,t('Choose an action for an existing work'))),items?h('span',{className:'bt-recovery-count'},rows.filter(row=>row.choice==='open').length):null),
    h('div',{className:'bt-recovery-body'},h('p',{className:'bt-recovery-note'},t('Your choice does not close the work or establish its outcome.')),
      incomplete?h('p',{className:'bt-recovery-warning',role:'status'},t('The recovery list may be incomplete.')):null,
      error?h('p',{className:'bt-recovery-warning',role:'alert'},error):null,
      h('div',{className:'bt-recovery-workspace'},h('div',{className:'bt-recovery-work-list'},h('div',{className:'bt-recovery-list-header'},h('strong',null,t('Needs a decision')),h('button',{type:'button',disabled:busy,onClick:()=>void refresh()},t('Refresh'))),
        rows.length?h('input',{type:'search',value:query,placeholder:t('Filter by Bot or ID'),disabled:busy,onChange:event=>setQuery(event.target.value)}):null,
        items&&open.length===0&&!incomplete?h('p',{className:'bt-recovery-empty'},t('No work needs a decision.')):null,render(open),
        handled.length?h('details',null,h('summary',null,`${t('Handled')} (${handled.length})`),render(handled)):null),
      h('div',{className:'bt-recovery-detail'},item?h('div',{className:'bt-recovery-review'},
        h('div',{className:'bt-recovery-facts'},h(Fact,{label:t('Original work ID'),value:item.workId}),h(Fact,{label:t('Board'),value:scope.id}),h(Fact,{label:t('Sender'),value:actorLabel(item.sender,actors)}),h(Fact,{label:t('Owner'),value:actorLabel(item.owner,actors)})),
        h('p',{className:'bt-recovery-note'},t('The result remains unknown; this is not independent acceptance.')),
        item.canDecide!==true?h('p',{className:'bt-recovery-warning'},t('The original work identity cannot be verified.')):null,
        item.choice==='open'?h('div',null,h('button',{type:'button',disabled:busy||item.canDecide!==true,onClick:()=>void decide(item,'ignored')},t('Ignore')),' ',h('button',{type:'button',disabled:busy||item.canDecide!==true,onClick:()=>void decide(item,'user-accepted')},t('Record my acceptance'))):h('div',null,h('strong',null,t(item.choice==='ignored'?'Ignored':'Accepted by you')),' ',h('button',{type:'button',disabled:busy||item.canDecide!==true,onClick:()=>void decide(item,'open')},t('Move back to needs a decision')))):
        h('p',{className:'bt-recovery-empty'},t('Choose a work to review.'))))))
}
function LegacyWorkReview({ scope, request, actors }) {
  const [workId, setWorkId] = useState(''), [record, setRecord] = useState(null)
  const [summary, setSummary] = useState(''), [evidence, setEvidence] = useState(''), [unfinished, setUnfinished] = useState('')
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [query, setQuery] = useState(''), [uncertain, setUncertain] = useState(false)
  const [candidates, setCandidates] = useState(null)
  const epoch = useRef(0), requested = useRef(false), inFlight = useRef(false)
  const selected = useRef(''), recordFor = useRef(''), uncertainRef = useRef(false)
  useEffect(() => () => { epoch.current += 1 }, [])
  useEffect(() => {
    const onStorage = event => {
      if (event.key && !event.key.startsWith(reviewMarkerPrefix)) return
      try { const pending = reviewMarkers(selected.current).length > 0; uncertainRef.current = pending; setUncertain(pending) }
      catch { uncertainRef.current = true; setUncertain(true) }
    }
    globalThis.addEventListener('storage', onStorage)
    return () => globalThis.removeEventListener('storage', onStorage)
  }, [])
  const clearDraft = () => { setSummary(''); setEvidence(''); setUnfinished('') }
  const run = async (endpoint, body, id = workId) => {
    if (inFlight.current || typeof id !== 'string' || id === '' || selected.current !== id
      || (endpoint !== 'legacy-review-get' && (recordFor.current !== id || uncertainRef.current))) return
    const current = epoch.current
    inFlight.current = true; setBusy(true); setError('')
    let markerKey = '', mutationStarted = false
    try {
      let markers = [], storageAvailable = true
      try { markers = reviewMarkers(id) } catch { storageAvailable = false }
      if (endpoint === 'legacy-review-get') {
        for (const marker of markers) {
          const receipt = await request('legacy-review-operation', { scope: marker.scope, workId: id, operationId: marker.operationId, kind: marker.kind }).catch(() => null)
          if (receipt?.status === 'committed') globalThis.localStorage.removeItem(marker.key)
        }
        if (storageAvailable) markers = reviewMarkers(id)
      } else {
        if (!storageAvailable) throw new Error('Review storage unavailable')
        if (markers.length) throw new Error('Pending review operation')
        const kind = endpoint === 'legacy-review-create' ? 'create' : 'finding'
        const prepared = await request('legacy-review-prepare', { scope, workId: id, kind, ...body })
        if (!reviewOperationPattern.test(prepared?.operationId)) throw new Error('Invalid review operation')
        markerKey = putReviewMarker({ workId: id, operationId: prepared.operationId, kind, scope: { kind: scope.kind, id: scope.id } })
        body = { ...body, operationId: prepared.operationId }
      }
      mutationStarted = endpoint !== 'legacy-review-get'
      const result = await request(endpoint, { scope, workId: id, ...body })
      if (!result || typeof result !== 'object' || Array.isArray(result)
        || (result.workId !== undefined && result.workId !== id)
        || (result.snapshot?.workId !== undefined && result.snapshot.workId !== id)) throw new Error('Review identity changed')
      if (markerKey) globalThis.localStorage.removeItem(markerKey)
      if (current === epoch.current && selected.current === id) {
        recordFor.current = id; setRecord(result)
        uncertainRef.current = !storageAvailable || markers.length > 0; setUncertain(!storageAvailable || markers.length > 0)
        if (!storageAvailable) setError(t('Review storage or verification is unavailable; saving is disabled.'))
        if (markers.length) setError(t('A previous review action is still unconfirmed. Check again before saving.'))
        if (endpoint === 'legacy-review-finding' || (endpoint === 'legacy-review-get' && storageAvailable && !markers.length
          && summary && (result.history ?? []).some(item => item.finding?.summary === summary
            && JSON.stringify(item.finding?.evidenceRefs) === JSON.stringify(evidence.split('\n').map(s => s.trim()).filter(Boolean))
            && JSON.stringify(item.finding?.unfinished) === JSON.stringify(unfinished.split('\n').map(s => s.trim()).filter(Boolean))))) clearDraft()
      }
    } catch {
      if (current === epoch.current && selected.current === id) {
        uncertainRef.current = true; setUncertain(true)
        setError(t(mutationStarted ? 'Action outcome is unknown; check it before making another change.' : 'Review storage or verification is unavailable; saving is disabled.'))
      }
    } finally { inFlight.current = false; if (current === epoch.current) setBusy(false) }
  }
  const list = async () => {
    if (inFlight.current) return
    const current = epoch.current
    inFlight.current = true; requested.current = true; setBusy(true); setError(''); setCandidates(null)
    try {
      const result = await request('legacy-review-list', { scope })
      const ids = new Set()
      if (!result || !Array.isArray(result.items) || result.items.some(item => {
        if (!item || typeof item.workId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(item.workId)
          || typeof item.owner !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(item.owner) || ids.has(item.workId)) return true
        ids.add(item.workId); return false
      })) throw new Error('Invalid review sources')
      if (current === epoch.current) setCandidates({ items: result.items, incomplete: result.incomplete !== false })
    } catch { if (current === epoch.current) { recordFor.current = ''; setRecord(null); setCandidates(null); setError(t('Review sources are unavailable.')) } }
    finally { inFlight.current = false; if (current === epoch.current) setBusy(false) }
  }
  const choose = item => {
    if (inFlight.current || typeof item?.workId !== 'string' || item.workId === '') return
    selected.current = item.workId; recordFor.current = ''
    setWorkId(item.workId); setRecord(null); clearDraft(); void run('legacy-review-get', {}, item.workId)
  }
  const rows = Array.isArray(candidates?.items) ? candidates.items : []
  const needle = query.trim().toLocaleLowerCase()
  const filtered = rows.filter(item => matchesRecovery(needle, [item.workId, item.owner, actorLabel(item.owner, actors)]))
  const groups = recoveryGroups(filtered, item => item.owner, item => actorLabel(item.owner, actors))
  const live = record?.liveRecovery
  return h('details', { className: 'bt-recovery-panel', onToggle: event => {
    if (event.target === event.currentTarget && event.currentTarget.open && !requested.current && !inFlight.current) void list()
  } },
  h('summary', { className: 'bt-recovery-summary' }, h('span', { className: 'bt-recovery-icon', 'aria-hidden': true }, '≡'),
    h('span', { className: 'bt-recovery-summary-text' }, h('strong', null, t('Manual notes (optional)')), h('small', null, t('Review note'))),
    Array.isArray(candidates?.items) ? h('span', { className: 'bt-recovery-count' }, String(rows.length)) : null),
  h('div', { className: 'bt-recovery-body' },
    h('div', { className: 'bt-recovery-intro' }, h('p', null, t('Review notes do not send messages or close work. Sources are unverified; inspect the original records.')),
      h('span', null, t('Only works between existing Bots are currently supported.'))),
    candidates?.incomplete ? h('p', { className: 'bt-recovery-warning', role: 'status' }, t('The recovery list may be incomplete.')) : null,
    error ? h('p', { className: 'bt-recovery-warning', role: 'alert' }, error) : null,
    h('div', { className: 'bt-recovery-workspace' },
      h('div', { className: 'bt-recovery-work-list' },
        h('div', { className: 'bt-recovery-list-header' }, h('strong', null, t('Find works awaiting inspection')),
          h('button', { type: 'button', disabled: busy, onClick: () => void list() }, t('Refresh'))),
        rows.length ? h('label', { className: 'bt-recovery-search' }, h('span', { className: 'bt-recovery-sr' }, t('Filter by Bot or ID')),
          h('input', { type: 'search', value: query, disabled: busy, placeholder: t('Filter by Bot or ID'), onChange: event => setQuery(event.target.value) })) : null,
        busy && candidates === null ? h('p', { className: 'bt-recovery-empty', role: 'status' }, t('Loading…')) : null,
        !busy && candidates !== null && !candidates.incomplete && !rows.length ? h('p', { className: 'bt-recovery-empty', role: 'status' }, t('No work awaiting inspection.')) : null,
        rows.length && !filtered.length ? h('p', { className: 'bt-recovery-empty', role: 'status' }, t('No matching records.')) : null,
        h('div', { className: 'bt-recovery-work-groups' }, groups.map(group => h('section', { key: group.id, className: 'bt-recovery-work-group' },
          h('div', { className: 'bt-recovery-group-title' }, h('strong', null, group.name), h('span', null, group.rows.length)),
          group.rows.map(item => h('button', { key: item.workId, type: 'button', className: 'bt-recovery-work-choice', disabled: busy,
            'aria-pressed': workId === item.workId, onClick: () => choose(item), title: item.workId }, shortIdentity(item.workId))))))),
      h('div', { className: 'bt-recovery-detail' },
        h('div', { className: 'bt-recovery-manual' },
          h('label', null, t('Original work ID'), h('input', { value: workId, disabled: busy, onChange: event => { if (inFlight.current) return; selected.current = event.target.value; recordFor.current = ''; setWorkId(event.target.value); setRecord(null); clearDraft() } })),
          h('button', { type: 'button', disabled: busy || !workId.trim(), onClick: () => { if (inFlight.current) return; const id = workId.trim(), same = selected.current === id && recordFor.current === id; selected.current = id; recordFor.current = ''; setWorkId(id); setRecord(null); if (!same) clearDraft(); void run('legacy-review-get', {}, id) } }, t('Check'))),
        !record && !busy ? h('p', { className: 'bt-recovery-empty' }, t('Choose a work to review.')) : null,
        live ? h('div', { className: 'bt-recovery-snapshot', role: 'status' }, live.available
          ? h('div', null, h('strong', null, t('Recovery snapshot')), ' · ', snapshotTime(live.sampledAt),
            h('div', { className: 'bt-recovery-facts' }, h(Fact, { label: t('Queue'), value: recoveryObservationText(live.observed?.queue) }),
              h(Fact, { label: t('Held records'), value: recoveryObservationText(live.observed?.held) }),
              h(Fact, { label: t('Original sessions'), value: (live.ids ?? []).join(', ') || t('Not known') })))
          : t('Current recovery sources are unavailable.')) : null,
        record?.state === 'not-created' ? h('button', { type: 'button', disabled: busy || uncertain, onClick: () => void run('legacy-review-create', {}) }, t('Create review')) : null,
        record && record.state !== 'not-created' ? h('div', { className: 'bt-recovery-review' },
          h('div', { className: 'bt-recovery-facts' }, h(Fact, { label: t('Status'), value: legacyReviewStateText(record.state) }),
            h(Fact, { label: t('Owner'), value: actorLabel(record.owner, actors) }),
            h(Fact, { label: t('Source snapshot time (UTC)'), value: snapshotTime(record.snapshot?.sampledAt) }),
            h(Fact, { label: t('Original sessions'), value: (record.snapshot?.sources ?? []).map(source => source.sessionId).join(', ') || t('Not known') })),
          record.archived ? h('p', { className: 'bt-recovery-warning', role: 'status' }, t('The original work is unavailable, changed, or its identity is unverified. This record is read only and does not establish the outcome.')) : null,
          h('p', { className: 'bt-recovery-note' }, t('Execution and external effects remain unknown.')),
          !record.archived && ['needs-review', 'evidence-needed'].includes(record.state) ? h('div', { className: 'bt-recovery-form' },
            h('label', null, t('Review note'), h('textarea', { value: summary, disabled: busy || uncertain, onChange: event => { if (!inFlight.current && !uncertainRef.current) setSummary(event.target.value) } })),
            h('label', null, t('Evidence references, one per line'), h('textarea', { value: evidence, disabled: busy || uncertain, onChange: event => { if (!inFlight.current && !uncertainRef.current) setEvidence(event.target.value) } })),
            h('label', null, t('Unfinished items, one per line'), h('textarea', { value: unfinished, disabled: busy || uncertain, onChange: event => { if (!inFlight.current && !uncertainRef.current) setUnfinished(event.target.value) } })),
            h('button', { type: 'button', disabled: busy || uncertain || !summary.trim(), onClick: () => void run('legacy-review-finding', { expectedRevision: record.revision, summary, evidenceRefs: evidence.split('\n').map(s => s.trim()).filter(Boolean), unfinished: unfinished.split('\n').map(s => s.trim()).filter(Boolean) }) }, t('Save review note'))) : null,
          (record.history ?? []).map(item => h('article', { key: item.revision, className: 'bt-recovery-history' }, h(Fact, { label: t('Review note'), value: item.finding.summary }),
            h(Fact, { label: t('Evidence references'), value: item.finding.evidenceRefs.join(', ') }), h(Fact, { label: t('Unfinished items'), value: item.finding.unfinished.join(', ') })))) : null))))
}

const periodicReviewIdentity = (scopeId, goal) => JSON.stringify([scopeId, goal?.id, goal?.reviewAttempt?.id, goal?.revision, goal?.status, goal?.idle, goal?.idleReason, goal?.idleRevision, goal?.reviewAttempt?.state, goal?.reviewAttempt?.at])

// This action only clears a specific periodic inspection's uncertainty fence.
// The host independently rechecks the current goal, attempt, scope and activity.
function PeriodicReviewRecovery({ scope, goal, resolveReview, refreshGoal, currentRoomGoal, initiallyOpen }) {
  const [checking, setChecking] = useState(false), [saving, setSaving] = useState(false)
  const [checkedKey, setCheckedKey] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const generation = useRef(0), scopeGeneration = useRef(0), checkBusy = useRef(false), saveBusy = useRef(false)
  const attempt = goal?.reviewAttempt
  const scopeId = scope.kind === 'room' ? scope.id : ''
  const attemptId = typeof attempt?.id === 'string' ? attempt.id : ''
  const goalId = typeof goal?.id === 'string' ? goal.id : ''
  const identity = periodicReviewIdentity(scopeId, goal)
  const attemptKey = JSON.stringify([scopeId, goalId, attemptId])
  const previousAttempt = useRef(attemptKey)
  if (previousAttempt.current !== attemptKey) { previousAttempt.current = attemptKey; generation.current += 1 }
  useEffect(() => { scopeGeneration.current += 1; setNotice(''); return () => { scopeGeneration.current += 1; generation.current += 1 } }, [scopeId])
  if (!scopeId || (!attempt && !notice && !error)) return null
  const automaticIdle = goal?.idle === true && ['admin-pass', 'nudge-limit'].includes(goal.idleReason)
    && Number.isSafeInteger(goal.idleRevision) && goal.idleRevision === goal.revision
  const eligible = goal?.status === 'active' && goalId && attemptId
    && (['uncertain', 'cancelled-uncertain'].includes(attempt?.state)
      || (attempt?.state === 'admitting' && Number.isFinite(attempt.at) && Date.now() - attempt.at >= 30 * 60 * 1000))
    && (goal.idle !== true || automaticIdle)
  const refresh = async () => {
    if (checkBusy.current || saveBusy.current || typeof refreshGoal !== 'function') return
    const current = generation.current, scopeAtStart = scopeGeneration.current, key = identity
    checkBusy.current = true; setChecking(true); setError(''); setCheckedKey('')
    try {
      const snapshot = await refreshGoal()
      if (generation.current === current) {
        if (periodicReviewIdentity(scopeId, snapshot?.roomsById?.[scopeId]?.goal) === key) setCheckedKey(key)
        else setError(t('Group status changed. Refresh and review the current attempt.'))
      }
    }
    catch { if (generation.current === current) setError(t('Could not refresh the group status.')) }
    finally { checkBusy.current = false; if (scopeGeneration.current === scopeAtStart) setChecking(false) }
  }
  const submit = async () => {
    if (!eligible || checkedKey !== identity
      || checkBusy.current || saveBusy.current || typeof resolveReview !== 'function') return
    let fresh
    try { fresh = currentRoomGoal?.(scopeId) } catch { /* no verified current view */ }
    if (periodicReviewIdentity(scopeId, fresh) !== identity) {
      setCheckedKey(''); setError(t('Group status changed. Refresh and review the current attempt.')); return
    }
    const current = generation.current, scopeAtStart = scopeGeneration.current
    saveBusy.current = true; setSaving(true); setError(''); setNotice('')
    try {
      await resolveReview(goalId, attemptId)
      if (scopeGeneration.current === scopeAtStart) setNotice(`${t('Request accepted. Refresh to verify the current review status.')} ${t('Review ID')}: ${attemptId}`)
      if (generation.current === current) setCheckedKey('')
    } catch (err) {
      if (generation.current === current) setCheckedKey('')
      if (scopeGeneration.current === scopeAtStart) setError(['bot/stale', 'bot/invalid', 'bot/refused', 'bot/read-only'].includes(err?.code)
        ? t('The goal changed or related work is still pending. Check it before recovery.')
        : t('Action outcome is unknown; check it before making another change.'))
    } finally { saveBusy.current = false; if (scopeGeneration.current === scopeAtStart) setSaving(false) }
  }
  const reason = typeof resolveReview !== 'function' ? t('Review recovery is unavailable in this view.')
    : typeof refreshGoal !== 'function' || typeof currentRoomGoal !== 'function' ? t('Group status is unavailable.')
      : !goalId || !attemptId ? t('Review identity is unavailable.')
    : goal?.status !== 'active' ? t('The group goal must be active before reviews can resume.')
      : goal.idle === true && !automaticIdle ? t('The goal is paused or its idle state needs review.')
        : !eligible ? t('This review is not ready to resume. Refresh its status later.')
          : checkedKey !== identity ? t('Refresh the group status before continuing.') : ''
  return h('details', { className: 'bt-recovery-panel bt-periodic-review', open: initiallyOpen || undefined,
    onToggle: event => { if (event.target === event.currentTarget && event.currentTarget.open && checkedKey !== identity && !checkBusy.current) void refresh() } },
    h('summary', { className: 'bt-recovery-summary' }, h('span', { className: 'bt-recovery-icon', 'aria-hidden': true }, '!'),
      h('span', { className: 'bt-recovery-summary-text' }, h('strong', null, t('Periodic review issue')), h('small', null, t('Inspection recovery'))),
      attempt ? h('span', { className: 'bt-recovery-badge' }, t('Status unknown')) : null),
    h('div', { className: 'bt-recovery-body' },
      attempt ? h('div', { className: 'bt-periodic-context' },
        h('p', { className: 'bt-recovery-note' }, t('The previous inspection outcome remains unknown. Allowing future inspections does not confirm its result.')),
        h('p', { className: 'bt-recovery-note' }, t('This only resumes periodic inspections; it does not approve or complete tasks.')),
        h('div', { className: 'bt-recovery-facts' }, h(Fact, { label: t('Group ID'), value: scopeId }),
          h(Fact, { label: t('Goal ID'), value: goalId || t('Unknown') }), h(Fact, { label: t('Review ID'), value: attemptId || t('Unknown') })),
        h('p', { className: 'bt-recovery-warning' }, t('The server also checks the group and administrator sessions for pending work, approvals and subagents.'))) : null,
      h('div', { className: 'bt-recovery-list-header' }, h('span', null, checking ? t('Loading…') : checkedKey === identity ? t('Current status checked') : t('Group status')),
        h('button', { type: 'button', disabled: checking || saving || typeof refreshGoal !== 'function', onClick: () => void refresh() }, t('Refresh status'))),
      notice ? h('p', { className: 'bt-recovery-notice', role: 'status' }, notice) : null,
      error ? h('p', { className: 'bt-recovery-warning', role: 'alert' }, error) : null,
      attempt ? h('div', { className: 'bt-recovery-form' },
        reason ? h('p', { className: 'bt-recovery-note', role: 'status' }, reason) : null,
        h('button', { type: 'button', disabled: !!reason || checking || saving || typeof resolveReview !== 'function', onClick: () => void submit() }, t('Allow future inspections'))) : null))
}

function DependenciesField({ tasks, value, disabled, exclude, onChange }) {
  const options = (Array.isArray(tasks) ? tasks : []).filter(task => task && !task.legacy && typeof task.id === 'string' && task.id !== exclude)
  return h('label', null, t('Dependencies'), h('select', { 'aria-label': t('Dependencies'), multiple: true, value, disabled,
    onChange: event => onChange([...event.target.selectedOptions].map(option => option.value)) },
  options.map(task => h('option', { key: task.id, value: task.id }, `${textValue(task.title) || t('Shared task')} · ${task.id}`))))
}

function CreateTask({ disabled, actors, tasks, onCreate, defaultOwner = '' }) {
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [owner, setOwner] = useState(defaultOwner)
  const [reviewer, setReviewer] = useState('')
  const [acceptance, setAcceptance] = useState('')
  const [dependencies, setDependencies] = useState([])
  const valid = title.trim() && owner.trim() && reviewer.trim() && acceptance.trim() && owner.trim() !== reviewer.trim()
  if (!open) return h('button', { className: 'bt-board-primary', type: 'button', disabled, onClick: () => setOpen(true) }, h('span', { 'aria-hidden': 'true' }, '+ '), t('Create task'))
  const field = (label, value, update) => h('label', null, t(label), h('input', { 'aria-label': t(label), value, disabled, onChange: event => update(event.target.value) }))
  const actorField = (label, value, update) => Array.isArray(actors)
    ? h('label', null, t(label), h('select', { 'aria-label': t(label), value, disabled, onChange: event => update(event.target.value) },
      h('option', { value: '' }, t('Choose a Bot')),
      actors.filter(actor => typeof actor?.id === 'string').map(actor => h('option', { key: actor.id, value: actor.id }, actor.name || actor.id))))
    : field(label, value, update)
  return h('form', { className: 'bt-board-create', onSubmit: event => {
    event.preventDefault()
    if (!valid || disabled) return
    void onCreate({ title: title.trim(), owner: owner.trim(), reviewer: reviewer.trim(), acceptance: acceptance.trim(),
      dependencies }).then(result => {
      if (result !== 'committed') return
      setTitle(''); setOwner(defaultOwner); setReviewer(''); setAcceptance(''); setDependencies([]); setOpen(false)
    })
  } },
  h('p', null, t('New tasks start in Preparing.')),
  field('Title', title, setTitle), actorField('Owner ID', owner, setOwner), actorField('Independent reviewer ID', reviewer, setReviewer),
  field('Acceptance criteria', acceptance, setAcceptance), h(DependenciesField, { tasks, value: dependencies, disabled, onChange: setDependencies }),
  h('div', null, h('button', { type: 'submit', disabled: disabled || !valid }, t('Submit proposal')), ' ',
    h('button', { type: 'button', disabled, onClick: () => setOpen(false) }, t('Cancel'))))
}

function EditTask({ task, actors, tasks, disabled, onEdit }) {
  const [open, setOpen] = useState(false)
  const [base, setBase] = useState(task.revision)
  const [draft, setDraft] = useState({})
  const reset = () => {
    setBase(task.revision)
    setDraft({ title: textValue(task.title), owner: asText(task.owner), reviewer: asText(task.reviewer),
      acceptance: textValue(task.acceptance), dependencies: (task.dependencies ?? []).map(asText).filter(Boolean) })
  }
  const changed = task.revision !== base
  const valid = draft.title?.trim() && draft.owner?.trim() && draft.reviewer?.trim() && draft.acceptance?.trim() && draft.owner !== draft.reviewer
  if (!open) return h('button', { type: 'button', disabled, onClick: () => { reset(); setOpen(true) } }, t('Edit task'))
  const field = (label, key) => h('label', null, t(label), h('input', { 'aria-label': t(label), value: draft[key] ?? '', disabled, onChange: event => setDraft({ ...draft, [key]: event.target.value }) }))
  const actorField = (label, key) => h('label', null, t(label), h('select', { 'aria-label': t(label), value: draft[key] ?? '', disabled, onChange: event => setDraft({ ...draft, [key]: event.target.value }) },
    h('option', { value: '' }, t('Choose a Bot')),
    actors.filter(actor => typeof actor?.id === 'string').map(actor => h('option', { key: actor.id, value: actor.id }, actor.name || actor.id))))
  return h('form', { className: 'bt-board-actions', onSubmit: event => {
    event.preventDefault()
    if (disabled || changed || !valid) return
    void onEdit({ ...task, revision: base }, { title: draft.title.trim(), owner: draft.owner.trim(), reviewer: draft.reviewer.trim(),
      acceptance: draft.acceptance.trim(), dependencies: draft.dependencies }).then(result => {
      if (result === 'committed') setOpen(false)
    })
  } },
  changed ? h('div', { role: 'alert' }, t('Task changed. Reload its current values before saving.'), ' ',
    h('button', { type: 'button', disabled, onClick: reset }, t('Reload values'))) : null,
  field('Title', 'title'), actorField('Owner ID', 'owner'), actorField('Independent reviewer ID', 'reviewer'),
  field('Acceptance criteria', 'acceptance'), h(DependenciesField, { tasks, exclude: task.id, value: draft.dependencies ?? [], disabled, onChange: value => setDraft({ ...draft, dependencies: value }) }),
  h('div', null, h('button', { type: 'submit', disabled: disabled || changed || !valid }, t('Save changes')), ' ',
    h('button', { type: 'button', disabled, onClick: () => setOpen(false) }, t('Cancel'))))
}

function CardDetails({task,editable,disabled,onEdit}) {
  const [open,setOpen]=useState(false),[base,setBase]=useState(()=>cardStamp(task)),[draft,setDraft]=useState({}),[entry,setEntry]=useState('')
  const reset=()=>{setBase(cardStamp(task));setEntry('');setDraft({description:textValue(task.description),dueDate:textValue(task.dueDate),labels:(Array.isArray(task.labels)?task.labels:[]).join('\n'),checklist:(Array.isArray(task.checklist)?task.checklist:[]).map(item=>({...item}))})}
  const checklist=Array.isArray(task.checklist)?task.checklist:[]
  const labels=Array.isArray(task.labels)?task.labels:[]
  const changed=!sameCardStamp(task,base)
  const labelValues=(draft.labels??'').split('\n').map(value=>value.trim()).filter(Boolean)
  const bytes=value=>new TextEncoder().encode(value).length
  const valid=bytes(draft.description??'')<=8192&&labelValues.length<=20&&new Set(labelValues).size===labelValues.length
    &&labelValues.every(value=>bytes(value)<=40)&&(draft.checklist??[]).length<=100
    &&(draft.checklist??[]).every(item=>item.text.trim()&&bytes(item.text.trim())<=512)
  return h('div',{className:'bt-board-card-details-fields'},
    !open ? h('div',null,
      h(Fact,{label:t('Description'),value:textValue(task.description)}),
      h(Fact,{label:t('Due date'),value:textValue(task.dueDate)}),
      labels.length?h(Fact,{label:t('Labels'),value:labels.join(' · ')}):null,
      checklist.length?h('div',{className:'bt-board-checklist'},h('strong',null,t('Checklist')),
        checklist.map(item=>h('label',{key:item.id},h('input',{type:'checkbox',checked:item.checked===true,disabled:true}),` ${item.text}`))):null,
      editable?h('button',{type:'button',disabled,onClick:()=>{reset();setOpen(true)}},t('Edit card details')):null)
      : h('form',{className:'bt-board-actions',onSubmit:event=>{
        event.preventDefault();if(disabled||changed||!valid)return
        void onEdit(stampedTask(task,base),{description:draft.description,dueDate:draft.dueDate||null,labels:labelValues,checklist:draft.checklist.map(item=>({...item,text:item.text.trim()}))})
          .then(result=>{if(result==='committed')setOpen(false)})
      }},
      changed?h('div',{role:'alert'},t('Task changed. Reload its current values before saving.'),' ',h('button',{type:'button',disabled,onClick:reset},t('Reload values'))):null,
      h('label',null,t('Description'),h('textarea',{'aria-label':t('Description'),value:draft.description??'',disabled,onChange:event=>setDraft({...draft,description:event.target.value})})),
      h('label',null,t('Due date'),h('input',{type:'date','aria-label':t('Due date'),value:draft.dueDate??'',disabled,onChange:event=>setDraft({...draft,dueDate:event.target.value})})),
      h('label',null,t('Labels, one per line'),h('textarea',{'aria-label':t('Labels, one per line'),value:draft.labels??'',disabled,onChange:event=>setDraft({...draft,labels:event.target.value})})),
      h('fieldset',null,h('legend',null,t('Checklist')),
        (draft.checklist??[]).map(item=>h('div',{key:item.id,className:'bt-board-check-row'},
          h('input',{type:'checkbox','aria-label':t('Mark checklist item'),checked:item.checked,disabled,onChange:event=>setDraft({...draft,checklist:draft.checklist.map(row=>row.id===item.id?{...row,checked:event.target.checked}:row)})}),
          h('input',{'aria-label':t('Checklist item'),value:item.text,disabled,onChange:event=>setDraft({...draft,checklist:draft.checklist.map(row=>row.id===item.id?{...row,text:event.target.value}:row)})}),
          h('button',{type:'button',disabled,onClick:()=>setDraft({...draft,checklist:draft.checklist.filter(row=>row.id!==item.id)})},t('Remove')))),
        h('label',null,t('New checklist item'),h('input',{'aria-label':t('New checklist item'),value:entry,disabled,onChange:event=>setEntry(event.target.value)})),
        h('button',{type:'button',disabled:disabled||!entry.trim()||bytes(entry.trim())>512||(draft.checklist??[]).length>=100,onClick:()=>{
          if(!window.crypto?.randomUUID)return
          setDraft({...draft,checklist:[...(draft.checklist??[]),{id:window.crypto.randomUUID(),text:entry.trim(),checked:false}]});setEntry('')
        }},t('Add item'))),
      !valid?h('p',{role:'alert'},t('Check the card details and size limits.')):null,
      h('p',{className:'bt-board-readonly'},t('Checklist items do not complete the task or its dependencies.')),
      h('div',null,h('button',{type:'submit',disabled:disabled||changed||!valid},t('Save changes')),' ',h('button',{type:'button',disabled,onClick:()=>setOpen(false)},t('Cancel')))))
}

function CardConversation({task,commands,disabled,onCommand}) {
  const [text,setText]=useState('')
  const comments=Array.isArray(task.comments)?task.comments:[]
  const activity=Array.isArray(task.boardActivity)?task.boardActivity:[]
  const type=task.legacy?'goal-card-comment':'card-comment'
  const labels={edit:'Task edited',details:'Card details updated','card-details':'Card details updated',comment:'Comment added','card-comment':'Comment added',attach:'Images added','remove-image':'Image removed','personal-progress':'Personal progress updated',share:'Task shared',unshare:'Share revoked'}
  const when=value=>Number.isFinite(value)?new Date(value).toLocaleString():''
  return h('section',{className:'bt-board-conversation'},
    h('strong',null,t('Comments')),
    comments.length?comments.map(comment=>h('div',{key:comment.id,className:'bt-board-comment'},
      h('small',null,`${t('You')} · ${when(comment.at)}`),h('p',null,textValue(comment.text)))):h('p',{className:'bt-board-readonly'},t('No comments yet.')),
    commands.some(command=>command.type===type)?h('form',{onSubmit:event=>{
      event.preventDefault();if(disabled||!text.trim()||new TextEncoder().encode(text)>2048)return
      const submitted=text
      void onCommand(task,{type},{text:submitted}).then(result=>{if(result==='committed')setText(current=>current===submitted?'':current)})
    }},h('label',null,t('Add a comment'),h('textarea',{'aria-label':t('Add a comment'),value:text,disabled,onChange:event=>setText(event.target.value)})),
    h('button',{type:'submit',disabled:disabled||!text.trim()||new TextEncoder().encode(text)>2048},t('Post comment'))):null,
    activity.length?h('details',null,h('summary',null,t('Recent card activity')),
      h('ul',null,activity.map(item=>h('li',{key:item.id},`${when(item.at)} · ${t(labels[item.type]??'Card updated')}`)))):null)
}

function EditGoalTask({task,disabled,onEdit}) {
  const [open,setOpen]=useState(false),[base,setBase]=useState(()=>cardStamp(task)),[title,setTitle]=useState(''),[note,setNote]=useState(''),[status,setStatus]=useState('')
  const reset=()=>{setBase(cardStamp(task));setTitle(textValue(task.legacy?.originalTitle??task.title));setNote(textValue(task.goalNote));setStatus(task.legacy?.originalStatus??'')}
  const changed=!sameCardStamp(task,base),original=task.legacy?.originalStatus,paused=task.legacy?.goalStatus!=='active'
  const titleLocked=['reported','done'].includes(original)
  const next=original==='pending'?'working':original==='working'?'reported':undefined
  const statuses=[original,...(!paused&&next?[next]:[])].filter(Boolean)
  const modified=title.trim()!==textValue(task.legacy?.originalTitle??task.title)||note!==textValue(task.goalNote)||status!==original
  const valid=title.trim()&&modified&&(!status||status===original||note.trim())
  if(!open)return h('button',{type:'button',disabled,onClick:()=>{reset();setOpen(true)}},t('Edit goal task'))
  return h('form',{className:'bt-board-actions',onSubmit:event=>{
    event.preventDefault();if(disabled||changed||!valid)return
    const value={}
    if(title.trim()!==textValue(task.legacy?.originalTitle??task.title))value.title=title.trim()
    if(note!==textValue(task.goalNote)||status!==original)value.note=note
    if(status!==original)value.status=status
    void onEdit(stampedTask(task,base),value).then(result=>{if(result==='committed')setOpen(false)})
  }},
  changed?h('div',{role:'alert'},t('Task changed. Reload its current values before saving.'),' ',h('button',{type:'button',disabled,onClick:reset},t('Reload values'))):null,
  h('label',null,t('Task description'),h('textarea',{'aria-label':t('Task description'),value:title,disabled:disabled||titleLocked,onChange:event=>setTitle(event.target.value)})),
  titleLocked?h('p',{className:'bt-board-readonly'},t('Reported or completed work must be reconciled before changing its description.')):null,
  h('label',null,t('Goal task status'),h('select',{'aria-label':t('Goal task status'),value:status,disabled:disabled||paused,onChange:event=>setStatus(event.target.value)},
    statuses.map(value=>h('option',{key:value,value},t(({pending:'Not started',working:'In progress',reported:'Awaiting review',done:'Done'})[value]??'Status unknown'))))),
  h('label',null,t('Goal task note'),h('textarea',{'aria-label':t('Goal task note'),value:note,disabled:disabled||paused,onChange:event=>setNote(event.target.value)})),
  h('p',{className:'bt-board-readonly'},t('Owner, acceptance and completed status are managed by the group goal.')),
  h('div',null,h('button',{type:'submit',disabled:disabled||changed||!valid},t('Save changes')),' ',h('button',{type:'button',disabled,onClick:()=>setOpen(false)},t('Cancel'))))
}

function EditHistoryTitle({task,disabled,onEdit}) {
  const [open,setOpen]=useState(false),[base,setBase]=useState(()=>cardStamp(task)),[title,setTitle]=useState(''),[reason,setReason]=useState('')
  const reset=()=>{setBase(cardStamp(task));setTitle(textValue(task.title));setReason('')}
  const changed=!sameCardStamp(task,base)
  const valid=title.trim() && title.trim().length<=500 && title.trim()!==task.title && reason.trim() && reason.length<=300
  if(!open)return h('button',{type:'button',disabled,onClick:()=>{reset();setOpen(true)}},t('Correct card title'))
  return h('form',{className:'bt-board-actions',onSubmit:event=>{event.preventDefault();if(disabled||changed||!valid)return
    void onEdit(stampedTask(task,base),{title:title.trim(),reason:reason.trim()}).then(result=>{if(result==='committed')setOpen(false)})}},
    changed?h('div',{role:'alert'},t('Task changed. Reload its current values before saving.'),' ',h('button',{type:'button',disabled,onClick:reset},t('Reload values'))):null,
    h('label',null,t('Card display title'),h('input',{'aria-label':t('Card display title'),value:title,disabled,onChange:event=>setTitle(event.target.value)})),
    h('label',null,t('Reason for correction'),h('textarea',{'aria-label':t('Reason for correction'),value:reason,disabled,onChange:event=>setReason(event.target.value)})),
    h('p',{className:'bt-board-readonly'},t('The original task and acceptance record remain unchanged.')),
    h('div',null,h('button',{type:'submit',disabled:disabled||changed||!valid},t('Save changes')),' ',h('button',{type:'button',disabled,onClick:()=>setOpen(false)},t('Cancel'))))
}

function ShareTask({ task, commands, targets, disabled, onCommand }) {
  const [open, setOpen] = useState(false)
  const [base, setBase] = useState(task.revision)
  const [target, setTarget] = useState('')
  const [includeTitle, setIncludeTitle] = useState(false)
  const canShare = commands.some(command => command.type === 'share') && Array.isArray(targets)
  const canRevoke = commands.some(command => command.type === 'unshare')
  const shares = Array.isArray(task.shares) ? task.shares.filter(share => typeof share?.id === 'string') : []
  if (!canShare && (!canRevoke || !shares.length)) return null
  const changed = open && base !== task.revision
  const targetName = id => targets?.find(item => item?.id === id)?.name || t('Shared group')
  return h('div', { className: 'bt-board-shares' },
    shares.length ? h('div', null, t('Shared with'), shares.map(share => h('div', { className: 'bt-board-share-row', key: share.id },
      h('span', null, targetName(share.targetRoomId)),
      canRevoke ? h('button', { type: 'button', disabled, onClick: () => onCommand(task, { type: 'unshare' }, { shareId: share.id }) }, t('Revoke share')) : null))) : null,
    canShare && !open ? h('button', { type: 'button', disabled, onClick: () => { setBase(task.revision); setTarget(''); setIncludeTitle(false); setOpen(true) } }, t('Share with group')) : null,
    canShare && open ? h('form', { className: 'bt-board-actions', onSubmit: event => {
      event.preventDefault()
      if (disabled || changed || !target || !targets.some(item => item?.id === target)) return
      void onCommand({ ...task, revision: base }, { type: 'share' }, { targetRoomId: target,
        fields: includeTitle ? ['status', 'title'] : ['status'] }).then(result => { if (result === 'committed') setOpen(false) })
    } },
    changed ? h('div', { role: 'alert' }, t('Task changed. Reopen sharing before saving.')) : null,
    h('label', null, t('Target group'), h('select', { 'aria-label': t('Target group'), value: target, disabled, onChange: event => setTarget(event.target.value) },
      h('option', { value: '' }, t('Choose a group')),
      targets.filter(item => typeof item?.id === 'string').map(item => h('option', { key: item.id, value: item.id }, item.name || t('Shared group'))))),
    h('label', { className: 'bt-board-share-check' }, h('input', { type: 'checkbox', checked: includeTitle, disabled, onChange: event => setIncludeTitle(event.target.checked) }), t('Share title too')),
    h('span', null, t('Status is always shared.')),
    h('div', null, h('button', { type: 'submit', disabled: disabled || changed || !target }, t('Share')), ' ',
      h('button', { type: 'button', disabled, onClick: () => setOpen(false) }, t('Cancel')))) : null)
}

function BoardImage({ scope, taskId, image, request, disabled, onRemove, canRemove }) {
  const [url, setUrl] = useState('')
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let live = true
    setUrl(''); setFailed(false)
    request('board-image', { scope, taskId, imageId: image.id }).then(result => {
      if (!live) return
      if (!IMAGE_TYPES.has(result?.mediaType) || typeof result.data !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(result.data)) throw new Error('invalid image')
      setUrl(`data:${result.mediaType};base64,${result.data}`)
    }).catch(() => { if (live) setFailed(true) })
    return () => { live = false }
  }, [scope.kind, scope.id, taskId, image.id])
  return h('div', { className: 'bt-board-photo' }, url ? h('img', { src: url, alt: textValue(image.name) || t('Task image'), onError: () => { setUrl(''); setFailed(true) } })
    : h('span', null, failed ? t('Image unavailable') : t('Loading…')),
  canRemove ? h('button', { type: 'button', disabled, onClick: () => onRemove(taskId, image.id) }, t('Remove image')) : null)
}

function UploadImages({ task, disabled, onUpload }) {
  const [images, setImages] = useState([])
  const [error, setError] = useState('')
  const [base, setBase] = useState(()=>cardStamp(task))
  const changed = images.length > 0 && !sameCardStamp(task,base)
  const urls = useRef(new Set())
  useEffect(() => () => { for (const url of urls.current) URL.revokeObjectURL(url); urls.current.clear() }, [])
  const remove = image => {
    URL.revokeObjectURL(image.url)
    urls.current.delete(image.url)
    setImages(current => current.filter(item => item.uploadId !== image.uploadId))
  }
  const choose = event => {
    const files = [...(event.target.files ?? [])]
    event.target.value = ''
    if (!images.length) setBase(cardStamp(task))
    const count = (Array.isArray(task.images) ? task.images.length : 0) + images.length + files.length
    const bytes = images.reduce((sum, image) => sum + image.file.size, 0) + files.reduce((sum, file) => sum + file.size, 0)
    if (!window.crypto?.randomUUID || count > IMAGE_TASK_MAX_COUNT || images.length + files.length > IMAGE_BATCH_MAX_COUNT || bytes > IMAGE_BATCH_MAX_BYTES || files.some(file => !IMAGE_TYPES.has(file.type) || file.size <= 0 || file.size > IMAGE_MAX_BYTES)) {
      setError(t('Choose non-interlaced PNG or JPEG: up to 20 per task, 10 per batch, 5 MiB each and 20 MiB per batch.')); return
    }
    setError('')
    const fresh = []
    try {
      for (const file of files) {
        const url = URL.createObjectURL(file)
        urls.current.add(url)
        fresh.push({ file, url, uploadId: window.crypto.randomUUID() })
      }
      setImages(current => [...current, ...fresh])
    } catch {
      for (const image of fresh) { URL.revokeObjectURL(image.url); urls.current.delete(image.url) }
      setError(t('Unable to preview images'))
    }
  }
  return h('div', { className: 'bt-board-upload' },
    h('label', null, t('Choose images'), h('input', { type: 'file', multiple: true, accept: 'image/png,image/jpeg', disabled: disabled || changed, onChange: choose })),
    h('span', null, t('Non-interlaced PNG and JPEG are supported.')),
    error ? h('span', { role: 'alert' }, error) : null,
    changed ? h('span', { role: 'alert' }, t('Task changed. Remove selected images and choose them again.')) : null,
    h('div', { className: 'bt-board-images' }, images.map(image => h('div', { className: 'bt-board-photo', key: image.uploadId },
      h('img', { src: image.url, alt: image.file.name }),
      h('button', { type: 'button', disabled, onClick: () => remove(image) }, t('Remove image'))))),
    images.length ? h('button', { type: 'button', disabled: disabled || changed, onClick: () => { void onUpload(stampedTask(task,base), images).then(result => {
      if (result !== 'committed') return
      for (const image of images) { URL.revokeObjectURL(image.url); urls.current.delete(image.url) }
      setImages([])
    }) } }, t('Upload images')) : null)
}

function ColumnRail({label,personal,children}) {
  const rail=useRef(null)
  const move=direction=>{const node=rail.current;if(node)node.scrollBy({left:direction*Math.max(240,node.clientWidth*.8),behavior:'smooth'})}
  return h('div',{className:'bt-board-rail'},
    h('div',{className:'bt-board-rail-controls'},
      h('button',{type:'button','aria-label':t('Previous columns'),onClick:()=>move(-1)},'←'),
      h('button',{type:'button','aria-label':t('Next columns'),onClick:()=>move(1)},'→')),
    h('div',{ref:rail,className:`bt-board-columns${personal?' bt-board-columns-personal':''}`,role:'region','aria-label':label,tabIndex:0,
      onKeyDown:event=>{if(event.target===event.currentTarget && ['ArrowLeft','ArrowRight'].includes(event.key)){event.preventDefault();move(event.key==='ArrowLeft'?-1:1)}}},children))
}

function TaskCard({scope,task,commands,actors,uncertain,onOpen}) {
  const dependencies=Array.isArray(task.dependencies)?task.dependencies.map(asText).filter(Boolean):[]
  const blocker=asText(task.blocked)
  const canMove=commands.some(command=>command.type==='personal-progress')&&PERSONAL_COLUMNS.some(([id])=>id===task.personalProgress)
  const owner=scope.kind==='personal'&&scope.id==='user'&&task.owner==='user'?'':actorLabel(task.owner,actors)
  return h('article', { className: 'bt-board-card', 'data-task-id':task.id, draggable: canMove && !uncertain,
    onDragStart: event => { if (canMove && !uncertain) { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('application/x-ds-bot-personal-task', task.id) } } },
    h('button',{type:'button',className:'bt-board-card-summary',onClick:event=>onOpen(task.id,event.currentTarget)},
      h('strong', { className: 'bt-board-title' }, textValue(task.title) || task.id),
      h('span', { className: 'bt-board-card-meta' }, owner ? h('span', { className:'bt-board-owner' }, owner) : null,
        task.shared ? h('span', { className:'bt-board-chip' }, t('Shared task · read only')) : null,
        blocker ? h('span', { className:'bt-board-chip bt-board-chip-blocked' }, t('Blocked')) : null,
        dependencies.length ? h('span', { className:'bt-board-chip' }, t('{count} dependencies', { count:dependencies.length })) : null,
        task.dueDate ? h('span',{className:'bt-board-chip'},`${t('Due date')}: ${textValue(task.dueDate)}`) : null,
        Array.isArray(task.labels) ? task.labels.slice(0,3).map(label=>h('span',{key:label,className:'bt-board-chip'},label)) : null,
        Array.isArray(task.checklist)&&task.checklist.length ? h('span',{className:'bt-board-chip'},`${task.checklist.filter(item=>item.checked).length}/${task.checklist.length} ${t('Checklist')}`) : null,
        task.images?.length ? h('span', { className:'bt-board-chip' }, t('{count} images', { count:task.images.length })) : null,
        h('span', { className: 'bt-board-open-hint' }, t('View details')))))
}

function TaskCardDialog({scope,task,tasks,commands,actors,targets,uploadEnabled,uncertain,onCommand,onUpload,request,onClose,focusReturn,boardRef,pending,busy,error,onCheck,onCancel,cancelBusy}) {
  const modal=useRef(null)
  const dependencies=Array.isArray(task.dependencies)?task.dependencies.map(asText).filter(Boolean):[]
  const evidence=Array.isArray(task.evidence)?task.evidence.map(asText).filter(Boolean).join(' · '):asText(task.evidence)
  const blocker=asText(task.blocked)
  const canMove=commands.some(command=>command.type==='personal-progress')&&PERSONAL_COLUMNS.some(([id])=>id===task.personalProgress)
  useEffect(()=>{
    const popup=modal.current, backdrop=popup?.parentElement, parent=backdrop?.parentElement
    // Capture before the host shell's keyboard handlers: the inner dialog owns
    // Tab and Escape even if an async save removed the previously focused node.
    const keyDown=event=>{
      if(!popup || !['Tab','Escape'].includes(event.key))return
      event.preventDefault();event.stopImmediatePropagation()
      if(event.key==='Escape'){onClose();return}
      const choices=[...popup.querySelectorAll('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),summary,a[href],[tabindex="0"]')]
        .filter(item=>item.tabIndex>=0 && !item.closest('[inert]') && item.getClientRects().length>0)
      if(!choices.length){popup.focus();return}
      const current=choices.indexOf(document.activeElement)
      const index=event.shiftKey ? (current<=0?choices.length-1:current-1) : (current<0||current===choices.length-1?0:current+1)
      choices[index].focus()
    }
    const keepFocus=event=>{if(popup?.isConnected && !popup.contains(event.target))popup.focus()}
    const previous=new Map()
    const hideBackground=()=>{for(const item of parent?.children??[]){
      if(item===backdrop)continue
      if(!previous.has(item))previous.set(item,{inert:item.inert,hidden:item.getAttribute('aria-hidden')})
      item.inert=true;item.setAttribute('aria-hidden','true')
    }}
    popup?.focus()
    hideBackground()
    const observer=new MutationObserver(hideBackground)
    if(parent)observer.observe(parent,{childList:true})
    window.addEventListener('keydown',keyDown,true)
    document.addEventListener('focusin',keepFocus,true)
    return ()=>{
      window.removeEventListener('keydown',keyDown,true)
      document.removeEventListener('focusin',keepFocus,true)
      observer.disconnect()
      for(const [item,{inert,hidden}] of previous){item.inert=inert;if(hidden===null)item.removeAttribute('aria-hidden');else item.setAttribute('aria-hidden',hidden)}
      const replacement=[...(boardRef.current?.querySelectorAll('[data-task-id]')??[])].find(item=>item.dataset.taskId===task.id)?.querySelector('.bt-board-card-summary')
      if(focusReturn.current?.isConnected)focusReturn.current.focus();else if(replacement)replacement.focus();else boardRef.current?.focus()
    }
  },[])
  return h('div',{className:'bt-card-modal-backdrop',onMouseDown:event=>{if(event.target===event.currentTarget)onClose()}},
    h('section',{ref:modal,className:'bt-card-modal',role:'dialog','aria-modal':'true','aria-label':textValue(task.title)||task.id,tabIndex:-1,onWheel:event=>event.stopPropagation()},
      h('header',{className:'bt-card-modal-header'},h('div',null,h('p',null,t('Task details')),h('h2',null,textValue(task.title)||task.id)),
        h('button',{type:'button','aria-label':t('Close card'),'data-close-card':'true',onClick:onClose},'×')),
      pending?h('div',{className:'bt-card-modal-status',role:'status'},t(busy?'Saving…':'An action needs confirmation.'),' ',
        h('button',{type:'button',onClick:()=>onCheck(pending)},t('Check action')),' ',
        h('button',{type:'button',disabled:cancelBusy,onClick:()=>onCancel(pending)},t('Safely cancel pending request')),
        error?h('p',{role:'alert'},error):null):error?h('div',{className:'bt-card-modal-status',role:'alert'},error):null,
    h('div', { className:'bt-board-card-body' },
    canMove ? h('label', { className:'bt-board-move' }, h('span', null, t('Personal progress')),
      h('select', { 'aria-label':t('Move personal task'), disabled:uncertain, value:task.personalProgress,
        onChange:event => { void onCommand(task, { type:'personal-progress' }, { progress:event.target.value }) } },
      PERSONAL_COLUMNS.map(([id,label]) => h('option', { key:id, value:id }, t(label))))) : null,
    h('span', { className: 'bt-board-id' }, task.id),
    task.legacy ? h('span', { className: 'bt-board-legacy' }, t(({current:'Current goal task',previous:'Earlier goal stage',future:'Upcoming goal stage',archived:'Archived goal task',closed:'Closed goal task'})[task.legacy.position] ?? (task.legacy.current?'Current goal task':'Earlier goal stage'))) : null,
    task.legacy?.useOverlay ? h(Fact,{label:t('Original task description'),value:textValue(task.legacy.originalTitle)}) : null,
    task.legacy?.titleStale ? h('p',{className:'bt-board-pending',role:'status'},t('The original task changed after this display title was corrected. Review the title.')) : null,
    task.legacy?.pending ? h('p',{className:'bt-board-pending',role:'status'},t('A card change is awaiting confirmation in its original board.')) : null,
    task.shared ? h('span', { className: 'bt-board-legacy' }, t('Shared task · read only')) : null,
    task.legacy && !KNOWN.has(task.status) ? h(Fact, { label: t('Original status'), value: textValue(task.legacy.originalStatus) || t('Status unknown') }) : null,
    h(Fact, { label: t('Owner'), value: actorLabel(task.owner, actors) }),
    h(Fact, { label: t('Reviewer'), value: actorLabel(task.reviewer, actors) }),
    h(Fact, { label: t('Acceptance criteria'), value: textValue(task.acceptance) }),
    task.legacy ? h(Fact,{label:t('Goal task note'),value:textValue(task.goalNote)}) : null,
    h(Fact, { label: t('Dependencies'), value: dependencies.join(' · ') }),
    h(Fact, { label: t('Next action'), value: asText(task.nextAction) }),
    h(Fact, { label: t('Blocked'), value: blocker }),
    h(Fact, { label: t('Evidence'), value: evidence }),
    h(Fact, { label: t('Target version'), value: asText(task.authority) }),
    !task.shared ? h(CardDetails,{task,editable:commands.some(command=>command.type===(task.legacy?'goal-card-details':'card-details')),disabled:uncertain,onEdit:(item,value)=>onCommand(item,{type:task.legacy?'goal-card-details':'card-details'},value)}) : null,
    !task.shared ? h(CardConversation,{task,commands,disabled:uncertain,onCommand}) : null,
    !canMove && !commands.some(command=>command.type==='goal-task-edit') ? h('span', { className:'bt-board-readonly' }, t('Status changes are not available for this task.')) : null,
    Array.isArray(task.images) && task.images.length ? h('div', { className: 'bt-board-images' }, task.images.map(image => h(BoardImage, {
      key: image.id, scope, taskId: task.id, image, request, disabled: uncertain,
      canRemove: commands.some(command => command.type === (task.legacy?'goal-image-remove':'remove-image')),
      onRemove: (_, imageId) => onCommand(task, { type: task.legacy?'goal-image-remove':'remove-image' }, { imageId }),
    }))) : null,
    uploadEnabled && commands.some(command => command.type === 'upload') ? h(UploadImages, { task, disabled: uncertain, onUpload }) : null,
    h(ShareTask, { task, commands, targets, disabled: uncertain, onCommand }),
    commands.some(command=>command.type==='goal-history-title') ? h(EditHistoryTitle,{task,disabled:uncertain,onEdit:(item,value)=>onCommand(item,{type:'goal-history-title'},value)}) : null,
    Array.isArray(task.boardHistory)&&task.boardHistory.length ? h('details',{className:'bt-board-history'},h('summary',null,t('Card revision history')),
      task.boardHistory.map(entry=>h('article',{key:entry.operationId},h('strong',null,`${Number.isFinite(entry.at)?new Date(entry.at).toLocaleString():''} · ${t('You')} · ${entry.kind}`),
        entry.reason?h('p',null,entry.reason):null,h('p',null,`${t('Before')}: ${JSON.stringify(entry.before)}`),h('p',null,`${t('After')}: ${JSON.stringify(entry.after)}`)))) : null,
    commands.some(command=>command.type==='goal-task-edit') ? h(EditGoalTask,{task,disabled:uncertain,onEdit:(item,value)=>onCommand(item,{type:'goal-task-edit'},value)}) : null,
    commands.some(command => command.type === 'edit') && Array.isArray(actors)
      ? h(EditTask, { task, actors, tasks, disabled: uncertain, onEdit: (item, value) => onCommand(item, { type: 'edit' }, value) })
      : !commands.some(command => ['goal-task-edit','goal-history-title','goal-card-details','goal-card-comment','goal-image-remove','remove-image', 'share', 'unshare'].includes(command.type) || (uploadEnabled && command.type === 'upload'))
        ? h('span', { className: 'bt-board-readonly' }, t('Read only')) : null)))
}

/** A server-authorized group or personal board. */
export function TaskBoard({ scope, title, close, request = call, goal, resolveReview, refreshGoal, currentRoomGoal, initialReview = false }) {
  const [visible, setVisible] = useState(true)
  const [snapshot, setData] = useState(null)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [selectedCard,setSelectedCard]=useState(null)
  const cardOpener=useRef(null)
  const [pending, setPending] = useState(() => pendingStore(scope)?.current ?? '')
  const [busy, setBusy] = useState(false)
  const [cancelBusy, setCancelBusy] = useState(false)
  const active = useRef(false)
  const generation = useRef(0)
  const loadSequence = useRef(0)
  const dialog = useRef(null)
  const dispose = useRef(null)
  const dismissed = useRef(false)
  const pendingRef = useRef(pending)
  const fetching = useRef(null)
  const cancelling = useRef(null)
  const store = useRef(null)
  const key = `${scope.kind}:${scope.id}`
  // A scope change must hide the old board in the same render, before effects run.
  const data = snapshot?.key === key ? snapshot.value : null

  const current = epoch => active.current && generation.current === epoch
  const load = async (epoch = generation.current, preserveError = false) => {
    const sequence = ++loadSequence.current
    try {
      const next = await request('board-list', { scope })
      if (!current(epoch) || sequence !== loadSequence.current) return
      if (!next || !Array.isArray(next.tasks)) throw new Error(t('Invalid board response'))
      boardColumns(next.tasks)
      setData({ key, value:next })
      if (!pendingRef.current && !preserveError) setError('')
      return true
    } catch (err) { if (current(epoch) && sequence === loadSequence.current) setError(err?.message || t('Unable to load board')) }
    return false
  }
  const settle = async (id, result, epoch) => {
    if (!current(epoch) || pendingRef.current !== id) return
    if (!finalOperation(result?.state)) {
      setError(t('Action outcome is unknown; check it before making another change.'))
      return
    }
    if (result.state === 'rejected') setError(result.message ? hostText(result.message) : t('Action rejected'))
    // A durable receipt settles the request, but the old revision must remain
    // fenced until this scope has successfully loaded a current board. A
    // failed or superseded load keeps the original ID available for recheck.
    const refreshed=await load(epoch,true)
    if(!refreshed || !current(epoch) || pendingRef.current!==id)return
    store.current?.clear()
    pendingRef.current = ''
    setPending('')
    if (fetching.current === id) { fetching.current = null; setBusy(false) }
    if (result.state === 'committed') setError('')
    return result.state
  }
  const check = async (id, epoch = generation.current) => {
    try {
      return await settle(id, await request('board-operation', { scope, operationId: id }), epoch)
    } catch { if (current(epoch) && pendingRef.current === id) setError(t('Action outcome is unknown; check it before making another change.')) }
  }
  const cancel = async id => {
    if (cancelling.current || pendingRef.current !== id) return
    const epoch = generation.current
    const token = Symbol('cancel')
    cancelling.current = token
    setCancelBusy(true)
    try {
      await settle(id, await request('board-operation-cancel', { scope, operationId: id }), epoch)
    } catch { if (current(epoch) && pendingRef.current === id) setError(t('Cancellation outcome is unknown. Check the original action again.')) }
    finally { if (cancelling.current === token) { cancelling.current = null; if (current(epoch)) setCancelBusy(false) } }
  }
  const dismiss = () => {
    if (dismissed.current) return
    dismissed.current = true
    // Dispose first: do not let pending async responses or the Escape handler
    // survive while the host reconciles its owning slot.
    dispose.current?.()
    flushSync(() => setVisible(false))
    close()
  }
  useEffect(() => {
    if (!visible) return undefined
    active.current = true
    const epoch = ++generation.current
    const previousFocus = document.activeElement
    store.current = pendingStore(scope)
    fetching.current = null
    cancelling.current = null
    setBusy(false)
    setCancelBusy(false)
    const operation = store.current?.current ?? ''
    pendingRef.current = operation
    setPending(operation)
    setData(null)
    setError('')
    setSearch('')
    void load(epoch)
    if (operation) void check(operation, epoch)
    dialog.current?.focus()
    const keyDown = event => {
      const modal=dialog.current?.querySelector('.bt-card-modal')
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if(modal)modal.querySelector('[data-close-card]')?.click();else dismiss(); return }
      if (event.key !== 'Tab' || !dialog.current) return
      const root=modal ?? dialog.current
      const focusable = [...root.querySelectorAll('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),summary,a[href],[tabindex="0"]')].filter(item=>!item.closest('[inert]') && item.getClientRects().length>0)
      if (!focusable.length) { event.preventDefault(); root.focus(); return }
      const index = focusable.indexOf(document.activeElement)
      if (event.shiftKey && index <= 0) { event.preventDefault(); focusable[focusable.length - 1].focus() }
      else if (!event.shiftKey && (index < 0 || index === focusable.length - 1)) { event.preventDefault(); focusable[0].focus() }
    }
    window.addEventListener('keydown', keyDown)
    let disposed = false
    const cleanup = () => {
      if (disposed) return
      disposed = true
      active.current = false
      generation.current += 1
      window.removeEventListener('keydown', keyDown)
      previousFocus?.focus?.()
    }
    dispose.current = cleanup
    return () => { cleanup(); if (dispose.current === cleanup) dispose.current = null }
  }, [key, visible])

  const run = async (task, command, value) => {
    if (fetching.current || pendingRef.current || !store.current || !window.crypto?.randomUUID) return
    const operationId = `${command.type.startsWith('goal-')?'goal:':''}${window.crypto.randomUUID()}`
    fetching.current = operationId
    const epoch = generation.current
    try {
      // Persist before the network call; if persistence is blocked, do not send.
      store.current.put(operationId)
      pendingRef.current = operationId
      setPending(operationId)
      setBusy(true)
      await request('board-command', { scope, operationId, taskId: task.id,
        ...(Number.isSafeInteger(task.revision) ? { expectedRevision: task.revision } : {}),
        ...(task.legacy?.useOverlay ? {expectedBoardRevision:task.legacy.boardRevision,expectedPosition:task.legacy.position} : {}),
        type: command.type, ...(value !== undefined ? { value } : {}) })
      return await check(operationId, epoch)
    } catch (err) {
      if (current(epoch) && pendingRef.current === operationId) return await check(operationId, epoch)
      if (current(epoch) && !pendingRef.current && fetching.current === operationId) setError(err?.message || t('Unable to save action'))
    } finally { if (fetching.current === operationId) { fetching.current = null; if (current(epoch)) setBusy(false) } }
  }
  const upload = async (task, images) => {
    if (fetching.current || pendingRef.current || !store.current || !window.crypto?.randomUUID) return
    const epoch = generation.current
    const token = Symbol('upload')
    let operationId
    fetching.current = token
    setBusy(true)
    try {
      const encoded = await Promise.all(images.map(image => new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onerror = () => reject(new Error(t('Unable to read image')))
        reader.onload = () => {
          const data = String(reader.result ?? '').split(',')[1]
          if (!data || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) reject(new Error(t('Unable to read image')))
          else resolve({ uploadId: image.uploadId, mediaType: image.file.type, name: image.file.name, data })
        }
        reader.readAsDataURL(image.file)
      })))
      if (!current(epoch)) return
      operationId = `${task.legacy?'goal:':''}${window.crypto.randomUUID()}`
      store.current.put(operationId)
      pendingRef.current = operationId
      fetching.current = operationId
      setPending(operationId)
      await request('board-upload', { scope, taskId: task.id, expectedRevision: task.revision, ...(task.legacy?.useOverlay ? {expectedBoardRevision:task.legacy.boardRevision,expectedPosition:task.legacy.position} : {}), operationId, images: encoded })
      return await check(operationId, epoch)
    } catch (err) {
      if (current(epoch) && operationId && pendingRef.current === operationId) return await check(operationId, epoch)
      if (current(epoch) && !pendingRef.current && (fetching.current === token || fetching.current === operationId)) setError(err?.message || t('Image upload failed'))
    } finally { if (fetching.current === token || fetching.current === operationId) { fetching.current = null; if (current(epoch)) setBusy(false) } }
  }
  const canAct = !!store.current && !!window.crypto?.randomUUID && !pending && !busy
  const commandMap = data?.capabilities?.commands ?? {}
  const capacity = data?.capabilities
  const showCapacity = Number.isSafeInteger(capacity?.taskCount) && capacity.taskCount >= 0
    && Number.isSafeInteger(capacity?.taskLimit) && capacity.taskLimit > 0
  const capacityReached = capacity?.taskLimitReached === true
  const hasLegacy = data?.tasks?.some(task => task.legacy) === true
  const needle = search.trim().toLocaleLowerCase()
  const filtered = (data?.tasks ?? []).filter(task => !needle || [task.title, task.id, actorLabel(task.owner, data?.capabilities?.actors), actorLabel(task.reviewer, data?.capabilities?.actors)]
    .some(value => textValue(value).toLocaleLowerCase().includes(needle)))
  const personal = scope.kind === 'personal' && scope.id === 'user'
  const personalTasks = personal ? filtered.filter(task => PERSONAL_COLUMNS.some(([id]) => id === task.personalProgress)) : []
  const personalIds = new Set(personalTasks.map(task => task.id))
  const columns = boardColumns(filtered.filter(task => !personalIds.has(task.id)))
  const listed = [...COLUMNS.filter(([status])=>!['legacy-pending','legacy-done'].includes(status)||columns.get(status).length), ...(columns.get('unknown').length ? [['unknown', 'Status unknown']] : [])]
  const commandsFor=task=>!task.shared && Array.isArray(commandMap[task.id]) ? commandMap[task.id].filter(command=>command && typeof command.type==='string') : []
  const card=task=>h(TaskCard,{key:task.id,scope,task,commands:commandsFor(task),actors:data?.capabilities?.actors,uncertain:!canAct,
    onOpen:(id,opener)=>{cardOpener.current=opener;setSelectedCard({key,id})}})
  const selected=selectedCard?.key===key ? data?.tasks?.find(task=>task.id===selectedCard.id) : undefined
  useEffect(()=>{if(selectedCard && (selectedCard.key!==key || (data && !selected)))setSelectedCard(null)},[key,data,selectedCard,selected])
  if (!visible) return null
  return createPortal(h('div', { className: 'bt-board-backdrop' },
    h('section', { ref: dialog, tabIndex: -1, className: 'bt-board-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': title || t('Task board') },
      h('header', { className: 'bt-board-header' }, h('div', null, h('h2', null, title || t('Task board')),
        h('p', null, scope.kind === 'room' ? t('Group task board') : t('Personal task board')),
        showCapacity ? h('p', null, t('Instance task capacity: {count} / {limit}', { count: capacity.taskCount, limit: capacity.taskLimit })) : null),
      h('div', null, h('button', { type:'button', onClick:() => void load() }, t('Refresh')), ' ',
        h('button', { type: 'button', onClick: dismiss }, t('Close')))),
      error ? h('div', { className: 'bt-board-error', role: 'alert' }, error) : null,
      capacityReached ? h('div', { className: 'bt-board-pending', role: 'status' }, t('Task limit reached. New tasks cannot be created.')) : null,
      hasLegacy ? h('div', { className: 'bt-board-pending', role: 'note' }, t('Goal card details can be corrected without changing the original task or acceptance record.')) : null,
      pending ? h('div', { className: 'bt-board-pending', role: 'status' }, t(busy ? 'Saving…' : 'An action needs confirmation.'), ' ',
        h('button', { type: 'button', disabled: cancelBusy, onClick: () => check(pending) }, t('Check action')), ' ',
        h('button', { type: 'button', disabled: cancelBusy, onClick: () => cancel(pending) }, t('Safely cancel pending request'))) : null,
      h('div', { className:'bt-board-toolbar' },
      h('label', { className:'bt-board-search' }, h('span', { className:'bt-board-search-icon', 'aria-hidden':'true' }, '⌕'),
        h('input', { type:'search', 'aria-label':t('Search tasks'), placeholder:t('Search tasks'), value:search, onChange:event => setSearch(event.target.value) })),
      data?.capabilities?.create === true && Array.isArray(data?.capabilities?.actors) ? h(CreateTask, { disabled: !canAct || capacityReached, actors: data.capabilities.actors, tasks: data.tasks,
        defaultOwner:scope.kind === 'personal' ? scope.id : '', onCreate: value => {
        if (!window.crypto?.randomUUID) return Promise.resolve(undefined)
        return run({ id: window.crypto.randomUUID() }, { type: 'create' }, value)
      } }) : null),
      data ? h('div', { className:'bt-board-review-tools' }, h(HeldTurns, { key, recovery: data.recovery, scope, request, onRefresh:() => load() }), h(WorkDecisions, { key, scope, request, actors:data.capabilities?.actors }), h(LegacyWorkReview, { key, scope, request, actors: data.capabilities?.actors }), h(PeriodicReviewRecovery, { key, scope, goal, resolveReview, refreshGoal, currentRoomGoal, initiallyOpen: initialReview }), h(RemoteChanges,{monitor:data.remoteChanges})) : null,
      !data ? h('div', { className: 'bt-board-empty' }, error ? t('Board unavailable') : t('Loading…'),
        error ? h('button', { type: 'button', onClick: () => load() }, t('Retry')) : null)
        : h('div', { className:'bt-board-content' },
        personal ? h('section', { className:'bt-board-section', 'aria-label':t('Personal progress') },
          h('div', { className:'bt-board-section-heading' }, h('h3', null, t('Personal progress')),
            h('p', null, t('Drag a card or use its progress menu.'), ' ', t('Your own progress markers do not complete shared work or unblock dependencies.'))),
          h(ColumnRail, {label:t('Personal progress'),personal:true}, PERSONAL_COLUMNS.map(([progress,label]) => {
            const tasks = personalTasks.filter(task => task.personalProgress === progress)
            const accepts = event => canAct && [...event.dataTransfer.types].includes('application/x-ds-bot-personal-task')
            return h('section', { className:'bt-board-column', key:progress, 'aria-label':t(label), 'data-stage':progress,
              onDragOver:event=>{ if (accepts(event)) { event.preventDefault(); event.dataTransfer.dropEffect='move' } },
              onDrop:event=>{ if (!accepts(event)) return; event.preventDefault(); const id=event.dataTransfer.getData('application/x-ds-bot-personal-task')
                const task=personalTasks.find(item=>item.id===id); if (task && task.personalProgress!==progress && commandMap[task.id]?.some(command=>command.type==='personal-progress')) void run(task,{type:'personal-progress'},{progress}) } },
              h('h3', null, h('span', null,t(label)), h('span', { className:'bt-board-count' },tasks.length)),
              tasks.length ? tasks.map(card) : h('p', { className:'bt-board-drop-hint' },t('Drag a card here')))
          }))) : null,
        !personal || filtered.some(task => !personalIds.has(task.id)) ? h('section', { className:'bt-board-section', 'aria-label':t('Workflow') },
          personal ? h('div', { className:'bt-board-section-heading' },h('h3',null,t('Shared workflow')),h('p',null,t('These statuses reflect the shared task workflow.'))) : null,
          h(ColumnRail, {label:t('Workflow')}, listed.map(([status, label]) => {
          const tasks = columns.get(status)
          return h('section', { className: 'bt-board-column', key: status, 'aria-label': t(label), 'data-stage':status },
            h('h3', null, h('span',null,t(label)), tasks.length ? h('span', { className:'bt-board-count' },tasks.length) : null),
            tasks.length ? tasks.map(card) : h('p', { className:'bt-board-lane-empty' },t('No tasks')))
        }))) : null),
        selected ? h(TaskCardDialog,{key:selected.id,scope,task:selected,tasks:data.tasks,commands:commandsFor(selected),actors:data.capabilities?.actors,
          targets:data.capabilities?.shareTargets?.[selected.id],uploadEnabled:data.capabilities?.upload===true,uncertain:!canAct,onCommand:run,onUpload:upload,request,
          onClose:()=>setSelectedCard(null),focusReturn:cardOpener,boardRef:dialog,pending,busy,error,onCheck:check,onCancel:cancel,cancelBusy}) : null)), document.body)
}

export const TASK_BOARD_CSS = `
.bt-board-launch{position:absolute;right:8px;top:7px;pointer-events:auto;-webkit-app-region:no-drag;color:var(--bt-ink-2);font:inherit;font-size:12px;background:var(--bt-card);border:1px solid var(--bt-line-2);border-radius:8px;padding:4px 8px;cursor:pointer}
.bt-board-backdrop{position:fixed;inset:0;z-index:10000;background:rgba(15,23,42,.46);display:flex;align-items:center;justify-content:center;padding:18px}
.bt-board-dialog{box-sizing:border-box;display:flex;flex-direction:column;height:min(900px,calc(100vh - 36px));max-height:calc(100vh - 36px);width:min(1920px,100%);background:var(--bt-main);color:var(--bt-ink);border:1px solid var(--bt-line);border-radius:16px;box-shadow:0 24px 70px rgba(15,23,42,.25);overflow:hidden}
.bt-board-header{display:flex;justify-content:space-between;align-items:center;gap:16px;padding:20px 26px 16px;border-bottom:1px solid var(--bt-line);flex:none}
.bt-board-header h2{font-size:20px;line-height:1.3;letter-spacing:-.025em;margin:0}.bt-board-header p{font-size:12px;color:var(--bt-ink-2);margin:4px 0 0}
.bt-board-dialog button,.bt-board-dialog select,.bt-board-dialog textarea,.bt-board-dialog input{font:inherit;color:inherit;background:var(--bt-card);border:1px solid var(--bt-line-2);border-radius:8px;padding:7px 10px}
.bt-board-dialog button:disabled,.bt-board-dialog select:disabled{opacity:.5}.bt-board-dialog button:not(:disabled){cursor:pointer}
.bt-board-dialog :is(button,input,select,textarea,summary):focus-visible{outline:2px solid var(--bt-accent);outline-offset:2px}
.bt-board-dialog button:not(:disabled):hover{background:var(--bt-hover)}
.bt-board-dialog button.bt-board-primary{background:var(--bt-accent);color:var(--bt-accent-ink);border-color:transparent;font-weight:600;white-space:nowrap}
.bt-board-dialog button.bt-board-primary:not(:disabled):hover{filter:brightness(.94)}
.bt-board-toolbar{display:flex;align-items:flex-start;gap:12px;flex-wrap:wrap;padding:14px 24px;border-bottom:1px solid var(--bt-line);flex:none}
.bt-board-search{display:flex;align-items:center;gap:8px;min-width:200px;max-width:360px;flex:1;color:var(--bt-ink-2);background:var(--bt-card);border:1px solid var(--bt-line-2);border-radius:8px;padding-left:11px}
.bt-board-search-icon{font-size:20px;line-height:1}.bt-board-dialog .bt-board-search input{min-width:0;width:100%;border:0;background:transparent;outline:none;padding:9px 8px 9px 0}
.bt-board-search:focus-within{outline:2px solid var(--bt-accent);outline-offset:2px}
.bt-board-review-tools{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,230px),1fr));align-items:start;gap:10px;padding:10px 24px;border-bottom:1px solid var(--bt-line);flex:none;max-height:min(46vh,480px);overflow:auto}
.bt-board-recovery-clear{font-size:12px;color:var(--bt-ink-2);padding:10px 0;margin:0}
.bt-board-error,.bt-board-pending{padding:10px 20px;background:var(--bt-danger-soft);font-size:13px}.bt-board-empty{padding:24px}
.bt-board-held{padding:10px 0;overflow:auto;max-height:30vh;font-size:12px}.bt-board-held summary{cursor:pointer;font-weight:600;color:var(--bt-ink-2)}.bt-board-held-record{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:8px;padding:10px 0;border-top:1px solid var(--bt-line);overflow-wrap:anywhere}
.bt-board-review-tools:has(.bt-recovery-panel[open]){max-height:min(68vh,680px)}
.bt-recovery-panel{min-width:0;background:var(--bt-card);border:1px solid var(--bt-line-2);border-radius:12px;box-shadow:0 2px 6px color-mix(in srgb,var(--bt-ink) 5%,transparent)}
.bt-recovery-panel[open]{grid-column:1/-1}.bt-recovery-summary{display:flex;align-items:center;gap:10px;min-width:0;cursor:pointer;list-style:none;padding:12px 14px}.bt-recovery-summary::-webkit-details-marker,.bt-recovery-record-summary::-webkit-details-marker{display:none}
.bt-recovery-summary:focus-visible,.bt-recovery-record-summary:focus-visible,.bt-recovery-work-choice:focus-visible{outline:2px solid var(--bt-accent);outline-offset:2px}.bt-recovery-summary-text{min-width:0;flex:1;display:flex;flex-direction:column;gap:3px}.bt-recovery-summary-text strong{font-size:13px;line-height:1.35}.bt-recovery-summary-text small{font-size:11px;color:var(--bt-ink-2)}
.bt-recovery-icon{display:grid;place-items:center;width:30px;height:30px;flex:none;border-radius:9px;color:var(--bt-accent);background:color-mix(in srgb,var(--bt-accent) 10%,var(--bt-card));font-size:18px}.bt-recovery-count,.bt-recovery-badge{flex:none;padding:3px 7px;border-radius:8px;background:var(--bt-tag-bg);color:var(--bt-ink-2);font-size:11px}.bt-recovery-panel[open]>.bt-recovery-summary{border-bottom:1px solid var(--bt-line)}
.bt-recovery-body{padding:14px;display:flex;flex-direction:column;gap:12px;min-width:0}.bt-recovery-intro{display:flex;justify-content:space-between;align-items:start;gap:12px;flex-wrap:wrap;color:var(--bt-ink-2);font-size:12px;line-height:1.5}.bt-recovery-intro p{margin:0;max-width:680px}.bt-recovery-intro>span{font-size:11px}.bt-recovery-warning{margin:0;padding:9px 11px;border-radius:8px;background:var(--bt-hover);color:var(--bt-ink);font-size:12px;line-height:1.5}
.bt-recovery-search{display:block;max-width:360px}.bt-board-dialog .bt-recovery-search input{box-sizing:border-box;width:100%;padding:8px 10px;background:var(--bt-main);border:1px solid var(--bt-line-2);border-radius:8px;font:inherit;font-size:12px;color:var(--bt-ink)}.bt-recovery-sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}.bt-recovery-empty{margin:0;padding:14px;color:var(--bt-ink-2);font-size:12px;line-height:1.5;background:var(--bt-sidebar);border-radius:8px}
.bt-recovery-groups,.bt-recovery-work-groups{display:flex;flex-direction:column;gap:10px;min-width:0;max-height:250px;overflow:auto}.bt-recovery-group,.bt-recovery-work-group{min-width:0}.bt-recovery-group-title{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:4px 2px;color:var(--bt-ink-2);font-size:11px}.bt-recovery-group-title span{font-variant-numeric:tabular-nums}
.bt-recovery-record{display:block;border:1px solid var(--bt-line);border-radius:9px;padding:0;margin-top:5px;background:var(--bt-main)}.bt-recovery-record-summary{display:flex;align-items:center;gap:10px;list-style:none;cursor:pointer;padding:10px}.bt-recovery-record-id{font:12px ui-monospace,SFMono-Regular,Menlo,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1}.bt-recovery-record-time{font-size:11px;color:var(--bt-ink-2);white-space:nowrap}.bt-recovery-facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,170px),1fr));gap:12px;min-width:0}.bt-recovery-record>.bt-recovery-facts{padding:0 10px 12px}.bt-recovery-facts .bt-board-fact{min-width:0;overflow-wrap:anywhere}
.bt-recovery-workspace{display:grid;grid-template-columns:minmax(180px,260px) minmax(0,1fr);gap:14px;align-items:start;min-width:0}.bt-recovery-work-list,.bt-recovery-detail{display:flex;flex-direction:column;gap:10px;min-width:0}.bt-recovery-work-list{padding:10px;background:var(--bt-sidebar);border-radius:9px}.bt-recovery-list-header{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:12px}.bt-recovery-work-choice{display:block;width:100%;text-align:left;font:12px ui-monospace,SFMono-Regular,Menlo,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:3px}.bt-recovery-work-choice[aria-pressed=true]{background:color-mix(in srgb,var(--bt-accent) 14%,var(--bt-card));border-color:var(--bt-accent)}
.bt-recovery-manual{display:flex;align-items:end;gap:8px}.bt-recovery-manual label{display:flex;flex:1;min-width:0;flex-direction:column;gap:4px;color:var(--bt-ink-2);font-size:12px}.bt-board-dialog .bt-recovery-manual input,.bt-board-dialog .bt-recovery-form textarea{box-sizing:border-box;width:100%;padding:8px 10px;color:var(--bt-ink);background:var(--bt-main);border:1px solid var(--bt-line-2);border-radius:8px;font:inherit}.bt-recovery-snapshot,.bt-recovery-history{padding:12px;background:var(--bt-sidebar);border-radius:9px;font-size:12px;line-height:1.5}.bt-recovery-snapshot .bt-recovery-facts{margin-top:10px}.bt-recovery-review,.bt-recovery-form{display:flex;flex-direction:column;gap:10px}.bt-recovery-note{margin:0;color:var(--bt-ink-2);font-size:12px}.bt-recovery-form label{display:flex;flex-direction:column;gap:4px;font-size:12px}.bt-recovery-form textarea{min-height:54px;resize:vertical}.bt-recovery-form button{align-self:flex-start}.bt-recovery-history{display:grid;gap:8px}.bt-recovery-form .bt-recovery-confirm{flex-direction:row;align-items:flex-start;gap:8px}.bt-recovery-confirm input{flex:none}.bt-periodic-context{display:flex;flex-direction:column;gap:10px}.bt-recovery-notice{margin:0;padding:9px 11px;border-radius:8px;color:var(--bt-ink);background:color-mix(in srgb,var(--bt-green) 14%,var(--bt-card));font-size:12px}
@media(max-width:600px){.bt-recovery-workspace{grid-template-columns:1fr}.bt-recovery-record-summary{flex-wrap:wrap}.bt-recovery-record-time{order:3;width:100%}.bt-recovery-groups,.bt-recovery-work-groups{max-height:190px}}

.bt-board-content{overflow-y:auto;overflow-x:hidden;min-height:0;flex:1;padding:24px 26px 28px;background:radial-gradient(ellipse at 95% 8%,color-mix(in srgb,var(--bt-accent) 25%,transparent),transparent 46%),linear-gradient(145deg,color-mix(in srgb,var(--bt-accent) 18%,var(--bt-main)),color-mix(in srgb,var(--bt-accent) 7%,var(--bt-main)) 70%)}
.bt-board-section+.bt-board-section{margin-top:32px}.bt-board-section-heading{margin:0 0 16px}.bt-board-section-heading h3{font-size:15px;font-weight:700;margin:0}.bt-board-section-heading p{font-size:12px;line-height:1.5;color:var(--bt-ink-2);margin:5px 0 0}
.bt-board-rail{min-width:0}.bt-board-rail-controls{display:flex;justify-content:flex-end;gap:6px;margin-bottom:8px}.bt-board-dialog .bt-board-rail-controls button{min-width:36px;padding:4px 8px;line-height:1.3;font-size:17px}
.bt-board-columns{display:flex;gap:12px;overflow-x:auto;overflow-y:hidden;padding:2px 2px 20px;align-items:flex-start;min-height:190px;scrollbar-width:none;overscroll-behavior-x:contain;touch-action:pan-x pan-y}.bt-board-columns::-webkit-scrollbar{display:none}
.bt-board-column{flex:0 0 280px;min-width:0;border:1px solid color-mix(in srgb,var(--bt-ink) 9%,transparent);border-radius:14px;background:color-mix(in srgb,var(--bt-ink) 7%,var(--bt-card));padding:12px;box-sizing:border-box;box-shadow:0 4px 12px color-mix(in srgb,var(--bt-ink) 9%,transparent)}
.bt-board-columns-personal>.bt-board-column{flex:0 0 300px;min-height:150px}
.bt-board-column h3{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:13px;font-weight:700;margin:4px 4px 14px}.bt-board-count{min-width:20px;padding:2px 6px;text-align:center;background:color-mix(in srgb,var(--bt-ink) 8%,var(--bt-card));color:var(--bt-ink-2);border-radius:8px;font-size:11px;font-weight:600}
.bt-board-column h3>span:first-child{display:flex;align-items:center;gap:8px}.bt-board-column h3>span:first-child:before{content:'';width:8px;height:8px;border-radius:50%;background:var(--bt-ink-3)}
.bt-board-column:is([data-stage=doing],[data-stage=working],[data-stage=reported]) h3>span:first-child:before{background:var(--bt-accent)}
.bt-board-column:is([data-stage=finished],[data-stage=done]) h3>span:first-child:before{background:var(--bt-green)}
.bt-board-lane-empty{font-size:12px;color:var(--bt-ink-3);margin:14px 4px}.bt-board-drop-hint{display:flex;align-items:center;min-height:60px;box-sizing:border-box;border:1px dashed color-mix(in srgb,var(--bt-ink) 20%,transparent);border-radius:9px;color:var(--bt-ink-2);font-size:12px;margin:0;padding:12px}.bt-board-card{background:var(--bt-card);border:1px solid color-mix(in srgb,var(--bt-ink) 8%,transparent);border-radius:10px;margin-bottom:9px;overflow-wrap:anywhere;box-shadow:0 2px 5px color-mix(in srgb,var(--bt-ink) 12%,transparent)}
.bt-board-card[draggable=true]{cursor:grab}.bt-board-card[draggable=true]:active{cursor:grabbing}.bt-board-card:hover{border-color:var(--bt-line-2)}
.bt-board-dialog .bt-board-card-summary{box-sizing:border-box;display:flex;width:100%;text-align:left;background:transparent;border:0;border-radius:10px;padding:11px 12px}
.bt-card-modal-backdrop{position:fixed;inset:0;z-index:10001;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(15,23,42,.52);overscroll-behavior:contain}
.bt-card-modal{box-sizing:border-box;display:flex;flex-direction:column;width:min(860px,100%);max-height:calc(100vh - 48px);overflow:hidden;background:var(--bt-card);color:var(--bt-ink);border:1px solid var(--bt-line);border-radius:16px;box-shadow:0 24px 70px rgba(15,23,42,.3)}
.bt-card-modal-header{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;padding:20px 24px;border-bottom:1px solid var(--bt-line);flex:none}.bt-card-modal-header p{margin:0 0 5px;color:var(--bt-ink-2);font-size:12px}.bt-card-modal-header h2{margin:0;font-size:21px;line-height:1.3;overflow-wrap:anywhere}.bt-card-modal-header button{font-size:22px;line-height:1;min-width:38px}
.bt-card-modal .bt-board-card-body{overflow-y:auto;overflow-x:hidden;overflow-wrap:anywhere;overscroll-behavior:contain;min-height:0;gap:12px;padding:20px 24px 28px}.bt-card-modal .bt-board-actions textarea,.bt-card-modal .bt-board-actions input{box-sizing:border-box;max-width:100%;width:100%}.bt-card-modal-status{padding:10px 24px;background:var(--bt-danger-soft);font-size:13px;overflow-wrap:anywhere}
.bt-board-card-details>summary{list-style:none;cursor:pointer}.bt-board-card-details>summary::-webkit-details-marker{display:none}.bt-board-card-summary{display:flex;flex-direction:column;gap:6px;padding:11px 12px}
.bt-board-conversation{display:flex;flex-direction:column;gap:8px;border-top:1px solid var(--bt-line);padding-top:10px}.bt-board-conversation form,.bt-board-conversation label{display:flex;flex-direction:column;gap:6px}.bt-board-comment{padding:8px;border-radius:8px;background:var(--bt-sidebar);white-space:pre-wrap;overflow-wrap:anywhere}.bt-board-comment p{margin:4px 0 0}.bt-board-comment small{color:var(--bt-ink-2)}
.bt-board-card-meta{display:flex;align-items:center;gap:5px;flex-wrap:wrap}.bt-board-owner,.bt-board-chip{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border-radius:8px;background:var(--bt-tag-bg);color:var(--bt-ink-2);padding:3px 7px;font-size:11px}.bt-board-chip-blocked{color:var(--bt-danger);background:color-mix(in srgb,var(--bt-danger) 10%,var(--bt-card))}
.bt-board-open-hint{font-size:11px;color:var(--bt-ink-2);margin-left:auto}.bt-board-card-details[open] .bt-board-open-hint{display:none}.bt-board-card-body{display:flex;flex-direction:column;gap:8px;padding:0 13px 13px}.bt-board-move{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 0;border-top:1px solid var(--bt-line);font-size:12px;color:var(--bt-ink-2)}.bt-board-dialog .bt-board-move select{max-width:60%;font-size:12px;padding:4px 6px}
.bt-board-title{font-size:14px;line-height:1.4}.bt-board-id{font-size:11px;color:var(--bt-ink-3)}.bt-board-fact{display:flex;flex-direction:column;font-size:12px;gap:2px}.bt-board-fact>:first-child{color:var(--bt-ink-2)}
.bt-board-legacy{font-size:11px;color:var(--bt-ink-2)}
.bt-board-actions{display:flex;flex-direction:column;gap:8px;border-top:1px solid var(--bt-line);padding-top:8px}.bt-board-actions label{display:flex;flex-direction:column;gap:4px;font-size:12px}.bt-board-actions input{font:inherit;color:inherit;background:var(--bt-card);border:1px solid var(--bt-line-2);border-radius:8px;padding:6px 9px}.bt-board-readonly{font-size:11px;color:var(--bt-ink-3)}
.bt-board-shares{display:flex;flex-direction:column;gap:6px;font-size:12px}.bt-board-share-row{display:flex;align-items:center;justify-content:space-between;gap:6px}.bt-board-actions .bt-board-share-check{flex-direction:row;align-items:center}
.bt-board-create{display:flex;gap:10px;flex-wrap:wrap;width:100%;padding:14px;background:var(--bt-sidebar);border:1px solid var(--bt-line);border-radius:10px}.bt-board-create p{width:100%;font-size:12px;margin:0;color:var(--bt-ink-2)}.bt-board-create label{display:flex;flex-direction:column;gap:4px;font-size:12px;flex:1 1 160px}.bt-board-create>div{display:flex;align-items:flex-end;gap:6px}
.bt-board-images{display:flex;gap:6px;flex-wrap:wrap}.bt-board-photo{display:flex;flex-direction:column;gap:4px;max-width:100px;font-size:11px}.bt-board-photo img{width:92px;height:72px;object-fit:cover;border-radius:6px}.bt-board-photo button{font-size:11px;padding:3px}.bt-board-upload{display:flex;flex-direction:column;gap:6px;font-size:12px}.bt-board-upload input{width:100%;font-size:11px}
@media(max-width:600px){.bt-board-backdrop{padding:0}.bt-board-dialog{height:100%;max-height:none;border-radius:0}.bt-board-header{padding:14px 16px}.bt-board-toolbar{padding:12px 16px}.bt-board-review-tools{padding:0 16px}.bt-board-content{padding:16px}.bt-board-column,.bt-board-columns-personal>.bt-board-column{flex:0 0 min(82vw,274px)}.bt-card-modal-backdrop{padding:0}.bt-card-modal{width:100%;height:100dvh;max-height:100dvh;border-radius:0}.bt-card-modal-header{padding:16px}.bt-card-modal .bt-board-card-body{padding:16px 16px 28px}}
`
