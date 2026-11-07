import type { Tab, TabContentType } from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/types'
import { useAppStore } from '@renderer/store'

export const WORKSPACE = 'landing'

export function demoTab(id: string, groupId: string, contentType: TabContentType, label: string, extra: Partial<Tab> = {}): Tab {
  return { id, worktreeId: `${WORKSPACE}-wt`, groupId, contentType, ptyId: id, label, sortOrder: 0, createdAt: 0, ...extra }
}

export function addDemoTabs(tabs: Tab[], viewerFiles: Record<string, string> = {}): void {
  useAppStore.setState((s) => ({
    activeWorkspaceId: WORKSPACE,
    settings: s.settings ?? { ...DEFAULT_SETTINGS, editorFontSize: 12 },
    tabsByWorkspace: { ...s.tabsByWorkspace, [WORKSPACE]: [...(s.tabsByWorkspace[WORKSPACE] ?? []).filter((t) => !tabs.some((n) => n.id === t.id)), ...tabs] },
    viewerFileByTab: { ...s.viewerFileByTab, ...viewerFiles }
  }))
}
