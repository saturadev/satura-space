import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type MouseEvent, type ReactNode } from 'react'
import type { FrameLoad, FrameView } from '@shared/report-frame'
import { resolveReportPath, type ReportLocation } from '@shared/report-link'
import { CODE_EXTENSIONS } from '@shared/report-code'
import { ReportBoundary, RuntimeError, build, evaluate, type Loaded, type Mapper } from '../components/report/report-eval'
import { ReportApi, ReportContext, ReportSavedContext, ReportStore, type ReportBridge } from '../components/report/report-context'
import { ReportOverlay, type ImageGallery, type ImageHint, type Overlay } from '../components/report/ReportOverlay'
import { anchorTest } from '../components/report/report-blocks'
import { forgetBridgeCodeRefs, parseCodeHref } from '../components/report/code-ref'
import type { ReportView } from '../components/report/report-view-state'
import { LineMap, evalLineOffset, mapStack } from '../components/report/source-map'
import { mediaLoader } from '../lib/media-loader'
import { emit } from './channel'

function Rendered({ onRendered, children }: { onRendered: () => void; children: ReactNode }) {
  useEffect(() => {
    onRendered()
  }, [onRendered])
  return <>{children}</>
}

function viewSnapshot(view: ReportView): Omit<FrameView, 'scrollTop'> {
  return { frames: [...view.frames], states: [...view.states], blocks: view.blocks }
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? ''
  } catch {
    return String(Math.random())
  }
}

export function makeView(load: FrameLoad): ReportView {
  return { file: load.file, scrollTop: load.view.scrollTop, frames: new Map(load.view.frames), states: new Map(load.view.states), blocks: load.view.blocks }
}

