import './lib/dev-user-timing'

import { createRoot } from 'react-dom/client'
import { DEFAULT_THEME } from '@shared/types'
import { App } from './App'
import { applyTheme } from './lib/theme/themes'
import './index.css'

// Paint the default theme before first render so there is no flash; loadSettings() reconciles it
// to the persisted choice moments later.
applyTheme(DEFAULT_THEME)
void document.fonts.load("400 12px 'JetBrains Mono Variable'")
void document.fonts.load("600 12px 'JetBrains Mono Variable'")

window.addEventListener('dragover', (e) => {
  if (e.dataTransfer?.types.includes('Files')) e.preventDefault()
})
window.addEventListener('drop', (e) => {
  if (e.dataTransfer?.types.includes('Files')) e.preventDefault()
})

const clampShellScroll = (): void => {
  const de = document.documentElement
  if (de.scrollTop || de.scrollLeft) {
    de.scrollTop = 0
    de.scrollLeft = 0
  }
  if (document.body && (document.body.scrollTop || document.body.scrollLeft)) {
    document.body.scrollTop = 0
    document.body.scrollLeft = 0
  }
  const root = document.getElementById('root')
  if (root && (root.scrollTop || root.scrollLeft)) {
    root.scrollTop = 0
    root.scrollLeft = 0
  }
}
window.addEventListener(
  'scroll',
  (e) => {
    const t = e.target
    if (
      t === document ||
      t === document.documentElement ||
      t === document.body ||
      (t instanceof HTMLElement && t.id === 'root')
    ) {
      clampShellScroll()
    }
  },
  true
)
window.addEventListener('focusin', clampShellScroll)
window.addEventListener(
  'keydown',
  (e) => {
    if (e.key !== 'Tab') return
    const t = e.target
    if (t instanceof HTMLElement && t.closest('textarea, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]')) return
    e.preventDefault()
  },
  true
)

const root = createRoot(document.getElementById('root')!)

root.render(<App />)
if (import.meta.env.DEV) {
  void Promise.allSettled([
    import('./components/workbench/MonacoEditor'),
    import('./components/workbench/MarkdownView')
  ]).then(() => window.api.app.notifyRendererWarm())
}
