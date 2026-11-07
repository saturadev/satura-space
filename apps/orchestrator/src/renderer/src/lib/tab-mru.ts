import type { TabGroup } from '@shared/types'

const usedAt = new Map<string, number>()
let tick = 0

export function noteActiveTabs(next: Record<string, TabGroup[]>, prev: Record<string, TabGroup[]> | undefined): void {
  if (next === prev) return
  for (const [ws, groups] of Object.entries(next)) {
    const before = prev?.[ws]
    if (groups === before) continue
    for (const g of groups) {
      if (!g.activeTabId) continue
      if (before?.find((b) => b.id === g.id)?.activeTabId === g.activeTabId) continue
      usedAt.set(g.activeTabId, ++tick)
    }
  }
}

export function forgetTabUse(tabId: string): void {
  usedAt.delete(tabId)
}

export function pickRecentTab(tabOrder: string[], leavingTabId: string): string | null {
  let best: string | null = null
  let bestAt = 0
  for (const id of tabOrder) {
    if (id === leavingTabId) continue
    const at = usedAt.get(id) ?? 0
    if (at > bestAt) {
      best = id
      bestAt = at
    }
  }
  if (best) return best
  const idx = tabOrder.indexOf(leavingTabId)
  if (idx === -1) return null
  if (idx + 1 < tabOrder.length) return tabOrder[idx + 1]
  if (idx - 1 >= 0) return tabOrder[idx - 1]
  return null
}
