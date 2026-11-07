import { useEffect } from 'react'
import {
  CLAUDE_AGENT_ID,
  initialClaudeSessionTrack,
  nextClaudeSessionTrack,
  type ClaudeSessionEvent,
  type ClaudeSessionTrack
} from '@shared/claude-sessions'
import type { Tab } from '@shared/types'
import { useAppStore } from '../../store'
import { censusTrack } from '@shared/census'
import { debugLog } from '@shared/debug-log'

const tracks = new Map<string, ClaudeSessionTrack>()
censusTrack('session-tracking.tracks', tracks)

function tabForPty(ptyId: string): Tab | null {
  for (const tabs of Object.values(useAppStore.getState().tabsByWorkspace)) {
    const tab = tabs.find((t) => t.ptyId === ptyId)
    if (tab) return tab
  }
  return null
}

export function applyClaudeSessionEvent(event: ClaudeSessionEvent): void {
  const tab = tabForPty(event.id)
  if (!tab || tab.agentId !== CLAUDE_AGENT_ID) return
  const current = tracks.get(event.id) ?? initialClaudeSessionTrack(tab.claudeSessionId)
  const next = nextClaudeSessionTrack(current, event)
  tracks.set(event.id, next)
  if (!next.sessionId || next.sessionId === (tab.claudeSessionId ?? null)) return
  useAppStore.getState().setTabClaudeSession(event.id, next.sessionId)
  debugLog(`[claude-session] tab ${tab.id} now tracks session ${next.sessionId}`)
}

export function forgetClaudeSessionTrack(ptyId: string): void {
  tracks.delete(ptyId)
}

export function useClaudeSessionTracking(): void {
  useEffect(() => window.api.pty.onClaudeSession(applyClaudeSessionEvent), [])
}
