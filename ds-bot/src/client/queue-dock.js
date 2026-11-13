import { createElement as h, Fragment, useEffect, useId, useMemo, useRef, useState } from 'react'
import { t } from './i18n.js'
import { ArrowUpIcon, CheckIcon, ChevronDownIcon, ChevronUpIcon, CloseIcon, PaperclipIcon, PencilIcon, QueueIcon, TrashIcon } from './icons.js'

// The queue dock above the composer, drawn by DS Bot in place of the shell's own
// (same slot, same id 'queue'). The session inbox also queues the team's mail —
// requests, replies and reports a delivery sends with agent.followup arrive as
// kind 'bot' — but they are the Bot's incoming messages, not drafts of the user.
// The shell's dock draws every queued row as the user's own: a relay looked
// typed, and one tap on its edit, delete or steer controls rewrote or dropped a
// team's exchange (#663). Bot deliveries are displayed separately as read-only
// items, while only the user's own queued sends have actions.

// Kinds carrying the user's own queued sends: composer submissions, scheduled
// sends and an answer filed through a question card.
const OWN_QUEUE_KINDS = new Set(['user', 'schedule', 'user-question-reply'])

const EMPTY_QUEUE = []
const QUEUE_TEXT_FACTS = { collapseWhitespace: true, trimWhitespace: true }

const textOf = content => (content.every(block => block.type === 'text') ? content.map(block => block.text).join('') : null)

// Durable references carried by one queued row. Inbox projections are wire data,
// so a block without a reference is skipped rather than trusted.
function queueAttachments(content) {
  const attachments = []
  for (const block of content) {
    if (block.type === 'image' || block.type === 'file') {
      if (block.attachment !== undefined) attachments.push({ type: block.type, attachment: block.attachment })
    }
  }
  return attachments
}

