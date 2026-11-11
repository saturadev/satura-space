import { memo, useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { MoreHorizontal } from 'lucide-react'
import type { ReportCompileResult } from '@shared/report-compile'
import { buildDashboardAsk, snapshotText, widgetFile, type DashboardTile as Tile } from '@shared/dashboard'
import { buildPluginAsk, projectPluginFile } from '@shared/project-plugins'
import type { FrameEvent, FrameHook, FrameLoad, FrameTileStatus } from '@shared/report-frame'
import { DEFAULT_THEME } from '@shared/types'
import { AnchoredLayer } from '../ui/AnchoredLayer'
import { ActionMenu, ActionMenuItems, hasActionMenuPresenter } from '../../lib/actions/ActionMenu'
import type { ActionNode } from '../../lib/actions/action-tree'
import { ReportFrame } from '../report/ReportFrame'
import { frameChrome, frameMediaSetup, type FrameChannel, type FrameScope } from '../report/frame-host'
import { isMobileLayout } from '../../lib/mobile/mobile-back'
import { writeClipboard } from '../../lib/clipboard'
import { useAppStore } from '../../store'
import { AskBox } from './AskBox'
import { sendToAgent } from '../../lib/dashboard/send-agent'
import { debugLog } from '@shared/debug-log'
import { useRemoteLink } from '../../lib/remote-link'

export interface TilePlace {
  workspaceId: string
  worktreeId: string
  groupId: string
}

export interface TileRect {
  left: number
  top: number
  width: number
  height: number
}

const READY_CAP_MS = 8000

function Hooks({ list }: { list: FrameHook[] }) {
  return (
    <pre hidden data-dashboard-hooks>
      {JSON.stringify(list)}
    </pre>
  )
}

export const DashboardTileView = memo(function DashboardTileView({
  project,
  place,
  pageTitle,
  tile,
  index,
  version,
  known,
  state,
  series,
  rect,
  moving,
  onPointerDown,
  onReady,
  onOpenSource,
  plugin
}: {
  project: string
  place: TilePlace | null
  pageTitle: string
  tile: Tile
  index: number
  version: number
  known: boolean
  state: Record<string, unknown>
  series: Map<string, number[]>
  rect: TileRect
  moving: boolean
  onPointerDown: (e: ReactPointerEvent, index: number, mode: 'move' | 'resize') => void
  onReady: (widget: string, ready: boolean, failed: boolean) => void
  onOpenSource: (file: string, line?: number) => void
  plugin?: { name: string; title: string }
}) {
  const file = plugin ? projectPluginFile(project, plugin.name, 'panel.tsx') : widgetFile(project, tile.widget)
  const shown = plugin ? `.sspace/plugins/${plugin.name}/panel.tsx` : `.sspace/dashboard/widgets/${tile.widget}.tsx`
  const [compiled, setCompiled] = useState<ReportCompileResult | null>(null)
  const [ipcError, setIpcError] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  const [menu, setMenu] = useState<HTMLElement | null>(null)
  const [asking, setAsking] = useState<HTMLElement | null>(null)
  const [capped, setCapped] = useState(false)
  const [compiling, setCompiling] = useState(false)
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [tileStatus, setTileStatus] = useState<FrameTileStatus | null>(null)
  const [media, setMedia] = useState<{ key: string; media: FrameLoad['media'] } | null>(null)
  const [mediaError, setMediaError] = useState('')
  const menuRef = useRef<HTMLButtonElement>(null)
  const channelRef = useRef<FrameChannel | null>(null)
  const link = useRemoteLink()
  const online = link?.online !== false
  const theme = useAppStore((s) => s.settings?.theme ?? DEFAULT_THEME)

  useEffect(() => {
    if (!known || !online) return
    let alive = true
    setCompiling(true)
    window.api.app.compileReport(file, project).then(
      (res) => {
        if (!alive) return
        setIpcError(null)
        setCompiling(false)
        setCompiled((prev) => (prev && prev.stamp === res.stamp && prev.ok === res.ok ? prev : res))
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
  }, [file, project, version, known, online, loadAttempt])

  const mediaKey = `${file}\n${project}`
  useEffect(() => {
    if (!known) return
    let alive = true
    setMediaError('')
    frameMediaSetup(file, project).then(
      (m) => alive && setMedia({ key: mediaKey, media: m }),
      (e: unknown) => alive && setMediaError(e instanceof Error ? e.message : String(e))
    )
    return () => {
      alive = false
    }
  }, [file, project, mediaKey, known])

  const renderKey = `${compiled?.stamp ?? ''}.${retry}`
  const mediaSetup = media?.key === mediaKey ? media.media : null
  const settingsRef = useRef({ online, theme })
  settingsRef.current = { online, theme }
  const load = useMemo<FrameLoad | null>(() => {
    if (!compiled?.ok || !mediaSetup) return null
    const s = settingsRef.current
    return {
      mode: 'tile',
      file,
      root: project,
      version: renderKey,
      stamp: compiled.stamp,
      code: compiled.code ?? '',
      map: compiled.map,
      shown,
      initial: null,
      view: { scrollTop: 0, frames: [], states: [], blocks: null },
      aspects: [],
      infos: [],
      zoom: 1,
      layout: isMobileLayout() ? 'mobile' : 'desktop',
      chrome: frameChrome(),
      theme: s.theme,
      media: mediaSetup,
      chunks: mediaSetup.kind === 'token' ? 'satura-report-frame://app/' : null,
      online: s.online,
      canAct: true,
      tile: { widget: tile.widget, state, series: [...series].filter(([k]) => k.startsWith(`${tile.widget}\n`)) }
    }
  }, [compiled, mediaSetup, file, shown, project, renderKey, tile.widget, state, series])
  const scope = useMemo<FrameScope>(() => ({ mode: 'tile', file, root: project, canAct: true, tile: { widget: tile.widget, state } }), [file, project, tile.widget, state])
  const settings = useMemo(() => ({ online, theme }), [online, theme])
  const onFrameEvent = useCallback(
    (ev: FrameEvent) => {
      if (ev.e === 'tile') setTileStatus(ev.tile)
      else if (ev.e === 'openFile') onOpenSource(ev.path, ev.line)
      else if (ev.e === 'showCode') onOpenSource(ev.ref, ev.line)
      else if (ev.e === 'copy') void writeClipboard(ev.text)
      else if (ev.e === 'series') for (const [k, v] of ev.series) if (k.startsWith(`${tile.widget}\n`)) series.set(k, v)
    },
    [onOpenSource, series, tile.widget]
  )
  const onChannel = useCallback((c: FrameChannel | null) => {
    channelRef.current = c
  }, [])

  const ts = tileStatus?.version === renderKey ? tileStatus : null
  const title = ts?.title || plugin?.title || tile.widget
  const compileError = !known
    ? plugin
      ? `${plugin.name} has no panel. Add ${shown}.`
      : `There is no widget file for "${tile.widget}". Add .sspace/dashboard/widgets/${tile.widget}.tsx or fix the id in dashboard.json.`
    : compiled && !compiled.ok ? compiled.text : null
  const loadError = known && ipcError && !compiled ? ipcError : mediaError || null
  const runtimeError = ts?.status === 'error' ? ts.error : null
  const error = compileError ?? loadError ?? runtimeError
  const status = error ? 'error' : ts?.status !== 'ok' ? 'loading' : 'ok'
  const hookList = ts?.hooks ?? []
  const empty = status === 'ok' && !!ts?.rendered && !!ts?.empty

  useEffect(() => {
    setCapped(false)
    const t = window.setTimeout(() => setCapped(true), READY_CAP_MS)
    return () => window.clearTimeout(t)
  }, [renderKey])
  const ready = status === 'error' || (status === 'ok' && !!ts?.rendered && ((ts?.pending ?? 0) === 0 || capped))
  const failed = status === 'error'
  useEffect(() => {
    onReady(tile.widget, ready, failed)
  }, [onReady, tile.widget, ready, failed])

  const firstLine = compiled?.diagnostics[0]?.line
  const ask = async (question: string, to: Parameters<typeof sendToAgent>[1]) => {
    if (!place) return { sent: false as const, error: 'This panel is not in a workspace.' }
    const data = await (channelRef.current?.query<unknown[]>({ q: 'hooks' }, 5000).catch(() => []) ?? Promise.resolve([]))
    const snapshot = error ? `error: ${error.split('\n').slice(0, 6).join(' ')}` : data.length ? snapshotText(data.length === 1 ? data[0] : data) : ''
    const text = plugin ? buildPluginAsk({ name: plugin.name, title, question, snapshot }) : buildDashboardAsk({ widget: tile.widget, title, file: shown, page: pageTitle, question, snapshot })
    const r = await sendToAgent(place, to, text)
    debugLog(`[${plugin ? 'plugin' : 'dashboard'}] ask about ${tile.widget}${plugin ? '' : ` on page ${pageTitle}`}: ${r.sent ? `sent to ${r.label}` : r.error}`)
    return r.sent ? { sent: true as const, label: r.label } : r
  }

  const menuNodes: ActionNode[] = [
    { id: 'dashboard.tile.ask', label: 'Ask an agent…', icon: 'bubble.left', run: () => setAsking(menuRef.current) },
    { id: 'dashboard.tile.source', label: 'Open source', icon: 'chevron.left.forwardslash.chevron.right', enabled: known, run: () => onOpenSource(file) },
    { id: 'dashboard.tile.reload', label: 'Reload', icon: 'arrow.clockwise', run: () => setRetry((n) => n + 1) }
  ]
  const menuAt = (): { x: number; y: number } => {
    const b = menu?.getBoundingClientRect()
    return b ? { x: b.right, y: b.bottom } : { x: 0, y: 0 }
  }

  return (
    <div
      className={`dk-tile${plugin ? ' fill' : ''}${moving ? ' moving' : ''}${status === 'error' ? ' failed' : ''}`}
      style={plugin ? undefined : { left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
      data-dashboard-tile={tile.widget}
      data-dashboard-title={title}
      data-dashboard-status={status}
      data-dashboard-index={index}
    >
      <div className="dk-tile-head" onPointerDown={(e) => onPointerDown(e, index, 'move')} data-dashboard-drag>
        <span className={`dk-tile-dot ${status === 'ok' && compiling ? 'loading' : status}`} />
        <span className="dk-tile-title" title={`${title}  ·  ${plugin ? `plugins/${plugin.name}/panel.tsx` : `widgets/${tile.widget}.tsx`}`}>
          {title}
        </span>
        <button
          ref={menuRef}
          type="button"
          className="dk-icon-btn"
          aria-label={`${title} menu`}
          title="Ask, open source, reload"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => setMenu((m) => (m ? null : menuRef.current))}
        >
          <MoreHorizontal size={14} />
        </button>
      </div>
      <div className="dk-tile-body" data-dashboard-body>
        {loadError && !compileError ? (
          <div className="dk-tile-error" data-dashboard-wait={online ? 'error' : 'offline'}>
            <span>{online ? `Couldn't load this ${plugin ? 'panel' : 'widget'} from your desktop. ${loadError}` : 'Waiting for your desktop to reconnect'}</span>
            {online && (
              <div className="dk-tile-error-actions">
                <button
                  type="button"
                  className="dk-btn"
                  onClick={() => {
                    setIpcError(null)
                    setLoadAttempt((n) => n + 1)
                  }}
                >
                  Try again
                </button>
              </div>
            )}
          </div>
        ) : error ? (
          <div className="dk-tile-error">
            <pre data-dashboard-error>{error}</pre>
            <div className="dk-tile-error-actions">
              {known && (
                <button type="button" className="dk-btn" onClick={() => onOpenSource(file, firstLine)}>
                  Open source
                </button>
              )}
              {runtimeError && !compileError && (
                <button type="button" className="dk-btn" onClick={() => setRetry((n) => n + 1)}>
                  Try again
                </button>
              )}
              <button type="button" className="dk-btn" onClick={(e) => setAsking(e.currentTarget)}>
                Ask an agent…
              </button>
            </div>
          </div>
        ) : null}
        {compiled?.ok && !compileError && (
          <ReportFrame
            scope={scope}
            load={load}
            settings={settings}
            onEvent={onFrameEvent}
            onChannel={onChannel}
            title={title}
            className="absolute inset-0 h-full w-full border-0 bg-transparent"
            style={error ? { visibility: 'hidden' } : undefined}
          />
        )}
        {status === 'loading' && (
          <div className="dk-tile-wait" data-dashboard-wait={online ? 'loading' : 'offline'}>
            {online && <span className="rk-media-spin" />}
            <span>{online ? `Loading the ${plugin ? 'panel' : 'widget'}` : 'Waiting for your desktop to reconnect'}</span>
          </div>
        )}
        {empty && (
          <div className="dk-tile-wait" data-dashboard-wait="empty">
            <span>This {plugin ? 'panel' : 'widget'} shows nothing yet</span>
          </div>
        )}
        <Hooks list={hookList} />
        <pre hidden data-dashboard-outline>
          {ts?.outline ?? ''}
        </pre>
      </div>
      {!plugin && <div className="dk-resize" onPointerDown={(e) => onPointerDown(e, index, 'resize')} title="Drag to resize" />}
      {menu && hasActionMenuPresenter() && <ActionMenu {...menuAt()} nodes={menuNodes} onDismiss={() => setMenu(null)} />}
      {menu && !hasActionMenuPresenter() && (
        <AnchoredLayer anchor={menu} side="bottom" align="end" className="animate-menu-pop-in surface-overlay z-50 w-44 rounded-lg p-1">
          <div data-menu-layer role="menu" onMouseLeave={() => undefined}>
            <ActionMenuItems nodes={menuNodes} onPicked={() => setMenu(null)} />
          </div>
        </AnchoredLayer>
      )}
      {menu && !hasActionMenuPresenter() && <MenuDismiss anchor={menu} onClose={() => setMenu(null)} />}
      {asking && place && <AskBox anchor={asking} workspaceId={place.workspaceId} title={title} onSend={ask} onClose={() => setAsking(null)} />}
    </div>
  )
})

function MenuDismiss({ anchor, onClose }: { anchor: HTMLElement; onClose: () => void }) {
  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      const t = e.target as Element | null
      if (anchor.contains(t) || t?.closest?.('[data-menu-layer]')) return
      onClose()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [anchor, onClose])
  return null
}
