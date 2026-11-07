import { createRoot } from 'react-dom/client'
import type { FrameLoad } from '@shared/report-frame'
import { ReportApi, ReportContext, ReportSavedContext, ReportStore, type ReportBridge } from '../components/report/report-context'
import { forgetBridgeCodeRefs, parseCodeHref } from '../components/report/code-ref'
import { ReportBoundary, evaluate } from '../components/report/report-eval'

const SETTLE_MS = 400
const PAGE_TIMEOUT_MS = 20_000
const MAX_CODE_FILES = 400

function wait(ms: number): Promise<void> {
  return new Promise((r) => window.setTimeout(r, ms))
}

async function settle(store: ReportStore, failed: () => boolean): Promise<void> {
  const started = Date.now()
  let quietSince = 0
  await wait(50)
  while (Date.now() - started < PAGE_TIMEOUT_MS) {
    if (failed()) return
    if (store.get().pending === 0) {
      if (!quietSince) quietSince = Date.now()
      if (Date.now() - quietSince >= SETTLE_MS) return
    } else quietSince = 0
    await wait(50)
  }
}

function codeRefsIn(el: HTMLElement): string[] {
  const out = new Set<string>()
  for (const n of el.querySelectorAll<HTMLElement>('[data-code-ref]')) {
    if (n.dataset.codeRefStatus !== 'missing' && n.dataset.codeRef) out.add(n.dataset.codeRef)
  }
  for (const a of el.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    const code = parseCodeHref(a.getAttribute('href') ?? '')
    if (code) out.add(code.path)
  }
  return [...out]
}

export interface CollectResult {
  title: string
  error?: string
  refs: string[]
  media: string[]
}

export async function collectPage(load: FrameLoad, bridge: ReportBridge, mediaUrl: (path: string) => string): Promise<CollectResult> {
  const media = new Set<string>()
  const mapper = { shown: load.shown, map: (t: string) => t }
  const loaded = evaluate({ ok: true, file: load.file, stamp: '', code: load.code, diagnostics: [], text: '', ms: 0 }, mapper, encodeURI(load.file))
  if (!loaded.Component) return { title: '', error: loaded.error ?? 'The report did not load', refs: [], media: [] }
  let title = ''
  let error = ''
  const store = new ReportStore()
  const api = new ReportApi({
    file: load.file,
    root: load.root,
    version: 'export',
    store,
    initial: null,
    frames: new Map(),
    states: new Map(),
    bridge,
    mediaUrl: (p) => {
      media.add(p)
      return mediaUrl(p)
    },
    setTitle: (t) => {
      title = t
    },
    openReport: () => {},
    openFile: () => {},
    showImage: () => {},
    showCode: () => {},
    copyLink: () => {}
  })
  const holder = document.createElement('div')
  holder.style.cssText = 'position:fixed;left:0;top:0;width:1100px;height:900px;overflow:hidden;contain:strict'
  holder.className = 'sr-scope'
  const scroller = document.createElement('div')
  scroller.className = 'rk-host'
  holder.appendChild(scroller)
  document.body.appendChild(holder)
  const rootEl = createRoot(scroller)
  const C = loaded.Component
  try {
    rootEl.render(
      <div className="rk-report">
        <ReportContext.Provider value={api}>
          <ReportSavedContext.Provider value={undefined}>
            <ReportBoundary mapper={mapper} onError={(t) => (error = t)} onRetry={() => {}}>
              <C />
            </ReportBoundary>
          </ReportSavedContext.Provider>
        </ReportContext.Provider>
      </div>
    )
    await settle(store, () => !!error)
    return { title, refs: codeRefsIn(scroller).slice(0, MAX_CODE_FILES), media: [...media], ...(error ? { error } : {}) }
  } finally {
    rootEl.unmount()
    holder.remove()
    forgetBridgeCodeRefs(bridge)
  }
}
