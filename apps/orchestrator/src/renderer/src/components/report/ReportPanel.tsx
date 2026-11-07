import { isMobileLayout, useMobileBack } from '../../lib/mobile/mobile-back'
import { setPhoneScale, usePhoneScales } from '../../lib/mobile/phone-scales'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import type { ReportCompileResult, ReportDiagnostic } from '@shared/report-compile'
import type { ReportLocation } from '@shared/report-link'
import type { FrameEvent, FrameLoad, FrameStatus } from '@shared/report-frame'
import { DEFAULT_THEME } from '@shared/types'
import { useAppStore } from '../../store'
import { ReportOverlay, type Overlay } from './ReportOverlay'
import { noteImageAspect, noteMediaInfo, reportView, viewCaches, type ReportView } from './report-view-state'
import { useRemoteLink } from '../../lib/remote-link'
import { writeClipboard } from '../../lib/clipboard'
import { ReportFrame } from './ReportFrame'
import { frameChrome, frameMediaSetup, type FrameChannel, type FrameScope } from './frame-host'
import { ProgressBar } from '../../remote/motion'
import './report-kit.css'

export function applyFrameView(view: ReportView, ev: Extract<FrameEvent, { e: 'view' }>): void {
  if (typeof ev.view.scrollTop === 'number') view.scrollTop = ev.view.scrollTop
  if (ev.view.frames) view.frames = new Map(ev.view.frames)
  if (ev.view.states) view.states = new Map(ev.view.states)
  if (ev.view.blocks !== undefined) view.blocks = ev.view.blocks
  for (const [k, v] of ev.aspects ?? []) noteImageAspect(k, v, 1)
  for (const [k, v] of ev.infos ?? []) noteMediaInfo(k, v)
}

function CompileErrors({ diagnostics, text, onOpen }: { diagnostics: ReportDiagnostic[]; text: string; onOpen: (d: ReportDiagnostic) => void }) {
  const n = diagnostics.length
  return (
    <div className="rk-error">
      <div className="rk-error-box">
        <h2 className="rk-error-title">{n === 1 ? 'This report has 1 error' : `This report has ${n} errors`}</h2>
        <p className="rk-error-hint">Fix report.tsx and save it. The panel reloads by itself.</p>
        <div className="rk-error-pre rk-diag">
          {diagnostics.map((d, i) => (
            <div key={i} style={{ display: 'contents' }}>
              <span className="rk-diag-at" onClick={() => onOpen(d)} title="Open at this line">
                {d.line ? `${d.file.split('/').pop()}:${d.line}:${d.column}` : d.file.split('/').pop()}
              </span>
              <span className="rk-diag-msg">{d.code ? `${d.code} ${d.message}` : d.message}</span>
            </div>
          ))}
        </div>
        <pre hidden data-report-error>
          {text}
        </pre>
      </div>
    </div>
  )
}

type Phase = 'loading' | 'rendering' | 'ok' | 'error'

const SIZES_WAIT_MS = 1500
const PHONE_SIZES_WAIT_MS = 4000

function LoadError({ text, onRetry }: { text: string; onRetry: () => void }) {
  return (
    <div className="rk-error">
      <div className="rk-error-box">
        <h2 className="rk-error-title">Couldn't load this report</h2>
        <pre className="rk-error-pre" data-report-error>
          {text}
        </pre>
        <div>
          <button type="button" onClick={onRetry} className="rk-error-retry">
            Try again
          </button>
        </div>
      </div>
    </div>
  )
}

function StatusFrame({
  pending,
  warnings,
  error,
  stamp,
  phase,
  settled,
  children,
  onKeyDown
}: {
  pending: number
  warnings: string[]
  error: string
  stamp: string
  phase: Phase
  settled: boolean
  children: ReactNode
  onKeyDown: (e: KeyboardEvent) => void
}) {
  const snap = { pending, warnings }
  const status = phase === 'rendering' ? 'loading' : phase
  return (
    <div
      className="absolute inset-0 outline-none"
      tabIndex={-1}
      data-viewer-report
      data-report-stamp={stamp}
      data-report-status={status}
      data-report-pending={snap.pending}
      data-report-settled={settled && (phase === 'error' || snap.pending === 0) ? '' : undefined}
      onKeyDown={onKeyDown}
    >
      {children}
      {error && (
        <pre hidden data-report-error>
          {error}
        </pre>
      )}
      <div hidden>
        {snap.warnings.map((w, i) => (
          <span key={i} data-report-warning>
            {w}
          </span>
        ))}
      </div>
    </div>
  )
}

