import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type PointerEvent as ReactPointerEvent } from 'react'
import { Plus, X } from 'lucide-react'
import {
  DASHBOARD_COLS,
  DASHBOARD_ROW_PX,
  buildAlertMessage,
  type DashboardAlertState,
  type DashboardLoad,
  type DashboardPage,
  type DashboardTile as Tile
} from '@shared/dashboard'
import { useAppStore } from '../../store'
import { openFileInWorkbench } from '../../lib/editor/open-file'
import { dashboardPage, setDashboardPage, subscribeDashboardPage } from '../../lib/dashboard/open-dashboard'
import { useDashboardAlerts } from '../../lib/dashboard/alerts-store'
import { sendToAgent } from '../../lib/dashboard/send-agent'
import { registerViewerFind } from '../../lib/shortcuts/pane-actions'
import { FindInViewBar } from '../workbench/FindInViewBar'
import { AskDriftPicker } from '../tuner/AskDriftPicker'
import { compact, section, usePanelActions, type ActionNode } from '../../lib/actions/action-tree'
import { isMobileLayout } from '../../lib/mobile/mobile-back'
import { DashboardTileView, type TilePlace, type TileRect } from './DashboardTile'
import '../report/report-kit.css'
import { useRemoteLink } from '../../lib/remote-link'
import './dashboard.css'
import { debugLog } from '@shared/debug-log'

const GAP = 10
const PAD = 16

type Box = { x: number; y: number; w: number; h: number }
type Drag = { index: number; mode: 'move' | 'resize'; sx: number; sy: number; orig: Box; cur: Box }

function overlap(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

function settle(tiles: Tile[], moved: number, box: Box): Box[] {
  const out: Box[] = tiles.map((t) => ({ x: t.x, y: t.y, w: t.w, h: t.h }))
  out[moved] = box
  const placed: Box[] = [box]
  const order = out.map((b, i) => ({ b, i })).filter((o) => o.i !== moved).sort((a, b) => a.b.y - b.b.y || a.b.x - b.b.x)
  for (const o of order) {
    const c = { ...o.b }
    for (let guard = 0; guard < 200; guard++) {
      const hit = placed.filter((p) => overlap(p, c))
      if (!hit.length) break
      c.y = Math.max(...hit.map((p) => p.y + p.h))
    }
    out[o.i] = c
    placed.push(c)
  }
  return out
}

const STACK_MIN_ROWS = 4
const STACK_TWO_COLS_PX = 560

function stackBoxes(tiles: Tile[], width: number): { rects: TileRect[]; height: number } {
  const cols = width >= STACK_TWO_COLS_PX ? 2 : 1
  const colW = (Math.max(0, width - PAD * 2) - GAP * (cols - 1)) / cols
  const tops = new Array<number>(cols).fill(PAD)
  const order = tiles.map((t, i) => ({ t, i })).sort((a, b) => a.t.y - b.t.y || a.t.x - b.t.x)
  const rects: TileRect[] = new Array(tiles.length)
  for (const { t, i } of order) {
    const c = tops.indexOf(Math.min(...tops))
    const height = Math.max(STACK_MIN_ROWS, t.h) * DASHBOARD_ROW_PX - GAP
    rects[i] = { left: PAD + c * (colW + GAP), top: tops[c], width: Math.max(40, colW), height }
    tops[c] += height + GAP
  }
  return { rects, height: Math.max(...tops) + PAD }
}

function usePlace(tabId: string): TilePlace | null {
  const key = useAppStore((s) => {
    for (const [workspaceId, tabs] of Object.entries(s.tabsByWorkspace)) {
      const t = tabs.find((x) => x.id === tabId)
      if (t) return `${workspaceId}\n${t.worktreeId}\n${t.groupId}`
    }
    return ''
  })
  return useMemo(() => {
    const [workspaceId, worktreeId, groupId] = key.split('\n')
    return workspaceId && worktreeId && groupId ? { workspaceId, worktreeId, groupId } : null
  }, [key])
}

function PageTab({
  page,
  active,
  index,
  canDelete,
  editing,
  onPick,
  onRename,
  onEdit,
  onDelete,
  onMove
}: {
  page: DashboardPage
  active: boolean
  index: number
  canDelete: boolean
  editing: boolean
  onPick: () => void
  onRename: (title: string) => void
  onEdit: (on: boolean) => void
  onDelete: () => void
  onMove: (from: string, to: number) => void
}) {
  const [confirm, setConfirm] = useState(false)
  const [draft, setDraft] = useState(page.title)
  useEffect(() => {
    if (!confirm) return
    const t = window.setTimeout(() => setConfirm(false), 3000)
    return () => window.clearTimeout(t)
  }, [confirm])
  useEffect(() => {
    if (editing) setDraft(page.title)
  }, [editing, page.title])
  if (editing) {
    return (
      <input
        autoFocus
        className="dk-page-input"
        value={draft}
        aria-label="Page name"
        onChange={(e) => setDraft(e.target.value)}
        onFocus={(e) => e.currentTarget.select()}
        onBlur={() => {
          onEdit(false)
          if (draft.trim() && draft.trim() !== page.title) onRename(draft.trim())
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
          if (e.key === 'Escape') {
            setDraft(page.title)
            onEdit(false)
          }
        }}
      />
    )
  }
  return (
    <div
      className={`dk-page${active ? ' on' : ''}`}
      draggable
      onDragStart={(e) => e.dataTransfer.setData('text/x-dashboard-page', page.id)}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('text/x-dashboard-page')) e.preventDefault()
      }}
      onDrop={(e) => {
        const from = e.dataTransfer.getData('text/x-dashboard-page')
        if (from && from !== page.id) onMove(from, index)
      }}
    >
      <button
        type="button"
        role="tab"
        aria-selected={active}
        className="dk-page-btn"
        data-dashboard-page-tab={page.id}
        title={active ? 'Double-click to rename, drag to reorder' : page.title}
        onClick={onPick}
        onDoubleClick={() => onEdit(true)}
      >
        {page.title}
      </button>
      {active && canDelete &&
        (confirm ? (
          <button type="button" className="dk-page-del confirm" onClick={onDelete}>
            Delete page
          </button>
        ) : (
          <button type="button" className="dk-page-x" aria-label={`Delete page ${page.title}`} title="Delete this page" onClick={() => setConfirm(true)}>
            <X size={12} />
          </button>
        ))}
    </div>
  )
}

