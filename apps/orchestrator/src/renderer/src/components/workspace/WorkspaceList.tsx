import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { Bug, ChevronDown, Copy, Plus, Settings, SquarePlus, X } from 'lucide-react'
import type { WindowInfo } from '@shared/api'
import { useAppStore } from '../../store'
import { workspaceTitle } from '../../lib/path'
import { confirmDeleteWorkspace } from '../../lib/confirm/close-confirmations'
import { anchorFromElement, type ConfirmAnchor } from '../../lib/confirm/confirm-store'
import { resolveUnsavedFiles, unsavedFilesOf } from '../../lib/editor/unsaved-files'
import { IS_MAC } from '../../lib/shortcuts/shortcuts'
import { TRAFFIC_LIGHT_INSET } from '../../lib/window-insets'
import { ActionMenu } from '../../lib/actions/ActionMenu'
import { workspaceMenuNodes } from '../../lib/actions/tab-actions'
import { WorkspaceAgentsBadge } from './WorkspaceAgentsBadge'
import { UpdatePopover } from '../UpdatePopover'

export { TRAFFIC_LIGHT_INSET, WINDOW_CONTROLS_INSET } from '../../lib/window-insets'
export const SIDEBAR_TOGGLE_LEFT = IS_MAC ? TRAFFIC_LIGHT_INSET + 4 : 8
export const TOP_LEFT_INSET = SIDEBAR_TOGGLE_LEFT + 32

export const iconButtonClass =
  'flex h-6 w-6 shrink-0 items-center justify-center rounded text-ink-2 transition-colors hover:bg-white/[0.07] hover:text-ink [-webkit-app-region:no-drag]'

export function useWorkspaceWindowIdentity(): void {
  const { workspaces, activeWorkspaceId } = useAppStore(
    useShallow((s) => ({ workspaces: s.workspaces, activeWorkspaceId: s.activeWorkspaceId }))
  )
  useEffect(() => {
    const active = workspaces.find((w) => w.id === activeWorkspaceId)
    window.api.window.setWorkspaceIdentity({
      label: active ? workspaceTitle(active) : '',
      folderPath: active?.folderPath ?? '',
      worktreePath: active?.worktreePath ?? active?.folderPath ?? ''
    })
  }, [workspaces, activeWorkspaceId])
}

export function requestDeleteWorkspace(id: string, anchor?: ConfirmAnchor | null): void {
  const s = useAppStore.getState()
  const ws = s.workspaces.find((w) => w.id === id)
  if (!ws) return
  const tabs = s.tabsByWorkspace[id] ?? []
  const hasWork = tabs.some(
    (t) =>
      t.contentType === 'unity-instance-player' ||
      t.contentType === 'unity-scratchpad' ||
      (t.contentType === 'terminal' && !s.exitedPtyIds.includes(t.ptyId))
  )
  const worktrees = s.worktreesByWorkspace[id] ?? []
  const roots = [ws.worktreePath ?? '', ...worktrees.map((w) => w.path)].filter(Boolean)
  const files = unsavedFilesOf((t) => tabs.includes(t), roots)
  const asked = files.length
    ? resolveUnsavedFiles(files, 'workspace', {
        anchor,
        root: worktrees[0]?.path ?? ws.worktreePath ?? ws.folderPath,
        note: hasWork ? 'Closing it also ends its running terminals and Unity instances.' : ''
      })
    : confirmDeleteWorkspace(ws.name, hasWork, anchor)
  void asked.then((ok) => {
    if (!ok) return
    const identity = {
      folderPath: ws.folderPath ?? '',
      worktreePath: ws.worktreePath ?? ws.folderPath ?? ''
    }
    s.deleteWorkspace(id)
    window.api.window.closeWorkspaceWindows(identity)
  })
}

export const sidebarRowClass = 'flex h-7 items-center gap-2 rounded px-1'

export const sidebarTwoLineRowClass = 'flex min-h-7 items-start gap-2 rounded px-1 py-[5px]'

