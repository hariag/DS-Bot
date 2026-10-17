import { createElement as h, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { t } from '../../../ds-bot/src/client/i18n.js'
import { allThemes, themeCss } from '../../../ds-bot/src/client/themes.js'
import { call, openFeed } from './api.js'
import { Chat } from './chat.js'
import { Sidebar } from './sidebar.js'

const LIVE_KEYS = ['activity', 'work', 'memoryNews', 'memoryReviews', 'connectors', 'capabilityStatuses']
// Some live facts (memory news, connector status) change without a feed notice.
const CATCH_UP_MS = 15_000

// The team as the `state` endpoint gives it: `view` changes with a new revision, `live`
// with every answer. Requests do not overlap; one asked for while another runs follows it.
function useTeam() {
  const [team, setTeam] = useState({ view: null, live: {}, error: null })
  const known = useRef({ since: undefined, models: undefined })
  const running = useRef(false)
  const again = useRef(false)
  const refresh = useCallback(async () => {
    if (running.current) { again.current = true; return }
    running.current = true
    do {
      again.current = false
      try {
        const value = await call('state', { since: known.current.since, models: known.current.models, locale: navigator.language })
        const live = Object.fromEntries(LIVE_KEYS.map(key => [key, value[key]]))
        if (value.unchanged) setTeam(current => ({ ...current, live, error: null }))
        else {
          known.current = { since: value.revision, models: value.modelsKey }
          setTeam({ view: value, live, error: null })
        }
      } catch (error) {
        setTeam(current => ({ ...current, error }))
      }
    } while (again.current)
    running.current = false
  }, [])
  return [team, refresh]
}

// Feed events for the open chat.
function createBus() {
  const listeners = new Set()
  return {
    on(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    emit(event, data) { for (const listener of listeners) listener(event, data) },
  }
}

// The team's theme and accent, as the plugin paints them.
function useTheme(prefs) {
  useEffect(() => {
    const theme = allThemes()[prefs?.theme] ?? allThemes().deepseek
    const style = document.createElement('style')
    style.textContent = themeCss(theme, prefs?.accent)
    document.head.append(style)
    if (prefs?.motion) document.body.dataset.btMotion = prefs.motion
    else delete document.body.dataset.btMotion
    return () => { style.remove() }
  }, [prefs?.theme, prefs?.accent, prefs?.motion])
}

export function App() {
  const [team, refresh] = useTeam()
  const bus = useMemo(createBus, [])
  const [selected, setSelected] = useState(null)
  const view = team.view
  useTheme(view?.prefs)

  useEffect(() => {
    void refresh()
    const close = openFeed((event, data) => {
      if (event === 'hello' || event === 'revision' || event === 'live') void refresh()
      bus.emit(event, data)
    })
    const timer = setInterval(() => { void refresh() }, CATCH_UP_MS)
    return () => {
      close()
      clearInterval(timer)
    }
  }, [refresh, bus])

  const bots = useMemo(() => {
    const list = view?.bots ?? []
    const mains = view?.mainBotIds ?? []
    return [...list].sort((a, b) => (mains.includes(b.id) - mains.includes(a.id)) || (a.createdAt ?? 0) - (b.createdAt ?? 0))
  }, [view])
  const current = bots.find(bot => bot.id === selected) ?? bots.find(bot => bot.id === view?.mainBotId) ?? bots[0]

  if (view === null) {
    return h('div', { className: 'app-blank' }, team.error ? h('p', { className: 'app-error' }, team.error.message) : h('p', { className: 'app-wait' }, t('Loading…')))
  }
  return h('div', { className: 'app' },
    h(Sidebar, { bots, mainBotIds: view.mainBotIds ?? [], live: team.live, questions: view.questions ?? {}, current: current?.id, onOpen: setSelected }),
    h('main', { className: 'app-main' },
      current ? h(Chat, { key: current.id, bot: current, team: view, live: team.live, bus }) : null,
      team.error ? h('div', { className: 'app-toast', role: 'alert' }, team.error.message) : null))
}