function AlertChip({ alert, place, project }: { alert: DashboardAlertState; place: TilePlace | null; project: string }) {
  const [picker, setPicker] = useState<HTMLElement | null>(null)
  const [note, setNote] = useState('')
  const tone = alert.status === 'firing' ? 'k-error' : alert.status === 'error' ? 'k-warn' : alert.status === 'ok' ? 'k-ok' : 'k-info'
  const what =
    alert.status === 'firing'
      ? `Firing: ${alert.message ?? ''}${alert.deliveredTo ? `\nSent to ${alert.deliveredTo.length > 20 ? 'an agent' : alert.deliveredTo}` : ''}`
      : alert.status === 'error'
        ? `The alert is broken: ${alert.error ?? ''}`
        : alert.status === 'ok'
          ? `Quiet. Checks every ${alert.every}s.`
          : 'Starting'
  const send = alert.status === 'firing' && alert.undelivered && !!place
  return (
    <span className={`dk-alert ${tone}${alert.undelivered && alert.status === 'firing' ? ' loud' : ''}`} data-dashboard-alert={alert.id} data-dashboard-alert-status={alert.status} title={what}>
      <span className={`sr-dot ${tone}`} />
      {alert.id}
      {send && (
        <button type="button" className="dk-alert-send" onClick={(e) => setPicker(e.currentTarget)}>
          {note || 'Send to agent…'}
        </button>
      )}
      {picker && place && (
        <AskDriftPicker
          anchor={picker}
          workspaceId={place.workspaceId}
          current=""
          onClose={() => setPicker(null)}
          onPick={(to) => {
            setPicker(null)
            const text = buildAlertMessage({ id: alert.id, file: `.sspace/dashboard/alerts/${alert.id}.ts`, message: alert.message ?? '', data: '' })
            void sendToAgent(place, to, text).then((r) => {
              debugLog(`[dashboard] alert ${alert.id} sent by hand: ${r.sent ? `to ${r.label}` : r.error}`)
              if (r.sent) window.api.dashboard.alertSent(project, alert.id, r.ptyId)
              else setNote(r.error)
            })
          }}
        />
      )}
    </span>
  )
}

