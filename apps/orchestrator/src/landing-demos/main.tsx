import { containScroll } from './contain-scroll'
import { installUserFocus } from './user-focus'
import { installNoZoom } from './no-zoom'
import './offscreen'
import './mock/install'
import { lazy, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import { DEFAULT_THEME } from '@shared/types'
import { applyTheme } from '@renderer/lib/theme/themes'
import { installInspectorTouch } from '@renderer/remote/tuner/inspector-touch'
import { installTunerTypingPane } from '@renderer/remote/tuner/typing-pane'
import { installToolbarTips } from '@renderer/remote/tuner/toolbar-tips'
import { installToolbarScrollbar } from '@renderer/remote/tuner/toolbar-scrollbar'
import { installPhoneExpand } from '@renderer/remote/expand'
import { installPopoverDismiss } from '@renderer/remote/popover-dismiss'
import '@renderer/remote/tuner/tuner.css'
import '@renderer/remote/phone-expand.css'
import './landing.css'

const Demo = lazy(() => import('./arena/Demo'))

if (window.innerWidth < 640) {
  document.documentElement.dataset.layout = 'mobile'
  installInspectorTouch()
  installTunerTypingPane()
  installToolbarTips()
  installToolbarScrollbar()
  installPhoneExpand()
  installPopoverDismiss()
}
if (window.innerWidth < 640 || matchMedia('(pointer: coarse)').matches) installNoZoom()
installUserFocus()
containScroll()
applyTheme(DEFAULT_THEME)

createRoot(document.getElementById('root')!).render(
  <div className="fixed inset-0 bg-panel">
    <Suspense fallback={<div className="flex h-full items-center justify-center text-[12px] text-ink-3">Loading the Tuner…</div>}>
      <Demo />
    </Suspense>
  </div>
)
