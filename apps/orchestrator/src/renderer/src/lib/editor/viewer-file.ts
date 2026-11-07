import type { Tab } from '@shared/types'

export function viewerFileForTab(
  tab: Tab,
  viewerFileByTab: Record<string, string>
): string | undefined {
  if (tab.contentType !== 'file-viewer') return undefined
  return viewerFileByTab[tab.id]
}
