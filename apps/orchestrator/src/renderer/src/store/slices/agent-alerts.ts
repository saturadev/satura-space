import type { StateCreator } from 'zustand'
import type { AppState } from '../index'
import type { AgentRunStatus } from '../../lib/agent-status'
import { censusTrack } from '@shared/census'

export type AgentAlertKind = 'finished' | 'attention'

export type PanePulseKind = AgentAlertKind | 'opened'

export interface AgentAlertPulse {
  kind: PanePulseKind
  seq: number
}

export interface AgentAlertsSlice {
  pulseByPty: Record<string, AgentAlertPulse>
  pulseAgentPane: (ptyId: string, kind: PanePulseKind) => void
  clearAgentPulse: (ptyId: string) => void
  workspaceAlertByWorkspace: Record<string, AgentAlertKind>
  setWorkspaceAlert: (workspaceId: string, kind: AgentAlertKind) => void
  clearWorkspaceAlert: (workspaceId: string) => void
  agentHookStatusByPty: Record<string, AgentRunStatus>
  setAgentHookStatus: (ptyId: string, status: AgentRunStatus) => void
}

const PULSE_DURATION_MS = 2700
const timers = new Map<string, ReturnType<typeof setTimeout>>()
censusTrack('agent-alerts.timers', timers)

export const createAgentAlertsSlice: StateCreator<AppState, [], [], AgentAlertsSlice> = (
  set,
  get
) => ({
  pulseByPty: {},

  pulseAgentPane: (ptyId, kind) => {
    const seq = (get().pulseByPty[ptyId]?.seq ?? 0) + 1
    set((s) => ({ pulseByPty: { ...s.pulseByPty, [ptyId]: { kind, seq } } }))
    const existing = timers.get(ptyId)
    if (existing) clearTimeout(existing)
    timers.set(
      ptyId,
      setTimeout(() => {
        timers.delete(ptyId)
        get().clearAgentPulse(ptyId)
      }, PULSE_DURATION_MS)
    )
  },

  clearAgentPulse: (ptyId) => {
    const existing = timers.get(ptyId)
    if (existing) {
      clearTimeout(existing)
      timers.delete(ptyId)
    }
    set((s) => {
      if (!s.pulseByPty[ptyId]) return s
      const next = { ...s.pulseByPty }
      delete next[ptyId]
      return { pulseByPty: next }
    })
  },

  workspaceAlertByWorkspace: {},

  setWorkspaceAlert: (workspaceId, kind) =>
    set((s) => {
      if (s.workspaceAlertByWorkspace[workspaceId] === 'attention' && kind === 'finished') return s
      return { workspaceAlertByWorkspace: { ...s.workspaceAlertByWorkspace, [workspaceId]: kind } }
    }),

  clearWorkspaceAlert: (workspaceId) =>
    set((s) => {
      if (!s.workspaceAlertByWorkspace[workspaceId]) return s
      const next = { ...s.workspaceAlertByWorkspace }
      delete next[workspaceId]
      return { workspaceAlertByWorkspace: next }
    }),

  agentHookStatusByPty: {},

  setAgentHookStatus: (ptyId, status) =>
    set((s) =>
      s.agentHookStatusByPty[ptyId] === status
        ? s
        : { agentHookStatusByPty: { ...s.agentHookStatusByPty, [ptyId]: status } }
    )
})
