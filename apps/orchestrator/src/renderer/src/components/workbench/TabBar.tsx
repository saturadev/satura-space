import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { ChevronDown, ChevronRight, FlaskConical, Plus, X } from 'lucide-react'
import type { Tab, Worktree } from '@shared/types'
import { useAppStore } from '../../store'
import { AlphaTag } from '../ui/AlphaTag'
import { useScratchpads } from '../../lib/unity/scratchpads'
import { beginTabPointerDrag } from '../../lib/tab-drag-controller'
import { useTabInsert } from '../../lib/tab-insert'
import { requestCloseTab } from '../../lib/editor/close-file-tab'
import { anchorFromEvent, anchorFromElement } from '../../lib/confirm/confirm-store'
import { viewerFileForTab } from '../../lib/editor/viewer-file'
import { tabDisplayLabel } from '../../lib/tab-label'
import { useTunerTabTitles } from '../../lib/tuner/tab-titles'
import { PanelIcon } from './PanelIcon'
import { StatusDot, STATUS_LABEL } from '../workspace/WorkspaceAgentsBadge'
import { agentRunStatusFor, statusSinceFor, stripAgentStatusGlyph } from '../../lib/agent-status'
import { NewSessionMenu } from './NewSessionMenu'
import { RemotePresenceBadge, RemotePresencePill } from './RemotePresenceBadge'
import { flattenSegments, layoutSegments, useReportPlan, type SegmentView } from '../../lib/terminal/report-groups'
import { fitSegments, segmentWidth } from '../../lib/terminal/segment-fit'
import { Popover } from '../ui/Popover'
import { HoverCardLayer, useHoverCard } from '../ui/HoverCard'
import { TabHoverContent } from './TabHoverCard'
import { TabContextMenu } from './TabContextMenu'
import { tabMenuNodes } from '../../lib/actions/tab-actions'
import { BarXScroll } from './BarXScroll'
import type { GroupEdges } from './TabGroupPanel'
import { IS_MAC } from '../../lib/shortcuts/shortcuts'
import { IS_PRIMARY_WINDOW } from '../../lib/window-role'
import { TOP_LEFT_INSET, TRAFFIC_LIGHT_INSET, WINDOW_CONTROLS_INSET } from '../workspace/WorkspaceList'

const barButtonClass =
  'flex h-6 w-6 items-center justify-center rounded hover:bg-white/[0.07] hover:text-ink [-webkit-app-region:no-drag]'

