import { useCallback, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { getAgentLabel } from '@shared/agent-catalog'
import { useAppStore } from '../../store'
import { PaneFileHierarchySlot } from './PaneFileHierarchySlot'
import {
  SidebarDisclosure,
  sidebarTwoLineRowClass,
  SidebarTitlebar,
  SidebarWindowTitle,
  WorkspacesSection
} from '../workspace/WorkspaceList'
import { AgentIcon } from '../../lib/agent-icon'
import {
  agentStatusLine,
  StatusDot,
  summaryStatus,
  useNow,
  useWorkspaceAgents
} from '../workspace/WorkspaceAgentsBadge'

export function WorkbenchSidebar({
  workspaceIds,
  activeWorkspaceId,
  isPrimary
}: {
  workspaceIds: string[]
  activeWorkspaceId: string | null
  isPrimary: boolean
}) {
  const width = useAppStore((s) => s.sidebarWidth)
  const setSidebarWidth = useAppStore((s) => s.setSidebarWidth)

  return (
    <div className="relative flex h-full shrink-0" style={{ width }}>
      <div className="relative flex min-w-0 flex-1 flex-col bg-window" data-pane="sidebar">
        <SidebarTitlebar />
        {isPrimary ? <WorkspacesSection /> : <SidebarWindowTitle />}
        {activeWorkspaceId && <AgentsSection workspaceId={activeWorkspaceId} />}
        <SectionRule />
        <div className="relative min-h-0 flex-1">
          {workspaceIds.map((id) => (
            <SidebarFiles key={id} workspaceId={id} visible={id === activeWorkspaceId} />
          ))}
        </div>
      </div>
      <ResizeHandle width={width} onResize={setSidebarWidth} />
    </div>
  )
}

function SidebarFiles({ workspaceId, visible }: { workspaceId: string; visible: boolean }) {
  const worktree = useAppStore(useShallow((s) => (s.worktreesByWorkspace[workspaceId] ?? [])[0]))
  const activeGroupId = useAppStore((s) => s.activeGroupIdByWorkspace[workspaceId] ?? '')
  return (
    <div
      className={`absolute inset-0 ${visible ? '' : 'invisible'}`}
      aria-hidden={!visible}
      inert={!visible}
      data-sidebar-files={workspaceId}
    >
      {worktree ? (
        <PaneFileHierarchySlot
          workspaceId={workspaceId}
          groupId={activeGroupId}
          worktreeId={worktree.id}
          rootPath={worktree.path}
        />
      ) : (
        <div className="flex h-full items-center justify-center px-4 text-center text-xs text-ink-3">
          No folder open
        </div>
      )}
    </div>
  )
}

function SectionRule() {
  return <div aria-hidden className="my-1 h-px shrink-0 bg-white/[0.06]" />
}

function AgentsSection({ workspaceId }: { workspaceId: string }) {
  const agents = useWorkspaceAgents(workspaceId)
  const open = useAppStore((s) => !s.sidebarCollapsed.agents)
  const toggleSidebarSection = useAppStore((s) => s.toggleSidebarSection)
  const activateTab = useAppStore((s) => s.activateTab)
  const now = useNow(30000)
  if (agents.length === 0) return null
  return (
    <>
    <SectionRule />
    <div className={`flex shrink-0 flex-col ${open ? 'pb-2' : ''}`} data-sidebar-agents>
      <SidebarDisclosure
        label="Agents"
        open={open}
        onToggle={() => toggleSidebarSection('agents')}
        status={<StatusDot status={summaryStatus(agents)} />}
        count={agents.length}
      />
      {open && (
        <div className="flex flex-col px-2">
          {agents.map((a) => (
            <button
              key={a.tabId}
              onClick={() => activateTab(a.tabId)}
              title={`${a.label} · ${getAgentLabel(a.agentId)}`}
              data-sidebar-agent={a.status}
              className={`${sidebarTwoLineRowClass} w-full text-left text-[13px] hover:bg-white/[0.04] hover:text-ink ${
                a.status === 'working' ? 'text-ink' : 'text-ink-2'
              }`}
            >
              <span
                className={`flex h-[18px] w-4 shrink-0 items-center justify-center ${a.status === 'idle' ? 'opacity-50' : ''}`}
              >
                <AgentIcon id={a.agentId} />
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate leading-[18px]">{a.label}</span>
                <span
                  className={`flex min-w-0 items-center gap-1.5 text-[11.5px] leading-4 ${
                    a.status === 'needs-input' ? 'text-warn' : 'text-ink-3'
                  }`}
                >
                  {a.status === 'working' && <StatusDot status="working" />}
                  <span className="min-w-0 truncate">
                    {getAgentLabel(a.agentId)} · {agentStatusLine(a, now)}
                  </span>
                </span>
              </span>
              <span className="w-6 shrink-0" />
            </button>
          ))}
        </div>
      )}
    </div>
    </>
  )
}

function ResizeHandle({
  width,
  onResize
}: {
  width: number
  onResize: (width: number, persistWidth?: boolean) => void
}) {
  const [dragging, setDragging] = useState(false)

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault()
      const handle = event.currentTarget
      const startX = event.clientX
      const startWidth = width
      let lastWidth: number | null = null
      setDragging(true)
      handle.setPointerCapture(event.pointerId)

      const onPointerMove = (move: PointerEvent): void => {
        if (!handle.hasPointerCapture(event.pointerId)) return
        lastWidth = startWidth + (move.clientX - startX)
        onResize(lastWidth, false)
      }
      let done = false
      const cleanup = (): void => {
        if (done) return
        done = true
        setDragging(false)
        if (lastWidth !== null) onResize(lastWidth)
        try {
          if (handle.hasPointerCapture(event.pointerId))
            handle.releasePointerCapture(event.pointerId)
        } catch {
        }
        handle.removeEventListener('pointermove', onPointerMove)
        handle.removeEventListener('pointerup', cleanup)
        handle.removeEventListener('pointercancel', cleanup)
        handle.removeEventListener('lostpointercapture', cleanup)
      }
      handle.addEventListener('pointermove', onPointerMove)
      handle.addEventListener('pointerup', cleanup)
      handle.addEventListener('pointercancel', cleanup)
      handle.addEventListener('lostpointercapture', cleanup)
    },
    [width, onResize]
  )

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      onPointerDown={onPointerDown}
      className="group relative w-1 shrink-0 cursor-col-resize"
    >
      <div
        className={`absolute inset-y-1 left-[1px] w-0.5 rounded-full ${
          dragging ? 'bg-accent/60' : 'group-hover:bg-accent/40'
        }`}
      />
    </div>
  )
}
