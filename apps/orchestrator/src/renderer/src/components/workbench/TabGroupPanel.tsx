import { memo, useState, type ReactNode } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { Tab, TabContentType } from '@shared/types'
import { useAppStore } from '../../store'
import { TabBar } from './TabBar'
import { PaneTerminalSlot } from './PaneTerminalSlot'
import { PaneUnitySlot } from './PaneUnitySlot'
import { PaneFileViewerSlot } from './PaneFileViewerSlot'
import { PaneDropZones } from './PaneDropZones'
import { HiddenGroupCard } from './HiddenGroupCard'
import { NewSessionMenu } from './NewSessionMenu'
import { PaneScratchpadSlot } from '../scratchpad/PaneScratchpadSlot'
import { TargetedToolPane, isTargetedToolType } from '../scratchpad/TargetedToolPane'
import { PaneGitScmSlot } from './PaneGitScmSlot'
import { PaneDashboardSlot } from '../dashboard/PaneDashboardSlot'
import { PaneErrorBoundary } from './PaneErrorBoundary'
import { shownTab } from '../../lib/tab-tree'
import { IS_MAC } from '../../lib/shortcuts/shortcuts'
import { pickPath } from '../../lib/file-picker/file-picker-store'

const PANEL_RADIUS = 6
const WINDOW_CORNER_RADIUS = IS_MAC ? 10 : 8

const TabGroupPane = memo(function TabGroupPane(props: TabGroupPaneProps) {
  return (
    <PaneErrorBoundary key={props.tabId} label="Panel">
      <TabGroupPaneContent {...props} />
    </PaneErrorBoundary>
  )
})

interface TabGroupPaneProps {
  contentType: TabContentType
  ptyId: string
  tabId: string
  projectPath: string
  scratchpadId: string | null
  focused: boolean
}

function TabGroupPaneContent({
  contentType,
  ptyId,
  tabId,
  projectPath,
  scratchpadId,
  focused
}: TabGroupPaneProps) {
  if (contentType === 'unity-instance-player') {
    return <PaneUnitySlot id={ptyId} projectPath={projectPath} />
  }
  if (isTargetedToolType(contentType)) {
    return (
      <TargetedToolPane
        contentType={contentType}
        tabId={tabId}
        ptyId={ptyId}
        worktreePath={projectPath}
        scratchpadId={scratchpadId}
      />
    )
  }
  if (contentType === 'unity-scratchpad') {
    return <PaneScratchpadSlot tabId={tabId} ptyId={ptyId} projectPath={projectPath} />
  }
  if (contentType === 'file-viewer') {
    return <PaneFileViewerSlot rootPath={projectPath} tabId={tabId} focused={focused} />
  }
  if (contentType === 'git-scm') {
    return <PaneGitScmSlot ptyId={ptyId} />
  }
  if (contentType === 'dashboard') {
    return <PaneDashboardSlot tabId={tabId} projectPath={projectPath} />
  }
  return <PaneTerminalSlot ptyId={ptyId} />
}

export interface GroupEdges {
  top: boolean
  left: boolean
  right: boolean
}

