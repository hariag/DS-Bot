// Decisions live at project scope. Each participating group keeps its release board.
import { createElement as h, useCallback, useEffect, useRef, useState } from 'react'
import { dateLocale, hostText, t } from './i18n.js'

function field(label, element) {
  return h('label', { className:'bt-project-field' }, h('span', null, label), element)
}

function Parties({ rooms, ids, fixed, onChange }) {
  return h('fieldset', { className:'bt-project-parties' },
    h('legend', null, t('Participating groups')),
    rooms.map(room => h('label', { key:room.id }, h('input', {
      type:'checkbox', checked:ids.includes(room.id), disabled:fixed.includes(room.id),
      onChange:event => onChange(event.target.checked ? [...ids, room.id] : ids.filter(id => id !== room.id)),
    }), room.name)))
}

const fieldLabels = {
  title:'Title', description:'Description', owner:'Owner', reviewer:'Reviewer', acceptance:'Acceptance criteria',
  status:'Status', scope:'Group chat', stage:'Work stage', releaseId:'Release', progress:'Progress',
  blocked:'Blocked', archivedAt:'Archived', dependencies:'Dependencies', checklist:'Checklist', labels:'Labels',
  dueDate:'Due date', boardActivity:'Activity', parentTaskId:'Parent card', created:'Created',
  'release.version':'Version', 'release.status':'Status', 'release.name':'Name',
}

export function ProjectEvent({ row, roomId, roomName, card, release, actorName, openCard, visitSource }) {
  const related = row.taskId && row.originRoomId !== roomId && visitSource && row.originRoomId
    ? () => visitSource(row.originRoomId, roomName(row.originRoomId), row.taskId)
    : card && (() => openCard(card.id))
  const title = row.kind === 'task' && row.changedFields?.length
    ? t('Updated') + ' · ' + row.changedFields.map(key => t(fieldLabels[key] ?? key)).join(', ')
    : row.summary
  const facts = [row.resource, roomName(row.originRoomId), row.owner && actorName(row.owner),
    release?.name ?? row.releaseId, row.releaseVersion, row.status, row.stage].filter(Boolean)
  const receipts = row.acknowledgements ?? []
  const acknowledgements = (row.audience ?? []).map(id => {
    const received = receipts.filter(ack => ack.roomId === id)
    if (!received.length) return t('Awaiting acknowledgement from {group}', {group:roomName(id)})
    const people = received.map(ack => actorName(ack.actor) + ' ' + new Date(ack.at).toLocaleString(dateLocale()))
    return t('Acknowledged by {group}', {group:roomName(id)}) + ' (' + people.join(', ') + ')'
  })
  return h('li', null, h('strong', null, '#', row.revision, ' ', title), h('div', null, facts.join(' · ')),
    row.taskId && (related
      ? h('button', {type:'button', className:'bt-card-mini', onClick:related}, card?.title || row.taskId)
      : h('code', null, row.taskId)),
    h('div', null, acknowledgements.join(' · ')),
    h('small', null, actorName(row.actor), ' · ', new Date(row.createdAt).toLocaleString(dateLocale())))
}

