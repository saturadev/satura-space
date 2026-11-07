import { useSyncExternalStore } from 'react'
import { primaryWorldId } from '@shared/unity/ids'
import { isPendingId, useInstanceIds } from '../../lib/unity/world-store'

const picks = new Map<string, string>()
const subs = new Set<() => void>()

const keyOf = (tabId: string, projectPath: string): string => `${tabId}\n${projectPath}`

export function pickPlayer(tabId: string, projectPath: string, worldId: string, index: number): void {
  const key = keyOf(tabId, projectPath)
  if (picks.get(key) === worldId) return
  picks.set(key, worldId)
  console.info(`[unity] phone shows player ${index + 1} (${worldId})`)
  for (const s of subs) s()
}

function subscribe(cb: () => void): () => void {
  subs.add(cb)
  return () => subs.delete(cb)
}

export function pickedPlayer(tabId: string, projectPath: string): string {
  return picks.get(keyOf(tabId, projectPath)) ?? primaryWorldId(projectPath)
}

export function usePickedPlayer(tabId: string, projectPath: string): { worldId: string; ids: string[] } {
  const ids = useInstanceIds(projectPath)
  const picked = useSyncExternalStore(subscribe, () => picks.get(keyOf(tabId, projectPath)) ?? '')
  const worldId = picked && ids.includes(picked) && !isPendingId(picked) ? picked : primaryWorldId(projectPath)
  return { worldId, ids }
}
