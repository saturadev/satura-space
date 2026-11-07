import { useEffect, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '../../store'
import { TabGroupSplitLayout } from './TabGroupSplitLayout'
import { TerminalSessionLayer } from './TerminalSessionLayer'
import { UnitySessionLayer } from './UnitySessionLayer'
import { GitScmSessionLayer } from './GitScmSessionLayer'
import { RootDropZones } from './RootDropZones'
import { WorkbenchSidebar } from './WorkbenchSidebar'
import { WorkspaceCreatingOverlay } from './WorkspaceCreatingOverlay'
import { StartScreen } from '../startscreen/StartScreen'
import { ClaudeRestorePrompt } from './ClaudeSessionPicker'
import { useWorkspaceDriven } from '../../lib/agent-exec/driven'
import { syncReportSegments, terminalRoot, useReportPlan, workspaceTerminals } from '../../lib/terminal/report-groups'
import { useWatchReportRoots } from '../../lib/terminal/terminal-reports'

export function Workbench({ isPrimary }: { isPrimary: boolean }) {
  const { workspaces, activeWorkspaceId } = useAppStore(
    useShallow((s) => ({ workspaces: s.workspaces, activeWorkspaceId: s.activeWorkspaceId }))
  )
  const overlayPhase = useAppStore((s) => s.overlayPhase)
  const sidebarOpen = useAppStore((s) => s.sidebarOpen)
  const sidebarVisible = sidebarOpen && workspaces.length > 0

  const [opened, setOpened] = useState<Set<string>>(() => new Set())
  useEffect(() => {
    if (activeWorkspaceId) {
      setOpened((prev) =>
        prev.has(activeWorkspaceId) ? prev : new Set(prev).add(activeWorkspaceId)
      )
    }
  }, [activeWorkspaceId])

  const toRender = workspaces
    .filter((w) => opened.has(w.id) || w.id === activeWorkspaceId)
    .map((w) => w.id)

  return (
    <div className="flex h-full w-full bg-window">
      {sidebarVisible && (
        <WorkbenchSidebar
          workspaceIds={toRender}
          activeWorkspaceId={activeWorkspaceId}
          isPrimary={isPrimary}
        />
      )}
      <div
        className="relative min-w-0 flex-1 pb-1"
        data-sidebar-visible={sidebarVisible ? 'true' : undefined}
      >
      <div className="relative h-full w-full">
      <TerminalSessionLayer workspaceIds={toRender} activeWorkspaceId={activeWorkspaceId} />
      <UnitySessionLayer workspaceIds={toRender} activeWorkspaceId={activeWorkspaceId} />
      <GitScmSessionLayer workspaceIds={toRender} activeWorkspaceId={activeWorkspaceId} />
      <ScratchpadHostSync />
      <ScratchpadPanelSync />
      {toRender.map((wsId) => (
        <WorkspaceView key={wsId} workspaceId={wsId} visible={wsId === activeWorkspaceId} />
      ))}
      {!activeWorkspaceId && (
        <div className="absolute inset-0 z-20 overflow-hidden rounded-md">
          <StartScreen />
        </div>
      )}
      {overlayPhase !== 'idle' && <WorkspaceCreatingOverlay />}
      </div>
      </div>
    </div>
  )
}

function ScratchpadPanelSync() {
  const paths = useAppStore(
    useShallow((s) => {
      const out = new Set<string>()
      for (const [wsId, tabs] of Object.entries(s.tabsByWorkspace)) {
        const wts = s.worktreesByWorkspace[wsId] ?? []
        for (const t of tabs) {
          if (t.contentType !== 'unity-scratchpad') continue
          const path = wts.find((w) => w.id === t.worktreeId)?.path
          if (path) out.add(path)
        }
      }
      return [...out].sort()
    })
  )
  const key = paths.join('\n')
  useEffect(() => {
    window.api.scratchpads?.setPanels(paths)
  }, [key])
  return null
}

function ScratchpadHostSync() {
  const paths = useAppStore(
    useShallow((s) => {
      const out = new Set<string>()
      for (const ws of s.workspaces) {
        if (ws.folderPath) out.add(ws.folderPath)
        if (ws.worktreePath) out.add(ws.worktreePath)
      }
      return [...out].sort()
    })
  )
  const key = paths.join('\n')
  useEffect(() => {
    const api = window.api.scratchpads
    if (!api) return
    for (const p of paths) void api.attach(p)
  }, [key])
  return null
}

function WorkspaceView({ workspaceId, visible }: { workspaceId: string; visible: boolean }) {
  const ensureWorkbench = useAppStore((s) => s.ensureWorkbench)
  const driven = useWorkspaceDriven(workspaceId)
  useEffect(() => {
    ensureWorkbench(workspaceId)
  }, [workspaceId, ensureWorkbench])

  const behind = !visible && driven
  const hidden = !visible && !driven
  return (
    <div
      className={`absolute inset-0 flex min-h-0 ${visible ? '' : behind ? 'opacity-0' : 'invisible opacity-0'}`}
      style={behind ? { zIndex: -1 } : undefined}
      aria-hidden={hidden}
      inert={hidden}
      data-workspace-view={workspaceId}
      data-driven={driven ? 'true' : undefined}
    >
      <div className="relative min-w-0 flex-1" data-workspace={workspaceId} data-active={visible}>
        <TabGroupSplitLayout workspaceId={workspaceId} />
        <RootDropZones />
        <ClaudeRestorePrompt workspaceId={workspaceId} active={visible} />
        <ReportGroupsSync workspaceId={workspaceId} />
      </div>
    </div>
  )
}

function ReportGroupsSync({ workspaceId }: { workspaceId: string }) {
  const roots = useAppStore(
    useShallow((s) => [...new Set(workspaceTerminals(s, workspaceId).filter((t) => t.claudeSessionId).map((t) => terminalRoot(s, workspaceId, t)).filter(Boolean))].sort())
  )
  useWatchReportRoots(roots)
  const plan = useReportPlan(workspaceId)
  useEffect(() => {
    syncReportSegments(workspaceId, plan)
  }, [workspaceId, plan])
  return null
}
