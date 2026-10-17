import { createElement as h, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { dateLocale, t } from '../../../ds-bot/src/client/i18n.js'
import { ArrowUpIcon } from '../../../ds-bot/src/client/icons.js'
import { BotAvatar } from '../../../ds-bot/src/client/mark.js'
import { call } from './api.js'
import { stateOf } from './sidebar.js'

// The chat follows its end while the user is this close to it.
const FOLLOW_PX = 80
const sameItem = (a, b) => a.kind === b.kind && a.time === b.time && a.text === b.text

// A Bot's own chat: pages from the `chat` endpoint, new entries and the reply being
// written from the feed. Entries that arrive while the first page loads wait for it.
function useChat(bot, bus) {
  const [view, setView] = useState({ sessionId: null, items: [], cursor: null, loading: true, failed: false })
  const [stream, setStream] = useState(null)
  const [pending, setPending] = useState([])
  const ready = useRef(false)
  const early = useRef([])
  const busy = useRef(false)
  const keep = useRef(null)

  const load = useCallback(async (cursor, scroller) => {
    if (busy.current) return
    busy.current = true
    if (cursor === undefined) ready.current = false
    setView(current => ({ ...current, loading: true, failed: false }))
    try {
      const page = await call('chat', { botId: bot.id, ...(cursor ? { cursor } : {}) })
      if (cursor === undefined) {
        const later = early.current.filter(entry => entry.sessionId === page.sessionId && !page.items.some(item => sameItem(item, entry.item)))
        early.current = []
        ready.current = true
        setView({ sessionId: page.sessionId, items: [...page.items, ...later.map(entry => entry.item)], cursor: page.cursor, loading: false, failed: false })
      } else {
        // Content added above the viewport would push the view down; keep its distance from the end.
        if (scroller) keep.current = scroller.scrollHeight - scroller.scrollTop
        setView(current => ({ ...current, items: [...page.items, ...current.items], cursor: page.cursor, loading: false }))
      }
    } catch {
      ready.current = cursor !== undefined || ready.current
      setView(current => ({ ...current, loading: false, failed: true }))
    } finally {
      busy.current = false
    }
  }, [bot.id])

  // A new part (bot.sessionId) starts the chat over.
  useEffect(() => { void load(undefined) }, [load, bot.sessionId])

  useEffect(() => bus.on((event, data) => {
    // The feed came back after a break: entries may have been missed.
    if (event === 'hello') { if (ready.current) void load(undefined); return }
    if (data?.botId !== bot.id) return
    if (event === 'message') {
      if (!ready.current) { early.current.push(data); return }
      setView(current => (data.sessionId !== current.sessionId || current.items.some(item => sameItem(item, data.item)) ? current : { ...current, items: [...current.items, data.item] }))
      if (data.item.kind === 'user') {
        setPending((list) => {
          const at = list.findIndex(entry => entry.text === data.item.text)
          return at < 0 ? list : [...list.slice(0, at), ...list.slice(at + 1)]
        })
      }
      if (data.item.kind === 'bot') setStream(null)
    } else if (event === 'stream') {
      if (data.phase === 'start') setStream({ attemptId: data.attemptId, text: '' })
      else if (data.phase === 'end') setStream(current => (current?.attemptId === data.attemptId ? null : current))
      else setStream(current => (current?.attemptId === data.attemptId ? { ...current, text: current.text + data.text } : current))
    }
  }), [bus, bot.id, load])

  // Shown at once: the message can come back on the feed before the request returns.
  const send = async (text) => {
    const entry = { text, time: Date.now() }
    setPending(list => [...list, entry])
    try {
      await call('send', { sessionId: bot.id, text })
    } catch (error) {
      setPending(list => list.filter(item => item !== entry))
      throw error
    }
  }
  return { view, stream, pending, load, send, keep }
}

const timeText = time => (Number.isFinite(time) ? new Date(time).toLocaleString(dateLocale(), { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '')

function answerText(item) {
  return (item.answers ?? []).map(answer => [...(answer.selected ?? []), ...(answer.custom ? [answer.custom] : [])].join(', ')).filter(Boolean).join('\n')
}

function EventLine({ item, team }) {
  if (item.role === 'report') return h('div', { className: 'chat-event' }, `${t('Replies from')} ${team.rooms?.find(room => room.id === item.roomId)?.name ?? t('a group chat')}`)
  const other = team.bots.find(bot => bot.id === item.botId)
  const prefix = { stopped: t('Stopped by'), reply: t('Reply from') }[item.role] ?? t('Message from')
  return h('div', { className: 'chat-event' }, `${prefix} ${other?.name ?? item.name ?? t('a Bot')}`)
}

// Consecutive bubbles from one side share their inner corners.
function Rows({ items, team }) {
  return items.map((item, index) => {
    const key = `${index}:${item.kind}:${item.time ?? ''}`
    if (item.kind === 'divider') return h('div', { key, className: 'chat-divider' }, h('span', null, timeText(item.time)))
    if (item.kind === 'event') return h(EventLine, { key, item, team })
    const side = item.kind === 'bot' ? 'bot' : 'user'
    const sideOf = other => (other?.kind === 'bot' ? 'bot' : other?.kind === 'user' || other?.kind === 'answer' || other?.pending ? 'user' : null)
    const text = item.kind === 'answer' ? answerText(item) : item.text
    return h('div', {
      key,
      className: `chat-row chat-${side}`,
      'data-prev': sideOf(items[index - 1]) === side || undefined,
      'data-next': sideOf(items[index + 1]) === side || undefined,
      'data-pending': item.pending || undefined,
    },
    h('div', { className: 'chat-bubble' }, text,
      item.images ? h('span', { className: 'chat-note' }, item.images === 1 ? t('1 image') : t('{count} images', { count: item.images })) : null))
  })
}

function ModelChoice({ bot, models }) {
  const [busy, setBusy] = useState(null)
  const [error, setError] = useState(null)
  const pick = async (ref) => {
    setBusy(ref)
    setError(null)
    try { await call('update-bot', { id: bot.id, model: ref }) } catch (failure) { setError(failure.message); setBusy(null) }
  }
  return h('div', { className: 'chat-card' },
    h('p', null, t("Hi, I'm {name}. Pick a model for me first. You can change it later in my details.", { name: bot.name })),
    models.length === 0
      ? h('p', { className: 'chat-muted' }, t("Add a provider and a model in DeepSeek Harness first, or pick one in the Bot's chat later."))
      : h('div', { className: 'chat-choices' }, models.map(model => h('button', {
        key: model.ref, type: 'button', className: 'chat-choice', disabled: busy !== null, 'aria-busy': busy === model.ref || undefined, onClick: () => pick(model.ref),
      }, h('span', null, model.name ?? model.ref), model.providerName ? h('span', { className: 'chat-muted' }, model.providerName) : null))),
    error ? h('p', { className: 'chat-error', role: 'alert' }, error) : null)
}

function QuestionCard({ bot, question }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const answer = async (label) => {
    setBusy(true)
    setError(null)
    try { await call('answer-question', { sessionId: bot.id, questionId: question.id, answer: { selected: [label], custom: '' } }) } catch (failure) { setError(failure.message) } finally { setBusy(false) }
  }
  return h('div', { className: 'chat-card' },
    h('p', { className: 'chat-question' }, question.question),
    question.detail ? h('p', { className: 'chat-muted' }, question.detail) : null,
    h('div', { className: 'chat-choices' }, (question.options ?? []).map(option => h('button', {
      key: option.label, type: 'button', className: 'chat-choice', disabled: busy, onClick: () => answer(option.label),
    }, h('span', null, option.label), option.description ? h('span', { className: 'chat-muted' }, option.description) : null))),
    error ? h('p', { className: 'chat-error', role: 'alert' }, error) : null)
}

function Composer({ bot, disabled, placeholder, onSend }) {
  const [text, setText] = useState('')
  const [error, setError] = useState(null)
  const [sending, setSending] = useState(false)
  const field = useRef(null)
  useLayoutEffect(() => {
    const node = field.current
    if (!node) return
    node.style.height = 'auto'
    node.style.height = `${Math.min(node.scrollHeight, 120)}px`
  }, [text])
  useEffect(() => { if (!disabled) field.current?.focus() }, [bot.id, disabled])
  const submit = async () => {
    const value = text.trim()
    if (value === '' || sending || disabled) return
    setSending(true)
    setError(null)
    setText('')
    try {
      await onSend(value)
    } catch (failure) {
      setText(current => (current === '' ? value : current))
      setError(failure.message)
    } finally {
      setSending(false)
    }
  }
  return h('div', { className: 'composer-wrap' },
    error ? h('p', { className: 'chat-error', role: 'alert' }, error) : null,
    h('form', { className: 'composer', 'data-multiline': text.includes('\n') || undefined, onSubmit: (event) => { event.preventDefault(); void submit() } },
      h('textarea', {
        ref: field,
        rows: 1,
        value: text,
        disabled,
        placeholder,
        'aria-label': placeholder,
        onChange: event => setText(event.target.value),
        onKeyDown: (event) => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault()
            void submit()
          }
        },
      }),
      h('button', { type: 'submit', className: 'composer-send', disabled: disabled || sending || text.trim() === '', 'aria-label': t('Send message') }, h(ArrowUpIcon))))
}

export function Chat({ bot, team, live, bus }) {
  const { view, stream, pending, load, send, keep } = useChat(bot, bus)
  const scroller = useRef(null)
  const follow = useRef(true)
  const question = team.questions?.[bot.sessionId]
  const working = live.work?.bots?.[bot.id] !== undefined
  const items = [...view.items, ...pending.map(entry => ({ kind: 'user', text: entry.text, time: entry.time, pending: true }))]

  useLayoutEffect(() => {
    const node = scroller.current
    if (!node) return
    if (keep.current !== null) {
      node.scrollTop = node.scrollHeight - keep.current
      keep.current = null
    } else if (follow.current) node.scrollTop = node.scrollHeight
  }, [view.items, stream, pending, working, question])

  const onScroll = () => {
    const node = scroller.current
    follow.current = node.scrollHeight - node.scrollTop - node.clientHeight < FOLLOW_PX
  }

  return h('section', { className: 'chat', 'aria-label': bot.name },
    h('header', { className: 'chat-head' },
      h(BotAvatar, { bot, size: 28, state: stateOf(bot, live, team.questions ?? {}), main: (team.mainBotIds ?? []).includes(bot.id), badge: false }),
      h('span', { className: 'chat-title' }, bot.name),
      bot.role ? h('span', { className: 'chat-role' }, bot.role) : null),
    h('div', { ref: scroller, className: 'chat-scroll', onScroll },
      h('div', { className: 'chat-column', role: 'feed', 'aria-busy': view.loading },
        h('div', { className: 'chat-top' },
          view.loading ? h('span', { className: 'chat-muted' }, t('Loading earlier messages…'))
            : view.failed ? h('button', { type: 'button', className: 'chat-soft', onClick: () => load(view.cursor ?? undefined, scroller.current) }, t('Couldn’t load earlier messages · Retry'))
              : view.cursor ? h('button', { type: 'button', className: 'chat-soft', onClick: () => load(view.cursor, scroller.current) }, t('Load earlier')) : null),
        h(Rows, { items, team }),
        stream?.text ? h('div', { className: 'chat-row chat-bot' }, h('div', { className: 'chat-bubble' }, stream.text)) : null,
        working && !stream?.text ? h('div', { className: 'chat-row chat-bot' }, h('div', { className: 'chat-bubble chat-typing', 'aria-label': t('Working') }, h('i'), h('i'), h('i'))) : null,
        bot.waiting ? h(ModelChoice, { bot, models: team.models ?? [] }) : null,
        question ? h(QuestionCard, { bot, question }) : null)),
    h(Composer, {
      bot,
      disabled: bot.waiting === true,
      placeholder: bot.waiting ? t('Pick a model and {name} can start.', { name: bot.name }) : t('Message {name}', { name: bot.name }),
      onSend: send,
    }))
}
