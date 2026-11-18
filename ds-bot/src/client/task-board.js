import { createElement as h, useEffect, useRef, useState } from 'react'
import { createPortal, flushSync } from 'react-dom'
import { call } from './api.js'
import { dateLocale, hostText, t } from './i18n.js'
import { CheckIcon, ChevronLeftIcon, ChevronRightIcon, CloseIcon, CopyIcon, PaperclipIcon, PencilIcon, PlusIcon, SearchIcon, TrashIcon, ChatsIcon, ClockIcon, TextIcon } from './icons.js'
import { SPRING_SHAPE } from './motion.js'

// The server supplies already-authorized tasks; never infer membership or filter
// another actor's private tasks in the browser.
// Workflow lanes in the Status view. `ready` is the delivery step between scheduling
// and the Bot starting, so it shares the Waiting lane; goal-card projections are shown
// in their own section rather than as workflow statuses.
const COLUMNS = [
  ['draft', 'Draft'], ['proposed', 'Preparing'], ['waiting', 'Waiting'],
  ['working', 'In progress'], ['reported', 'Awaiting review'], ['done', 'Done'], ['cancelled', 'Cancelled'],
]
// Every status a card can carry, including the delivery step and the goal-card
// projections, for card chips and dialogs.
const STATUS_LABELS = {
  draft:'Draft', proposed:'Preparing', waiting:'Waiting', ready:'Ready', working:'In progress',
  reported:'Awaiting review', done:'Done', 'legacy-pending':'Not started', 'legacy-done':'Goal marked done', cancelled:'Cancelled',
}
const LANE_OF_STATUS = { ready:'waiting' }
const PERSONAL_COLUMNS = [['todo', 'To do'], ['doing', 'Doing'], ['finished', 'Personally finished']]
const TASK_TYPES = [
  ['requirement', 'Requirement'], ['design', 'Design'], ['feature', 'Feature'], ['development', 'Development'],
  ['test', 'Test'], ['deployment', 'Deployment'], ['operations', 'Operations'], ['bugfix', 'Bugfix'],
  ['ui', 'UI design'], ['ux', 'UX'], ['other', 'Other'],
]
const TASK_TYPE_LABELS = Object.fromEntries(TASK_TYPES)
const TASK_TYPE_KEYS = new Set(TASK_TYPES.map(([id]) => id))
const BULK_STATUS_ACTIONS = [
  { id:'submit', label:'Submit', inverse:'cancel' },
  { id:'schedule', label:'Schedule Bot', inverse:'unschedule' },
  { id:'restore', label:'Restore card', inverse:'cancel' },
  { id:'unarchive', label:'Restore from archive', inverse:'archive' },
]
const RELEASE_STATUS_LABELS = { draft:'Draft', queued:'Queued', running:'Running', published:'Published', failed:'Failed', cancelled:'Cancelled' }
const RELEASE_GATES = [['docs', 'Docs'], ['artifacts', 'Artifacts'], ['environment', 'Environment'], ['summary', 'Summary']]
const RELEASE_GATE_KEYS = new Set(RELEASE_GATES.map(([key]) => key))
const RELEASE_GATE_SHORT = { docs:'Docs', artifacts:'Artifacts', environment:'Env', summary:'Summary' }
const RELEASE_GATE_STATUSES = new Set(['pending', 'passed', 'failed'])
const RELEASE_GATE_STATUS_LABELS = { pending:'Pending', passed:'Passed', failed:'Failed' }
// Host role keys stay stable; these labels are the English source copy for them.
const RELEASE_ROLE_LABELS = {
  projectManager:'Project Manager', productManager:'Product Manager', architect:'Architect',
  uiDesigner:'UI Designer', uxDesigner:'UX Designer', frontend:'Frontend Developer', backend:'Backend Developer',
  apiEngineer:'API Engineer', dba:'Database Administrator', tester:'Test Engineer', reviewer:'Independent Reviewer',
  ops:'Operations Engineer',
}
const KNOWN = new Set(COLUMNS.map(([status]) => status))
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg'])
const FILE_TYPES = new Set([...IMAGE_TYPES, 'application/pdf', 'application/zip', 'text/plain', 'text/markdown', 'application/json'])
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
const taskType = task => TASK_TYPE_KEYS.has(task?.type) ? task.type : 'other'
const releaseStatusLabel = value => t(RELEASE_STATUS_LABELS[value] ?? 'Unknown')
const releasePosition = release => typeof release?.position === 'string' ? release.position : ''
const releaseRolesOf = release => release?.roles && typeof release.roles === 'object' && !Array.isArray(release.roles) ? release.roles : {}
const releaseRoleId = (release, key) => textValue(releaseRolesOf(release)[key])
const releaseRoleCount = release => Object.values(releaseRolesOf(release)).filter(id => typeof id === 'string' && id !== '').length
const releaseRoleLabel = role => {
  const label = RELEASE_ROLE_LABELS[role?.key] ?? textValue(role?.label)
  return label ? t(label) : textValue(role?.key)
}
const releaseGateStatus = (release, key) => RELEASE_GATE_KEYS.has(key) && RELEASE_GATE_STATUSES.has(release?.gates?.[key]?.status) ? release.gates[key].status : 'pending'
const releaseGatePassedCount = release => RELEASE_GATES.filter(([key]) => releaseGateStatus(release, key) === 'passed').length
const releaseGatesPassed = release => RELEASE_GATES.every(([key]) => releaseGateStatus(release, key) === 'passed')
const releaseEditable = release => !!release && ['draft', 'queued', 'running'].includes(release.status)
const releaseItemsDone = release => Number.isSafeInteger(release?.itemCount) && release.itemCount > 0 && release?.doneCount === release.itemCount
const formatMoment = value => {
  try { return new Date(value).toLocaleString(dateLocale()) } catch { return '' }
}
const confirmCommands = new Set(['edit', 'card-details', 'goal-task-edit', 'goal-history-title', 'goal-card-details'])
const CONFIRM_FIELD_LABELS = {
  title:'Title', owner:'Owner', reviewer:'Reviewer', acceptance:'Acceptance criteria', dependencies:'Dependencies',
  description:'Description', stage:'Work stage', dueDate:'Due date', dueComplete:'Due date complete', labels:'Labels', checklist:'Checklist',
  coverImageId:'Cover image', type:'Type', note:'Goal task note', status:'Goal task status', reason:'Reason for correction',
}

/** Group task cards into display columns without inferring completion. */
export function boardColumns(tasks) {
  const columns = new Map(COLUMNS.map(([key]) => [key, []]))
  columns.set('unknown', [])
  const seen = new Set()
  for (const task of Array.isArray(tasks) ? tasks : []) {
    if (!task || typeof task.id !== 'string' || !task.id || seen.has(task.id)) throw new Error('Invalid or duplicate task ID')
    seen.add(task.id)
    const lane = LANE_OF_STATUS[task.status] ?? task.status
    columns.get(KNOWN.has(lane) ? lane : 'unknown').push(task)
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
const shortIdentity = value => typeof value !== 'string' ? t('Unknown') : value.length > 32 ? `${value.slice(0, 20)}…{value.slice(-8)}` : value
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

function HeldRecord({ item, scope, request, busy, decide }) {
  const [candidate, setCandidate] = useState(null), [loading, setLoading] = useState(false), [error, setError] = useState('')
  const generation = useRef(0), key = JSON.stringify([scope.kind, scope.id, item.recoveryId]), currentKey = useRef(key)
  if (currentKey.current !== key) { currentKey.current = key; generation.current += 1 }
  useEffect(() => { setCandidate(null); setLoading(false); setError(''); return () => { generation.current += 1 } }, [key])
  const clear = () => { generation.current += 1; setCandidate(null); setLoading(false); setError('') }
  const inspect = async () => {
    if (loading) return
    const at = ++generation.current
    setLoading(true); setCandidate(null); setError('')
    try {
      const result = await request('board-redo-preview', { scope, recoveryId:item.recoveryId })
      if (at !== generation.current) return
      if (!result || result.recoveryId !== item.recoveryId || result.sessionId !== item.sessionId) throw Error('candidate changed')
      const legacy = result.kind === 'unverified-legacy-candidate'
      const parts = legacy ? result.textSegments : result.content?.map(part => part?.type === 'text' ? part.text : null)
      if ((legacy && (result.producerVerified !== false || result.executeAllowed !== false)) || (!legacy && result.execution !== 'disabled')
        || !Array.isArray(parts) || parts.length === 0 || parts.some(part => typeof part !== 'string')
        || parts.reduce((length, part) => length + part.length, 0) > 65536) throw Error('candidate unavailable')
      setCandidate({ parts, legacy, snapshot:result.snapshotOnly === true, key })
    } catch { if (at === generation.current) setError(t('Candidate text is unavailable. The record may be missing, incomplete or changing.')) }
    finally { if (at === generation.current) setLoading(false) }
  }
  return h('details', { className:'bt-board-held-record bt-recovery-record', onToggle:event => { if (event.target === event.currentTarget && !event.currentTarget.open) clear() } },
    h('summary', { className:'bt-recovery-record-summary' }, h('span', { className:'bt-recovery-record-id', title:item.sessionId }, shortIdentity(item.sessionId)),
      h('span', { className:'bt-recovery-record-time' }, Number.isSafeInteger(item.startedAt) ? snapshotTime(item.startedAt) : t('Unknown')),
      h('span', { className:'bt-recovery-badge' }, t(item.decision === 'ignored' ? 'Ignored' : 'Status unknown'))),
    h('div', { className:'bt-recovery-facts' }, h(Fact, { label:t('Session ID'), value:item.sessionId }),
      h(Fact, { label:t('Original turn'), value:Number.isSafeInteger(item.turn) ? String(item.turn) : t('Unknown') }),
      h(Fact, { label:t('Exchange ID'), value:item.exchangeId || t('Unknown') }), h(Fact, { label:t('Recovery ID'), value:item.recoveryId })),
    h('p', { className:'bt-recovery-note' }, t('Ignoring keeps the record and does not complete the work.')),
    item.redo?.status === 'unknown' ? h('p', { className:'bt-recovery-note', role:'status' }, t('A separate redo record exists. Its execution and result are unknown; the original work remains unresolved.')) : null,
    h('p', { className:'bt-recovery-note' }, t('Redo is not available. You can inspect candidate text without sending it.')),
    h('button', { type:'button', disabled:loading, onClick:() => void inspect() }, t(loading ? 'Loading…' : 'View candidate text')),
    error ? h('p', { className:'bt-recovery-warning', role:'alert' }, error) : null,
    candidate?.key === key ? h('div', { className:'bt-recovery-candidate' },
      h('p', { className:'bt-recovery-warning', role:'status' }, t(candidate.legacy
        ? 'This text is only a time-matched candidate. Its sender and original outcome are unverified; it is for inspection and cannot be executed directly.'
        : 'This is a candidate from the persisted log; its original sender is not authenticated. It is for inspection only and cannot be executed.')),
      candidate.snapshot ? h('p', { className:'bt-recovery-note' }, t('This saved snapshot may omit other inputs and may be out of date.')) : null,
      candidate.parts.map((part,index) => h('pre', { key:index, className:'bt-recovery-candidate-text' }, part))) : null,
    h('button', { type:'button', disabled:!!busy, onClick:() => void decide(item, item.decision === 'ignored' ? 'open' : 'ignored') }, t(item.decision === 'ignored' ? 'Undo ignore' : 'Ignore')))
}

const queuedDeliveryStatus = value => value === 'send-outcome-unknown' ? t('Send outcome unknown')
  : value === 'history-unavailable' ? t('Session history unavailable')
    : value === 'seen-in-history' ? t('Exchange found in history')
      : value === 'work-stopped' ? t('Work stopped') : t('Review outcome unknown')
const queuedDeliveryNote = value => value === 'send-outcome-unknown' ? t('The send result is unknown. It will not be sent again automatically.')
  : value === 'history-unavailable' ? t('The relevant Session history could not be read. The same exchange stays held until recovery can check it.')
    : value === 'seen-in-history' ? t('The exchange is present in Session history, but its outcome is unknown. It will not be sent again.')
      : value === 'work-stopped' ? t('The work is stopped or its stop state is unknown. This delivery remains held.')
        : t('The group review outcome is unknown. This delivery remains held.')
const queuedDeliveryRestoreNote = value => value === 'send-outcome-unknown'
  ? t('Restoring review only keeps this unknown send visible; it does not enable a resend.')
  : t('Restoring review lets later recovery check the same exchange; it does not send it now.')

function QueuedDelivery({ item, busy, decide }) {
  return h('article', { className:'bt-recovery-delivery' },
    h('div', { className:'bt-recovery-delivery-heading' }, h('strong', null, item.recipientName),
      h('span', { className:'bt-recovery-badge' }, t(item.decision === 'ignored' ? 'Ignored' : queuedDeliveryStatus(item.status)))),
    h('div', { className:'bt-recovery-facts' }, h(Fact, { label:t('Session ID'), value:item.sessionId }),
      h(Fact, { label:t('Exchange ID'), value:item.exchangeId }),
      h(Fact, { label:t('Queued at'), value:Number.isSafeInteger(item.queuedAt) ? snapshotTime(item.queuedAt) : t('Unknown') })),
    h('p', { className:'bt-recovery-note' }, queuedDeliveryNote(item.status)),
    h('p', { className:'bt-recovery-note' }, t('Ignoring prevents future automatic recovery and does not complete the work.')),
    item.decision === 'ignored' ? h('p', { className:'bt-recovery-note' }, queuedDeliveryRestoreNote(item.status)) : null,
    h('button', { type:'button', disabled:!!busy, onClick:() => void decide(item, item.decision === 'ignored' ? 'open' : 'ignored') },
      t(item.decision === 'ignored' ? 'Undo ignore' : 'Ignore')))
}

// The host provides scoped metadata only. This view never replays or closes work.
function HeldTurns({ recovery, open, onOpen, scope, request, onRefresh }) {
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
  const decideDelivery = async (item, choice) => {
    if (inFlight.current || !Number.isSafeInteger(item.decisionRevision)) return
    inFlight.current = true; setBusy(item.recoveryId); setError('')
    try {
      await request('board-queued-delivery-decision', { scope, recoveryId:item.recoveryId, expectedRevision:item.decisionRevision, choice })
      await onRefresh()
    } catch { setError(t('Decision outcome is unknown. Refresh before trying again.')) }
    finally { inFlight.current = false; setBusy('') }
  }
  const panel = { className:'bt-recovery-panel', open, onToggle:event => {
    if (event.target === event.currentTarget && event.currentTarget.open !== open) onOpen(event.currentTarget.open)
  } }
  const icon = h('span', { className:'bt-recovery-icon', 'aria-hidden':true }, '↻')
  const title = h('strong', null, t('Interrupted work'))
  if (!open || recovery?.available !== true) return h('details', panel,
    h('summary', { className:'bt-recovery-summary' }, icon, h('span', { className:'bt-recovery-summary-text' }, title)),
    open ? h('p', { className:'bt-board-pending', role:'status' }, t(recovery === undefined ? 'Loading…' : 'Recovery records are unavailable or incomplete.')) : null)
  const rows = Array.isArray(recovery.items) ? recovery.items : []
  const needle = query.trim().toLocaleLowerCase()
  const filtered = rows.filter(item => matchesRecovery(needle, [item.botName, item.botId, item.sessionId, item.exchangeId, item.recoveryId]))
  const pendingRows = filtered.filter(item => item.decision !== 'ignored')
  const ignoredRows = filtered.filter(item => item.decision === 'ignored')
  const groups = recoveryGroups(pendingRows, item => item.botId, item => item.botName)
  const deliveries = Array.isArray(recovery.deliveries) ? recovery.deliveries : []
  const filteredDeliveries = deliveries.filter(item => matchesRecovery(needle, [item.recipientName, item.recipientId, item.sessionId, item.exchangeId]))
  const pendingDeliveries = filteredDeliveries.filter(item => item.decision !== 'ignored')
  const ignoredDeliveries = filteredDeliveries.filter(item => item.decision === 'ignored')
  const renderDeliveries = list => h('div', { className:'bt-recovery-deliveries' }, recoveryGroups(list, item => item.recipientId, item => item.recipientName).map(group => h('section', { key:group.id, className:'bt-recovery-group' },
    h('div', { className:'bt-recovery-group-title' }, h('strong', null, group.name), h('span', null, group.rows.length)),
    group.rows.map(item => h(QueuedDelivery, { key:item.recoveryId, item, busy, decide:decideDelivery })))))
  const renderRows = list => h('div', { className: 'bt-recovery-groups' }, recoveryGroups(list, item => item.botId, item => item.botName).map(group => h('section', { key: group.id, className: 'bt-recovery-group' },
    h('div', { className: 'bt-recovery-group-title' }, h('strong', null, group.name), h('span', null, group.rows.length)),
    group.rows.map(item => h(HeldRecord, { key:item.recoveryId, item, scope, request, busy, decide })))))
  return h('details', panel,
    h('summary', { className: 'bt-recovery-summary' }, icon,
      h('span', { className: 'bt-recovery-summary-text' }, title,
        h('small', null, pendingDeliveries.length ? t('{turns} interrupted turns · {messages} queued messages', { turns:pendingRows.length, messages:pendingDeliveries.length })
          : t(rows.length ? 'Choose what to do with each item' : recovery.incomplete ? 'Recovery records are unavailable or incomplete.' : 'No items'))),
      h('span', { className: 'bt-recovery-count' }, recovery.incomplete && !pendingRows.length && !pendingDeliveries.length ? '—' : String(pendingRows.length + pendingDeliveries.length))),
    h('div', { className: 'bt-recovery-body' },
      error ? h('p', { role:'alert', className:'bt-recovery-warning' }, error) : null,
      h('div', { className: 'bt-recovery-intro' },
        h('p', null, t('The outcome is unknown. Your choice does not mark the work complete.')),
        h('span', null, t('Snapshot time (UTC)'), ': ', snapshotTime(recovery.sampledAt))),
      recovery.incomplete ? h('p', { className: 'bt-recovery-warning', role: 'status' }, t('Recovery records are unavailable or incomplete.')) : null,
      rows.length || deliveries.length ? h('label', { className: 'bt-recovery-search' }, h('span', { className: 'bt-recovery-sr' }, t('Filter by Bot or ID')),
        h('input', { type: 'search', value: query, placeholder: t('Filter by Bot or ID'), onChange: event => setQuery(event.target.value) })) : null,
      !rows.length && !deliveries.length && !recovery.incomplete ? h('p', { className: 'bt-recovery-empty', role: 'status' }, t('No interrupted turns in this snapshot.')) : null,
      (rows.length || deliveries.length) && !filtered.length && !filteredDeliveries.length ? h('p', { className: 'bt-recovery-empty', role: 'status' }, t('No matching records.')) : null,
      groups.length ? renderRows(pendingRows) : null,
      ignoredRows.length ? h('details', null, h('summary', null, `${t('Ignored')} (${ignoredRows.length})`), renderRows(ignoredRows)) : null,
      pendingDeliveries.length || ignoredDeliveries.length || recovery.deliveriesIncomplete ? h('section', { className:'bt-recovery-delivery-section' },
        h('div', { className:'bt-recovery-list-header' }, h('strong', null, t('Queued messages awaiting review')), h('span', null, pendingDeliveries.length)),
        h('p', { className:'bt-recovery-note' }, t('Message text is hidden. These exchanges stay held until recovery can verify their delivery status.')),
        recovery.deliveriesIncomplete ? h('p', { className:'bt-recovery-warning', role:'status' }, t('Some queued messages could not be listed.')) : null,
        pendingDeliveries.length ? renderDeliveries(pendingDeliveries) : null,
        ignoredDeliveries.length ? h('details', null, h('summary', null, `${t('Ignored queued messages')} (${ignoredDeliveries.length})`), renderDeliveries(ignoredDeliveries)) : null) : null))
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

const periodicReviewIdentity = (scopeId, goal) => JSON.stringify([scopeId, goal?.id, goal?.reviewAttempt?.id, goal?.revision, goal?.status, goal?.idle, goal?.idleReason, goal?.idleRevision, goal?.reviewAttempt?.state, goal?.reviewAttempt?.at, goal?.reviewAttempt?.terminalFailure?.at])

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
  if (attempt?.terminalFailure) {
    return h('details', { className: 'bt-recovery-panel bt-periodic-review', open: initiallyOpen || undefined },
      h('summary', { className: 'bt-recovery-summary' }, t('Inspection failed before any administrator tool ran')),
      h('div', { className: 'bt-recovery-body' },
        h('p', null, t('The original inspection has been verified. Future inspections will wait until pending group work has cleared.')),
        h('code', null, attemptId)))
  }
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


// --- Board presentation helpers ------------------------------------------------

const IMAGE_CACHE_LIMIT = 80
const boardImageCache = new Map()
const RefreshIcon = () => h('svg', { width: 16, height: 16, viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
  h('path', { d: 'M16 10a6 6 0 1 1-1.76-4.24' }), h('path', { d: 'M16 3.5V7h-3.5' }))
const labelTone = value => {
  let hash = 0
  for (const char of textValue(value)) hash = (hash * 31 + char.codePointAt(0)) % 1009
  return hash % 6
}
const LABEL_TONE_NAMES = ['blue', 'green', 'rose', 'amber', 'violet', 'slate']
const labelToneName = value => LABEL_TONE_NAMES[labelTone(value)]
const initials = value => {
  const text = textValue(value).trim()
  if (!text) return '?'
  const words = text.split(/\s+/).filter(Boolean)
  return (words.length > 1 ? words[0][0] + words[1][0] : [...text][0]).toUpperCase()
}
const relativeTime = value => {
  if (!Number.isFinite(value)) return ''
  const delta = Date.now() - value
  if (delta < 60_000) return t('Just now')
  if (delta < 3_600_000) return t('{count}m ago', { count: Math.floor(delta / 60_000) })
  if (delta < 86_400_000) return t('{count}h ago', { count: Math.floor(delta / 3_600_000) })
  try { return new Date(value).toLocaleDateString(dateLocale(), { month: 'short', day: 'numeric' }) } catch { return '' }
}
const formatDay = value => {
  try { return new Date(value).toLocaleDateString(dateLocale(), { month: 'short', day: 'numeric' }) } catch { return '' }
}
const formatClock = value => {
  try { return new Date(value).toLocaleTimeString(dateLocale(), { hour: '2-digit', minute: '2-digit' }) } catch { return '' }
}
const dueMoment = value => {
  if (typeof value !== 'string') return null
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/.exec(value)
  if (!match) return null
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3])
  const hour = match[4] === undefined ? 23 : Number(match[4])
  const minute = match[5] === undefined ? 59 : Number(match[5])
  const local = new Date(year, month - 1, day, hour, minute, match[4] === undefined ? 59 : 0, match[4] === undefined ? 999 : 0)
  if (!Number.isFinite(local.getTime()) || local.getFullYear() !== year || local.getMonth() !== month - 1 || local.getDate() !== day) return null
  if (match[4] !== undefined && (hour > 23 || minute > 59)) return null
  return local
}
const dueInfo = task => {
  const moment = dueMoment(task.dueDate)
  if (!moment) return null
  const complete = task.dueComplete === true
  const now = Date.now()
  const state = complete ? 'complete' : moment.getTime() < now ? 'overdue' : moment.getTime() - now < 7 * 86_400_000 ? 'soon' : 'normal'
  const day = formatDay(moment)
  const label = task.dueDate.includes('T') ? day + ' ' + formatClock(moment) : day
  return { moment, complete, state, label, title: moment.toLocaleString(dateLocale()) }
}
const dueFilterMatch = (task, filter) => {
  if (!filter) return true
  const info = dueInfo(task)
  if (filter === 'none') return !info
  if (!info) return false
  if (filter === 'overdue') return info.state === 'overdue'
  if (filter === 'soon') return info.state === 'overdue' || info.state === 'soon'
  if (filter === 'complete') return info.complete
  return true
}
const checklistDone = task => Array.isArray(task.checklist) ? task.checklist.filter(item => item?.checked === true).length : 0
const commentsOf = task => Array.isArray(task.comments) ? task.comments : []
const imagesOf = task => Array.isArray(task.images) ? task.images : []
const labelsOf = task => Array.isArray(task.labels) ? task.labels : []
const dependenciesOf = task => Array.isArray(task.dependencies) ? task.dependencies.map(asText).filter(Boolean) : []
const commandOf = (commands, type) => Array.isArray(commands) && commands.some(command => command?.type === type)
const stageLabelOf = task => task?.legacy ? ({current:'Current goal task',previous:'Earlier goal stage',future:'Upcoming goal stage',archived:'Archived goal task',closed:'Closed goal task'})[task.legacy.position] ?? t('Goal task') : t(STATUS_LABELS[task?.status] ?? 'Status unknown')
const actorName = (value, actors) => actorLabel(value, actors) || t('Unknown')
// A closed <details> hides its body but keeps the direct <summary> visible.
// Nested summaries (inside the hidden body) must not enter a focus trap.
const hiddenInClosedDetails = item => {
  const closed = item.closest('details:not([open])')
  if (!closed) return false
  // A summary is the one visible child of its own closed details, unless that
  // details is itself inside another closed details (a nested More actions body).
  if (item.tagName !== 'SUMMARY' || item.parentElement !== closed) return true
  return !!closed.parentElement?.closest('details:not([open])')
}

function useBoardImage(scope, taskId, image, request) {
  const key = scope.kind + ':' + scope.id + ':' + taskId + ':' + (image?.id ?? '')
  const [url, setUrl] = useState(() => boardImageCache.get(key) ?? '')
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (!image?.id) { setUrl(''); setFailed(false); return undefined }
    const cached = boardImageCache.get(key)
    if (cached) { setUrl(cached); setFailed(false); return undefined }
    let live = true
    setUrl(''); setFailed(false)
    request('board-image', { scope, taskId, imageId: image.id }).then(result => {
      if (!live) return
      if (!FILE_TYPES.has(result?.mediaType) || typeof result.data !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(result.data)) throw new Error('invalid attachment')
      const data = 'data:' + result.mediaType + ';base64,' + result.data
      if (boardImageCache.size >= IMAGE_CACHE_LIMIT) boardImageCache.delete(boardImageCache.keys().next().value)
      boardImageCache.set(key, data)
      setUrl(data)
    }).catch(() => { if (live) setFailed(true) })
    return () => { live = false }
  }, [key])
  return { url, failed }
}

function MemberAvatar({ name, size = 22, muted = false }) {
  return h('span', { className: 'bt-board-avatar' + (muted ? ' bt-board-avatar-muted' : ''), style: { width: size, height: size, fontSize: Math.max(11, Math.round(size * 0.42)) }, 'aria-hidden': true }, initials(name))
}

function LabelChip({ label, onRemove, disabled }) {
  return h('span', { className: 'bt-board-label bt-board-label-' + labelToneName(label) },
    h('span', null, label),
    onRemove ? h('button', { type: 'button', className: 'bt-board-label-remove', 'aria-label': t('Remove label {label}', { label }), disabled, onClick: onRemove }, '×') : null)
}

function TypeChip({ type }) {
  const id = TASK_TYPE_KEYS.has(type) ? type : 'other'
  return h('span', { className: 'bt-board-type bt-board-type-' + id, title: t(TASK_TYPE_LABELS[id]) }, t(TASK_TYPE_LABELS[id]))
}

function ReleaseStatusChip({ status }) {
  return h('span', { className: 'bt-board-release-status bt-board-release-status-' + (RELEASE_STATUS_LABELS[status] ? status : 'unknown') }, releaseStatusLabel(status))
}

function ReleaseGateStrip({ release, compact = false }) {
  return h('span', { className: 'bt-board-release-gates' }, RELEASE_GATES.map(([key, label]) => {
    const status = releaseGateStatus(release, key)
    const text = t(compact ? RELEASE_GATE_SHORT[key] : label)
    return h('span', { key, className: 'bt-board-gate bt-board-gate-' + status, title: t(label) + ': ' + t(RELEASE_GATE_STATUS_LABELS[status]) },
      h('span', { className: 'bt-board-gate-dot', 'aria-hidden': true }), text)
  }))
}

const statusValueLabel = value => t(({draft:'Draft',proposed:'Preparing',waiting:'Waiting',ready:'Ready',pending:'Not started',working:'In progress',reported:'Awaiting review',done:'Done',cancelled:'Cancelled'})[value] ?? 'Status unknown')
const displayFieldValue = (value, field, task, actors, tasks) => {
  if (field === 'type') return t(TASK_TYPE_LABELS[value] ?? 'Other')
  if (field === 'status') return statusValueLabel(value)
  if (field === 'owner' || field === 'reviewer') return actorName(value, actors)
  if (field === 'coverImageId') {
    const image = (task?.images ?? []).find(item => item.id === value)
    return value ? textValue(image?.name) || value : t('None')
  }
  if (field === 'dueComplete') return value ? t('Yes') : t('No')
  if (field === 'labels') return Array.isArray(value) && value.length ? value.join(', ') : t('None')
  if (field === 'checklist') return Array.isArray(value) && value.length
    ? value.map(item => (item?.checked === true ? '✓ ' : '') + textValue(item?.text)).join(' · ') : t('None')
  if (field === 'dependencies') return Array.isArray(value) && value.length
    ? value.map(id => textValue((Array.isArray(tasks) ? tasks : []).find(task => task.id === id)?.title) || id).join(', ') : t('None')
  if (value === null || value === undefined || value === '') return t('None')
  if (Array.isArray(value)) return value.length ? value.join(', ') : t('None')
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}
const confirmationRows = (task, command, value, actors, tasks) => {
  const before = command.type === 'goal-task-edit'
    ? { title: textValue(task.legacy?.originalTitle ?? task.title), note: textValue(task.goalNote), status: task.legacy?.originalStatus ?? '' }
    : command.type === 'goal-history-title' ? { title: textValue(task.title), reason: '' } : task
  return Object.keys(value ?? {}).map(field => ({
    field,
    label: CONFIRM_FIELD_LABELS[field] ?? field,
    before: displayFieldValue(field === 'type' ? taskType(task) : before?.[field], field, task, actors, tasks),
    after: displayFieldValue(value[field], field, task, actors, tasks),
  })).filter(row => row.before !== row.after)
}
const proposalRows = (proposal, actors, tasks, releases = []) => {
  const task = (Array.isArray(tasks) ? tasks : []).find(item => item.id === proposal?.taskId)
  const releaseName = id => {
    const release = releases.find(item => item.id === id)
    return release ? [textValue(release.name), textValue(release.version)].filter(Boolean).join(' · ') : textValue(id) || t('None')
  }
  if (proposal?.kind === 'status') {
    const action = proposal.command?.type ?? proposal.after?.type
    return [{ field:'status', label:'Status', before: task ? statusValueLabel(task.status) : t('Unknown'),
      after: t(({submit:'Submit card',cancel:'Cancel card',restore:'Restore card'})[action] ?? 'Status unknown') }]
  }
  if (proposal?.kind === 'release') {
    const target = proposal.command?.value?.releaseId ?? proposal.after?.releaseId
    return [{ field:'releaseId', label:'Release', before: task?.releaseId ? releaseName(task.releaseId) : t('Unassigned'), after: releaseName(target) }]
  }
  const before = proposal?.before && typeof proposal.before === 'object' ? proposal.before : {}
  const after = proposal?.after && typeof proposal.after === 'object' ? proposal.after : {}
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter(field => JSON.stringify(before[field] ?? null) !== JSON.stringify(after[field] ?? null))
    .map(field => ({
      field,
      label: CONFIRM_FIELD_LABELS[field] ?? field,
      before: displayFieldValue(before[field], field, task, actors, tasks),
      after: displayFieldValue(after[field], field, task, actors, tasks),
    }))
}

function DueChip({ task }) {
  const info = dueInfo(task)
  if (!info) return null
  return h('span', { className: 'bt-board-due bt-board-due-' + info.state, title: info.title }, info.complete ? h(CheckIcon) : h(ClockIcon), h('span', null, info.label))
}

function ChecklistProgress({ task, compact = false }) {
  const items = Array.isArray(task.checklist) ? task.checklist : []
  if (!items.length) return null
  const done = checklistDone(task)
  const percent = items.length ? Math.round(done / items.length * 100) : 0
  return h('span', { className: 'bt-board-progress' + (compact ? ' bt-board-progress-compact' : ''), title: done + '/' + items.length },
    h('span', { className: 'bt-board-progress-track' }, h('span', { className: 'bt-board-progress-fill', style: { width: percent + '%' } })),
    h('span', { className: 'bt-board-progress-text' }, done + '/' + items.length))
}

function CardCover({ scope, task, request }) {
  const images = imagesOf(task).filter(item => typeof item.mediaType === 'string' && item.mediaType.startsWith('image/'))
  const image = images.find(item => item.id === task.coverImageId) ?? images[0]
  const state = useBoardImage(scope, task.id, image, request)
  if (!image || state.failed || !state.url) return null
  return h('div', { className: 'bt-board-card-cover', 'aria-hidden': true }, h('img', { src: state.url, alt: '' }))
}

function TaskCard({ scope, task, items, commands, actors, uncertain, dragging, dragEnabled, request, onOpen, onDragStart, onDragEnd, onDragOverCard, selectionMode = false, selected = false, onSelect }) {
  const owner = actorLabel(task.owner, actors)
  const labels = labelsOf(task)
  const dependencies = dependenciesOf(task)
  const info = dueInfo(task)
  const comments = commentsOf(task)
  const images = imagesOf(task)
  const canReorder = commandOf(commands, 'reorder')
  const canMove = commandOf(commands, 'personal-progress') && PERSONAL_COLUMNS.some(([id]) => id === task.personalProgress)
  const canSchedule = commandOf(commands, 'schedule') && ['proposed', 'waiting'].includes(task.status)
  // A ready card shares the Waiting lane; it has no drop target of its own there, so
  // it is not a drag handle (the delivery chips still show its queue state).
  const canDrag = !uncertain && !task.shared && (dragEnabled === true || (task.status !== 'ready' && (canReorder || canMove || canSchedule)))
  const deliveryLabel = task.dispatchState === 'uncertain' ? t('Delivery needs review')
    : task.dispatchState === 'accepted' ? t('Sent to Bot')
      : task.dispatchState === 'claimed' ? t('Preparing delivery')
        : task.dispatchState === 'pending' ? t('Bot queued') : ''
  return h('article', {
    className: 'bt-board-card' + (dragging ? ' bt-board-card-dragging' : ''), 'data-task-id': task.id,
    draggable: canDrag, onDragStart: event => onDragStart?.(task, event), onDragEnd, onDragOver: event => onDragOverCard?.(task, event),
  },
  h(CardCover, { scope, task, request }),
  selectionMode ? h('label', { className: 'bt-board-select', onClick: event => event.stopPropagation() },
    h('input', { type:'checkbox', checked:selected, 'aria-label': t('Select card'), onChange:event => onSelect?.(task.id, event.target.checked) })) : null,
  h('button', { type: 'button', className: 'bt-board-card-summary', onClick: event => onOpen(task.id, event.currentTarget) },
    labels.length ? h('span', { className: 'bt-board-card-labels' }, labels.slice(0, 4).map(label => h(LabelChip, { key: label, label })), labels.length > 4 ? h('span', { className: 'bt-board-card-more-labels' }, '+' + (labels.length - 4)) : null) : null,
    h('strong', { className: 'bt-board-card-title' }, textValue(task.title) || task.id),
    task.progress && task.status === 'working' ? h('span', { className: 'bt-board-card-milestone' },
      h('span', { title: task.progress.summary }, task.progress.summary),
      !task.blocked && !task.stale ? h('span', { title: task.progress.next }, t('Next action'), ' · ', task.progress.next) : null) : null,
    h('span', { className: 'bt-board-card-meta' },
      h(TypeChip, { type: taskType(task) }),
      task.stage ? h('span', {className:'bt-board-chip',title:t('Work stage')}, task.stage) : null,
      info ? h(DueChip, { task }) : null,
      h(ChecklistProgress, { task, compact: true }),
      textValue(task.description) ? h('span', { className: 'bt-board-card-count', title: t('Description') }, h(TextIcon)) : null,
      comments.length ? h('span', { className: 'bt-board-card-count', title: t('Comments') }, h(ChatsIcon), comments.length) : null,
      images.length ? h('span', { className: 'bt-board-card-count', title: t('Attachments') }, h(PaperclipIcon), images.length) : null,
      deliveryLabel ? h('span', { className: 'bt-board-chip' + (task.dispatchState === 'uncertain' ? ' bt-board-chip-blocked' : ''), role: task.dispatchState === 'uncertain' ? 'status' : undefined }, t(deliveryLabel)) : null,
      task.blocked ? h('span', { className: 'bt-board-chip bt-board-chip-blocked' }, t('Blocked')) : null,
      dependencies.length ? h('span', { className: 'bt-board-chip' }, t('{count} dependencies', { count: dependencies.length })) : null,
      task.shared ? h('span', { className: 'bt-board-chip' }, t('Shared task · read only')) : null),
    h('span', { className: 'bt-board-card-foot' },
      h('span', { className: 'bt-board-card-owner' }, h(MemberAvatar, { name: owner || t('You'), size: 22, muted: !owner || owner === t('You') }), h('span', null, owner || t('Unknown'))))),
  items?.length ? h('details', { className:'bt-board-items', open:true },
    h('summary', null, t('Task items'), ' · ', items.filter(item => item.status === 'done' || item.legacy?.originalStatus === 'done').length, '/', items.length),
    h('div', {className:'bt-board-item-list'}, items.map(item => h(TaskItemLink, { key:item.id, item, actors, onOpen })))) : null)
}


const byteLength = value => new TextEncoder().encode(textValue(value)).length

