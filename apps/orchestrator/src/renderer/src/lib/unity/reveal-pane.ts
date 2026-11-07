import { useAppStore } from '../../store'
import { agentRunStatusFor } from '../agent-status'

export function useAgentsWorkingForPane(primaryPtyId: string): boolean {
  return useAppStore((s) => {
    if (!primaryPtyId) return false
    for (const tabs of Object.values(s.tabsByWorkspace)) {
      const owns = tabs.some(
        (t) => t.contentType === 'unity-instance-player' && t.ptyId === primaryPtyId
      )
      if (!owns) continue
      return tabs.some(
        (t) =>
          !!t.agentId &&
          agentRunStatusFor(t, s.exitedPtyIds.includes(t.ptyId), s.agentHookStatusByPty[t.ptyId]) ===
            'working'
      )
    }
    return false
  })
}

export function afterNextPaint(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  })
}
