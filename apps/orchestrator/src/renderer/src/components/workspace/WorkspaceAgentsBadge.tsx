import { useEffect, useMemo, useState, type MouseEvent } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { getAgentLabel } from '@shared/agent-catalog'
import { useAppStore } from '../../store'
import { AgentIcon } from '../../lib/agent-icon'
import { FloatingMenu } from '../ui/FloatingMenu'
import {
  countWorking,
  deriveWorkspaceAgents,
  formatElapsed,
  statusSinceFor,
  type AgentRunStatus,
  type AgentSummary
} from '../../lib/agent-status'

export const STATUS_LABEL: Record<AgentRunStatus, string> = {
  working: 'working',
  'needs-input': 'needs input',
  idle: 'idle'
}

export function StatusDot({ status }: { status: AgentRunStatus }) {
  if (status === 'working') {
    return (
      <span className="inline-flex h-3 w-3 shrink-0 animate-spin text-work" aria-label="working">
        <svg viewBox="0 0 16 16" className="h-3 w-3" fill="none">
          <circle cx="8" cy="8" r="6" stroke="currentColor" strokeOpacity="0.25" strokeWidth="1.75" />
          <path d="M14 8a6 6 0 0 0-6-6" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
        </svg>
      </span>
    )
  }
  if (status === 'needs-input') {
    return (
      <svg viewBox="0 0 16 16" className="h-3 w-3 shrink-0 text-warn" fill="none" aria-label="needs input">
        <path d="M8 2.2 14.2 13H1.8L8 2.2Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
        <path d="M8 6.5v3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        <circle cx="8" cy="11.3" r="0.6" fill="currentColor" />
      </svg>
    )
  }
  return (
    <svg viewBox="0 0 16 16" className="h-3 w-3 shrink-0 text-ink-3" fill="none" aria-label="idle">
      <circle cx="8" cy="8" r="5" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  )
}

export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
  return now
}

export function agentStatusLine(a: AgentSummary, now: number): string {
  if (a.status === 'needs-input') return 'waiting for you'
  const elapsed = formatElapsed(now - statusSinceFor(a.ptyId, a.status, now))
  return elapsed ? `${a.status} ${elapsed}` : a.status
}

export function workspaceStatusLine(agents: AgentSummary[]): string {
  const working = countWorking(agents)
  const needs = agents.filter((a) => a.status === 'needs-input').length
  const idle = agents.length - working - needs
  if (working === agents.length) return `${working} agent${working === 1 ? '' : 's'} working`
  if (idle === agents.length) return `${idle} agent${idle === 1 ? '' : 's'} idle`
  return [
    working && `${working} working`,
    needs && `${needs} need${needs === 1 ? 's' : ''} you`,
    idle && `${idle} idle`
  ]
    .filter(Boolean)
    .join(' · ')
}

export function summaryStatus(agents: AgentSummary[]): AgentRunStatus {
  if (agents.some((a) => a.status === 'needs-input')) return 'needs-input'
  if (countWorking(agents) > 0) return 'working'
  return 'idle'
}

export function useWorkspaceAgents(workspaceId: string): AgentSummary[] {
  const tabs = useAppStore(useShallow((s) => s.tabsByWorkspace[workspaceId] ?? []))
  const exitedPtyIds = useAppStore((s) => s.exitedPtyIds)
  const agentHookStatusByPty = useAppStore((s) => s.agentHookStatusByPty)
  return useMemo(
    () => deriveWorkspaceAgents(tabs, new Set(exitedPtyIds), agentHookStatusByPty),
    [tabs, exitedPtyIds, agentHookStatusByPty]
  )
}

export function WorkspaceAgentsBadge({ workspaceId }: { workspaceId: string }) {
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null)
  const workspaceName = useAppStore(
    (s) => s.workspaces.find((w) => w.id === workspaceId)?.name ?? ''
  )
  const setActiveWorkspace = useAppStore((s) => s.setActiveWorkspace)
  const activateTab = useAppStore((s) => s.activateTab)

  const agents = useWorkspaceAgents(workspaceId)

  if (agents.length === 0) return null

  const working = countWorking(agents)
  const title = `${working} working · ${agents.length} agent${agents.length === 1 ? '' : 's'}`
  const status = summaryStatus(agents)

  const toggle = (e: MouseEvent<HTMLButtonElement>): void => {
    e.stopPropagation()
    if (anchor) {
      setAnchor(null)
      return
    }
    const rect = e.currentTarget.getBoundingClientRect()
    setAnchor({ x: rect.left, y: rect.bottom + 6 })
  }

  const focus = (a: AgentSummary): void => {
    setActiveWorkspace(workspaceId)
    activateTab(a.tabId)
    setAnchor(null)
  }

  return (
    <>
      <button
        onClick={toggle}
        onMouseDown={(e) => e.stopPropagation()}
        title={title}
        aria-label={`Working agents: ${title}`}
        data-workspace-agents-line
        className={`-mx-1 flex max-w-full min-w-0 items-center gap-1.5 rounded-sm px-1 text-left text-[11.5px] leading-4 transition-colors hover:bg-white/10 ${
          status === 'needs-input' ? 'text-warn' : 'text-ink-3'
        }`}
      >
        {status === 'working' && <StatusDot status="working" />}
        <span className="min-w-0 truncate">{workspaceStatusLine(agents)}</span>
      </button>

      {anchor && (
        <FloatingMenu x={anchor.x} y={anchor.y} onDismiss={() => setAnchor(null)} className="w-72">
          <div className="flex items-baseline justify-between px-3 py-1.5">
            <span className="truncate text-xs font-semibold text-zinc-200">{workspaceName}</span>
            <span className="ml-2 shrink-0 text-[10px] text-zinc-500">{working} working</span>
          </div>
          <div className="my-1 h-px bg-white/[0.06]" />
          {agents.map((a) => (
            <button
              key={a.tabId}
              onClick={() => focus(a)}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-white/10"
            >
              <AgentIcon id={a.agentId} />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm text-zinc-100">{a.label}</span>
                <span className="truncate text-[10px] text-zinc-500">{getAgentLabel(a.agentId)}</span>
              </span>
              <span className="flex shrink-0 items-center gap-1.5">
                <span className="text-[10px] text-zinc-500">{STATUS_LABEL[a.status]}</span>
                <StatusDot status={a.status} />
              </span>
            </button>
          ))}
        </FloatingMenu>
      )}
    </>
  )
}
