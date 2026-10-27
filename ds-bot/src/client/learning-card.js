import { createElement as h, useId, useRef, useState } from 'react'
import { currentPart } from './text.js'
import { t } from './i18n.js'

function ProposalCard({ proposal, initialError = '', onFailure, onResolved, actions }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(initialError)
  const busyRef = useRef(false)
  const titleId = useId()
  const answer = approve => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setError('')
    void Promise.resolve().then(() => actions.learningAnswer(proposal.id, approve))
      .then(() => onResolved(proposal.id), failure => {
        const message = failure?.message ?? String(failure)
        setError(message)
        onFailure(proposal, message)
      })
      .finally(() => {
        busyRef.current = false
        setBusy(false)
      })
  }
  return h('section', { className: 'bt-q bt-secret bt-learning-card', role: 'group', 'aria-labelledby': titleId, 'aria-busy': busy },
    h('div', { className: 'bt-q-head' },
      h('div', { className: 'bt-q-text' },
        h('p', { className: 'bt-q-title', id: titleId }, t(proposal.action === 'update' ? 'Skill update' : 'New skill')),
        h('div', { className: 'bt-q-detail' }, h('code', { className: 'bt-secret-name' }, proposal.name)))),
    h('div', { className: 'bt-secret-body' },
      h('p', { className: 'bt-learning-description' }, proposal.description),
      proposal.why ? h('p', { className: 'bt-learning-why' }, proposal.why) : null,
      h('details', { className: 'bt-learning-preview' },
        h('summary', null, t('Preview')),
        h('pre', null, proposal.content))),
    error ? h('div', { className: 'bt-secret-error', role: 'alert' }, error) : null,
    h('div', { className: 'bt-q-foot' },
      h('button', { type: 'button', className: 'bt-q-btn', disabled: busy, onClick: () => answer(false) }, t('Decline')),
      h('button', { type: 'button', className: 'bt-q-submit', disabled: busy, onClick: () => answer(true) }, t('Approve'))))
}

export function LearningDock({ sessionId, useRoster, actions }) {
  const roster = useRoster(value => value)
  const [failed, setFailed] = useState({})
  const bot = roster.byId?.[sessionId]
  if (!bot || currentPart(bot) !== sessionId) return null
  const proposals = roster.learning?.[bot.id] ?? []
  const visible = [...proposals]
  for (const entry of Object.values(failed)) {
    if (entry.proposal.botId === bot.id && !proposals.some(proposal => proposal.id === entry.proposal.id)) visible.push(entry.proposal)
  }
  if (visible.length === 0) return null
  const onFailure = (proposal, error) => setFailed(current => ({ ...current, [proposal.id]: { proposal, error } }))
  const onResolved = id => setFailed(current => {
    if (!(id in current)) return current
    const next = { ...current }
    delete next[id]
    return next
  })
  return h('div', { className: 'bt-q-dock bt-secret-dock bt-learning-dock' },
    visible.map(proposal => h(ProposalCard, {
      key: proposal.id,
      proposal,
      initialError: failed[proposal.id]?.error,
      onFailure,
      onResolved,
      actions,
    })))
}

export const LEARNING_CSS = `
.bt-learning-description{margin:0;font-size:13px;line-height:18px;color:var(--bt-ink)}
.bt-learning-why{margin:0;font-size:12px;line-height:16px;color:var(--bt-ink-2)}
.bt-learning-preview{font-size:12px;line-height:16px;color:var(--bt-ink-2)}
.bt-learning-preview summary{width:fit-content;cursor:pointer}
.bt-learning-preview pre{max-height:220px;overflow:auto;margin:6px 0 0;padding:8px;border:1px solid var(--bt-line);border-radius:8px;background:var(--bt-card);color:var(--bt-ink);font-family:ui-monospace,monospace;font-size:12px;line-height:16px;white-space:pre-wrap;overflow-wrap:anywhere}
`