export function TabBar({
  workspaceId,
  groupId,
  tabs,
  activeTabId,
  worktrees,
  focused = false,
  edges,
  actions = true
}: {
  workspaceId: string
  groupId: string
  tabs: Tab[]
  activeTabId: string | null
  worktrees: Worktree[]
  focused?: boolean
  edges?: GroupEdges
  actions?: boolean
}) {
  const sidebarOpen = useAppStore((s) => s.sidebarOpen)
  const atTop = !!edges?.top
  const sidebarHidden = !sidebarOpen
  const insetLeft = atTop && !!edges?.left && sidebarHidden && (IS_MAC || IS_PRIMARY_WINDOW)
  const insetRight = atTop && !!edges?.right && !IS_MAC
  const activateTab = useAppStore((s) => s.activateTab)
  const promoteTab = useAppStore((s) => s.promoteTab)
  const draggingTabId = useAppStore((s) => s.draggingTabId)
  const setTabLabel = useAppStore((s) => s.setTabLabel)
  const toggleGroupFullscreen = useAppStore((s) => s.toggleGroupFullscreen)
  const isFullscreen = useAppStore((s) => s.fullscreenGroupIdByWorkspace[workspaceId] === groupId)
  const toggleGroupHidden = useAppStore((s) => s.toggleGroupHidden)
  const isHidden = useAppStore(
    (s) => !!s.groupsByWorkspace[workspaceId]?.find((g) => g.id === groupId)?.hidden
  )
  const viewerFileByTab = useAppStore(useShallow((s) => s.viewerFileByTab))
  const reportTitles = useAppStore((s) => s.reportTitles)
  const tunerTitles = useTunerTabTitles()
  const dirtyKeys = useAppStore(useShallow((s) => Object.keys(s.draftsByPath)))
  const dirtySet = new Set(dirtyKeys)
  const pulseByPty = useAppStore(useShallow((s) => s.pulseByPty))
  const exitedPtyIds = useAppStore((s) => s.exitedPtyIds)
  const agentHookStatusByPty = useAppStore((s) => s.agentHookStatusByPty)

  const plan = useReportPlan(workspaceId)
  const insert = useTabInsert((s) => s.target)
  const tabIds = new Set(tabs.map((t) => t.id))
  const units = tabs
    .filter((t) => !(t.attachedTo && tabIds.has(t.attachedTo) && tabs.some((o) => o.id === t.attachedTo && o.contentType === 'terminal')))
    .map((head) => ({
      head,
      segs: head.contentType === 'terminal' ? layoutSegments(head, tabs.filter((t) => t.attachedTo === head.id), plan, viewerFileByTab) : []
    }))

  const displayLabel = (tab: Tab): string => tabDisplayLabel(tab, viewerFileByTab, reportTitles, tunerTitles)

  const canRenameTab = (tab: Tab): boolean =>
    tab.contentType === 'terminal'

  const [menuOpen, setMenuOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [ctxMenu, setCtxMenu] = useState<{ tabId: string; x: number; y: number } | null>(null)
  const renameResolvedRef = useRef(false)
  const hover = useHoverCard<string>({ disabled: !!draggingTabId || editingId != null || ctxMenu != null })
  const hoverTab = hover.target ? tabs.find((t) => t.id === hover.target?.key) : undefined
  const renameInputRef = useRef<HTMLInputElement | null>(null)

  const barRef = useRef<HTMLDivElement>(null)
  const [budgets, setBudgets] = useState<Record<string, number>>({})
  const measure = (): void => {
    const sc = barRef.current?.querySelector('[data-tab-unit]')?.parentElement
    if (!sc) return
    let fixed = 0
    const merged: HTMLElement[] = []
    for (const el of Array.from(sc.children) as HTMLElement[]) {
      if (!el.hasAttribute('data-tab-unit')) continue
      if (el.hasAttribute('data-tab-merged')) {
        merged.push(el)
        fixed += ((el.querySelector('[data-seg-kind="terminal"]') as HTMLElement | null)?.offsetWidth ?? 0) + 4
      } else fixed += el.offsetWidth
    }
    const share = merged.length ? Math.max(0, Math.floor((sc.clientWidth - fixed - 4) / merged.length)) : 0
    const next: Record<string, number> = {}
    for (const el of merged) next[el.getAttribute('data-tab-unit') ?? ''] = share
    setBudgets((prev) => (Object.keys(next).length === Object.keys(prev).length && Object.entries(next).every(([k, v]) => prev[k] === v) ? prev : next))
  }
  useLayoutEffect(measure)
  useEffect(() => {
    const bar = barRef.current
    if (!bar) return
    const ro = new ResizeObserver(() => measure())
    ro.observe(bar)
    return () => ro.disconnect()
  }, [])

  const activeTabRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    activeTabRef.current?.scrollIntoView({ inline: 'nearest', block: 'nearest' })
  }, [activeTabId])

  const openRename = (tab: Tab): void => {
    renameResolvedRef.current = false
    setDraft(displayLabel(tab))
    setEditingId(tab.id)
  }
  const commitRename = (): void => {
    if (renameResolvedRef.current) return
    renameResolvedRef.current = true
    if (editingId) setTabLabel(editingId, draft)
    setEditingId(null)
  }
  const cancelRename = (): void => {
    renameResolvedRef.current = true
    setEditingId(null)
  }
  useEffect(() => {
    if (!editingId) return
    const raf = requestAnimationFrame(() => {
      const el = renameInputRef.current
      if (!el) return
      el.focus()
      el.select()
    })
    return () => cancelAnimationFrame(raf)
  }, [editingId])

  const contextWorktreeId =
    tabs.find((t) => t.id === activeTabId)?.worktreeId ?? worktrees[0]?.id ?? ''


  const renderTab = (tab: Tab, variant: 'plain' | 'head' | 'seg', seg?: SegmentView, owner?: Tab) => {
    const active = tab.id === activeTabId
    const agentStatus =
      tab.contentType === 'terminal' && tab.agentId
        ? agentRunStatusFor(tab, exitedPtyIds.includes(tab.ptyId), agentHookStatusByPty[tab.ptyId])
        : null
    const label = seg?.trail.length ? seg.trail[seg.trail.length - 1] : agentStatus ? stripAgentStatusGlyph(displayLabel(tab)) : displayLabel(tab)
    const viewerFile = viewerFileForTab(tab, viewerFileByTab)
    const dirty = !!viewerFile && dirtySet.has(viewerFile)
    const pulse = pulseByPty[tab.ptyId]
    if (agentStatus) statusSinceFor(tab.ptyId, agentStatus, Date.now())
    const hoverProps = hover.bind(tab.id)
    const depth = seg?.depth ?? 0
    const shape =
      variant === 'plain'
        ? `min-w-32 max-w-[28rem] gap-2 pl-2.5 pr-1 text-[13px] ${draggingTabId === tab.id ? 'opacity-40' : ''}`
        : variant === 'head'
          ? 'min-w-28 max-w-48 shrink-0 gap-2 pl-2.5 pr-1 text-[13px]'
          : `shrink-0 pr-1 ${depth > 0 ? 'gap-1 pl-1 text-[12px]' : 'gap-1.5 pl-1.5 text-[12.5px]'} ${draggingTabId === tab.id ? 'opacity-40' : ''}`
    return (
      <div
        key={tab.id}
        role="tab"
        aria-selected={active}
        aria-label={agentStatus && agentStatus !== 'idle' ? `${label}, ${STATUS_LABEL[agentStatus]}` : label}
        data-tabbar-tab
        data-tab-status={agentStatus ?? undefined}
        data-tab-id={tab.id}
        data-tab-label={tab.label}
        data-seg-kind={variant === 'plain' ? undefined : variant === 'head' ? 'terminal' : 'report'}
        data-seg-depth={seg ? seg.depth : undefined}
        data-seg-tab={seg ? tab.id : undefined}
        data-seg-owner={seg && owner ? owner.id : undefined}
        data-seg-parent={seg ? (seg.parentFile ?? '') : undefined}
        data-seg-file={seg ? seg.file : undefined}
        ref={active ? activeTabRef : null}
        onPointerEnter={hoverProps.onPointerEnter}
        onPointerLeave={hoverProps.onPointerLeave}
        onFocus={hoverProps.onFocus}
        onBlur={hoverProps.onBlur}
        onPointerDown={(e) => {
          hoverProps.onPointerDown(e)
          if (editingId === tab.id) return
          if (e.button !== 0) return
          if ((e.target as HTMLElement).closest('button, input')) return
          beginTabPointerDrag(e, tab.id, label)
        }}
        onClick={() => {
          activateTab(tab.id)
          if (tab.preview) promoteTab(tab.id)
        }}
        onAuxClick={(e) => {
          if (e.button !== 1) return
          if (editingId === tab.id) return
          e.preventDefault()
          requestCloseTab(tab.id, anchorFromEvent(e))
        }}
        onDoubleClick={() => {
          if (canRenameTab(tab)) openRename(tab)
          else toggleGroupFullscreen(workspaceId, groupId)
        }}
        onContextMenu={(e) => {
          e.preventDefault()
          setCtxMenu({ tabId: tab.id, x: e.clientX, y: e.clientY })
        }}
        className={`group relative flex cursor-pointer items-center transition-opacity [-webkit-app-region:no-drag] ${shape} ${
          active ? 'text-ink' : 'text-ink-3 hover:text-ink-2'
        }`}
      >
        {active && (
          <span
            aria-hidden
            className={`pointer-events-none absolute bottom-0 ${variant === 'plain' ? 'left-2.5 right-2.5 h-px' : 'left-1.5 right-1.5 h-[2px] rounded-full'} ${focused ? 'bg-accent' : 'bg-white/40'}`}
          />
        )}
        {pulse && (
          <span
            key={pulse.seq}
            aria-hidden
            className={`satura-alert-flash pointer-events-none absolute inset-0 ${variant === 'plain' ? '' : 'rounded-[6px]'} ${
              pulse.kind === 'finished'
                ? 'bg-emerald-400/12'
                : pulse.kind === 'opened'
                  ? 'bg-sky-400/15'
                  : 'bg-amber-400/15'
            }`}
          />
        )}
        {pulse && variant !== 'seg' && (
          <span
            aria-hidden
            className={`relative shrink-0 h-1.5 w-1.5 rounded-full ${
              pulse.kind === 'finished'
                ? 'bg-emerald-400'
                : pulse.kind === 'opened'
                  ? 'bg-sky-400'
                  : 'bg-amber-400'
            }`}
          />
        )}
        {tab.scratchpadId && tab.contentType !== 'unity-scratchpad' && (
          <ScratchpadTabBadge
            worktreePath={worktrees.find((w) => w.id === tab.worktreeId)?.path ?? ''}
            scratchpadId={tab.scratchpadId}
          />
        )}
        {variant === 'seg' && depth > 0 ? (
          <span className="flex shrink-0 scale-[0.85] opacity-80">
            <PanelIcon tab={tab} file={viewerFile} />
          </span>
        ) : (
          <PanelIcon tab={tab} file={viewerFile} />
        )}
        {editingId === tab.id ? (
          <input
            ref={renameInputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitRename()
              else if (e.key === 'Escape') cancelRename()
            }}
            onClick={(e) => e.stopPropagation()}
            className="min-w-0 flex-1 bg-sunken px-1 text-sm text-white outline-none ring-1 ring-white/20"
          />
        ) : (
          <span className={`min-w-0 flex-1 truncate ${variant === 'seg' ? 'max-w-[150px]' : ''} ${tab.preview ? 'italic' : ''}`}>
            {dirty && (
              <span className="mr-1 text-amber-400" aria-hidden>
                •
              </span>
            )}
            {label}
          </span>
        )}
        {tab.contentType === 'tuner' && <AlphaTag />}
        {agentStatus && agentStatus !== 'idle' && (
          <span className="flex shrink-0 items-center" data-tab-working={agentStatus === 'working' ? '' : undefined}>
            <StatusDot status={agentStatus} />
          </span>
        )}
        <RemotePresenceBadge tabId={tab.id} />
        {actions && (
          <button
            onClick={(e) => {
              e.stopPropagation()
              requestCloseTab(tab.id, anchorFromElement(e.currentTarget))
            }}
            title={variant === 'seg' ? 'Close report' : variant === 'head' ? 'Close terminal and its reports' : 'Close tab'}
            aria-label={variant === 'seg' ? 'Close report' : variant === 'head' ? 'Close terminal and its reports' : 'Close tab'}
            className={`flex h-5 shrink-0 items-center justify-center rounded text-ink-3 hover:bg-white/10 hover:text-ink ${variant === 'seg' ? 'w-4' : 'w-5'} ${
              active ? '' : 'opacity-0 group-hover:opacity-100'
            }`}
          >
            <X size={variant === 'seg' ? 12 : 13} strokeWidth={1.75} />
          </button>
        )}
      </div>
    )
  }

  const renderSegments = (owner: Tab, segs: SegmentView[]) => {
    const flat = flattenSegments(segs)
    const { shown, hidden } = fitSegments(flat, activeTabId, budgets[owner.id], (v) => segmentWidth(v.trail[v.trail.length - 1] ?? '', v.depth))
    const target = insert?.kind === 'seg' && insert.owner === owner.id ? insert : null
    let endAt = -1
    if (target && target.before === null) {
      const sibs = shown.filter((v) => (v.parentFile ?? '') === target.parent)
      const last = sibs[sibs.length - 1]
      endAt = last ? shown.indexOf(last) : -1
      while (endAt >= 0 && endAt + 1 < shown.length && shown[endAt + 1].depth > (last?.depth ?? 0)) endAt++
    }
    const out = shown.map((v, k) => {
      const prev = k > 0 ? shown[k - 1] : null
      const sep =
        v.depth === 0 ? (
          <span aria-hidden className="mx-1 h-4 w-px shrink-0 self-center bg-white/[0.14]" />
        ) : prev && prev.tab.id === v.parentTabId ? (
          <ChevronRight aria-hidden size={12} strokeWidth={2} className="mx-px shrink-0 self-center text-ink-3" />
        ) : (
          <span aria-hidden className="mx-1.5 h-2.5 w-px shrink-0 self-center bg-white/[0.14]" />
        )
      return (
        <div key={v.tab.id} className="relative flex shrink-0 items-stretch">
          {sep}
          {renderTab(v.tab, 'seg', v, owner)}
          {target?.before === v.tab.id && <InsertLine edge="left" />}
          {endAt === k && <InsertLine edge="right" />}
        </div>
      )
    })
    if (hidden.length > 0)
      out.push(
        <div key="overflow" className="flex shrink-0 items-stretch">
          <span aria-hidden className="mx-1 h-4 w-px shrink-0 self-center bg-white/[0.14]" />
          <SegmentOverflow hidden={hidden} activeTabId={activeTabId} onPick={(id) => activateTab(id)} />
        </div>
      )
    return out
  }

  const hoverTrail = hoverTab ? units.flatMap((u) => flattenSegments(u.segs)).find((v) => v.tab.id === hoverTab.id)?.trail : undefined

  const onBarDoubleClick = (e: React.MouseEvent): void => {
    if ((e.target as HTMLElement).closest('[data-tabbar-tab], button, input')) return
    toggleGroupFullscreen(workspaceId, groupId)
  }

  return (
    <div
      className="flex h-[38px] shrink-0 items-stretch bg-canvas px-1 shadow-[inset_0_-1px_0_rgb(255_255_255/0.06)]"
      style={{
        paddingLeft: insetLeft ? (IS_PRIMARY_WINDOW ? TOP_LEFT_INSET : TRAFFIC_LIGHT_INSET) - 4 : undefined,
        paddingRight: insetRight ? WINDOW_CONTROLS_INSET : undefined
      }}
      onDoubleClick={onBarDoubleClick}
      data-tabbar
      data-tabbar-group={groupId}
      ref={barRef}
    >
      <BarXScroll
        wrapperClassName="relative flex min-w-0 flex-1"
        className="no-scrollbar flex min-w-0 flex-1 items-stretch overflow-x-auto"
      >
        {units.map((unit, i) => {
          const line = insert?.kind === 'unit' && insert.groupId === groupId ? insert.before : undefined
          const lineHere = line === unit.head.id || (line === null && i === units.length - 1)
          const lineEdge = line === unit.head.id ? 'left' : 'right'
          if (unit.segs.length === 0) {
            return (
              <div key={unit.head.id} data-tab-unit={unit.head.id} className="relative flex min-w-32 items-stretch">
                {renderTab(unit.head, 'plain')}
                {lineHere && <InsertLine edge={lineEdge} />}
              </div>
            )
          }
          const holdsActive = unit.head.id === activeTabId || flattenSegments(unit.segs).some((v) => v.tab.id === activeTabId)
          return (
            <div
              key={unit.head.id}
              data-tab-unit={unit.head.id}
              data-tab-merged={unit.segs.length}
              data-seg-flat={JSON.stringify(flattenSegments(unit.segs).map((v) => [v.tab.id, v.parentFile ?? '']))}
              className={`relative mx-0.5 mt-1 flex shrink-0 items-stretch rounded-t-[7px] bg-white/[0.05] transition-opacity ${draggingTabId === unit.head.id ? 'opacity-40' : ''}`}
            >
              <span aria-hidden className={`pointer-events-none absolute inset-x-1 bottom-0 h-px ${holdsActive ? 'bg-white/[0.22]' : 'bg-white/[0.12]'}`} />
              {renderTab(unit.head, 'head')}
              {renderSegments(unit.head, unit.segs)}
              {lineHere && <InsertLine edge={lineEdge} />}
            </div>
          )
        })}
      </BarXScroll>
      {hover.target && hoverTab && (
        <HoverCardLayer
          anchor={hover.target.el}
          placement="bottom-start"
          onDismiss={hover.close}
          floatingProps={hover.floatingProps}
          label="Tab details"
        >
          <TabHoverContent
            tab={hoverTab}
            label={hoverTrail?.length ? hoverTrail[hoverTrail.length - 1] : hoverTab.agentId ? stripAgentStatusGlyph(displayLabel(hoverTab)) : displayLabel(hoverTab)}
            file={viewerFileForTab(hoverTab, viewerFileByTab)}
            root={worktrees.find((w) => w.id === hoverTab.worktreeId)?.path ?? ''}
            trail={hoverTrail}
          />
        </HoverCardLayer>
      )}

      <div className="relative flex shrink-0 items-center gap-0.5 pl-1">
        <RemotePresencePill tabIds={tabs.map((t) => t.id)} />
        {actions && (
          <>
            <button
              onClick={() => toggleGroupHidden(workspaceId, groupId)}
              title={isHidden ? 'Show these panels' : 'Hide these panels'}
              aria-pressed={isHidden}
              className={`${barButtonClass} ${isHidden ? 'text-accent' : 'text-ink-3'}`}
            >
              {isHidden ? (
                <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                  <path d="M10.7 5.1A10.4 10.4 0 0112 5c6.5 0 10 7 10 7a17.6 17.6 0 01-2.2 3.2M6.6 6.6A17.4 17.4 0 002 12s3.5 7 10 7a9.7 9.7 0 005.4-1.6M9.9 9.9a3 3 0 004.2 4.2M3 3l18 18" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                  <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
                  <circle cx="12" cy="12" r="3" />
                </svg>
              )}
            </button>
            <button
              onClick={() => toggleGroupFullscreen(workspaceId, groupId)}
              title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen this panel'}
              className={`${barButtonClass} ${isFullscreen ? 'text-accent' : 'text-ink-3'}`}
            >
              {isFullscreen ? (
                <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                  <path d="M9 9L4 4M9 9V5M9 9H5M15 9l5-5M15 9V5M15 9h4M9 15l-5 5M9 15v4M9 15H5M15 15l5 5M15 15v4M15 15h4" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                  <path d="M8 3H5a2 2 0 00-2 2v3M16 3h3a2 2 0 012 2v3M8 21H5a2 2 0 01-2-2v-3M16 21h3a2 2 0 002-2v-3" />
                </svg>
              )}
            </button>
            <button
              onClick={() => setMenuOpen((v) => !v)}
              title="New session"
              aria-label="New session"
              className={`${barButtonClass} text-ink-3`}
            >
              <Plus size={15} strokeWidth={1.5} />
            </button>
          </>
        )}
        {menuOpen && (
          <NewSessionMenu
            workspaceId={workspaceId}
            groupId={groupId}
            defaultWorktreeId={contextWorktreeId}
            onClose={() => setMenuOpen(false)}
          />
        )}
      </div>

      {ctxMenu && (
        <TabContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          nodes={tabMenuNodes(ctxMenu.tabId, {
            onRename: () => {
              const tab = tabs.find((t) => t.id === ctxMenu.tabId)
              if (tab) openRename(tab)
            },
            anchor: { x: ctxMenu.x, y: ctxMenu.y }
          })}
          onDismiss={() => setCtxMenu(null)}
        />
      )}
    </div>
  )
}