function CreateCardDialog({ laneLabel, parentTaskId, group = false, disabled, actors, tasks, defaultOwner = '', ownerOnly = false, personalProgress, scheduleOnCreate = false, followup = false, defaultDraft = false, initial, onClose, onCreate }) {
  const seed = initial ?? {}
  const seedDetails = seed.details ?? {}
  const draftAllowed = !scheduleOnCreate && personalProgress === undefined && !followup
  const [title, setTitle] = useState(() => textValue(seed.title))
  const [owner, setOwner] = useState(() => textValue(seed.owner) || defaultOwner)
  const [reviewer, setReviewer] = useState(() => textValue(seed.reviewer))
  const [acceptance, setAcceptance] = useState(() => textValue(seed.acceptance))
  const allowedTypes = group && !parentTaskId ? TASK_TYPES.filter(([id]) => ['feature','bugfix'].includes(id)) : TASK_TYPES
  const [type, setType] = useState(() => allowedTypes.some(([id]) => id === seed.type) ? seed.type : parentTaskId ? 'development' : 'feature')
  const [draft, setDraft] = useState(() => draftAllowed && (seed.draft === true || defaultDraft === true))
  const [description, setDescription] = useState(() => textValue(seedDetails.description))
  const [dependencies, setDependencies] = useState(() => Array.isArray(seed.dependencies) ? seed.dependencies.map(asText).filter(Boolean) : [])
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const first = useRef(null)
  useEffect(() => { first.current?.focus() }, [])
  useEffect(() => {
    const onKey = event => { if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); onClose() } }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])
  const candidates = Array.isArray(actors) ? actors.filter(actor => typeof actor?.id === 'string') : []
  const ownerCandidates = candidates.filter(actor => (!ownerOnly || actor.id === defaultOwner) && (!scheduleOnCreate || actor.id !== 'user'))
  const reviewerCandidates = candidates.filter(actor => actor.id !== owner && (!scheduleOnCreate || actor.id !== 'user'))
  useEffect(() => { if (reviewer && reviewer === owner) setReviewer('') }, [owner, reviewer])
  const available = (Array.isArray(tasks) ? tasks : []).filter(task => task && !task.legacy && typeof task.id === 'string' && task.id !== seed.id)
  const unassigned = Boolean(draft && group && parentTaskId && !owner && !reviewer)
  const draftOwner = owner || (ownerOnly ? defaultOwner : (candidates.find(actor => actor.id !== 'user')?.id ?? defaultOwner))
  const draftReviewer = reviewer || candidates.find(actor => actor.id !== draftOwner && actor.id !== 'user')?.id
  const valid = title.trim() && (draft
    ? unassigned || Boolean(draftOwner && draftReviewer && draftOwner !== draftReviewer)
    : Boolean(owner.trim() && reviewer.trim() && acceptance.trim() && owner.trim() !== reviewer.trim()))
    && byteLength(title.trim()) <= 200 && byteLength(acceptance.trim()) <= 8192
    && dependencies.length <= 100 && dependencies.every(id => available.some(task => task.id === id))
    && (!scheduleOnCreate || owner.trim() !== 'user' && reviewer.trim() !== 'user')
  const submit = async event => {
    event.preventDefault()
    if (!valid || disabled || saving) return
    setSaving(true); setError('')
    try {
      const value = { title: title.trim(), owner: draft ? (unassigned ? null : draftOwner) : owner.trim(), reviewer: draft ? (unassigned ? null : draftReviewer) : reviewer.trim(), acceptance: draft ? (acceptance.trim() || 'To be defined.') : acceptance.trim(), dependencies, type,
        ...(draft ? { draft: true } : {}),
        ...(personalProgress !== undefined ? { personalProgress } : {}),
        ...(scheduleOnCreate ? { schedule: true } : {}),
        ...(description.trim() ? { description: description.trim() } : {}),
        ...(seedDetails.dueDate ? { dueDate: seedDetails.dueDate } : {}),
        ...(seedDetails.dueComplete ? { dueComplete: true } : {}),
        ...(Array.isArray(seedDetails.labels) && seedDetails.labels.length ? { labels: seedDetails.labels } : {}),
        ...(Array.isArray(seedDetails.checklist) && seedDetails.checklist.length ? { checklist: seedDetails.checklist } : {}) }
      const result = await onCreate(value)
      if (result === 'committed') onClose()
      else if (result === 'rejected') setError(t('The card was rejected. Check the fields and try again.'))
      else if (result === undefined) setError(t('The card could not be created. Check the board and try again.'))
    } catch (caught) { setError(caught?.message || t('The card could not be created. Check the board and try again.')) }
    finally { setSaving(false) }
  }
  const close = () => { if (!saving) onClose() }
  const heading = t(parentTaskId ? 'Create task item' : 'Create card')
  return h('div', { className: 'bt-card-modal-backdrop bt-create-backdrop', onMouseDown: event => { if (event.target === event.currentTarget) close() } },
    h('section', { className: 'bt-card-modal bt-create-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': heading, tabIndex: -1 },
      h('header', { className: 'bt-card-modal-header' },
        h('div', null, h('p', null, laneLabel ? t('Add to {lane}', { lane: laneLabel }) : t('New card')), h('h2', null, heading)),
        h('button', { type: 'button', className: 'bt-icon-btn', 'aria-label': t('Close'), onClick: close }, h(CloseIcon))),
      h('form', { className: 'bt-create-form', onSubmit: submit },
        h('label', { className: 'bt-field' }, h('span', null, t('Title')), h('input', { ref: first, value: title, disabled: disabled || saving, maxLength: 200, placeholder: t('Card title'), 'aria-label': t('Title'), onChange: event => setTitle(event.target.value) })),
        h('label', { className: 'bt-field' }, h('span', null, t('Type')), h('select', { value: type, disabled: disabled || saving, 'aria-label': t('Task type'), onChange: event => setType(event.target.value) },
          allowedTypes.map(([id, label]) => h('option', { key: id, value: id }, t(label))))),
        h('div', { className: 'bt-create-row' },
          h('label', { className: 'bt-field' }, h('span', null, t('Owner')), h('select', { value: owner, disabled: disabled || saving, 'aria-label': t('Owner'), onChange: event => setOwner(event.target.value) },
            h('option', { value: '' }, t('Choose a Bot')), ownerCandidates.map(actor => h('option', { key: actor.id, value: actor.id }, actor.name || actor.id)))),
          h('label', { className: 'bt-field' }, h('span', null, t('Independent reviewer')), h('select', { value: reviewer, disabled: disabled || saving, 'aria-label': t('Independent reviewer'), onChange: event => setReviewer(event.target.value) },
            h('option', { value: '' }, t('Choose a Bot')), reviewerCandidates.map(actor => h('option', { key: actor.id, value: actor.id }, actor.name || actor.id))))),
        h('label', { className: 'bt-field' }, h('span', null, t('Acceptance criteria')), h('textarea', { value: acceptance, disabled: disabled || saving, rows: 3, placeholder: t('What must be true for this card to be accepted?'), 'aria-label': t('Acceptance criteria'), onChange: event => setAcceptance(event.target.value) })),
        h('label', { className: 'bt-field' }, h('span', null, t('Description (optional)')), h('textarea', { value: description, disabled: disabled || saving, rows: 3, placeholder: t('Add a description to give the Bot more context'), 'aria-label': t('Description'), onChange: event => setDescription(event.target.value) })),
        available.length ? h('fieldset', { className: 'bt-field bt-dependency-field' }, h('legend', null, t('Dependencies')),
          h('div', { className: 'bt-dependency-list' }, available.map(task => h('label', { key: task.id, className: 'bt-dependency-option' },
            h('input', { type: 'checkbox', checked: dependencies.includes(task.id), disabled: disabled || saving, 'aria-label': textValue(task.title) || task.id,
              onChange: event => setDependencies(current => event.target.checked ? [...current, task.id] : current.filter(id => id !== task.id)) }),
            h('span', null, textValue(task.title) || task.id))))) : null,
        draftAllowed ? h('label', { className: 'bt-card-check' }, h('input', { type: 'checkbox', checked: draft, disabled: disabled || saving, 'aria-label': t('Save as draft'), onChange: event => setDraft(event.target.checked) }), t('Save as draft')) : null,
        h('p', { className: 'bt-create-note' }, t(draft
          ? 'Draft cards stay in Draft until they are submitted. A draft can be saved with only a title; owner, reviewer and acceptance can be added later.'
          : personalProgress !== undefined ? 'Personal progress does not dispatch a Bot or complete shared work.'
            : scheduleOnCreate ? 'This card will be sent to its Bot owner when its dependencies are met.'
              : followup ? 'This creates a follow-up in Preparing; reported and completed work cannot be created without evidence.' : 'New cards start in Preparing.')),
        error ? h('p', { className: 'bt-form-error', role: 'alert' }, error) : null,
        h('div', { className: 'bt-create-actions' },
          h('button', { type: 'button', className: 'bt-btn bt-btn-ghost', disabled: saving, onClick: close }, t('Cancel')),
          h('button', { type: 'submit', className: 'bt-btn bt-btn-primary', disabled: disabled || saving || !valid }, t(draft ? 'Save as draft' : scheduleOnCreate ? 'Create and schedule' : followup ? 'Create follow-up' : 'Create card'))))))
}

function CardSection({ title, action, children, className = '' }) {
  if (!children) return null
  return h('section', { className: 'bt-card-section ' + className },
    h('div', { className: 'bt-card-section-head' }, h('h3', null, title), action),
    children)
}

function CardTextEditor({ task, field = 'description', editable, disabled, onSave }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [base, setBase] = useState(null)
  const [error, setError] = useState('')
  const stage = field === 'stage'
  const label = t(stage ? 'Work stage' : 'Description')
  const current = textValue(task[field])
  const start = () => { setBase(cardStamp(task)); setDraft(current); setError(''); setEditing(true) }
  const save = async () => {
    if (!base || disabled) return
    if (byteLength(stage ? draft.trim() : draft) > (stage ? 120 : 8192)) { setError(t(stage ? 'Stage is too long.' : 'Description is too long.')); return }
    const result = await onSave(stampedTask(task, base), { [field]:stage ? draft.trim() : draft })
    if (result === 'committed') setEditing(false)
    else if (result !== 'cancelled') setError(t(stage ? 'The stage could not be saved.' : 'The description could not be saved. Check the board and try again.'))
  }
  const changed = base && !sameCardStamp(task, base)
  const dirty = base && draft !== current
  if (!editable && !current) return null
  return h(CardSection, { title: label, action: editable && !editing ? h('button', { type: 'button', className: 'bt-card-mini', onClick: start }, h(PencilIcon), t(current ? 'Edit' : 'Add')) : null, className: stage ? 'bt-card-work-stage' : 'bt-card-description' },
    editing ? h('div', { className: 'bt-card-editor' },
      changed ? h('p', { className: 'bt-card-warning', role: 'alert' }, t('Task changed. Your draft was kept; reload the current values before saving.'), ' ', h('button', { type: 'button', className: 'bt-card-mini', onClick: start }, t('Reload'))) : null,
      h(stage ? 'input' : 'textarea', { value: draft, rows: stage ? undefined : 6, disabled, 'aria-label': label, onChange: event => { setDraft(event.target.value); setError('') } }),
      error ? h('p', { className: 'bt-form-error', role: 'alert' }, error) : null,
      h('div', { className: 'bt-card-editor-actions' },
        h('button', { type: 'button', className: 'bt-btn bt-btn-ghost', disabled, onClick: () => setEditing(false) }, t('Cancel')),
        h('button', { type: 'button', className: 'bt-btn bt-btn-primary', disabled: disabled || changed || !dirty, onClick: () => void save() }, t('Save'))))
      : current ? h('p', { className: 'bt-card-rich-text' }, current) : h('button', { type: 'button', className: 'bt-card-ghost', onClick: start }, t(stage ? 'Set work stage' : 'Add a more detailed description')))
}

function DueEditor({ task, editable, disabled, legacy, onSave }) {
  const [date, setDate] = useState(() => { const value = textValue(task.dueDate); return value.includes('T') ? value.slice(0, 10) : value })
  const [time, setTime] = useState(() => { const value = textValue(task.dueDate); return value.includes('T') ? value.slice(11, 16) : '' })
  const [complete, setComplete] = useState(task.dueComplete === true)
  const [base, setBase] = useState(null)
  const [error, setError] = useState('')
  useEffect(() => {
    const value = textValue(task.dueDate)
    setDate(value.includes('T') ? value.slice(0, 10) : value)
    setTime(value.includes('T') ? value.slice(11, 16) : '')
    setComplete(task.dueComplete === true)
  }, [task.dueDate, task.dueComplete])
  const info = dueInfo(task)
  if (!editable && !info) return null
  if (!editable) return h('div', { className: 'bt-card-side-block' }, h('h4', null, t('Due date')), h(DueChip, { task }))
  const start = () => { setBase(cardStamp(task)); setError('') }
  const save = async (clear = false) => {
    if (!base || disabled) return
    if (!clear && date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) { setError(t('Choose a valid date.')); return }
    const value = clear ? null : date ? (time ? date + 'T' + time : date) : null
    const payload = legacy ? { dueDate: value } : { dueDate: value, dueComplete: complete }
    const result = await onSave(stampedTask(task, base), payload)
    if (result !== 'committed' && result !== 'cancelled') setError(t('The due date could not be saved.'))
  }
  return h('div', { className: 'bt-card-side-block bt-card-due-editor' },
    h('h4', null, t('Due date')),
    h('div', { className: 'bt-card-due-inputs' },
      h('input', { type: 'date', value: date, disabled, 'aria-label': t('Due date'), onFocus: start, onChange: event => { start(); setDate(event.target.value) } }),
      legacy ? null : h('input', { type: 'time', value: time, disabled, 'aria-label': t('Due time'), onFocus: start, onChange: event => { start(); setTime(event.target.value) } })),
    legacy ? null : h('label', { className: 'bt-card-check' }, h('input', { type: 'checkbox', checked: complete, disabled, onChange: event => { start(); setComplete(event.target.checked) } }), t('Mark due date complete')),
    error ? h('p', { className: 'bt-form-error', role: 'alert' }, error) : null,
    h('div', { className: 'bt-card-editor-actions' },
      h('button', { type: 'button', className: 'bt-btn bt-btn-ghost', disabled, onClick: () => { start(); void save(true) } }, t('Clear')),
      h('button', { type: 'button', className: 'bt-btn bt-btn-primary', disabled: disabled || !base, onClick: () => void save(false) }, t('Save'))))
}

function LabelsEditor({ task, editable, disabled, onSave }) {
  const labels = labelsOf(task)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState([])
  const [entry, setEntry] = useState('')
  const [base, setBase] = useState(null)
  const [error, setError] = useState('')
  const start = () => { setBase(cardStamp(task)); setDraft([...labels]); setEntry(''); setError(''); setEditing(true) }
  const add = () => {
    const label = entry.trim()
    if (!label || draft.includes(label) || draft.length >= 20 || byteLength(label) > 40) { setError(t('Use up to 20 unique labels of 40 bytes each.')); return }
    setDraft([...draft, label]); setEntry(''); setError('')
  }
  const save = async () => {
    if (!base || disabled) return
    const result = await onSave(stampedTask(task, base), { labels: draft })
    if (result === 'committed') { setEditing(false); setError('') }
    else if (result !== 'cancelled') setError(t('The labels could not be saved.'))
  }
  if (!editable && !labels.length) return null
  return h('div', { className: 'bt-card-side-block bt-card-labels' },
    h('div', { className: 'bt-card-side-head' }, h('h4', null, t('Labels')), editable && !editing ? h('button', { type: 'button', className: 'bt-card-mini', onClick: start }, h(PencilIcon), t('Edit')) : null),
    editing ? h('div', { className: 'bt-card-editor' },
      h('div', { className: 'bt-board-card-labels' }, draft.length ? draft.map(label => h(LabelChip, { key: label, label, disabled, onRemove: () => setDraft(current => current.filter(item => item !== label)) })) : h('span', { className: 'bt-card-muted' }, t('No labels'))),
      h('div', { className: 'bt-card-inline' }, h('input', { value: entry, disabled, placeholder: t('Add a label'), 'aria-label': t('Add a label'), onChange: event => setEntry(event.target.value), onKeyDown: event => { if (event.key === 'Enter') { event.preventDefault(); add() } } }),
        h('button', { type: 'button', className: 'bt-btn bt-btn-ghost', disabled, onClick: add }, t('Add'))),
      error ? h('p', { className: 'bt-form-error', role: 'alert' }, error) : null,
      h('div', { className: 'bt-card-editor-actions' },
        h('button', { type: 'button', className: 'bt-btn bt-btn-ghost', disabled, onClick: () => setEditing(false) }, t('Cancel')),
        h('button', { type: 'button', className: 'bt-btn bt-btn-primary', disabled, onClick: () => void save() }, t('Save'))))
      : labels.length ? h('div', { className: 'bt-board-card-labels' }, labels.map(label => h(LabelChip, { key: label, label }))) : h('span', { className: 'bt-card-muted' }, t('No labels')))
}

function ChecklistEditor({ task, editable, disabled, onSave }) {
  const items = Array.isArray(task.checklist) ? task.checklist : []
  const [entry, setEntry] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [editingId, setEditingId] = useState('')
  const [draft, setDraft] = useState('')
  const write = async next => {
    if (disabled || saving) return undefined
    setSaving(true); setError('')
    try {
      const result = await onSave(task, { checklist: next })
      if (result !== 'committed' && result !== 'cancelled') setError(t('The checklist could not be saved.'))
      return result
    } catch { setError(t('The checklist could not be saved.')); return undefined }
    finally { setSaving(false) }
  }
  const add = () => {
    const text = entry.trim()
    if (!text || items.length >= 100 || byteLength(text) > 512 || !window.crypto?.randomUUID) { setError(t('Use up to 100 checklist items of 512 bytes each.')); return }
    setEntry('')
    void write([...items, { id: window.crypto.randomUUID(), text, checked: false }])
  }
  const startEdit = item => { if (!editable || disabled || saving) return; setEditingId(item.id); setDraft(item.text); setError('') }
  const saveEdit = async item => {
    const text = draft.trim()
    if (!text || byteLength(text) > 512) { setError(t('Use up to 100 checklist items of 512 bytes each.')); return }
    const result = await write(items.map(row => row.id === item.id ? { ...row, text } : row))
    if (result === 'committed') setEditingId('')
  }
  if (!editable && !items.length) return null
  return h(CardSection, { title: t('Checklist'), action: items.length ? h(ChecklistProgress, { task }) : null, className: 'bt-card-checklist' },
    items.length ? h('ul', { className: 'bt-card-checklist-list' }, items.map(item => h('li', { key: item.id, className: 'bt-card-checklist-item' },
      editingId === item.id ? h('div', { className: 'bt-card-inline bt-card-checklist-edit' },
        h('input', { value: draft, disabled: disabled || saving, 'aria-label': t('Edit checklist item'), autoFocus: true, onChange: event => setDraft(event.target.value), onKeyDown: event => { if (event.key === 'Enter') { event.preventDefault(); void saveEdit(item) } else if (event.key === 'Escape') { event.preventDefault(); setEditingId('') } } }),
        h('button', { type: 'button', className: 'bt-btn bt-btn-primary', disabled: disabled || saving || !draft.trim(), onClick: () => void saveEdit(item) }, t('Save')),
        h('button', { type: 'button', className: 'bt-btn bt-btn-ghost', disabled: saving, onClick: () => setEditingId('') }, t('Cancel')))
        : h('label', { className: 'bt-card-check' }, h('input', { type: 'checkbox', checked: item.checked === true, disabled: !editable || disabled || saving, 'aria-label': t('Mark checklist item'), onChange: event => void write(items.map(row => row.id === item.id ? { ...row, checked: event.target.checked } : row)) }), h('span', { className: item.checked ? 'bt-card-checked' : '' }, item.text)),
      editable && editingId !== item.id ? h('span', { className: 'bt-card-checklist-actions' },
        h('button', { type: 'button', className: 'bt-card-mini', 'aria-label': t('Edit checklist item'), disabled: disabled || saving, onClick: () => startEdit(item) }, h(PencilIcon)),
        h('button', { type: 'button', className: 'bt-card-icon-danger', 'aria-label': t('Remove checklist item'), disabled: disabled || saving, onClick: () => void write(items.filter(row => row.id !== item.id)) }, h(TrashIcon))) : null))) : h('p', { className: 'bt-card-muted' }, t('No checklist items yet.')),
    editable ? h('div', { className: 'bt-card-inline' },
      h('input', { value: entry, disabled: disabled || saving, placeholder: t('Add an item'), 'aria-label': t('New checklist item'), onChange: event => setEntry(event.target.value), onKeyDown: event => { if (event.key === 'Enter') { event.preventDefault(); add() } } }),
      h('button', { type: 'button', className: 'bt-btn bt-btn-ghost', disabled: disabled || saving || !entry.trim(), onClick: add }, t('Add item'))) : null,
    error ? h('p', { className: 'bt-form-error', role: 'alert' }, error) : null,
    h('p', { className: 'bt-card-note' }, t('Checklist items do not complete the task or its dependencies.')))
}


function AttachmentTile({ scope, task, image, request, canRemove, canCover, isCover, disabled, onRemove, onCover, onOpen }) {
  const state = useBoardImage(scope, task.id, image, request)
  const isImage = typeof image.mediaType === 'string' && image.mediaType.startsWith('image/')
  return h('figure', { className: 'bt-attachment' + (isCover ? ' bt-attachment-cover' : '') + (isImage ? '' : ' bt-attachment-file') },
    h('button', { type: 'button', className: 'bt-attachment-open', disabled, onClick: () => onOpen?.(image, state.url), title: textValue(image.name) || t('Attachment') },
      isImage ? (state.url ? h('img', { src: state.url, alt: textValue(image.name) || '' }) : h('span', { className: 'bt-attachment-placeholder' }, state.failed ? t('Image unavailable') : t('Loading…')))
        : h('span', { className: 'bt-attachment-placeholder' }, h(PaperclipIcon), h('span', null, textValue(image.name) || t('Attachment')), h('small', null, image.mediaType === 'application/pdf' ? 'PDF' : image.mediaType === 'application/zip' ? 'ZIP' : image.mediaType === 'application/json' ? 'JSON' : t('Text'))),
      isCover ? h('span', { className: 'bt-attachment-cover-flag' }, t('Cover')) : null),
    canCover && isImage ? h('button', { type: 'button', className: 'bt-attachment-cover-action', disabled, title: t(isCover ? 'Remove cover' : 'Set as cover'), 'aria-label': t(isCover ? 'Remove cover' : 'Set as cover'), onClick: () => onCover?.(isCover ? null : image.id) }, t(isCover ? 'Remove cover' : 'Set cover')) : null,
    h('figcaption', null, h('span', { className: 'bt-attachment-name', title: textValue(image.name) }, textValue(image.name) || t('Attachment')),
      canRemove ? h('button', { type: 'button', className: 'bt-card-icon-danger', 'aria-label': t('Remove attachment'), disabled, onClick: () => onRemove?.(image.id) }, h(TrashIcon)) : null))
}

function ImageUploader({ task, disabled, onUpload }) {
  const [queue, setQueue] = useState([])
  const [error, setError] = useState('')
  const [base, setBase] = useState(null)
  const [dragging, setDragging] = useState(false)
  const [saving, setSaving] = useState(false)
  const input = useRef(null)
  const urls = useRef(new Set())
  useEffect(() => () => { for (const url of urls.current) URL.revokeObjectURL(url); urls.current.clear() }, [])
  const remove = image => { URL.revokeObjectURL(image.url); urls.current.delete(image.url); setQueue(current => current.filter(item => item.uploadId !== image.uploadId)) }
  const add = files => {
    const list = [...files]
    if (!list.length) return
    if (!base) setBase(cardStamp(task))
    const count = imagesOf(task).length + queue.length + list.length
    const bytes = queue.reduce((sum, image) => sum + image.file.size, 0) + list.reduce((sum, file) => sum + file.size, 0)
    if (!window.crypto?.randomUUID || count > IMAGE_TASK_MAX_COUNT || queue.length + list.length > IMAGE_BATCH_MAX_COUNT || bytes > IMAGE_BATCH_MAX_BYTES || list.some(file => !FILE_TYPES.has(file.type) || file.size <= 0 || file.size > IMAGE_MAX_BYTES)) {
      setError(t('Choose PNG/JPEG, PDF, ZIP, plain text, Markdown or JSON: up to 20 per task, 10 per batch, 5 MiB each and 20 MiB per batch.')); return
    }
    setError('')
    const fresh = []
    try {
      for (const file of list) {
        const url = URL.createObjectURL(file)
        urls.current.add(url)
        fresh.push({ file, url, uploadId: window.crypto.randomUUID() })
      }
      setQueue(current => [...current, ...fresh])
    } catch {
      for (const image of fresh) { URL.revokeObjectURL(image.url); urls.current.delete(image.url) }
      setError(t('Unable to preview attachments'))
    }
  }
  const choose = event => { add(event.target.files ?? []); event.target.value = '' }
  const upload = async () => {
    if (!base || disabled || saving) return
    setSaving(true); setError('')
    try {
      const result = await onUpload(stampedTask(task, base), queue)
      if (result === 'committed') {
        for (const image of queue) { URL.revokeObjectURL(image.url); urls.current.delete(image.url) }
        setQueue([]); setBase(null)
      } else setError(t('The attachments could not be uploaded.'))
    } catch (caught) { setError(caught?.message || t('The attachments could not be uploaded.')) }
    finally { setSaving(false) }
  }
  const changed = base && !sameCardStamp(task, base)
  return h('div', { className: 'bt-attachment-uploader' },
    h('div', { className: 'bt-dropzone' + (dragging ? ' bt-dropzone-active' : ''), onDragOver: event => { event.preventDefault(); setDragging(true) }, onDragLeave: () => setDragging(false),
      onDrop: event => { event.preventDefault(); setDragging(false); add(event.dataTransfer.files ?? []) }, onPaste: event => { if (event.clipboardData?.files?.length) { event.preventDefault(); add(event.clipboardData.files) } } },
      h(PaperclipIcon), h('span', null, t('Drop files here, paste, or')),
      h('button', { type: 'button', className: 'bt-btn bt-btn-ghost', disabled, onClick: () => input.current?.click() }, t('Choose files')),
      h('input', { ref: input, type: 'file', multiple: true, accept: 'image/png,image/jpeg,application/pdf,application/zip,text/plain,text/markdown,application/json', hidden: true, disabled, onChange: choose })),
    h('p', { className: 'bt-card-note' }, t('PNG/JPEG, PDF, ZIP, text, Markdown and JSON are supported.')),
    changed ? h('p', { className: 'bt-card-warning', role: 'alert' }, t('Task changed. Remove selected attachments and choose them again.')) : null,
    queue.length ? h('div', { className: 'bt-attachment-queue' }, queue.map(image => h('figure', { key: image.uploadId, className: 'bt-attachment' + (image.file.type.startsWith('image/') ? '' : ' bt-attachment-file') },
      image.file.type.startsWith('image/') ? h('img', { src: image.url, alt: image.file.name }) : h('span', { className:'bt-attachment-placeholder' }, h(PaperclipIcon), h('span', null, image.file.name)),
      h('figcaption', null, h('span', { className: 'bt-attachment-name' }, image.file.name), h('button', { type: 'button', className: 'bt-card-icon-danger', 'aria-label': t('Remove attachment'), onClick: () => remove(image) }, h(TrashIcon)))))) : null,
    error ? h('p', { className: 'bt-form-error', role: 'alert' }, error) : null,
    queue.length ? h('button', { type: 'button', className: 'bt-btn bt-btn-primary', disabled: disabled || saving || changed, onClick: () => void upload() }, t('Upload files')) : null)
}

function AttachmentsEditor({ scope, task, request, canUpload, canRemove, canCover, disabled, onUpload, onRemove, onCover, onOpenImage }) {
  const images = imagesOf(task)
  if (!images.length && !canUpload) return null
  return h(CardSection, { title: t('Attachments'), action: images.length ? h('span', { className: 'bt-card-count' }, images.length) : null, className: 'bt-card-attachments' },
    images.length ? h('div', { className: 'bt-attachment-grid' }, images.map(image => h(AttachmentTile, { key: image.id, scope, task, image, request, canRemove, canCover, isCover: task.coverImageId === image.id, disabled, onRemove, onCover, onOpen: onOpenImage }))) : null,
    canUpload ? h(ImageUploader, { task, disabled, onUpload }) : null)
}

const WORK_REPLY_LABELS = { reply:'Task reply', 'goal-update':'Group goal update', start:'Work claimed', progress:'Progress', report:'Submitted for independent review', block:'Blocked', unblock:'Blocker cleared' }
function WorkReply({ comment, actors }) {
  const label = comment.workflowAction === 'review'
    ? (comment.result === 'pass' ? 'Independent review passed' : 'Rework requested')
    : WORK_REPLY_LABELS[comment.workflowAction]
  return h('div', { className:'bt-card-work-reply' },
    label ? h('strong', null, t(label)) : null,
    comment.text ? h('p', { className:'bt-comment-text' }, comment.text) : null,
    h(Fact, { label:t('Next action'), value:comment.next }),
    h(Fact, { label:t('Environment'), value:comment.environment }),
    h(Fact, { label:t('Unblock condition'), value:comment.condition }),
    comment.blockOwner ? h(Fact, { label:t('Owner'), value:actorName(comment.blockOwner, actors) }) : null)
}

function CommentItem({ comment, actors, canEdit, canDelete, disabled, onEdit, onDelete }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(textValue(comment.text))
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState('')
  const save = async () => {
    if (disabled || !draft.trim() || byteLength(draft) > 2048) return
    const result = await onEdit(comment.id, draft.trim())
    if (result === 'committed') setEditing(false)
    else setError(t('The comment could not be saved.'))
  }
  const author = actorName(comment.author, actors)
  return h('article', { className: 'bt-comment' },
    h(MemberAvatar, { name: author, size: 28 }),
    h('div', { className: 'bt-comment-body' },
      h('header', null, h('strong', null, author), h('time', { dateTime: Number.isFinite(comment.at) ? new Date(comment.at).toISOString() : undefined }, relativeTime(comment.at)),
        canEdit && !editing ? h('button', { type: 'button', className: 'bt-card-mini', disabled, onClick: () => { setDraft(textValue(comment.text)); setEditing(true); setError('') } }, t('Edit')) : null,
        canDelete && !editing ? (confirming ? h('span', { className: 'bt-comment-confirm' }, h('button', { type: 'button', className: 'bt-card-mini bt-card-icon-danger', disabled, onClick: () => void onDelete(comment.id) }, t('Confirm delete')), h('button', { type: 'button', className: 'bt-card-mini', onClick: () => setConfirming(false) }, t('Cancel'))) : h('button', { type: 'button', className: 'bt-card-mini', disabled, onClick: () => setConfirming(true) }, t('Delete'))) : null),
      comment.workflowAction ? h(WorkReply, { comment, actors }) : editing ? h('div', { className: 'bt-card-editor' }, h('textarea', { value: draft, rows: 3, disabled, 'aria-label': t('Edit comment'), onChange: event => setDraft(event.target.value) }),
        error ? h('p', { className: 'bt-form-error', role: 'alert' }, error) : null,
        h('div', { className: 'bt-card-editor-actions' }, h('button', { type: 'button', className: 'bt-btn bt-btn-ghost', onClick: () => setEditing(false) }, t('Cancel')), h('button', { type: 'button', className: 'bt-btn bt-btn-primary', disabled: disabled || !draft.trim() || byteLength(draft) > 2048, onClick: () => void save() }, t('Save')))) : h('p', { className: 'bt-comment-text' }, textValue(comment.text))))
}

function CommentsEditor({ task, actors, canPost, canEdit, canDelete, disabled, postType, onCommand }) {
  const comments = commentsOf(task)
  const [text, setText] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const post = async () => {
    if (!canPost || disabled || saving || !text.trim() || byteLength(text) > 2048) return
    setSaving(true); setError('')
    try {
      const result = await onCommand(task, { type: postType }, { text: text.trim() })
      if (result === 'committed') setText('')
      else setError(t('The comment could not be posted.'))
    } catch (caught) { setError(caught?.message || t('The comment could not be posted.')) }
    finally { setSaving(false) }
  }
  if (!comments.length && !canPost) return null
  return h(CardSection, { title: t('Comments'), action: comments.length ? h('span', { className: 'bt-card-count' }, comments.length) : null, className: 'bt-card-comments' },
    comments.length ? h('div', { className: 'bt-comment-list' }, comments.map(comment => h(CommentItem, { key: comment.id, comment, actors, canEdit:canEdit && !comment.workflowAction, canDelete:canDelete && !comment.workflowAction, disabled,
      onEdit: async (id, value) => onCommand(task, { type: 'card-comment-edit' }, { commentId: id, text: value }),
      onDelete: async id => { const result = await onCommand(task, { type: 'card-comment-delete' }, { commentId: id }); return result } }))) : h('p', { className: 'bt-card-muted' }, t('No comments yet.')),
    canPost ? h('div', { className: 'bt-comment-compose' },
      h('textarea', { value: text, rows: 3, disabled: disabled || saving, placeholder: t('Write a comment'), 'aria-label': t('Add a comment'), onChange: event => { setText(event.target.value); setError('') } }),
      error ? h('p', { className: 'bt-form-error', role: 'alert' }, error) : null,
      h('div', { className: 'bt-card-editor-actions' }, h('button', { type: 'button', className: 'bt-btn bt-btn-primary', disabled: disabled || saving || !text.trim() || byteLength(text) > 2048, onClick: () => void post() }, t('Post comment')))) : null)
}

const ACTIVITY_LABELS = { edit:'Task edited', details:'Card details updated', 'card-details':'Card details updated', comment:'Comment added', 'card-comment':'Comment added',
  'card-comment-edit':'Comment edited', 'card-comment-delete':'Comment deleted', attach:'Images added', 'remove-image':'Image removed',
  'personal-progress':'Personal progress updated', share:'Task shared', unshare:'Share revoked', reorder:'Card reordered', create:'Card created' }
function ActivitySection({ task }) {
  const activity = Array.isArray(task.boardActivity) ? task.boardActivity : []
  if (!activity.length) return null
  return h('details', { className: 'bt-card-activity' },
    h('summary', null, t('Activity'), h('span', { className: 'bt-card-count' }, activity.length)),
    h('ul', null, [...activity].reverse().slice(0, 20).map(item => h('li', { key: item.id },
      h('span', { className: 'bt-card-activity-dot', 'aria-hidden': true }),
      h('span', null, t(ACTIVITY_LABELS[item.type] ?? 'Card updated')),
      h('time', { dateTime: Number.isFinite(item.at) ? new Date(item.at).toISOString() : undefined }, relativeTime(item.at))))))
}

function SideSection({ title, action, children, className = '' }) {
  if (!children) return null
  return h('section', { className: 'bt-card-side-block ' + className },
    title ? h('div', { className: 'bt-card-side-head' }, h('h4', null, title), action) : action,
    children)
}

function StatusBlock({ task, commands, canMove, canSchedule, disabled, onCommand, notice }) {
  const progress = PERSONAL_COLUMNS.find(([id]) => id === task.personalProgress)
  const canSubmit = commandOf(commands, 'submit') && task.status === 'draft'
  const canCancel = commandOf(commands, 'cancel') && !['done','cancelled'].includes(task.status)
  const canRestore = commandOf(commands, 'restore') && task.status === 'cancelled'
  const moves = [
      canSubmit ? { key:'submit', label:t('Preparing'), run:() => onCommand(task, { type:'submit' }) } : null,
      canSchedule ? { key:'schedule', label:t('Ready'), run:() => onCommand(task, { type:'schedule' }) } : null,
      canRestore ? { key:'restore', label:t('Preparing'), run:() => onCommand(task, { type:'restore' }) } : null,
      canCancel ? { key:'cancel', label:t('Cancelled'), run:() => onCommand(task, { type:'cancel' }) } : null,
    ].filter(Boolean)
    return h(SideSection, { title: t('Status') },
    h('div', { className: 'bt-card-status' },
      h('span', { className: 'bt-board-stage-dot bt-board-stage-dot-' + (task.status || 'unknown'), 'aria-hidden': true }),
      h('strong', null, progress ? t(progress[1]) : stageLabelOf(task))),
    task.status === 'draft' ? h('p', { className: 'bt-card-note' }, t('Draft cards are not scheduled.')) : null,
    task.status === 'cancelled' ? h('p', { className: 'bt-card-note' }, t('Cancelled cards are not scheduled and can be restored.')) : null,
    task.dispatchState === 'uncertain' ? h('p', { className: 'bt-card-warning', role: 'status' }, t('The Bot message may or may not have reached its Session. Check the delivery before scheduling again.')) : null,
    canMove ? h('label', { className: 'bt-field' }, h('span', null, t('Personal progress')), h('select', { value: task.personalProgress, disabled, 'aria-label': t('Move personal task'), onChange: event => void onCommand(task, { type: 'personal-progress' }, { progress: event.target.value }) }, PERSONAL_COLUMNS.map(([id, label]) => h('option', { key: id, value: id }, t(label))))) : null,
    canSchedule ? h('button', { type: 'button', className: 'bt-btn bt-btn-primary bt-btn-block', disabled, onClick: () => void onCommand(task, { type: 'schedule' }) }, t('Schedule Bot')) : null,
    canSubmit || canRestore || canCancel ? h('div', { className: 'bt-card-status-actions' },
      canSubmit ? h('button', { type: 'button', className: 'bt-btn bt-btn-primary bt-btn-block', disabled, onClick: () => void onCommand(task, { type: 'submit' }) }, t('Submit card')) : null,
      canRestore ? h('button', { type: 'button', className: 'bt-btn bt-btn-primary bt-btn-block', disabled, onClick: () => void onCommand(task, { type: 'restore' }) }, t('Restore card')) : null,
      canCancel ? h('button', { type: 'button', className: 'bt-btn bt-btn-ghost bt-btn-block bt-card-cancel', disabled, onClick: () => void onCommand(task, { type: 'cancel' }) }, t('Cancel card')) : null) : null,
    moves.length ? h('details', { className: 'bt-card-move' }, h('summary', null, t('Move to…')),
      h('div', { className: 'bt-card-move-body' }, moves.map(move => h('button', { key:move.key, type:'button', className:'bt-card-mini', disabled, onClick:() => void move.run() }, move.label)))) : null,
    notice)
}

