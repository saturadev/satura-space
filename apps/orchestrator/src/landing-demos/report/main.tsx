import { containScroll } from '../contain-scroll'
import '../offscreen'
import { useEffect, useMemo, useState, type ReactElement } from 'react'
import { createRoot } from 'react-dom/client'
import { DEFAULT_THEME } from '@shared/types'
import type { CodeFileResult, CodeRefResolution } from '@shared/report-code'
import { applyTheme } from '@renderer/lib/theme/themes'
import { ReportApi, ReportContext, ReportStore, type ReportBridge, type ReportGit } from '@renderer/components/report/report-context'
import { ReportOverlay, type ImageGallery, type Overlay } from '@renderer/components/report/ReportOverlay'
import { installPopoverDismiss } from '@renderer/remote/popover-dismiss'
import HealthPackReport from './hollowmere/report'
import healthPackSource from './hollowmere/HealthPack.cs.txt?raw'
import './report.css'

const ROOT = '/hollowmere'
const FILE = `${ROOT}/.sspace/reports/health-pack-reach/report.tsx`
const MEDIA: Record<string, string> = { [`${ROOT}/.sspace/videos/health-pack-reach.mp4`]: '/media/health-pack-run.mp4?v=1' }
const CODE: Record<string, string> = { 'Assets/Rollmates/Scripts/HealthPack.cs': healthPackSource }

const phone = window.innerWidth < 640
const flow = phone && window.parent !== window
if (phone) {
  document.documentElement.dataset.layout = 'mobile'
  installPopoverDismiss()
  const stop = (e: Event): void => {
    if (e.type === 'touchmove' && (e as TouchEvent).touches.length < 2) return
    if (e.type === 'wheel' && !(e as WheelEvent).ctrlKey) return
    e.preventDefault()
    e.stopPropagation()
  }
  for (const t of ['gesturestart', 'gesturechange', 'gestureend', 'touchmove', 'wheel']) document.addEventListener(t, stop, { capture: true, passive: false })
  const fingers = new Set<number>()
  const multi = (e: PointerEvent): void => {
    if (e.pointerType !== 'touch') return
    if (e.type === 'pointerdown') fingers.add(e.pointerId)
    if (e.type === 'pointerup' || e.type === 'pointercancel') fingers.delete(e.pointerId)
    if (fingers.size > 1) e.stopPropagation()
  }
  for (const t of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) document.addEventListener(t, multi as EventListener, { capture: true })
  document.addEventListener('dblclick', (e) => e.stopPropagation(), { capture: true })
}
if (flow) document.documentElement.dataset.embed = 'flow'

function postEmbed(): () => void {
  const host = document.querySelector<HTMLElement>('.rk-host')
  if (!host) return () => {}
  let last = ''
  const post = (): void => {
    const msg = { type: 'satura-report-embed', height: Math.ceil(host.getBoundingClientRect().height), overlay: !!document.querySelector('[data-report-overlay]') }
    const key = `${msg.height} ${msg.overlay}`
    if (key === last) return
    last = key
    window.parent.postMessage(msg, location.origin)
  }
  const ro = new ResizeObserver(post)
  ro.observe(host)
  const mo = new MutationObserver(post)
  mo.observe(document.body, { childList: true })
  post()
  return () => {
    ro.disconnect()
    mo.disconnect()
  }
}
containScroll()
applyTheme(DEFAULT_THEME)

const noGit = (): Promise<never> => Promise.resolve({ ok: false, error: { message: 'No git in this demo' } } as never)

const bridge: ReportBridge = {
  statPath: (p) => Promise.resolve({ exists: p in MEDIA }),
  codeRefs: (_f, _r, refs) =>
    Promise.resolve(
      Object.fromEntries(
        refs.map((r): [string, CodeRefResolution] => [r, r in CODE ? { ref: r, status: 'ok', rel: r } : { ref: r, status: 'missing' }])
      )
    ),
  readCode: (_f, _r, rel): Promise<CodeFileResult> =>
    Promise.resolve(rel in CODE ? { ok: true, rel, path: `${ROOT}/${rel}`, text: CODE[rel] } : { ok: false, error: 'missing' }),
  git: { getState: noGit, getCommit: noGit, diffBetweenWithStats: noGit, show: noGit, patch: noGit } as ReportGit
}

function Page(): ReactElement {
  const [overlay, setOverlay] = useState<Overlay | null>(null)
  useEffect(() => (flow ? postEmbed() : undefined), [])
  const api = useMemo(
    () =>
      new ReportApi({
        file: FILE,
        root: ROOT,
        version: 'landing',
        store: new ReportStore(),
        initial: null,
        frames: new Map(),
        states: new Map(),
        bridge,
        mediaUrl: (p) => MEDIA[p] ?? 'data:,',
        setTitle: () => {},
        openReport: () => {},
        openFile: () => {},
        showImage: (u: string, alt?: string, gallery?: ImageGallery) => setOverlay({ kind: 'image', url: u, alt: alt ?? '', gallery }),
        showCode: (target) => setOverlay({ kind: 'code', ...target }),
        copyLink: () => {}
      }),
    []
  )
  return (
    <div className="absolute inset-0" data-phone-panel="viewer" data-tab-id="report">
      <div className="sr-scope absolute inset-0" data-viewer-report>
        <div className="sr-scope rk-host">
          <div className="rk-report">
            <ReportContext.Provider value={api}>
              <HealthPackReport />
            </ReportContext.Provider>
          </div>
        </div>
        {overlay && <ReportOverlay overlay={overlay} file={FILE} root={ROOT} onClose={() => setOverlay(null)} onChange={setOverlay} read={bridge.readCode} />}
      </div>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<Page />)
