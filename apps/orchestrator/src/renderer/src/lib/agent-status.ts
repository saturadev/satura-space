import type { AgentId, Tab } from '@shared/types'
import type { AgentHookKind } from '@shared/api'
import { detectAgentStatusFromTitle, stripAgentStatusGlyph } from '@shared/agent-title'

export { detectAgentStatusFromTitle, stripAgentStatusGlyph }

export type AgentRunStatus = 'working' | 'idle' | 'needs-input'

export function hookStatus(kind: AgentHookKind): AgentRunStatus {
  return kind === 'working' ? 'working' : kind === 'attention' ? 'needs-input' : 'idle'
}

export interface AgentSummary {
  tabId: string
  ptyId: string
  agentId: AgentId
  label: string
  status: AgentRunStatus
}

export function agentRunStatusFor(
  tab: Tab,
  exited: boolean,
  hook: AgentRunStatus | undefined
): AgentRunStatus {
  if (exited) return 'idle'
  const detected = detectAgentStatusFromTitle(tab.generatedLabel)
  if (hook === 'needs-input') return 'needs-input'
  return detected ?? hook ?? 'idle'
}

const STATUS_ORDER: Record<AgentRunStatus, number> = { working: 0, 'needs-input': 1, idle: 2 }

export function deriveWorkspaceAgents(
  tabs: Tab[],
  exitedPtyIds: Set<string>,
  hookStatusByPty: Record<string, AgentRunStatus> = {}
): AgentSummary[] {
  const summaries: AgentSummary[] = []
  for (const tab of tabs) {
    if (!tab.agentId) continue
    const status = agentRunStatusFor(tab, exitedPtyIds.has(tab.ptyId), hookStatusByPty[tab.ptyId])
    summaries.push({
      tabId: tab.id,
      ptyId: tab.ptyId,
      agentId: tab.agentId,
      label: tab.customLabel ?? stripAgentStatusGlyph(tab.generatedLabel ?? tab.label),
      status
    })
  }
  return summaries.sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status])
}

const statusSince = new Map<string, { status: AgentRunStatus; since: number }>()

export function statusSinceFor(ptyId: string, status: AgentRunStatus, now: number): number {
  const prev = statusSince.get(ptyId)
  if (prev && prev.status === status) return prev.since
  statusSince.set(ptyId, { status, since: now })
  return now
}

export function formatElapsed(ms: number): string {
  const m = Math.floor(ms / 60000)
  if (m < 1) return ''
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return m % 60 ? `${h}h ${m % 60}m` : `${h}h`
}

export function countWorking(summaries: AgentSummary[]): number {
  return summaries.reduce((n, s) => (s.status === 'working' ? n + 1 : n), 0)
}
