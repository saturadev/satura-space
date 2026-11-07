
import { useSyncExternalStore } from 'react'
import { censusTrack } from '@shared/census'
import type { InputGateProblem, UnityStartResult } from '@shared/api'

export interface SessionStatus {
  standalone: boolean
  revealed: boolean
  error: string | null
  hub: UnityStartResult['hub'] | null
  inputGate: InputGateProblem | null
}

const DEFAULT: SessionStatus = { standalone: false, revealed: false, error: null, hub: null, inputGate: null }

const statuses = new Map<string, SessionStatus>()
censusTrack('session-status.statuses', statuses)
const listeners = new Map<string, Set<() => void>>()
censusTrack('session-status.listeners', listeners)

function emit(id: string): void {
  listeners.get(id)?.forEach((fn) => fn())
}

export function getSessionStatus(id: string): SessionStatus {
  return statuses.get(id) ?? DEFAULT
}

export function setSessionStatus(id: string, patch: Partial<SessionStatus>): void {
  const next = { ...getSessionStatus(id), ...patch }
  const prev = statuses.get(id) ?? DEFAULT
  if (
    next.standalone === prev.standalone &&
    next.revealed === prev.revealed &&
    next.error === prev.error &&
    next.hub === prev.hub &&
    next.inputGate === prev.inputGate
  )
    return
  statuses.set(id, next)
  emit(id)
}

export function clearSessionStatus(id: string): void {
  if (!statuses.delete(id)) return
  emit(id)
}

export function useSessionStatus(id: string): SessionStatus {
  return useSyncExternalStore(
    (cb) => {
      let set = listeners.get(id)
      if (!set) {
        set = new Set()
        listeners.set(id, set)
      }
      set.add(cb)
      return () => {
        set!.delete(cb)
        if (set!.size === 0) listeners.delete(id)
      }
    },
    () => getSessionStatus(id)
  )
}