export function ReportPanel({
  file,
  rootPath,
  diskStamp,
  reloads,
  initial,
  onTitle,
  onReload,
  onOpenReport,
  onOpenFile,
  stateKey
}: {
  stateKey?: string
  file: string
  rootPath: string
  diskStamp: string
  reloads: number
  initial: ReportLocation | null
  onTitle: (title: string) => void
  onReload: () => void
  onOpenReport: (file: string, loc: ReportLocation) => void
  onOpenFile: (file: string, line?: number, column?: number) => void
}) {
  const [compiled, setCompiled] = useState<ReportCompileResult | null>(null)
  const [savedAt, setSavedAt] = useState<number | undefined>(undefined)
  const [ipcError, setIpcError] = useState<string | null>(null)
  const [compiling, setCompiling] = useState(false)
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [sizesKey, setSizesKey] = useState('')
  const link = useRemoteLink()
  const online = link?.online !== false
  const [frameStatus, setFrameStatus] = useState<FrameStatus | null>(null)
  const [settledKey, setSettledKey] = useState('')
  const [media, setMedia] = useState<{ key: string; media: FrameLoad['media'] } | null>(null)
  const [mediaError, setMediaError] = useState('')
  const view = useMemo(() => reportView(stateKey ?? '', file), [stateKey, file])
  const fileRef = useRef(file)
  const initialRef = useRef(initial)
  if (fileRef.current !== file) {
    fileRef.current = file
    initialRef.current = initial
  }
  const [overlay, setOverlay] = useState<Overlay | null>(null)
  useMobileBack(overlay ? () => setOverlay(null) : null, overlay?.kind === 'image' ? 'Image' : overlay ? 'Code' : '')
  const desktopZoom = useAppStore((s) => s.settings?.reportZoom ?? 1)
  const theme = useAppStore((s) => s.settings?.theme ?? DEFAULT_THEME)
  const phoneScales = usePhoneScales()
  const onPhone = isMobileLayout()
  const zoom = onPhone ? phoneScales.reportScale : desktopZoom
  const zoomKnown = !onPhone || phoneScales.loaded
  const [toast, setToast] = useState<{ text: string; n: number } | null>(null)
  useEffect(() => {
    if (!toast) return
    const t = window.setTimeout(() => setToast(null), 1600)
    return () => window.clearTimeout(t)
  }, [toast])
  const copyLink = useCallback((link: string) => {
    void writeClipboard(link)
    setToast((prev) => ({ text: 'Link copied', n: (prev?.n ?? 0) + 1 }))
  }, [])
  const shownZoom = useRef(zoom)
  const knewZoom = useRef(zoomKnown)
  useEffect(() => {
    const quiet = !knewZoom.current
    knewZoom.current = zoomKnown
    if (shownZoom.current === zoom) return
    shownZoom.current = zoom
    if (quiet) return
    setToast((prev) => ({ text: `Zoom ${Math.round(zoom * 100)}%`, n: (prev?.n ?? 0) + 1 }))
  }, [zoom, zoomKnown])
  const handlers = useRef({ onTitle, onOpenReport, onOpenFile, onReload })
  handlers.current = { onTitle, onOpenReport, onOpenFile, onReload }

  useEffect(() => {
    if (!online) return
    let alive = true
    setCompiling(true)
    window.api.app.compileReport(file, rootPath).then(
      (res) => {
        if (!alive) return
        setIpcError(null)
        setCompiling(false)
        setSavedAt(res.mtimeMs)
        setCompiled((prev) => (prev && prev.stamp === res.stamp && prev.ok === res.ok && prev.file === res.file ? prev : res))
      },
      (e: unknown) => {
        if (!alive) return
        setCompiling(false)
        setIpcError(e instanceof Error ? e.message : String(e))
      }
    )
    return () => {
      alive = false
    }
  }, [file, rootPath, diskStamp, reloads, online, loadAttempt])

  const mediaKey = `${file}\n${rootPath}`
  useEffect(() => {
    let alive = true
    setMediaError('')
    frameMediaSetup(file, rootPath).then(
      (m) => alive && setMedia({ key: mediaKey, media: m }),
      (e: unknown) => alive && setMediaError(e instanceof Error ? e.message : String(e))
    )
    return () => {
      alive = false
    }
  }, [file, rootPath, mediaKey])

  const current = compiled && compiled.file === file ? compiled : null
  const renderKey = `${current?.stamp ?? ''}.${reloads}`
  const shown = current?.diagnostics[0]?.file ?? (rootPath && file.startsWith(`${rootPath}/`) ? file.slice(rootPath.length + 1) : file)
  const mediaSetup = media?.key === mediaKey ? media.media : null
  const settingsRef = useRef({ zoom, online, theme })
  settingsRef.current = { zoom, online, theme }
  const load = useMemo<FrameLoad | null>(() => {
    if (!current?.ok || !mediaSetup) return null
    const caches = viewCaches()
    const s = settingsRef.current
    return {
      mode: 'report',
      file,
      root: rootPath,
      version: renderKey,
      stamp: current.stamp,
      code: current.code ?? '',
      map: current.map,
      shown,
      savedAt,
      initial: initialRef.current,
      view: { scrollTop: view.scrollTop, frames: [...view.frames], states: [...view.states], blocks: view.blocks },
      aspects: caches.aspects,
      infos: caches.infos,
      zoom: s.zoom,
      layout: isMobileLayout() ? 'mobile' : 'desktop',
      chrome: frameChrome(),
      theme: s.theme,
      media: mediaSetup,
      chunks: mediaSetup.kind === 'token' ? 'satura-report-frame://app/' : null,
      online: s.online,
      canAct: true
    }
  }, [current, mediaSetup, file, rootPath, renderKey, shown, savedAt, view])
  const scope = useMemo<FrameScope>(() => ({ mode: 'report', file, root: rootPath, canAct: true }), [file, rootPath])
  const settings = useMemo(() => ({ zoom, online, theme }), [zoom, online, theme])

  const onFrameEvent = useCallback(
    (ev: FrameEvent) => {
      switch (ev.e) {
        case 'status':
          setFrameStatus(ev.status)
          return
        case 'title':
          handlers.current.onTitle(ev.text)
          return
        case 'openReport':
          handlers.current.onOpenReport(ev.file, ev.loc)
          return
        case 'openFile':
          handlers.current.onOpenFile(ev.path, ev.line, ev.column)
          return
        case 'showCode':
          setOverlay({ kind: 'code', ref: ev.ref, line: ev.line, endLine: ev.endLine })
          return
        case 'copy':
          if (ev.toast) copyLink(ev.text)
          else void writeClipboard(ev.text)
          return
        case 'view':
          applyFrameView(view, ev)
          return
        case 'reload':
          handlers.current.onReload()
          return
        case 'zoom':
          if (onPhone) setPhoneScale({ reportScale: ev.scale }, ev.done)
          return
      }
    },
    [view, copyLink, onPhone]
  )
  const channelRef = useRef<FrameChannel | null>(null)
  const onChannel = useCallback((c: FrameChannel | null) => {
    channelRef.current = c
  }, [])

  const fs = frameStatus?.version === renderKey ? frameStatus : null
  let phase: Phase = 'loading'
  if ((ipcError && !current) || (current && !current.ok) || fs?.phase === 'error' || (mediaError && current?.ok)) phase = 'error'
  else if (fs?.phase === 'ok') phase = 'ok'
  else if (fs?.phase === 'rendering') phase = 'rendering'
  const snapPending = fs?.pending ?? 0

  useEffect(() => {
    if (phase !== 'ok') return
    const t = window.setTimeout(() => setSizesKey(renderKey), onPhone ? PHONE_SIZES_WAIT_MS : SIZES_WAIT_MS)
    return () => window.clearTimeout(t)
  }, [phase, renderKey, onPhone])
  const sizing = phase === 'ok' && (snapPending > 0 || !zoomKnown) && sizesKey !== renderKey && settledKey !== renderKey
  useEffect(() => {
    if (phase === 'error') {
      setSettledKey(renderKey)
      return
    }
    if (phase !== 'ok' || snapPending > 0 || !zoomKnown) return
    const t = window.setTimeout(() => setSettledKey(renderKey), 250)
    return () => window.clearTimeout(t)
  }, [phase, snapPending, renderKey, zoomKnown])

  const onKeyDown = (e: KeyboardEvent): void => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'r') {
      e.preventDefault()
      e.stopPropagation()
      handlers.current.onReload()
    }
  }

  useLayoutEffect(() => {
    if (!current?.ok) setFrameStatus(null)
  }, [current])

  let body: ReactNode
  if (ipcError && !current)
    body = (
      <LoadError
        text={online ? ipcError : 'Waiting for your desktop to reconnect.'}
        onRetry={() => {
          setIpcError(null)
          setLoadAttempt((n) => n + 1)
        }}
      />
    )
  else if (!current) body = null
  else if (!current.ok)
    body = (
      <CompileErrors
        diagnostics={current.diagnostics}
        text={current.text}
        onOpen={(d) => setOverlay({ kind: 'code', ref: file, line: d.line || undefined })}
      />
    )
  else if (mediaError)
    body = (
      <LoadError
        text={mediaError}
        onRetry={() => {
          setMediaError('')
          setMedia(null)
          setLoadAttempt((n) => n + 1)
        }}
      />
    )
  else
    body = (
      <ReportFrame
        scope={scope}
        load={load}
        settings={settings}
        onEvent={onFrameEvent}
        onChannel={onChannel}
        title={shown}
        className="absolute inset-0 h-full w-full border-0 bg-transparent"
      />
    )

  return (
    <StatusFrame
      pending={snapPending}
      warnings={fs?.warnings ?? []}
      error={fs?.phase === 'error' ? fs.error : ''}
      stamp={current?.stamp ?? ''}
      phase={phase}
      settled={settledKey === renderKey}
      onKeyDown={onKeyDown}
    >
      <div className="sr-scope absolute inset-0">
        {body}
        {fs?.empty && phase === 'ok' && (
          <div className="rk-empty" data-report-empty>
            This report is empty. Its report.tsx renders nothing yet.
          </div>
        )}
        {((phase !== 'ok' && phase !== 'error') || sizing) && (
          <div className="rk-loading" data-report-loading={!current ? (online ? 'compiling' : 'offline') : 'rendering'}>
            {online || current ? onPhone ? <ProgressBar value={null} className="rk-loading-bar" /> : <span className="rk-loading-spin" /> : null}
            <span>{!current ? (online ? 'Compiling the report' : 'Waiting for your desktop to reconnect') : 'Rendering the report'}</span>
          </div>
        )}
        {phase === 'ok' && compiling && !sizing && (
          <div className="rk-updating" data-report-updating>
            {onPhone ? <ProgressBar value={null} className="rk-updating-bar" /> : <span className="rk-loading-spin" />}
            <span>Updating</span>
          </div>
        )}
        {phase === 'ok' && !compiling && ipcError && (
          <div className="rk-updating" data-report-updating="failed">
            <span>{online ? "Couldn't update this report" : 'Your desktop is offline. Showing the last version.'}</span>
            {online && (
              <button
                type="button"
                onClick={() => {
                  setIpcError(null)
                  setLoadAttempt((n) => n + 1)
                }}
              >
                Try again
              </button>
            )}
          </div>
        )}
        {overlay && <ReportOverlay overlay={overlay} file={file} root={rootPath} onClose={() => setOverlay(null)} onChange={setOverlay} />}
        {toast && (
          <div key={toast.n} className="rk-toast" data-report-toast>
            {toast.text}
          </div>
        )}
      </div>
    </StatusFrame>
  )
}