export function SidebarDisclosure({
  label,
  open,
  onToggle,
  status,
  count
}: {
  label: string
  open: boolean
  onToggle: () => void
  status?: ReactNode
  count?: number
}) {
  return (
    <div className="flex h-7 shrink-0 items-center px-2">
      <div className="flex h-7 min-w-0 flex-1 items-center gap-2 px-1">
        <button
          onClick={onToggle}
          aria-expanded={open}
          className="flex h-7 min-w-0 flex-1 items-center gap-2 text-left text-xs font-medium text-ink-2 hover:text-ink"
        >
          <span className="flex h-4 w-4 shrink-0 items-center justify-center text-ink-3">
            <ChevronDown
              size={12}
              strokeWidth={1.75}
              className={`transition-transform ${open ? '' : '-rotate-90'}`}
            />
          </span>
          <span className="min-w-0 flex-1 truncate">{label}</span>
          {!open && status}
          {!open && count !== undefined && (
            <span className="shrink-0 font-normal tabular-nums text-ink-3">{count}</span>
          )}
        </button>
      </div>
    </div>
  )
}

export function SidebarTitlebar() {
  return <div className="h-[38px] shrink-0 [-webkit-app-region:drag]" data-sidebar-titlebar />
}

export function SidebarWindowTitle() {
  const activeTitle = useAppStore((s) => {
    const w = s.workspaces.find((x) => x.id === s.activeWorkspaceId)
    return w ? workspaceTitle(w) : ''
  })
  return (
    <div className="flex h-7 shrink-0 items-center px-3">
      <span className="min-w-0 flex-1 truncate text-xs font-medium text-ink-2">{activeTitle}</span>
    </div>
  )
}

export function WorkspacesSection() {
  const open = useAppStore((s) => !s.sidebarCollapsed.workspaces)
  const toggleSidebarSection = useAppStore((s) => s.toggleSidebarSection)
  const activeWorkspaceId = useAppStore((s) => s.activeWorkspaceId)
  const count = useAppStore((s) => s.workspaces.length)
  const setActiveWorkspace = useAppStore((s) => s.setActiveWorkspace)
  return (
    <>
      <SidebarDisclosure
        label="Workspaces"
        open={open}
        onToggle={() => toggleSidebarSection('workspaces')}
        count={count}
      />
      {open && <WorkspaceList reorderable />}
      <div className="shrink-0 px-2 pb-2 pt-1">
        <button
          onClick={() => setActiveWorkspace(null)}
          title="New workspace"
          aria-pressed={!activeWorkspaceId}
          className={`${sidebarRowClass} w-full text-left text-[13px] text-accent ${
            activeWorkspaceId ? 'hover:bg-accent/[0.08]' : 'bg-accent/[0.1]'
          }`}
        >
          <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded bg-accent/[0.16]">
            <Plus size={11} strokeWidth={2} />
          </span>
          <span className="min-w-0 flex-1 truncate">New workspace</span>
        </button>
      </div>
    </>
  )
}

const WORKSPACE_DRAG_THRESHOLD_PX = 4

function workspaceDropAt(list: HTMLElement, y: number): { before: string | null; top: number } | null {
  const rows = Array.from(list.querySelectorAll<HTMLElement>('[data-workspace-chip]'))
  if (rows.length === 0) return null
  const listTop = list.getBoundingClientRect().top
  for (const row of rows) {
    const r = row.getBoundingClientRect()
    if (y < r.top + r.height / 2) return { before: row.getAttribute('data-workspace-chip'), top: r.top - listTop - 3 }
  }
  return { before: null, top: rows[rows.length - 1].getBoundingClientRect().bottom - listTop + 1 }
}

