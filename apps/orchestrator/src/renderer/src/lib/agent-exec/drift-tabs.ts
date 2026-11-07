import { censusTrack } from '@shared/census'

export const driftTabs = new Set<string>()
censusTrack('drift-tabs.driftTabs', driftTabs)

export function forgetDriftTab(tabId: string): void {
  driftTabs.delete(tabId)
}
