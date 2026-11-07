import type { Tab, TabGroup } from '@shared/types'

export function consoleTabFor(tabs: Tab[], worktreeId: string, exceptId?: string): Tab | null {
  return tabs.find((t) => t.contentType === 'unity-console' && t.worktreeId === worktreeId && t.id !== exceptId) ?? null
}

export function duplicateConsoleTabIds(tabs: Tab[], groups: TabGroup[]): string[] {
  const shown = new Set(groups.map((g) => g.activeTabId).filter((id): id is string => !!id))
  const consoles = tabs
    .filter((t) => t.contentType === 'unity-console')
    .sort((a, b) => Number(shown.has(b.id)) - Number(shown.has(a.id)))
  const kept = new Set<string>()
  const extra: string[] = []
  for (const t of consoles) {
    if (kept.has(t.worktreeId)) extra.push(t.id)
    else kept.add(t.worktreeId)
  }
  return extra
}