export function WorkspaceList({ reorderable = false }: { reorderable?: boolean }) {
  const { workspaces, activeWorkspaceId, workspaceAlertByWorkspace } = useAppStore(
    useShallow((s) => ({
      workspaces: s.workspaces,
      activeWorkspaceId: s.activeWorkspaceId,
      workspaceAlertByWorkspace: s.workspaceAlertByWorkspace
    }))
  )
  const setActiveWorkspace = useAppStore((s) => s.setActiveWorkspace)
  const worktreeBusy = useAppStore((s) => s.worktreeBusy)
  const listRef = useRef<HTMLDivElement>(null)
  const suppressClick = useRef(false)
  const [drag, setDrag] = useState<{ id: string; top: number | null } | null>(null)

  const onRowPointerDown = (e: ReactPointerEvent<HTMLDivElement>, id: string): void => {
    suppressClick.current = false
    if (!reorderable || e.button !== 0 || e.pointerType !== 'mouse') return
    if ((e.target as Element).closest('button')) return
    const row = e.currentTarget
    const pointerId = e.pointerId
    const startX = e.clientX
    const startY = e.clientY
    let dragging = false
    let target: { before: string | null; top: number } | null = null
    const onMove = (ev: PointerEvent): void => {
      if (ev.pointerId !== pointerId) return
      if (!dragging) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < WORKSPACE_DRAG_THRESHOLD_PX) return
        dragging = true
        try {
          row.setPointerCapture(pointerId)
        } catch {
        }
        document.body.classList.add('dragging')
      }
      const hit = listRef.current ? workspaceDropAt(listRef.current, ev.clientY) : null
      const ids = useAppStore.getState().workspaces.map((w) => w.id)
      const next = ids[ids.indexOf(id) + 1] ?? null
      target = hit && hit.before !== id && hit.before !== next ? hit : null
      setDrag({ id, top: target?.top ?? null })
    }
    const finish = (commit: boolean): void => {
      window.removeEventListener('pointermove', onMove, true)
      window.removeEventListener('pointerup', onUp, true)
      window.removeEventListener('pointercancel', onCancel, true)
      window.removeEventListener('keydown', onKey, true)
      if (!dragging) return
      document.body.classList.remove('dragging')
      suppressClick.current = true
      setDrag(null)
      if (commit && target) useAppStore.getState().moveWorkspace(id, target.before)
    }
    const onUp = (ev: PointerEvent): void => {
      if (ev.pointerId === pointerId) finish(true)
    }
    const onCancel = (ev: PointerEvent): void => {
      if (ev.pointerId === pointerId) finish(false)
    }
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key !== 'Escape' || !dragging) return
      ev.preventDefault()
      ev.stopPropagation()
      finish(false)
    }
    window.addEventListener('pointermove', onMove, true)
    window.addEventListener('pointerup', onUp, true)
    window.addEventListener('pointercancel', onCancel, true)
    window.addEventListener('keydown', onKey, true)
  }

  const [menu, setMenu] = useState<{
    id: string
    x: number
    y: number
    targets: WindowInfo[]
  } | null>(null)

  return (
    <div
      ref={listRef}
      className={`relative flex shrink-0 flex-col gap-1 px-2 ${worktreeBusy ? 'pointer-events-none opacity-50' : ''}`}
      title={worktreeBusy ? 'Please wait — a worktree operation is in progress' : undefined}
      data-workspace-list
    >
      {workspaces.map((w) => {
        const active = w.id === activeWorkspaceId
        const alert = active ? undefined : workspaceAlertByWorkspace[w.id]
        const alertClass = alert
          ? alert === 'finished'
            ? 'bg-ok/10 text-ink'
            : 'bg-warn/10 text-ink'
          : ''
        return (
          <div
            key={w.id}
            data-workspace-chip={w.id}
            role="button"
            aria-label={`Workspace ${workspaceTitle(w)}`}
            title={w.folderPath ?? undefined}
            onPointerDown={(e) => onRowPointerDown(e, w.id)}
            onClick={() => {
              if (suppressClick.current) {
                suppressClick.current = false
                return
              }
              setActiveWorkspace(w.id)
            }}
            onContextMenu={(e) => {
              e.preventDefault()
              e.stopPropagation()
              const id = w.id
              const x = e.clientX
              const y = e.clientY
              void window.api.window.list().then((wins) => {
                setMenu({ id, x, y, targets: wins.filter((win) => win.role === 'primary') })
              })
            }}
            aria-current={active ? 'page' : undefined}
            className={`group relative ${sidebarTwoLineRowClass} cursor-default text-[13px] ${
              active
                ? 'bg-white/[0.07] text-ink'
                : 'text-ink-2 hover:bg-white/[0.04] hover:text-ink'
            } ${alertClass} ${drag?.id === w.id ? 'opacity-50' : ''}`}
          >
            {active && (
              <span aria-hidden className="absolute -left-2 top-2 bottom-2 w-0.5 rounded-full bg-accent" />
            )}
            <span className="flex h-[18px] w-4 shrink-0 items-center justify-center">
              {alert && (
                <span
                  className={`h-1.5 w-1.5 rounded-full ${
                    alert === 'finished' ? 'bg-ok' : 'bg-warn'
                  } animate-pulse`}
                />
              )}
            </span>
            <span className="flex min-w-0 flex-1 flex-col items-start">
              <span className="max-w-full truncate leading-[18px]">{workspaceTitle(w)}</span>
              <WorkspaceAgentsBadge workspaceId={w.id} />
            </span>
            <button
              onClick={(e) => {
                e.stopPropagation()
                requestDeleteWorkspace(w.id, anchorFromElement(e.currentTarget))
              }}
              title="Delete workspace"
              aria-label="Delete workspace"
              className="-my-[3px] flex h-6 w-6 shrink-0 items-center justify-center rounded text-ink-3 opacity-0 transition-opacity hover:bg-white/10 hover:text-ink group-hover:opacity-100"
            >
              <X size={12} strokeWidth={1.75} />
            </button>
          </div>
        )
      })}

      {drag?.top != null && (
        <span
          aria-hidden
          data-workspace-insert
          className="pointer-events-none absolute inset-x-2 z-20 h-0.5 rounded-full bg-accent shadow-[0_0_6px_var(--accent)]"
          style={{ top: drag.top }}
        />
      )}

      {menu && (
        <ActionMenu
          x={menu.x}
          y={menu.y}
          nodes={workspaceMenuNodes(menu.id, menu.targets, requestDeleteWorkspace, { x: menu.x, y: menu.y })}
          onDismiss={() => setMenu(null)}
        />
      )}
    </div>
  )
}

