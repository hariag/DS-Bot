import { createElement as h, useEffect, useRef, useState } from 'react'
import { createPortal, flushSync } from 'react-dom'
import { call } from './api.js'
import { hostText, t } from './i18n.js'

// The server supplies already-authorized tasks; never infer membership or filter
// another actor's private tasks in the browser.
const COLUMNS = [
  ['proposed', 'Preparing'], ['waiting', 'Waiting'], ['ready', 'Ready'],
  ['legacy-pending', 'Not started'], ['working', 'In progress'], ['reported', 'Awaiting review'], ['done', 'Done'],
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

// The host sends metadata only. This view has no commands to replay or close work.
function HeldTurns({ recovery }) {
  if (!recovery || recovery.available !== true) return h('p', { className: 'bt-board-pending', role: 'status' }, t('Recovery records are unavailable or incomplete.'))
  const rows = Array.isArray(recovery.items) ? recovery.items : []
  const sampled = Number.isSafeInteger(recovery.sampledAt) && recovery.sampledAt >= 0 && recovery.sampledAt <= 8_640_000_000_000_000
    ? new Date(recovery.sampledAt).toISOString() : t('Unknown')
  if (!rows.length && !recovery.incomplete) return h('p', { className:'bt-board-recovery-clear', role:'status' },
    t('No interrupted turns in this snapshot.'), ' ', t('Snapshot time (UTC)'), ': ', sampled)
  return h('details', { className: 'bt-board-held' },
    h('summary', null, t('Interrupted turns awaiting review'), rows.length ? ` (${rows.length})` : ''),
    h('p', null, t('Snapshot time (UTC)'), ': ', sampled),
    h('p', null, t('These records are read-only. A result is unknown; no work is resent or closed here.')),
    recovery.incomplete ? h('p', { role: 'status' }, t('Recovery records are unavailable or incomplete.')) : null,
    rows.map(item => h('article', { key: item.recoveryId, className: 'bt-board-held-record' },
      h(Fact, { label: t('Bot'), value: item.botName || item.botId }),
      h(Fact, { label: t('Session ID'), value: item.sessionId }),
      h(Fact, { label: t('Original turn'), value: Number.isSafeInteger(item.turn) ? String(item.turn) : t('Unknown') }),
      h(Fact, { label: t('Started at'), value: Number.isSafeInteger(item.startedAt) ? new Date(item.startedAt).toLocaleString() : t('Unknown') }),
      h(Fact, { label: t('Exchange ID'), value: item.exchangeId || t('Unknown') }),
      h(Fact, { label: t('Recovery ID'), value: item.recoveryId }),
      h(Fact, { label: t('Evidence'), value: 'inflight.json' }))))
}

// Owner-only manual notes on an existing work. This never dispatches or closes it.
const recoveryObservationText = value => value === 'observed-present' ? t('Observed in snapshot')
  : value === 'observed-absent' ? t('Not observed in snapshot') : t('Not known')
const legacyReviewStateText = value => value === 'needs-review' ? t('Needs manual review')
  : value === 'evidence-needed' ? t('Evidence still needed')
    : value === 'identity-unverified' ? t('Work identity unverified') : t('Not known')
function LegacyWorkReview({ scope, request }) {
  const [workId, setWorkId] = useState(''), [record, setRecord] = useState(null)
  const [summary, setSummary] = useState(''), [evidence, setEvidence] = useState(''), [unfinished, setUnfinished] = useState('')
  const [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const [candidates, setCandidates] = useState(null)
  const epoch = useRef(0), scopeKey = `${scope.kind}:${scope.id}`
  useEffect(() => { epoch.current++; setWorkId(''); setRecord(null); setCandidates(null); setSummary(''); setEvidence(''); setUnfinished(''); setError(''); setBusy(false); return () => { epoch.current++ } }, [scopeKey])
  const run = async (endpoint, body) => {
    const current = epoch.current; setBusy(true); setError('')
    try { const result = await request(endpoint, { scope, workId, ...body }); if (current === epoch.current) setRecord(result) }
    catch { if (current === epoch.current) setError(t('Action outcome is unknown; check it before making another change.')) }
    finally { if (current === epoch.current) setBusy(false) }
  }
  const list = async () => {
    const current=epoch.current;setBusy(true);setError('')
    try {const result=await request('legacy-review-list',{scope});if(current===epoch.current)setCandidates(result)}
    catch {if(current===epoch.current)setError(t('Review sources are unavailable.'))}
    finally {if(current===epoch.current)setBusy(false)}
  }
  return h('details', { className:'bt-board-held' }, h('summary', null, t('Review an existing work')),
    h('p', null, t('Review notes do not send messages or close work. Sources are unverified; inspect the original records.')),
    h('p', null, t('Only works between existing Bots are currently supported.')),
    h('button', {type:'button',disabled:busy,onClick:()=>void list()},t('Find works awaiting inspection')),
    candidates?.incomplete ? h('p', {role:'status'},t('The recovery list may be incomplete.')) : null,
    Array.isArray(candidates?.items) ? h('div', null, candidates.items.map(item=>h('button', {key:item.workId,type:'button',disabled:busy,onClick:()=>{setWorkId(item.workId);setRecord(null)}},`${item.workId} · ${item.owner}`))) : null,
    h('label', null, t('Original work ID'), ' ', h('input', { value:workId, disabled:busy, onChange:event => { setWorkId(event.target.value); setRecord(null) } })), ' ',
    h('button', { type:'button', disabled:busy||!workId, onClick:() => void run('legacy-review-get', {}) }, t('Check')),
    record?.liveRecovery ? h('p', {role:'status'}, record.liveRecovery.available
      ? `${t('Recovery snapshot')} (${Number.isSafeInteger(record.liveRecovery.sampledAt) && record.liveRecovery.sampledAt>=0 && record.liveRecovery.sampledAt<=8_640_000_000_000_000 ? new Date(record.liveRecovery.sampledAt).toISOString() : t('Not known')}): ${t('Queue')}: ${recoveryObservationText(record.liveRecovery.observed.queue)} · ${t('Held records')}: ${recoveryObservationText(record.liveRecovery.observed.held)} · ${(record.liveRecovery.ids ?? []).join(', ')}`
      : t('Current recovery sources are unavailable.')) : null,
    record?.state === 'not-created' ? h('button', { type:'button', disabled:busy, onClick:() => void run('legacy-review-create', {}) }, t('Create review')) : null,
    record && record.state !== 'not-created' ? h('div', null,
      h(Fact, { label:t('Status'), value:legacyReviewStateText(record.state) }),
      h(Fact, { label:t('Owner'), value:record.owner }),
      record.archived ? h('p', {role:'status'}, t('The original work is unavailable, changed, or its identity is unverified. This record is read only and does not establish the outcome.')) : null,
      h(Fact, { label:t('Source snapshot time (UTC)'), value:Number.isSafeInteger(record.snapshot?.sampledAt) && record.snapshot.sampledAt>=0 && record.snapshot.sampledAt<=8_640_000_000_000_000 ? new Date(record.snapshot.sampledAt).toISOString() : t('Not known') }),
      h(Fact, { label:t('Original sessions'), value:(record.snapshot?.sources ?? []).map(s=>s.sessionId).join(', ') }),
      h('p', null, t('Execution and external effects remain unknown.')),
      !record.archived && ['needs-review','evidence-needed'].includes(record.state) ? h('div', null,
        h('label', null, t('Review note'), h('textarea', { value:summary, disabled:busy, onChange:event=>setSummary(event.target.value) })),
        h('label', null, t('Evidence references, one per line'), h('textarea', { value:evidence, disabled:busy, onChange:event=>setEvidence(event.target.value) })),
        h('label', null, t('Unfinished items, one per line'), h('textarea', { value:unfinished, disabled:busy, onChange:event=>setUnfinished(event.target.value) })),
        h('button', { type:'button', disabled:busy||!summary.trim(), onClick:() => void run('legacy-review-finding', { expectedRevision:record.revision, summary, evidenceRefs:evidence.split('\n').map(s=>s.trim()).filter(Boolean), unfinished:unfinished.split('\n').map(s=>s.trim()).filter(Boolean) }) }, t('Save review note'))) : null,
      (record.history ?? []).map(item=>h('article', { key:item.revision }, h(Fact, { label:t('Review note'), value:item.finding.summary }),
        h(Fact, { label:t('Evidence references'), value:item.finding.evidenceRefs.join(', ') }), h(Fact, { label:t('Unfinished items'), value:item.finding.unfinished.join(', ') })))) : null,
    error ? h('p', { role:'alert' }, error) : null)
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

function EditGoalTask({task,disabled,onEdit}) {
  const [open,setOpen]=useState(false),[base,setBase]=useState(task.revision),[title,setTitle]=useState(''),[note,setNote]=useState(''),[status,setStatus]=useState('')
  const reset=()=>{setBase(task.revision);setTitle(textValue(task.title));setNote(textValue(task.goalNote));setStatus(task.legacy?.originalStatus??'')}
  const changed=task.revision!==base,original=task.legacy?.originalStatus,paused=task.legacy?.goalStatus!=='active'
  const titleLocked=['reported','done'].includes(original)
  const next=original==='pending'?'working':original==='working'?'reported':undefined
  const statuses=[original,...(!paused&&next?[next]:[])].filter(Boolean)
  const modified=title.trim()!==textValue(task.title)||note!==textValue(task.goalNote)||status!==original
  const valid=title.trim()&&modified&&(!status||status===original||note.trim())
  if(!open)return h('button',{type:'button',disabled,onClick:()=>{reset();setOpen(true)}},t('Edit goal task'))
  return h('form',{className:'bt-board-actions',onSubmit:event=>{
    event.preventDefault();if(disabled||changed||!valid)return
    const value={}
    if(title.trim()!==textValue(task.title))value.title=title.trim()
    if(note!==textValue(task.goalNote)||status!==original)value.note=note
    if(status!==original)value.status=status
    void onEdit({...task,revision:base},value).then(result=>{if(result==='committed')setOpen(false)})
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
  const [base, setBase] = useState(task.revision)
  const changed = images.length > 0 && base !== task.revision
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
    if (!images.length) setBase(task.revision)
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
    images.length ? h('button', { type: 'button', disabled: disabled || changed, onClick: () => { void onUpload({ ...task, revision: base }, images).then(result => {
      if (result !== 'committed') return
      for (const image of images) { URL.revokeObjectURL(image.url); urls.current.delete(image.url) }
      setImages([])
    }) } }, t('Upload images')) : null)
}

function TaskCard({ scope, task, tasks, commands, actors, targets, uploadEnabled, uncertain, onCommand, onUpload, request }) {
  const dependencies = Array.isArray(task.dependencies) ? task.dependencies.map(asText).filter(Boolean) : []
  const evidence = Array.isArray(task.evidence) ? task.evidence.map(asText).filter(Boolean).join(' · ') : asText(task.evidence)
  const blocker = asText(task.blocked)
  const canMove = commands.some(command => command.type === 'personal-progress') && PERSONAL_COLUMNS.some(([id]) => id === task.personalProgress)
  const owner = scope.kind === 'personal' && scope.id === 'user' && task.owner === 'user' ? '' : actorLabel(task.owner, actors)
  return h('article', { className: 'bt-board-card', draggable: canMove && !uncertain,
    onDragStart: event => { if (canMove && !uncertain) { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('application/x-ds-bot-personal-task', task.id) } } },
    h('details', { className: 'bt-board-card-details' },
    h('summary', { className: 'bt-board-card-summary' },
      h('strong', { className: 'bt-board-title' }, textValue(task.title) || task.id),
      h('span', { className: 'bt-board-card-meta' }, owner ? h('span', { className:'bt-board-owner' }, owner) : null,
        task.shared ? h('span', { className:'bt-board-chip' }, t('Shared task · read only')) : null,
        blocker ? h('span', { className:'bt-board-chip bt-board-chip-blocked' }, t('Blocked')) : null,
        dependencies.length ? h('span', { className:'bt-board-chip' }, t('{count} dependencies', { count:dependencies.length })) : null,
        task.images?.length ? h('span', { className:'bt-board-chip' }, t('{count} images', { count:task.images.length })) : null,
        h('span', { className: 'bt-board-open-hint' }, t('View details')))),
    h('div', { className:'bt-board-card-body' },
    canMove ? h('label', { className:'bt-board-move' }, h('span', null, t('Personal progress')),
      h('select', { 'aria-label':t('Move personal task'), disabled:uncertain, value:task.personalProgress,
        onChange:event => { void onCommand(task, { type:'personal-progress' }, { progress:event.target.value }) } },
      PERSONAL_COLUMNS.map(([id,label]) => h('option', { key:id, value:id }, t(label))))) : null,
    h('span', { className: 'bt-board-id' }, task.id),
    task.legacy ? h('span', { className: 'bt-board-legacy' }, t(task.legacy.current ? 'Original group goal task' : 'Earlier group goal task · read only')) : null,
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
    !canMove ? h('span', { className:'bt-board-readonly' }, t('Status changes are not available for this task.')) : null,
    Array.isArray(task.images) && task.images.length ? h('div', { className: 'bt-board-images' }, task.images.map(image => h(BoardImage, {
      key: image.id, scope, taskId: task.id, image, request, disabled: uncertain,
      canRemove: commands.some(command => command.type === (task.legacy?'goal-image-remove':'remove-image')),
      onRemove: (_, imageId) => onCommand(task, { type: task.legacy?'goal-image-remove':'remove-image' }, { imageId }),
    }))) : null,
    uploadEnabled && commands.some(command => command.type === 'upload') ? h(UploadImages, { task, disabled: uncertain, onUpload }) : null,
    h(ShareTask, { task, commands, targets, disabled: uncertain, onCommand }),
    commands.some(command=>command.type==='goal-task-edit') ? h(EditGoalTask,{task,disabled:uncertain,onEdit:(item,value)=>onCommand(item,{type:'goal-task-edit'},value)}) : null,
    commands.some(command => command.type === 'edit') && Array.isArray(actors)
      ? h(EditTask, { task, actors, tasks, disabled: uncertain, onEdit: (item, value) => onCommand(item, { type: 'edit' }, value) })
      : !commands.some(command => ['goal-task-edit','goal-image-remove','remove-image', 'share', 'unshare'].includes(command.type) || (uploadEnabled && command.type === 'upload'))
        ? h('span', { className: 'bt-board-readonly' }, t('Read only')) : null)))
}

/** A server-authorized group or personal board. */
export function TaskBoard({ scope, title, close, request = call }) {
  const [visible, setVisible] = useState(true)
  const [snapshot, setData] = useState(null)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
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
    } catch (err) { if (current(epoch) && sequence === loadSequence.current) setError(err?.message || t('Unable to load board')) }
  }
  const settle = async (id, result, epoch) => {
    if (!current(epoch) || pendingRef.current !== id) return
    if (!finalOperation(result?.state)) {
      setError(t('Action outcome is unknown; check it before making another change.'))
      return
    }
    store.current?.clear()
    pendingRef.current = ''
    setPending('')
    if (fetching.current === id) { fetching.current = null; setBusy(false) }
    if (result.state === 'rejected') { setError(result.message ? hostText(result.message) : t('Action rejected')); await load(epoch, true) }
    else await load(epoch)
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
      if (event.key === 'Escape') { event.stopPropagation(); dismiss(); return }
      if (event.key !== 'Tab' || !dialog.current) return
      const focusable = [...dialog.current.querySelectorAll('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex="0"]')]
      if (!focusable.length) { event.preventDefault(); dialog.current.focus(); return }
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
      await request('board-upload', { scope, taskId: task.id, expectedRevision: task.revision, operationId, images: encoded })
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
  const listed = [...COLUMNS.filter(([status])=>status!=='legacy-pending'||columns.get(status).length), ...(columns.get('unknown').length ? [['unknown', 'Status unknown']] : [])]
  const card = task => h(TaskCard, { key: task.id, scope, task, tasks: data.tasks, request, onUpload: upload,
    commands: !task.shared && Array.isArray(commandMap[task.id]) ? commandMap[task.id].filter(command => command && typeof command.type === 'string') : [],
    actors: data?.capabilities?.actors, targets: data?.capabilities?.shareTargets?.[task.id], uploadEnabled: data?.capabilities?.upload === true, uncertain: !canAct, onCommand: run })
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
      hasLegacy ? h('div', { className: 'bt-board-pending', role: 'note' }, t('Group goal cards edit the original task. Earlier stages remain read only.')) : null,
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
      data ? h('div', { className:'bt-board-review-tools' }, h(HeldTurns, { recovery: data.recovery }), h(LegacyWorkReview, { scope, request }), h(RemoteChanges,{monitor:data.remoteChanges})) : null,
      !data ? h('div', { className: 'bt-board-empty' }, error ? t('Board unavailable') : t('Loading…'),
        error ? h('button', { type: 'button', onClick: () => load() }, t('Retry')) : null)
        : h('div', { className:'bt-board-content' },
        personal ? h('section', { className:'bt-board-section', 'aria-label':t('Personal progress') },
          h('div', { className:'bt-board-section-heading' }, h('h3', null, t('Personal progress')),
            h('p', null, t('Drag a card or use its progress menu.'), ' ', t('Your own progress markers do not complete shared work or unblock dependencies.'))),
          h('div', { className:'bt-board-columns bt-board-columns-personal' }, PERSONAL_COLUMNS.map(([progress,label]) => {
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
          h('div', { className: 'bt-board-columns' }, listed.map(([status, label]) => {
          const tasks = columns.get(status)
          return h('section', { className: 'bt-board-column', key: status, 'aria-label': t(label), 'data-stage':status },
            h('h3', null, h('span',null,t(label)), tasks.length ? h('span', { className:'bt-board-count' },tasks.length) : null),
            tasks.length ? tasks.map(card) : h('p', { className:'bt-board-lane-empty' },t('No tasks')))
        }))) : null))), document.body)
}

export const TASK_BOARD_CSS = `
.bt-board-launch{position:absolute;right:8px;top:7px;pointer-events:auto;-webkit-app-region:no-drag;color:var(--bt-ink-2);font:inherit;font-size:12px;background:var(--bt-card);border:1px solid var(--bt-line-2);border-radius:8px;padding:4px 8px;cursor:pointer}
.bt-board-backdrop{position:fixed;inset:0;z-index:10000;background:rgba(15,23,42,.46);display:flex;align-items:center;justify-content:center;padding:18px}
.bt-board-dialog{box-sizing:border-box;display:flex;flex-direction:column;height:min(860px,calc(100vh - 36px));max-height:calc(100vh - 36px);width:min(1440px,100%);background:var(--bt-main);color:var(--bt-ink);border:1px solid var(--bt-line);border-radius:16px;box-shadow:0 24px 70px rgba(15,23,42,.25);overflow:hidden}
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
.bt-board-review-tools{display:flex;gap:8px;flex-wrap:wrap;padding:0 24px;border-bottom:1px solid var(--bt-line);flex:none;max-height:30%;overflow:auto}
.bt-board-recovery-clear{font-size:12px;color:var(--bt-ink-2);padding:10px 0;margin:0}
.bt-board-error,.bt-board-pending{padding:10px 20px;background:var(--bt-danger-soft);font-size:13px}.bt-board-empty{padding:24px}
.bt-board-held{padding:10px 0;overflow:auto;max-height:30vh;font-size:12px}.bt-board-held summary{cursor:pointer;font-weight:600;color:var(--bt-ink-2)}.bt-board-held-record{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:8px;padding:10px 0;border-top:1px solid var(--bt-line);overflow-wrap:anywhere}
.bt-board-content{overflow:auto;min-height:0;flex:1;padding:24px 26px 28px;background:radial-gradient(ellipse at 95% 8%,color-mix(in srgb,var(--bt-accent) 25%,transparent),transparent 46%),linear-gradient(145deg,color-mix(in srgb,var(--bt-accent) 18%,var(--bt-main)),color-mix(in srgb,var(--bt-accent) 7%,var(--bt-main)) 70%)}
.bt-board-section+.bt-board-section{margin-top:32px}.bt-board-section-heading{margin:0 0 16px}.bt-board-section-heading h3{font-size:15px;font-weight:700;margin:0}.bt-board-section-heading p{font-size:12px;line-height:1.5;color:var(--bt-ink-2);margin:5px 0 0}
.bt-board-columns{display:flex;gap:12px;overflow-x:auto;overflow-y:visible;padding:2px 2px 20px;align-items:flex-start;min-height:190px}
.bt-board-column{flex:0 0 280px;min-width:0;border:1px solid color-mix(in srgb,var(--bt-ink) 9%,transparent);border-radius:14px;background:color-mix(in srgb,var(--bt-ink) 7%,var(--bt-card));padding:12px;box-sizing:border-box;box-shadow:0 4px 12px color-mix(in srgb,var(--bt-ink) 9%,transparent)}
.bt-board-columns-personal>.bt-board-column{flex:0 0 300px;min-height:150px}
.bt-board-column h3{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:13px;font-weight:700;margin:4px 4px 14px}.bt-board-count{min-width:20px;padding:2px 6px;text-align:center;background:color-mix(in srgb,var(--bt-ink) 8%,var(--bt-card));color:var(--bt-ink-2);border-radius:8px;font-size:11px;font-weight:600}
.bt-board-column h3>span:first-child{display:flex;align-items:center;gap:8px}.bt-board-column h3>span:first-child:before{content:'';width:8px;height:8px;border-radius:50%;background:var(--bt-ink-3)}
.bt-board-column:is([data-stage=doing],[data-stage=working],[data-stage=reported]) h3>span:first-child:before{background:var(--bt-accent)}
.bt-board-column:is([data-stage=finished],[data-stage=done]) h3>span:first-child:before{background:var(--bt-green)}
.bt-board-lane-empty{font-size:12px;color:var(--bt-ink-3);margin:14px 4px}.bt-board-drop-hint{display:flex;align-items:center;min-height:60px;box-sizing:border-box;border:1px dashed color-mix(in srgb,var(--bt-ink) 20%,transparent);border-radius:9px;color:var(--bt-ink-2);font-size:12px;margin:0;padding:12px}.bt-board-card{background:var(--bt-card);border:1px solid color-mix(in srgb,var(--bt-ink) 8%,transparent);border-radius:10px;margin-bottom:9px;overflow-wrap:anywhere;box-shadow:0 2px 5px color-mix(in srgb,var(--bt-ink) 12%,transparent)}
.bt-board-card[draggable=true]{cursor:grab}.bt-board-card[draggable=true]:active{cursor:grabbing}.bt-board-card:hover{border-color:var(--bt-line-2)}
.bt-board-card-details>summary{list-style:none;cursor:pointer}.bt-board-card-details>summary::-webkit-details-marker{display:none}.bt-board-card-summary{display:flex;flex-direction:column;gap:6px;padding:11px 12px}
.bt-board-card-meta{display:flex;align-items:center;gap:5px;flex-wrap:wrap}.bt-board-owner,.bt-board-chip{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border-radius:8px;background:var(--bt-tag-bg);color:var(--bt-ink-2);padding:3px 7px;font-size:11px}.bt-board-chip-blocked{color:var(--bt-danger);background:color-mix(in srgb,var(--bt-danger) 10%,var(--bt-card))}
.bt-board-open-hint{font-size:11px;color:var(--bt-ink-2);margin-left:auto}.bt-board-card-details[open] .bt-board-open-hint{display:none}.bt-board-card-body{display:flex;flex-direction:column;gap:8px;padding:0 13px 13px}.bt-board-move{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 0;border-top:1px solid var(--bt-line);font-size:12px;color:var(--bt-ink-2)}.bt-board-dialog .bt-board-move select{max-width:60%;font-size:12px;padding:4px 6px}
.bt-board-title{font-size:14px;line-height:1.4}.bt-board-id{font-size:11px;color:var(--bt-ink-3)}.bt-board-fact{display:flex;flex-direction:column;font-size:12px;gap:2px}.bt-board-fact>:first-child{color:var(--bt-ink-2)}
.bt-board-legacy{font-size:11px;color:var(--bt-ink-2)}
.bt-board-actions{display:flex;flex-direction:column;gap:8px;border-top:1px solid var(--bt-line);padding-top:8px}.bt-board-actions label{display:flex;flex-direction:column;gap:4px;font-size:12px}.bt-board-actions input{font:inherit;color:inherit;background:var(--bt-card);border:1px solid var(--bt-line-2);border-radius:8px;padding:6px 9px}.bt-board-readonly{font-size:11px;color:var(--bt-ink-3)}
.bt-board-shares{display:flex;flex-direction:column;gap:6px;font-size:12px}.bt-board-share-row{display:flex;align-items:center;justify-content:space-between;gap:6px}.bt-board-actions .bt-board-share-check{flex-direction:row;align-items:center}
.bt-board-create{display:flex;gap:10px;flex-wrap:wrap;width:100%;padding:14px;background:var(--bt-sidebar);border:1px solid var(--bt-line);border-radius:10px}.bt-board-create p{width:100%;font-size:12px;margin:0;color:var(--bt-ink-2)}.bt-board-create label{display:flex;flex-direction:column;gap:4px;font-size:12px;flex:1 1 160px}.bt-board-create>div{display:flex;align-items:flex-end;gap:6px}
.bt-board-images{display:flex;gap:6px;flex-wrap:wrap}.bt-board-photo{display:flex;flex-direction:column;gap:4px;max-width:100px;font-size:11px}.bt-board-photo img{width:92px;height:72px;object-fit:cover;border-radius:6px}.bt-board-photo button{font-size:11px;padding:3px}.bt-board-upload{display:flex;flex-direction:column;gap:6px;font-size:12px}.bt-board-upload input{width:100%;font-size:11px}
@media(max-width:600px){.bt-board-backdrop{padding:0}.bt-board-dialog{height:100%;max-height:none;border-radius:0}.bt-board-header{padding:14px 16px}.bt-board-toolbar{padding:12px 16px}.bt-board-review-tools{padding:0 16px}.bt-board-content{padding:16px}.bt-board-column,.bt-board-columns-personal>.bt-board-column{flex:0 0 min(82vw,274px)}}
`
