import { createElement as h } from 'react'
import { createRoot } from 'react-dom/client'
import { installLocale } from '../../../ds-bot/src/client/i18n.js'
import { MARK_CSS } from '../../../ds-bot/src/client/styles.js'
import { createLocale } from './locale.js'
import { App } from './app.js'
import './app.css'

installLocale(createLocale(navigator.language))
document.documentElement.lang = navigator.language

const marks = document.createElement('style')
marks.textContent = MARK_CSS
document.head.append(marks)

// The plugin's colors switch on body[data-ds-dark-theme], which DSH sets; here the system's
// light or dark mode sets it.
const dark = matchMedia('(prefers-color-scheme: dark)')
const paint = () => { document.body.toggleAttribute('data-ds-dark-theme', dark.matches) }
paint()
dark.addEventListener('change', paint)

createRoot(document.getElementById('root')).render(h(App))