export function SidebarToggle() {
  const sidebarOpen = useAppStore((s) => s.sidebarOpen)
  const toggleSidebar = useAppStore((s) => s.toggleSidebar)
  const hasWorkspaces = useAppStore((s) => s.workspaces.length > 0)
  if (!hasWorkspaces) return null
  return (
    <button
      onClick={toggleSidebar}
      title="Toggle Sidebar"
      aria-label="Toggle sidebar"
      aria-pressed={sidebarOpen}
      className={`${iconButtonClass} fixed z-[60] ${sidebarOpen ? 'text-ink' : ''}`}
      style={{ left: SIDEBAR_TOGGLE_LEFT, top: 7 }}
      data-sidebar-toggle
    >
      <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <path d="M9 3v18" />
      </svg>
    </button>
  )
}

export function AppActions({ onOpenSettings }: { onOpenSettings: () => void }) {
  const activeWorkspace = useAppStore((s) => s.workspaces.find((w) => w.id === s.activeWorkspaceId))
  return (
    <div className="flex shrink-0 items-center gap-1">
      <UpdatePopover />
      <button
        onClick={() => void window.api.app.reportBug()}
        title="Report a bug"
        aria-label="Report a bug"
        className={iconButtonClass}
      >
        <Bug size={14} strokeWidth={1.5} />
      </button>
      <button
        onClick={() =>
          void (activeWorkspace
            ? window.api.window.createForWorkspace({
                folderPath: activeWorkspace.folderPath ?? '',
                worktreePath: activeWorkspace.worktreePath ?? activeWorkspace.folderPath ?? '',
                name: activeWorkspace.name
              })
            : window.api.window.create())
        }
        title={activeWorkspace ? 'New window for this workspace' : 'New primary window'}
        aria-label={activeWorkspace ? 'New window for this workspace' : 'New primary window'}
        className={iconButtonClass}
      >
        {activeWorkspace ? <Copy size={14} strokeWidth={1.5} /> : <SquarePlus size={14} strokeWidth={1.5} />}
      </button>
      <button onClick={onOpenSettings} title="Settings" aria-label="Settings" className={iconButtonClass}>
        <Settings size={14} strokeWidth={1.5} />
      </button>
    </div>
  )
}
