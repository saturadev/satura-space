import { useShallow } from 'zustand/react/shallow'
import type { AgentId } from '@shared/types'
import { getAgentLabel } from '@shared/agent-catalog'
import { useAppStore } from '../../store'
import { AgentIcon } from '../../lib/agent-icon'
import { stripAgentStatusGlyph } from '../../lib/agent-status'

export interface PtyAgent {
  agentId: AgentId
  name: string
  tab: string
}

export function usePtyAgent(ptyId: string | null): PtyAgent | null {
  return useAppStore(
    useShallow((s): PtyAgent | null => {
      if (!ptyId) return null
      for (const tabs of Object.values(s.tabsByWorkspace)) {
        const t = tabs.find((x) => x.ptyId === ptyId && x.contentType === 'terminal')
        if (!t) continue
        if (!t.agentId) return null
        return {
          agentId: t.agentId,
          name: getAgentLabel(t.agentId),
          tab: t.customLabel ?? stripAgentStatusGlyph(t.generatedLabel ?? t.label)
        }
      }
      return null
    })
  )
}

export function AgentLine({ agent }: { agent: PtyAgent }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5" data-hover-agent={agent.agentId}>
      <AgentIcon id={agent.agentId} className="h-3.5 w-3.5" />
      <span className="shrink-0">{agent.name}</span>
      {agent.tab && agent.tab !== agent.name && <span className="min-w-0 truncate text-ink-2">· {agent.tab}</span>}
    </span>
  )
}
