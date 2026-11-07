import { useSyncExternalStore } from 'react'
import type { RemotePresence } from '@shared/remote-protocol'

let list: RemotePresence[] = []
let started = false
const listeners = new Set<() => void>()

function set(next: RemotePresence[]): void {
  list = Array.isArray(next) ? next : []
  for (const l of listeners) l()
}

function start(): void {
  if (started || typeof window === 'undefined' || !window.api?.remote?.onPresence) return
  started = true
  window.api.remote.onPresence(set)
  void window.api.remote
    .presence()
    .then((v) => Array.isArray(v) && set(v))
    .catch(() => {})
}

function subscribe(cb: () => void): () => void {
  start()
  listeners.add(cb)
  return () => listeners.delete(cb)
}

export function useRemoteViewers(tabIds: readonly string[]): string[] {
  const key = useSyncExternalStore(subscribe, () =>
    list
      .filter((p) => tabIds.includes(p.tabId))
      .map((p) => p.device)
      .join('\n')
  )
  return key ? [...new Set(key.split('\n'))] : []
}
