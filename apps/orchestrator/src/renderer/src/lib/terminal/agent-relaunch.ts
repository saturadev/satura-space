import type { AgentId } from '@shared/types'
import { buildAgentLaunchCommand, buildAgentLaunchEnv, getAgentEntry } from '@shared/agent-catalog'
import { useAppStore } from '../../store'
import { takePendingEnv } from './pending-commands'

function agentIdForPty(ptyId: string): AgentId | null {
  const tab = Object.values(useAppStore.getState().tabsByWorkspace)
    .flat()
    .find((t) => t.ptyId === ptyId)
  return tab?.agentId ?? null
}

export function agentLaunchEnvFor(ptyId: string): Record<string, string> | undefined {
  const pendingEnv = takePendingEnv(ptyId)
  const agentId = agentIdForPty(ptyId)
  if (!agentId) return pendingEnv ?? undefined
  const settings = useAppStore.getState().settings
  const extraEnv =
    agentId === 'claude' && settings?.claudeVirtualizedRenderer !== false
      ? { CLAUDE_CODE_NO_FLICKER: '1' }
      : undefined
  const env = { ...buildAgentLaunchEnv(settings?.agents[agentId], { extraEnv }), ...pendingEnv }
  return Object.keys(env).length > 0 ? env : undefined
}

export function agentRelaunchCommandFor(ptyId: string): string | null {
  const s = useAppStore.getState()
  if (s.exitedPtyIds.includes(ptyId)) return null
  const agentId = agentIdForPty(ptyId)
  if (!agentId) return null
  const entry = getAgentEntry(agentId)
  if (!entry) return null
  return buildAgentLaunchCommand(entry, s.settings?.agents[agentId])
}