export function ProjectCoordinationPanel({ scope, request, tasks, releases, actorName, openCard, visitSource }) {
  const roomId = scope.id
  const [data, setData] = useState(null)
  const [draft, setDraft] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const key = 'ds-bot:project-operation:' + roomId
  const [pending, setPending] = useState(() => { try { return window.sessionStorage.getItem(key) } catch { return null } })
  const generation = useRef(0)
  const lock = useRef(false)
  const read = useCallback(async (beforeRevision, operationId) => {
    const seq = ++generation.current
    const next = await request('board-project', { scope:{kind:'room', id:roomId}, beforeRevision, operationId })
    if (seq !== generation.current) return null
    if (!next || !Array.isArray(next.events)) throw Error(t('Invalid board response'))
    setData(prev => beforeRevision && prev?.project?.id === next.project?.id
      ? { ...next, events:[...new Map([...prev.events, ...next.events].map(row => [row.revision,row])).values()] } : next)
    return next
  }, [roomId, request])
  const load = page => { setError(''); return read(page).catch(e => setError(hostText(e.message))) }
  useEffect(() => {
    let active = true
    read().catch(e => { if (active) setError(hostText(e.message)) })
    const refresh = () => {
      if (document.visibilityState === 'visible' && !lock.current) read().catch(e => { if (active) setError(hostText(e.message)) })
    }
    document.addEventListener('visibilitychange',refresh)
    const timer = window.setInterval(refresh, 30000)
    return () => {
      active = false; generation.current++
      document.removeEventListener('visibilitychange',refresh)
      window.clearInterval(timer)
    }
  }, [read])
  const project = data?.project
  const roomName = id => [...(project?.rooms ?? []), ...(data?.availableRooms ?? [])].find(r => r.id === id)?.name ?? id
  const fieldChange = (key, value) => setDraft(prev => ({ ...prev, [key]:value }))
  const start = mode => {
    setNotice(''); setError('')
    setDraft({ mode, expectedRevision:project?.revision ?? 0, projectId:project?.id ?? '', name:project?.name ?? '',
      roomIds:project?.rooms.map(r => r.id) ?? [roomId], resource:'', summary:'', taskId:'' })
  }
  const clearPending = () => { window.sessionStorage.removeItem(key); setPending(null) }
  const confirm = async () => {
    if (lock.current || !pending) return
    lock.current = true; setBusy(true); setError('')
    try {
      const result = await read(undefined, pending)
      if (!result) return
      if (result.receipt?.operationId === pending) {
        clearPending(); setDraft(null); setNotice(t('Saved.'))
      } else if (result.receipt === null) {
        clearPending(); setNotice(t('No receipt found. Review the current revision before retrying.'))
      } else throw Error(t('Invalid board response'))
    } catch (e) { setError(hostText(e.message)) }
    finally { lock.current=false; setBusy(false) }
  }
  const submit = async event => {
    event.preventDefault()
    if (!draft || lock.current || pending || draft.expectedRevision !== (project?.revision ?? 0)) return
    lock.current = true; setBusy(true); setError(''); setNotice('')
    try {
      const binding = draft.mode === 'binding'
      const body = { scope:{kind:'room',id:roomId}, expectedRevision:draft.expectedRevision, roomIds:[...draft.roomIds].sort() }
      if (binding) Object.assign(body,{ projectId:draft.projectId.trim(), name:draft.name.trim(), coordinatorRoomId:project?.coordinatorRoomId ?? roomId })
      else Object.assign(body,{ resource:draft.resource.trim(), summary:draft.summary.trim(), ...(draft.taskId ? {taskId:draft.taskId} : {}) })
      const endpoint = binding ? 'board-project-bind' : 'board-project-decide'
      const bytes = await window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([endpoint, body])))
      const operationId = 'web-project-' + [...new Uint8Array(bytes)].map(n => n.toString(16).padStart(2,'0')).join('')
      window.sessionStorage.setItem(key, operationId); setPending(operationId)
      const receipt = await request(endpoint, { ...body, operationId })
      if (receipt?.operationId !== operationId) throw Error(t('Decision outcome is unknown. Refresh before trying again.'))
      clearPending(); setDraft(null); setNotice(t('Saved.')); await read()
    } catch (e) {
      if (['bot/refused','bot/invalid','bot/read-only','bot/not-found','bot/conflict'].includes(e.code)) {
        clearPending(); await read().catch(() => {})
      }
      setError(hostText(e.message))
    } finally { lock.current=false; setBusy(false) }
  }
  const changed = draft && draft.expectedRevision !== (project?.revision ?? 0)
  return h('section', { className:'bt-board-section bt-project', 'aria-label':t('Project coordination') },
    h('div', {className:'bt-card-editor-actions'}, h('strong', null, project?.name ?? t('Project coordination')),
      h('button', {type:'button', className:'bt-card-mini', disabled:busy, onClick:() => load()}, t('Refresh'))),
    error && h('div', {role:'alert',className:'bt-board-error'},error),
    notice && h('div', {role:'status'},notice),
    pending && h('div', {className:'bt-board-pending'}, t('Decision outcome may be unknown. Refresh to verify it.'), ' ',
      h('button', {type:'button', className:'bt-card-mini', disabled:busy, onClick:confirm},t('Check action'))),
    !data && !error && h('span',null,t('Loading…')),
    data && h('p',null,project
      ? [project.id, t('Revision')+' '+project.revision, t('Coordinating group')+' '+roomName(project.coordinatorRoomId), project.rooms.map(r=>r.name).join(' / ')].join(' · ')
      : t('This group has no shared project yet.')),
    data && !draft && h('div', {className:'bt-card-editor-actions'},
      project && h('button',{type:'button',className:'bt-btn bt-btn-primary',disabled:!!pending,onClick:()=>start('decision')},t('Record a decision')),
      (!project || project.coordinatorRoomId === roomId) && h('button',{type:'button',className:'bt-btn bt-btn-ghost',disabled:!!pending,onClick:()=>start('binding')},t('Link project groups'))),
    draft && h('form',{onSubmit:submit,className:'bt-project-editor'},
      draft.mode === 'binding' ? h('div',null,
        field(t('Project ID'),h('input',{required:true,disabled:!!project,value:draft.projectId,onChange:e=>fieldChange('projectId',e.target.value)})),
        field(t('Name'),h('input',{required:true,disabled:!!project,value:draft.name,onChange:e=>fieldChange('name',e.target.value)})),
        h('p',null,t('Selected groups can read shared decisions and linked task updates.')))
        : h('div',null,
          field(t('Shared resource'),h('input',{required:true,list:'bt-project-resources-'+roomId,value:draft.resource,onChange:e=>fieldChange('resource',e.target.value)})),
          h('datalist',{id:'bt-project-resources-'+roomId},[...new Set(data.events.map(row=>row.resource).filter(Boolean))].map(resource=>h('option',{key:resource,value:resource}))),
          field(t('Decision'),h('textarea',{required:true,rows:3,value:draft.summary,onChange:e=>fieldChange('summary',e.target.value)})),
          field(t('Linked task'),h('select',{value:draft.taskId,onChange:e=>fieldChange('taskId',e.target.value)},
            h('option',{value:''},t('None')),tasks.filter(t=>!t.shared && !t.legacy && !t.archivedAt).map(t=>h('option',{key:t.id,value:t.id},t.title || t.id))))),
      h(Parties,{rooms:draft.mode === 'binding' ? data.availableRooms : project.rooms,ids:draft.roomIds,fixed:draft.mode==='binding' ? project?.rooms.map(r=>r.id) ?? [roomId] : [roomId],onChange:ids=>fieldChange('roomIds',ids)}),
      changed && h('button',{type:'button',className:'bt-card-mini',onClick:()=>fieldChange('expectedRevision',project?.revision ?? 0)},t('Use reviewed revision {revision}',{revision:project?.revision ?? 0})),
      h('div',{className:'bt-card-editor-actions'},
        h('button',{type:'submit',className:'bt-btn bt-btn-primary',disabled:busy || !!pending || !!changed},t('Save')),
        h('button',{type:'button',className:'bt-btn bt-btn-ghost',disabled:busy,onClick:()=>setDraft(null)},t('Cancel')))),
    project && h('ol', {className:'bt-project-events'}, data.events.map(row =>
      h(ProjectEvent, {key:row.revision, row, roomId, roomName, actorName, openCard, visitSource,
        card:tasks.find(task => task.id === row.taskId), release:releases.find(release => release.id === row.releaseId)}))),
    data?.nextBeforeRevision ? h('button', {type:'button', className:'bt-card-mini', onClick:() => load(data.nextBeforeRevision)}, t('Show more')) : null)
}
