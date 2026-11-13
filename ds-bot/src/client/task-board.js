import { createElement as h, useEffect, useRef, useState } from 'react'
import { createPortal, flushSync } from 'react-dom'
import { call } from './api.js'
import { t } from './i18n.js'

// The server supplies already-authorized tasks; never infer membership or filter
// another actor's private tasks in the browser.
const COLUMNS = [
  ['proposed', 'Preparing'], ['waiting', 'Waiting'], ['ready', 'Ready'],
  ['working', 'In progress'], ['reported', 'Awaiting review'], ['done', 'Done'],
]
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
  if (!id || !Array.isArray(actors)) return id
  const actor = actors.find(item => item?.id === id)
  return textValue(actor?.name) || id
}

function Fact({ label, value }) {
  if (!value) return null
  return h('div', { className: 'bt-board-fact' }, h('span', null, label), h('span', null, value))
}

function DependenciesField({ tasks, value, disabled, exclude, onChange }) {
  const options = (Array.isArray(tasks) ? tasks : []).filter(task => task && !task.legacy && typeof task.id === 'string' && task.id !== exclude)
  return h('label', null, t('Dependencies'), h('select', { 'aria-label': t('Dependencies'), multiple: true, value, disabled,
    onChange: event => onChange([...event.target.selectedOptions].map(option => option.value)) },
  options.map(task => h('option', { key: task.id, value: task.id }, `${textValue(task.title) || t('Shared task')} · ${task.id}`))))
}

function CreateTask({ disabled, actors, tasks, onCreate }) {
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [owner, setOwner] = useState('')
  const [reviewer, setReviewer] = useState('')
  const [acceptance, setAcceptance] = useState('')
  const [dependencies, setDependencies] = useState([])
  const valid = title.trim() && owner.trim() && reviewer.trim() && acceptance.trim() && owner.trim() !== reviewer.trim()
  if (!open) return h('button', { type: 'button', disabled, onClick: () => setOpen(true) }, t('Propose task'))
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
      setTitle(''); setOwner(''); setReviewer(''); setAcceptance(''); setDependencies([]); setOpen(false)
    })
  } },
  h('p', null, t('A proposed task is not yet assigned or registered.')),
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
  return h('article', { className: 'bt-board-card' },
    h('strong', { className: 'bt-board-title' }, textValue(task.title) || task.id),
    h('span', { className: 'bt-board-id' }, task.id),
    task.legacy ? h('span', { className: 'bt-board-legacy' }, t('Existing group goal aggregate; child tasks not yet linked')) : null,
    task.shared ? h('span', { className: 'bt-board-legacy' }, t('Shared task · read only')) : null,
    task.legacy && !KNOWN.has(task.status) ? h(Fact, { label: t('Original status'), value: textValue(task.legacy.originalStatus) || t('Status unknown') }) : null,
    h(Fact, { label: t('Owner'), value: actorLabel(task.owner, actors) }),
    h(Fact, { label: t('Reviewer'), value: actorLabel(task.reviewer, actors) }),
    h(Fact, { label: t('Dependencies'), value: dependencies.join(' · ') }),
    h(Fact, { label: t('Next action'), value: asText(task.nextAction) }),
    h(Fact, { label: t('Blocked'), value: blocker }),
    h(Fact, { label: t('Evidence'), value: evidence }),
    h(Fact, { label: t('Target version'), value: asText(task.authority) }),
    Array.isArray(task.images) && task.images.length ? h('div', { className: 'bt-board-images' }, task.images.map(image => h(BoardImage, {
      key: image.id, scope, taskId: task.id, image, request, disabled: uncertain,
      canRemove: commands.some(command => command.type === 'remove-image'),
      onRemove: (_, imageId) => onCommand(task, { type: 'remove-image' }, { imageId }),
    }))) : null,
    uploadEnabled && commands.some(command => command.type === 'upload') ? h(UploadImages, { task, disabled: uncertain, onUpload }) : null,
    h(ShareTask, { task, commands, targets, disabled: uncertain, onCommand }),
    commands.some(command => command.type === 'edit') && Array.isArray(actors)
      ? h(EditTask, { task, actors, tasks, disabled: uncertain, onEdit: (item, value) => onCommand(item, { type: 'edit' }, value) })
      : !commands.some(command => ['remove-image', 'share', 'unshare'].includes(command.type) || (uploadEnabled && command.type === 'upload'))
        ? h('span', { className: 'bt-board-readonly' }, t('Read only')) : null)
}

