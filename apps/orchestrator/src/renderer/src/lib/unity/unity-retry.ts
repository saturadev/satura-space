import { useSyncExternalStore } from 'react'
import { censusTrack } from '@shared/census'

const nonces = new Map<string, number>()
censusTrack('unity-retry.nonces', nonces)
const listeners = new Map<string, Set<() => void>>()
censusTrack('unity-retry.listeners', listeners)

export function getUnityRetry(id: string): number {
  return nonces.get(id) ?? 0
}

export function bumpUnityRetry(id: string): void {
  nonces.set(id, getUnityRetry(id) + 1)
  listeners.get(id)?.forEach((fn) => fn())
}

export function forgetUnityRetry(id: string): void {
  nonces.delete(id)
}

export function useUnityRetry(id: string): number {
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
    () => getUnityRetry(id)
  )
}