export function PaneDashboardSlot({ tabId, projectPath }: { tabId: string; projectPath: string }) {
  const project = projectPath.replace(/\\/g, '/').replace(/\/+$/, '')
  const place = usePlace(tabId)
  const [load, setLoad] = useState<DashboardLoad | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [reloads, setReloads] = useState(0)
  const [versions, setVersions] = useState<Record<string, number>>({})
  const [editing, setEditing] = useState<string | null>(null)
  const [drag, setDrag] = useState<Drag | null>(null)
  const [width, setWidth] = useState(0)
  const [ready, setReady] = useState<Record<string, { ready: boolean; failed: boolean }>>({})
  const [find, setFind] = useState<{ seq: number } | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const zoom = useAppStore((s) => s.settings?.reportZoom ?? 1)
  const stacked = isMobileLayout()
  const hostRef = useRef<HTMLDivElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const series = useMemo(() => new Map<string, number[]>(), [])
  const alerts = useDashboardAlerts(project)
  const wanted = useSyncExternalStore(subscribeDashboardPage, () => dashboardPage(project))

  const editSeq = useRef(0)
  const editsPending = useRef(0)
  const link = useRemoteLink()
  const online = link?.online !== false
  useEffect(() => {
    if (!online) return
    let alive = true
    const seq = editSeq.current
    window.api.dashboard.load(project).then(
      (res) => {
        if (!alive || editsPending.current > 0 || seq !== editSeq.current) return
        setLoad(res)
        setLoadError(null)
      },
      (e: unknown) => alive && setLoadError(e instanceof Error ? e.message : String(e))
    )
    return () => {
      alive = false
    }
  }, [project, reloads, online])

  useEffect(
    () =>
      window.api.dashboard.watch(project, (files) => {
        const widgets = files.filter((f) => /^widgets\/[^/]+\.tsx$/.test(f)).map((f) => f.slice(8, -4))
        if (widgets.length) setVersions((v) => Object.fromEntries([...Object.entries(v), ...widgets.map((w) => [w, (v[w] ?? 0) + 1])]))
        if (files.some((f) => f === '' || f === 'dashboard.json' || f.startsWith('widgets'))) setReloads((n) => n + 1)
      }),
    [project]
  )

  useEffect(() => registerViewerFind(tabId, () => setFind((f) => ({ seq: (f?.seq ?? 0) + 1 }))), [tabId])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const ro = new ResizeObserver(() => setWidth(host.clientWidth))
    ro.observe(host)
    setWidth(host.clientWidth)
    return () => ro.disconnect()
  }, [load?.exists])

  const doc = load?.doc
  const page = doc?.pages.find((p) => p.id === wanted) ?? doc?.pages[0]
  const pageId = page?.id ?? ''
  const tiles = useMemo(() => page?.tiles ?? [], [page])

  useEffect(() => {
    setReady({})
  }, [pageId])

  const edit = useCallback(
    (e: Parameters<typeof window.api.dashboard.edit>[1]) => {
      const seq = ++editSeq.current
      editsPending.current++
      window.api.dashboard.edit(project, e).then(
        (res) => {
          editsPending.current--
          if (seq === editSeq.current) setLoad(res)
          setSaveError(null)
        },
        (err: unknown) => {
          editsPending.current--
          setSaveError(err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(err))
          if (seq === editSeq.current) setReloads((n) => n + 1)
        }
      )
    },
    [project]
  )

  const onReady = useCallback((widget: string, ok: boolean, failed: boolean) => {
    setReady((r) => (r[widget]?.ready === ok && r[widget]?.failed === failed ? r : { ...r, [widget]: { ready: ok, failed } }))
  }, [])

  const onOpenSource = useCallback(
    (file: string, line?: number) => {
      const abs = file.startsWith('/') || /^[A-Za-z]:[\\/]/.test(file) ? file : `${project}/${file}`
      openFileInWorkbench({ file: abs, line, projectPath: project, text: true, sourceGroupId: place?.groupId })
    },
    [project, place?.groupId]
  )

  const inner = Math.max(0, width - PAD * 2)
  const col = (inner + GAP) / DASHBOARD_COLS

  const onPointerDown = useCallback(
    (e: ReactPointerEvent, index: number, mode: 'move' | 'resize') => {
      if (stacked || e.button !== 0 || (e.target as Element).closest('button')) return
      const t = tiles[index]
      if (!t) return
      e.preventDefault()
      const box = { x: t.x, y: t.y, w: t.w, h: t.h }
      setDrag({ index, mode, sx: e.clientX, sy: e.clientY, orig: box, cur: box })
    },
    [tiles, stacked]
  )

  const dragRef = useRef(drag)
  dragRef.current = drag
  const pageRef = useRef(page)
  pageRef.current = page
  useEffect(() => {
    if (!drag) return
    const move = (e: PointerEvent): void => {
      const d = dragRef.current
      if (!d || col <= 0) return
      const dx = (e.clientX - d.sx) / zoom
      const dy = (e.clientY - d.sy) / zoom
      const o = d.orig
      const cur =
        d.mode === 'move'
          ? { ...o, x: Math.max(0, Math.min(DASHBOARD_COLS - o.w, Math.round(o.x + dx / col))), y: Math.max(0, Math.round(o.y + dy / DASHBOARD_ROW_PX)) }
          : { ...o, w: Math.max(1, Math.min(DASHBOARD_COLS - o.x, Math.round(o.w + dx / col))), h: Math.max(1, Math.round(o.h + dy / DASHBOARD_ROW_PX)) }
      if (cur.x !== d.cur.x || cur.y !== d.cur.y || cur.w !== d.cur.w || cur.h !== d.cur.h) setDrag({ ...d, cur })
    }
    const up = (): void => {
      const d = dragRef.current
      setDrag(null)
      const page = pageRef.current
      if (!d || !page) return
      const o = d.orig
      const c = d.cur
      if (o.x === c.x && o.y === c.y && o.w === c.w && o.h === c.h) return
      const next = settle(page.tiles, d.index, c)
      const changed = next
        .map((b, index) => ({ index, ...b }))
        .filter((b) => {
          const t = page.tiles[b.index]
          return t.x !== b.x || t.y !== b.y || t.w !== b.w || t.h !== b.h
        })
      setLoad((l) =>
        l ? { ...l, doc: { ...l.doc, pages: l.doc.pages.map((p) => (p.id === page.id ? { ...p, tiles: p.tiles.map((t, i) => ({ ...t, ...next[i] })) } : p)) } } : l
      )
      edit({ kind: 'tiles', page: page.id, tiles: changed })
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
    }
  }, [drag !== null, col, zoom, edit])

  const rectOf = (b: Box): TileRect => ({
    left: PAD + b.x * col,
    top: PAD + b.y * DASHBOARD_ROW_PX,
    width: Math.max(40, b.w * col - GAP),
    height: Math.max(30, b.h * DASHBOARD_ROW_PX - GAP)
  })
  const boxes = tiles.map((t, i) => (drag?.index === i ? drag.cur : { x: t.x, y: t.y, w: t.w, h: t.h }))
  const rows = Math.max(8, ...boxes.map((b) => b.y + b.h)) + (drag ? 6 : 2)
  const stack = useMemo(() => (stacked ? stackBoxes(tiles, width) : null), [stacked, tiles, width])
  const known = useMemo(() => new Set(load?.widgets ?? []), [load?.widgets])
  const failed = tiles.filter((t) => ready[t.widget]?.failed).map((t) => t.widget)
  const settled = !!load && (!load.exists || tiles.every((t) => ready[t.widget]?.ready))
  const stateOf = useMemo(() => {
    const cache = new Map<string, Record<string, unknown>>()
    return (w: string): Record<string, unknown> => {
      let s = cache.get(w)
      if (!s) cache.set(w, (s = { ...(load?.state[w] ?? {}) }))
      return s
    }
  }, [load?.exists, project])

  const addPage = (title?: string): void => {
    if (!doc) return
    const name = title?.trim() || `Page ${doc.pages.length + 1}`
    window.api.dashboard.edit(project, { kind: 'addPage', title: name }).then(
      (res) => {
        setLoad(res)
        const added = res.doc.pages[res.doc.pages.length - 1]
        if (added) {
          setDashboardPage(project, added.id)
          if (!title) setEditing(added.id)
        }
      },
      (err: unknown) => setSaveError(err instanceof Error ? err.message : String(err))
    )
  }

  const jumpToError = (): void => {
    rootRef.current?.querySelector(`[data-dashboard-tile="${CSS.escape(failed[0])}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }

  const actions: ActionNode[] = !load
    ? []
    : !load.exists || !doc
      ? [{ id: 'dashboard.create', label: 'Create an empty dashboard', icon: 'plus.square', primary: true, run: () => edit({ kind: 'create', title: project.split('/').pop() ?? 'Dashboard' }) }]
      : compact([
          section('pages', [
            doc.pages.length > 1 && {
              id: 'dashboard.page',
              label: 'Page',
              icon: 'rectangle.stack',
              children: doc.pages.map((p) => ({ id: `dashboard.page.${p.id}`, label: p.title, checked: p.id === pageId, run: () => setDashboardPage(project, p.id) }))
            },
            { id: 'dashboard.addPage', label: 'Add a page', icon: 'plus', input: { title: 'New page', placeholder: 'Page name', initial: `Page ${doc.pages.length + 1}`, submit: 'Add' }, run: (v) => addPage(v ?? `Page ${doc.pages.length + 1}`) },
            page && { id: 'dashboard.renamePage', label: 'Rename page…', icon: 'pencil', input: { title: 'Rename page', placeholder: 'Page name', initial: page.title, submit: 'Rename' }, run: (v) => {
              if (v === undefined) setEditing(page.id)
              else if (v.trim() && v.trim() !== page.title) edit({ kind: 'renamePage', page: page.id, title: v.trim() })
            } },
            page && doc.pages.length > 1 && { id: 'dashboard.deletePage', label: 'Delete page', icon: 'trash', destructive: true, run: () => edit({ kind: 'deletePage', page: page.id }) }
          ]),
          section('view', [
            { id: 'dashboard.reload', label: 'Reload', icon: 'arrow.clockwise', primary: true, run: () => setReloads((n) => n + 1) },
            { id: 'dashboard.find', label: 'Find in this view', icon: 'magnifyingglass', shortcut: 'mod+f', primary: true, run: () => setFind((f) => ({ seq: (f?.seq ?? 0) + 1 })) },
            failed.length > 0 && { id: 'dashboard.errors', label: failed.length === 1 ? 'Show the widget error' : `Show widget errors (${failed.length})`, icon: 'exclamationmark.triangle', run: jumpToError },
            { id: 'dashboard.zoom', label: 'Zoom', icon: 'plus.magnifyingglass', children: [
              { id: 'dashboard.zoom.in', label: 'Increase font size', shortcut: 'mod+plus', run: () => useAppStore.getState().adjustReportZoom(1) },
              { id: 'dashboard.zoom.out', label: 'Decrease font size', shortcut: 'mod+minus', run: () => useAppStore.getState().adjustReportZoom(-1) },
              { id: 'dashboard.zoom.reset', label: 'Reset font size', shortcut: 'mod+0', run: () => useAppStore.getState().adjustReportZoom('reset') }
            ] }
          ]),
          section('source', [
            { id: 'dashboard.openJson', label: 'Open dashboard.json', icon: 'curlybraces', run: () => onOpenSource('.sspace/dashboard/dashboard.json') }
          ])
        ])
  usePanelActions(tabId, actions)

  let body
  if (loadError && !load)
    body = (
      <div className="dk-empty" data-dashboard-wait={online ? 'error' : 'offline'}>
        {online ? (
          <>
            <h2>Couldn't load the dashboard</h2>
            <pre>{loadError}</pre>
            <button
              type="button"
              className="dk-btn"
              onClick={() => {
                setLoadError(null)
                setReloads((n) => n + 1)
              }}
            >
              Try again
            </button>
          </>
        ) : (
          <p>Waiting for your desktop to reconnect</p>
        )}
      </div>
    )
  else if (!load)
    body = (
      <div className="dk-empty" data-dashboard-wait={online ? 'loading' : 'offline'}>
        <p className="dk-loading">
          {online && <span className="rk-media-spin" />}
          {online ? 'Loading the dashboard' : 'Waiting for your desktop to reconnect'}
        </p>
      </div>
    )
  else if (!load.exists)
    body = (
      <div className="dk-empty">
        <h2>No dashboard for this project yet</h2>
        <p>
          A dashboard is a grid of live widgets: numbers and charts from your game servers, Unity handles, git and logs. Agents build it in
          <code> .sspace/dashboard/</code>; ask one for the numbers you care about.
        </p>
        <button type="button" className="dk-btn primary" onClick={() => edit({ kind: 'create', title: project.split('/').pop() ?? 'Dashboard' })}>
          Create an empty dashboard
        </button>
      </div>
    )
  else
    body = (
      <div className="dk-host" ref={hostRef} style={zoom !== 1 ? { zoom } : undefined}>
        <div className="dk-grid" data-dashboard-stack={stack ? '' : undefined} style={{ height: stack ? stack.height : PAD * 2 + rows * DASHBOARD_ROW_PX }}>
          {!tiles.length && (
            <div className="dk-empty-page">
              This page has no tiles yet. Agents write widgets to <code>.sspace/dashboard/widgets/&lt;id&gt;.tsx</code> and place them in
              <code> dashboard.json</code>.
            </div>
          )}
          {width > 0 &&
            tiles.map((t, i) => (
              <DashboardTileView
                key={`${pageId}:${i}:${t.widget}`}
                project={project}
                place={place}
                pageTitle={page?.title ?? ''}
                tile={t}
                index={i}
                version={versions[t.widget] ?? 0}
                known={known.has(t.widget)}
                state={stateOf(t.widget)}
                series={series}
                rect={stack ? stack.rects[i] : rectOf(boxes[i])}
                moving={drag?.index === i}
                onPointerDown={onPointerDown}
                onReady={onReady}
                onOpenSource={onOpenSource}
              />
            ))}
        </div>
      </div>
    )

  return (
    <div
      ref={rootRef}
      className="sr-scope dk-root"
      tabIndex={-1}
      data-dashboard-panel
      data-dashboard-project={project}
      data-dashboard-page={pageId}
      data-dashboard-title={doc?.title ?? ''}
      data-dashboard-settled={settled ? '' : undefined}
      data-viewer-report-zoom
      onKeyDown={(e) => {
        if (e.key === 'Escape' && find && !e.defaultPrevented) setFind(null)
      }}
    >
      {load?.exists && doc && (
        <div className="dk-head">
          <span className="dk-title" title={`${project}/.sspace/dashboard`}>
            {doc.title}
          </span>
          <div className="dk-pages" role="tablist">
            {doc.pages.map((p, i) => (
              <PageTab
                key={p.id}
                page={p}
                index={i}
                active={p.id === pageId}
                canDelete={doc.pages.length > 1}
                editing={editing === p.id}
                onPick={() => setDashboardPage(project, p.id)}
                onEdit={(on) => setEditing(on ? p.id : null)}
                onRename={(title) => edit({ kind: 'renamePage', page: p.id, title })}
                onDelete={() => edit({ kind: 'deletePage', page: p.id })}
                onMove={(from, to) => edit({ kind: 'movePage', page: from, to })}
              />
            ))}
            <button
              type="button"
              className="dk-icon-btn"
              aria-label="Add page"
              title="Add a page"
              onClick={() => addPage()}
            >
              <Plus size={14} />
            </button>
          </div>
          <span className="sr-spacer" />
          {failed.length > 0 && (
            <button
              type="button"
              className="sr-chip k-error dk-chip"
              data-dashboard-errors={failed.length}
              title={`Widgets with errors: ${failed.join(', ')}`}
              onClick={jumpToError}
            >
              <span className="sr-dot k-error" />
              {failed.length === 1 ? '1 widget error' : `${failed.length} widget errors`}
            </button>
          )}
          {alerts.length > 0 && (
            <div className="dk-alerts" data-dashboard-alerts>
              {alerts.map((a) => (
                <AlertChip key={a.id} alert={a} place={place} project={project} />
              ))}
            </div>
          )}
        </div>
      )}
      {(load?.error || saveError) && (
        <div className="dk-problems" data-dashboard-problems>
          {[load?.error, saveError].filter(Boolean).join('\n')}
        </div>
      )}
      <div className="dk-body">
        {find && <FindInViewBar key="find" containerRef={rootRef} rootSelector=".dk-grid" focusSeq={find.seq} onClose={() => setFind(null)} />}
        {body}
      </div>
    </div>
  )
}
