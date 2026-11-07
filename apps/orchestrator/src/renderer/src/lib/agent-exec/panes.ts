import type { Tab, TabContentType, TunerTarget } from '@shared/types'
import { emptyGroups, paneName, planPlacementRoomy, type PaneAct, type PaneGroup, type PaneKind, type PaneModel, type PlaceHow, type Rect, type Size } from '@shared/pane-plan'
import { useAppStore, type AppState } from '../../store'
import { collectGroupIds, isValidLayoutNode, shownTab } from '../tab-tree'
import { driftTabs } from './drift-tabs'
import { censusTrack } from '@shared/census'

export interface Placed {
  tabId: string
  group: string
  how: PlaceHow
  near: string
  size: Size
  want: Size
  splitsRejected: boolean
  pruned: number
}

const placed = new Map<string, Placed>()
censusTrack('panes.placed', placed)

export function kindOfContent(type: TabContentType | undefined): PaneKind {
  if (!type) return 'empty'
  if (type === 'tuner') return 'tuner'
  if (type === 'unity-instance-player') return 'unity'
  if (type === 'terminal') return 'terminal'
  return 'other'
}

function domRect(el: Element | null, origin: DOMRect | null): Rect | null {
  if (!el || !origin) return null
  const r = el.getBoundingClientRect()
  return { x: Math.round(r.x - origin.x), y: Math.round(r.y - origin.y), w: Math.round(r.width), h: Math.round(r.height) }
}

export function paneModelOf(s: AppState, workspaceId: string, callerPty?: string): PaneModel | null {
  const tree = s.layoutByWorkspace[workspaceId]
  if (!isValidLayoutNode(tree)) return null
  const tabs = s.tabsByWorkspace[workspaceId] ?? []
  const laidOut = new Set(collectGroupIds(tree))
  const area = typeof document === 'undefined' ? null : document.querySelector(`[data-workspace="${CSS.escape(workspaceId)}"]`)
  const origin = area?.getBoundingClientRect() ?? null
  const width = Math.round(origin?.width ?? (typeof window === 'undefined' ? 0 : window.innerWidth))
  const height = Math.round(origin?.height ?? (typeof window === 'undefined' ? 0 : window.innerHeight))
  const groups: PaneGroup[] = (s.groupsByWorkspace[workspaceId] ?? [])
    .filter((g) => laidOut.has(g.id))
    .map((g) => {
      const own = g.tabOrder.map((id) => tabs.find((t) => t.id === id)).filter((t): t is Tab => !!t)
      const shown = shownTab(g, own)
      const content = area?.querySelector(`[data-group-id="${CSS.escape(g.id)}"]`) ?? null
      const preview = own.find((t) => t.preview && t.id === shown?.id)
      return {
        id: g.id,
        kind: g.hidden ? 'empty' : kindOfContent(shown?.contentType),
        tabs: own.length,
        caller: !!callerPty && own.some((t) => t.ptyId === callerPty),
        drift: own.length > 0 && own.every((t) => driftTabs.has(t.id)),
        preview: preview?.id ?? null,
        rect: domRect(content?.parentElement ?? null, origin),
        hasTuner: own.some((t) => kindOfContent(t.contentType) === 'tuner'),
        hasTerminal: own.some((t) => kindOfContent(t.contentType) === 'terminal')
      }
    })
  const side = area ? document.querySelector('[data-pane="sidebar"]')?.parentElement : null
  const sidebar = area
    ? { open: !!side, width: Math.round(side?.getBoundingClientRect().width ?? 0) }
    : { open: s.sidebarOpen, width: s.sidebarOpen ? s.sidebarWidth : 0 }
  return { width, height, tree, groups, fullscreen: s.fullscreenGroupIdByWorkspace[workspaceId] ?? null, sidebar }
}

const nextFrame = (): Promise<void> =>
  new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    else setTimeout(resolve, 32)
  })

export function closeEmptyGroups(workspaceId: string, ids: readonly string[]): number {
  let n = 0
  for (const id of ids) {
    const st = useAppStore.getState()
    const before = st.groupsByWorkspace[workspaceId]?.length ?? 0
    st.closeGroup(workspaceId, id)
    if ((useAppStore.getState().groupsByWorkspace[workspaceId]?.length ?? 0) < before) n++
  }
  return n
}

export async function actOnPanes(workspaceId: string, act: PaneAct, groupId?: string): Promise<void> {
  const st = useAppStore.getState()
  if (act === 'sidebar' && st.sidebarOpen) st.setSidebarOpen(false)
  if (act === 'fullscreen' && groupId && st.fullscreenGroupIdByWorkspace[workspaceId] !== groupId) st.toggleGroupFullscreen(workspaceId, groupId)
  if (act === 'prune') {
    const model = paneModelOf(st, workspaceId)
    if (model) closeEmptyGroups(workspaceId, emptyGroups(model, groupId))
  }
  await nextFrame()
}

export function takePlaced(workspaceId: string): Placed | null {
  const p = placed.get(workspaceId) ?? null
  placed.delete(workspaceId)
  return p
}

export function placeDriftTab(
  workspaceId: string,
  worktreeId: string,
  opts: { label: string; contentType: TabContentType; tuner?: TunerTarget | null; scratchpadId?: string | null },
  callerPty?: string
): Tab | null {
  const model = paneModelOf(useAppStore.getState(), workspaceId, callerPty)
  if (!model) return null
  const { plan, drop } = planPlacementRoomy(model, kindOfContent(opts.contentType))
  if (!plan) return null
  const near = model.groups.find((g) => g.id === plan.group)
  const pruned = drop.length ? closeEmptyGroups(workspaceId, drop) : 0
  const st = useAppStore.getState()
  if (st.fullscreenGroupIdByWorkspace[workspaceId]) st.exitFullscreen(workspaceId)
  let tab: Tab
  if (plan.how === 'right' || plan.how === 'down') {
    tab = st.openTabSplit(workspaceId, plan.group, worktreeId, plan.how === 'right' ? 'horizontal' : 'vertical', plan.ratio ?? 0.5, opts)
  } else {
    tab = st.createTab(workspaceId, worktreeId, { ...opts, groupId: plan.group })
    if (plan.how === 'replace' && plan.previewTabId) useAppStore.getState().closeTab(plan.previewTabId)
  }
  driftTabs.add(tab.id)
  placed.set(workspaceId, { tabId: tab.id, group: tab.groupId, how: plan.how, near: paneName(near), size: plan.size, want: plan.want, splitsRejected: plan.splitsRejected, pruned })
  return tab
}