function TypeBlock({ task, editable, disabled, onSave }) {
  const [value, setValue] = useState(() => taskType(task))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [undoType, setUndoType] = useState(null)
  const undoTimer = useRef(null)
  useEffect(() => { setValue(taskType(task)); setError('') }, [task.type])
  useEffect(() => () => clearTimeout(undoTimer.current), [])
  if (!editable) return h(SideSection, { title: t('Type') }, h('div', { className: 'bt-card-status' }, h(TypeChip, { type: taskType(task) })))
  const save = async next => {
    const previous = taskType(task)
    if (busy || disabled || next === previous) return
    setValue(next); setBusy(true); setError('')
    try {
      const result = await onSave(task, { type: next })
      if (result !== 'committed' && result !== 'cancelled') { setValue(previous); setError(t('The type could not be saved.')) }
      else if (result === 'cancelled') setValue(previous)
      else {
        setUndoType(previous)
        clearTimeout(undoTimer.current)
        undoTimer.current = setTimeout(() => setUndoType(null), 6000)
      }
    } catch { setValue(previous); setError(t('The type could not be saved.')) }
    finally { setBusy(false) }
  }
  const change = event => void save(event.target.value)
  return h(SideSection, { title: t('Type') },
    h('label', { className: 'bt-field' }, h('span', null, t('Type')), h('select', { value, disabled: disabled || busy, 'aria-label': t('Task type'), onChange: change },
      TASK_TYPES.map(([id, label]) => h('option', { key: id, value: id }, t(label))))),
    undoType ? h('button', { type:'button', className:'bt-card-mini', disabled:busy || disabled, onClick:() => void save(undoType) }, t('Undo')) : null,
    error ? h('p', { className: 'bt-form-error', role: 'alert' }, error) : null)
}

function PeopleBlock({ task, actors }) {
  const rows = [['Owner', task.owner], ['Reviewer', task.reviewer]]
  if (task.parentTaskId && !task.owner && !task.reviewer) return h(SideSection,{title:t('People')},t('Unassigned'))
  return h(SideSection, { title: t('People') }, h('div', { className: 'bt-card-people' },
    rows.filter(([, id]) => id).map(([role, id]) => h('div', { key: role, className: 'bt-card-person' },
      h(MemberAvatar, { name: actorName(id, actors), size: 28 }), h('span', null, h('strong', null, actorName(id, actors)), h('small', null, t(role)))))))
}

function DependenciesBlock({ task, tasks }) {
  const ids = dependenciesOf(task)
  if (!ids.length) return null
  return h(SideSection, { title: t('Dependencies') }, h('div', { className: 'bt-card-dependency-list' }, ids.map(id => {
    const item = Array.isArray(tasks) ? tasks.find(task => task.id === id) : undefined
    return h('span', { key: id, className: 'bt-board-chip' }, textValue(item?.title) || id)
  })))
}

function TaskItemLink({ item, actors, onOpen }) {
  return h('button', { type:'button', 'data-item-id':item.id, className:'bt-card-related-link', onClick:event => onOpen(item.id, event.currentTarget) },
    h('span', null, textValue(item.title) || item.id),
    h('small', null, [actorLabel(item.owner, actors), item.legacy ? t(stageLabelOf(item)) : stageLabelOf(item), item.legacy?.originalStatus ? t(STATUS_LABELS[item.legacy.originalStatus] ?? item.legacy.originalStatus) : '', item.stage, item.blocked ? t('Blocked') : ''].filter(Boolean).join(' · ')),
    item.status === 'working' && item.progress ? h('span', { className:'bt-board-item-progress' },
      item.progress.summary, !item.blocked && !item.stale ? ' · ' + t('Next action') + ' · ' + item.progress.next : '') : null)
}

function RelatedTasks({ task, tasks, actors, onOpen, onCreateItem, onMove }) {
  const [destination, setDestination] = useState('')
  const parent = task.parentTaskId && tasks.find(item => item.id === task.parentTaskId)
  const children = tasks.filter(item => item.parentTaskId === task.id)
  const editable = card => card && ['draft','proposed'].includes(card.status) && !card.archivedAt && !card.stale && !card.blocked
  const candidates = onMove && editable(parent) ? tasks.filter(card => editable(card) && !card.parentTaskId && !card.shared && !card.legacy
    && ['feature','bugfix'].includes(card.type) && card.id !== parent.id && (card.releaseId ?? null) === (parent.releaseId ?? null)) : []
  if (!parent && !children.length && !onCreateItem) return null
  const link = item => h(TaskItemLink, { key:item.id, item, actors, onOpen })
  return h('div', { className:'bt-card-side-block' },
    parent ? h('h3', null, t('Parent card')) : null, parent ? link(parent) : null,
    candidates.length ? h('div', {className:'bt-field'},
      h('select', {value:destination,'aria-label':t('Destination card'),onChange:event => setDestination(event.target.value)},
        h('option',{value:''},t('Choose a feature or bugfix')),candidates.map(card => h('option',{key:card.id,value:card.id},card.title))),
      h('button',{type:'button',className:'bt-btn bt-btn-ghost',disabled:!candidates.some(card => card.id === destination),
        onClick:() => onMove(parent,destination)},t('Move to card'))) : null,
    children.length || onCreateItem ? h('h3', null, t('Task items')) : null, children.map(link),
    onCreateItem ? h('button', { type:'button', className:'bt-btn bt-btn-ghost', onClick:onCreateItem }, t('Create task item')) : null)
}

function FactsBlock({ task }) {
  const evidence = task.evidence && typeof task.evidence === 'object'
    ? [textValue(task.evidence.evidence), textValue(task.evidence.environment)].filter(Boolean).join(' · ')
    : Array.isArray(task.evidence) ? task.evidence.map(asText).filter(Boolean).join(' · ') : asText(task.evidence)
  return h(SideSection, { title: t('Details') },
    h('div', { className: 'bt-card-facts' },
      h(Fact, { label: t('Acceptance criteria'), value: textValue(task.acceptance) }),
      h(Fact, { label: t('Next action'), value: asText(task.nextAction) }),
      h(Fact, { label: t('Blocked'), value: asText(task.blocked) }),
      h(Fact, { label: t('Evidence'), value: evidence }),
      h(Fact, { label: t('Target version'), value: asText(task.authority) }),
      task.legacy ? h(Fact, { label: t('Goal task note'), value: textValue(task.goalNote) }) : null,
      task.legacy?.useOverlay ? h(Fact, { label: t('Original task description'), value: textValue(task.legacy.originalTitle) }) : null))
}

function ChangeBlock({ task }) {
  if (!task.change) return null
  return h('div', { className: 'bt-card-change' }, h('strong', null, t('Requirement change')),
    h(Fact, { label: t('Original task'), value: task.change.sourceTaskId + ' · ' + t('Revision') + ' ' + task.change.sourceRevision }),
    h('p', { role: 'status' }, t(task.status === 'working' ? 'This change is being worked as a separate task; the original stays unchanged.'
      : task.status === 'ready' ? 'The source task is complete; this requirement change is queued as its own task.' : 'This change waits for the original task to complete. It has not been dispatched.')),
    Object.entries({ title:'Title', owner:'Owner', reviewer:'Reviewer', acceptance:'Acceptance criteria', dependencies:'Dependencies', description:'Description' })
      .filter(([field]) => JSON.stringify(task.change.before?.[field]) !== JSON.stringify(task.change.after?.[field]))
      .map(([field, label]) => h('div', { key: field }, h('strong', null, t(label)),
        h('p', null, t('Before') + ': ' + (typeof task.change.before?.[field] === 'string' ? task.change.before[field] : JSON.stringify(task.change.before?.[field] ?? ''))),
        h('p', null, t('After') + ': ' + (typeof task.change.after?.[field] === 'string' ? task.change.after[field] : JSON.stringify(task.change.after?.[field] ?? ''))))))
}


function DependencySelect({ tasks, value, disabled, exclude, onChange }) {
  const options = (Array.isArray(tasks) ? tasks : []).filter(task => task && !task.legacy && typeof task.id === 'string' && task.id !== exclude)
  return h('label', { className: 'bt-field' }, h('span', null, t('Dependencies')),
    h('select', { multiple: true, size: Math.min(4, Math.max(2, options.length)), value, disabled,
      'aria-label': t('Dependencies'), onChange: event => onChange([...event.target.selectedOptions].map(option => option.value)) },
    options.map(task => h('option', { key: task.id, value: task.id }, (textValue(task.title) || t('Shared task')) + ' · ' + task.id))))
}

function EditTask({ task, actors, tasks, disabled, onEdit }) {
  const [open, setOpen] = useState(false)
  const [base, setBase] = useState(task.revision)
  const [draft, setDraft] = useState({})
  const reset = () => {
    setBase(task.revision)
    setDraft({ title: textValue(task.title), owner: asText(task.owner), reviewer: asText(task.reviewer),
      acceptance: textValue(task.acceptance), dependencies: dependenciesOf(task) })
  }
  const changed = task.revision !== base
  const valid = draft.title?.trim() && draft.owner?.trim() && draft.reviewer?.trim() && draft.acceptance?.trim() && draft.owner !== draft.reviewer
  if (!open) return h('button', { type: 'button', className: 'bt-btn bt-btn-ghost', disabled, onClick: () => { reset(); setOpen(true) } }, t('Edit task'))
  const field = (label, key) => h('label', { className: 'bt-field' }, h('span', null, t(label)), h('input', { value: draft[key] ?? '', disabled, onChange: event => setDraft({ ...draft, [key]: event.target.value }) }))
  const actorField = (label, key) => h('label', { className: 'bt-field' }, h('span', null, t(label)),
    h('select', { value: draft[key] ?? '', disabled, onChange: event => setDraft({ ...draft, [key]: event.target.value }) },
      h('option', { value: '' }, t('Choose a Bot')),
      (Array.isArray(actors) ? actors : []).filter(actor => typeof actor?.id === 'string').map(actor => h('option', { key: actor.id, value: actor.id }, actor.name || actor.id))))
  return h('form', { className: 'bt-card-form', onSubmit: event => {
    event.preventDefault()
    if (disabled || changed || !valid) return
    void onEdit({ ...task, revision: base }, { title: draft.title.trim(), owner: draft.owner.trim(), reviewer: draft.reviewer.trim(),
      acceptance: draft.acceptance.trim(), dependencies: draft.dependencies }).then(result => { if (result === 'committed') setOpen(false) })
  } },
  changed ? h('p', { className: 'bt-card-warning', role: 'alert' }, t('Task changed. Reload its current values before saving.'), ' ', h('button', { type: 'button', className: 'bt-card-mini', disabled, onClick: reset }, t('Reload values'))) : null,
  ['working','reported','done'].includes(task.status) ? h('p', { className: 'bt-card-note' }, t('Saving creates a separate change proposal after the original task.')) : null,
  field('Title', 'title'), actorField('Owner', 'owner'), actorField('Independent reviewer', 'reviewer'),
  field('Acceptance criteria', 'acceptance'), h(DependencySelect, { tasks, exclude: task.id, value: draft.dependencies ?? [], disabled, onChange: value => setDraft({ ...draft, dependencies: value }) }),
  h('div', { className: 'bt-card-editor-actions' }, h('button', { type: 'button', className: 'bt-btn bt-btn-ghost', disabled, onClick: () => setOpen(false) }, t('Cancel')),
    h('button', { type: 'submit', className: 'bt-btn bt-btn-primary', disabled: disabled || changed || !valid }, t('Save changes'))))
}

function ShareTask({ task, commands, targets, disabled, onCommand }) {
  const [open, setOpen] = useState(false)
  const [base, setBase] = useState(task.revision)
  const [target, setTarget] = useState('')
  const [includeTitle, setIncludeTitle] = useState(false)
  const canShare = commandOf(commands, 'share') && Array.isArray(targets)
  const canRevoke = commandOf(commands, 'unshare')
  const shares = Array.isArray(task.shares) ? task.shares.filter(share => typeof share?.id === 'string') : []
  if (!canShare && (!canRevoke || !shares.length)) return null
  const changed = open && base !== task.revision
  const targetName = id => targets?.find(item => item?.id === id)?.name || t('Shared group')
  return h('div', { className: 'bt-card-shares' },
    shares.length ? h('div', { className: 'bt-card-share-list' }, shares.map(share => h('div', { className: 'bt-card-share-row', key: share.id },
      h('span', null, targetName(share.targetRoomId)),
      canRevoke ? h('button', { type: 'button', className: 'bt-card-mini', disabled, onClick: () => onCommand(task, { type: 'unshare' }, { shareId: share.id }) }, t('Revoke share')) : null))) : null,
    canShare && !open ? h('button', { type: 'button', className: 'bt-btn bt-btn-ghost', disabled, onClick: () => { setBase(task.revision); setTarget(''); setIncludeTitle(false); setOpen(true) } }, t('Share with group')) : null,
    canShare && open ? h('form', { className: 'bt-card-form', onSubmit: event => {
      event.preventDefault()
      if (disabled || changed || !target || !targets.some(item => item?.id === target)) return
      void onCommand({ ...task, revision: base }, { type: 'share' }, { targetRoomId: target, fields: includeTitle ? ['status', 'title'] : ['status'] }).then(result => { if (result === 'committed') setOpen(false) })
    } },
    changed ? h('p', { className: 'bt-card-warning', role: 'alert' }, t('Task changed. Reopen sharing before saving.')) : null,
    h('label', { className: 'bt-field' }, h('span', null, t('Target group')), h('select', { value: target, disabled, onChange: event => setTarget(event.target.value) },
      h('option', { value: '' }, t('Choose a group')),
      targets.filter(item => typeof item?.id === 'string').map(item => h('option', { key: item.id, value: item.id }, item.name || t('Shared group'))))),
    h('label', { className: 'bt-card-check' }, h('input', { type: 'checkbox', checked: includeTitle, disabled, onChange: event => setIncludeTitle(event.target.checked) }), t('Share title too')),
    h('span', { className: 'bt-card-note' }, t('Status is always shared.')),
    h('div', { className: 'bt-card-editor-actions' }, h('button', { type: 'button', className: 'bt-btn bt-btn-ghost', disabled, onClick: () => setOpen(false) }, t('Cancel')),
      h('button', { type: 'submit', className: 'bt-btn bt-btn-primary', disabled: disabled || changed || !target }, t('Share')))) : null)
}

function TaskHistory({ scope, task, request }) {
  const [history, setHistory] = useState(null)
  const [error, setError] = useState('')
  const sequence = useRef(0)
  useEffect(() => { setHistory(null); setError(''); sequence.current++; return () => { sequence.current++ } }, [task.id, task.revision])
  const load = async event => {
    if (!event.currentTarget.open || history) return
    const id = ++sequence.current
    try { const result = await request('board-history', { scope, taskId: task.id }); if (sequence.current === id) setHistory(result) }
    catch (caught) { if (sequence.current === id) setError(caught?.message || t('Board unavailable')) }
  }
  const fields = { title:'Title', owner:'Owner', reviewer:'Reviewer', acceptance:'Acceptance criteria', dependencies:'Dependencies', description:'Description', stage:'Work stage', dueDate:'Due date', dueComplete:'Due date complete', labels:'Labels', checklist:'Checklist' }
  return h('details', { className: 'bt-card-history', onToggle: load }, h('summary', null, t('Card revision history')),
    error ? h('p', { role: 'alert', className: 'bt-form-error' }, error) : null,
    !history && !error ? h('p', { className: 'bt-card-muted' }, t('Loading…')) : null,
    history?.truncated ? h('p', { className: 'bt-card-note' }, t('Showing the latest 50 revisions.')) : null,
    (history?.entries ?? []).map(entry => {
      const changed = Object.entries(fields).filter(([key]) => JSON.stringify(entry.before?.[key] ?? null) !== JSON.stringify(entry.after?.[key] ?? null))
      if (!changed.length) return null
      return h('article', { key: entry.after.revision }, h('strong', null, t('Revision') + ' ' + entry.after.revision),
        changed.map(([key, label]) => h('div', { key }, h('strong', null, t(label)),
          h('p', null, t('Before') + ': ' + (typeof entry.before?.[key] === 'string' ? entry.before[key] : JSON.stringify(entry.before?.[key] ?? ''))),
          h('p', null, t('After') + ': ' + (typeof entry.after?.[key] === 'string' ? entry.after[key] : JSON.stringify(entry.after?.[key] ?? ''))))))
    }))
}

function EditGoalTask({ task, disabled, onEdit }) {
  const [open, setOpen] = useState(false), [base, setBase] = useState(() => cardStamp(task)), [title, setTitle] = useState(''), [note, setNote] = useState(''), [status, setStatus] = useState('')
  const reset = () => { setBase(cardStamp(task)); setTitle(textValue(task.legacy?.originalTitle ?? task.title)); setNote(textValue(task.goalNote)); setStatus(task.legacy?.originalStatus ?? '') }
  const changed = !sameCardStamp(task, base), original = task.legacy?.originalStatus, paused = task.legacy?.goalStatus !== 'active'
  const titleLocked = ['reported','done'].includes(original)
  const next = original === 'pending' ? 'working' : original === 'working' ? 'reported' : undefined
  const statuses = [original, ...(!paused && next ? [next] : [])].filter(Boolean)
  const modified = title.trim() !== textValue(task.legacy?.originalTitle ?? task.title) || note !== textValue(task.goalNote) || status !== original
  const valid = title.trim() && modified && (!status || status === original || note.trim())
  if (!open) return h('button', { type: 'button', className: 'bt-btn bt-btn-ghost', disabled, onClick: () => { reset(); setOpen(true) } }, t('Edit goal task'))
  return h('form', { className: 'bt-card-form', onSubmit: event => {
    event.preventDefault(); if (disabled || changed || !valid) return
    const value = {}
    if (title.trim() !== textValue(task.legacy?.originalTitle ?? task.title)) value.title = title.trim()
    if (note !== textValue(task.goalNote) || status !== original) value.note = note
    if (status !== original) value.status = status
    void onEdit(stampedTask(task, base), value).then(result => { if (result === 'committed') setOpen(false) })
  } },
  changed ? h('p', { className: 'bt-card-warning', role: 'alert' }, t('Task changed. Reload its current values before saving.'), ' ', h('button', { type: 'button', className: 'bt-card-mini', onClick: reset }, t('Reload values'))) : null,
  h('label', { className: 'bt-field' }, h('span', null, t('Task description')), h('textarea', { value: title, disabled: disabled || titleLocked, onChange: event => setTitle(event.target.value) })),
  titleLocked ? h('p', { className: 'bt-card-note' }, t('Reported or completed work must be reconciled before changing its description.')) : null,
  h('label', { className: 'bt-field' }, h('span', null, t('Goal task status')), h('select', { value: status, disabled: disabled || paused, onChange: event => setStatus(event.target.value) },
    statuses.map(value => h('option', { key: value, value }, t(({pending:'Not started',working:'In progress',reported:'Awaiting review',done:'Done'})[value] ?? 'Status unknown'))))),
  h('label', { className: 'bt-field' }, h('span', null, t('Goal task note')), h('textarea', { value: note, disabled: disabled || paused, onChange: event => setNote(event.target.value) })),
  h('p', { className: 'bt-card-note' }, t('Owner, acceptance and completed status are managed by the group goal.')),
  h('div', { className: 'bt-card-editor-actions' }, h('button', { type: 'button', className: 'bt-btn bt-btn-ghost', disabled, onClick: () => setOpen(false) }, t('Cancel')),
    h('button', { type: 'submit', className: 'bt-btn bt-btn-primary', disabled: disabled || changed || !valid }, t('Save changes'))))
}

function EditHistoryTitle({ task, disabled, onEdit }) {
  const [open, setOpen] = useState(false), [base, setBase] = useState(() => cardStamp(task)), [title, setTitle] = useState(''), [reason, setReason] = useState('')
  const reset = () => { setBase(cardStamp(task)); setTitle(textValue(task.title)); setReason('') }
  const changed = !sameCardStamp(task, base)
  const valid = title.trim() && title.trim().length <= 500 && title.trim() !== task.title && reason.trim() && reason.length <= 300
  if (!open) return h('button', { type: 'button', className: 'bt-btn bt-btn-ghost', disabled, onClick: () => { reset(); setOpen(true) } }, t('Correct card title'))
  return h('form', { className: 'bt-card-form', onSubmit: event => { event.preventDefault(); if (disabled || changed || !valid) return
    void onEdit(stampedTask(task, base), { title: title.trim(), reason: reason.trim() }).then(result => { if (result === 'committed') setOpen(false) }) } },
    changed ? h('p', { className: 'bt-card-warning', role: 'alert' }, t('Task changed. Reload its current values before saving.'), ' ', h('button', { type: 'button', className: 'bt-card-mini', onClick: reset }, t('Reload values'))) : null,
    h('label', { className: 'bt-field' }, h('span', null, t('Card display title')), h('input', { value: title, disabled, onChange: event => setTitle(event.target.value) })),
    h('label', { className: 'bt-field' }, h('span', null, t('Reason for correction')), h('textarea', { value: reason, disabled, onChange: event => setReason(event.target.value) })),
    h('p', { className: 'bt-card-note' }, t('The original task and acceptance record remain unchanged.')),
    h('div', { className: 'bt-card-editor-actions' }, h('button', { type: 'button', className: 'bt-btn bt-btn-ghost', disabled, onClick: () => setOpen(false) }, t('Cancel')),
      h('button', { type: 'submit', className: 'bt-btn bt-btn-primary', disabled: disabled || changed || !valid }, t('Save changes'))))
}


function TaskCardDialog({ scope, task, tasks, commands, actors, targets, uploadEnabled, uncertain, onCommand, onUpload, request, onClose, onOpenRelated, onCreateItem, focusReturn, boardRef, pending, busy, error, onCheck, onCancel, cancelBusy, onDuplicate }) {
  const modal = useRef(null)
  const lightboxRef = useRef(null)
  const confirmationRef = useRef(null)
  const confirmBox = useRef(null)
  const [lightbox, setLightbox] = useState(null)
  const [confirmation, setConfirmation] = useState(null)
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState(textValue(task.title))
  const [titleError, setTitleError] = useState('')
  lightboxRef.current = lightbox
  confirmationRef.current = confirmation
  const legacy = !!task.legacy
  const detailsType = legacy ? 'goal-card-details' : 'card-details'
  const commentType = legacy ? 'goal-card-comment' : 'card-comment'
  const removeType = legacy ? 'goal-image-remove' : 'remove-image'
  const canDetails = commandOf(commands, detailsType)
  const canComment = commandOf(commands, commentType)
  const canEditComment = !legacy && commandOf(commands, 'card-comment-edit')
  const canDeleteComment = !legacy && commandOf(commands, 'card-comment-delete')
  const canUpload = uploadEnabled && commandOf(commands, 'upload')
  const canRemoveImage = commandOf(commands, removeType)
  const canShare = commandOf(commands, 'share')
  const canUnshare = commandOf(commands, 'unshare')
  const canEdit = commandOf(commands, 'edit')
  const canSchedule = commandOf(commands, 'schedule') && ['proposed', 'waiting'].includes(task.status) && !task.blocked && !task.stale
  const canMove = commandOf(commands, 'personal-progress') && PERSONAL_COLUMNS.some(([id]) => id === task.personalProgress)
  const canArchive = commandOf(commands, 'archive')
  const canUnarchive = commandOf(commands, 'unarchive')
  const canGoalEdit = commandOf(commands, 'goal-task-edit')
  const canHistoryTitle = commandOf(commands, 'goal-history-title')
  const canRename = !legacy && !task.shared && canEdit && ['proposed', 'waiting', 'ready'].includes(task.status) && !uncertain
  const stage = task.personalProgress ? t((PERSONAL_COLUMNS.find(([id]) => id === task.personalProgress) ?? [null, 'Status unknown'])[1]) : stageLabelOf(task)
  const cancelConfirmation = () => {
    const current = confirmationRef.current
    if (!current) return
    confirmationRef.current = null; setConfirmation(null)
    current.resolve?.('cancelled')
  }
  const applyConfirmation = async () => {
    const current = confirmationRef.current
    if (!current) return
    confirmationRef.current = null; setConfirmation(null)
    let result
    try { result = await onCommand(current.target, current.command, current.value) }
    catch { result = undefined }
    current.resolve?.(result)
  }
  const confirmCommand = (target, command, value) => {
    if (task.shared || !confirmCommands.has(command.type)) return onCommand(target, command, value)
    if (confirmationRef.current) return Promise.resolve('cancelled')
    return new Promise(resolve => {
      setConfirmation({ target, command, value, rows: confirmationRows(task, command, value, actors, tasks), resolve })
    })
  }
  useEffect(() => {
    if (confirmation) confirmBox.current?.focus()
  }, [confirmation])
  useEffect(() => {
    const popup = modal.current, backdrop = popup?.parentElement, parent = backdrop?.parentElement
    const keyDown = event => {
      if (!popup || !['Tab', 'Escape'].includes(event.key)) return
      event.preventDefault(); event.stopImmediatePropagation()
      if (event.key === 'Escape') { if (lightboxRef.current) { setLightbox(null); return } if (confirmationRef.current) { cancelConfirmation(); return } onClose(); return }
      const choices = [...popup.querySelectorAll('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),summary,a[href],[tabindex="0"]')]
        .filter(item => item.tabIndex >= 0 && !item.closest('[inert]') && !hiddenInClosedDetails(item) && item.getClientRects().length > 0)
      if (!choices.length) { popup.focus(); return }
      const current = choices.indexOf(document.activeElement)
      const index = event.shiftKey ? (current <= 0 ? choices.length - 1 : current - 1) : (current < 0 || current === choices.length - 1 ? 0 : current + 1)
      choices[index].focus()
    }
    const keepFocus = event => { if (popup?.isConnected && !popup.contains(event.target)) popup.focus() }
    const previous = new Map()
    const hideBackground = () => { for (const item of parent?.children ?? []) { if (item === backdrop) continue
      if (!previous.has(item)) previous.set(item, { inert: item.inert, hidden: item.getAttribute('aria-hidden') })
      item.inert = true; item.setAttribute('aria-hidden', 'true') } }
    popup?.focus(); hideBackground()
    const observer = new MutationObserver(hideBackground)
    if (parent) observer.observe(parent, { childList: true })
    window.addEventListener('keydown', keyDown, true)
    document.addEventListener('focusin', keepFocus, true)
    return () => {
      window.removeEventListener('keydown', keyDown, true)
      document.removeEventListener('focusin', keepFocus, true)
      observer.disconnect()
      for (const [item, { inert, hidden }] of previous) { item.inert = inert; if (hidden === null) item.removeAttribute('aria-hidden'); else item.setAttribute('aria-hidden', hidden) }
      const replacement = [...(boardRef.current?.querySelectorAll('[data-task-id]') ?? [])].find(item => item.dataset.taskId === task.id)?.querySelector('.bt-board-card-summary')
      if (focusReturn.current?.isConnected) focusReturn.current.focus(); else if (replacement) replacement.focus(); else boardRef.current?.focus()
    }
  }, [])
  useEffect(() => { if (!lightbox) return undefined
    const close = event => { if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); setLightbox(null) } }
    window.addEventListener('keydown', close, true); return () => window.removeEventListener('keydown', close, true) }, [lightbox])
  const saveTitle = async () => {
    if (!canRename || !titleDraft.trim() || byteLength(titleDraft.trim()) > 200) return
    setTitleError('')
    const result = await confirmCommand(task, { type: 'edit' }, { title: titleDraft.trim(), owner: task.owner, reviewer: task.reviewer, acceptance: textValue(task.acceptance), dependencies: dependenciesOf(task) })
    if (result === 'committed') setEditingTitle(false)
    else if (result !== 'cancelled') setTitleError(t('The title could not be saved.'))
  }
  const detailsSave = (target, value) => confirmCommand(target, { type: detailsType }, value)
  return h('div', { className: 'bt-card-modal-backdrop', onMouseDown: event => { if (event.target === event.currentTarget) onClose() } },
    h('section', { ref: modal, className: 'bt-card-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': textValue(task.title) || task.id, tabIndex: -1, onWheel: event => event.stopPropagation() },
      h('header', { className: 'bt-card-modal-header' },
        h('div', { className: 'bt-card-modal-heading' },
          h('p', { className: 'bt-card-eyebrow' }, (scope.kind === 'room' ? t('Group task board') : t('Personal task board')) + ' · ' + stage),
          editingTitle ? h('form', { className: 'bt-card-title-form', onSubmit: event => { event.preventDefault(); void saveTitle() } },
            h('input', { value: titleDraft, disabled: uncertain || busy, 'aria-label': t('Card title'), onChange: event => setTitleDraft(event.target.value) }),
            h('button', { type: 'submit', className: 'bt-btn bt-btn-primary', disabled: uncertain || busy || !titleDraft.trim() }, t('Save')),
            h('button', { type: 'button', className: 'bt-btn bt-btn-ghost', onClick: () => setEditingTitle(false) }, t('Cancel')),
            titleError ? h('span', { className: 'bt-form-error', role: 'alert' }, titleError) : null)
            : h('h2', null, textValue(task.title) || task.id),
          h('div', { className: 'bt-card-submeta' },
            h('span', { className: 'bt-card-head-status' }, h('span', { className: 'bt-board-stage-dot bt-board-stage-dot-' + (task.status || 'unknown'), 'aria-hidden': true }), h('span', null, stageLabelOf(task))),
            h(TypeChip, { type: taskType(task) }),
            h('span', { className: 'bt-board-id' }, task.id), legacy ? h('span', { className: 'bt-board-legacy' }, stageLabelOf(task)) : null, task.shared ? h('span', { className: 'bt-board-legacy' }, t('Shared task · read only')) : null)),
        h('div', { className: 'bt-card-modal-actions' },
          canRename && !editingTitle ? h('button', { type: 'button', className: 'bt-icon-btn', 'aria-label': t('Rename card'), title: t('Rename card'), onClick: () => { setTitleDraft(textValue(task.title)); setEditingTitle(true) } }, h(PencilIcon)) : null,
          h('button', { type: 'button', className: 'bt-icon-btn', 'aria-label': t('Close card'), 'data-close-card': 'true', onClick: onClose }, h(CloseIcon)))),
      confirmation ? h('section', { ref: confirmBox, className: 'bt-card-confirm', role: 'alertdialog', 'aria-label': t('Confirm change'), tabIndex: -1 },
        h('div', { className: 'bt-card-confirm-head' },
          h('h3', null, t('Confirm change')),
          h('p', null, t('Review the before and after values before applying this change.'))),
        h('div', { className: 'bt-card-diff' }, confirmation.rows.length ? confirmation.rows.map(row => h('div', { key: row.field, className: 'bt-card-diff-row' },
          h('strong', null, t(row.label)),
          h('div', { className: 'bt-card-diff-values' },
            h('span', null, h('b', null, t('Before') + ': '), row.before),
            h('span', null, h('b', null, t('After') + ': '), row.after)))) : h('p', { className: 'bt-card-note' }, t('No visible field changes.'))),
        h('div', { className: 'bt-card-editor-actions' },
          h('button', { type: 'button', className: 'bt-btn bt-btn-ghost', onClick: cancelConfirmation }, t('Cancel')),
          h('button', { type: 'button', className: 'bt-btn bt-btn-primary', onClick: () => void applyConfirmation() }, t('Confirm')))) : null,
      pending ? h('div', { className: 'bt-card-banner', role: 'status' }, t(busy ? 'Saving…' : 'An action needs confirmation.'), ' ',
        h('button', { type: 'button', className: 'bt-card-mini', onClick: () => onCheck(pending) }, t('Check action')), ' ',
        h('button', { type: 'button', className: 'bt-card-mini', disabled: cancelBusy, onClick: () => onCancel(pending) }, t('Safely cancel pending request')))
        : error ? h('div', { className: 'bt-card-banner bt-card-banner-error', role: 'alert' }, error) : null,
      h('div', { className: 'bt-card-modal-body' },
        h('div', { className: 'bt-card-mobile-bar' },
          h('span', { className: 'bt-card-head-status' }, h('span', { className: 'bt-board-stage-dot bt-board-stage-dot-' + (task.status || 'unknown'), 'aria-hidden': true }), h('span', null, stageLabelOf(task))),
          h(TypeChip, { type: taskType(task) }),
          h('span', { className: 'bt-board-card-owner' }, h(MemberAvatar, { name: actorName(task.owner, actors), size: 22 }), h('span', null, actorName(task.owner, actors))),
          task.dueDate ? h(DueChip, { task }) : null,
          h('button', { type:'button', className:'bt-card-mini', onClick:() => modal.current?.querySelector('.bt-card-side')?.scrollIntoView({ behavior:'smooth', block:'start' }) }, t('Manage'))),
        h('main', { className: 'bt-card-main', onPaste: event => { const files = [...(event.clipboardData?.files ?? [])].filter(file => FILE_TYPES.has(file.type)); if (files.length && canUpload) { event.preventDefault(); const input = event.currentTarget.querySelector('.bt-attachment-uploader input[type=file]'); if (input) { const transfer = new DataTransfer(); for (const file of files) transfer.items.add(file); input.files = transfer.files; input.dispatchEvent(new Event('change', { bubbles: true })) } } } },
          task.legacy?.pending ? h('p', { className: 'bt-card-note', role: 'status' }, t('A card change is awaiting confirmation in its original board.')) : null,
          task.legacy?.titleStale ? h('p', { className: 'bt-card-note', role: 'status' }, t('The original task changed after this display title was corrected. Review the title.')) : null,
          task.shared ? h('p', { className: 'bt-card-note' }, t('This shared card is read only in this board.')) : null,
          h(ChangeBlock, { task }),
          h(CardTextEditor, { task, editable: canDetails, disabled: uncertain || busy, onSave: detailsSave }),
          h(ChecklistEditor, { task, editable: canDetails, disabled: uncertain || busy, onSave: (target, value) => detailsSave(target, value) }),
          h(AttachmentsEditor, { scope, task, request, canUpload, canRemove: canRemoveImage, canCover: !legacy && canDetails, disabled: uncertain || busy, onUpload, onRemove: imageId => onCommand(task, { type: removeType }, { imageId }), onCover: imageId => detailsSave(task, { coverImageId: imageId }), onOpenImage: (image, url) => {
            if (!url) return
            if (typeof image.mediaType === 'string' && image.mediaType.startsWith('image/')) setLightbox({ url, name: textValue(image.name) })
            else { const link = document.createElement('a'); link.href = url; link.download = textValue(image.name) || 'attachment'; link.click() }
          } }),
          h(CommentsEditor, { task, actors, canPost: canComment, canEdit: canEditComment, canDelete: canDeleteComment, disabled: uncertain || busy, postType: commentType, onCommand }),
          h(ActivitySection, { task })),
        h('aside', { className: 'bt-card-side' },
          h(StatusBlock, { task, commands, canMove, canSchedule, disabled: uncertain || busy, onCommand }),
          h(PeopleBlock, { task, actors }),
          !legacy ? h(CardTextEditor, { task, field:'stage', editable:canDetails, disabled:uncertain || busy, onSave:detailsSave }) : null,
          h(TypeBlock, { task, editable: canDetails, disabled: uncertain || busy, onSave: detailsSave }),
          h(DueEditor, { task, editable: canDetails, disabled: uncertain || busy, legacy, onSave: detailsSave }),
          h(LabelsEditor, { task, editable: canDetails, disabled: uncertain || busy, onSave: detailsSave }),
          h(DependenciesBlock, { task, tasks }),
          h(RelatedTasks, { task, tasks, actors, onOpen:onOpenRelated, onCreateItem,
            onMove: !uncertain && !busy && commandOf(commands,legacy ? 'move-goal-item' : 'move-item')
              ? (parent,parentTaskId) => onCommand(legacy ? parent : task,{type:legacy ? 'move-goal-item' : 'move-item'},
                legacy ? {itemId:task.id,parentTaskId} : {parentTaskId}) : undefined }),
          h(FactsBlock, { task }),
          h('div', { className: 'bt-card-side-block' }, h(ShareTask, { task, commands, targets, disabled: uncertain || busy, onCommand })),
          !canEdit && !canDetails && !canComment && !canUpload && !canShare && !canUnshare && !canMove && !canSchedule && !canGoalEdit && !canHistoryTitle
            ? h('p', { className: 'bt-card-note' }, t('Read only')) : null,
          h('details', { className: 'bt-card-more' }, h('summary', null, t('More actions')),
            h('div', { className: 'bt-card-more-body' },
              canEdit ? h(EditTask, { task, actors, tasks, disabled: uncertain || busy, onEdit: (target, value) => confirmCommand(target, { type: 'edit' }, value) }) : null,
              onDuplicate && !legacy && !task.shared ? h('button', { type: 'button', className: 'bt-btn bt-btn-ghost', disabled: uncertain || busy, onClick: () => onDuplicate(task) }, h(CopyIcon), t('Duplicate card')) : null,
              canArchive ? h('button', { type: 'button', className: 'bt-btn bt-btn-ghost', disabled: uncertain || busy, onClick: () => void onCommand(task, { type:'archive' }) }, t('Archive card')) : null,
              canUnarchive ? h('button', { type: 'button', className: 'bt-btn bt-btn-ghost', disabled: uncertain || busy, onClick: () => void onCommand(task, { type:'unarchive' }) }, t('Restore from archive')) : null,
              canGoalEdit ? h(EditGoalTask, { task, disabled: uncertain || busy, onEdit: (target, value) => confirmCommand(target, { type: 'goal-task-edit' }, value) }) : null,
              canHistoryTitle ? h(EditHistoryTitle, { task, disabled: uncertain || busy, onEdit: (target, value) => confirmCommand(target, { type: 'goal-history-title' }, value) }) : null,
              !legacy ? h(TaskHistory, { scope, task, request }) : null,
              legacy && Array.isArray(task.boardHistory) && task.boardHistory.length ? h('details', { className: 'bt-card-history' }, h('summary', null, t('Card revision history')),
                task.boardHistory.map(entry => h('article', { key: entry.operationId }, h('strong', null, (Number.isFinite(entry.at) ? new Date(entry.at).toLocaleString() : '') + ' · ' + t('You') + ' · ' + entry.kind),
                  entry.reason ? h('p', null, entry.reason) : null, h('p', null, t('Before') + ': ' + JSON.stringify(entry.before)), h('p', null, t('After') + ': ' + JSON.stringify(entry.after))))) : null,
              !canEdit && !canDetails && !canComment && !canUpload && !canShare && !canUnshare && !canMove && !canSchedule && !canGoalEdit && !canHistoryTitle
                ? h('p', { className: 'bt-card-note' }, t('Read only')) : null)))),
      lightbox ? h('div', { className: 'bt-lightbox', onMouseDown: event => { if (event.target === event.currentTarget) setLightbox(null) } },
        h('img', { src: lightbox.url, alt: lightbox.name || t('Attachment') }),
        h('div', { className: 'bt-lightbox-bar' }, h('span', null, lightbox.name || t('Attachment')), h('button', { type: 'button', className: 'bt-icon-btn', 'aria-label': t('Close image'), onClick: () => setLightbox(null) }, h(CloseIcon)))) : null))
}


