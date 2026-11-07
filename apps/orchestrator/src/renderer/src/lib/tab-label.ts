import type { Tab } from '@shared/types'
import { pathBasename } from './path'
import { viewerFileForTab } from './editor/viewer-file'
import { isReactReport, reportFallbackTitle } from '@shared/report-compile'
import type { TunerTabTitle, TunerTabTitleKind } from './tuner/tab-titles'
import { captureText } from './capture'
import { DASHBOARD_TAB_LABEL } from '@shared/dashboard'

export const GIT_TAB_LABEL = 'Git'
const LEGACY_GIT_TAB_LABEL = 'Source Control'
const TUNER_TITLE_PREFIX: Record<TunerTabTitleKind, string> = { scene: 'Scene', prefab: 'Prefab', variant: 'Prefab Variant', staging: 'Prefab' }

export function withCurrentTabLabel<T extends Pick<Tab, 'contentType' | 'label'>>(tab: T): T {
  return tab.contentType === 'git-scm' && tab.label === LEGACY_GIT_TAB_LABEL ? { ...tab, label: GIT_TAB_LABEL } : tab
}

export function tabDisplayLabel(
  tab: Tab,
  viewerFileByTab: Record<string, string>,
  reportTitles?: Record<string, string>,
  tunerTitles?: Record<string, TunerTabTitle>
): string {
  return captureText(rawTabLabel(tab, viewerFileByTab, reportTitles, tunerTitles))
}

function rawTabLabel(
  tab: Tab,
  viewerFileByTab: Record<string, string>,
  reportTitles?: Record<string, string>,
  tunerTitles?: Record<string, TunerTabTitle>
): string {
  if (tab.customLabel) return tab.customLabel
  if (tab.contentType === 'tuner' && tunerTitles?.[tab.id]) return `${TUNER_TITLE_PREFIX[tunerTitles[tab.id].kind]}: ${tunerTitles[tab.id].name}`
  if (tab.contentType === 'file-viewer') {
    const f = viewerFileForTab(tab, viewerFileByTab)
    if (f && isReactReport(f)) return reportTitles?.[f] || reportFallbackTitle(f)
    return f ? pathBasename(f) : 'Viewer'
  }
  if (tab.contentType === 'git-scm') return GIT_TAB_LABEL
  if (tab.contentType === 'dashboard') return tab.generatedLabel || DASHBOARD_TAB_LABEL
  return tab.generatedLabel || tab.label
}
