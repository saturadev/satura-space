import './web-shell/bridge'
import './install-api'
import { createRoot } from 'react-dom/client'
import { DEFAULT_THEME } from '@shared/types'
import { applyTheme } from '../lib/theme/themes'
import './remote.css'
import { installMirror } from './mirror'
import { installRestorePrompts } from './restore-prompts'
import { connect, e2eState, linkState, onConnectionState } from './ws-transport'
import { ensureVideoLink } from './video/link'
import { RemoteApp } from './RemoteApp'
import { installInspectorTouch } from './tuner/inspector-touch'
import { installTunerTypingPane } from './tuner/typing-pane'
import { installToolbarTips } from './tuner/toolbar-tips'
import { installToolbarScrollbar } from './tuner/toolbar-scrollbar'
import { installPhoneExpand } from './expand'
import { installPopoverDismiss } from './popover-dismiss'
import { censusSizes } from '@shared/census'
import { linkDiagView, startLinkReports } from './link-diag'
import { clickNotificationForTest, installPushClient, usePush } from './push'
import { claimSessionFor, listMacs, pathHostId } from './macs'
import { installMacSummary } from './mac-summary'
import { installMotion } from './motion'

if (!navigator.clipboard) {
  const none = (): Promise<never> => Promise.reject(new Error('The clipboard needs a secure connection'))
  Object.defineProperty(navigator, 'clipboard', { value: { write: none, writeText: none, read: none, readText: none }, configurable: true })
}
void document.fonts.load("400 12px 'JetBrains Mono Variable'")
void document.fonts.load("600 12px 'JetBrains Mono Variable'")
void document.fonts.load("400 12px 'Satura Term Symbols'", '⏺⎯⎿')
const pageHost = pathHostId()
if (pageHost) claimSessionFor(pageHost)
applyTheme(DEFAULT_THEME)
document.documentElement.dataset.layout = 'mobile'
installMirror()
installRestorePrompts()
const QUIET_INPUT: Record<string, string> = { autocorrect: 'off', autocapitalize: 'off', spellcheck: 'false', autocomplete: 'off' }
function quietInput(t: EventTarget | null): void {
  if (!(t instanceof HTMLElement)) return
  const field = t.closest<HTMLElement>('input, textarea, [contenteditable=""], [contenteditable="true"]')
  if (!field) return
  for (const [k, v] of Object.entries(QUIET_INPUT)) if (field.getAttribute(k) !== v) field.setAttribute(k, v)
}
let touchedAt = 0
const OVERLAY_FOCUS_MS = 4000
document.addEventListener('pointerdown', () => (touchedAt = Date.now()), true)
document.addEventListener('touchstart', (e) => quietInput(e.target), { capture: true, passive: true })
document.addEventListener('focusin', (e) => {
  const t = e.target
  quietInput(t)
  if (t instanceof HTMLTextAreaElement && t.classList.contains('xterm-helper-textarea')) return t.blur()
  const late = Date.now() - touchedAt > (t instanceof Element && t.closest('[data-ti-text-overlay]') ? OVERLAY_FOCUS_MS : 600)
  if ((t instanceof HTMLTextAreaElement || t instanceof HTMLInputElement) && late && !t.hasAttribute('data-web-shell-composer')) t.blur()
})
installInspectorTouch()
installTunerTypingPane()
window.api.tuner.onDrift((cue) =>
  void import('./tuner/phone-drift').then(
    (m) => m.onPhoneDriftCue(cue),
    (e) => console.warn(`[drift] phone could not load Drift for #${cue.seq} ${cue.op}: ${(e as Error)?.message ?? e}`)
  )
)
installToolbarTips()
installToolbarScrollbar()
installPhoneExpand()
installPopoverDismiss()
installMotion()
createRoot(document.getElementById('root')!).render(<RemoteApp />)
onConnectionState((state) => {
  if (state === 'online') ensureVideoLink()
})
startLinkReports()
installPushClient()
installMacSummary()
connect()
;(window as unknown as { __saturaCensus?: () => Record<string, number> }).__saturaCensus = censusSizes
;(window as unknown as { __saturaLink?: typeof linkState }).__saturaLink = linkState
;(window as unknown as { __saturaLinkDiag?: typeof linkDiagView }).__saturaLinkDiag = linkDiagView
;(window as unknown as { __saturaE2e?: typeof e2eState }).__saturaE2e = e2eState
;(window as unknown as { __saturaMacs?: unknown }).__saturaMacs = { list: listMacs, host: pathHostId }
;(window as unknown as { __saturaPush?: unknown }).__saturaPush = {
  state: () => usePush.getState(),
  click: clickNotificationForTest,
  shown: () => navigator.serviceWorker?.ready.then((r) => r.getNotifications()).then((list) => list.map((n) => ({ tag: n.tag, title: n.title, body: n.body, data: n.data })))
}
console.info(`[remote] page loaded ${navigator.userAgent}`)
