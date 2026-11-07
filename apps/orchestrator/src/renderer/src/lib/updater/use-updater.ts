import { useEffect, useState } from 'react'
import type { UpdaterStatus } from '@shared/api'
import { useAppStore } from '../../store'
import { useWorldStore } from '../unity/world-store'
import { censusTrack } from '@shared/census'

const AGENT_ACTIVE_WINDOW_MS = 3000

const lastPtyData = new Map<string, number>()
censusTrack('use-updater.lastPtyData', lastPtyData)
let trackerStartedAt = 0

function startPtyActivityTracker(): () => void {
  trackerStartedAt = Date.now()
  const off = window.api.pty.onData((e) => lastPtyData.set(e.id, Date.now()))
  return () => {
    off()
    lastPtyData.clear()
  }
}

function pruneStalePtyData(): void {
  const now = Date.now()
  for (const [id, at] of lastPtyData) if (now - at >= AGENT_ACTIVE_WINDOW_MS) lastPtyData.delete(id)
}

export function useUpdaterStatus(): UpdaterStatus {
  const [status, setStatus] = useState<UpdaterStatus>({ state: 'idle' })
  useEffect(() => window.api.updater.onStatus(setStatus), [])
  return status
}

function anyUnityPlaying(worlds: ReturnType<typeof useWorldStore.getState>['worlds']): boolean {
  for (const entry of Object.values(worlds)) {
    for (const inst of Object.values(entry.observed.instances)) {
      if (inst.lifecycle === 'playing' || inst.lifecycle === 'entering-play') return true
    }
  }
  return false
}

function anyAgentProcessing(tabsByWorkspace: Record<string, { ptyId: string; contentType?: string; agentId?: string | null }[]>): boolean {
  const now = Date.now()
  for (const tabs of Object.values(tabsByWorkspace)) {
    for (const t of tabs) {
      if (t.contentType === 'terminal' && t.agentId) {
        if (now - trackerStartedAt < AGENT_ACTIVE_WINDOW_MS) return true
        const last = lastPtyData.get(t.ptyId)
        if (last !== undefined && now - last < AGENT_ACTIVE_WINDOW_MS) return true
      }
    }
  }
  return false
}

// Reason the update restart is currently blocked, or null when it's safe to restart.
// Recomputed on a short interval so agent activity (a moving time window) stays fresh.
export function useUpdateBlockReason(active = true): string | null {
  const [, tick] = useState(0)
  const unityPlaying = useWorldStore((s) => active && anyUnityPlaying(s.worlds))

  useEffect(() => {
    if (!active) return
    const stopTracker = startPtyActivityTracker()
    const id = setInterval(() => {
      pruneStalePtyData()
      tick((n) => n + 1)
    }, 1000)
    return () => {
      clearInterval(id)
      stopTracker()
    }
  }, [active])

  if (!active) return null
  if (unityPlaying) return 'Stop Unity Play mode before updating.'
  if (anyAgentProcessing(useAppStore.getState().tabsByWorkspace)) return 'Wait for agents to finish before updating.'
  return null
}