function ColumnRail({ label, personal, children }) {
  const rail = useRef(null)
  const [overflow, setOverflow] = useState(false)
  const [range, setRange] = useState({ from: 1, to: 0, total: 0 })
  const move = direction => { const node = rail.current; if (node) node.scrollBy({ left: direction * Math.max(240, node.clientWidth * 0.8), behavior: 'smooth' }) }
  useEffect(() => {
    const node = rail.current
    if (!node) return
    const update = () => {
      setOverflow(node.scrollWidth > node.clientWidth + 1)
      const lanes = [...node.children].filter(child => child.nodeType === 1)
      if (!lanes.length) { setRange({ from: 0, to: 0, total: 0 }); return }
      const left = node.scrollLeft, right = left + node.clientWidth
      const visible = lanes.map((child, index) => ({ index, start: child.offsetLeft, end: child.offsetLeft + child.offsetWidth }))
        .filter(item => item.end > left + 1 && item.start < right - 1)
      setRange({ from:(visible[0]?.index ?? 0) + 1, to:(visible.at(-1)?.index ?? 0) + 1, total:lanes.length })
    }
    const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(update) : null
    const mutation = typeof MutationObserver === 'function' ? new MutationObserver(() => { resize?.disconnect(); resize?.observe(node); for (const child of node.children) resize?.observe(child); update() }) : null
    resize?.observe(node)
    for (const child of node.children) resize?.observe(child)
    mutation?.observe(node, { childList: true, subtree: true, attributes: true })
    window.addEventListener('resize', update)
    node.addEventListener('scroll', update, { passive:true })
    update()
    return () => { resize?.disconnect(); mutation?.disconnect(); window.removeEventListener('resize', update); node.removeEventListener('scroll', update) }
  }, [])
  return h('div', { className: 'bt-board-rail' },
    h('div', { className: 'bt-board-rail-controls', hidden: !overflow },
      h('span', { className:'bt-board-rail-status', role:'status', 'aria-live':'polite' },
        t('Columns {from}–{to} of {total}', { from:range.from, to:range.to, total:range.total }),
        range.total > range.to ? h('span', { className:'bt-board-rail-more' }, ' · ', t('{count} more', { count:range.total - range.to })) : null),
      h('button', { type: 'button', className: 'bt-icon-btn', 'aria-label': t('Previous columns'), onClick: () => move(-1) }, h(ChevronLeftIcon)),
      h('button', { type: 'button', className: 'bt-icon-btn', 'aria-label': t('Next columns'), onClick: () => move(1) }, h(ChevronRightIcon))),
    h('div', { ref: rail, className: 'bt-board-columns' + (personal ? ' bt-board-columns-personal' : ''), role: 'region', 'aria-label': label, tabIndex: 0,
      onKeyDown: event => { if (event.target === event.currentTarget && ['ArrowLeft', 'ArrowRight'].includes(event.key)) { event.preventDefault(); move(event.key === 'ArrowLeft' ? -1 : 1) } } }, children))
}

function BoardLane({ kind, stage, label, count, meta, actions, releaseId, focus, createEnabled, onCreate, dropActive, empty, children, onDragOver, onDragLeave, onDrop, onRename, onMove, onArchiveAll }) {
  const [adding, setAdding] = useState(false)
  const [collapsed, setCollapsed] = useState(false)
  const [renameValue, setRenameValue] = useState(label)
  const menu = useRef(null)
  const [title, setTitle] = useState('')
  const closeComposer = () => { setAdding(false); setTitle('') }
  const submit = event => {
    event?.preventDefault?.()
    const value = title.trim()
    if (!value) return
    closeComposer()
    onCreate(value)
  }
  const rename = event => { event.preventDefault(); if (renameValue.trim()) onRename?.(renameValue); menu.current?.removeAttribute('open') }
  return h('section', { className: 'bt-board-lane' + (dropActive ? ' bt-board-lane-drop' : '') + (focus ? ' bt-board-lane-focus' : '') + (collapsed ? ' bt-board-lane-collapsed' : ''), 'aria-label': label, 'data-stage': stage, 'data-kind': kind,
    ...(releaseId ? { 'data-release-id': releaseId } : {}), onDragOver, onDragLeave, onDrop },
    h('header', { className: 'bt-board-lane-head' },
      h('div', { className: 'bt-board-lane-title' }, h('span', { className: 'bt-board-stage-dot bt-board-stage-dot-' + stage, 'aria-hidden': true }), h('h3', null, label), count ? h('span', { className: 'bt-board-count' }, count) : null, meta ?? null),
      h('div', { className:'bt-board-lane-head-actions' },
        onRename || onMove || onArchiveAll ? h('details', { ref:menu, className:'bt-board-lane-menu' },
          h('summary', { className:'bt-icon-btn', 'aria-label':t('Lane actions'), title:t('Lane actions') }, '⋯'),
          h('div', { className:'bt-board-lane-menu-body' },
            onRename ? h('form', { className:'bt-board-lane-rename', onSubmit:rename }, h('input', { value:renameValue, 'aria-label':t('Rename lane'), maxLength:40, onChange:event => setRenameValue(event.target.value) }), h('button', { type:'submit', className:'bt-card-mini' }, t('Save'))) : null,
            onMove ? h('button', { type:'button', className:'bt-board-lane-menu-item', onClick:() => { onMove(-1); menu.current?.removeAttribute('open') } }, t('Move lane left')) : null,
            onMove ? h('button', { type:'button', className:'bt-board-lane-menu-item', onClick:() => { onMove(1); menu.current?.removeAttribute('open') } }, t('Move lane right')) : null,
            onArchiveAll ? h('button', { type:'button', className:'bt-board-lane-menu-item bt-card-cancel', onClick:() => { onArchiveAll(); menu.current?.removeAttribute('open') } }, t('Archive all cards')) : null)) : null,
        h('button', { type:'button', className:'bt-icon-btn', 'aria-label': t(collapsed ? 'Expand lane' : 'Collapse lane'), title:t(collapsed ? 'Expand lane' : 'Collapse lane'), 'aria-expanded':!collapsed, onClick:() => setCollapsed(value => !value) }, h(ChevronRightIcon, { className:'bt-lane-chevron' + (collapsed ? ' bt-lane-chevron-collapsed' : '') })),
        actions ?? (createEnabled ? h('button', { type: 'button', className: 'bt-icon-btn bt-board-lane-add-icon', 'aria-label': t('Add card to {lane}', { lane: label }), title: t('Add card'), onClick: () => { closeComposer(); onCreate() } }, h(PlusIcon)) : null))),
    collapsed ? null : h('div', { className: 'bt-board-lane-cards' }, children),
    !collapsed && empty ? h('p', { className: 'bt-board-lane-empty' }, typeof empty === 'string' ? empty : t('Drop cards here')) : null,
    !collapsed && createEnabled ? (adding
      ? h('form', { className: 'bt-board-quick-add', onSubmit: submit },
        h('textarea', { value: title, rows: 2, autoFocus: true, 'aria-label': t('Card title'), placeholder: t('Enter a title'), onChange: event => setTitle(event.target.value), onKeyDown: event => { if (event.key === 'Escape') { event.preventDefault(); closeComposer() } } }),
        h('div', { className: 'bt-board-quick-add-actions' },
          h('button', { type: 'submit', className: 'bt-btn bt-btn-primary', disabled: !title.trim() }, t('Add card')),
          h('button', { type: 'button', className: 'bt-btn bt-btn-ghost', onClick: closeComposer }, t('Cancel'))))
      : h('button', { type: 'button', className: 'bt-board-lane-add', onClick: () => setAdding(true) }, h(PlusIcon), t('Add card'))) : null)
}

function ReleaseChip({ release, onOpen }) {
  const total = Number.isSafeInteger(release.itemCount) ? release.itemCount : 0
  const done = Number.isSafeInteger(release.doneCount) ? release.doneCount : 0
  return h('button', { type: 'button', className: 'bt-board-release-chip', onClick: onOpen,
    title: [release.name, release.version, t(RELEASE_STATUS_LABELS[release.status] ?? 'Status unknown')].filter(Boolean).join(' · '),
    'aria-label': [release.name, release.version, t(RELEASE_STATUS_LABELS[release.status] ?? 'Status unknown'), `${done}/${total}`].filter(Boolean).join(' · ') },
  h('span', { className: 'bt-board-release-version' }, release.version || textValue(release.name) || t('Untitled release')),
  h('span', { className: 'bt-board-release-progress' }, `${done}/${total}`))
}

function MajorVersionCard({ name, releases, tasks, onOpen, onCreate, disabled }) {
  const features = tasks.filter(task => !task.archivedAt && !task.shared && !task.legacy && !task.parentTaskId && ['feature','bugfix'].includes(task.type))
  const parentIds = new Set(features.map(task => task.id))
  const itemCount = tasks.filter(task => !task.archivedAt && parentIds.has(task.parentTaskId)).length
  return h('section', { className:'bt-major-version', 'aria-label':t('Major version') },
    h('header', { className:'bt-board-section-heading bt-board-section-heading-row' },
      h('div', null, h('h3', null, t('Major version'), ' · ', name),
        h('p', null, t('{cards} feature or bugfix cards · {items} task items', {cards:features.length, items:itemCount}))),
      h('button', { type:'button', className:'bt-btn bt-btn-ghost', disabled, onClick:onCreate }, h(PlusIcon), t('New release'))),
    h('h4', null, t('Minor releases')),
    releases.length ? h('ul', { className:'bt-minor-releases' }, releases.map(release =>
      h('li', { key:release.id }, h('button', { type:'button', onClick:() => onOpen(release.id) },
        h('span', null, textValue(release.name) || textValue(release.version) || t('Untitled release'),
          release.version && release.name && release.name !== release.version ? h('small', null, release.version) : null),
        h(ReleaseStatusChip, { status:release.status }))))) : h('p', { className:'bt-card-muted' }, t('No releases yet')))
}

function ReleaseDialog({ disabled, releaseRoles, releaseCandidates = {}, actors, onClose, onCreate }) {
  const roles = Array.isArray(releaseRoles) ? releaseRoles.filter(role => role && typeof role.key === 'string' && role.key) : []
  const teamSupported = roles.length > 0
  const bots = (Array.isArray(actors) ? actors : []).filter(actor => actor && typeof actor.id === 'string' && actor.id !== 'user')
  const candidates = releaseCandidates && typeof releaseCandidates === 'object' && !Array.isArray(releaseCandidates) ? releaseCandidates : {}
  const firstCandidate = key => candidates[key]?.[0]?.id ?? ''
  const teamRoles = roles.filter(role => role.key !== 'projectManager')
  const [name, setName] = useState('')
  const [version, setVersion] = useState('')
  const [manager, setManager] = useState(() => firstCandidate('projectManager'))
  const [assignments, setAssignments] = useState(() => Object.fromEntries(teamRoles.filter(role => role.required === true).map(role => [role.key, firstCandidate(role.key)])))
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const first = useRef(null)
  useEffect(() => { first.current?.focus() }, [])
  useEffect(() => {
    const onKey = event => { if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); onClose() } }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])
  // The project manager select answers the projectManager role; the other roles
  // keep their own select. Optional roles may stay unassigned.
  const requiredMissing = teamRoles.filter(role => role.required === true && !assignments[role.key])
  const missingCandidates = teamRoles.filter(role => role.required === true && !(Array.isArray(candidates[role.key]) && candidates[role.key].length))
  const teamReady = !!manager && requiredMissing.length === 0
  const valid = !!name.trim() && !!version.trim() && (!teamSupported || teamReady)
  const assign = (key, value) => setAssignments(current => ({ ...current, [key]: value }))
  const autoFill = () => {
    setManager(firstCandidate('projectManager'))
    setAssignments(Object.fromEntries(teamRoles.map(role => [role.key, firstCandidate(role.key)]).filter(([, id]) => id)))
  }
  const submit = async event => {
    event.preventDefault()
    if (!valid || disabled || saving) return
    setSaving(true); setError('')
    const picked = Object.fromEntries(Object.entries(assignments).filter(([, id]) => typeof id === 'string' && id))
    const team = teamSupported ? { projectManagerId: manager, roles: { ...picked, projectManager: manager } } : undefined
    try { await onCreate({ name: name.trim(), version: version.trim(), ...(team ? { team } : {}) }); onClose() }
    catch (caught) { setError(hostText(caught?.message) || t('The release could not be created. Check the fields and try again.')) }
    finally { setSaving(false) }
  }
  const close = () => { if (!saving) onClose() }
  const botSelect = (value, label, onPick, roleKey) => {
    const choices = Array.isArray(candidates[roleKey]) && candidates[roleKey].length ? candidates[roleKey] : bots
    return h('select', { value, 'aria-label': label, disabled: disabled || saving, onChange: event => onPick(event.target.value) },
      h('option', { value: '' }, t('Choose a Bot')), choices.map(bot => h('option', { key: bot.id, value: bot.id }, textValue(bot.name) || bot.id, bot.role ? ' · ' + bot.role : '')))
  }
  return h('div', { className: 'bt-card-modal-backdrop bt-create-backdrop', onMouseDown: event => { if (event.target === event.currentTarget) close() } },
    h('section', { className: 'bt-card-modal bt-create-modal bt-release-modal' + (teamSupported ? ' bt-release-modal-team' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-label': t('New release'), tabIndex: -1 },
      h('header', { className: 'bt-card-modal-header' },
        h('div', null, h('p', { className: 'bt-card-eyebrow' }, t('Releases')), h('h2', null, t('New release'))),
        h('button', { type: 'button', className: 'bt-icon-btn', 'aria-label': t('Close'), onClick: close }, h(CloseIcon))),
      h('form', { className: 'bt-create-form', onSubmit: submit },
        h('label', { className: 'bt-field' }, h('span', null, t('Release name')), h('input', { ref: first, value: name, maxLength: 200, disabled: disabled || saving, 'aria-label': t('Release name'), placeholder: t('Release name'), onChange: event => setName(event.target.value) })),
        h('label', { className: 'bt-field' }, h('span', null, t('Version')), h('input', { value: version, maxLength: 100, disabled: disabled || saving, 'aria-label': t('Version'), placeholder: t('Version'), onChange: event => setVersion(event.target.value) })),
        teamSupported ? h('section', { className: 'bt-release-team', 'aria-label': t('Release team') },
          h('div', { className: 'bt-release-team-head' },
            h('h3', null, t('Release team')),
            h('span', { className: 'bt-release-team-count' }, t('{count} roles', { count: roles.length })),
            h('button', { type:'button', className:'bt-card-mini', disabled: disabled || saving, onClick: autoFill }, t('Auto-fill roles'))),
          h('p', { className: 'bt-create-note' }, t('This minor release uses the current major-version group and its existing admin and members.')),
          h('label', { className: 'bt-field bt-release-team-pm' },
            h('span', null, t('Project Manager'), h('span', { className: 'bt-release-required' }, ' *')),
            botSelect(manager, t('Project Manager'), setManager, 'projectManager')),
          h('div', { className: 'bt-release-team-grid' }, teamRoles.map(role => h('label', { key: role.key, className: 'bt-field' },
            h('span', null, releaseRoleLabel(role), role.required === true ? h('span', { className: 'bt-release-required' }, ' *') : null),
            botSelect(assignments[role.key] ?? '', releaseRoleLabel(role), value => assign(role.key, value), role.key)))),
          teamReady ? null : h('p', { className: 'bt-release-team-hint', role: 'note' },
            missingCandidates.length
              ? t('No Bot is tagged for {roles}. Pick another Bot, or create one with that role in Bots settings.', { roles: missingCandidates.map(releaseRoleLabel).join(', ') })
              : t('Choose a project manager and every required role.'))) : null,
        error ? h('p', { className: 'bt-form-error', role: 'alert' }, error) : null,
        h('div', { className: 'bt-create-actions' },
          h('button', { type: 'button', className: 'bt-btn bt-btn-ghost', disabled: saving, onClick: close }, t('Cancel')),
          h('button', { type: 'submit', className: 'bt-btn bt-btn-primary', disabled: disabled || saving || !valid }, t('Create release'))))))
}

// One release gate: status, evidence, and its own small edit surface. The host
// accepts evidence as optional; this view requires it before a gate may pass.
function ReleaseGateRow({ gateKey, label, gate, editable, disabled, onSave }) {
  const status = RELEASE_GATE_STATUSES.has(gate?.status) ? gate.status : 'pending'
  const saved = textValue(gate?.evidence)
  const [draftStatus, setDraftStatus] = useState(status)
  const [draftEvidence, setDraftEvidence] = useState(saved)
  const evidence = draftEvidence.trim()
  const needsEvidence = draftStatus === 'passed' && !evidence
  const changed = draftStatus !== status || evidence !== saved.trim()
  return h('article', { className: 'bt-release-gate' },
    h('div', { className: 'bt-release-gate-head' },
      h('strong', null, t(label)),
      h('span', { className: 'bt-release-gate-state bt-release-gate-state-' + status }, t(RELEASE_GATE_STATUS_LABELS[status]))),
    h('p', { className: 'bt-release-gate-evidence' }, saved || t('No evidence')),
    editable ? h('div', { className: 'bt-release-gate-edit' },
      h('label', { className: 'bt-release-gate-field' }, h('span', null, t('Gate status')),
        h('select', { value: draftStatus, disabled, 'aria-label': t(label) + ' ' + t('Gate status'), onChange: event => setDraftStatus(event.target.value) },
          ['pending', 'passed', 'failed'].map(value => h('option', { key: value, value }, t(RELEASE_GATE_STATUS_LABELS[value]))))),
      h('label', { className: 'bt-release-gate-field bt-release-gate-field-evidence' }, h('span', null, t('Evidence')),
        h('input', { value: draftEvidence, maxLength: 500, disabled, placeholder: t('Short evidence'), 'aria-label': t(label) + ' ' + t('Evidence'), onChange: event => setDraftEvidence(event.target.value) })),
      h('button', { type: 'button', className: 'bt-btn bt-btn-ghost bt-release-gate-save', disabled: disabled || !changed || needsEvidence, onClick: () => onSave(gateKey, draftStatus, evidence) }, t('Save gate'))) : null,
    needsEvidence ? h('p', { className: 'bt-release-gate-hint', role: 'note' }, t('Evidence is required to pass a gate.')) : null)
}

function ReleaseDetailDialog({ release, actors, releaseRoles, canEdit, busy, error, onClose, onCheck, onSaveGate, onOpenReport }) {
  const modal = useRef(null)
  useEffect(() => { modal.current?.focus() }, [])
  useEffect(() => {
    const onKey = event => { if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); onClose() } }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])
  const roles = Array.isArray(releaseRoles) && releaseRoles.length
    ? releaseRoles.filter(role => role && typeof role.key === 'string' && role.key)
    : Object.keys(releaseRolesOf(release)).map(key => ({ key, required: false }))
  const name = textValue(release.name) || t('Untitled release')
  const groupId = textValue(release.groupId)
  const total = Number.isSafeInteger(release.itemCount) ? release.itemCount : 0
  const done = Number.isSafeInteger(release.doneCount) ? release.doneCount : 0
  const passed = releaseGatePassedCount(release)
  const running = release.status === 'running'
  return h('div', { className: 'bt-card-modal-backdrop', onMouseDown: event => { if (event.target === event.currentTarget) onClose() } },
    h('section', { ref: modal, className: 'bt-card-modal bt-release-detail', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('Release details') + ': ' + name, tabIndex: -1 },
      h('header', { className: 'bt-card-modal-header' },
        h('div', { className: 'bt-card-modal-heading' },
          h('p', { className: 'bt-card-eyebrow' }, t('Release details')),
          h('h2', null, release.version ? name + ' · ' + release.version : name),
          h('div', { className: 'bt-card-submeta' }, h(ReleaseStatusChip, { status: release.status }), h('span', { className: 'bt-board-id' }, release.id))),
        h('div', { className: 'bt-card-modal-actions' },
          h('button', { type: 'button', className: 'bt-icon-btn', 'aria-label': t('Close'), 'data-close-card': 'true', onClick: onClose }, h(CloseIcon)))),
      h('div', { className: 'bt-release-detail-body' },
        error ? h('p', { className: 'bt-form-error', role: 'alert' }, error) : null,
        release.failure ? h('p', { className: 'bt-card-warning', role: 'status' }, t('Failure') + ': ' + textValue(release.failure)) : null,
        h('div', { className: 'bt-release-facts' },
          h(Fact, { label: t('Project manager'), value: release.projectManagerId ? actorName(release.projectManagerId, actors) : t('Unassigned') }),
          h(Fact, { label: t('Major-version group'), value: groupId || t('Unknown') }),
          h(Fact, { label: t('Items'), value: t('{done}/{total} done', { done, total }) }),
          h(Fact, { label: t('Gates'), value: `${passed}/${RELEASE_GATES.length}` }),
          release.startedAt ? h(Fact, { label: t('Started'), value: formatMoment(release.startedAt) }) : null,
          release.publishedAt ? h(Fact, { label: t('Published at'), value: formatMoment(release.publishedAt) }) : null),
        h('section', { className: 'bt-release-section' },
          h('div', { className: 'bt-release-section-head' },
            h('h3', null, t('Role assignments')),
            h('span', { className: 'bt-release-section-count' }, t('{count} assigned', { count: releaseRoleCount(release) }))),
          roles.length
            ? h('div', { className: 'bt-release-role-list' }, roles.map(role => {
              const id = releaseRoleId(release, role.key)
              return h('div', { key: role.key, className: 'bt-release-role' },
                h('span', null, releaseRoleLabel(role), role.required === true ? h('span', { className: 'bt-release-required' }, ' *') : null),
                h('span', { className: id ? 'bt-release-role-name' : 'bt-release-role-name bt-release-role-none' }, id ? actorLabel(id, actors) : t('Unassigned')))
            }))
            : h('p', { className: 'bt-card-muted' }, t('No release team'))),
        h('section', { className: 'bt-release-section' },
          h('div', { className: 'bt-release-section-head' },
            h('h3', null, t('Gates')),
            h('span', { className: 'bt-release-section-count' }, `${passed}/${RELEASE_GATES.length}`)),
          h('div', { className: 'bt-release-gates' }, RELEASE_GATES.map(([key, label]) => h(ReleaseGateRow, {
            key: `${release.id}:${key}:${release.gates?.[key]?.updatedAt ?? 0}`,
            gateKey: key, label, gate: release.gates?.[key], editable: canEdit,
            disabled: busy || canEdit !== true, onSave: onSaveGate })))),
        h('div', { className: 'bt-release-detail-actions' },
          release.report ? h('button', { type: 'button', className: 'bt-btn bt-btn-ghost', onClick: () => onOpenReport(release) }, t('Open summary report')) : null,
          h('button', { type: 'button', className: 'bt-btn bt-btn-primary', disabled: busy || !running,
            ...(running ? {} : { title: t('Only a running release can be checked.') }), onClick: () => onCheck(release) }, t('Check release'))))))
}

function ReleaseReportDialog({ release, report, onClose, onBack }) {
  const modal = useRef(null)
  useEffect(() => { modal.current?.focus() }, [])
  useEffect(() => {
    const onKey = event => { if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); onClose() } }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])
  const name = textValue(release.name) || t('Untitled release')
  return h('div', { className: 'bt-card-modal-backdrop', onMouseDown: event => { if (event.target === event.currentTarget) onClose() } },
    h('section', { ref: modal, className: 'bt-card-modal bt-release-report', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('Summary report') + ': ' + name, tabIndex: -1 },
      h('header', { className: 'bt-card-modal-header' },
        h('div', { className: 'bt-card-modal-heading' },
          h('p', { className: 'bt-card-eyebrow' }, t('Summary report')),
          h('h2', null, release.version ? name + ' · ' + release.version : name),
          h('p', { className: 'bt-card-note' }, t('The report is read only.'))),
        h('div', { className: 'bt-card-modal-actions' },
          h('button', { type: 'button', className: 'bt-icon-btn', 'aria-label': t('Close'), 'data-close-card': 'true', onClick: onClose }, h(CloseIcon)))),
      h('div', { className: 'bt-release-report-body' },
        report?.error ? h('p', { className: 'bt-form-error', role: 'alert' }, report.error)
          : report && report.loading !== true ? h('pre', { className: 'bt-release-report-text' }, report.text)
            : h('p', { className: 'bt-card-muted', role: 'status' }, t('Loading…'))),
      h('div', { className: 'bt-release-report-foot' },
        h('span', { className: 'bt-card-note' }, report?.generatedAt ? t('Generated at {time}', { time: formatMoment(report.generatedAt) }) : ''),
        h('div', { className: 'bt-release-report-buttons' },
          onBack ? h('button', { type: 'button', className: 'bt-btn bt-btn-ghost', onClick: onBack }, t('Back to release')) : null,
          h('button', { type: 'button', className: 'bt-btn bt-btn-primary', onClick: onClose }, t('Close'))))))
}

const PROPOSAL_KIND_LABELS = { create:'Create', update:'Update', status:'Status', release:'Release' }
function ProposalPanel({ proposals, actors, tasks, releases, disabled, busy, error, onDecide, onClose }) {
  return h('section', { className: 'bt-board-proposals', role: 'region', 'aria-label': t('Changes') },
    h('div', { className: 'bt-board-proposals-head' },
      h('h3', null, t('Changes')),
      h('span', { className: 'bt-board-count' }, proposals.length),
      h('button', { type: 'button', className: 'bt-card-mini', onClick: onClose }, t('Close'))),
    error ? h('p', { className: 'bt-form-error', role: 'alert' }, error) : null,
    proposals.length ? proposals.map(proposal => {
      const title = textValue(proposal.taskTitle) || textValue((Array.isArray(tasks) ? tasks : []).find(task => task.id === proposal.taskId)?.title) || textValue(proposal.taskId) || t('Unknown')
      const rows = proposalRows(proposal, actors, tasks, releases)
      return h('article', { key: proposal.id, className: 'bt-board-proposal' },
        h('div', { className: 'bt-board-proposal-head' },
          h('strong', null, title),
          h('span', { className: 'bt-board-proposal-kind' }, t(PROPOSAL_KIND_LABELS[proposal.kind] ?? 'Update'))),
        h('p', { className: 'bt-board-proposal-meta' }, t('Proposed by {name}', { name: actorName(proposal.proposer, actors) }), ' · ', relativeTime(proposal.createdAt)),
        proposal.note ? h('p', { className: 'bt-board-proposal-note' }, proposal.note) : null,
        rows.length ? h('div', { className: 'bt-board-proposal-diff' }, rows.map(row => h('div', { key: row.field, className: 'bt-card-diff-row' },
          h('strong', null, t(row.label)),
          h('div', { className: 'bt-card-diff-values' },
            h('span', null, h('b', null, t('Before') + ': '), row.before),
            h('span', null, h('b', null, t('After') + ': '), row.after))))) : null,
        h('div', { className: 'bt-board-proposal-actions' },
          h('button', { type: 'button', className: 'bt-btn bt-btn-ghost', disabled: disabled || busy === proposal.id, onClick: () => onDecide(proposal, 'reject') }, t('Reject')),
          h('button', { type: 'button', className: 'bt-btn bt-btn-primary', disabled: disabled || busy === proposal.id, onClick: () => onDecide(proposal, 'confirm') }, t('Confirm'))))
    }) : h('p', { className: 'bt-card-muted' }, t('No pending changes.')))
}