export const TabGroupPanel = memo(function TabGroupPanel({
  workspaceId,
  groupId,
  edges,
  renderPane,
  tabActions = true
}: {
  workspaceId: string
  groupId: string
  edges?: GroupEdges
  renderPane?: (tab: Tab) => ReactNode
  tabActions?: boolean
}) {
  const group = useAppStore((s) => s.groupsByWorkspace[workspaceId]?.find((g) => g.id === groupId))
  const orderedTabs = useAppStore(
    useShallow((s) => {
      const g = s.groupsByWorkspace[workspaceId]?.find((x) => x.id === groupId)
      if (!g) return []
      const all = s.tabsByWorkspace[workspaceId] ?? []
      return g.tabOrder
        .map((id) => all.find((t) => t.id === id))
        .filter((t): t is Tab => Boolean(t))
    })
  )
  const worktrees = useAppStore(useShallow((s) => s.worktreesByWorkspace[workspaceId] ?? []))
  const isGroupActive = useAppStore((s) => s.activeGroupIdByWorkspace[workspaceId] === groupId)
  const dropZone = useAppStore((s) =>
    s.externalDropTarget?.scope === 'leaf' && s.externalDropTarget.groupId === groupId
      ? s.externalDropTarget.zone
      : null
  )
  const setActiveGroup = useAppStore((s) => s.setActiveGroup)
  const createTab = useAppStore((s) => s.createTab)
  const createWorktree = useAppStore((s) => s.createWorktree)
  const defaultProjectsFolder = useAppStore((s) => s.settings?.defaultProjectsFolder ?? '')
  const activeTab = group ? shownTab(group, orderedTabs) : undefined
  const activePtyId = activeTab?.ptyId
  const activePulse = useAppStore((s) => (activePtyId ? s.pulseByPty[activePtyId] : undefined))
  const groupCount = useAppStore((s) => s.groupsByWorkspace[workspaceId]?.length ?? 0)
  const sidebarOpen = useAppStore((s) => s.sidebarOpen)
  const flushTop = !!edges?.top
  const flushRight = !!edges?.right
  const flushLeft = !!edges?.left && !sidebarOpen
  const corner = (a: boolean, b: boolean): number =>
    a && b ? WINDOW_CORNER_RADIUS : PANEL_RADIUS
  const shape = {
    borderTopLeftRadius: corner(flushTop, flushLeft),
    borderTopRightRadius: corner(flushTop, flushRight),
    borderBottomLeftRadius: corner(false, flushLeft),
    borderBottomRightRadius: corner(false, flushRight)
  }
  const closeGroup = useAppStore((s) => s.closeGroup)
  const [addOpen, setAddOpen] = useState(false)

  if (!group) return null

  const addTerminal = async (): Promise<void> => {
    let worktreeId = worktrees[0]?.id
    if (!worktreeId) {
      const path = await pickPath({
        mode: 'openFolder',
        purpose: 'project',
        title: 'Choose a folder for the terminal',
        confirmLabel: 'Choose',
        defaultPath: defaultProjectsFolder || undefined,
        unity: true
      })
      if (!path) return
      worktreeId = createWorktree(workspaceId, path).id
    }
    createTab(workspaceId, worktreeId, { groupId })
  }

  return (
    <div
      onMouseDown={() => {
        if (!isGroupActive) setActiveGroup(workspaceId, groupId)
      }}
      className="relative flex h-full w-full flex-col overflow-hidden bg-canvas"
      style={shape}
      data-group-focused={isGroupActive ? 'true' : undefined}
      data-pane-group={groupId}
      data-active-tab={group.activeTabId ?? undefined}
    >
      {!group.hidden && (
        <TabBar
          workspaceId={workspaceId}
          groupId={groupId}
          tabs={orderedTabs}
          activeTabId={group.activeTabId}
          worktrees={worktrees}
          focused={isGroupActive}
          edges={edges}
          actions={tabActions}
        />
      )}
      <div className="relative min-h-0 flex-1 overflow-hidden" data-group-id={groupId}>
        {group.hidden ? (
          <HiddenGroupCard workspaceId={workspaceId} groupId={groupId} tabs={orderedTabs} />
        ) : activeTab && renderPane ? (
          renderPane(activeTab)
        ) : activeTab ? (
          <TabGroupPane
            key={activeTab.ptyId}
            contentType={activeTab.contentType}
            ptyId={activeTab.ptyId}
            tabId={activeTab.id}
            projectPath={worktrees.find((w) => w.id === activeTab.worktreeId)?.path ?? ''}
            scratchpadId={activeTab.scratchpadId ?? null}
            focused={isGroupActive}
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center" data-empty-group={groupId}>
            <p className="text-sm text-zinc-500">{groupCount > 1 ? 'This panel group is empty' : 'No terminals in this group'}</p>
            <div className="flex items-center gap-2">
              {worktrees[0] ? (
                <div className="relative">
                  <button
                    onClick={() => setAddOpen((v) => !v)}
                    data-empty-group-add
                    className="rounded bg-elevated px-4 py-2 text-sm text-ink transition-colors hover:bg-white/10"
                  >
                    Add panel
                  </button>
                  {addOpen && (
                    <NewSessionMenu
                      workspaceId={workspaceId}
                      groupId={groupId}
                      defaultWorktreeId={worktrees[0].id}
                      onClose={() => setAddOpen(false)}
                    />
                  )}
                </div>
              ) : (
                <button
                  onClick={() => void addTerminal()}
                  className="rounded bg-elevated px-4 py-2 text-sm text-ink transition-colors hover:bg-white/10"
                >
                  Add a folder…
                </button>
              )}
              {groupCount > 1 && (
                <button
                  onClick={() => closeGroup(workspaceId, groupId)}
                  data-empty-group-close
                  className="rounded px-4 py-2 text-sm text-zinc-400 transition-colors hover:bg-white/10 hover:text-white"
                >
                  Close group
                </button>
              )}
            </div>
          </div>
        )}
        <PaneDropZones zone={dropZone} />
        {activePulse && !group.hidden && (
          <span
            key={activePulse.seq}
            aria-hidden
            className={`satura-alert-flash pointer-events-none absolute inset-0 z-20 ring-1 ring-inset ${
              activePulse.kind === 'finished'
                ? 'ring-emerald-400/40'
                : activePulse.kind === 'opened'
                  ? 'ring-sky-400/60'
                  : 'ring-amber-400/40'
            }`}
          />
        )}
      </div>
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 z-[25] border-solid border-white/[0.06]"
        style={{
          ...shape,
          borderTopWidth: flushTop ? 0 : 1,
          borderRightWidth: flushRight ? 0 : 1,
          borderBottomWidth: 1,
          borderLeftWidth: flushLeft ? 0 : 1
        }}
      />
    </div>
  )
})