const fileSizeText = (bytes) => typeof bytes !== 'number' || !Number.isFinite(bytes) ? ''
  : bytes < 1024 ? `${bytes} B`
    : bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KB`
      : `${(bytes / 1048576).toFixed(1)} MB`

function QueueFile({ attachment, label }) {
  const size = fileSizeText(attachment.bytes)
  return h('span', { className: 'bt-queue-file', 'aria-label': label, title: attachment.name },
    h('span', { className: 'bt-queue-fileicon', 'aria-hidden': true }, h(PaperclipIcon)),
    h('span', { className: 'bt-queue-filename' }, attachment.name),
    size !== '' ? h('span', { className: 'bt-queue-filesize' }, size) : null)
}

// One durable queued image as a fixed-size thumbnail; a load failure keeps the
// empty placeholder.
function QueueThumb({ attachment, loadImage, label }) {
  const [url, setUrl] = useState(null)
  useEffect(() => {
    let alive = true
    loadImage(attachment).then((resolved) => { if (alive) setUrl(resolved) }, () => {})
    return () => { alive = false }
  }, [attachment, loadImage])
  return url === null
    ? h('span', { className: 'bt-queue-thumb', 'aria-hidden': true })
    : h('img', { className: 'bt-queue-thumb', src: url, alt: label })
}

// The row's content in the plain-text preview the dock draws; the user-text
// factory renders it when the shell provides one.
function Preview({ text, renderFactorySlot }) {
  const rendered = renderFactorySlot?.('conversation.user.text', { text, facts: QUEUE_TEXT_FACTS, interactive: false, ellipsis: true })
  return h('span', { className: 'bt-queue-preview' }, rendered ?? text)
}

function EditField({ text, onChange, onSave, onCancel }) {
  const field = useRef(null)
  useEffect(() => {
    const node = field.current
    if (node === null) return
    node.focus()
    node.style.height = 'auto'
    node.style.height = `${node.scrollHeight}px`
  }, [text])
  return h('textarea', {
    ref: field,
    className: 'bt-queue-edit',
    value: text,
    rows: 1,
    'aria-label': t('Edit queued message'),
    onChange: event => onChange(event.target.value),
    onKeyDown: (event) => {
      if (event.key === 'Escape') { event.stopPropagation(); onCancel() }
      else if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); onSave() }
    },
  })
}

function RowButton({ label, title, disabled, onClick, children }) {
  return h('button', { type: 'button', className: 'bt-queue-action', 'aria-label': label, title: title ?? label, disabled, onClick }, children)
}

// Host snapshots and the DSH projection are independent reads. Preserve every
// identifiable row, but never turn a changing or unidentifiable snapshot into
// an exact count. Same-part rows match by message ID; different parts by exchange ID.
export function combineRoomPosts(projection, host, sessionId, available) {
  const observed = projection.map(({ row }) => ({ sessionId, messageId: typeof row.id === 'string' && row.id !== '' ? row.id : undefined, exchangeId: typeof row.source?.exchangeId === 'string' && row.source.exchangeId !== '' ? row.source.exchangeId : undefined, row }))
  const hostRows = host?.rows ?? []
  const hostCurrent = hostRows.filter(item => item.sessionId === sessionId)
  const projIds = new Set(observed.map(item => item.messageId).filter(Boolean))
  const hostIds = new Set(hostCurrent.map(item => item.messageId).filter(Boolean))
  let uncertain = !available || host?.unavailable !== false || observed.some(item => !item.messageId) || hostCurrent.some(item => !item.messageId)
  if (projIds.size !== hostIds.size || [...projIds].some(id => !hostIds.has(id))) uncertain = true
  const rows = []
  const identities = new Map()
  const byMessage = new Map()
  // Earliest two distinct Sessions for each exchange suffice to find the
  // earliest match that is not in the incoming Session.
  const byExchange = new Map()
  for (const item of [...observed, ...hostRows]) {
    if (!item.messageId) uncertain = true
    else {
      const key = JSON.stringify([item.sessionId, item.messageId])
      if (identities.has(key) && identities.get(key) !== item.exchangeId) uncertain = true
      else identities.set(key, item.exchangeId)
    }
    const messageKey = item.messageId ? JSON.stringify([item.sessionId, item.messageId]) : undefined
    const ownIndex = messageKey === undefined ? undefined : byMessage.get(messageKey)
    const exchange = item.exchangeId ? byExchange.get(item.exchangeId) : undefined
    const otherIndex = exchange === undefined ? undefined : exchange.first.sessionId === item.sessionId ? exchange.second?.index : exchange.first.index
    // Both indexes refer to retained rows. The smaller index matches the old
    // first-match semantics if both a same-part and a cross-part match exist.
    const sameIndex = ownIndex === undefined ? otherIndex : otherIndex === undefined ? ownIndex : Math.min(ownIndex, otherIndex)
    if (sameIndex !== undefined) continue
    const index = rows.push(item) - 1
    if (messageKey !== undefined) byMessage.set(messageKey, index)
    if (item.exchangeId) {
      const entry = { index, sessionId: item.sessionId }
      if (exchange === undefined) byExchange.set(item.exchangeId, { first: entry })
      else if (exchange.first.sessionId !== item.sessionId && exchange.second === undefined) exchange.second = entry
    }
  }
  const sessions = new Set(rows.map(item => item.sessionId))
  if (sessions.size > 1 && rows.some(item => !item.exchangeId)) uncertain = true
  return { rows, uncertain }
}

// One item renders directly; several default to a collapsible count header; an
// empty queue renders nothing. Rows still in flight show a sending state with
// disabled actions until their queue rows arrive.
export function QueueDock({ sessionId, useSession, useProjection, useRoster, useWork, updateQueue, loadImage, renderFactorySlot, actions }) {
  const inbox = useProjection?.('inbox')
  const botId = useRoster?.(roster => roster.byId?.[sessionId]?.id) ?? null
  const roomId = useRoster?.(roster => roster.roomsById?.[sessionId]?.id) ?? null
  const isRoom = roomId !== null
  const roomStateJson = useWork?.(work => JSON.stringify({ posts: work.roomPostQueues?.[roomId] ?? { rows: [], unavailable: true }, pending: work.roomPending?.[roomId] ?? { relay: 0, next: 0 } })) ?? '{}'
  const roomState = useMemo(() => JSON.parse(roomStateJson), [roomStateJson])
  const groupQueueJson = useWork?.(work => JSON.stringify(work.groupQueues?.[botId] ?? [])) ?? '[]'
  const groupQueue = useMemo(() => JSON.parse(groupQueueJson), [groupQueueJson])
  const earlierPrivateJson = useWork?.(work => JSON.stringify(work.earlierPrivateQueues?.[botId] ?? [])) ?? '[]'
  const earlierPrivateItems = useMemo(() => JSON.parse(earlierPrivateJson), [earlierPrivateJson])
  const groupPending = groupQueue.filter(item => !item.unavailable).length
  const groupUnknown = groupQueue.some(item => item.unavailable)
  const inboxAvailable = Array.isArray(inbox?.['next-step']) && Array.isArray(inbox?.['next-turn'])
  const pendingSubmissions = useSession?.((s) => s.pendingSubmissions) ?? EMPTY_QUEUE
  const queue = useMemo(() => {
    const rows = (inbox?.['next-turn'] ?? EMPTY_QUEUE).filter(row => OWN_QUEUE_KINDS.has(row.source?.kind))
    const inChat = new Set(pendingSubmissions.filter(item => item.placement === 'transcript').map(item => item.requestId))
    return inChat.size === 0 ? rows : rows.filter(({ source }) => source === null || typeof source !== 'object' || !('rpcId' in source) || !inChat.has(source.rpcId))
  }, [inbox, pendingSubmissions])
  const pendingQueue = useMemo(() => {
    const admitted = new Set(queue.flatMap(({ source }) => (source !== null && typeof source === 'object' && 'rpcId' in source) ? [source.rpcId] : []))
    return pendingSubmissions.filter(submission => submission.placement === 'queued' && !admitted.has(submission.requestId))
  }, [pendingSubmissions, queue])
  const rowCount = queue.length + pendingQueue.length
  const allBotQueue = useMemo(() => [
    ...(inbox?.['next-step'] ?? EMPTY_QUEUE).filter(row => row.source?.kind === 'bot').map(row => ({ row, placement: 'next-step' })),
    ...(inbox?.['next-turn'] ?? EMPTY_QUEUE).filter(row => row.source?.kind === 'bot').map(row => ({ row, placement: 'next-turn' })),
  ], [inbox])
  const roomPosts = isRoom ? allBotQueue.filter(({ row }) => row.source?.role === 'post') : EMPTY_QUEUE
  const roomJoined = combineRoomPosts(roomPosts, roomState.posts, sessionId, inboxAvailable)
  const roomUnknown = isRoom && roomJoined.uncertain
  const roomPostCount = roomJoined.rows.length
  const roomRelayCount = roomState.pending?.relay ?? 0
  const roomNextCount = roomState.pending?.next ?? 0
  const botQueue = isRoom ? allBotQueue.filter(({ row }) => row.source?.role !== 'post') : allBotQueue
  const earlierPrivate = useMemo(() => {
    const present = new Set(botQueue.map(({ row }) => row.source?.exchangeId).filter(Boolean))
    return earlierPrivateItems.filter(item => !item.exchangeId || !present.has(item.exchangeId))
  }, [botQueue, earlierPrivateItems])
  const privatePending = botQueue.length + earlierPrivate.filter(item => !item.unavailable).length
  const privateUnknown = (botId !== null && !inboxAvailable) || earlierPrivate.some(item => item.unavailable)
  // A partial snapshot is not a reliable total (or even a numeric lower bound).
  // Keep its uncertainty explicit whenever a real queued row makes the panel visible.
  const botTitle = [
    privatePending > 0 && (privateUnknown ? t('Bot private messages waiting; count unavailable') : t('Bot private {n}', { n: privatePending })),
    groupPending > 0 && (groupUnknown ? t('Group messages waiting; count unavailable') : t('Group {n}', { n: groupPending })),
  ].filter(Boolean).join(' + ')
  const roomPendingTitle = [
    roomRelayCount > 0 && t('Relay waiting items: {n}', { n: roomRelayCount }),
    roomNextCount > 0 && t('Next-round items: {n}', { n: roomNextCount }),
  ].filter(Boolean).join(' · ')
  const roomTitle = [
    roomPostCount > 0 && (roomUnknown ? t('Group posts awaiting dispatch; count unavailable') : t('Group posts awaiting dispatch: {n}', { n: roomPostCount })),
    roomPendingTitle,
  ].filter(Boolean).join(' · ')
  const [botExpandedSession, setBotExpandedSession] = useState(null)
  const botCollapsed = botExpandedSession !== sessionId
  const botListId = useId()
  const roomListId = useId()
  useEffect(() => { setBotExpandedSession(null) }, [sessionId])
  useEffect(() => {
    if (botTitle === '' && (!isRoom || roomTitle === '') && !botCollapsed) setBotExpandedSession(null)
  }, [botTitle, roomTitle, isRoom, botCollapsed])
  const running = useSession?.((s) => s.running) === true
  const queueMutable = useSession?.((s) => s.subagent === null || s.subagent === undefined || s.subagent.address?.mode === 'continuable') ?? true
  const [editing, setEditing] = useState(null)
  const [busy, setBusy] = useState(null)
  const [collapsed, setCollapsed] = useState(true)
  const listId = useId()
  useEffect(() => {
    if (rowCount === 0 && !collapsed) setCollapsed(true)
    if (editing !== null && (!queueMutable || !queue.some(row => row.id === editing.id))) setEditing(null)
  }, [collapsed, editing, queue, queueMutable, rowCount])
  if (rowCount === 0 && botTitle === '' && (!isRoom || roomTitle === '')) return null
  const interactionActive = queueMutable && (editing !== null || busy !== null)
  const expanded = !collapsed || interactionActive
  const listVisible = rowCount === 1 || expanded
  const applyAction = async (itemId, action, failure) => {
    setBusy(itemId)
    try {
      const result = await updateQueue(itemId, action)
      // A row the Agent already claimed converges by itself — it left the queue,
      // or goes with the next turn either way.
      if (result && result.ok === false
        && result.error?.code !== 'session/queue-item-not-found'
        && result.error?.code !== 'session/steer-unavailable') {
        actions.reportError(new Error(failure), 'queue')
        return false
      }
      return true
    } catch {
      actions.reportError(new Error(failure), 'queue')
      return false
    } finally {
      setBusy(current => current === itemId ? null : current)
    }
  }
  const saveEdit = async () => {
    if (editing === null || editing.text.trim() === '') return
    if (await applyAction(editing.id, { kind: 'edit', content: [{ type: 'text', text: editing.text }] }, t('Couldn’t edit the queued message — it may have started already.'))) setEditing(null)
  }
  return h('div', { className: 'bt-queue-dock', 'data-queue-dock': '' },
    isRoom && roomTitle !== '' && h('div', { className: 'bt-queue-panel bt-bot-queue-panel', 'data-room-post-queue-dock': '' },
      h('button', { type: 'button', className: 'bt-queue-head', 'aria-controls': roomListId, 'aria-expanded': !botCollapsed, onClick: () => setBotExpandedSession(value => value === sessionId ? null : sessionId) },
        h('span', { className: 'bt-queue-lead', 'aria-hidden': true }, h(QueueIcon)),
        h('span', { className: 'bt-queue-count' }, roomTitle),
        h('span', { className: 'bt-queue-chev', 'aria-hidden': true }, !botCollapsed ? h(ChevronDownIcon) : h(ChevronUpIcon))),
      (roomRelayCount > 0 || roomNextCount > 0) && h('div', { className: 'bt-bot-queue-row' }, t('Counts exclude items in transfer and may include control events.')),
      h('ul', { id: roomListId, className: 'bt-queue-list bt-bot-queue-list', 'data-room-post-queue-list': '', hidden: botCollapsed },
        roomUnknown && h('li', { className: 'bt-bot-queue-row' }, t('Group queue snapshot is incomplete or changing.')),
        roomPendingTitle !== '' && h('li', { className: 'bt-bot-queue-row' }, roomPendingTitle),
        h('li', { className: 'bt-bot-queue-row' }, t('Counts exclude items in transfer and may include control events.')),
        !botCollapsed && roomJoined.rows.map((item, index) => {
          const row = item.row
          if (row === undefined) return h('li', { key: `${item.sessionId}:${item.id}:${index}`, className: 'bt-bot-queue-row', 'data-room-post-queue-row': '' },
            h('div', { className: 'bt-bot-queue-meta' }, h('span', { className: 'bt-bot-queue-sender' }, item.senderName || t('Bot'))),
            item.attachments > 0 && h('div', null, t('Attachments: {n}', { n: item.attachments })),
            item.text && h('div', { className: 'bt-bot-queue-text' }, item.text))
          const text = row.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
          const attachments = queueAttachments(row.content)
          return h('li', { key: `${item.sessionId}:${item.messageId ?? index}`, className: 'bt-bot-queue-row', 'data-room-post-queue-row': '' },
            h('div', { className: 'bt-bot-queue-meta' }, h('span', { className: 'bt-bot-queue-sender' }, row.source?.senderName || t('Bot'))),
            attachments.length > 0 && h('span', { className: 'bt-queue-attachments' }, attachments.map((attachment, position) => attachment.type === 'image'
              ? h(QueueThumb, { key: position, attachment: attachment.attachment, loadImage, label: t('Queued image') })
              : h(QueueFile, { key: position, attachment: attachment.attachment, label: t('Queued file {name}', { name: attachment.attachment.name }) }))),
            text && h('div', { className: 'bt-bot-queue-text' }, text.length > 400 ? `${text.slice(0, 400)}…` : text))
        }))),
    botTitle !== '' && h('div', { className: 'bt-queue-panel bt-bot-queue-panel', 'data-bot-queue-dock': '' },
      h('button', { type: 'button', className: 'bt-queue-head', 'data-bot-queue-head': '', 'aria-controls': botListId, 'aria-expanded': !botCollapsed, onClick: () => setBotExpandedSession(value => value === sessionId ? null : sessionId) },
        h('span', { className: 'bt-queue-lead', 'aria-hidden': true }, h(QueueIcon)),
        h('span', { className: 'bt-queue-count' }, botTitle),
        h('span', { className: 'bt-queue-chev', 'aria-hidden': true }, !botCollapsed ? h(ChevronDownIcon) : h(ChevronUpIcon))),
      h('ul', { id: botListId, className: 'bt-queue-list bt-bot-queue-list', 'data-bot-queue-list': '', hidden: botCollapsed },
        !botCollapsed && botQueue.map(({ row, placement }) => {
          const attachments = queueAttachments(row.content)
          const text = row.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
          return h('li', { key: row.id, className: 'bt-bot-queue-row', 'data-bot-queue-row': '', 'data-bot-queue-placement': placement },
            h('div', { className: 'bt-bot-queue-meta' },
              h('span', { className: 'bt-bot-queue-sender' }, row.source?.senderName || t('Bot')),
              h('span', { className: 'bt-bot-queue-placement' }, t(placement === 'next-step' ? 'Next step' : 'Next turn'))),
            attachments.length > 0 && h('span', { className: 'bt-queue-attachments bt-bot-queue-attachments' },
              attachments.map((item, index) => item.type === 'image'
                ? h(QueueThumb, { key: `${item.attachment.attachmentId}:${index}`, attachment: item.attachment, loadImage, label: t('Queued image') })
                : h(QueueFile, { key: `${item.attachment.attachmentId}:${item.attachment.name}:${index}`, attachment: item.attachment, label: t('Queued file {name}', { name: item.attachment.name }) }))),
            text !== '' && h('div', { className: 'bt-bot-queue-text' }, text))
        }),
        !botCollapsed && privateUnknown && !inboxAvailable && h('li', { className: 'bt-bot-queue-row' }, t('Private inbox unavailable')),
        !botCollapsed && earlierPrivate.map(item => h('li', { key: item.id, className: 'bt-bot-queue-row', 'data-bot-earlier-private-queue-row': '' },
          h('div', { className: 'bt-bot-queue-meta' },
            h('span', { className: 'bt-bot-queue-sender' }, item.senderName || t('Bot')),
            h('span', { className: 'bt-bot-queue-placement' }, item.unavailable ? t('Private inbox unavailable') : t('Earlier conversation'))),
          item.text && h('div', { className: 'bt-bot-queue-text' }, item.text))),
        !botCollapsed && groupQueue.map(item => h('li', { key: `${item.roomId}:${item.id}`, className: 'bt-bot-queue-row', 'data-bot-group-queue-row': '' },
          h('div', { className: 'bt-bot-queue-meta' },
            h('span', { className: 'bt-bot-queue-sender' }, item.roomName || t('Group')),
            h('span', { className: 'bt-bot-queue-placement' }, item.unavailable ? t('Group inbox unavailable') : item.previous ? t('Earlier conversation') : item.senderName)),
          item.text && h('div', { className: 'bt-bot-queue-text' }, item.text))))),
    rowCount > 0 && h('div', { className: 'bt-queue-panel' },
      rowCount > 1 && h('button', { type: 'button', className: 'bt-queue-head', 'aria-controls': listId, 'aria-expanded': expanded, disabled: interactionActive, onClick: () => setCollapsed(value => !value) },
        h('span', { className: 'bt-queue-lead', 'aria-hidden': true }, h(QueueIcon)),
        h('span', { className: 'bt-queue-count' }, t('{n} queued messages', { n: rowCount })),
        !listVisible && pendingQueue.length > 0 && h('span', { className: 'bt-queue-status', role: 'status' }, t('Sending…')),
        h('span', { className: 'bt-queue-chev', 'aria-hidden': true }, expanded ? h(ChevronDownIcon) : h(ChevronUpIcon))),
      h('ul', { id: listId, className: 'bt-queue-list', hidden: !listVisible },
        listVisible && queue.map((row) => {
          const attachments = queueAttachments(row.content)
          const text = textOf(row.content)
          return h('li', { key: row.id, className: 'bt-queue-row' },
            rowCount === 1 && h('span', { className: 'bt-queue-lead', 'aria-hidden': true }, h(QueueIcon)),
            editing?.id === row.id
              ? h(EditField, { text: editing.text, onChange: text => setEditing({ id: row.id, text }), onSave: saveEdit, onCancel: () => setEditing(null) })
              : h(Fragment, null,
                attachments.length > 0 && h('span', { className: 'bt-queue-attachments' },
                  attachments.map((item, index) => item.type === 'image'
                    ? h(QueueThumb, { key: `${item.attachment.attachmentId}:${index}`, attachment: item.attachment, loadImage, label: t('Queued image') })
                    : h(QueueFile, { key: `${item.attachment.attachmentId}:${item.attachment.name}:${index}`, attachment: item.attachment, label: t('Queued file {name}', { name: item.attachment.name }) }))),
                h(Preview, { text: row.content.filter(block => block.type === 'text').map(block => block.text).join(''), renderFactorySlot })),
            queueMutable && h('div', { className: 'bt-queue-actions' },
              editing?.id === row.id
                ? h(Fragment, null,
                  h(RowButton, { label: t('Save queued message'), disabled: busy !== null || editing.text.trim() === '', onClick: saveEdit }, h(CheckIcon)),
                  h(RowButton, { label: t('Cancel editing'), disabled: busy !== null, onClick: () => setEditing(null) }, h(CloseIcon)))
                : h(Fragment, null,
                  h(RowButton, { label: t('Edit queued message'), title: text === null ? t('Contains non-text content, so editing is not supported yet') : undefined, disabled: busy !== null || text === null, onClick: () => { if (text !== null) setEditing({ id: row.id, text }) } }, h(PencilIcon)),
                  h(RowButton, { label: t('Delete queued message'), disabled: busy !== null, onClick: () => applyAction(row.id, { kind: 'remove' }, t('Couldn’t delete the queued message — it may have started already.')) }, h(TrashIcon)),
                  h(RowButton, { label: t('Steer queued message'), title: running ? undefined : t('Only while a turn is running'), disabled: busy !== null || !running, onClick: () => applyAction(row.id, { kind: 'steer' }, t('Couldn’t steer the queued message. Try again.')) }, h(ArrowUpIcon)))))
        }),
        listVisible && pendingQueue.map(submission => h('li', { key: submission.requestId, className: 'bt-queue-row bt-queue-pending' },
          rowCount === 1 && h('span', { className: 'bt-queue-lead', 'aria-hidden': true }, h(QueueIcon)),
          submission.attachments.length > 0 && h('span', { className: 'bt-queue-attachments' },
            submission.attachments.map((attachment, index) => attachment.type === 'image'
              ? h('img', { key: `${attachment.value.previewUrl}:${index}`, className: 'bt-queue-thumb', src: attachment.value.previewUrl, alt: t('Queued image') })
              : h(QueueFile, { key: `${attachment.value.attachmentId}:${attachment.value.name}:${index}`, attachment: attachment.value, label: t('Queued file {name}', { name: attachment.value.name }) }))),
          h(Preview, { text: submission.text, renderFactorySlot }),
          h('span', { className: 'bt-queue-status', role: 'status' }, t('Sending…')),
          queueMutable && h('div', { className: 'bt-queue-actions' },
            h(RowButton, { label: t('Edit queued message'), title: t('Sending…'), disabled: true }, h(PencilIcon)),
            h(RowButton, { label: t('Delete queued message'), title: t('Sending…'), disabled: true }, h(TrashIcon)),
            h(RowButton, { label: t('Steer queued message'), title: t('Sending…'), disabled: true }, h(ArrowUpIcon))))))))
}

export const QUEUE_CSS = `
.bt-queue-dock{box-sizing:border-box;width:calc(100% - var(--dsh-composer-side-clearance,0px) - var(--dsh-composer-side-clearance,0px) - var(--dsh-composer-dock-inset,0px) - var(--dsh-composer-dock-inset,0px));max-width:calc(var(--dsh-composer-card-max-width,748px) - var(--dsh-composer-dock-inset,0px) - var(--dsh-composer-dock-inset,0px));margin:0 auto calc(0px - var(--dsh-composer-stack-gap,8px) - 3px);padding:0 var(--dsh-composer-dock-inset,0px);flex:none}
.bt-queue-panel{position:relative;isolation:isolate;width:100%;padding:2px 0;border-radius:var(--dsw-radius-lg,14px) var(--dsw-radius-lg,14px) 0 0;overflow:hidden}
.bt-queue-panel:before{z-index:-1;border-radius:inherit;background:var(--dsw-specific-menu,var(--bt-main));backdrop-filter:var(--dsw-menu-backdrop-filter,none);content:"";pointer-events:none;position:absolute;inset:0}
.bt-queue-panel:after{border:.5px solid var(--bt-line-2);border-bottom:none;border-radius:inherit;content:"";pointer-events:none;position:absolute;inset:0}
.bt-queue-head{box-sizing:border-box;width:100%;height:36px;border:0;border-radius:var(--dsw-radius-md,10px);background:none;color:var(--bt-ink);text-align:left;font:inherit;cursor:pointer;display:flex;align-items:center;gap:10px;padding:4px 12px}
.bt-queue-head:focus-visible{outline:2px solid var(--bt-accent);outline-offset:-2px}
.bt-queue-head:disabled{cursor:default}
.bt-queue-lead{color:var(--bt-ink-3);flex:none;display:grid;place-items:center}
.bt-queue-count{min-width:0;flex:auto;font-size:13px;font-weight:500;line-height:24px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-queue-chev{width:14px;height:14px;color:var(--bt-ink-3);flex:none;display:grid;place-items:center}
.bt-queue-list{max-height:180px;margin:0;padding:0;list-style:none;overflow-y:auto}
.bt-queue-row{box-sizing:border-box;min-height:36px;width:100%;border-radius:var(--dsw-radius-md,10px);display:flex;align-items:center;gap:10px;padding:4px 5px 4px 12px}
.bt-queue-row+.bt-queue-row{box-shadow:inset 0 1px 0 var(--bt-line)}
.bt-bot-queue-list{max-height:240px}
.bt-bot-queue-row{padding:8px 12px;min-width:0}
.bt-bot-queue-row+.bt-bot-queue-row{box-shadow:inset 0 1px 0 var(--bt-line)}
.bt-bot-queue-meta{display:flex;align-items:baseline;gap:8px;font-size:12px;line-height:18px;color:var(--bt-ink-2)}
.bt-bot-queue-sender{min-width:0;overflow-wrap:anywhere;font-weight:500;color:var(--bt-ink-2)}
.bt-bot-queue-placement{flex:none}
.bt-bot-queue-text{margin-top:4px;min-width:0;max-height:160px;overflow-y:auto;font-size:13px;line-height:20px;color:var(--bt-ink-2);white-space:pre-wrap;overflow-wrap:anywhere}
.bt-queue-attachments.bt-bot-queue-attachments{max-width:100%;margin-top:4px}
.bt-queue-attachments{flex:none;min-width:0;max-width:55%;display:flex;gap:4px;overflow:hidden}
.bt-queue-pending .bt-queue-attachments{flex-shrink:1}
.bt-queue-file{box-sizing:border-box;height:24px;min-width:74px;flex:0 180px;border:.5px solid var(--bt-line);border-radius:var(--dsw-radius-sm,6px);background:var(--bt-main);display:inline-flex;align-items:center;gap:4px;padding:0 6px;overflow:hidden}
.bt-queue-fileicon{flex:none;width:16px;height:16px;color:var(--bt-ink-3);display:inline-flex}
.bt-queue-filename{min-width:0;flex:auto;font-size:13px;line-height:18px;color:var(--bt-ink-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-queue-filesize{flex:none;font-size:10px;color:var(--bt-ink-3);white-space:nowrap}
.bt-queue-thumb{width:24px;height:24px;border:.5px solid var(--bt-line);border-radius:var(--dsw-radius-xs,4px);background:var(--bt-main);object-fit:cover}
.bt-queue-preview{min-width:0;flex:auto;font-size:13px;color:var(--bt-ink-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-queue-edit{min-width:0;flex:auto;box-sizing:border-box;border:0;outline:none;resize:none;background:none;color:var(--bt-ink);font:inherit;font-size:13px;line-height:20px;max-height:120px;padding:4px 0}
.bt-queue-actions{flex:none;display:flex;align-items:center;gap:10px}
.bt-queue-status{flex:none;font-size:13px;color:var(--bt-ink-3);white-space:nowrap}
.bt-queue-action{width:28px;height:28px;border:0;border-radius:999px;background:none;color:var(--bt-ink-3);cursor:pointer;display:grid;place-items:center;padding:0}
.bt-queue-action:hover:not(:disabled){background:var(--bt-hover);color:var(--bt-ink-2)}
.bt-queue-action:focus-visible{outline:2px solid var(--bt-accent);outline-offset:-2px}
.bt-queue-action:disabled{cursor:default;opacity:.45}
`
