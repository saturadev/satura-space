import { useEffect, useState } from 'react'
import type { RvLayout } from '@shared/remote-video'

const shown = new Map<string, string>()
const seen = new Map<string, number>()
const listeners = new Set<() => void>()
let visible: Set<string> | null = null
let seq = 0

function bump(): void {
  for (const l of listeners) l()
}

export function noteMacLayout(layout: RvLayout): void {
  const next = new Set(layout.groups.map((g) => g.id))
  let changed = !visible || visible.size !== next.size || [...next].some((id) => !visible?.has(id))
  visible = next
  for (const g of layout.groups) {
    if (!g.tab || shown.get(g.id) === g.tab) continue
    shown.set(g.id, g.tab)
    changed = true
  }
  if (changed) bump()
}

export function noteMacSeen(tabId: string): void {
  if (seq && seen.get(tabId) === seq) return
  seen.set(tabId, ++seq)
  bump()
}

export function macShownTab(groupId: string, active: string | null): string | null {
  if (!visible) return active
  return visible.has(groupId) ? shown.get(groupId) ?? active : null
}

export function macOrder<T extends { id: string }>(groupId: string, tabs: readonly T[], active: string | null): T[] {
  const first = macShownTab(groupId, active)
  const key = (t: T, i: number): [number, number] => (t.id === first ? [0, 0] : seen.has(t.id) ? [1, -(seen.get(t.id) ?? 0)] : [2, i])
  return tabs
    .map((t, i) => ({ t, k: key(t, i) }))
    .sort((a, b) => a.k[0] - b.k[0] || a.k[1] - b.k[1])
    .map((x) => x.t)
}

export function useMacOrderVersion(): number {
  const [n, setN] = useState(0)
  useEffect(() => {
    const on = (): void => setN((x) => x + 1)
    listeners.add(on)
    return () => {
      listeners.delete(on)
    }
  }, [])
  return n
}
