import { useSyncExternalStore } from 'react'
import { censusTrack } from '@shared/census'

const driven = new Map<string, number>()
censusTrack('driven.driven', driven)
const listeners = new Set<() => void>()
censusTrack('driven.listeners', listeners)

export function setWorkspaceDriven(workspaceId: string, on: boolean): void {
  const n = Math.max(0, (driven.get(workspaceId) ?? 0) + (on ? 1 : -1))
  if (n) driven.set(workspaceId, n)
  else driven.delete(workspaceId)
  for (const l of listeners) l()
}

export function isWorkspaceDriven(workspaceId: string): boolean {
  return driven.has(workspaceId)
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useWorkspaceDriven(workspaceId: string): boolean {
  return useSyncExternalStore(subscribe, () => driven.has(workspaceId))
}