/** A server-authorized group or personal board. */
export function TaskBoard({ scope, title, close, request = call, goal, resolveReview, refreshGoal, currentRoomGoal, initialReview = false }) {
  const [visible, setVisible] = useState(true)
  const [snapshot, setData] = useState(null)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [toolsOpen, setToolsOpen] = useState(initialReview)
  const [recoveryOpen, setRecoveryOpen] = useState(false)
  const recoveryScope = useRef(null)
  const [memberFilter, setMemberFilter] = useState('')
  const [labelFilter, setLabelFilter] = useState('')
  const [dueFilter, setDueFilter] = useState('')
  const [typeFilter, setTypeFilter] = useState('')
  const [sortMode, setSortMode] = useState('')
  const preferenceKey = `ds-bot:board-prefs:${scope.kind}:${scope.id}`
  const [lanePrefs, setLanePrefs] = useState(() => {
    try { const value = JSON.parse(globalThis.localStorage?.getItem(preferenceKey) ?? '{}'); return { names:value.names ?? {}, order:Array.isArray(value.order) ? value.order : [] } }
    catch { return { names:{}, order:[] } }
  })
  useEffect(() => { try { globalThis.localStorage?.setItem(preferenceKey, JSON.stringify(lanePrefs)) } catch {} }, [preferenceKey, lanePrefs])
  const [view, setView] = useState('status')
  const [releaseFocus, setReleaseFocus] = useState('')
  const [changesOpen, setChangesOpen] = useState(false)
  const [proposalUnread, setProposalUnread] = useState(0)
  const knownProposals = useRef(0)
  const loadRef = useRef(null)
  const [newRelease, setNewRelease] = useState(false)
  const [releasePanel, setReleasePanel] = useState(null)
  const [releaseReport, setReleaseReport] = useState(null)
  const [releaseBusy, setReleaseBusy] = useState('')
  const [releaseError, setReleaseError] = useState('')
  const [proposalBusy, setProposalBusy] = useState('')
  const [proposalError, setProposalError] = useState('')
  const [selectedCard, setSelectedCard] = useState(null)
  const [createFor, setCreateFor] = useState(null)
  const [notice, setNotice] = useState('')
  const [noticeAction, setNoticeAction] = useState(null)
  const [dragId, setDragId] = useState('')
  const [selectionMode, setSelectionMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState(() => new Set())
  const [drop, setDrop] = useState(null)
  const [boardConfirm, setBoardConfirm] = useState(null)
  const boardConfirmRef = useRef(null)
  const boardConfirmBox = useRef(null)
  const cardOpener = useRef(null)
  const noticeTimer = useRef(null)
  const [pending, setPending] = useState(() => pendingStore(scope)?.current ?? '')
  const [busy, setBusy] = useState(false)
  const [bulkBusy, setBulkBusy] = useState(false)
  const [cancelBusy, setCancelBusy] = useState(false)
  const active = useRef(false)
  const generation = useRef(0)
  const loadSequence = useRef(0)
  const reading = useRef(null)
  const dialog = useRef(null)
  const searchRef = useRef(null)
  const dispose = useRef(null)
  const dismissed = useRef(false)
  const pendingRef = useRef(pending)
  const fetching = useRef(null)
  const cancelling = useRef(null)
  const store = useRef(null)
  const key = scope.kind + ':' + scope.id
  const data = snapshot?.key === key ? snapshot.value : null
  const notify = (text, action) => { clearTimeout(noticeTimer.current); setNotice(text); setNoticeAction(action ? { label:t('Undo'), run:action } : null); noticeTimer.current = setTimeout(() => { setNotice(''); setNoticeAction(null) }, 5200) }
  const runNoticeAction = async () => { const action = noticeAction; setNotice(''); setNoticeAction(null); clearTimeout(noticeTimer.current); try { await action?.run() } catch (caught) { setError(hostText(caught?.message) || t('The undo could not be completed.')) } }
  useEffect(() => () => clearTimeout(noticeTimer.current), [])
  const askBoardConfirm = payload => new Promise(resolve => {
    if (boardConfirmRef.current) { resolve(false); return }
    const entry = { ...payload, resolve }
    boardConfirmRef.current = entry
    setBoardConfirm(entry)
  })
  const settleBoardConfirm = approved => {
    const current = boardConfirmRef.current
    boardConfirmRef.current = null
    setBoardConfirm(null)
    current?.resolve(approved)
  }
  useEffect(() => { if (boardConfirm) boardConfirmBox.current?.focus() }, [boardConfirm])

  const current = epoch => active.current && generation.current === epoch
  const load = async (epoch = generation.current, preserveError = false) => {
    const sequence = ++loadSequence.current
    reading.current = sequence
    try {
      const includeRecovery = recoveryScope.current === key
      const next = await request('board-list', { scope, includeRecovery })
      if (!current(epoch) || sequence !== loadSequence.current) return
      if (!next || !Array.isArray(next.tasks)) throw new Error(t('Invalid board response'))
      boardColumns(next.tasks)
      const recovery = includeRecovery && recoveryScope.current === key ? next.recovery ?? null : undefined
      setData({ key, value:{ ...next, recovery } })
      const nextProposals = Array.isArray(next.proposals) ? next.proposals.length : 0
      if (!changesOpen && nextProposals > knownProposals.current) setProposalUnread(value => value + (nextProposals - knownProposals.current))
      knownProposals.current = nextProposals
      if (!pendingRef.current && !preserveError) setError('')
      return true
    } catch (caught) {
      if (current(epoch) && sequence === loadSequence.current) {
        if (recoveryScope.current === key) setData(existing => existing?.key === key ? { key, value:{ ...existing.value, recovery:null } } : existing)
        setError(caught?.message || t('Unable to load board'))
      }
    } finally {
      if (reading.current === sequence) reading.current = null
    }
    return false
  }
  loadRef.current = load
  const inspectRecovery = open => {
    recoveryScope.current = open ? key : null
    setRecoveryOpen(open)
    setData(existing => existing?.key === key ? { key, value:{ ...existing.value, recovery:undefined } } : existing)
    if (open) {
      setToolsOpen(true)
      void load()
    }
  }
  useEffect(() => {
    if (!visible) return
    const refresh = () => { if (!document.hidden && !selectedCard && !createFor && reading.current === null) void loadRef.current?.() }
    const timer = setInterval(refresh, 15_000)
    window.addEventListener('focus', refresh)
    return () => { clearInterval(timer); window.removeEventListener('focus', refresh) }
  }, [key, selectedCard, createFor, visible])
  const settle = async (id, result, epoch) => {
    if (!current(epoch) || pendingRef.current !== id) return
    if (!finalOperation(result?.state)) { setError(t('Action outcome is unknown; check it before making another change.')); return }
    if (result.state === 'rejected') setError(result.message ? hostText(result.message) : t('Action rejected'))
    const refreshed = await load(epoch, true) || (await new Promise(resolve => setTimeout(resolve, 180)), await load(epoch, true))
    if (!refreshed || !current(epoch) || pendingRef.current !== id) return
    store.current?.clear(); pendingRef.current = ''; setPending('')
    if (fetching.current === id) { fetching.current = null; setBusy(false) }
    if (result.state === 'committed') setError('')
    return result.state
  }
  const check = async (id, epoch = generation.current) => {
    try { return await settle(id, await request('board-operation', { scope, operationId: id }), epoch) }
    catch { if (current(epoch) && pendingRef.current === id) setError(t('Action outcome is unknown; check it before making another change.')) }
  }
  const cancel = async id => {
    if (cancelling.current || pendingRef.current !== id) return
    const epoch = generation.current
    const token = Symbol('cancel')
    cancelling.current = token; setCancelBusy(true)
    try { await settle(id, await request('board-operation-cancel', { scope, operationId: id }), epoch) }
    catch { if (current(epoch) && pendingRef.current === id) setError(t('Cancellation outcome is unknown. Check the original action again.')) }
    finally { if (cancelling.current === token) { cancelling.current = null; if (current(epoch)) setCancelBusy(false) } }
  }
  const dismiss = () => {
    if (dismissed.current) return
    dismissed.current = true
    dispose.current?.()
    flushSync(() => setVisible(false))
    close()
  }
  useEffect(() => {
    if (!visible) return undefined
    active.current = true
    recoveryScope.current = null
    setRecoveryOpen(false); setToolsOpen(initialReview)
    const epoch = ++generation.current
    const previousFocus = document.activeElement
    store.current = pendingStore(scope)
    fetching.current = null; cancelling.current = null
    setBusy(false); setCancelBusy(false); setData(null); setError(''); setSearch(''); setMemberFilter(''); setLabelFilter(''); setDueFilter(''); setTypeFilter(''); setView('status'); setReleaseFocus(''); setChangesOpen(false); setNewRelease(false); setReleasePanel(null); setReleaseReport(null); setReleaseBusy(''); setReleaseError(''); setProposalBusy(''); setProposalError(''); setCreateFor(null); setSelectedCard(null); setDragId(''); setDrop(null); setBoardConfirm(null); boardConfirmRef.current = null
    const operation = store.current?.current ?? ''
    pendingRef.current = operation; setPending(operation)
    void load(epoch)
    if (operation) void check(operation, epoch)
    dialog.current?.focus()
    const keyDown = event => {
      const createModal = dialog.current?.querySelector('.bt-create-modal')
      if (event.key === 'Escape' && boardConfirmRef.current) { event.preventDefault(); event.stopPropagation(); settleBoardConfirm(false); return }
      if (event.key === 'Tab' && boardConfirmRef.current && boardConfirmBox.current) {
        const buttons = [...boardConfirmBox.current.querySelectorAll('button:not([disabled])')]
        if (!buttons.length) return
        const index = buttons.indexOf(document.activeElement)
        const next = event.shiftKey ? (index <= 0 ? buttons.length - 1 : index - 1) : (index < 0 || index === buttons.length - 1 ? 0 : index + 1)
        event.preventDefault(); buttons[next].focus(); return
      }
      if (createModal && event.key === 'Escape') return
      if (event.key === 'Escape' && dialog.current?.querySelector('.bt-board-filters-open')) { event.preventDefault(); event.stopPropagation(); setFiltersOpen(false); return }
      const modal = dialog.current?.querySelector('.bt-card-modal')
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (modal) modal.querySelector('[data-close-card]')?.click(); else dismiss(); return }
      if (event.key !== 'Tab' || !dialog.current) return
      const root = modal ?? dialog.current
      const focusable = [...root.querySelectorAll('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),summary,a[href],[tabindex="0"]')].filter(item => !item.closest('[inert]') && !hiddenInClosedDetails(item) && item.getClientRects().length > 0)
      if (!focusable.length) { event.preventDefault(); root.focus(); return }
      const index = focusable.indexOf(document.activeElement)
      if (event.shiftKey && index <= 0) { event.preventDefault(); focusable[focusable.length - 1].focus() }
      else if (!event.shiftKey && (index < 0 || index === focusable.length - 1)) { event.preventDefault(); focusable[0].focus() }
    }
    window.addEventListener('keydown', keyDown)
    let disposed = false
    const cleanup = () => { if (disposed) return; disposed = true; active.current = false; generation.current += 1; window.removeEventListener('keydown', keyDown); previousFocus?.focus?.() }
    dispose.current = cleanup
    return () => { cleanup(); if (dispose.current === cleanup) dispose.current = null }
  }, [key, visible])

  const run = async (task, command, value) => {
    if (fetching.current || pendingRef.current || !store.current || !window.crypto?.randomUUID) return
    const operationId = (command.type.startsWith('goal-') ? 'goal:' : '') + window.crypto.randomUUID()
    fetching.current = operationId
    const epoch = generation.current
    try {
      store.current.put(operationId); pendingRef.current = operationId; setPending(operationId); setBusy(true)
      await request('board-command', { scope, operationId, taskId: task.id,
        ...(Number.isSafeInteger(task.revision) ? { expectedRevision: task.revision } : {}),
        ...(task.legacy?.useOverlay ? { expectedBoardRevision: task.legacy.boardRevision, expectedPosition: task.legacy.position } : {}),
        type: command.type, ...(value !== undefined ? { value } : {}) })
      const state = await check(operationId, epoch)
      const inverse = { cancel:'restore', submit:'cancel', archive:'unarchive', schedule:'unschedule' }[command.type]
      if (state === 'committed' && inverse) {
        notify(t('Card updated'), async () => {
          const latest = await request('board-list', { scope, includeRecovery:false })
          const currentTask = (latest?.tasks ?? []).find(item => item.id === task.id)
          if (!currentTask) return
          await request('board-command', { scope, operationId:window.crypto.randomUUID(), taskId:task.id, expectedRevision:currentTask.revision, type:inverse })
          await load(); notify(t('Card restored'))
        })
      }
      return state
    } catch (caught) {
      if (current(epoch) && pendingRef.current === operationId) return await check(operationId, epoch)
      if (current(epoch) && !pendingRef.current && fetching.current === operationId) setError(caught?.message || t('Unable to save action'))
    } finally { if (fetching.current === operationId) { fetching.current = null; if (current(epoch)) setBusy(false) } }
  }
  const undoReorder = afterId => async taskId => {
    const latest = await request('board-list', { scope, includeRecovery:false })
    const current = (latest?.tasks ?? []).find(item => item.id === taskId)
    if (!current) return
    await request('board-command', { scope, operationId:window.crypto.randomUUID(), taskId, expectedRevision:current.revision, type:'reorder', value:{ afterId } })
    await load(); notify(t('Card order restored'))
  }
  const upload = async (task, images) => {
    if (fetching.current || pendingRef.current || !store.current || !window.crypto?.randomUUID) return
    const epoch = generation.current
    const token = Symbol('upload')
    let operationId
    fetching.current = token; setBusy(true)
    try {
      const encoded = await Promise.all(images.map(image => new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onerror = () => reject(new Error(t('Unable to read image')))
        reader.onload = () => { const encodedData = String(reader.result ?? '').split(',')[1]
          if (!encodedData || !/^[A-Za-z0-9+/]+={0,2}$/.test(encodedData)) reject(new Error(t('Unable to read image')))
          else resolve({ uploadId: image.uploadId, mediaType: image.file.type, name: image.file.name, data: encodedData }) }
        reader.readAsDataURL(image.file)
      })))
      if (!current(epoch)) return
      operationId = (task.legacy ? 'goal:' : '') + window.crypto.randomUUID()
      store.current.put(operationId); pendingRef.current = operationId; fetching.current = operationId; setPending(operationId)
      await request('board-upload', { scope, taskId: task.id, expectedRevision: task.revision, ...(task.legacy?.useOverlay ? { expectedBoardRevision: task.legacy.boardRevision, expectedPosition: task.legacy.position } : {}), operationId, images: encoded })
      return await check(operationId, epoch)
    } catch (caught) {
      if (current(epoch) && operationId && pendingRef.current === operationId) return await check(operationId, epoch)
      if (current(epoch) && !pendingRef.current && (fetching.current === token || fetching.current === operationId)) setError(caught?.message || t('Image upload failed'))
    } finally { if (fetching.current === token || fetching.current === operationId) { fetching.current = null; if (current(epoch)) setBusy(false) } }
  }
  const canAct = !!store.current && !!window.crypto?.randomUUID && !pending && !busy
  const commandMap = data?.capabilities?.commands ?? {}
  const capacity = data?.capabilities
  const showCapacity = Number.isSafeInteger(capacity?.taskCount) && capacity.taskCount >= 0 && Number.isSafeInteger(capacity?.taskLimit) && capacity.taskLimit > 0
  const capacityReached = capacity?.taskLimitReached === true
  const actors = capacity?.actors
  const createEnabled = canAct && capacity?.create === true && Array.isArray(actors) && !capacityReached
  useEffect(() => {
    if (!visible) return
    const onKey = event => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || selectedCard || createFor) return
      const target = event.target
      if (target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return
      if (event.key === '/') { event.preventDefault(); searchRef.current?.focus(); return }
      if (event.key.toLowerCase() === 'n' && createEnabled) {
        event.preventDefault()
        setCreateFor({ laneLabel:t('Preparing'), scheduleOnCreate:false, followup:false })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectedCard, createFor, createEnabled, visible])
  const createCard = value => {
    if (!window.crypto?.randomUUID) return Promise.resolve(undefined)
    return run({ id: window.crypto.randomUUID() }, { type: 'create' }, createFor?.parentTaskId ? { ...value, parentTaskId:createFor.parentTaskId } : value)
  }
  const bulkArchive = async () => {
    const ids = [...selectedIds]
    if (!ids.length || bulkBusy || !window.crypto?.randomUUID) return
    setBulkBusy(true)
    try {
      for (const id of ids) {
        const task = allTasks.find(item => item.id === id)
        if (!task || task.archivedAt || !commandsFor(task).some(command => command.type === 'archive')) continue
        await request('board-command', { scope, operationId:window.crypto.randomUUID(), taskId:id, expectedRevision:task.revision, type:'archive' })
      }
      setSelectedIds(new Set()); setSelectionMode(false)
      await load()
      notify(t('Archived {count} cards', { count:ids.length }), async () => {
        const latest = await request('board-list', { scope, includeRecovery:false })
        const current = (latest?.tasks ?? []).filter(task => ids.includes(task.id) && task.archivedAt)
        for (const task of current) await request('board-command', { scope, operationId:window.crypto.randomUUID(), taskId:task.id, expectedRevision:task.revision, type:'unarchive' })
        await load()
        notify(t('Archived cards restored'))
      })
    } catch (caught) { setError(hostText(caught?.message) || t('Unable to archive cards')) }
    finally { setBulkBusy(false) }
  }
  const bulkCancel = async () => {
    const ids = [...selectedIds]
    if (!ids.length || bulkBusy || !window.crypto?.randomUUID) return
    const approved = await askBoardConfirm({ title:t('Cancel {count} cards', { count:ids.length }), rows:[{ label:t('Status'), before:t('Selected'), after:t('Cancelled') }] })
    if (!approved) return
    setBulkBusy(true)
    try {
      let changed = 0
      for (const id of ids) {
        const task = allTasks.find(item => item.id === id)
        if (!task || ['done','cancelled'].includes(task.status) || !commandsFor(task).some(command => command.type === 'cancel')) continue
        await request('board-command', { scope, operationId:window.crypto.randomUUID(), taskId:id, expectedRevision:task.revision, type:'cancel', value:{ reason:'Cancelled from bulk selection' } })
        changed += 1
      }
      setSelectedIds(new Set()); setSelectionMode(false)
      await load()
      if (changed) notify(t('Cancelled {count} cards', { count:changed }), async () => {
        const latest = await request('board-list', { scope, includeRecovery:false })
        const current = (latest?.tasks ?? []).filter(task => ids.includes(task.id) && task.status === 'cancelled')
        for (const task of current) await request('board-command', { scope, operationId:window.crypto.randomUUID(), taskId:task.id, expectedRevision:task.revision, type:'restore' })
        await load()
        notify(t('Cancelled cards restored'))
      })
    } catch (caught) { setError(hostText(caught?.message) || t('Unable to cancel cards')) }
    finally { setBulkBusy(false) }
  }
  const bulkApplyStatus = async action => {
    const spec = BULK_STATUS_ACTIONS.find(item => item.id === action)
    const ids = [...selectedIds]
    if (!spec || !ids.length || bulkBusy || !window.crypto?.randomUUID) return
    const approved = await askBoardConfirm({ title:t('Update {count} cards', { count:ids.length }), rows:[{ label:t('Status'), before:t('Selected cards'), after:t(spec.label) }] })
    if (!approved) return
    setBulkBusy(true)
    const changed = []
    try {
      for (const id of ids) {
        const task = allTasks.find(item => item.id === id)
        if (!task || !commandsFor(task).some(command => command.type === spec.id)) continue
        await request('board-command', { scope, operationId:window.crypto.randomUUID(), taskId:id, expectedRevision:task.revision, type:spec.id })
        changed.push(id)
      }
      setSelectedIds(new Set()); setSelectionMode(false)
      await load(); notify(t('Updated {count} cards', { count:changed.length }), changed.length ? async () => {
        let failed = 0
        for (const id of changed) {
          const latest = await request('board-list', { scope, includeRecovery:false })
          const current = (latest?.tasks ?? []).find(item => item.id === id)
          if (!current) continue
          try { await request('board-command', { scope, operationId:window.crypto.randomUUID(), taskId:id, expectedRevision:current.revision, type:spec.inverse }) }
          catch { failed += 1 }
        }
        await load()
        notify(failed ? t('Some changes could not be undone.') : t('Card changes restored'))
      } : undefined)
    } catch (caught) { setError(hostText(caught?.message) || t('Unable to update cards')) }
    finally { setBulkBusy(false) }
  }
  const archiveLane = async (kind, stage, laneTasks) => {
    const ids = laneTasks.filter(task => !task.archivedAt && commandsFor(task).some(command => command.type === 'archive')).map(task => task.id)
    if (!ids.length || !window.crypto?.randomUUID) return
    const approved = await askBoardConfirm({ title:t('Archive {count} cards', { count:ids.length }), rows:[{ label:t('Lane'), before:t('Selected lane'), after:t('Archived') }] })
    if (!approved) return
    setBulkBusy(true)
    try {
      for (const id of ids) {
        const task = allTasks.find(item => item.id === id)
        if (!task) continue
        await request('board-command', { scope, operationId:window.crypto.randomUUID(), taskId:id, expectedRevision:task.revision, type:'archive' })
      }
      await load()
      notify(t('Archived {count} cards', { count:ids.length }), async () => {
        const latest = await request('board-list', { scope, includeRecovery:false })
        for (const task of (latest?.tasks ?? []).filter(task => ids.includes(task.id) && task.archivedAt)) {
          await request('board-command', { scope, operationId:window.crypto.randomUUID(), taskId:task.id, expectedRevision:task.revision, type:'unarchive' })
        }
        await load(); notify(t('Archived cards restored'))
      })
    } catch (caught) { setError(hostText(caught?.message) || t('Unable to archive cards')) }
    finally { setBulkBusy(false) }
  }
  const bulkSetType = async next => {
    const ids = [...selectedIds]
    if (!ids.length || !next || bulkBusy || !window.crypto?.randomUUID) return
    const approved = await askBoardConfirm({ title:t('Change the type of {count} cards', { count:ids.length }), rows:[{ label:t('Type'), before:t('Selected cards'), after:t(TASK_TYPE_LABELS[next] ?? 'Other') }] })
    if (!approved) return
    setBulkBusy(true)
    const changed = []
    try {
      for (const id of ids) {
        const task = allTasks.find(item => item.id === id)
        if (!task || !commandsFor(task).some(command => command.type === 'card-details')) continue
        changed.push([id, taskType(task)])
        await request('board-command', { scope, operationId:window.crypto.randomUUID(), taskId:id, expectedRevision:task.revision, type:'card-details', value:{ type:next } })
      }
      setSelectedIds(new Set()); setSelectionMode(false)
      await load(); notify(t('Updated the type of {count} cards', { count:ids.length }), changed.length ? async () => {
        for (const [id, previous] of changed) {
          const latest = await request('board-list', { scope, includeRecovery:false })
          const current = (latest?.tasks ?? []).find(item => item.id === id)
          if (!current) continue
          await request('board-command', { scope, operationId:window.crypto.randomUUID(), taskId:id, expectedRevision:current.revision, type:'card-details', value:{ type:previous } })
        }
        await load(); notify(t('Card types restored'))
      } : undefined)
    } catch (caught) { setError(hostText(caught?.message) || t('Unable to update card types')) }
    finally { setBulkBusy(false) }
  }
  const bulkSetOwner = async next => {
    const ids = [...selectedIds]
    if (!ids.length || !next || bulkBusy || !window.crypto?.randomUUID) return
    const approved = await askBoardConfirm({ title:t('Change the owner of {count} cards', { count:ids.length }), rows:[{ label:t('Owner'), before:t('Selected cards'), after:actorName(next, actors) }] })
    if (!approved) return
    setBulkBusy(true)
    const changed = []
    try {
      for (const id of ids) {
        const task = allTasks.find(item => item.id === id)
        if (!task || task.owner === next || task.reviewer === next || !commandsFor(task).some(command => command.type === 'edit')) continue
        changed.push({ id, owner:task.owner })
        await request('board-command', { scope, operationId:window.crypto.randomUUID(), taskId:id, expectedRevision:task.revision, type:'edit',
          value:{ title:task.title, owner:next, reviewer:task.reviewer, acceptance:task.acceptance, dependencies:dependenciesOf(task) } })
      }
      setSelectedIds(new Set()); setSelectionMode(false)
      await load(); notify(t('Updated the owner of {count} cards', { count:changed.length }), changed.length ? async () => {
        for (const entry of changed) {
          const latest = await request('board-list', { scope, includeRecovery:false })
          const current = (latest?.tasks ?? []).find(item => item.id === entry.id)
          if (!current) continue
          await request('board-command', { scope, operationId:window.crypto.randomUUID(), taskId:entry.id, expectedRevision:current.revision, type:'edit',
            value:{ title:current.title, owner:entry.owner, reviewer:current.reviewer, acceptance:current.acceptance, dependencies:dependenciesOf(current) } })
        }
        await load(); notify(t('Card owners restored'))
      } : undefined)
    } catch (caught) { setError(hostText(caught?.message) || t('Unable to update card owners')) }
    finally { setBulkBusy(false) }
  }
  const bulkAssignRelease = async releaseId => {
    const ids = [...selectedIds]
    const release = releases.find(item => item.id === releaseId)
    if (!ids.length || !release || bulkBusy || !window.crypto?.randomUUID) return
    const approved = await askBoardConfirm({ title:t('Add {count} cards to {release}', { count:ids.length, release:textValue(release.name) || release.id }), rows:[{ label:t('Release'), before:t('Selected cards'), after:textValue(release.name) || release.id }] })
    if (!approved) return
    setBulkBusy(true)
    const changed = []
    try {
      for (const id of ids) {
        const task = allTasks.find(item => item.id === id)
        if (!task || task.releaseId === release.id) continue
        changed.push({ id, releaseId:task.releaseId ?? null })
        await request('board-release-assign', { scope, operationId:window.crypto.randomUUID(), releaseId:release.id,
          expectedReleaseRevision:release.revision, taskId:id, expectedTaskRevision:task.revision, afterId:null })
      }
      setSelectedIds(new Set()); setSelectionMode(false)
      await load(); notify(t('Added {count} cards to {release}', { count:changed.length, release:textValue(release.name) || release.id }), changed.length ? async () => {
        let failed = 0
        for (const entry of changed) {
          const latest = await request('board-list', { scope, includeRecovery:false })
          const current = (latest?.tasks ?? []).find(item => item.id === entry.id)
          const currentRelease = (latest?.releases ?? []).find(item => item.id === release.id)
          if (!current || !currentRelease || current.releaseId !== release.id) continue
          try {
            if (entry.releaseId === null) {
              await request('board-release-remove', { scope, operationId:window.crypto.randomUUID(), releaseId:release.id,
                expectedReleaseRevision:currentRelease.revision, taskId:entry.id, expectedTaskRevision:current.revision })
            } else {
              const previous = (latest?.releases ?? []).find(item => item.id === entry.releaseId)
              if (!previous) { failed += 1; continue }
              await request('board-release-assign', { scope, operationId:window.crypto.randomUUID(), releaseId:previous.id,
                expectedReleaseRevision:previous.revision, taskId:entry.id, expectedTaskRevision:current.revision, afterId:null })
            }
          } catch { failed += 1 }
        }
        await load(); notify(failed ? t('Some release assignments could not be undone.') : t('Release assignments restored'))
      } : undefined)
    } catch (caught) { setError(hostText(caught?.message) || t('Unable to assign release')) }
    finally { setBulkBusy(false) }
  }
  const bulkDuplicate = async () => {
    const ids = [...selectedIds]
    if (!ids.length || !createEnabled || bulkBusy || !window.crypto?.randomUUID) return
    const approved = await askBoardConfirm({ title:t('Duplicate {count} cards', { count:ids.length }), rows:[{ label:t('Cards'), before:t('Selected'), after:t('New copies') }] })
    if (!approved) return
    setBulkBusy(true)
    const created = []
    try {
      for (const id of ids) {
        const task = allTasks.find(item => item.id === id)
        if (!task || task.legacy || task.shared) continue
        const taskId = `card-${window.crypto.randomUUID()}`
        const value = { title:t('Copy of {title}', { title:textValue(task.title) }), owner:asText(task.owner), reviewer:asText(task.reviewer),
          acceptance:textValue(task.acceptance), dependencies:[], type:taskType(task),
          ...(textValue(task.description) ? { description:textValue(task.description) } : {}),
          ...(textValue(task.dueDate) ? { dueDate:textValue(task.dueDate), dueComplete:task.dueComplete === true } : {}),
          ...(labelsOf(task).length ? { labels:labelsOf(task) } : {}),
          ...(Array.isArray(task.checklist) && task.checklist.length ? { checklist:task.checklist.map(item => ({ ...item })) } : {}),
          ...(task.status === 'draft' ? { draft:true } : {}),
          ...(task.personalProgress !== undefined ? { personalProgress:task.personalProgress } : {}) }
        await request('board-command', { scope, operationId:window.crypto.randomUUID(), taskId, type:'create', value })
        created.push(taskId)
      }
      setSelectedIds(new Set()); setSelectionMode(false)
      await load(); notify(t('Duplicated {count} cards', { count:created.length }), created.length ? async () => {
        const latest = await request('board-list', { scope, includeRecovery:false })
        for (const id of created) {
          const current = (latest?.tasks ?? []).find(item => item.id === id)
          if (!current || current.archivedAt) continue
          await request('board-command', { scope, operationId:window.crypto.randomUUID(), taskId:id, expectedRevision:current.revision, type:'archive' })
        }
        await load(); notify(t('Copies archived'))
      } : undefined)
    } catch (caught) { setError(hostText(caught?.message) || t('Unable to duplicate cards')) }
    finally { setBulkBusy(false) }
  }
  const bulkMovePersonal = async progress => {
    const ids = [...selectedIds]
    if (!ids.length || !progress || bulkBusy || !window.crypto?.randomUUID) return
    const approved = await askBoardConfirm({ title:t('Move {count} cards', { count:ids.length }), rows:[{ label:t('Personal progress'), before:t('Selected'), after:t(PERSONAL_COLUMNS.find(([id]) => id === progress)?.[1] ?? 'Personal progress') }] })
    if (!approved) return
    setBulkBusy(true)
    const changed = []
    try {
      for (const id of ids) {
        const task = allTasks.find(item => item.id === id)
        if (!task || task.personalProgress === progress || !commandsFor(task).some(command => command.type === 'personal-progress')) continue
        changed.push({ id, progress:task.personalProgress })
        await request('board-command', { scope, operationId:window.crypto.randomUUID(), taskId:id, expectedRevision:task.revision, type:'personal-progress', value:{ progress } })
      }
      setSelectedIds(new Set()); setSelectionMode(false)
      await load(); notify(t('Moved {count} cards', { count:changed.length }), changed.length ? async () => {
        for (const entry of changed) {
          const latest = await request('board-list', { scope, includeRecovery:false })
          const current = (latest?.tasks ?? []).find(item => item.id === entry.id)
          if (!current) continue
          await request('board-command', { scope, operationId:window.crypto.randomUUID(), taskId:entry.id, expectedRevision:current.revision, type:'personal-progress', value:{ progress:entry.progress } })
        }
        await load(); notify(t('Card positions restored'))
      } : undefined)
    } catch (caught) { setError(hostText(caught?.message) || t('Unable to move cards')) }
    finally { setBulkBusy(false) }
  }
  const releases = Array.isArray(data?.releases) ? data.releases : []
  const releaseSupported = Array.isArray(data?.releases)
  const orderedReleases = [...releases].sort((left, right) => {
    const a = releasePosition(left), b = releasePosition(right)
    return a < b ? -1 : a > b ? 1 : left.id < right.id ? -1 : left.id > right.id ? 1 : 0
  })
  const releaseById = new Map(releases.map(release => [release.id, release]))
  const releaseRoles = Array.isArray(data?.releaseRoles) ? data.releaseRoles.filter(role => role && typeof role.key === 'string' && role.key) : null
  const releaseTeamSupported = scope.kind === 'room' && !!releaseRoles?.length
  const proposals = Array.isArray(data?.proposals) ? data.proposals : []
  const proposalSupported = Array.isArray(data?.proposals)
  const chooseView = next => { setView(next); setReleaseFocus('') }
  const openRelease = id => { setView('release'); setReleaseFocus(id) }
  const createRelease = async value => {
    if (!window.crypto?.randomUUID) throw new Error(t('Unable to update release'))
    const operationId = window.crypto.randomUUID()
    // `team` only exists for a room board with release roles; personal boards and
    // older hosts keep the plain release body.
    const { team, ...release } = value
    await request('board-release-create', { scope, operationId, release: { id: window.crypto.randomUUID(), ...release }, ...(team ? { team } : {}) })
    await load(generation.current, true)
  }
  const releaseRequest = async (endpoint, payload) => {
    if (releaseBusy || !window.crypto?.randomUUID) return false
    const operationId = window.crypto.randomUUID()
    setReleaseBusy(payload.releaseId || 'new'); setReleaseError('')
    try {
      await request(endpoint, { scope, operationId, ...payload })
      await load(generation.current, true)
      return true
    } catch (caught) {
      setReleaseError(hostText(caught?.message) || t('Unable to update release'))
      await load(generation.current, true)
      return false
    } finally { setReleaseBusy('') }
  }
  const releaseAction = (release, endpoint) => releaseRequest(endpoint, { releaseId: release.id, expectedRevision: release.revision })
  const openReleaseDetails = id => { setReleaseError(''); setReleasePanel({ id, mode: 'detail' }) }
  const closeReleasePanel = () => { setReleasePanel(null); setReleaseReport(null) }
  const openReleaseReport = async release => {
    const id = release.id
    setReleasePanel({ id, mode: 'report' })
    setReleaseReport({ id, loading: true, error: '', text: '', generatedAt: 0 })
    try {
      const result = await request('board-release-report', { scope, releaseId: id })
      if (typeof result?.markdown !== 'string') throw new Error('invalid release report')
      setReleaseReport(current => (current?.id === id
        ? { id, loading: false, error: '', text: result.markdown, generatedAt: Number.isSafeInteger(result.generatedAt) ? result.generatedAt : 0 }
        : current))
    } catch (caught) {
      setReleaseReport(current => (current?.id === id
        ? { id, loading: false, error: hostText(caught?.message) || t('Unable to load release report'), text: '', generatedAt: 0 }
        : current))
    }
  }
  const saveReleaseGate = (release, gate, status, evidence) => {
    if (status === 'passed' && !evidence) return Promise.resolve(false)
    return releaseRequest('board-release-gate', { releaseId: release.id, expectedRevision: release.revision, gate, status, ...(evidence ? { evidence } : {}) })
  }
  const checkRelease = release => releaseRequest('board-release-check', { releaseId: release.id })
  const moveRelease = async (release, direction) => {
    if (releaseBusy || !window.crypto?.randomUUID) return
    const index = orderedReleases.findIndex(item => item.id === release.id)
    const neighbor = orderedReleases[index + direction]
    if (!neighbor) return
    setReleaseBusy(release.id); setReleaseError('')
    try {
      await request('board-release-update', { scope, operationId: window.crypto.randomUUID(), releaseId: release.id, expectedRevision: release.revision, value: { position: neighbor.position } })
      await request('board-release-update', { scope, operationId: window.crypto.randomUUID(), releaseId: neighbor.id, expectedRevision: neighbor.revision, value: { position: release.position } })
      await load(generation.current, true)
    } catch (caught) {
      setReleaseError(hostText(caught?.message) || t('Unable to update release'))
      await load(generation.current, true)
    } finally { setReleaseBusy('') }
  }
  const assignInRelease = async (task, release, laneTasks, dropIndex) => {
    if (releaseBusy || !window.crypto?.randomUUID) return
    const previousReleaseId = task.releaseId
    setReleaseBusy(task.id); setReleaseError('')
    try {
      if (!release) {
        const source = task.releaseId ? releaseById.get(task.releaseId) : null
        if (!source) return
        await request('board-release-remove', { scope, operationId: window.crypto.randomUUID(), releaseId: source.id,
          expectedReleaseRevision: source.revision, taskId: task.id, expectedTaskRevision: task.revision })
      } else {
        const without = laneTasks.filter(item => item.id !== task.id)
        const originalIndex = laneTasks.findIndex(item => item.id === task.id)
        const target = Math.max(0, Math.min(without.length, dropIndex - (originalIndex >= 0 && originalIndex < dropIndex ? 1 : 0)))
        const afterId = target > 0 ? without[target - 1].id : null
        await request('board-release-assign', { scope, operationId: window.crypto.randomUUID(), releaseId: release.id,
          expectedReleaseRevision: release.revision, taskId: task.id, expectedTaskRevision: task.revision, afterId })
      }
      await load(generation.current, true)
      notify(t('Card moved'), async () => {
        const latest = await request('board-list', { scope, includeRecovery:false })
        const currentTask = (latest?.tasks ?? []).find(item => item.id === task.id)
        if (!currentTask) return
        if (previousReleaseId) {
          const target = (latest.releases ?? []).find(item => item.id === previousReleaseId)
          if (!target || !['draft','queued'].includes(target.status)) return
          await request('board-release-assign', { scope, operationId:window.crypto.randomUUID(), releaseId:target.id,
            expectedReleaseRevision:target.revision, taskId:task.id, expectedTaskRevision:currentTask.revision, afterId:null })
        } else if (currentTask.releaseId) {
          const target = (latest.releases ?? []).find(item => item.id === currentTask.releaseId)
          if (!target) return
          await request('board-release-remove', { scope, operationId:window.crypto.randomUUID(), releaseId:target.id,
            expectedReleaseRevision:target.revision, taskId:task.id, expectedTaskRevision:currentTask.revision })
        }
        await load()
      })
    } catch (caught) {
      setReleaseError(hostText(caught?.message) || t('Unable to update release'))
      await load(generation.current, true)
    } finally { setReleaseBusy('') }
  }
  const decideProposal = async (proposal, decision) => {
    if (proposalBusy || !canAct || !window.crypto?.randomUUID) return
    const operationId = window.crypto.randomUUID()
    setProposalBusy(proposal.id); setProposalError('')
    try {
      await request('board-proposal-decide', { scope, operationId, proposalId: proposal.id, expectedRevision: proposal.revision, decision })
      await load(generation.current, true)
    } catch (caught) {
      setProposalError(caught?.message || t('The proposal decision failed.'))
      await load(generation.current, true)
    } finally { setProposalBusy('') }
  }
  const hasLegacy = data?.tasks?.some(task => task.legacy) === true
  const allTasks = data?.tasks ?? []
  const needle = search.trim().toLocaleLowerCase()
  const textOf = value => textValue(value).toLocaleLowerCase()
  const filtered = allTasks.filter(task => {
    const labels = labelsOf(task)
    const comments = commentsOf(task)
    const type = taskType(task), typeText = TASK_TYPE_LABELS[type]
    const matched = !needle || [task.title, task.id, task.description, task.stage, task.acceptance, task.progress?.summary, task.progress?.next, type, typeText, t(typeText), actorLabel(task.owner, actors), actorLabel(task.reviewer, actors), ...labels, ...comments.map(comment => comment.text)]
      .some(value => textOf(value).includes(needle))
    const memberOk = !memberFilter || asText(task.owner) === memberFilter || asText(task.reviewer) === memberFilter
    const labelOk = !labelFilter || labels.includes(labelFilter)
    const dueOk = dueFilterMatch(task, dueFilter)
    const typeOk = !typeFilter || type === typeFilter
    return matched && memberOk && labelOk && dueOk && typeOk
  })
  const personal = scope.kind === 'personal' && scope.id === 'user'
  const taskById = new Map(allTasks.map(task => [task.id, task]))
  // Keep a matching item with its parent through search, member filters and archive.
  const matchedIds = new Set(filtered.map(task => task.id))
  const activeRoots = new Set(), archivedRoots = new Set()
  const activeItems = new Map(), archivedItems = new Map()
  for (const task of allTasks) {
    const parent = taskById.get(task.parentTaskId)
    if (!matchedIds.has(task.id) && (!parent || !matchedIds.has(parent.id))) continue
    const rootId = parent?.id ?? task.id
    const archived = task.archivedAt || parent?.archivedAt
    const roots = archived ? archivedRoots : activeRoots
    roots.add(rootId)
    if (!parent) continue
    const items = archived ? archivedItems : activeItems
    if (!items.has(rootId)) items.set(rootId, [])
    items.get(rootId).push(task)
  }
  const archivedTasks = allTasks.filter(task => archivedRoots.has(task.id))
  const activeFiltered = allTasks.filter(task => activeRoots.has(task.id))
  const personalTasks = personal ? activeFiltered.filter(task => PERSONAL_COLUMNS.some(([id]) => id === task.personalProgress)) : []
  const personalIds = new Set(personalTasks.map(task => task.id))
  // Goal cards come from group goals, not from the task workflow; they stay readable
  // in their own section and never count as a workflow status.
  const legacyTasks = activeFiltered.filter(task => task.legacy)
  const columns = boardColumns(activeFiltered.filter(task => !task.legacy && !personalIds.has(task.id)))
  const listedBase = [...COLUMNS, ...(columns.get('unknown').length ? [['unknown', 'Status unknown']] : [])]
  const listed = lanePrefs.order.length
    ? [...listedBase].sort((left, right) => {
        const li = lanePrefs.order.indexOf(left[0]), ri = lanePrefs.order.indexOf(right[0])
        return (li === -1 ? 999 : li) - (ri === -1 ? 999 : ri)
      })
    : listedBase
  const laneKey = (kind, stage) => kind + ':' + stage
  const laneLabelFor = (kind, stage, label) => lanePrefs.names[laneKey(kind, stage)] || label
  const renameLane = (kind, stage, value) => setLanePrefs(current => ({ ...current, names:{ ...current.names, [laneKey(kind, stage)]:value.trim() } }))
  const moveLane = (kind, stage, direction) => {
    const keys = listed.map(([status]) => status)
    const index = keys.indexOf(stage)
    const target = index + direction
    if (index < 0 || target < 0 || target >= keys.length) return
    ;[keys[index], keys[target]] = [keys[target], keys[index]]
    setLanePrefs(current => ({ ...current, order:keys }))
  }
  const commandsFor = task => !task.shared && Array.isArray(commandMap[task.id]) ? commandMap[task.id].filter(command => command && typeof command.type === 'string') : []
  const memberOptions = [...new Set((Array.isArray(actors) ? actors : []).map(actor => actor.id).filter(Boolean))]
  const labelOptions = [...new Set(allTasks.flatMap(labelsOf))].sort((a, b) => a.localeCompare(b))
  const hasFilters = !!(search || memberFilter || labelFilter || dueFilter || typeFilter)
  const laneOf = task => personal && PERSONAL_COLUMNS.some(([id]) => id === task.personalProgress) ? task.personalProgress : task.status
  const canDropOn = (task, kind, stage) => {
    if (!task || task.shared) return false
    const commands = commandsFor(task)
    if (kind === 'personal') return commandOf(commands, 'personal-progress')
    if (kind === 'type') return commandOf(commands, 'card-details') && taskType(task) !== stage
    if (kind === 'release') {
      if (['done', 'cancelled'].includes(task.status)) return false
      if (stage === 'unassigned') {
        const source = task.releaseId ? releaseById.get(task.releaseId) : null
        return !!source && ['draft', 'queued'].includes(source.status)
      }
      const release = releaseById.get(stage)
      return !!release && ['draft', 'queued'].includes(release.status) && commandOf(commands, 'release-assign')
    }
    if (laneOf(task) === stage && commandOf(commands, 'reorder')) return true
    if (stage === 'cancelled') return task.status !== 'cancelled' && commandOf(commands, 'cancel')
    if (task.status === 'draft' && stage === 'proposed') return commandOf(commands, 'submit')
    if (task.status === 'cancelled' && stage === 'proposed') return commandOf(commands, 'restore')
    return ['waiting', 'ready', 'working'].includes(stage) && commandOf(commands, 'schedule')
  }
  const openCard = (id, opener) => { cardOpener.current = opener; setSelectedCard({ key, id }) }
  const card = (task, index, laneTasks, kind, stage) => h(TaskCard, { key: task.id, scope, task, items:(kind === 'archive' ? archivedItems : activeItems).get(task.id), commands: commandsFor(task), actors, uncertain: !canAct, dragging: dragId === task.id,
    dragEnabled: kind === 'type' || kind === 'release', request, selectionMode, selected: selectedIds.has(task.id),
    onSelect: (id, checked) => setSelectedIds(current => { const next = new Set(current); if (checked) next.add(id); else next.delete(id); return next }),
    onOpen: openCard, onDragStart: (item, event) => { if (!canAct) return; event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('application/x-ds-bot-card', item.id); setDragId(item.id); setDrop(null) },
    onDragEnd: () => { setDragId(''); setDrop(null) },
    onDragOverCard: (item, event) => {
      if (!dragId || item.id === dragId) return
      const dragged = taskById.get(dragId)
      if (!canDropOn(dragged, kind, stage)) return
      event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'move'
      const rect = event.currentTarget.getBoundingClientRect()
      setDrop({ kind, stage, index: index + (event.clientY > rect.top + rect.height / 2 ? 1 : 0) })
    } })
  const selected = selectedCard?.key === key ? data?.tasks?.find(task => task.id === selectedCard.id) : undefined
  const panelRelease = releasePanel ? releaseById.get(releasePanel.id) : null
  useEffect(() => {
    if (releasePanel && data && !panelRelease) { setReleasePanel(null); setReleaseReport(null) }
  }, [releasePanel, data, panelRelease])
  useEffect(() => { if (selectedCard && (selectedCard.key !== key || (data && !selected))) setSelectedCard(null) }, [key, data, selectedCard, selected])
  const laneHandlers = (kind, stage, laneTasks) => {
    const labelText = kind === 'type' ? t(TASK_TYPE_LABELS[stage] ?? 'Other')
      : kind === 'release' ? (stage === 'unassigned' ? t('Unassigned') : textValue(releaseById.get(stage)?.name) || t('Untitled release'))
        : t(STATUS_LABELS[stage] ?? PERSONAL_COLUMNS.find(([value]) => value === stage)?.[1] ?? stage)
    if (kind === 'release') {
      const release = stage === 'unassigned' ? null : releaseById.get(stage)
      return {
        onDragOver: event => { const dragged = taskById.get(dragId); if (!dragged || !canDropOn(dragged, kind, stage)) return; event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setDrop({ kind, stage, index: laneTasks.length }) },
        onDragLeave: event => { if (!event.currentTarget.contains(event.relatedTarget)) setDrop(null) },
        onDrop: event => {
          const id = event.dataTransfer.getData('application/x-ds-bot-card') || dragId
          const task = taskById.get(id)
          if (!task) { setDragId(''); setDrop(null); return }
          if (stage === 'unassigned' && !task.releaseId) { setDragId(''); setDrop(null); return }
          if (!canDropOn(task, kind, stage)) { event.preventDefault(); notify(t('This card cannot be moved to {lane}.', { lane: labelText })); setDragId(''); setDrop(null); return }
          event.preventDefault()
          const dropIndex = drop && drop.kind === kind && drop.stage === stage ? drop.index : laneTasks.length
          setDragId(''); setDrop(null)
          void assignInRelease(task, release, laneTasks, dropIndex)
        },
      }
    }
    return {
      onDragOver: event => { const dragged = taskById.get(dragId); if (!dragged || !canDropOn(dragged, kind, stage)) return; event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setDrop({ kind, stage, index: laneTasks.length }) },
      onDragLeave: event => { if (!event.currentTarget.contains(event.relatedTarget)) setDrop(null) },
      onDrop: event => {
        const id = event.dataTransfer.getData('application/x-ds-bot-card') || dragId
        const task = taskById.get(id)
        if (!task) { setDragId(''); setDrop(null); return }
        if (kind === 'type' && taskType(task) === stage) { setDragId(''); setDrop(null); return }
        if (!canDropOn(task, kind, stage)) { event.preventDefault(); notify(t('This card cannot be moved to {lane}.', { lane: labelText })); setDragId(''); setDrop(null); return }
        event.preventDefault()
        const dropIndex = drop && drop.kind === kind && drop.stage === stage ? drop.index : laneTasks.length
        const originalIndex = laneTasks.findIndex(item => item.id === id)
        const without = laneTasks.filter(item => item.id !== id)
        const target = Math.max(0, Math.min(without.length, dropIndex - (originalIndex >= 0 && originalIndex < dropIndex ? 1 : 0)))
        const afterId = target > 0 ? without[target - 1].id : null
        setDragId(''); setDrop(null)
        const commands = commandsFor(task)
        const previousAfterId = originalIndex > 0 ? laneTasks[originalIndex - 1].id : null
        if (kind === 'personal') {
          if (task.personalProgress === stage && commandOf(commands, 'reorder')) void run(task, { type: 'reorder' }, { afterId }).then(state => { if (state === 'committed') notify(t('Card reordered'), () => undoReorder(previousAfterId)(task.id)) })
          else void run(task, { type: 'personal-progress' }, { progress: stage, afterId })
        } else if (kind === 'type') {
          if (taskType(task) !== stage) {
            const before = t(TASK_TYPE_LABELS[taskType(task)] ?? 'Other'), after = t(TASK_TYPE_LABELS[stage] ?? 'Other')
            void askBoardConfirm({ title: task.title, rows: [{ label: t('Type'), before, after }] })
              .then(ok => { if (ok) void run(task, { type: 'card-details' }, { type: stage }) })
          }
        } else if (task.status === stage && commandOf(commands, 'reorder')) void run(task, { type: 'reorder' }, { afterId }).then(state => { if (state === 'committed') notify(t('Card reordered'), () => undoReorder(previousAfterId)(task.id)) })
        else if (stage === 'cancelled') void run(task, { type: 'cancel' })
        else if (task.status === 'draft' && stage === 'proposed') void run(task, { type: 'submit' })
        else if (task.status === 'cancelled' && stage === 'proposed') void run(task, { type: 'restore' })
        else if (['waiting', 'ready', 'working'].includes(stage) && commandOf(commands, 'schedule')) void run(task, { type: 'schedule' })
        else notify(t('This card cannot be moved to {lane}.', { lane: labelText }))
      },
    }
  }
  const openCreate = (config, title = '') => {
    if (!createEnabled) return
    setCreateFor(title ? { ...config, initial: { ...config.initial, title } } : config)
  }
  const duplicate = task => {
    setSelectedCard(null)
    setCreateFor({ ...(task.parentTaskId ? {parentTaskId:task.parentTaskId} : {}), laneLabel: stageLabelOf(task), defaultOwner: asText(task.owner), ownerOnly: false, scheduleOnCreate: false, followup: false,
      initial: { title: t('Copy of {title}', { title: textValue(task.title) }), owner: asText(task.owner), reviewer: asText(task.reviewer), acceptance: textValue(task.acceptance), type: taskType(task),
        dependencies: dependenciesOf(task), details: { description: textValue(task.description), dueDate: textValue(task.dueDate), dueComplete: task.dueComplete === true, labels: labelsOf(task), checklist: Array.isArray(task.checklist) ? task.checklist.map(item => ({ ...item })) : [] } } })
  }
  const renderLane = (kind, stage, label, laneTasks, config) => {
    const shownLabel = laneLabelFor(kind, stage, label)
    const sorted = sortMode === 'title'
      ? [...laneTasks].sort((a, b) => textValue(a.title).localeCompare(textValue(b.title)))
      : sortMode === 'due'
        ? [...laneTasks].sort((a, b) => (textValue(a.dueDate) || '9999').localeCompare(textValue(b.dueDate) || '9999'))
        : sortMode === 'type'
          ? [...laneTasks].sort((a, b) => taskType(a).localeCompare(taskType(b)))
          : laneTasks
    const dropHere = drop && drop.kind === kind && drop.stage === stage
    const children = []
    sorted.forEach((task, index) => {
      if (dropHere && drop.index === index) children.push(h('span', { key: 'drop-' + index, className: 'bt-board-drop-line', 'aria-hidden': true }))
      children.push(card(task, index, laneTasks, kind, stage))
    })
    if (dropHere && drop.index >= sorted.length) children.push(h('span', { key: 'drop-end', className: 'bt-board-drop-line', 'aria-hidden': true }))
    return h(BoardLane, { key: stage, kind, stage, label:shownLabel, count: laneTasks.length, meta: config?.meta, actions: config?.actions, releaseId: config?.releaseId, focus: config?.focus,
      createEnabled: config?.noCreate ? false : createEnabled, onCreate: title => openCreate({ ...config, laneLabel:shownLabel }, title), dropActive: !!dropHere, empty: laneTasks.length ? false : (config?.emptyLabel ?? true),
      onRename: kind === 'workflow' ? value => renameLane(kind, stage, value) : undefined,
      onMove: kind === 'workflow' ? direction => moveLane(kind, stage, direction) : undefined,
      onArchiveAll: kind === 'workflow' ? () => void archiveLane(kind, stage, laneTasks) : undefined,
      ...laneHandlers(kind, stage, laneTasks) }, children)
  }
  useEffect(() => { if (view === 'release' && data && !releaseSupported) setView('status') }, [view, data, releaseSupported])
  useEffect(() => {
    if (view !== 'release' || !releaseFocus) return undefined
    const frame = window.requestAnimationFrame(() => {
      const node = [...(dialog.current?.querySelectorAll('[data-release-id]') ?? [])].find(item => item.dataset.releaseId === releaseFocus)
      node?.scrollIntoView({ block: 'nearest', inline: 'start' })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [view, releaseFocus, orderedReleases.length])
  const releaseActionButton = (release, label, endpoint, extraClass = '') => h('button', { type: 'button', className: 'bt-card-mini ' + extraClass, disabled: !!releaseBusy || !canAct,
    onClick: () => void releaseAction(release, endpoint) }, t(label))
  // Checking only reads the release and its items; it sends no revision fence.
  const releaseCheckButton = release => h('button', { type: 'button', className: 'bt-card-mini', disabled: !!releaseBusy || !canAct,
    onClick: () => void checkRelease(release) }, t('Check'))
  const cancelRelease = release => {
    void askBoardConfirm({ title: release.name, rows: [{ label: t('Status'), before: release.status, after: t('Cancelled') }] })
      .then(approved => { if (approved) void releaseAction(release, 'board-release-cancel') })
  }
  const releaseActions = release => {
    const editable = ['draft', 'queued'].includes(release.status)
    const index = orderedReleases.findIndex(item => item.id === release.id)
    const destructive = ['draft', 'queued', 'running'].includes(release.status)
    return h('div', { className: 'bt-board-release-actions' },
      h('button', { type: 'button', className: 'bt-card-mini', onClick: () => openReleaseDetails(release.id) }, t('Details')),
      release.status === 'running' ? releaseCheckButton(release) : null,
      release.status === 'draft' ? releaseActionButton(release, 'Queue', 'board-release-queue') : null,
      ['draft', 'queued'].includes(release.status) ? releaseActionButton(release, 'Start', 'board-release-start') : null,
      destructive || editable ? h('details', { className: 'bt-board-lane-menu bt-board-release-menu' },
        h('summary', { className: 'bt-card-mini', 'aria-label': t('Release actions'), title: t('Release actions') }, '···'),
        h('div', { className: 'bt-board-lane-menu-body' },
          destructive ? h('button', { type:'button', className:'bt-card-mini bt-board-release-cancel', disabled:!!releaseBusy || !canAct, onClick:() => cancelRelease(release) }, t('Cancel release')) : null,
          editable && index > 0 ? h('button', { type: 'button', className: 'bt-card-mini', disabled: !!releaseBusy || !canAct, onClick: () => void moveRelease(release, -1) }, t('Move release up')) : null,
          editable && index >= 0 && index < orderedReleases.length - 1 ? h('button', { type: 'button', className: 'bt-card-mini', disabled: !!releaseBusy || !canAct, onClick: () => void moveRelease(release, 1) }, t('Move release down')) : null)) : null)
  }
  // The lane header carries the release team, its group and the four gates; the
  // owner and role count stay plain text so the lane count element stays unique.
  const releaseMeta = release => {
    const manager = release.projectManagerId ? actorName(release.projectManagerId, actors) : ''
    const roleCount = releaseRoleCount(release)
    const groupId = textValue(release.groupId)
    return h('span', { className: 'bt-board-release-meta' },
      release.version ? h('span', { className: 'bt-board-release-version' }, release.version) : null,
      h(ReleaseStatusChip, { status: release.status }),
      h('span', { className: 'bt-board-release-progress' }, t('{done}/{total} done', { done: release.doneCount ?? 0, total: release.itemCount ?? 0 })),
      manager ? h('span', { className: 'bt-board-release-pm', title: t('Project manager') }, t('Project manager: {name}', { name: manager })) : null,
      roleCount ? h('span', { className: 'bt-board-release-roles', title: t('Role assignments') }, t('{count} roles', { count: roleCount })) : null,
      groupId ? h('span', { className: 'bt-board-release-group', title: groupId }, t('Group {id}', { id: shortIdentity(groupId) })) : null,
      !manager && !roleCount && !groupId ? h('span', { className: 'bt-board-release-pm bt-board-release-team-none' }, t('No release team')) : null,
      h(ReleaseGateStrip, { release, compact: true }),
      release.status === 'running' && releaseItemsDone(release) && !releaseGatesPassed(release)
        ? h('span', { className: 'bt-board-release-awaiting', role: 'status' }, t('Awaiting gates')) : null)
  }
  const releaseBar = releaseSupported && orderedReleases.length ? h('div', { className: 'bt-board-release-bar' },
    h('div', { className: 'bt-board-release-chips', role: 'group', 'aria-label': t('Releases') },
      orderedReleases.map(release => h(ReleaseChip, { key: release.id, release, onOpen: () => openRelease(release.id) })))) : null
  const typeSection = h('section', { className: 'bt-board-section', 'aria-label': t('Task types') },
    h('div', { className: 'bt-board-section-heading' }, h('h3', null, t('By type')), h('p', null, t('Drag a card to another type lane to change its type without changing its status.'))),
    h(ColumnRail, { label: t('Task types') }, TASK_TYPES.map(([id, label]) => renderLane('type', id, t(label), activeFiltered.filter(task => taskType(task) === id), { noCreate: true, laneLabel: t(label) }))))
  const activityItems = Array.isArray(data?.activity) ? data.activity : []
  const activitySection = h('section', { className: 'bt-board-section', 'aria-label': t('Activity') },
    h('div', { className: 'bt-board-section-heading' }, h('h3', null, t('Activity')), h('p', null, t('Recent changes across the board.'))),
    activityItems.length ? h('div', { className:'bt-board-activity' }, activityItems.map(item => h('button', { key:item.id, type:'button', className:'bt-board-activity-row', onClick:() => openCard(item.taskId) },
      h('span', { className:'bt-card-activity-dot', 'aria-hidden':true }),
      h('span', { className:'bt-board-activity-text' }, h('strong', null, t(ACTIVITY_LABELS[item.type] ?? 'Card updated')), h('span', null, textValue(item.taskTitle) || item.taskId)),
      h('span', { className:'bt-board-activity-by' }, actorName(item.actor, actors)),
      h('time', { dateTime:Number.isFinite(item.at) ? new Date(item.at).toISOString() : undefined }, relativeTime(item.at))))) : h('p', { className:'bt-card-muted' }, t('No activity yet.')))
  const archiveSection = h('section', { className: 'bt-board-section', 'aria-label': t('Archive') },
    h('div', { className: 'bt-board-section-heading' }, h('h3', null, t('Archive')), h('p', null, t('Archived cards are hidden from the workflow and release views. Restore a card to return it to the board.'))),
    h(ColumnRail, { label: t('Archive') }, renderLane('archive', 'archived', t('Archived cards'), archivedTasks, { noCreate: true, laneLabel: t('Archived cards'), emptyLabel:t('No archived cards') })))
  const releaseSection = releaseSupported ? h('section', { className: 'bt-board-section', 'aria-label': t('Releases') },
    scope.kind === 'room' ? h(MajorVersionCard, {name:textValue(title) || textValue(goal?.title) || scope.id,
      releases:orderedReleases, tasks:allTasks, onOpen:openReleaseDetails, onCreate:() => setNewRelease(true), disabled:!canAct}) :
    h('div', { className: 'bt-board-section-heading bt-board-section-heading-row' },
      h('div', null, h('h3', null, t('Releases')), h('p', null, t('Drag cards between release lanes. Arrow controls reorder draft and queued releases.'))),
      h('button', { type: 'button', className: 'bt-btn bt-btn-ghost', disabled: !canAct, onClick: () => setNewRelease(true) }, h(PlusIcon), t('New release'))),
    h(ColumnRail, { label: t('Releases') }, [
      ...orderedReleases.map(release => {
        const label = textValue(release.name) || textValue(release.version) || t('Untitled release')
        return renderLane('release', release.id, label, activeFiltered.filter(task => task.releaseId === release.id), {
          noCreate: true, laneLabel: label, releaseId: release.id, focus: releaseFocus === release.id,
          meta: releaseMeta(release),
          actions: releaseActions(release),
        })
      }),
      renderLane('release', 'unassigned', t('Unassigned'), activeFiltered.filter(task => !task.releaseId), { noCreate: true, laneLabel: t('Unassigned') }),
    ])) : null
  if (!visible) return null
  return createPortal(h('div', { className: 'bt-board-backdrop' },
    h('section', { ref: dialog, tabIndex: -1, className: 'bt-board-dialog', role: 'dialog', 'aria-modal': selectedCard || createFor ? 'false' : 'true', 'aria-label': title || t('Task board') },
      h('header', { className: 'bt-board-header' },
        h('div', { className: 'bt-board-heading' },
          h('div', { className: 'bt-board-title-row' }, h('h2', null, title || t('Task board')),
            showCapacity ? h('span', { className: 'bt-board-capacity' }, t('{count} / {limit}', { count: capacity.taskCount, limit: capacity.taskLimit })) : null),
          h('p', null, scope.kind === 'room' ? t('DS-Bot project · Major version (group) · Minor releases') : t('Personal task board'), data ? ' · ' + t('{count} cards', { count: filtered.length }) : '')),
        h('div', { className: 'bt-board-head-actions' },
          h('button', { type: 'button', className: 'bt-icon-btn', 'aria-label': t('Refresh'), title: t('Refresh'), onClick: () => void load() }, h(RefreshIcon)),
          h('button', { type: 'button', className: 'bt-icon-btn', 'aria-label': t('Close'), title: t('Close'), onClick: dismiss }, h(CloseIcon)))),
      boardConfirm ? h('div', { className: 'bt-board-confirm-layer', onMouseDown: event => { if (event.target === event.currentTarget) settleBoardConfirm(false) } },
        h('section', { ref: boardConfirmBox, className: 'bt-board-confirm', role: 'alertdialog', 'aria-label': t('Confirm change'), tabIndex: -1 },
          h('div', { className: 'bt-card-confirm-head' }, h('h3', null, t('Confirm change')), h('p', null, t('Review the before and after values before applying this change.'))),
          h('p', { className: 'bt-board-confirm-title' }, textValue(boardConfirm.title)),
          h('div', { className: 'bt-card-diff' }, (boardConfirm.rows ?? []).map(row => h('div', { key: row.label, className: 'bt-card-diff-row' },
            h('strong', null, row.label),
            h('div', { className: 'bt-card-diff-values' }, h('span', null, h('b', null, t('Before') + ': '), row.before), h('span', null, h('b', null, t('After') + ': '), row.after))))),
          h('div', { className: 'bt-card-editor-actions' },
            h('button', { type: 'button', className: 'bt-btn bt-btn-ghost', onClick: () => settleBoardConfirm(false) }, t('Cancel')),
            h('button', { type: 'button', className: 'bt-btn bt-btn-primary', onClick: () => settleBoardConfirm(true) }, t('Confirm'))))) : null,
      error ? h('div', { className: 'bt-board-error', role: 'alert' }, error) : null,
      capacityReached ? h('div', { className: 'bt-board-pending', role: 'status' }, t('Task limit reached. New tasks cannot be created.')) : null,
      hasLegacy ? h('div', { className: 'bt-board-legacy-note', role: 'note' }, t('Goal card details can be corrected without changing the original task or acceptance record.')) : null,
      data && capacity?.create !== true ? h('div', { className: 'bt-board-legacy-note', role: 'note' }, t('This board is read only.')) : null,
      pending ? h('div', { className: 'bt-board-pending', role: 'status' }, t(busy ? 'Saving…' : 'An action needs confirmation.'), ' ',
        h('button', { type: 'button', className: 'bt-card-mini', disabled: cancelBusy, onClick: () => check(pending) }, t('Check action')), ' ',
        h('button', { type: 'button', className: 'bt-card-mini', disabled: cancelBusy, onClick: () => cancel(pending) }, t('Safely cancel pending request'))) : null,
      h('div', { className: 'bt-board-toolbar' },
        h('div', { className: 'bt-board-views', role: 'group', 'aria-label': t('Board view') },
          [['status', 'Status'], ['type', 'Type'], ...(releaseSupported ? [['release', 'Release']] : []), ...(archivedTasks.length > 0 || canAct ? [['archive', 'Archive']] : []), ['activity', 'Activity']].map(([id, label]) =>
            h('button', { key: id, type: 'button', className: 'bt-board-view', 'aria-pressed': view === id, onClick: () => chooseView(id) }, t(label)))),
        h('label', { className: 'bt-board-search' }, h(SearchIcon), h('input', { ref:searchRef, type: 'search', 'aria-label': t('Search tasks'), placeholder: t('Search tasks'), value: search, onChange: event => setSearch(event.target.value) })),
        h('button', { type:'button', className:'bt-board-filter-toggle', 'aria-expanded':filtersOpen, onClick:() => setFiltersOpen(value => !value) }, t('Filters'), hasFilters ? h('span', { className:'bt-board-count' }, '•') : null),
        filtersOpen ? h('div', { className:'bt-board-filter-scrim', 'aria-hidden':true, onClick:() => setFiltersOpen(false) }) : null,
        h('div', { className: 'bt-board-filters' + (filtersOpen ? ' bt-board-filters-open' : '') },
          h('select', { value: memberFilter, 'aria-label': t('Filter by member'), onChange: event => setMemberFilter(event.target.value) },
            h('option', { value: '' }, t('All members')), memberOptions.map(id => h('option', { key: id, value: id }, actorName(id, actors)))),
          h('select', { value: typeFilter, 'aria-label': t('Filter by type'), onChange: event => setTypeFilter(event.target.value) },
            h('option', { value: '' }, t('All types')), TASK_TYPES.map(([id, label]) => h('option', { key: id, value: id }, t(label)))),
          labelOptions.length ? h('select', { value: labelFilter, 'aria-label': t('Filter by label'), onChange: event => setLabelFilter(event.target.value) },
            h('option', { value: '' }, t('All labels')), labelOptions.map(label => h('option', { key: label, value: label }, label))) : null,
          h('select', { value: dueFilter, 'aria-label': t('Filter by due date'), onChange: event => setDueFilter(event.target.value) },
            h('option', { value: '' }, t('Any due date')), h('option', { value: 'overdue' }, t('Overdue')), h('option', { value: 'soon' }, t('Due soon')), h('option', { value: 'complete' }, t('Due complete')), h('option', { value: 'none' }, t('No due date'))),
          h('select', { value: sortMode, 'aria-label': t('Sort cards'), onChange: event => setSortMode(event.target.value) },
            h('option', { value: '' }, t('Manual order')), h('option', { value: 'due' }, t('Due date')), h('option', { value: 'title' }, t('Title')), h('option', { value: 'type' }, t('Type'))),
          hasFilters ? h('button', { type: 'button', className: 'bt-card-mini', onClick: () => { setSearch(''); setMemberFilter(''); setLabelFilter(''); setDueFilter(''); setTypeFilter('') } }, t('Clear filters')) : null),
        proposalSupported ? h('button', { type: 'button', className: 'bt-board-changes' + (changesOpen ? ' bt-board-changes-open' : '') + (proposalUnread > 0 && !changesOpen ? ' bt-board-changes-new' : ''), 'aria-pressed': changesOpen,
          onClick: () => { setChangesOpen(value => !value); if (!changesOpen) { setProposalUnread(0); void load() } } },
        t('Changes'), proposals.length ? h('span', { className: 'bt-board-count' }, proposals.length) : null) : null,
        canAct ? h('button', { type:'button', className:'bt-board-select-toggle', 'aria-pressed':selectionMode, onClick:() => { setSelectionMode(value => !value); setSelectedIds(new Set()) } }, selectionMode ? t('Done') : t('Select')) : null),
      selectionMode ? h('div', { className:'bt-board-bulk', role:'status' },
        h('span', null, t('{count} selected', { count:selectedIds.size })),
        h('button', { type:'button', className:'bt-card-mini', disabled:bulkBusy || !selectedIds.size, onClick:() => void bulkArchive() }, t('Archive selected')),
        h('button', { type:'button', className:'bt-card-mini', disabled:bulkBusy || !selectedIds.size || !createEnabled, onClick:() => void bulkDuplicate() }, t('Duplicate selected')),
        h('button', { type:'button', className:'bt-card-mini bt-card-mini-danger', disabled:bulkBusy || !selectedIds.size, onClick:() => void bulkCancel() }, t('Cancel selected')),
        personal && selectionMode ? h('label', { className:'bt-board-bulk-select' }, h('span', null, t('Personal progress')), h('select', { defaultValue:'', disabled:bulkBusy || !selectedIds.size, 'aria-label':t('Move selected cards'), onChange:event => { const next=event.target.value; event.target.value=''; if(next) void bulkMovePersonal(next) } },
          h('option', { value:'' }, t('Move to')), PERSONAL_COLUMNS.map(([id,label]) => h('option', { key:id, value:id }, t(label))))) : null,
        h('label', { className:'bt-board-bulk-select' }, h('span', null, t('Status')), h('select', { defaultValue:'', disabled:bulkBusy || !selectedIds.size, 'aria-label':t('Apply status to selected cards'), onChange:event => { const next=event.target.value; event.target.value=''; if(next) void bulkApplyStatus(next) } },
          h('option', { value:'' }, t('Apply status')), BULK_STATUS_ACTIONS.map(item => h('option', { key:item.id, value:item.id }, t(item.label))))),
        h('label', { className:'bt-board-bulk-select' }, h('span', null, t('Type')), h('select', { defaultValue:'', disabled:bulkBusy || !selectedIds.size, 'aria-label':t('Set type for selected cards'), onChange:event => { const next=event.target.value; event.target.value=''; if(next) void bulkSetType(next) } },
          h('option', { value:'' }, t('Set type')), TASK_TYPES.map(([id,label]) => h('option', { key:id, value:id }, t(label))))),
        h('label', { className:'bt-board-bulk-select' }, h('span', null, t('Owner')), h('select', { defaultValue:'', disabled:bulkBusy || !selectedIds.size, 'aria-label':t('Set owner for selected cards'), onChange:event => { const next=event.target.value; event.target.value=''; if(next) void bulkSetOwner(next) } },
          h('option', { value:'' }, t('Set owner')), (Array.isArray(actors) ? actors : []).filter(actor => actor.id !== 'user').map(actor => h('option', { key:actor.id, value:actor.id }, actor.name || actor.id)))),
        orderedReleases.some(release => ['draft','queued'].includes(release.status)) ? h('label', { className:'bt-board-bulk-select' }, h('span', null, t('Release')), h('select', { defaultValue:'', disabled:bulkBusy || !selectedIds.size, 'aria-label':t('Add selected cards to release'), onChange:event => { const next=event.target.value; event.target.value=''; if(next) void bulkAssignRelease(next) } },
          h('option', { value:'' }, t('Add to release')), orderedReleases.filter(release => ['draft','queued'].includes(release.status)).map(release => h('option', { key:release.id, value:release.id }, textValue(release.name) || release.id)))) : null,
        h('button', { type:'button', className:'bt-card-mini', disabled:bulkBusy, onClick:() => { setSelectedIds(new Set()); setSelectionMode(false) } }, t('Clear selection'))) : null,
      view === 'status' && data?.summary ? h('div', { className:'bt-board-summary', role:'status', 'aria-label':t('Board summary') },
        h('span', null, h('b', null, data.summary.statuses?.working ?? 0), ' ', t('In progress')),
        h('span', null, h('b', null, (data.summary.statuses?.waiting ?? 0) + (data.summary.statuses?.ready ?? 0)), ' ', t('Waiting')),
        h('span', { className: data.summary.blocked ? 'bt-board-summary-alert' : '' }, h('b', null, data.summary.blocked ?? 0), ' ', t('Blocked')),
        h('span', { className: data.summary.overdue ? 'bt-board-summary-alert' : '' }, h('b', null, data.summary.overdue ?? 0), ' ', t('Overdue')),
        h('span', null, h('b', null, data.summary.statuses?.done ?? 0), ' ', t('Done'))) : null,
      data ? h('button', { type:'button', className:'bt-board-tools-toggle', 'aria-expanded':toolsOpen, onClick:() => { if (toolsOpen && recoveryOpen) inspectRecovery(false); setToolsOpen(value => !value) } }, t('Board tools')) : null,
      data ? h('div', { className: 'bt-board-review-tools' + (toolsOpen ? ' bt-board-review-tools-open' : '') }, h(HeldTurns, { key: 'held:' + key, recovery:data.recovery, open:recoveryOpen && recoveryScope.current === key, onOpen:inspectRecovery, scope, request, onRefresh:() => recoveryScope.current === key && loadRef.current?.() }), h(WorkDecisions, { key: 'decisions:' + key, scope, request, actors: data.capabilities?.actors }), h(LegacyWorkReview, { key: 'legacy-review:' + key, scope, request, actors: data.capabilities?.actors }), h(PeriodicReviewRecovery, { key: 'periodic:' + key, scope, goal, resolveReview, refreshGoal, currentRoomGoal, initiallyOpen: initialReview }), h(RemoteChanges, { key: 'remote:' + key, monitor: data.remoteChanges })) : null,
      !data ? h('div', { className: 'bt-board-empty' }, error ? t('Board unavailable') : t('Loading…'), error ? h('button', { type: 'button', className: 'bt-btn bt-btn-ghost', onClick: () => load() }, t('Retry')) : null)
        : h('div', { className: 'bt-board-content' },
          changesOpen && proposalSupported ? h(ProposalPanel, { proposals, actors, tasks: data.tasks, releases, disabled: !canAct || !!proposalBusy,
            busy: proposalBusy, error: proposalError, onDecide: decideProposal, onClose: () => setChangesOpen(false) }) : null,
          releaseError ? h('div', { className: 'bt-board-release-error', role: 'alert' }, releaseError) : null,
          view === 'status' && releaseSupported ? releaseBar : null,
          view === 'status' && personal ? h('section', { className: 'bt-board-section', 'aria-label': t('Personal progress') },
            h('div', { className: 'bt-board-section-heading' }, h('h3', null, t('Personal progress')), h('p', null, t('Drag a card or use its progress menu.'), ' ', t('Your own progress markers do not complete shared work or unblock dependencies.'))),
            h(ColumnRail, { label: t('Personal progress'), personal: true }, PERSONAL_COLUMNS.map(([progress, label]) => renderLane('personal', progress, t(label), personalTasks.filter(task => task.personalProgress === progress),
              { laneLabel: t(label), personalProgress: progress, defaultOwner: 'user', ownerOnly: true, scheduleOnCreate: false, followup: false })))) : null,
          view === 'status' && legacyTasks.length ? h('section', { className: 'bt-board-section bt-board-goal-cards', 'aria-label': t('Goal cards') },
            h('div', { className: 'bt-board-section-heading' }, h('h3', null, t('Goal cards')), h('p', null, t('Group goal cards are not workflow tasks and do not count as acceptance.'))),
            h('div', { className: 'bt-board-goal-grid' }, legacyTasks.map((task, index) => card(task, index, legacyTasks, 'legacy', 'goal')))) : null,
          view === 'status' && (!personal || filtered.some(task => !personalIds.has(task.id) && !task.legacy)) ? h('section', { className: 'bt-board-section', 'aria-label': t('Workflow') },
            personal ? h('div', { className: 'bt-board-section-heading' }, h('h3', null, t('Shared workflow')), h('p', null, t('These statuses reflect the shared task workflow.'))) : null,
            h(ColumnRail, { label: t('Workflow') }, listed.map(([status, label]) => {
              const scheduleOnCreate = !personal && ['waiting', 'ready', 'working'].includes(status)
              const followup = personal || ['reported', 'done', 'unknown'].includes(status)
              return renderLane('workflow', status, t(label), columns.get(status), { laneLabel: t(label), scheduleOnCreate, followup, noCreate: status === 'cancelled', defaultDraft: status === 'draft', defaultOwner: personal ? 'user' : scope.kind === 'personal' ? scope.id : '', ownerOnly: scope.kind === 'personal' })
            }))) : null,
          view === 'type' ? typeSection : null,
          view === 'release' && releaseSupported ? releaseSection : null,
          view === 'archive' ? archiveSection : null,
          view === 'activity' ? activitySection : null,
          selected && !createFor ? h(TaskCardDialog, { key: selected.id, scope, task: selected, tasks: data.tasks, commands: commandsFor(selected), actors: data.capabilities?.actors,
            targets: data.capabilities?.shareTargets?.[selected.id], uploadEnabled: data.capabilities?.upload === true, uncertain: !canAct, onCommand: run, onUpload: upload, request,
            onCreateItem: createEnabled && scope.kind === 'room' && !selected.shared && !selected.legacy && !selected.parentTaskId && !selected.archivedAt && !selected.blocked && !selected.stale
              && ['feature','bugfix'].includes(selected.type) && !['cancelled','done','reported'].includes(selected.status)
              ? () => setCreateFor({ parentTaskId:selected.id, laneLabel:textValue(selected.title) || selected.id }) : undefined,
            onClose: () => setSelectedCard(null), onOpenRelated:id => setSelectedCard({ key, id }), focusReturn: cardOpener, boardRef: dialog, pending, busy, error, onCheck: check, onCancel: cancel, cancelBusy, onDuplicate: createEnabled ? duplicate : undefined }) : null,
          createFor ? h(CreateCardDialog, { key: 'create:' + (createFor.laneLabel || '') + ':' + (createFor.personalProgress || ''), ...createFor, group:scope.kind === 'room', disabled: !createEnabled, actors, tasks: data.tasks, onCreate: createCard, onClose: () => setCreateFor(null) }) : null,
          newRelease ? h(ReleaseDialog, { disabled: !canAct, releaseRoles: releaseTeamSupported ? releaseRoles : null, releaseCandidates: data.releaseCandidates, actors,
            onClose: () => setNewRelease(false), onCreate: createRelease }) : null,
          panelRelease && releasePanel?.mode === 'report'
            ? h(ReleaseReportDialog, { key: 'report:' + panelRelease.id, release: panelRelease,
              report: releaseReport?.id === panelRelease.id ? releaseReport : null,
              onClose: closeReleasePanel, onBack: () => setReleasePanel({ id: panelRelease.id, mode: 'detail' }) })
            : panelRelease
              ? h(ReleaseDetailDialog, { key: 'release:' + panelRelease.id, release: panelRelease, actors, releaseRoles,
                canEdit: releaseEditable(panelRelease), busy: !!releaseBusy, error: releaseError,
                onClose: closeReleasePanel, onCheck: release => void checkRelease(release),
                onSaveGate: (gate, status, evidence) => void saveReleaseGate(panelRelease, gate, status, evidence),
                onOpenReport: release => void openReleaseReport(release) }) : null),
      h('div', { className: 'bt-board-toast', role: 'status', hidden: !notice }, notice,
        noticeAction ? h('button', { type:'button', className:'bt-board-toast-action', onClick:() => void runNoticeAction() }, noticeAction.label) : null))), document.body)
}


export const TASK_BOARD_CSS = `
.bt-board-review-tools{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,230px),1fr));align-items:start;gap:10px;padding:10px 24px;border-bottom:1px solid var(--bt-line);flex:none;max-height:min(46vh,480px);overflow:auto}
.bt-board-recovery-clear{font-size:12px;color:var(--bt-ink-2);padding:10px 0;margin:0}
.bt-board-error,.bt-board-pending{padding:10px 20px;background:var(--bt-danger-soft);font-size:13px}.bt-board-empty{padding:24px}
.bt-board-held{padding:10px 0;overflow:auto;max-height:30vh;font-size:12px}.bt-board-held summary{cursor:pointer;font-weight:600;color:var(--bt-ink-2)}.bt-board-held-record{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:8px;padding:10px 0;border-top:1px solid var(--bt-line);overflow-wrap:anywhere}
.bt-board-review-tools:has(.bt-recovery-panel[open]){max-height:min(68vh,680px)}
.bt-recovery-panel{min-width:0;background:var(--bt-card);border:1px solid var(--bt-line-2);border-radius:12px;box-shadow:0 2px 6px color-mix(in srgb,var(--bt-ink) 5%,transparent)}
.bt-recovery-panel[open]{grid-column:1/-1}.bt-recovery-summary{display:flex;align-items:center;gap:10px;min-width:0;cursor:pointer;list-style:none;padding:12px 14px}.bt-recovery-summary::-webkit-details-marker,.bt-recovery-record-summary::-webkit-details-marker{display:none}
.bt-recovery-summary:focus-visible,.bt-recovery-record-summary:focus-visible,.bt-recovery-work-choice:focus-visible{outline:2px solid var(--bt-accent);outline-offset:2px}.bt-recovery-summary-text{min-width:0;flex:1;display:flex;flex-direction:column;gap:3px}.bt-recovery-summary-text strong{font-size:13px;line-height:1.35}.bt-recovery-summary-text small{font-size:11px;color:var(--bt-ink-2)}
.bt-recovery-icon{display:grid;place-items:center;width:30px;height:30px;flex:none;border-radius:8px;color:var(--bt-accent);background:color-mix(in srgb,var(--bt-accent) 10%,var(--bt-card));font-size:18px}.bt-recovery-count,.bt-recovery-badge{flex:none;padding:3px 7px;border-radius:8px;background:var(--bt-tag-bg);color:var(--bt-ink-2);font-size:11px}.bt-recovery-panel[open]>.bt-recovery-summary{border-bottom:1px solid var(--bt-line)}
.bt-recovery-body{padding:14px;display:flex;flex-direction:column;gap:12px;min-width:0}.bt-recovery-intro{display:flex;justify-content:space-between;align-items:start;gap:12px;flex-wrap:wrap;color:var(--bt-ink-2);font-size:12px;line-height:1.5}.bt-recovery-intro p{margin:0;max-width:680px}.bt-recovery-intro>span{font-size:11px}.bt-recovery-warning{margin:0;padding:9px 11px;border-radius:8px;background:var(--bt-hover);color:var(--bt-ink);font-size:12px;line-height:1.5}
.bt-recovery-search{display:block;max-width:360px}.bt-board-dialog .bt-recovery-search input{box-sizing:border-box;width:100%;padding:8px 10px;background:var(--bt-main);border:1px solid var(--bt-line-2);border-radius:8px;font:inherit;font-size:12px;color:var(--bt-ink)}.bt-recovery-sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}.bt-recovery-empty{margin:0;padding:14px;color:var(--bt-ink-2);font-size:12px;line-height:1.5;background:var(--bt-sidebar);border-radius:8px}
.bt-recovery-groups,.bt-recovery-work-groups{display:flex;flex-direction:column;gap:10px;min-width:0;max-height:250px;overflow:auto}.bt-recovery-group,.bt-recovery-work-group{min-width:0}.bt-recovery-group-title{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:4px 2px;color:var(--bt-ink-2);font-size:11px}.bt-recovery-group-title span{font-variant-numeric:tabular-nums}
.bt-recovery-record{display:block;border:1px solid var(--bt-line);border-radius:8px;padding:0;margin-top:5px;background:var(--bt-main)}.bt-recovery-record-summary{display:flex;align-items:center;gap:10px;list-style:none;cursor:pointer;padding:10px}.bt-recovery-record-id{font:12px ui-monospace,SFMono-Regular,Menlo,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1}.bt-recovery-record-time{font-size:11px;color:var(--bt-ink-2);white-space:nowrap}.bt-recovery-facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,170px),1fr));gap:12px;min-width:0}.bt-recovery-record>.bt-recovery-facts{padding:0 10px 12px}.bt-recovery-facts .bt-board-fact{min-width:0;overflow-wrap:anywhere}
.bt-recovery-delivery-section{display:grid;gap:8px;min-width:0;padding-top:12px;border-top:1px solid var(--bt-line)}.bt-recovery-deliveries{display:flex;flex-direction:column;gap:8px;max-height:250px;overflow:auto;min-width:0}.bt-recovery-delivery{display:grid;gap:8px;min-width:0;padding:10px;border:1px solid var(--bt-line);border-radius:8px;background:var(--bt-main)}.bt-recovery-delivery-heading{display:flex;align-items:center;justify-content:space-between;gap:8px;min-width:0}.bt-recovery-delivery-heading strong{min-width:0;overflow-wrap:anywhere;font-size:12px}
.bt-recovery-workspace{display:grid;grid-template-columns:minmax(180px,260px) minmax(0,1fr);gap:14px;align-items:start;min-width:0}.bt-recovery-work-list,.bt-recovery-detail{display:flex;flex-direction:column;gap:10px;min-width:0}.bt-recovery-work-list{padding:10px;background:var(--bt-sidebar);border-radius:8px}.bt-recovery-list-header{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:12px}.bt-recovery-work-choice{display:block;width:100%;text-align:left;font:12px ui-monospace,SFMono-Regular,Menlo,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:3px}.bt-recovery-work-choice[aria-pressed=true]{background:color-mix(in srgb,var(--bt-accent) 14%,var(--bt-card));border-color:var(--bt-accent)}
.bt-recovery-manual{display:flex;align-items:end;gap:8px}.bt-recovery-manual label{display:flex;flex:1;min-width:0;flex-direction:column;gap:4px;color:var(--bt-ink-2);font-size:12px}.bt-board-dialog .bt-recovery-manual input,.bt-board-dialog .bt-recovery-form textarea{box-sizing:border-box;width:100%;padding:8px 10px;color:var(--bt-ink);background:var(--bt-main);border:1px solid var(--bt-line-2);border-radius:8px;font:inherit}.bt-recovery-snapshot,.bt-recovery-history{padding:12px;background:var(--bt-sidebar);border-radius:8px;font-size:12px;line-height:1.5}.bt-recovery-snapshot .bt-recovery-facts{margin-top:10px}.bt-recovery-review,.bt-recovery-form{display:flex;flex-direction:column;gap:10px}.bt-recovery-note{margin:0;color:var(--bt-ink-2);font-size:12px}.bt-recovery-form label{display:flex;flex-direction:column;gap:4px;font-size:12px}.bt-recovery-form textarea{min-height:54px;resize:vertical}.bt-recovery-form button{align-self:flex-start}.bt-recovery-history{display:grid;gap:8px}.bt-recovery-form .bt-recovery-confirm{flex-direction:row;align-items:flex-start;gap:8px}.bt-recovery-confirm input{flex:none}.bt-periodic-context{display:flex;flex-direction:column;gap:10px}.bt-recovery-notice{margin:0;padding:9px 11px;border-radius:8px;color:var(--bt-ink);background:color-mix(in srgb,var(--bt-green) 14%,var(--bt-card));font-size:12px}
.bt-recovery-candidate{display:grid;gap:8px;padding:10px;min-width:0}.bt-recovery-candidate-text{white-space:pre-wrap;overflow-wrap:anywhere;max-height:240px;overflow:auto;margin:0;padding:10px;border:1px solid var(--bt-line);border-radius:8px;background:var(--bt-sidebar);color:var(--bt-ink);font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}
@media(max-width:600px){.bt-recovery-workspace{grid-template-columns:1fr}.bt-recovery-record-summary{flex-wrap:wrap}.bt-recovery-record-time{order:3;width:100%}.bt-recovery-groups,.bt-recovery-work-groups{max-height:190px}}



.bt-board-launch{position:absolute;left:8px;top:7px;pointer-events:auto;-webkit-app-region:no-drag;color:var(--bt-ink-2);font:inherit;font-size:12px;line-height:16px;background:var(--bt-card);border:1px solid var(--bt-line-2);border-radius:999px;padding:4px 10px;cursor:pointer}
.bt-board-launch:hover{background:var(--bt-hover);color:var(--bt-ink)}
.bt-board-backdrop{position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;padding:24px;background:var(--dsw-alias-bg-mask-3,rgba(0,0,0,.32))}
.bt-board-dialog{box-sizing:border-box;display:flex;flex-direction:column;width:min(1680px,100%);height:min(920px,calc(100vh - 48px));max-height:calc(100vh - 48px);overflow:hidden;background:var(--bt-main);color:var(--bt-ink);border:0.5px solid var(--bt-line-2);border-radius:16px;box-shadow:0 24px 80px rgba(0,0,0,.24);font-family:var(--bt-font,inherit);font-size:13px;line-height:18px}
.bt-board-header{display:flex;align-items:center;justify-content:space-between;gap:16px;flex:none;padding:16px 24px;border-bottom:1px solid var(--bt-line)}
.bt-board-heading{min-width:0}
.bt-board-title-row{display:flex;align-items:center;gap:10px;min-width:0}
.bt-board-header h2{font-size:17px;line-height:24px;font-weight:500;letter-spacing:0;margin:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bt-board-header p{font-size:12px;line-height:18px;color:var(--bt-ink-2);margin:3px 0 0}
.bt-board-capacity{flex:none;padding:2px 8px;border-radius:999px;background:var(--bt-tag-bg);color:var(--bt-ink-2);font-size:11px;line-height:16px;font-variant-numeric:tabular-nums}
.bt-board-head-actions{display:flex;align-items:center;gap:4px;flex:none}
.bt-board-dialog button{font:inherit;color:inherit;cursor:pointer}
.bt-board-dialog button:disabled{opacity:.4;cursor:not-allowed}
.bt-board-dialog button:not([class]){background:var(--bt-hover);border:1px solid var(--bt-line);border-radius:8px;padding:6px 10px;font-size:12px;line-height:16px;color:var(--bt-ink)}
.bt-board-dialog button:not([class]):hover:not(:disabled){background:var(--bt-active)}
.bt-board-dialog input,.bt-board-dialog select,.bt-board-dialog textarea{box-sizing:border-box;font:inherit;font-size:13px;line-height:18px;color:var(--bt-ink);background:var(--bt-card);border:1px solid var(--bt-line);border-radius:8px;padding:7px 9px}
.bt-board-dialog input::placeholder,.bt-board-dialog textarea::placeholder{color:var(--bt-ink-3)}
.bt-board-dialog :is(button,input,select,textarea,summary,a[href],[tabindex="0"]):focus-visible{outline:2px solid var(--bt-accent);outline-offset:2px}
.bt-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:32px;padding:0 12px;border:0;border-radius:999px;background:var(--bt-hover);color:var(--bt-ink);font-size:13px;line-height:18px;font-weight:500;white-space:nowrap;text-decoration:none}
.bt-btn:hover:not(:disabled){background:var(--bt-active)}
.bt-btn svg{width:15px;height:15px;flex:none}
.bt-btn-primary{background:var(--bt-accent);color:var(--bt-accent-ink)}
.bt-btn-primary:hover:not(:disabled){background:color-mix(in srgb,var(--bt-accent) 88%,var(--bt-ink))}
.bt-btn-ghost{background:transparent;border:1px solid var(--bt-line)}
.bt-btn-ghost:hover:not(:disabled){background:var(--bt-hover)}
.bt-btn-block{width:100%}
.bt-icon-btn{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:0;border-radius:999px;background:transparent;color:var(--bt-ink-2);flex:none}
.bt-icon-btn:hover:not(:disabled){background:var(--bt-hover);color:var(--bt-ink)}
.bt-icon-btn svg{width:16px;height:16px}
.bt-card-mini{display:inline-flex;align-items:center;justify-content:center;gap:4px;min-width:28px;min-height:28px;padding:2px 6px;border:0;border-radius:6px;background:transparent;color:var(--bt-ink-2);font-size:12px;line-height:16px}
.bt-card-mini:hover:not(:disabled){background:var(--bt-hover);color:var(--bt-ink)}
.bt-card-mini svg{width:14px;height:14px}
.bt-card-icon-danger{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--bt-danger);flex:none}
.bt-card-icon-danger:hover:not(:disabled){background:color-mix(in srgb,var(--bt-danger) 10%,transparent)}
.bt-card-icon-danger svg{width:14px;height:14px}
.bt-board-toolbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;flex:none;padding:10px 24px;border-bottom:1px solid var(--bt-line)}
.bt-board-search{display:flex;align-items:center;gap:8px;flex:1 1 240px;max-width:420px;min-width:200px;height:36px;box-sizing:border-box;padding:0 10px;border:0.5px solid var(--bt-line-2);border-radius:12px;background:var(--bt-card);color:var(--bt-ink-2)}
.bt-board-search:focus-within{border-color:var(--bt-accent);box-shadow:0 0 0 2px color-mix(in srgb,var(--bt-accent) 18%,transparent)}
.bt-board-search svg{width:15px;height:15px;flex:none}
.bt-board-dialog .bt-board-search input{flex:1;min-width:0;height:100%;padding:0;border:0;border-radius:0;background:transparent;box-shadow:none;outline:none;font-size:13px;color:var(--bt-ink)}
.bt-board-filter-scrim{display:none}
.bt-board-filters{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.bt-board-dialog .bt-board-filters select{height:32px;padding:0 26px 0 12px;border:0;border-radius:999px;background:var(--bt-hover);color:var(--bt-ink-2);font-size:12px;line-height:16px;appearance:none;background-image:linear-gradient(45deg,transparent 50%,currentColor 50%),linear-gradient(135deg,currentColor 50%,transparent 50%);background-position:calc(100% - 14px) 14px,calc(100% - 10px) 14px;background-size:4px 4px,4px 4px;background-repeat:no-repeat}
.bt-board-dialog .bt-board-filters select:hover{background-color:var(--bt-active);color:var(--bt-ink)}
.bt-board-review-tools{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,230px),1fr));align-items:start;gap:10px;padding:10px 24px;border-bottom:1px solid var(--bt-line);flex:none;max-height:min(42vh,420px);overflow:auto}
.bt-board-review-tools:has(.bt-recovery-panel[open]){max-height:min(68vh,680px)}
.bt-board-error,.bt-board-pending{padding:9px 24px;background:color-mix(in srgb,var(--bt-danger) 8%,var(--bt-card));color:var(--bt-ink);font-size:12px;line-height:18px;border-bottom:1px solid var(--bt-line)}
.bt-board-legacy-note{padding:8px 24px;background:color-mix(in srgb,var(--bt-accent) 6%,var(--bt-card));color:var(--bt-ink-2);font-size:12px;line-height:18px;border-bottom:1px solid var(--bt-line)}
.bt-board-empty{display:flex;flex:1;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:40px;color:var(--bt-ink-2);font-size:13px}
.bt-board-content{flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;padding:18px 24px 24px;background:var(--dsw-alias-bg-base,var(--bt-main))}
.bt-board-section+.bt-board-section{margin-top:24px}
.bt-board-section-heading{margin:0 0 10px}
.bt-board-section-heading h3{font-size:13px;line-height:18px;font-weight:600;margin:0}
.bt-board-section-heading p{font-size:12px;line-height:18px;color:var(--bt-ink-2);margin:3px 0 0}
.bt-board-activity{display:flex;flex-direction:column;border:.5px solid var(--bt-line);border-radius:12px;overflow:hidden;background:var(--bt-card)}
.bt-board-activity-row{display:flex;align-items:center;gap:10px;width:100%;padding:9px 12px;border:0;border-bottom:.5px solid var(--bt-line);background:transparent;color:var(--bt-ink);font:inherit;font-size:13px;line-height:18px;text-align:left}
.bt-board-activity-row:last-child{border-bottom:0}
.bt-board-activity-row:hover{background:var(--bt-hover)}
.bt-board-activity-text{display:flex;flex-direction:column;gap:1px;min-width:0;flex:1}
.bt-board-activity-text strong{font-size:12px;line-height:16px;font-weight:500}
.bt-board-activity-text span{color:var(--bt-ink-2);font-size:12px;line-height:16px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-board-activity-by,.bt-board-activity-row time{color:var(--bt-ink-2);font-size:11px;line-height:16px;white-space:nowrap}
.bt-board-activity-row time{margin-left:auto}
.bt-board-rail{min-width:0}
.bt-board-rail{position:relative}
.bt-board-rail::after{content:"";position:absolute;top:0;right:-1px;bottom:14px;width:26px;pointer-events:none;background:linear-gradient(to right,transparent,var(--dsw-alias-bg-base,var(--bt-main)))}
.bt-board-columns{scroll-snap-type:x proximity}
.bt-board-lane{scroll-snap-align:start}
.bt-board-rail-controls{display:flex;justify-content:flex-end;gap:4px;margin-bottom:6px}
.bt-board-rail-status{display:inline-flex;align-items:center;gap:2px;margin-right:auto;color:var(--bt-ink-2);font-size:11px;line-height:16px;font-variant-numeric:tabular-nums}
.bt-board-rail-more{color:var(--bt-ink-3)}
.bt-board-rail-controls[hidden]{display:none}
.bt-board-columns{display:flex;gap:12px;align-items:stretch;min-height:clamp(280px,52vh,620px);overflow-x:auto;overflow-y:hidden;padding:0 0 14px;scrollbar-width:none;overscroll-behavior-x:contain;touch-action:pan-x pan-y}
.bt-board-columns::-webkit-scrollbar{display:none}
.bt-board-lane{display:flex;flex-direction:column;flex:0 0 300px;min-width:0;min-height:260px;box-sizing:border-box;padding:8px;border:1px solid transparent;border-radius:12px;background:color-mix(in srgb,var(--bt-ink) 3.5%,var(--bt-card));transition:background-color .12s,border-color .12s}
.bt-board-lane-drop{border-color:color-mix(in srgb,var(--bt-accent) 46%,transparent);background:color-mix(in srgb,var(--bt-accent) 6%,var(--bt-card))}
.bt-board-columns-personal .bt-board-lane{flex:1 0 280px;max-width:420px;min-height:180px}
.bt-board-lane-head{display:flex;align-items:center;justify-content:space-between;gap:6px;padding:2px 4px 8px}
.bt-board-lane-head-actions{display:flex;align-items:center;gap:2px;flex:none}
.bt-board-lane-menu{position:relative}
.bt-board-lane-menu>summary{list-style:none;cursor:pointer}
.bt-board-lane-menu>summary::-webkit-details-marker{display:none}
.bt-board-lane-menu-body{position:absolute;right:0;top:30px;z-index:5;display:flex;flex-direction:column;gap:3px;width:210px;padding:6px;border:.5px solid var(--bt-line-2);border-radius:10px;background:var(--bt-main);box-shadow:0 10px 20px -3px rgba(0,0,0,.1),0 4px 6px -4px rgba(0,0,0,.1)}
.bt-board-release-menu>summary{display:inline-flex;align-items:center;justify-content:center;min-width:28px;list-style:none;cursor:pointer}
.bt-board-release-menu>summary::-webkit-details-marker{display:none}
.bt-board-lane-rename{display:flex;gap:4px;padding:2px}
.bt-board-lane-rename input{flex:1;min-width:0;height:28px;padding:0 7px;border:1px solid var(--bt-line);border-radius:6px;background:var(--bt-card);color:var(--bt-ink);font:inherit;font-size:12px}
.bt-board-lane-menu-item{padding:6px 8px;border:0;border-radius:6px;background:transparent;color:var(--bt-ink);font:inherit;font-size:12px;line-height:16px;text-align:left}
.bt-board-lane-menu-item:hover{background:var(--bt-hover)}
.bt-lane-chevron{transform:rotate(90deg);transition:transform .12s}
.bt-lane-chevron-collapsed{transform:rotate(0)}
.bt-board-lane-collapsed{align-self:flex-start;min-height:0;max-height:none}
.bt-board-lane-title{display:flex;align-items:center;gap:8px;min-width:0}
.bt-board-lane-title h3{font-size:13px;line-height:18px;font-weight:600;margin:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bt-board-count{display:inline-flex;align-items:center;justify-content:center;min-width:20px;height:18px;padding:0 6px;border-radius:999px;background:var(--bt-tag-bg);color:var(--bt-ink-2);font-size:11px;line-height:16px;font-variant-numeric:tabular-nums;flex:none}
.bt-board-stage-dot{width:8px;height:8px;border-radius:50%;background:var(--bt-ink-3);flex:none;corner-shape:round}
.bt-board-stage-dot-waiting,.bt-board-stage-dot-todo{background:var(--bt-star)}
.bt-board-stage-dot-ready{background:var(--bt-accent)}
.bt-board-stage-dot-working,.bt-board-stage-dot-doing{background:var(--bt-green)}
.bt-board-stage-dot-reported{background:color-mix(in srgb,var(--bt-accent) 55%,var(--bt-danger))}
.bt-board-stage-dot-done,.bt-board-stage-dot-finished,.bt-board-stage-dot-legacy-done{background:var(--bt-green)}
.bt-board-stage-dot-proposed,.bt-board-stage-dot-unknown,.bt-board-stage-dot-legacy-pending{background:var(--bt-ink-3)}
.bt-board-lane-cards{display:flex;flex-direction:column;gap:8px;flex:1;min-height:0}
.bt-board-lane-empty{display:flex;flex:1;align-items:center;justify-content:center;min-height:84px;margin:0;padding:12px;border:1px dashed color-mix(in srgb,var(--bt-ink) 16%,transparent);border-radius:10px;color:var(--bt-ink-3);font-size:12px;line-height:18px}
.bt-board-lane-add{display:flex;align-items:center;gap:6px;width:100%;height:32px;margin-top:6px;padding:0 8px;border:0;border-radius:8px;background:transparent;color:var(--bt-ink-2);font-size:13px;line-height:18px;text-align:left}
.bt-board-lane-add:hover:not(:disabled){background:var(--bt-hover);color:var(--bt-ink)}
.bt-board-lane-add svg{width:16px;height:16px}
.bt-board-drop-line{display:block;height:2px;margin:1px 2px 5px;border-radius:999px;background:var(--bt-accent);box-shadow:0 0 0 2px color-mix(in srgb,var(--bt-accent) 18%,transparent)}
.bt-board-card{overflow:hidden;border:1px solid var(--bt-line);border-radius:12px;background:var(--bt-card);box-shadow:0 1px 2px rgba(0,0,0,.03);transition:box-shadow .12s,border-color .12s;position:relative}
.bt-board-select{position:absolute;right:6px;top:6px;z-index:2;display:flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:8px;background:color-mix(in srgb,var(--bt-card) 88%,transparent)}
.bt-board-select input{width:16px;height:16px;accent-color:var(--bt-accent)}
.bt-board-select-toggle{display:inline-flex;align-items:center;justify-content:center;height:30px;padding:0 10px;border:.5px solid var(--bt-line-2);border-radius:999px;background:var(--bt-card);color:var(--bt-ink-2);font:inherit;font-size:12px;line-height:16px}
.bt-board-select-toggle[aria-pressed=true]{background:var(--bt-active);color:var(--bt-ink)}
.bt-board-bulk{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:7px 24px;border-bottom:1px solid var(--bt-line);background:color-mix(in srgb,var(--bt-accent) 5%,var(--bt-card));color:var(--bt-ink-2);font-size:12px;line-height:16px}
.bt-card-mini-danger{color:var(--bt-danger)}
.bt-board-bulk-select{display:inline-flex;align-items:center;gap:5px;color:var(--bt-ink-2);font-size:12px;line-height:16px}
.bt-board-bulk-select select{height:28px;padding:0 22px 0 8px;border:.5px solid var(--bt-line-2);border-radius:6px;background:var(--bt-card);color:var(--bt-ink);font:inherit;font-size:12px}
.bt-board-card:hover{border-color:var(--bt-line-2);box-shadow:0 2px 8px -1px rgba(0,0,0,.06),0 1px 2px rgba(0,0,0,.04)}
.bt-board-card[draggable=true]{cursor:grab}
.bt-board-card[draggable=true]:active{cursor:grabbing}
.bt-board-card-dragging{opacity:.55}
.bt-board-card-cover{height:112px;overflow:hidden;background:var(--bt-sidebar)}
.bt-board-card-cover img{display:block;width:100%;height:100%;object-fit:cover}
.bt-board-card-summary{display:flex;flex-direction:column;gap:6px;width:100%;padding:10px 12px;border:0;border-radius:0;background:transparent;color:inherit;text-align:left}
.bt-board-card-summary:hover{background:transparent}
.bt-board-card-title{font-size:13px;line-height:18px;font-weight:500;overflow-wrap:anywhere}
.bt-board-card-milestone{display:grid;max-width:100%;font-size:12px;line-height:17px;color:var(--bt-ink-2)}
.bt-board-card-milestone>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-card-work-reply{display:grid;gap:4px}
.bt-card-related-link{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:baseline;gap:8px;width:100%;text-align:start;border:0;background:none;padding:4px 0;font:inherit;color:var(--bt-ink);cursor:pointer}
.bt-card-related-link>span{overflow-wrap:anywhere}.bt-card-related-link>small{flex:none;color:var(--bt-ink-2)}
.bt-board-card-meta{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-height:16px}
.bt-board-card-labels{display:flex;gap:4px;flex-wrap:wrap;align-items:center}
.bt-board-card-more-labels{font-size:11px;line-height:16px;color:var(--bt-ink-2)}
.bt-board-label{display:inline-flex;align-items:center;gap:2px;max-width:100%;padding:2px 7px;border-radius:6px;background:var(--bt-tag-bg);color:var(--bt-ink);font-size:11px;line-height:16px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-board-label-blue{background:color-mix(in srgb,var(--bt-accent) 14%,var(--bt-card));color:color-mix(in srgb,var(--bt-accent) 72%,var(--bt-ink))}
.bt-board-label-green{background:color-mix(in srgb,var(--bt-green) 14%,var(--bt-card));color:color-mix(in srgb,var(--bt-green) 58%,var(--bt-ink))}
.bt-board-label-rose{background:color-mix(in srgb,var(--bt-danger) 12%,var(--bt-card));color:color-mix(in srgb,var(--bt-danger) 74%,var(--bt-ink))}
.bt-board-label-amber{background:color-mix(in srgb,var(--bt-star) 14%,var(--bt-card));color:color-mix(in srgb,var(--bt-star) 62%,var(--bt-ink))}
.bt-board-label-violet{background:color-mix(in srgb,var(--bt-accent) 22%,var(--bt-danger) 10%,var(--bt-card));color:color-mix(in srgb,var(--bt-accent) 52%,var(--bt-danger) 30%,var(--bt-ink))}
.bt-board-label-slate{background:var(--bt-tag-bg);color:var(--bt-ink-2)}
.bt-board-label-remove{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;margin:-6px -7px -6px 0;padding:0;border:0;border-radius:50%;background:transparent;color:inherit;font-size:12px;line-height:1;opacity:.65}
.bt-board-label-remove:hover{opacity:1;background:color-mix(in srgb,var(--bt-ink) 12%,transparent)}
.bt-board-due{display:inline-flex;align-items:center;gap:4px;padding:2px 6px;border-radius:6px;background:var(--bt-tag-bg);color:var(--bt-ink-2);font-size:11px;line-height:16px;font-variant-numeric:tabular-nums;white-space:nowrap}
.bt-board-due svg{width:12px;height:12px;flex:none}
.bt-board-due-overdue{background:color-mix(in srgb,var(--bt-danger) 10%,var(--bt-card));color:var(--bt-danger)}
.bt-board-due-soon{background:color-mix(in srgb,var(--bt-star) 13%,var(--bt-card));color:color-mix(in srgb,var(--bt-star) 62%,var(--bt-ink))}
.bt-board-due-complete{background:color-mix(in srgb,var(--bt-green) 13%,var(--bt-card));color:color-mix(in srgb,var(--bt-green) 56%,var(--bt-ink))}
.bt-board-progress{display:inline-flex;align-items:center;gap:6px;color:var(--bt-ink-2);font-size:11px;line-height:16px;font-variant-numeric:tabular-nums}
.bt-board-progress-track{display:block;width:36px;height:3px;overflow:hidden;border-radius:999px;background:var(--bt-tag-bg)}
.bt-board-progress-fill{display:block;height:100%;border-radius:inherit;background:var(--bt-green)}
.bt-board-card-count{display:inline-flex;align-items:center;gap:3px;color:var(--bt-ink-2);font-size:11px;line-height:16px;font-variant-numeric:tabular-nums}
.bt-board-card-count svg{width:12px;height:12px}
.bt-board-card-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:2px;min-width:0}
.bt-major-version{border:1px solid var(--bt-line);border-radius:10px;padding:12px;margin-bottom:12px}.bt-major-version h4{margin:10px 0 4px}.bt-minor-releases{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,210px),1fr));gap:4px 12px}.bt-minor-releases button{display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%;padding:7px 0;background:none;border:0;border-top:1px solid var(--bt-line);color:var(--bt-ink);text-align:start;cursor:pointer}.bt-minor-releases small{margin-inline-start:6px;color:var(--bt-ink-2)}
.bt-board-items{margin:0 9px 9px;border-top:1px solid var(--bt-line);padding:5px 0;font-size:11px}.bt-board-items>summary{cursor:pointer;font-weight:600}.bt-board-item-list{max-height:clamp(72px,24vh,200px);overflow-y:auto;overscroll-behavior-y:contain;scrollbar-gutter:stable}.bt-board-item-progress{grid-column:1/-1;color:var(--bt-ink-2);font-size:11px}
.bt-board-card-owner{display:inline-flex;align-items:center;gap:6px;min-width:0;color:var(--bt-ink-2);font-size:11px;line-height:16px}
.bt-board-card-owner>span:last-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-board-open-hint{color:var(--bt-ink-3);font-size:11px;line-height:16px;white-space:nowrap}
.bt-board-avatar{display:inline-grid;place-items:center;flex:none;border-radius:50%;background:color-mix(in srgb,var(--bt-accent) 14%,var(--bt-card));color:var(--bt-ink);font-weight:600;line-height:1;corner-shape:round}
.bt-board-avatar-muted{background:var(--bt-hover);color:var(--bt-ink-2)}
.bt-board-chip{display:inline-flex;align-items:center;gap:4px;max-width:100%;padding:2px 6px;border-radius:6px;background:var(--bt-tag-bg);color:var(--bt-ink-2);font-size:11px;line-height:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bt-board-chip-blocked{background:color-mix(in srgb,var(--bt-danger) 10%,var(--bt-card));color:var(--bt-danger)}
.bt-board-id{font:11px/16px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--bt-ink-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}
.bt-board-legacy{color:var(--bt-ink-2);font-size:11px;line-height:16px}
.bt-board-toast{position:fixed;left:50%;bottom:32px;z-index:10005;transform:translateX(-50%);padding:8px 14px;border-radius:999px;background:var(--bt-ink);color:var(--bt-card);font-size:12px;line-height:18px;box-shadow:0 8px 28px rgba(0,0,0,.14);max-width:min(520px,calc(100vw - 48px));text-align:center}
.bt-board-toast[hidden]{display:none}
.bt-board-toast-action{margin-left:10px;padding:2px 8px;border:1px solid color-mix(in srgb,var(--bt-card) 35%,transparent);border-radius:999px;background:transparent;color:inherit;font:inherit;font-weight:600}
.bt-card-modal-backdrop{position:fixed;inset:0;z-index:10001;display:flex;align-items:center;justify-content:center;padding:24px;background:var(--dsw-alias-bg-mask-3,rgba(0,0,0,.32));overscroll-behavior:contain}
.bt-card-modal{box-sizing:border-box;display:flex;flex-direction:column;width:min(920px,100%);max-height:calc(100vh - 48px);overflow:hidden;background:var(--bt-main);color:var(--bt-ink);border:0.5px solid var(--bt-line-2);border-radius:16px;box-shadow:0 24px 80px rgba(0,0,0,.24);font-size:13px;line-height:18px}
.bt-create-modal{width:min(680px,100%)}
.bt-card-modal-header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex:none;padding:20px 24px 16px;border-bottom:1px solid var(--bt-line)}
.bt-card-modal-heading{min-width:0;flex:1}
.bt-card-eyebrow{margin:0 0 4px;color:var(--bt-ink-2);font-size:11px;line-height:16px}
.bt-card-modal-header h2{margin:0;font-size:15px;line-height:20px;font-weight:600;overflow-wrap:anywhere}
.bt-card-submeta{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:6px}
.bt-card-head-status{display:inline-flex;align-items:center;gap:5px;color:var(--bt-ink-2);font-size:11px;line-height:16px}
.bt-card-mobile-bar{display:none}
.bt-card-modal-actions{display:flex;align-items:center;gap:2px;flex:none}
.bt-card-title-form{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.bt-card-title-form input{min-width:240px;flex:1;font-size:15px;line-height:20px;font-weight:600;padding:6px 8px}
.bt-card-banner{padding:8px 24px;background:var(--bt-hover);font-size:12px;line-height:18px;border-bottom:1px solid var(--bt-line)}
.bt-card-banner-error{background:color-mix(in srgb,var(--bt-danger) 8%,var(--bt-card));color:var(--bt-ink)}
.bt-card-modal-body{display:grid;grid-template-columns:minmax(0,1fr) 272px;min-height:0;overflow-y:auto}
.bt-card-main{display:flex;flex-direction:column;gap:20px;min-width:0;padding:20px 24px 28px}
.bt-card-side{display:flex;flex-direction:column;gap:18px;min-width:0;padding:20px;border-left:1px solid var(--bt-line);background:var(--dsw-alias-bg-module-platform,var(--bt-sidebar))}
.bt-card-section{display:flex;flex-direction:column;gap:8px;min-width:0}
.bt-card-section-head{display:flex;align-items:center;justify-content:space-between;gap:8px;min-width:0}
.bt-card-section-head h3{margin:0;font-size:13px;line-height:18px;font-weight:600}
.bt-card-rich-text{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px;line-height:20px;color:var(--bt-ink)}
.bt-card-muted{color:var(--bt-ink-3);font-size:12px;line-height:18px;margin:0}
.bt-card-note{margin:0;color:var(--bt-ink-2);font-size:11px;line-height:16px}
.bt-card-warning{margin:0;padding:7px 9px;border-radius:8px;background:color-mix(in srgb,var(--bt-danger) 8%,var(--bt-card));color:var(--bt-ink);font-size:12px;line-height:18px}
.bt-card-ghost{display:flex;align-items:center;gap:6px;width:100%;padding:8px 10px;border:1px dashed var(--bt-line-2);border-radius:8px;background:transparent;color:var(--bt-ink-2);font-size:12px;line-height:18px;text-align:left}
.bt-card-ghost:hover:not(:disabled){background:var(--bt-hover);color:var(--bt-ink)}
.bt-card-editor{display:flex;flex-direction:column;gap:8px;min-width:0}
.bt-board-dialog .bt-card-editor textarea,.bt-card-modal .bt-card-editor textarea{width:100%;min-height:86px;resize:vertical}
.bt-card-editor-actions{display:flex;align-items:center;justify-content:flex-end;gap:8px;flex-wrap:wrap}
.bt-card-inline{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.bt-card-inline input{flex:1;min-width:140px}
.bt-card-check{display:flex;align-items:flex-start;gap:8px;font-size:12px;line-height:18px;color:var(--bt-ink)}
.bt-card-check input{width:15px;height:15px;margin:1px 0 0;flex:none;accent-color:var(--bt-accent)}
.bt-card-checklist-list{display:flex;flex-direction:column;gap:6px;margin:0;padding:0;list-style:none}
.bt-card-checklist-item{display:flex;align-items:flex-start;justify-content:space-between;gap:8px;padding:6px 8px;border:1px solid var(--bt-line);border-radius:8px;background:var(--bt-card)}
.bt-card-checklist-item .bt-card-check{flex:1;min-width:0}
.bt-card-checked{color:var(--bt-ink-3);text-decoration:line-through}
.bt-card-count{display:inline-flex;align-items:center;justify-content:center;min-width:20px;height:18px;padding:0 6px;border-radius:999px;background:var(--bt-tag-bg);color:var(--bt-ink-2);font-size:11px;line-height:16px;font-variant-numeric:tabular-nums}
.bt-attachment-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(128px,1fr));gap:8px}
.bt-attachment{margin:0;overflow:hidden;border:1px solid var(--bt-line);border-radius:10px;background:var(--bt-card)}
.bt-attachment-open{display:block;width:100%;height:92px;padding:0;border:0;border-radius:0;background:var(--bt-sidebar)}
.bt-attachment-open img{display:block;width:100%;height:100%;object-fit:cover}
.bt-attachment-placeholder{display:flex;align-items:center;justify-content:center;height:100%;padding:8px;color:var(--bt-ink-3);font-size:11px;line-height:16px;text-align:center}
.bt-attachment-file .bt-attachment-open{background:var(--bt-hover)}
.bt-attachment-file .bt-attachment-placeholder{flex-direction:column;gap:5px;color:var(--bt-ink-2);overflow:hidden}
.bt-attachment-file .bt-attachment-placeholder svg{width:20px;height:20px}
.bt-attachment-file .bt-attachment-placeholder small{color:var(--bt-ink-3);font-size:11px;line-height:16px}
.bt-attachment figcaption{display:flex;align-items:center;justify-content:space-between;gap:4px;padding:5px 6px;font-size:11px;line-height:16px;color:var(--bt-ink-2)}
.bt-attachment-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-attachment-queue{display:grid;grid-template-columns:repeat(auto-fill,minmax(128px,1fr));gap:8px}
.bt-attachment-queue img{display:block;width:100%;height:92px;object-fit:cover}
.bt-dropzone{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:10px 12px;border:1px dashed var(--bt-line-2);border-radius:10px;background:var(--bt-card);color:var(--bt-ink-2);font-size:12px;line-height:18px}
.bt-dropzone-active{border-color:var(--bt-accent);background:color-mix(in srgb,var(--bt-accent) 6%,var(--bt-card))}
.bt-dropzone svg{width:15px;height:15px}
.bt-comment-list{display:flex;flex-direction:column;gap:12px}
.bt-comment{display:flex;align-items:flex-start;gap:10px;min-width:0}
.bt-comment-body{display:flex;flex-direction:column;gap:4px;flex:1;min-width:0}
.bt-comment-body header{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.bt-comment-body header strong{font-size:12px;line-height:16px}
.bt-comment-body header time{color:var(--bt-ink-3);font-size:11px;line-height:16px}
.bt-comment-text{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px;line-height:20px;color:var(--bt-ink)}
.bt-comment-confirm{display:inline-flex;align-items:center;gap:4px}
.bt-comment-compose{display:flex;flex-direction:column;gap:8px;margin-top:4px}
.bt-board-dialog .bt-comment-compose textarea,.bt-card-modal .bt-comment-compose textarea{width:100%;min-height:64px;resize:vertical}
.bt-card-side-block{display:flex;flex-direction:column;gap:8px;min-width:0}
.bt-card-side-head{display:flex;align-items:center;justify-content:space-between;gap:8px}
.bt-card-side-head h4{margin:0;font-size:11px;line-height:16px;font-weight:600;letter-spacing:.02em;text-transform:uppercase;color:var(--bt-ink-2)}
.bt-card-status{display:flex;align-items:center;gap:8px;font-size:13px;line-height:18px}
.bt-card-people{display:flex;flex-direction:column;gap:8px}
.bt-card-person{display:flex;align-items:center;gap:8px;min-width:0}
.bt-card-person>span:last-child{display:flex;flex-direction:column;min-width:0;line-height:16px}
.bt-card-person strong{font-size:12px;line-height:16px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-card-person small{color:var(--bt-ink-2);font-size:11px;line-height:16px}
.bt-card-facts{display:flex;flex-direction:column;gap:8px}
.bt-board-fact{display:flex;flex-direction:column;gap:2px;min-width:0;font-size:12px;line-height:18px}
.bt-board-fact>span:first-child{color:var(--bt-ink-2);font-size:11px;line-height:16px}
.bt-board-fact>span:last-child{overflow-wrap:anywhere}
.bt-card-dependency-list{display:flex;flex-wrap:wrap;gap:4px}
.bt-card-due-inputs{display:flex;gap:6px;flex-wrap:wrap}
.bt-card-due-inputs input{flex:1;min-width:120px}
.bt-card-shares{display:flex;flex-direction:column;gap:8px;font-size:12px;line-height:18px}
.bt-card-share-list{display:flex;flex-direction:column;gap:4px}
.bt-card-share-row{display:flex;align-items:center;justify-content:space-between;gap:6px}
.bt-card-more>summary{list-style:none;cursor:pointer;color:var(--bt-ink-2);font-size:12px;line-height:18px;padding:4px 0}
.bt-card-more>summary::-webkit-details-marker{display:none}
.bt-card-more>summary:hover{color:var(--bt-ink)}
.bt-card-more-body{display:flex;flex-direction:column;gap:10px;padding-top:4px}
.bt-card-form{display:flex;flex-direction:column;gap:10px;min-width:0}
.bt-field{display:flex;flex-direction:column;gap:5px;min-width:0;font-size:12px;line-height:16px;color:var(--bt-ink-2)}
.bt-field>span:first-child,.bt-field>legend{color:var(--bt-ink-2);font-size:12px;line-height:16px}
.bt-field input,.bt-field select,.bt-field textarea{width:100%;color:var(--bt-ink)}
.bt-field textarea{min-height:72px;resize:vertical}
.bt-card-history{display:flex;flex-direction:column;gap:8px;font-size:12px;line-height:18px}
.bt-card-history>summary{list-style:none;cursor:pointer;color:var(--bt-ink-2)}
.bt-card-history>summary::-webkit-details-marker{display:none}
.bt-card-history article{display:flex;flex-direction:column;gap:4px;padding:8px;border:1px solid var(--bt-line);border-radius:8px;background:var(--bt-card)}
.bt-card-history p{margin:0;color:var(--bt-ink-2);overflow-wrap:anywhere}
.bt-card-activity{display:flex;flex-direction:column;gap:4px;font-size:12px;line-height:18px}
.bt-card-activity>summary{display:flex;align-items:center;gap:8px;list-style:none;cursor:pointer;color:var(--bt-ink-2)}
.bt-card-activity>summary::-webkit-details-marker{display:none}
.bt-card-activity ul{display:flex;flex-direction:column;gap:6px;margin:6px 0 0;padding:0;list-style:none}
.bt-card-activity li{display:flex;align-items:center;gap:8px;min-width:0}
.bt-card-activity time{margin-left:auto;color:var(--bt-ink-3);font-size:11px;line-height:16px;white-space:nowrap}
.bt-card-activity-dot{width:6px;height:6px;border-radius:50%;background:var(--bt-accent);flex:none}
.bt-card-change{display:flex;flex-direction:column;gap:8px;padding:10px 12px;border:1px solid var(--bt-line);border-radius:10px;background:var(--bt-card)}
.bt-card-change p{margin:0;color:var(--bt-ink-2);font-size:12px;line-height:18px;overflow-wrap:anywhere}
.bt-create-form{display:flex;flex-direction:column;gap:14px;padding:18px 24px 24px;overflow-y:auto}
.bt-create-row{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.bt-dependency-field{border:0;margin:0;padding:0}
.bt-dependency-list{display:flex;flex-direction:column;gap:4px;max-height:120px;overflow:auto;padding:6px;border:1px solid var(--bt-line);border-radius:8px;background:var(--bt-card)}
.bt-dependency-option{display:flex;align-items:center;gap:8px;font-size:12px;line-height:18px;color:var(--bt-ink)}
.bt-dependency-option input{width:14px;height:14px;flex:none;accent-color:var(--bt-accent)}
.bt-create-note{margin:0;color:var(--bt-ink-2);font-size:12px;line-height:18px}
.bt-create-actions{display:flex;align-items:center;justify-content:flex-end;gap:8px;flex-wrap:wrap;padding-top:14px;border-top:1px solid var(--bt-line)}
.bt-form-error{margin:0;color:var(--bt-danger);font-size:12px;line-height:18px}
.bt-lightbox{position:fixed;inset:0;z-index:10002;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:32px;background:var(--dsw-alias-bg-mask-photo,rgba(0,0,0,.88))}
.bt-lightbox img{max-width:min(1100px,100%);max-height:calc(100vh - 120px);object-fit:contain;border-radius:8px;background:var(--dsw-alias-bg-mask-photo,rgba(0,0,0,.88))}
.bt-lightbox-bar{display:flex;align-items:center;gap:12px;max-width:100%;color:var(--dsw-alias-label-primary-inverted,var(--bt-main));font-size:13px;line-height:18px}
.bt-lightbox-bar span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-lightbox-bar .bt-icon-btn{color:var(--dsw-alias-label-primary-inverted,var(--bt-main))}
.bt-lightbox-bar .bt-icon-btn:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary-inverted,var(--bt-main)) 14%,transparent)}
@media(max-width:900px){.bt-card-modal-body{grid-template-columns:1fr}.bt-card-side{border-left:0;border-top:1px solid var(--bt-line)}}
@media(max-width:700px){.bt-board-backdrop{padding:0}.bt-board-dialog{height:100%;max-height:none;border:0;border-radius:0}.bt-board-header{padding:12px 16px}.bt-board-toolbar{padding:10px 16px}.bt-board-review-tools{padding:8px 16px}.bt-board-content{padding:14px 16px 20px}.bt-board-lane,.bt-board-columns-personal .bt-board-lane{flex:0 0 min(84vw,300px);max-width:none}.bt-card-modal-backdrop{padding:0}.bt-card-modal{height:100dvh;max-height:100dvh;border:0;border-radius:0}.bt-card-modal-header{padding:16px}.bt-card-main{padding:16px 16px 24px}.bt-card-side{padding:16px}.bt-create-modal{height:100dvh;max-height:100dvh}.bt-create-form{padding:16px}.bt-create-row{grid-template-columns:1fr}.bt-lightbox{padding:16px}}
@media(prefers-reduced-motion:reduce){.bt-board-lane,.bt-board-card{transition:none}}

/* Harness skin: board surfaces, lanes and the card detail use the same hairline,
   quiet-hover and type steps as the rest of DeepSeek Harness. The rules above keep
   the recovery tools and legacy behaviour; these later rules own the board look. */
.bt-board-dialog,.bt-card-modal-backdrop,.bt-create-backdrop,.bt-lightbox{
  --bt-board-primary:var(--dsw-alias-button-primary-fill,var(--bt-ink));
  --bt-board-primary-ink:var(--dsw-alias-label-primary-inverted,var(--bt-main));
  --bt-board-primary-hover:var(--dsw-alias-button-primary-hover,color-mix(in srgb,var(--bt-ink) 82%,var(--bt-main)));
  --bt-board-canvas:color-mix(in srgb,var(--bt-sidebar) 55%,var(--bt-main));
  --bt-board-lane:color-mix(in srgb,var(--bt-card) 58%,var(--bt-sidebar));
  --bt-board-card-shadow:0 2px 8px -1px rgba(0,0,0,.06),0 1px 2px rgba(0,0,0,.04)}
.bt-board-backdrop{animation:bt-veil-in .22s ease-out}
.bt-board-dialog{animation:bt-dialog-rise ${SPRING_SHAPE.duration}ms ${SPRING_SHAPE.easing},bt-veil-in .22s ease-out}
.bt-board-header{padding:14px 20px;border-bottom:1px solid var(--bt-line)}
.bt-board-header h2{font-size:17px;line-height:24px;font-weight:500}
.bt-board-header p{font-size:12px;line-height:18px;margin-top:2px}
.bt-board-head-actions{gap:2px}
.bt-board-toolbar{padding:8px 20px;gap:8px}
.bt-board-search{height:34px;border-radius:10px;background:var(--bt-main);border:.5px solid var(--bt-line-2)}
.bt-board-search:focus-within{border-color:var(--bt-accent);box-shadow:0 0 0 2px color-mix(in srgb,var(--bt-accent) 18%,transparent)}
.bt-board-dialog .bt-board-filters select{height:30px;border-radius:999px;background-color:var(--bt-hover);font-size:12px;line-height:16px}
.bt-board-dialog .bt-board-filters select:hover{background-color:var(--bt-active)}
.bt-board-review-tools{display:flex;flex-wrap:wrap;align-items:flex-start;gap:8px;padding:8px 20px;max-height:none;overflow:visible}
.bt-board-review-tools:has(.bt-recovery-panel[open]){max-height:none}
.bt-recovery-panel{flex:0 1 auto;min-width:0;background:transparent;border:.5px solid var(--bt-line-2);border-radius:999px;box-shadow:none}
.bt-recovery-summary{padding:4px 10px;gap:6px}
.bt-recovery-icon{width:14px;height:14px;border-radius:0;background:none;color:var(--bt-ink-3);font-size:12px;line-height:14px}
.bt-recovery-summary-text{flex-direction:row;align-items:center;gap:6px}
.bt-recovery-summary-text strong{font-size:12px;line-height:16px;font-weight:500}
.bt-recovery-summary-text small{display:none}
.bt-recovery-count,.bt-recovery-badge{padding:0 6px;border-radius:999px;background:var(--bt-tag-bg);font-size:11px;line-height:16px;font-variant-numeric:tabular-nums}
.bt-recovery-panel[open]{flex:1 0 100%;border-radius:12px;background:var(--bt-card)}
.bt-recovery-panel[open]>.bt-recovery-summary{border-bottom:1px solid var(--bt-line)}
.bt-recovery-body{padding:12px;max-height:none;overflow:visible}
.bt-recovery-groups,.bt-recovery-work-groups,.bt-recovery-deliveries{max-height:none;overflow:visible}
.bt-board-error,.bt-board-pending{padding:8px 20px;background:color-mix(in srgb,var(--bt-danger) 8%,var(--bt-main));font-size:12px;line-height:18px}
.bt-board-legacy-note{padding:7px 20px;background:color-mix(in srgb,var(--bt-accent) 5%,var(--bt-main));font-size:12px;line-height:18px}
.bt-board-content{display:flex;flex-direction:column;gap:16px;flex:1;min-height:0;overflow:hidden;padding:16px 20px 18px;background:color-mix(in srgb,var(--bt-sidebar) 82%,var(--bt-main))}
.bt-board-section{display:flex;flex-direction:column;flex:1;min-height:0}
.bt-board-goal-cards{flex:none;min-height:0}
.bt-board-goal-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,260px),1fr));gap:10px;align-items:start;max-height:min(34vh,360px);overflow:auto;padding-bottom:2px}
.bt-board-section+.bt-board-section{margin-top:0}
.bt-board-section-heading{margin:0 0 8px}
.bt-board-section-heading h3{font-size:13px;line-height:18px;font-weight:600}
.bt-board-section-heading p{font-size:12px;line-height:18px;margin-top:2px}
.bt-board-rail{display:flex;flex-direction:column;flex:1;min-height:0}
.bt-board-rail-controls{margin-bottom:4px}
.bt-board-columns{flex:1;min-height:0;height:auto;align-items:stretch;gap:12px;padding:0 0 2px;overflow-x:auto;overflow-y:hidden}
.bt-board-columns-personal .bt-board-lane{flex:1 0 260px;max-width:420px;min-height:180px}
.bt-board-lane{flex:0 0 clamp(220px,18vw,288px);min-height:220px;max-height:100%;padding:8px;border:.5px solid var(--bt-line);border-radius:12px;background:var(--bt-card);transition:background-color .12s,border-color .12s}
.bt-board-lane-drop{border-color:color-mix(in srgb,var(--bt-accent) 46%,transparent);background:color-mix(in srgb,var(--bt-accent) 6%,var(--bt-card))}
.bt-board-lane-head{padding:1px 4px 6px}
.bt-board-lane-title h3{font-size:13px;line-height:18px;font-weight:600}
.bt-board-lane-cards{display:flex;flex-direction:column;gap:8px;flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:0 2px 2px;scrollbar-width:thin}
.bt-board-lane-cards:empty{display:none}
.bt-board-lane-empty{flex:1;min-height:80px;margin:0;padding:10px;border:.5px dashed color-mix(in srgb,var(--bt-ink) 16%,transparent);border-radius:10px;font-size:12px;line-height:18px}
.bt-board-lane-add{height:30px;margin-top:4px;padding:0 6px;border-radius:8px;font-size:13px;line-height:18px}
.bt-board-quick-add{display:flex;flex-direction:column;gap:6px;margin-top:4px}
.bt-board-quick-add textarea{width:100%;min-height:56px;resize:vertical;border-radius:8px;font-size:13px;line-height:18px}
.bt-board-quick-add-actions{display:flex;align-items:center;gap:6px}
.bt-board-card{border:.5px solid var(--bt-line);border-radius:12px;background:var(--bt-card);box-shadow:none;transition:box-shadow .12s,border-color .12s}
.bt-board-card:hover{border-color:var(--bt-line-2);box-shadow:var(--bt-board-card-shadow)}
.bt-board-card-cover{height:128px;border-bottom:.5px solid var(--bt-line)}
.bt-board-card-summary{padding:9px 10px 8px;gap:6px}
.bt-board-card-title{font-size:13px;line-height:18px;font-weight:500}
.bt-board-card-meta{gap:6px}
.bt-board-card-foot{margin-top:4px}
.bt-board-open-hint{display:none}
.bt-board-label{padding:2px 6px;border-radius:4px;font-size:11px;line-height:16px}
.bt-board-due,.bt-board-chip{border-radius:4px}
.bt-board-card-count svg,.bt-board-due svg{width:12px;height:12px}
.bt-board-progress-track{width:32px;height:3px}
.bt-board-avatar{border-radius:50%;corner-shape:round}
.bt-board-toast{border-radius:12px;background:var(--dsw-alias-toast-bg,var(--bt-ink));color:var(--dsw-alias-toast-label,var(--bt-card));box-shadow:0 8px 28px rgba(0,0,0,.14);font-size:12px;line-height:18px;animation:bt-veil-in .16s ease-out}
.bt-card-modal-backdrop{animation:bt-veil-in .16s ease-out}
.bt-card-modal{background:var(--bt-main);border:.5px solid var(--bt-line-2);border-radius:16px;box-shadow:0 24px 80px rgba(0,0,0,.24);animation:bt-dialog-rise ${SPRING_SHAPE.duration}ms ${SPRING_SHAPE.easing},bt-veil-in .22s ease-out}
.bt-card-modal-header{padding:18px 22px 14px}
.bt-card-modal-header h2{font-size:17px;line-height:24px;font-weight:500}
.bt-card-eyebrow{font-size:11px;line-height:16px;margin-bottom:2px}
.bt-card-submeta{margin-top:4px}
.bt-card-modal-body{grid-template-columns:minmax(0,1fr) 280px}
.bt-card-main{gap:18px;padding:18px 22px 26px}
.bt-card-side{gap:16px;padding:18px;border-left:.5px solid var(--bt-line);background:var(--bt-sidebar)}
.bt-card-section{gap:8px}
.bt-card-section-head h3{font-size:13px;line-height:18px;font-weight:600}
.bt-card-rich-text{font-size:13px;line-height:20px}
.bt-card-side-head h4{font-size:12px;line-height:16px;font-weight:600;letter-spacing:0;text-transform:none;color:var(--bt-ink-2)}
.bt-card-muted,.bt-card-note{font-size:12px;line-height:18px}
.bt-card-warning{border-radius:8px;font-size:12px;line-height:18px}
.bt-card-ghost{padding:7px 9px;border:.5px dashed var(--bt-line-2);border-radius:8px;font-size:12px;line-height:18px}
.bt-board-dialog .bt-card-editor textarea,.bt-card-modal .bt-card-editor textarea{min-height:80px}
.bt-card-checklist-item{padding:5px 7px;border:.5px solid var(--bt-line);border-radius:8px}
.bt-card-inline input{height:30px;font-size:13px;line-height:18px}
.bt-card-check{font-size:12px;line-height:18px}
.bt-card-count{border-radius:999px;font-size:11px;line-height:16px}
.bt-attachment-grid,.bt-attachment-queue{grid-template-columns:repeat(auto-fill,minmax(112px,1fr))}
.bt-attachment{position:relative;border:.5px solid var(--bt-line);border-radius:10px}
.bt-attachment-open{height:82px}
.bt-attachment figcaption{padding:4px 6px;font-size:11px;line-height:16px}
.bt-attachment-cover-flag{position:absolute;left:5px;top:5px;padding:1px 5px;border-radius:4px;background:var(--dsw-alias-toast-bg,var(--bt-ink));color:var(--dsw-alias-toast-label,var(--bt-card));font-size:11px;line-height:16px;font-weight:500}
.bt-attachment-cover{position:relative}
.bt-attachment-cover .bt-attachment-open{position:relative}
.bt-card-checklist-actions{display:flex;align-items:center;gap:2px;flex:none}
.bt-card-checklist-edit{flex:1;min-width:0}
.bt-card-checklist-edit input{flex:1;min-width:80px}
.bt-attachment-cover-action{position:absolute;right:5px;bottom:27px;z-index:1;display:inline-flex;align-items:center;padding:1px 6px;border:0;border-radius:4px;background:var(--dsw-alias-toast-bg,var(--bt-ink));color:var(--dsw-alias-toast-label,var(--bt-card));font-size:11px;line-height:16px;font-weight:500;opacity:0;transition:opacity .12s}
.bt-attachment:hover .bt-attachment-cover-action,.bt-attachment-cover-action:focus-visible,.bt-attachment-cover .bt-attachment-cover-action{opacity:1}
.bt-dropzone{padding:8px 10px;border:.5px dashed var(--bt-line-2);border-radius:10px;font-size:12px;line-height:18px;gap:6px;flex-direction:row;justify-content:center;min-height:44px}
.bt-dropzone svg{width:14px;height:14px}
.bt-comment-list{gap:14px}
.bt-comment{gap:8px}
.bt-comment-body header strong{font-size:12px;line-height:16px;font-weight:600}
.bt-comment-text{font-size:13px;line-height:20px}
.bt-comment-compose textarea{min-height:56px}
.bt-board-dialog .bt-comment-compose textarea,.bt-card-modal .bt-comment-compose textarea{min-height:56px}
.bt-card-activity,.bt-card-history{font-size:12px;line-height:18px}
.bt-card-change{padding:9px 11px;border:.5px solid var(--bt-line);border-radius:10px}
.bt-board-dialog input,.bt-board-dialog select,.bt-board-dialog textarea,.bt-card-modal input,.bt-card-modal select,.bt-card-modal textarea{border:.5px solid var(--bt-line-2);background:var(--bt-card);border-radius:8px;font-size:13px;line-height:18px;padding:6px 9px}
.bt-btn{height:32px;padding:0 12px;border-radius:999px;background:var(--bt-hover);font-size:13px;line-height:18px;font-weight:500}
.bt-btn-primary{background:var(--bt-board-primary);color:var(--bt-board-primary-ink)}
.bt-btn-primary:hover:not(:disabled){background:var(--bt-board-primary-hover)}
.bt-board-dialog .bt-btn-primary,.bt-card-modal .bt-btn-primary,.bt-create-modal .bt-btn-primary{background:var(--bt-board-primary);color:var(--bt-board-primary-ink)}
.bt-board-dialog .bt-btn-primary:hover:not(:disabled),.bt-card-modal .bt-btn-primary:hover:not(:disabled),.bt-create-modal .bt-btn-primary:hover:not(:disabled){background:var(--bt-board-primary-hover)}
.bt-btn-ghost{background:transparent;border:.5px solid var(--bt-line-2)}
.bt-icon-btn{width:28px;height:28px}
.bt-card-mini{padding:2px 5px;border-radius:6px;font-size:12px;line-height:16px}
.bt-field{gap:4px;font-size:12px;line-height:16px}
.bt-field>span:first-child,.bt-field>legend{font-size:12px;line-height:16px;font-weight:500;color:var(--bt-ink-2)}
.bt-field textarea{min-height:64px}
.bt-create-modal{width:min(620px,100%)}
.bt-create-form{gap:12px;padding:16px 22px 20px}
.bt-create-row{gap:10px}
.bt-create-note,.bt-create-actions{font-size:12px;line-height:18px}
.bt-create-actions{padding-top:12px}
.bt-form-error{font-size:12px;line-height:18px}
@media(max-width:900px){.bt-card-modal-body{grid-template-columns:1fr}.bt-card-side{border-left:0;border-top:.5px solid var(--bt-line)}.bt-board-review-tools{max-height:38vh;overflow:auto}
  .bt-card-mobile-bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;grid-column:1/-1;position:sticky;top:0;z-index:3;padding:8px 16px;border-bottom:.5px solid var(--bt-line);background:color-mix(in srgb,var(--bt-main) 94%,transparent);backdrop-filter:blur(8px)}
  .bt-card-mobile-bar .bt-board-card-owner{font-size:12px;line-height:16px;min-width:0;flex:1}
  .bt-card-mobile-bar .bt-card-mini{margin-left:auto;background:var(--bt-hover)}
}
@media(max-width:700px){.bt-board-header{padding:12px 16px}.bt-board-capacity{display:none}.bt-board-toolbar{padding:8px 16px}.bt-board-review-tools{padding:8px 16px}.bt-board-content{padding:12px 16px 16px;gap:12px}.bt-board-lane,.bt-board-columns-personal .bt-board-lane{flex:0 0 min(84vw,288px);max-width:none}.bt-card-modal-header{padding:14px 16px 12px}.bt-card-main{padding:16px}.bt-card-side{padding:16px}.bt-create-form{padding:16px}}
@media(prefers-reduced-motion:reduce){.bt-board-backdrop,.bt-board-dialog,.bt-card-modal-backdrop,.bt-card-modal,.bt-board-filter-scrim{animation:none!important}.bt-board-lane,.bt-board-card{transition:none}}

/* Phase 2: task types, lifecycle lanes, releases and confirmations. */
.bt-board-views{display:inline-flex;align-items:center;gap:2px;flex:none;padding:2px;border-radius:10px;background:var(--bt-hover)}
.bt-board-view{height:28px;padding:0 10px;border:0;border-radius:8px;background:transparent;color:var(--bt-ink-2);font:inherit;font-size:12px;line-height:16px}
.bt-board-view:hover:not(:disabled){color:var(--bt-ink)}
.bt-board-view[aria-pressed=true]{background:var(--bt-card);color:var(--bt-ink);box-shadow:0 .5px 2px rgba(0,0,0,.06)}
.bt-board-changes{display:inline-flex;align-items:center;gap:6px;flex:none;height:30px;padding:0 10px;border:.5px solid var(--bt-line-2);border-radius:999px;background:var(--bt-card);color:var(--bt-ink-2);font:inherit;font-size:12px;line-height:16px}
.bt-board-changes:hover:not(:disabled){background:var(--bt-hover);color:var(--bt-ink)}
.bt-board-changes[aria-pressed=true]{color:var(--bt-ink);background:var(--bt-active)}
.bt-board-changes-new .bt-board-count{background:var(--bt-accent);color:var(--bt-accent-ink)}
.bt-board-filter-toggle,.bt-board-tools-toggle{display:none}
.bt-board-summary{display:flex;align-items:center;gap:16px;flex-wrap:wrap;padding:7px 24px;border-bottom:1px solid var(--bt-line);color:var(--bt-ink-2);font-size:12px;line-height:16px}
.bt-board-summary b{color:var(--bt-ink);font-weight:600;font-variant-numeric:tabular-nums}
.bt-board-summary-alert,.bt-board-summary-alert b{color:var(--bt-danger)}
.bt-board-type{display:inline-flex;align-items:center;max-width:100%;padding:1px 6px;border-radius:4px;background:var(--bt-tag-bg);color:var(--bt-ink-2);font-size:11px;line-height:16px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bt-board-stage-dot-draft{background:var(--bt-ink-3)}
.bt-board-stage-dot-cancelled{background:color-mix(in srgb,var(--bt-danger) 55%,var(--bt-ink-3))}
.bt-board-stage-dot-unassigned{background:var(--bt-ink-3)}
.bt-card-status-actions{display:flex;flex-direction:column;gap:6px}
.bt-card-move>summary{display:flex;align-items:center;min-height:28px;cursor:pointer;color:var(--bt-ink-2);font-size:12px;line-height:16px;list-style:none}
.bt-card-move>summary::-webkit-details-marker{display:none}
.bt-card-move-body{display:flex;flex-direction:column;gap:4px;padding-top:4px}
.bt-card-move-body .bt-card-mini{width:100%;justify-content:flex-start}
.bt-card-cancel{color:var(--bt-danger)}
.bt-card-cancel:hover:not(:disabled){background:color-mix(in srgb,var(--bt-danger) 10%,transparent)}
.bt-card-confirm{display:flex;flex-direction:column;gap:10px;flex:none;padding:12px 22px;border-bottom:1px solid var(--bt-line);background:var(--bt-sidebar)}
.bt-card-confirm:focus-visible{outline:2px solid var(--bt-accent);outline-offset:-2px}
.bt-card-confirm-head h3{margin:0;font-size:13px;line-height:18px;font-weight:600}
.bt-card-confirm-head p{margin:2px 0 0;font-size:11px;line-height:16px;color:var(--bt-ink-2)}
.bt-card-diff{display:flex;flex-direction:column;max-height:min(34vh,320px);overflow:auto;border:.5px solid var(--bt-line);border-radius:8px;background:var(--bt-card)}
.bt-card-diff-row{display:grid;gap:2px;min-width:0;padding:7px 9px;border-top:.5px solid var(--bt-line)}
.bt-card-diff-row:first-child{border-top:0}
.bt-card-diff-row strong{font-size:11px;line-height:16px;font-weight:500;color:var(--bt-ink-2)}
.bt-card-diff-values{display:flex;flex-direction:column;gap:1px;min-width:0;font-size:12px;line-height:18px}
.bt-card-diff-values span{overflow-wrap:anywhere}
.bt-card-diff-values b{font-weight:500;color:var(--bt-ink-2)}
.bt-board-release-bar{display:flex;align-items:center;gap:8px;flex:none;min-width:0;padding:7px 0 9px;border-bottom:1px solid var(--bt-line)}
.bt-board-release-chips{display:flex;align-items:center;gap:6px;flex:1;min-width:0;overflow-x:auto;padding:1px;scrollbar-width:none}
.bt-board-release-chips::-webkit-scrollbar{display:none}
.bt-board-release-chip{display:inline-flex;align-items:center;gap:6px;flex:none;height:28px;padding:0 9px;border:.5px solid var(--bt-line-2);border-radius:999px;background:var(--bt-card);color:var(--bt-ink);font:inherit;font-size:11px;line-height:16px;white-space:nowrap}
.bt-board-release-chip:hover:not(:disabled){background:var(--bt-hover)}
.bt-board-release-name{max-width:130px;overflow:hidden;text-overflow:ellipsis;font-weight:500}
.bt-board-release-version{color:var(--bt-ink-3);font-variant-numeric:tabular-nums}
.bt-board-release-status{display:inline-flex;align-items:center;padding:0 6px;border-radius:4px;background:var(--bt-tag-bg);color:var(--bt-ink-2);font-size:11px;line-height:16px;font-weight:500}
.bt-board-release-status-queued{background:color-mix(in srgb,var(--bt-accent) 12%,var(--bt-card));color:color-mix(in srgb,var(--bt-accent) 70%,var(--bt-ink))}
.bt-board-release-status-running,.bt-board-release-status-published{background:color-mix(in srgb,var(--bt-green) 14%,var(--bt-card));color:color-mix(in srgb,var(--bt-green) 58%,var(--bt-ink))}
.bt-board-release-status-cancelled{background:color-mix(in srgb,var(--bt-danger) 10%,var(--bt-card));color:var(--bt-danger)}
.bt-board-release-progress{color:var(--bt-ink-3);font-variant-numeric:tabular-nums}
.bt-board-release-meta{display:flex;align-items:center;gap:4px;flex-wrap:wrap;min-width:0}
.bt-board-lane-actions,.bt-board-release-actions{display:flex;align-items:center;justify-content:flex-end;gap:2px;flex-wrap:wrap;min-width:0}
.bt-board-release-actions .bt-card-mini{border:.5px solid var(--bt-line);background:var(--bt-card)}
.bt-board-release-actions .bt-card-mini:hover:not(:disabled){background:var(--bt-hover)}
.bt-board-dialog{position:relative}
.bt-board-confirm-layer{position:absolute;inset:0;z-index:2;display:flex;align-items:center;justify-content:center;padding:24px;background:var(--dsw-alias-bg-mask-3,rgba(0,0,0,.32))}
.bt-board-confirm{box-sizing:border-box;display:flex;flex-direction:column;width:min(440px,100%);max-height:min(70vh,520px);overflow:auto;padding:16px;border:.5px solid var(--bt-line-2);border-radius:12px;background:var(--bt-main);box-shadow:0 24px 80px rgba(0,0,0,.24);color:var(--bt-ink)}
.bt-board-confirm:focus-visible{outline:2px solid var(--bt-accent);outline-offset:2px}
.bt-board-confirm-title{margin:2px 0 0;font-size:13px;line-height:18px;font-weight:500;overflow-wrap:anywhere}
.bt-board-confirm .bt-card-diff{margin-top:10px}
.bt-board-confirm .bt-card-editor-actions{margin-top:12px}
.bt-board-lane[data-kind="release"] .bt-board-lane-head{flex-wrap:wrap;row-gap:4px}
.bt-board-lane[data-kind="release"] .bt-board-lane-title{flex:1 1 100%;flex-wrap:wrap;row-gap:2px}
.bt-board-lane[data-kind="release"] .bt-board-lane-title h3{white-space:normal;overflow:visible;text-overflow:clip;min-width:0}
.bt-board-lane[data-kind="release"] .bt-board-release-meta{flex:1 0 100%;order:2}
.bt-board-lane[data-kind="release"] .bt-board-release-actions{flex:1 1 100%;justify-content:flex-start;flex-wrap:wrap}
.bt-board-release-cancel{color:var(--bt-danger)}
.bt-board-lane-focus{border-color:color-mix(in srgb,var(--bt-accent) 46%,var(--bt-line));box-shadow:0 0 0 2px color-mix(in srgb,var(--bt-accent) 14%,transparent)}
.bt-board-release-error{margin:0;padding:8px 10px;border-radius:8px;background:color-mix(in srgb,var(--bt-danger) 8%,var(--bt-card));color:var(--bt-ink);font-size:12px;line-height:18px;flex:none}
.bt-board-section-heading-row{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;flex-wrap:wrap}
.bt-board-new-release{flex:none}
.bt-release-modal{width:min(420px,100%)}
.bt-board-proposals{display:flex;flex-direction:column;gap:8px;flex:none;min-width:0;max-height:min(42vh,420px);overflow:auto;padding:10px 12px;border:.5px solid var(--bt-line-2);border-radius:12px;background:var(--bt-card);box-shadow:var(--bt-board-card-shadow)}
.bt-board-proposals-head{display:flex;align-items:center;gap:8px}
.bt-board-proposals-head h3{margin:0;flex:1;font-size:13px;line-height:18px;font-weight:600}
.bt-board-proposal{display:flex;flex-direction:column;gap:6px;min-width:0;padding:9px 0 0;border-top:.5px solid var(--bt-line)}
.bt-board-proposal-head{display:flex;align-items:center;justify-content:space-between;gap:8px;min-width:0}
.bt-board-proposal-head strong{font-size:13px;line-height:18px;overflow-wrap:anywhere}
.bt-board-proposal-kind{flex:none;padding:0 6px;border-radius:4px;background:var(--bt-tag-bg);color:var(--bt-ink-2);font-size:11px;line-height:16px}
.bt-board-proposal-meta{margin:0;font-size:11px;line-height:16px;color:var(--bt-ink-3)}
.bt-board-proposal-note{margin:0;font-size:12px;line-height:18px;color:var(--bt-ink-2);overflow-wrap:anywhere}
.bt-board-proposal-diff{display:flex;flex-direction:column;overflow:hidden;border:.5px solid var(--bt-line);border-radius:8px}
.bt-board-proposal-actions{display:flex;justify-content:flex-end;gap:6px;flex-wrap:wrap}
@media(max-width:700px){.bt-board-release-bar{flex-wrap:wrap}.bt-board-release-chips{flex-basis:100%;order:2}.bt-card-confirm{padding:10px 16px}.bt-board-proposals{max-height:46vh}.bt-board-proposal-diff,.bt-card-diff{max-height:40vh}}

/* Release teams, gates, the release detail and its read-only summary report. */
.bt-board-release-status-failed{background:color-mix(in srgb,var(--bt-danger) 10%,var(--bt-card));color:var(--bt-danger)}
.bt-board-release-pm,.bt-board-release-roles,.bt-board-release-group{display:inline-flex;align-items:center;max-width:100%;min-width:0;color:var(--bt-ink-2);font-size:11px;line-height:16px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-board-release-pm{max-width:190px}
.bt-board-release-team-none{color:var(--bt-ink-3)}
.bt-board-release-gates{display:inline-flex;align-items:center;gap:3px;flex-wrap:wrap;min-width:0}
.bt-board-gate{display:inline-flex;align-items:center;gap:3px;padding:0 5px;border:.5px solid var(--bt-line);border-radius:4px;background:var(--bt-card);color:var(--bt-ink-3);font-size:11px;line-height:16px}
.bt-board-gate-dot{width:5px;height:5px;flex:none;border-radius:50%;background:var(--bt-ink-3);corner-shape:round}
.bt-board-gate-passed{color:color-mix(in srgb,var(--bt-green) 58%,var(--bt-ink));border-color:color-mix(in srgb,var(--bt-green) 34%,var(--bt-line))}
.bt-board-gate-passed .bt-board-gate-dot{background:var(--bt-green)}
.bt-board-gate-failed{color:var(--bt-danger);border-color:color-mix(in srgb,var(--bt-danger) 34%,var(--bt-line))}
.bt-board-gate-failed .bt-board-gate-dot{background:var(--bt-danger)}
.bt-board-release-awaiting{padding:0 6px;border-radius:4px;background:color-mix(in srgb,var(--bt-star) 14%,var(--bt-card));color:color-mix(in srgb,var(--bt-star) 62%,var(--bt-ink));font-size:11px;line-height:16px;font-weight:500}
.bt-release-modal-team{width:min(620px,100%)}
.bt-release-team{display:flex;flex-direction:column;gap:8px;padding:10px 12px;border:.5px solid var(--bt-line-2);border-radius:12px;background:var(--bt-sidebar)}
.bt-release-team-head{display:flex;align-items:center;justify-content:space-between;gap:8px}
.bt-release-team-head h3{margin:0;font-size:12px;line-height:16px;font-weight:600}
.bt-release-team-count{color:var(--bt-ink-3);font-size:11px;line-height:16px;font-variant-numeric:tabular-nums}
.bt-release-team-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,150px),1fr));gap:8px}
.bt-release-team .bt-field{gap:3px}
.bt-release-team select{box-sizing:border-box;width:100%;height:30px;padding:4px 8px;font-size:13px;line-height:18px}
.bt-release-required{color:var(--bt-ink-3);font-weight:400}
.bt-release-team-hint{margin:0;color:var(--bt-ink-3);font-size:11px;line-height:16px}
.bt-release-detail{width:min(760px,100%)}
.bt-release-detail-body{display:flex;flex-direction:column;gap:14px;min-height:0;overflow-y:auto;padding:16px 22px 22px}
.bt-release-facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,150px),1fr));gap:10px;padding:10px 12px;border:.5px solid var(--bt-line-2);border-radius:12px;background:var(--bt-card)}
.bt-release-section{display:flex;flex-direction:column;gap:8px;min-width:0}
.bt-release-section-head{display:flex;align-items:center;justify-content:space-between;gap:8px}
.bt-release-section-head h3{margin:0;font-size:12px;line-height:16px;font-weight:600}
.bt-release-section-count{color:var(--bt-ink-3);font-size:11px;line-height:16px;font-variant-numeric:tabular-nums}
.bt-release-role-list{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,190px),1fr));gap:6px 12px;padding:10px 12px;border:.5px solid var(--bt-line-2);border-radius:12px;background:var(--bt-card)}
.bt-release-role{display:flex;align-items:baseline;justify-content:space-between;gap:8px;min-width:0;font-size:12px;line-height:16px}
.bt-release-role>span:first-child{color:var(--bt-ink-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-release-role-name{color:var(--bt-ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-release-role-none{color:var(--bt-ink-3)}
.bt-release-gates{display:flex;flex-direction:column;gap:8px}
.bt-release-gate{display:flex;flex-direction:column;gap:6px;padding:10px 12px;border:1px solid var(--bt-line);border-radius:12px;background:var(--bt-card)}
.bt-release-gate-head{display:flex;align-items:center;justify-content:space-between;gap:8px}
.bt-release-gate-head strong{font-size:12px;line-height:16px;font-weight:600}
.bt-release-gate-state{padding:0 6px;border-radius:4px;background:var(--bt-tag-bg);color:var(--bt-ink-2);font-size:11px;line-height:16px;font-weight:500}
.bt-release-gate-state-passed{background:color-mix(in srgb,var(--bt-green) 14%,var(--bt-card));color:color-mix(in srgb,var(--bt-green) 58%,var(--bt-ink))}
.bt-release-gate-state-failed{background:color-mix(in srgb,var(--bt-danger) 10%,var(--bt-card));color:var(--bt-danger)}
.bt-release-gate-evidence{margin:0;color:var(--bt-ink-2);font-size:12px;line-height:18px;overflow-wrap:anywhere}
.bt-release-gate-edit{display:grid;grid-template-columns:minmax(110px,140px) minmax(0,1fr) auto;gap:6px;align-items:end;min-width:0}
.bt-release-gate-field{display:flex;flex-direction:column;gap:3px;min-width:0;color:var(--bt-ink-2);font-size:12px;line-height:16px}
.bt-release-gate .bt-release-gate-field select,.bt-release-gate .bt-release-gate-field input{box-sizing:border-box;width:100%;height:30px;padding:4px 8px;font-size:13px;line-height:18px}
.bt-release-gate-save{flex:none;white-space:nowrap}
.bt-release-gate-hint{margin:0;color:var(--bt-ink-3);font-size:11px;line-height:16px}
.bt-release-detail-actions{display:flex;align-items:center;justify-content:flex-end;gap:8px;flex-wrap:wrap;padding-top:2px}
.bt-release-report{width:min(760px,100%)}
.bt-release-report-body{flex:1;min-height:0;overflow:auto;padding:16px 22px}
.bt-release-report-text{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--bt-ink);font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace}
.bt-release-report-foot{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;flex:none;padding:12px 22px 16px;border-top:1px solid var(--bt-line)}
.bt-release-report-buttons{display:flex;align-items:center;gap:8px}
@media(max-width:700px){.bt-release-detail-body,.bt-release-report-body{padding:12px 16px}.bt-release-gate-edit{grid-template-columns:1fr;align-items:stretch}.bt-release-report-foot{padding:10px 16px 14px}}
.bt-board-lane-cards>.bt-board-card{flex:none}
.bt-card-icon-danger{width:28px;height:28px}
@media(max-width:700px){
  .bt-board-filter-toggle,.bt-board-tools-toggle{display:inline-flex;align-items:center;justify-content:center;gap:4px;min-height:30px;padding:0 10px;border:.5px solid var(--bt-line-2);border-radius:999px;background:var(--bt-card);color:var(--bt-ink-2);font:inherit;font-size:12px;line-height:16px}
  .bt-board-tools-toggle{align-self:flex-start;margin:6px 16px 0}
  .bt-board-summary{display:none}
  .bt-board-new-release{display:none}
  .bt-board-bulk{padding:6px 16px;flex-wrap:nowrap;overflow-x:auto}
  .bt-board-filters{display:none}
  .bt-board-filters-open{display:grid;grid-template-columns:1fr;gap:8px;position:fixed;left:12px;right:12px;bottom:16px;z-index:10002;max-height:min(70vh,520px);overflow:auto;padding:14px;border:.5px solid var(--bt-line-2);border-radius:16px;background:var(--bt-main);box-shadow:0 24px 80px rgba(0,0,0,.22);mask-image:none}
  .bt-board-filter-scrim{display:block;position:fixed;inset:0;z-index:10001;background:color-mix(in srgb,var(--bt-ink) 24%,transparent);animation:bt-veil-in .12s ease-out}
  .bt-board-filters-open>*{width:100%;min-height:36px}
  .bt-board-review-tools{display:none}
  .bt-board-review-tools-open{display:flex;flex-wrap:wrap;max-height:34vh;overflow:auto;mask-image:none}
  .bt-board-release-chips{flex-wrap:nowrap;overflow-x:auto;scrollbar-width:none;mask-image:linear-gradient(to right,#000 0,#000 calc(100% - 18px),transparent 100%)}
  .bt-board-release-chips::-webkit-scrollbar{display:none}
}
`
