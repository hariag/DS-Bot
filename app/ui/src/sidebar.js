import { createElement as h } from 'react'
import { t } from '../../../ds-bot/src/client/i18n.js'
import { BotAvatar, botState } from '../../../ds-bot/src/client/mark.js'

export function stateOf(bot, live, questions) {
  return botState(live.work?.bots?.[bot.id] !== undefined, live.activity?.[bot.id], questions[bot.sessionId] !== undefined)
}

// `bt-row` lets the plugin's mark styles pet the avatar under the pointer.
function BotRow({ bot, main, state, current, onOpen }) {
  return h('button', { type: 'button', className: 'side-row bt-row', 'aria-current': current ? 'page' : undefined, onClick: () => onOpen(bot.id) },
    h(BotAvatar, { bot, size: 36, state, main }),
    h('span', { className: 'side-text' },
      h('span', { className: 'side-name' }, bot.name),
      bot.role ? h('span', { className: 'side-role' }, bot.role) : null))
}

export function Sidebar({ bots, mainBotIds, live, questions, current, onOpen }) {
  return h('aside', { className: 'side' },
    h('div', { className: 'side-top' }, h('span', { className: 'side-brand' }, 'DS Bot')),
    h('nav', { className: 'side-list', 'aria-label': t('Bots') },
      bots.map(bot => h(BotRow, {
        key: bot.id,
        bot,
        main: mainBotIds.includes(bot.id),
        state: stateOf(bot, live, questions),
        current: bot.id === current,
        onOpen,
      }))))
}
