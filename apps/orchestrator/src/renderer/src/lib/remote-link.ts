import { useSyncExternalStore } from 'react'

export interface RemoteLink {
  online: boolean
}

let link: RemoteLink | null = null
const subs = new Set<() => void>()

export function setRemoteLink(online: boolean): void {
  if (link?.online === online) return
  link = { online }
  for (const s of subs) s()
}

export function remoteLink(): RemoteLink | null {
  return link
}

export function onRemoteLink(cb: () => void): () => void {
  subs.add(cb)
  return () => subs.delete(cb)
}

export function useRemoteLink(): RemoteLink | null {
  return useSyncExternalStore(onRemoteLink, remoteLink)
}