function SegmentOverflow({ hidden, activeTabId, onPick }: { hidden: SegmentView[]; activeTabId: string | null; onPick: (tabId: string) => void }) {
  const [open, setOpen] = useState(false)
  const viewerFileByTab = useAppStore(useShallow((s) => s.viewerFileByTab))
  const base = Math.min(...hidden.map((v) => v.depth))
  const n = hidden.length
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      width="w-80"
      trigger={({ open: shown, toggle }) => (
        <button
          onClick={(e) => {
            e.stopPropagation()
            toggle()
          }}
          title={`${n} more report${n === 1 ? '' : 's'}`}
          aria-label={`${n} more report${n === 1 ? '' : 's'}`}
          aria-expanded={shown}
          data-seg-overflow={hidden.map((v) => v.tab.id).join(' ')}
          className={`my-[7px] mr-1 flex shrink-0 items-center gap-0.5 rounded-[5px] px-1.5 text-[12px] tabular-nums hover:bg-white/[0.08] hover:text-ink [-webkit-app-region:no-drag] ${
            shown ? 'bg-white/[0.08] text-ink' : 'text-ink-2'
          }`}
        >
          +{n}
          <ChevronDown size={12} strokeWidth={1.75} />
        </button>
      )}
    >
      <div className="px-3 pt-2.5 pb-1.5 text-xs text-zinc-400">More reports in this tab</div>
      <div className="max-h-80 overflow-y-auto pb-1" data-seg-overflow-list>
        {hidden.map((v) => (
          <button
            key={v.tab.id}
            onClick={() => {
              setOpen(false)
              onPick(v.tab.id)
            }}
            data-seg-overflow-item={v.tab.id}
            title={v.trail.join(' › ')}
            className={`flex w-full items-center gap-2 py-1.5 pr-3 text-left text-[13px] hover:bg-white/[0.06] ${v.tab.id === activeTabId ? 'text-ink' : 'text-ink-2'}`}
            style={{ paddingLeft: 12 + (v.depth - base) * 14 }}
          >
            {v.depth > base && <ChevronRight aria-hidden size={12} strokeWidth={2} className="-ml-1 shrink-0 text-ink-3" />}
            <PanelIcon tab={v.tab} file={viewerFileByTab[v.tab.id]} />
            <span className="min-w-0 flex-1 truncate">{v.trail[v.trail.length - 1]}</span>
          </button>
        ))}
      </div>
    </Popover>
  )
}

function InsertLine({ edge }: { edge: 'left' | 'right' }) {
  return (
    <span
      aria-hidden
      data-tab-insert={edge}
      className={`pointer-events-none absolute inset-y-1 z-20 w-0.5 rounded-full bg-accent shadow-[0_0_6px_var(--accent)] ${edge === 'left' ? '-left-[2px]' : '-right-[2px]'}`}
    />
  )
}

function ScratchpadTabBadge({ worktreePath, scratchpadId }: { worktreePath: string; scratchpadId: string }) {
  const { list } = useScratchpads(worktreePath)
  const name = list.find((s) => s.id === scratchpadId)?.name
  return (
    <span className="relative shrink-0" title={name ? `Scratchpad “${name}”` : 'Scratchpad'} data-tab-scratchpad={scratchpadId}>
      <FlaskConical className="h-3 w-3 text-violet-400" />
    </span>
  )
}
