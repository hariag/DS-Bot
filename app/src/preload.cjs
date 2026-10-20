// Gives the DSH Web entry the boot handshake it uses inside an app window. On Windows it also
// marks the page for the frameless window the way DSH Desktop's preload does
// (apps/desktop/src/preload-windows.ts, preload-platform.ts and preload-theme.ts; see NOTICE),
// but without data-platform: that puts DSH's shortcuts on native menu input, which this
// window does not have.
const { contextBridge, ipcRenderer } = require('electron')

if (location.protocol === 'dsh-app:' && location.hostname === 'app') {
  contextBridge.exposeInMainWorld('dshDesktopBoot', {
    ready: () => ipcRenderer.invoke('ds-bot:boot'),
    failed: (message) => ipcRenderer.invoke('ds-bot:boot-failed', String(message)),
  })
  // DS Bot's settings show and move the app's data location through this.
  contextBridge.exposeInMainWorld('dsBotApp', {
    dataLocation: () => ipcRenderer.invoke('ds-bot:data-location'),
    moveData: (workspace) => ipcRenderer.invoke('ds-bot:move-data', typeof workspace === 'string' ? workspace : undefined),
    teamWorkspaceChanged: (path) => { ipcRenderer.send('ds-bot:team-workspace', String(path)) },
  })
  const caption = process.argv.find(value => value.startsWith('--ds-bot-caption='))
  if (caption !== undefined) {
    ipcRenderer.on('ds-bot:fullscreen', (_event, fullscreen) => {
      const root = document.documentElement
      if (root === null) return
      if (fullscreen) root.dataset.fullscreen = 'true'
      else delete root.dataset.fullscreen
    })
    const start = () => { frameless(caption.slice('--ds-bot-caption='.length), process.argv.includes('--ds-bot-mica')) }
    // A preload runs before the document root exists.
    if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', start, { once: true })
    else start()
  }
}

function frameless(height, mica) {
  const root = document.documentElement
  root.dataset.windowsTitlebar = ''
  root.style.setProperty('--dsh-windows-titlebar-height', `${height}px`)
  let theme
  const sendTheme = () => {
    const value = root.getAttribute('data-ds-theme-source')
    if (value === null || value === theme) return
    theme = value
    ipcRenderer.send('ds-bot:native-theme', value)
  }
  new MutationObserver(sendTheme).observe(root, { attributeFilter: ['data-ds-theme-source'] })
  sendTheme()
  captionColors(mica)
}

// The caption buttons stand on the rightmost open column with Mica (the right sidebar or the
// conversation) and on the sidebar-colored band without it. Theme variables can resolve apart
// from what is painted, so the color comes from the element itself: the first one up from it
// that is not transparent.
function captionColors(mica) {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 1
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (context === null) return
  const opaque = (color) => {
    context.clearRect(0, 0, 1, 1)
    context.fillStyle = color
    context.fillRect(0, 0, 1, 1)
    const [red, green, blue, alpha] = context.getImageData(0, 0, 1, 1).data
    return alpha === 0 ? undefined : `rgb(${red}, ${green}, ${blue})`
  }
  const column = () => {
    if (!mica) return document.querySelector('div[class*="_sidebarCol"]')
    const right = document.querySelector('div[class*="_rightbarCol"]')
    return right !== null && right.getBoundingClientRect().width > 0 ? right : document.querySelector('div[class*="_centerCol"]')
  }
  let frame
  const surface = () => {
    const start = column()
    // Opening or closing the right sidebar changes the frame's columns.
    if (start !== null && frame === undefined) {
      frame = start.parentElement
      observer.observe(frame, { attributes: true, attributeFilter: ['style'] })
    }
    for (let element = start; element !== null; element = element.parentElement) {
      const color = opaque(getComputedStyle(element).backgroundColor)
      if (color !== undefined) return [color, opaque(getComputedStyle(element).color)]
    }
    return undefined
  }
  let sent = ''
  let tries = 0
  const send = () => {
    const colors = surface()
    // The frame appears once DSH has booted; until then the main process's colors hold.
    if (colors === undefined || colors[1] === undefined) {
      if (tries++ < 120) setTimeout(send, 250)
      return
    }
    const current = colors.join()
    if (current === sent) return
    sent = current
    ipcRenderer.send('ds-bot:caption-colors', ...colors)
  }
  const observer = new MutationObserver(send)
  observer.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme', 'style'] })
  observer.observe(document.head, { childList: true, subtree: true, characterData: true })
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-ds-theme-source', 'style'] })
  // A stylesheet link is added before it loads; its rules apply without another mutation.
  document.head.addEventListener('load', send, true)
  send()
}