export function FrameReport({ load, view, zoom, bridge, mediaUrl }: { load: FrameLoad; view: ReportView; zoom: number; bridge: ReportBridge; mediaUrl?: (path: string) => string }) {
  const [overlay, setOverlay] = useState<Overlay | null>(null)
  const [retry, setRetry] = useState(0)
  const [renderError, setRenderError] = useState<{ key: string; text: string } | null>(null)
  const [renderedKey, setRenderedKey] = useState('')
  const [empty, setEmpty] = useState('')
  const hostRef = useRef<HTMLDivElement>(null)
  const initialRef = useRef<ReportLocation | null>(load.initial)
  const fileRef = useRef(load.file)
  if (fileRef.current !== load.file) {
    fileRef.current = load.file
    initialRef.current = load.initial
  }
  const renderKey = `${load.version}.${retry}`
  const url = useMemo(() => encodeURI(load.file.replace(/\\/g, '/')), [load.file])
  const mapper = useMemo<Mapper>(() => {
    const lines = new LineMap(load.map)
    const offset = evalLineOffset(build)
    return { shown: load.shown, map: (text) => mapStack(text, url, load.shown, lines, offset) }
  }, [load.map, load.shown, url])
  const loaded = useMemo<Loaded>(
    () => evaluate({ ok: true, file: load.file, stamp: load.stamp, code: load.code, diagnostics: [], text: '', ms: 0 }, mapper, url),
    [load.file, load.stamp, load.code, mapper, url]
  )
  useEffect(() => forgetBridgeCodeRefs(bridge), [bridge, load.stamp, load.version])

  const store = useMemo(() => {
    void renderKey
    return new ReportStore()
  }, [renderKey])

  const titled = useRef('')
  const api = useMemo(
    () =>
      new ReportApi({
        file: load.file,
        root: load.root,
        version: renderKey,
        store,
        get initial() {
          return initialRef.current
        },
        set initial(v: ReportLocation | null) {
          initialRef.current = v
        },
        frames: view.frames,
        states: view.states,
        scroller: hostRef,
        view,
        bridge,
        mediaUrl,
        showImage: (u: string, alt?: string, gallery?: ImageGallery, hint?: ImageHint) => setOverlay({ kind: 'image', url: u, alt: alt ?? '', gallery, path: hint?.path, size: hint?.size }),
        showCode: (target: { ref: string; line?: number; endLine?: number }) => emit({ e: 'showCode', ref: target.ref, line: target.line, endLine: target.endLine }),
        copyLink: (link: string) => emit({ e: 'copy', text: link, toast: true }),
        setTitle: (t: string) => {
          if (t.trim()) titled.current = renderKey
          emit({ e: 'title', text: String(t).slice(0, 1024) })
        },
        openReport: (f: string, loc: ReportLocation) => emit({ e: 'openReport', file: f, loc: { video: loc.video, frame: loc.frame, t: loc.t } }),
        openFile: (f: string, line?: number, column?: number) => emit({ e: 'openFile', path: f, line, column })
      }),
    [load.file, load.root, renderKey, store, view, bridge, mediaUrl]
  )

  const onRendered = useCallback(() => {
    setRenderedKey(renderKey)
    if (titled.current !== renderKey) store.warn('The report has no title. Wrap it in <Report title="..."> with a short name for what was built or tested.')
  }, [renderKey, store])
  const onError = useCallback((text: string) => setRenderError({ key: renderKey, text }), [renderKey])
  const element = useMemo(() => {
    const C = loaded.Component
    return C ? <C /> : null
  }, [loaded])

  let phase: 'loading' | 'rendering' | 'ok' | 'error' = 'loading'
  if (loaded.error || renderError?.key === renderKey) phase = 'error'
  else if (element) phase = renderedKey === renderKey ? 'ok' : 'rendering'
  const snap = useSyncExternalStore(store.subscribe, store.get)
  const errorText = loaded.error ?? (renderError?.key === renderKey ? renderError.text : '')

  useLayoutEffect(() => {
    if (phase !== 'ok') {
      setEmpty('')
      return
    }
    const report = hostRef.current?.querySelector('.rk-report')
    setEmpty(report && !report.childElementCount && !report.textContent?.trim() ? renderKey : '')
  }, [phase, renderKey, element])

  const statusKey = `${load.version}|${phase}|${snap.pending}|${snap.warnings.join('\n')}|${errorText}|${empty === renderKey}`
  useEffect(() => {
    emit({ e: 'status', status: { version: load.version, phase, pending: snap.pending, warnings: snap.warnings.slice(0, 200).map((w) => w.slice(0, 4000)), error: errorText.slice(0, 60000), empty: empty === renderKey } })
  }, [statusKey])

  const sentView = useRef('')
  useEffect(() => {
    const send = (): void => {
      const snapView = viewSnapshot(view)
      const key = safeJson(snapView)
      if (key === sentView.current) return
      sentView.current = key
      emit({ e: 'view', view: snapView })
    }
    const t = window.setInterval(send, 400)
    return () => {
      window.clearInterval(t)
      send()
    }
  }, [view])

  const onClickCapture = (e: MouseEvent): void => {
    const a = (e.target as HTMLElement | null)?.closest?.('a[href]') as HTMLAnchorElement | null
    if (!a) return
    const href = a.getAttribute('href') ?? ''
    const code = parseCodeHref(href)
    e.preventDefault()
    e.stopPropagation()
    if (code) {
      emit({ e: 'showCode', ref: code.path, line: code.line, endLine: code.endLine })
      return
    }
    if (href.startsWith('#')) {
      let id = ''
      try {
        id = decodeURIComponent(href.slice(1))
      } catch {
        return
      }
      const find = (): HTMLElement | null => hostRef.current?.querySelector<HTMLElement>(`#${CSS.escape(id)}`) ?? null
      void api.reveal(anchorTest(id), find).then((target) => {
        const host = hostRef.current
        if (!target || !host) return
        const hb = host.getBoundingClientRect()
        const far = Math.abs(target.getBoundingClientRect().top - hb.top) > hb.height * 2
        if (!far || !api.jumpTo(target, 'start')) target.scrollIntoView({ block: 'start', behavior: far ? 'auto' : 'smooth' })
      })
      return
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) && !/^[A-Za-z]:[\\/]/.test(href)) {
      api.host.copyLink(href)
      return
    }
    let local = href.split('#')[0].split('?')[0]
    try {
      local = decodeURIComponent(local)
    } catch {
      return
    }
    const target = resolveReportPath(load.file, local)
    const ext = target.slice(target.lastIndexOf('.') + 1).toLowerCase()
    if (/(^|\/)report\.tsx$|\.report\.tsx$/i.test(target)) api.host.openReport(target, {})
    else if (/^(png|jpe?g|gif|webp|avif|svg)$/.test(ext) && !api.host.mediaUrl && mediaLoader()?.plan) setOverlay({ kind: 'image', url: api.url(target), path: api.path(target), alt: local })
    else if (/^(png|jpe?g|gif|webp|avif|svg)$/.test(ext)) void api.resolve(target).then((u) => setOverlay({ kind: 'image', url: u, alt: local }), () => api.host.copyLink(target))
    else if (CODE_EXTENSIONS.has(ext)) emit({ e: 'showCode', ref: target })
    else api.host.copyLink(target)
  }

  useLayoutEffect(() => {
    const host = hostRef.current
    if (!host) return
    const virtual = !!host.querySelector('[data-rk-blocks]')
    const target = virtual ? 0 : view.scrollTop
    const content = host.firstElementChild as HTMLElement | null
    let hiding = target > 0
    let pinned = target > 0
    const started = performance.now()
    if (hiding) content?.classList.add('rk-restoring')
    const reveal = (): void => {
      if (!hiding) return
      hiding = false
      content?.classList.remove('rk-restoring')
    }
    const apply = (): void => {
      if (!pinned) return
      host.scrollTop = target
      if (Math.abs(host.scrollTop - target) < 2 || performance.now() - started > 700) reveal()
      if (performance.now() - started > 2500) pinned = false
    }
    apply()
    const ro = new ResizeObserver(apply)
    if (content) ro.observe(content)
    const giveUp = window.setTimeout(() => {
      apply()
      reveal()
    }, 700)
    const stop = (): void => {
      pinned = false
      reveal()
    }
    let sendTimer = 0
    const onScroll = (): void => {
      if (hiding) return
      view.scrollTop = host.scrollTop
      if (sendTimer) return
      sendTimer = window.setTimeout(() => {
        sendTimer = 0
        emit({ e: 'view', view: { scrollTop: view.scrollTop } })
      }, 150)
    }
    host.addEventListener('scroll', onScroll, { passive: true })
    host.addEventListener('wheel', stop, { passive: true })
    host.addEventListener('pointerdown', stop)
    host.addEventListener('keydown', stop)
    return () => {
      ro.disconnect()
      window.clearTimeout(giveUp)
      if (sendTimer) {
        window.clearTimeout(sendTimer)
        emit({ e: 'view', view: { scrollTop: view.scrollTop } })
      }
      host.removeEventListener('scroll', onScroll)
      host.removeEventListener('wheel', stop)
      host.removeEventListener('pointerdown', stop)
      host.removeEventListener('keydown', stop)
    }
  }, [renderKey, element, view])

  useLayoutEffect(() => {
    const host = hostRef.current
    const report = host?.querySelector<HTMLElement>('.rk-report')
    if (!host || !report) return
    const z = (report as HTMLElement & { currentCSSZoom?: number }).currentCSSZoom
    const unit = typeof z === 'number' && z > 0 ? z : report.offsetWidth > 0 ? report.getBoundingClientRect().width / report.offsetWidth : 1
    host.style.setProperty('--rk-unit', String(Math.round((unit || 1) * 1000) / 1000))
  }, [zoom, element, loaded.error])

  const body = loaded.error ? (
    <RuntimeError text={loaded.error} />
  ) : (
    <div className="sr-scope rk-host" ref={hostRef} style={zoom !== 1 ? { zoom } : undefined} data-scaled={zoom !== 1 ? '' : undefined}>
      <div className="rk-report">
        <ReportContext.Provider value={api}>
          <ReportSavedContext.Provider value={load.savedAt}>
            <Rendered key={renderKey} onRendered={onRendered}>
              <ReportBoundary
                mapper={mapper}
                onError={onError}
                onRetry={() => {
                  setRenderError(null)
                  setRetry((n) => n + 1)
                }}
              >
                {element}
              </ReportBoundary>
            </Rendered>
          </ReportSavedContext.Provider>
        </ReportContext.Provider>
      </div>
    </div>
  )

  return (
    <div className="sr-scope absolute inset-0" data-frame-report onClickCapture={onClickCapture}>
      {body}
      {overlay?.kind === 'image' && <ReportOverlay overlay={overlay} file={load.file} root={load.root} onClose={() => setOverlay(null)} onChange={setOverlay} read={bridge.readCode} save={{ bridge, file: load.file, root: load.root }} />}
    </div>
  )
}
