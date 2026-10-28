import { createElement as h, useId, useRef, useState } from 'react'
import { useTurnFacts } from './btw.js'
import { proposalPlacement } from './learning-card-model.js'
import { currentPart } from './text.js'
import { t } from './i18n.js'
import { spring, SPRING_TAP } from './motion.js'

const failedAnswers = new Map()

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
  const lines = String(proposal.content ?? '').replace(/\n+$/, '').split('\n')
  const rows = lines.map((line, index) => ({ kind: 'added', mark: String(index + 1), line }))
  return h('section', { className: 'bt-q bt-learning-card', role: 'group', 'aria-labelledby': titleId, 'aria-busy': busy },
    h('div', { className: 'bt-learning-headtext' },
      h('span', { className: 'bt-learning-status' }, t('Awaiting approval')),
      h('p', { className: 'bt-q-title', id: titleId }, proposal.name),
      h('p', { className: 'bt-learning-sub' }, t(proposal.action === 'update' ? 'Skill update' : 'New skill')),
      proposal.description ? h('p', { className: 'bt-learning-description' }, proposal.description) : null),
    h(FileBox, {
      name: 'SKILL.md',
      path: `skills/${proposal.name}`,
      added: rows.length,
      removed: 0,
      state: proposal.action === 'update' ? 'Updated' : 'Added',
      blocks: [rows],
    }),
    proposal.why ? h('p', { className: 'bt-learning-why' }, proposal.why) : null,
    error ? h('div', { className: 'bt-learning-error', role: 'alert' }, error) : null,
    h('div', { className: 'bt-learning-actions' },
      h('button', { type: 'button', className: 'bt-learning-btn bt-learning-approve', disabled: busy, onClick: () => answer(true) }, t('Approve')),
      h('button', { type: 'button', className: 'bt-learning-btn bt-learning-decline', disabled: busy, onClick: () => answer(false) }, t('Decline'))))
}

const COLLAPSE_ROWS = 8

function FileBox({ name, path, added, removed, state, blocks }) {
  const [open, setOpen] = useState(false)
  const total = blocks.reduce((sum, rows) => sum + rows.length, 0)
  const folds = total > COLLAPSE_ROWS
  const shut = folds && !open
  return h('div', { className: 'bt-learning-file' },
    h('div', { className: 'bt-learning-filehead' },
      h('strong', null, name),
      path ? h('span', { className: 'bt-learning-path' }, path) : null,
      h('span', { className: 'bt-learning-spacer' }),
      added > 0 ? h('span', { className: 'bt-learning-plus' }, `+${added}`) : null,
      removed > 0 ? h('span', { className: 'bt-learning-minus' }, `\u2212${removed}`) : null,
      h('span', { className: `bt-learning-state${state === 'Added' ? ' bt-learning-state-new' : ''}` }, t(state))),
    h('div', { className: shut ? 'bt-learning-code bt-learning-shut' : 'bt-learning-code' },
      blocks.map((rows, blockIndex) => [
        blockIndex > 0 ? h('div', { className: 'bt-learning-gap', key: `gap-${blockIndex}` }) : null,
        ...rows.map((row, rowIndex) => h('div', { className: `bt-learning-row bt-learning-${row.kind}`, key: `${blockIndex}-${rowIndex}` },
          h('span', { className: 'bt-learning-num', 'aria-hidden': true }, row.mark),
          h('span', { className: 'bt-learning-text' }, row.line))),
      ]),
      shut ? h('div', { className: 'bt-learning-fade' }) : null),
    folds ? h('button', { type: 'button', className: 'bt-learning-more', 'aria-expanded': open, onClick: () => setOpen(!open) }, t(open ? 'Show less' : 'Show all')) : null)
}

function LearningProposals({ turn, dock, sessionId, useRoster, actions }) {
  const roster = useRoster(value => value)
  const facts = useTurnFacts(sessionId, actions)
  const [failed, setFailed] = useState({})
  const bot = roster.byId?.[sessionId]
  if (!bot || currentPart(bot) !== sessionId) return null
  const proposals = roster.learning?.[bot.id] ?? []
  const visible = [...proposals]
  for (const entry of Object.values(failed)) {
    if (entry.proposal.botId === bot.id && !proposals.some(proposal => proposal.id === entry.proposal.id)) visible.push(entry.proposal)
  }
  for (const entry of failedAnswers.values()) {
    if (entry.proposal.botId === bot.id && !proposals.some(proposal => proposal.id === entry.proposal.id)
      && !visible.some(proposal => proposal.id === entry.proposal.id)) visible.push(entry.proposal)
  }
  const cards = visible.filter(proposal => {
    const placement = proposalPlacement(proposal, facts?.turns)
    return dock ? placement.kind === 'dock' : placement.kind === 'turn' && placement.turn === turn?.turn
  })
  if (cards.length === 0) return null
  const onFailure = (proposal, error) => {
    failedAnswers.set(proposal.id, { proposal, error })
    setFailed(current => ({ ...current, [proposal.id]: { proposal, error } }))
  }
  const onResolved = id => setFailed(current => {
    failedAnswers.delete(id)
    if (!(id in current)) return current
    const next = { ...current }
    delete next[id]
    return next
  })
  return h('div', { className: dock ? 'bt-learning-stack bt-learning-dock' : 'bt-learning-stack' }, cards.map(proposal => h('div', { className: 'bt-q-inline', key: proposal.id },
    h(ProposalCard, {
      proposal,
      initialError: failed[proposal.id]?.error ?? failedAnswers.get(proposal.id)?.error,
      onFailure,
      onResolved,
      actions,
    }))))
}

