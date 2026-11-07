import { useEffect } from 'react'
import { DEFAULT_SETTINGS, type Tab } from '@shared/types'
import type { AgentHookEvent, AgentPaneReport } from '@shared/api'
import { useAppStore, type AppState } from '../../store'
import { hookStatus, stripAgentStatusGlyph } from '../agent-status'
import { collectGroupIds } from '../tab-tree'
import { getTerminalInstance } from '../terminal/terminal-registry'
import { soundUrl } from './sound-catalog'
import { playSound } from './play-sound'
import { censusTrack } from '@shared/census'

const COLLAPSE_WINDOW_MS = 1000
const lastFiredAt = new Map<string, number>()
censusTrack('use-agent-alerts.lastFiredAt', lastFiredAt)

function locateTabByPty(state: AppState, ptyId: string): { workspaceId: string; tab: Tab } | null {
  for (const [workspaceId, tabs] of Object.entries(state.tabsByWorkspace)) {
    const tab = tabs.find((t) => t.ptyId === ptyId)
    if (tab) return { workspaceId, tab }
  }
  return null
}

function isDuplicate(event: AgentHookEvent): boolean {
  const key = `${event.id}:${event.kind}`
  const now = Date.now()
  const previous = lastFiredAt.get(key)
  if (previous !== undefined && now - previous < COLLAPSE_WINDOW_MS) return true
  for (const [k, at] of lastFiredAt) if (now - at >= COLLAPSE_WINDOW_MS) lastFiredAt.delete(k)
  lastFiredAt.set(key, now)
  return false
}

export function agentPaneReports(s: AppState, pageVisible: boolean): AgentPaneReport[] {
  const out: AgentPaneReport[] = []
  for (const ws of s.workspaces) {
    const tabs = s.tabsByWorkspace[ws.id] ?? []
    const groups = s.groupsByWorkspace[ws.id] ?? []
    const inLayout = new Set(collectGroupIds(s.layoutByWorkspace[ws.id]))
    const fullscreen = s.fullscreenGroupIdByWorkspace[ws.id] ?? null
    const shown = new Set(
      groups
        .filter((g) => !g.hidden && inLayout.has(g.id) && (!fullscreen || g.id === fullscreen))
        .map((g) => g.activeTabId)
        .filter((id): id is string => !!id)
    )
    for (const t of tabs) {
      if (t.contentType !== 'terminal') continue
      out.push({
        ptyId: t.ptyId,
        agentId: t.agentId ?? null,
        label: t.customLabel ?? stripAgentStatusGlyph(t.generatedLabel ?? t.label),
        workspace: ws.name,
        visible: pageVisible && ws.id === s.activeWorkspaceId && shown.has(t.id)
      })
    }
  }
  return out
}

function focusAgentTab(ptyId: string): void {
  const s = useAppStore.getState()
  const located = locateTabByPty(s, ptyId)
  if (!located) return
  if (s.activeWorkspaceId !== located.workspaceId) s.setActiveWorkspace(located.workspaceId)
  useAppStore.getState().activateTab(located.tab.id)
  requestAnimationFrame(() => getTerminalInstance(ptyId)?.focus())
}

function useAgentPaneReports(): void {
  useEffect(() => {
    let last = ''
    const send = (): void => {
      const panes = agentPaneReports(useAppStore.getState(), document.visibilityState === 'visible')
      const key = JSON.stringify(panes)
      if (key === last) return
      last = key
      window.api.pty.reportAgentPanes(panes)
    }
    send()
    const unsub = useAppStore.subscribe((s, prev) => {
      if (
        s.tabsByWorkspace === prev.tabsByWorkspace &&
        s.groupsByWorkspace === prev.groupsByWorkspace &&
        s.layoutByWorkspace === prev.layoutByWorkspace &&
        s.fullscreenGroupIdByWorkspace === prev.fullscreenGroupIdByWorkspace &&
        s.activeWorkspaceId === prev.activeWorkspaceId &&
        s.workspaces === prev.workspaces
      )
        return
      send()
    })
    document.addEventListener('visibilitychange', send)
    const off = window.api.pty.onFocusAgent((e) => focusAgentTab(e.id))
    return () => {
      unsub()
      off()
      document.removeEventListener('visibilitychange', send)
    }
  }, [])
}

export function useAgentAlerts(): void {
  useAgentPaneReports()
  useEffect(() => {
    let live = true
    void window.api.pty
      .agentStates()
      .then((events) => {
        if (!live) return
        const state = useAppStore.getState()
        for (const e of events ?? []) state.setAgentHookStatus(e.id, hookStatus(e.kind))
      })
      .catch(() => {})
    const off = window.api.pty.onAgentHook((event: AgentHookEvent) => {
      const state = useAppStore.getState()
      state.setAgentHookStatus(event.id, hookStatus(event.kind))
      if (event.kind !== 'finished' && event.kind !== 'attention') return
      const kind = event.kind
      const located = locateTabByPty(state, event.id)
      if (!located) return
      const settings = state.settings ?? DEFAULT_SETTINGS
      if (!settings.agentAlertHighlight && !settings.agentAlertSound) return
      if (!located.tab.agentId) return
      if (isDuplicate(event)) return
      if (settings.agentAlertHighlight) {
        state.pulseAgentPane(event.id, kind)
        if (state.activeWorkspaceId !== located.workspaceId) {
          state.setWorkspaceAlert(located.workspaceId, kind)
        }
      }
      if (settings.agentAlertSound) {
        const finished = kind === 'finished'
        const url =
          soundUrl(finished ? settings.agentAlertFinishedSound : settings.agentAlertAttentionSound) ??
          soundUrl(finished ? DEFAULT_SETTINGS.agentAlertFinishedSound : DEFAULT_SETTINGS.agentAlertAttentionSound)
        if (url) playSound(url, settings.agentAlertVolume ?? DEFAULT_SETTINGS.agentAlertVolume)
      }
    })
    return () => {
      live = false
      off()
    }
  }, [])
}
