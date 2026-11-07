import type { Tab, TabGroup, Worktree } from '@shared/types'
import { LEGACY_TUNER_TAB_TYPE, TUNER_SCENE_VIEW } from '@shared/tuner'
import { scratchpadIdOf, scratchpadParentProject } from '@shared/scratchpads'
import { toPosixPath } from '../path'
import { isUnityAssetPath } from '@shared/unity-assets'
import { isBaseView, isSceneTuner, scopeRank, tunerBaseKey, type TunerScope } from '@shared/tuner-scope'

export interface TunerOpenTarget {
  workspaceId: string
  worktreeId: string
  agentTab: Tab | null
  scratchpadId: string | null
}

export function resolveTunerOpenTarget(
  s: {
    tabsByWorkspace: Record<string, Tab[]>
    worktreesByWorkspace: Record<string, Worktree[]>
    activeWorkspaceId: string | null
  },
  req: { projectPath: string; paneKey: string }
): TunerOpenTarget | null {
  const scratchpadId = scratchpadIdOf(req.projectPath)
  if (req.paneKey) {
    for (const [workspaceId, tabs] of Object.entries(s.tabsByWorkspace)) {
      const tab = tabs.find((t) => t.ptyId === req.paneKey)
      if (tab) return { workspaceId, worktreeId: tab.worktreeId, agentTab: tab, scratchpadId }
    }
  }
  const project = toPosixPath(scratchpadParentProject(req.projectPath) ?? req.projectPath)
  let best: TunerOpenTarget | null = null
  for (const [workspaceId, wts] of Object.entries(s.worktreesByWorkspace)) {
    const wt = wts.find((w) => toPosixPath(w.path) === project)
    if (!wt) continue
    best = { workspaceId, worktreeId: wt.id, agentTab: null, scratchpadId }
    if (workspaceId === s.activeWorkspaceId) break
  }
  return best
}

export function pickTunerTab(
  tabs: Tab[],
  worktreeId: string,
  scratchpadId: string | null,
  want: TunerScope,
  scopeOf: (tab: Tab) => TunerScope | null
): Tab | null {
  const mine = (t: Tab): boolean =>
    t.contentType === 'tuner' && t.worktreeId === worktreeId && (t.scratchpadId ?? null) === scratchpadId
  let best: Tab | null = null
  let bestRank = 0
  for (const t of tabs) {
    if (!mine(t)) continue
    const scope = t.tuner ? scopeOf(t) : null
    const rank = !t.tuner ? 1 : scope ? scopeRank(scope, want) * 2 : 0
    if (rank > bestRank) {
      best = t
      bestRank = rank
    }
  }
  return best
}

export function sceneTunerTab(tabs: Tab[], worktreeId: string, scratchpadId: string | null | undefined, groups: TabGroup[]): Tab | null {
  const shown = new Set(groups.map((g) => g.activeTabId).filter((id): id is string => !!id))
  const list = tabs
    .filter((t) => t.contentType === 'tuner' && t.worktreeId === worktreeId && (scratchpadId === undefined || (t.scratchpadId ?? null) === scratchpadId) && isSceneTuner(t.tuner))
    .sort((a, b) => Number(shown.has(b.id)) - Number(shown.has(a.id)) || (b.createdAt ?? 0) - (a.createdAt ?? 0))
  return list[0] ?? null
}

export function duplicateTunerTabIds(tabs: Tab[], groups: TabGroup[]): string[] {
  const shown = new Set(groups.map((g) => g.activeTabId).filter((id): id is string => !!id))
  const tuners = tabs
    .filter((t) => t.contentType === 'tuner' && t.tuner)
    .sort((a, b) => Number(shown.has(b.id)) - Number(shown.has(a.id)) || (b.createdAt ?? 0) - (a.createdAt ?? 0))
  const kept = new Set<string>()
  const extra: string[] = []
  for (const t of tuners) {
    const key = `${t.worktreeId}|${isSceneTuner(t.tuner) ? 'scene' : tunerBaseKey(t.tuner)}`
    if (kept.has(key)) extra.push(t.id)
    else kept.add(key)
  }
  return extra
}

const LEGACY_TAB_LABEL = 'Scene Tuner'
const LEGACY_VIEW_LABEL = 'Scene: '

function tunerTabLabel(label: string): string {
  if (label === LEGACY_TAB_LABEL) return 'Tuner'
  return label.startsWith(LEGACY_VIEW_LABEL) ? `Tuner: ${label.slice(LEGACY_VIEW_LABEL.length)}` : label
}

export function withCurrentTunerTab<T extends Pick<Tab, 'contentType' | 'label' | 'tuner'>>(tab: T): T {
  const legacy = (tab.contentType as string) === LEGACY_TUNER_TAB_TYPE
  if (!legacy && tab.contentType !== 'tuner') return tab
  const target = tab.tuner as { kind?: unknown; id?: unknown } | null | undefined
  if (target?.kind === 'view' && typeof target.id === 'string' && !isBaseView(target.id))
    return { ...tab, contentType: 'tuner', label: tunerTabLabel(tab.label), tuner: { kind: 'view', id: TUNER_SCENE_VIEW, filter: target.id } }
  if (target == null || (target.kind === 'view' && typeof target.id === 'string') || (target.kind === 'file' && typeof target.id === 'string' && isUnityAssetPath(target.id)))
    return legacy ? { ...tab, contentType: 'tuner', label: tunerTabLabel(tab.label) } : tab
  return { ...tab, contentType: 'tuner', label: 'Tuner', tuner: null }
}