/** A server-authorized group or personal board. */
export function TaskBoard({ scope, title, close, request = call }) {
  const [visible, setVisible] = useState(true)
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
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

  const current = epoch => active.current && generation.current === epoch
  const load = async (epoch = generation.current, preserveError = false) => {
    const sequence = ++loadSequence.current
    try {
      const next = await request('board-list', { scope })
      if (!current(epoch) || sequence !== loadSequence.current) return
      if (!next || !Array.isArray(next.tasks)) throw new Error(t('Invalid board response'))
      boardColumns(next.tasks)
      setData(next)
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
    if (result.state === 'rejected') { setError(result.message || t('Action rejected')); await load(epoch, true) }
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
    const operationId = window.crypto.randomUUID()
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
      operationId = window.crypto.randomUUID()
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
  const columns = boardColumns(data?.tasks)
  const listed = [...COLUMNS, ...(columns.get('unknown').length ? [['unknown', 'Status unknown']] : [])]
  if (!visible) return null
  return createPortal(h('div', { className: 'bt-board-backdrop' },
    h('section', { ref: dialog, tabIndex: -1, className: 'bt-board-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': title || t('Task board') },
      h('header', { className: 'bt-board-header' }, h('div', null, h('h2', null, title || t('Task board')),
        h('p', null, scope.kind === 'room' ? t('Group task board') : t('Personal task board')),
        showCapacity ? h('p', null, t('Instance task capacity: {count} / {limit}', { count: capacity.taskCount, limit: capacity.taskLimit })) : null),
      h('button', { type: 'button', onClick: dismiss }, t('Close'))),
      error ? h('div', { className: 'bt-board-error', role: 'alert' }, error) : null,
      capacityReached ? h('div', { className: 'bt-board-pending', role: 'status' }, t('Task limit reached. New tasks cannot be created.')) : null,
      hasLegacy ? h('div', { className: 'bt-board-pending', role: 'note' }, t('Existing group goal aggregates are read only. A new card does not automatically link to or replace them.')) : null,
      pending ? h('div', { className: 'bt-board-pending', role: 'status' }, t('An action needs confirmation.'), ' ',
        h('button', { type: 'button', disabled: cancelBusy, onClick: () => check(pending) }, t('Check action')), ' ',
        h('button', { type: 'button', disabled: cancelBusy, onClick: () => cancel(pending) }, t('Safely cancel pending request'))) : null,
      data?.capabilities?.create === true && Array.isArray(data?.capabilities?.actors) ? h(CreateTask, { disabled: !canAct || capacityReached, actors: data.capabilities.actors, tasks: data.tasks, onCreate: value => {
        if (!window.crypto?.randomUUID) return Promise.resolve(undefined)
        return run({ id: window.crypto.randomUUID() }, { type: 'create' }, value)
      } }) : null,
      !data ? h('div', { className: 'bt-board-empty' }, error ? t('Board unavailable') : t('Loading…'),
        error ? h('button', { type: 'button', onClick: () => load() }, t('Retry')) : null)
        : h('div', { className: 'bt-board-columns' }, listed.map(([status, label]) => {
          const tasks = columns.get(status)
          return h('section', { className: 'bt-board-column', key: status, 'aria-label': t(label) },
            h('h3', null, t(label), tasks.length ? ` ${tasks.length}` : ''),
            tasks.map(task => h(TaskCard, { key: task.id, scope, task, tasks: data.tasks, request, onUpload: upload,
              commands: !task.legacy && !task.shared && Array.isArray(commandMap[task.id]) ? commandMap[task.id].filter(command => command && typeof command.type === 'string') : [],
              actors: data?.capabilities?.actors, targets: data?.capabilities?.shareTargets?.[task.id], uploadEnabled: data?.capabilities?.upload === true, uncertain: !canAct, onCommand: run })))
        })))), document.body)
}

export const TASK_BOARD_CSS = `
.bt-board-launch{position:absolute;right:8px;top:7px;pointer-events:auto;-webkit-app-region:no-drag;color:var(--bt-ink-2);font:inherit;font-size:12px;background:var(--bt-card);border:1px solid var(--bt-line-2);border-radius:8px;padding:4px 8px;cursor:pointer}
.bt-board-backdrop{position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,.34);display:flex;align-items:center;justify-content:center;padding:18px}
.bt-board-dialog{box-sizing:border-box;display:flex;flex-direction:column;max-height:calc(100vh - 36px);width:min(1400px,100%);background:var(--bt-main);color:var(--bt-ink);border:1px solid var(--bt-line);border-radius:18px;box-shadow:0 16px 56px #0003;overflow:hidden}
.bt-board-header{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:18px 20px;border-bottom:1px solid var(--bt-line)}
.bt-board-header h2{font-size:18px;margin:0}.bt-board-header p{font-size:12px;color:var(--bt-ink-2);margin:4px 0 0}
.bt-board-dialog button,.bt-board-dialog select,.bt-board-dialog textarea{font:inherit;color:inherit;background:var(--bt-card);border:1px solid var(--bt-line-2);border-radius:7px;padding:6px 9px}
.bt-board-dialog button:disabled,.bt-board-dialog select:disabled{opacity:.5}.bt-board-dialog button:not(:disabled){cursor:pointer}
.bt-board-error,.bt-board-pending{padding:10px 20px;background:var(--bt-danger-soft);font-size:13px}.bt-board-empty{padding:24px}
.bt-board-columns{display:flex;gap:12px;overflow:auto;padding:16px 20px 22px;align-items:flex-start;min-height:180px}
.bt-board-column{flex:0 0 245px;min-width:0;border-radius:12px;background:var(--bt-tag-bg);padding:10px;box-sizing:border-box}
.bt-board-column h3{font-size:13px;margin:0 0 10px}.bt-board-card{display:flex;flex-direction:column;gap:7px;padding:12px;background:var(--bt-card);border:1px solid var(--bt-line);border-radius:9px;margin-bottom:8px;overflow-wrap:anywhere}
.bt-board-title{font-size:13px}.bt-board-id{font-size:11px;color:var(--bt-ink-3)}.bt-board-fact{display:flex;flex-direction:column;font-size:12px;gap:2px}.bt-board-fact>:first-child{color:var(--bt-ink-2)}
.bt-board-legacy{font-size:11px;color:var(--bt-ink-2)}
.bt-board-actions{display:flex;flex-direction:column;gap:8px;border-top:1px solid var(--bt-line);padding-top:8px}.bt-board-actions label{display:flex;flex-direction:column;gap:4px;font-size:12px}.bt-board-actions input{font:inherit;color:inherit;background:var(--bt-card);border:1px solid var(--bt-line-2);border-radius:7px;padding:6px 9px}.bt-board-readonly{font-size:11px;color:var(--bt-ink-3)}
.bt-board-shares{display:flex;flex-direction:column;gap:6px;font-size:12px}.bt-board-share-row{display:flex;align-items:center;justify-content:space-between;gap:6px}.bt-board-actions .bt-board-share-check{flex-direction:row;align-items:center}
.bt-board-create{display:flex;gap:8px;flex-wrap:wrap;padding:12px 20px;border-bottom:1px solid var(--bt-line)}.bt-board-create p{width:100%;font-size:12px;margin:0;color:var(--bt-ink-2)}.bt-board-create label{display:flex;flex-direction:column;gap:4px;font-size:12px}.bt-board-create input{font:inherit;color:inherit;background:var(--bt-card);border:1px solid var(--bt-line-2);border-radius:7px;padding:6px 9px}
.bt-board-images{display:flex;gap:6px;flex-wrap:wrap}.bt-board-photo{display:flex;flex-direction:column;gap:4px;max-width:100px;font-size:11px}.bt-board-photo img{width:92px;height:72px;object-fit:cover;border-radius:6px}.bt-board-photo button{font-size:11px;padding:3px}.bt-board-upload{display:flex;flex-direction:column;gap:6px;font-size:12px}.bt-board-upload input{width:100%;font-size:11px}
@media(max-width:600px){.bt-board-backdrop{padding:0}.bt-board-dialog{height:100%;max-height:none;border-radius:0}.bt-board-columns{flex-direction:column}.bt-board-column{width:100%;flex:0 0 auto}}
`