export function LearningTurnTail(props) {
  return h(LearningProposals, { ...props, dock: false })
}

export function LearningDock(props) {
  return h(LearningProposals, { ...props, dock: true })
}

export const LEARNING_CSS = `
.bt-learning-stack{display:flex;flex-direction:column;gap:4px}
.bt-learning-dock{width:100%;max-width:var(--dsh-chat-content-width,748px);margin:0 auto;box-sizing:border-box}
.bt-learning-card{gap:12px}
.bt-learning-headtext{display:flex;flex-direction:column;gap:2px;min-width:0}
.bt-learning-status{font-size:13px;line-height:18px;font-weight:500;color:var(--bt-star)}
.bt-learning-card .bt-q-title{overflow-wrap:anywhere}
.bt-learning-sub{margin:0;font-size:13px;line-height:18px;color:var(--bt-ink-2)}
.bt-learning-description{margin:4px 0 0;font-size:13px;line-height:18px;color:var(--bt-ink)}
.bt-learning-file{border:1px solid var(--bt-line-2);border-radius:10px;overflow:hidden;background:var(--bt-card)}
.bt-learning-filehead{display:flex;align-items:center;gap:8px;min-width:0;padding:8px 12px;border-bottom:1px solid var(--bt-line);font-size:13px;line-height:18px;color:var(--bt-ink)}
.bt-learning-filehead strong{flex:none;font-weight:500}
.bt-learning-path{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--bt-ink-3)}
.bt-learning-spacer{flex:1}
.bt-learning-plus{flex:none;font-weight:600;color:var(--bt-green)}
.bt-learning-minus{flex:none;font-weight:600;color:var(--bt-danger)}
.bt-learning-state{flex:none;padding:1px 8px;border-radius:6px;font-size:12px;font-weight:500;background:color-mix(in srgb,var(--bt-accent) 12%,transparent);color:var(--bt-accent)}
.bt-learning-state-new{background:color-mix(in srgb,var(--bt-green) 14%,transparent);color:var(--bt-green)}
.bt-learning-code{position:relative;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:20px;color:var(--bt-ink)}
.bt-learning-shut{max-height:180px;overflow:hidden}
.bt-learning-row{display:grid;grid-template-columns:40px 1fr}
.bt-learning-num{padding-right:10px;text-align:right;color:var(--bt-ink-3);user-select:none}
.bt-learning-text{min-width:0;padding:0 12px;white-space:pre-wrap;overflow-wrap:anywhere}
.bt-learning-added{background:color-mix(in srgb,var(--bt-green) 10%,transparent);box-shadow:inset 3px 0 0 var(--bt-green)}
.bt-learning-removed{background:color-mix(in srgb,var(--bt-danger) 8%,transparent);box-shadow:inset 3px 0 0 var(--bt-danger)}
.bt-learning-gap{height:8px;background:var(--bt-hover)}
.bt-learning-fade{position:absolute;left:0;right:0;bottom:0;height:56px;background:linear-gradient(transparent,var(--bt-card));pointer-events:none}
.bt-learning-more{display:block;width:100%;padding:6px;border:0;border-top:1px solid var(--bt-line);background:transparent;font:inherit;font-size:12px;line-height:16px;color:var(--bt-ink-2);cursor:pointer}
.bt-learning-more:hover{background:var(--bt-hover)}
.bt-learning-more:focus-visible{outline:2px solid var(--bt-accent);outline-offset:-2px}
.bt-learning-why{margin:0;font-size:12px;line-height:17px;color:var(--bt-ink-2)}
.bt-learning-actions{display:flex;align-items:center;justify-content:flex-start;gap:8px}
.bt-learning-btn{flex:none;display:inline-flex;align-items:center;height:32px;padding:0 16px;border-radius:8px;font:inherit;font-size:14px;font-weight:500;cursor:pointer;transition:background-color .12s ease,opacity .12s ease,${spring(SPRING_TAP, 'scale')}}
.bt-learning-decline{background:transparent;border:1px solid var(--bt-line-2);color:var(--bt-ink)}
.bt-learning-decline:hover:not(:disabled){background:var(--bt-hover)}
.bt-learning-approve{border:1px solid transparent;background:var(--bt-ink);color:var(--bt-card)}
.bt-learning-approve:hover:not(:disabled){opacity:.88}
.bt-learning-btn:disabled{opacity:.45;cursor:default}
.bt-learning-btn:active:not(:disabled){scale:.97}
.bt-learning-btn:focus-visible{outline:2px solid var(--bt-accent);outline-offset:2px}
@media (prefers-reduced-motion:reduce){.bt-learning-btn{transition:background-color .12s ease,opacity .12s ease}.bt-learning-btn:active:not(:disabled){scale:none}}
.bt-learning-error{font-size:12px;line-height:16px;color:var(--bt-danger)}
`
