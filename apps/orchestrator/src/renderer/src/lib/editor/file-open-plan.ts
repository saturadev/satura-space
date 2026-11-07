import type { Tab, TabContentType, TabGroup, TabGroupLayoutNode } from '@shared/types'

const HOST_KINDS: ReadonlySet<TabContentType> = new Set(['terminal', 'tuner'])
const BLOCKER_KINDS: ReadonlySet<TabContentType> = new Set(['unity-instance-player', 'unity-scratchpad'])

export type FileOpenPlan =
  | { kind: 'reuse'; tabId: string; groupId: string }
  | { kind: 'replace'; tabId: string; groupId: string }
  | { kind: 'create'; groupId: string }
  | { kind: 'split' }

interface FileOpenPlanInput {
  filePath: string
  worktreeId: string
  preview: boolean
  tabs: Tab[]
  groups: TabGroup[]
  layout: TabGroupLayoutNode | undefined
  fullscreenGroupId?: string | null
  activeGroupId?: string | null
  viewerFileByTab: Record<string, string>
  asset?: boolean
  assetFileByTab?: Record<string, string>
}

function samePath(a: string | undefined, b: string): boolean {
  if (!a) return false
  return a.replace(/\\/g, '/') === b.replace(/\\/g, '/')
}

function layoutAreas(layout: TabGroupLayoutNode | undefined): Map<string, number> {
  const out = new Map<string, number>()
  const walk = (node: TabGroupLayoutNode, area: number): void => {
    if (node.type === 'leaf') {
      out.set(node.groupId, area)
      return
    }
    const ratio = Math.min(1, Math.max(0, node.ratio ?? 0.5))
    walk(node.first, area * ratio)
    walk(node.second, area * (1 - ratio))
  }
  if (layout) walk(layout, 1)
  return out
}

export function isAssetTunerTab(t: Tab): boolean {
  return t.contentType === 'tuner' && t.tuner?.kind === 'file'
}

function groupTabs(group: TabGroup, tabs: Tab[]): Tab[] {
  return tabs.filter((t) => t.groupId === group.id)
}

export function canHostViewer(group: TabGroup, tabs: Tab[]): boolean {
  if (group.hidden) return false
  const own = groupTabs(group, tabs)
  return own.some((t) => HOST_KINDS.has(t.contentType)) && !own.some((t) => BLOCKER_KINDS.has(t.contentType))
}

function largestGroup(
  groups: TabGroup[],
  areas: Map<string, number>,
  activeGroupId: string | null | undefined,
  accept: (g: TabGroup) => boolean
): string | null {
  let best: string | null = null
  let bestArea = -1
  for (const g of groups) {
    const area = areas.get(g.id)
    if (area === undefined || g.hidden || !accept(g)) continue
    if (area > bestArea + 1e-9 || (Math.abs(area - bestArea) <= 1e-9 && g.id === activeGroupId)) {
      best = g.id
      bestArea = area
    }
  }
  return best
}

function pickLargestHostGroup(input: {
  tabs: Tab[]
  groups: TabGroup[]
  layout: TabGroupLayoutNode | undefined
  fullscreenGroupId?: string | null
  activeGroupId?: string | null
}): string | null {
  const { tabs, groups, layout, fullscreenGroupId, activeGroupId } = input
  const fullscreen = fullscreenGroupId ? groups.find((g) => g.id === fullscreenGroupId) : undefined
  if (fullscreen && canHostViewer(fullscreen, tabs)) return fullscreen.id
  const areas = layoutAreas(layout)
  return (
    largestGroup(groups, areas, activeGroupId, (g) => canHostViewer(g, tabs)) ??
    largestGroup(groups, areas, activeGroupId, () => true)
  )
}

function largestFirst<T extends { groupId: string }>(items: T[], areas: Map<string, number>): T[] {
  return [...items].sort((a, b) => (areas.get(b.groupId) ?? 0) - (areas.get(a.groupId) ?? 0))
}

export function planFileOpen(input: FileOpenPlanInput): FileOpenPlan {
  const { filePath, worktreeId, tabs, groups, viewerFileByTab } = input
  const assetFiles = input.assetFileByTab ?? {}
  const areas = layoutAreas(input.layout)
  const viewers = tabs.filter((t) => t.contentType === 'file-viewer' || isAssetTunerTab(t))
  const fileOf = (t: Tab): string | undefined => (isAssetTunerTab(t) ? assetFiles[t.id] : viewerFileByTab[t.id])

  const open = viewers.filter((t) => isAssetTunerTab(t) === !!input.asset && samePath(fileOf(t), filePath))
  if (open.length) {
    const shown = open.find((t) => groups.some((g) => g.id === t.groupId && g.activeTabId === t.id))
    const pick = shown ?? largestFirst(open, areas)[0]
    return { kind: 'reuse', tabId: pick.id, groupId: pick.groupId }
  }

  const target = pickLargestHostGroup(input)
  if (!target) return { kind: 'split' }
  const inTarget = viewers.find((t) => t.preview && t.worktreeId === worktreeId && t.groupId === target)
  if (inTarget) return { kind: 'replace', tabId: inTarget.id, groupId: target }
  return { kind: 'create', groupId: target }
}
