import type { StateCreator } from 'zustand'
import type {
  ReportGroupPrefs,
  Tab,
  TabGroup,
  TabGroupLayoutNode,
  TabContentType,
  Worktree,
  Workspace,
  AgentId,
  TunerTarget
} from '@shared/types'
import type { WorkspaceState, MovedPanel, MovedWorkspace } from '@shared/api'
import type { AppState } from '../index'
import { uid } from '../../lib/id'
import { folderWorkspaceName } from '../../lib/path'
import { seedTerminalSnapshot } from '../../lib/terminal/serialize'
import type { DropZone, ResolvedDropTarget } from '../../lib/tab-drag'
import {
  buildSplitNode,
  collectGroupIds,
  findFirstLeaf,
  findSiblingGroupId,
  isValidLayoutNode,
  removeLeaf,
  replaceLeaf,
  updateSplitRatio,
  wrapRootSplit,
  type SplitDirection
} from '../../lib/tab-tree'
import { sessionIdsForGroup } from '../../lib/unity/instance-ids'
import { releaseUnityHost } from '../../lib/unity/unity-registry'
import { forgetUnityRetry } from '../../lib/unity/unity-retry'
import { forgetConsoleView } from '../../lib/unity/unity-console-view'
import { forgetTuner } from '../../lib/tuner/session-memory'
import { forgetDriftTab } from '../../lib/agent-exec/drift-tabs'
import { consoleTabFor, duplicateConsoleTabIds } from '../../lib/unity/console-tabs'
import { placeChildTab } from '../../lib/agent-exec/placement'
import { withCurrentTabLabel } from '../../lib/tab-label'
import { duplicateTunerTabIds, withCurrentTunerTab } from '../../lib/tuner/tuner-target'
import { isKnownTabType } from '../../lib/tab-types'
import type { ChildPlacement } from '@shared/agent-exec'
import { forgetTabUse, pickRecentTab } from '../../lib/tab-mru'

export interface TabsSlice {
  tabsByWorkspace: Record<string, Tab[]>
  groupsByWorkspace: Record<string, TabGroup[]>
  layoutByWorkspace: Record<string, TabGroupLayoutNode>
  activeGroupIdByWorkspace: Record<string, string>
  fullscreenGroupIdByWorkspace: Record<string, string | null>

  ensureWorkbench: (workspaceId: string) => string
  createTab: (
    workspaceId: string,
    worktreeId: string,
    opts?: {
      groupId?: string
      label?: string
      contentType?: TabContentType
      preview?: boolean
      agentId?: AgentId | null
      claudeSessionId?: string | null
      tuner?: TunerTarget | null
      scratchpadId?: string | null
      plugin?: string | null
    }
  ) => Tab
  openTabBeside: (
    workspaceId: string,
    sourceGroupId: string,
    worktreeId: string,
    opts?: {
      label?: string
      contentType?: TabContentType
      preview?: boolean
      agentId?: AgentId | null
      claudeSessionId?: string | null
      tuner?: TunerTarget | null
      scratchpadId?: string | null
      plugin?: string | null
    }
  ) => Tab
  openTabSplit: (
    workspaceId: string,
    groupId: string,
    worktreeId: string,
    direction: 'horizontal' | 'vertical',
    ratio: number,
    opts?: {
      label?: string
      contentType?: TabContentType
      tuner?: TunerTarget | null
      scratchpadId?: string | null
    }
  ) => Tab
  activateTab: (tabId: string) => void
  promoteTab: (tabId: string) => void
  closeTab: (tabId: string, opts?: { keepGroup?: boolean }) => void
  closeGroup: (workspaceId: string, groupId: string) => void
  moveTab: (tabId: string, targetGroupId: string, beforeTabId?: string) => void
  moveSingleTab: (tabId: string, targetGroupId: string, beforeTabId?: string) => void
  attachReportSegment: (ownerTabId: string, file: string, opts: { activate: boolean }) => string | null
  setReportGroup: (ownerTabId: string, patch: ReportGroupPrefs) => void
  dropReportSegments: (ownerTabId: string) => void
  moveTabToSplit: (
    tabId: string,
    targetGroupId: string,
    direction: SplitDirection,
    position: 'first' | 'second'
  ) => void

  moveTabToRootSplit: (
    tabId: string,
    direction: SplitDirection,
    position: 'first' | 'second'
  ) => void
  draggingTabId: string | null
  setDraggingTabId: (tabId: string | null) => void
  openChildAgentTab: (order: {
    callerPtyId: string
    ptyId: string
    placement: ChildPlacement
    agentId: AgentId
    label: string
    customLabel: string | null
  }) => Tab | null

  openFileViewerSplit: (
    workspaceId: string,
    sourceGroupId: string,
    worktreeId: string,
    firstRatio?: number
  ) => Tab | null
  setActiveGroup: (workspaceId: string, groupId: string) => void

  toggleGroupFullscreen: (workspaceId: string, groupId: string) => void
  exitFullscreen: (workspaceId: string) => void
  toggleGroupHidden: (workspaceId: string, groupId: string) => void

  detachTab: (tabId: string) => void

  importPanel: (panel: MovedPanel) => void

  importWorkspace: (workspace: MovedWorkspace) => void

  externalDropTarget: ResolvedDropTarget | null
  setExternalDropTarget: (target: ResolvedDropTarget | null) => void
  setLayoutRatio: (workspaceId: string, path: string[], ratio: number) => void
  setTabLabel: (tabId: string, label: string) => void
  setTabTuner: (tabId: string, tuner: TunerTarget | null, label: string, scratchpadId?: string | null) => void
  setTabContent: (tabId: string, contentType: 'file-viewer' | 'tuner', tuner: TunerTarget | null, label: string) => void
  setTabScratchpad: (tabId: string, scratchpadId: string | null) => void
  setTabGeneratedLabel: (ptyId: string, title: string) => void
  setTabClaudeSession: (ptyId: string, sessionId: string | null) => void
  replaceTabPty: (tabId: string) => string | null
  exitedPtyIds: string[]
  markPtyExited: (ptyId: string) => void
  hydrateTabs: (state: WorkspaceState) => void
  removeWorkspaceTabs: (workspaceId: string) => void
  forgetTabs: (tabs: Tab[]) => void
}

interface TabLocation {
  workspaceId: string
  tab: Tab
}

function locateTab(state: AppState, tabId: string): TabLocation | null {
  for (const [workspaceId, tabs] of Object.entries(state.tabsByWorkspace)) {
    const tab = tabs.find((t) => t.id === tabId)
    if (tab) return { workspaceId, tab }
  }
  return null
}

function omitKeys<T>(rec: Record<string, T>, keys: string[]): Record<string, T> {
  let next: Record<string, T> | null = null
  for (const k of keys) {
    if (!(k in rec)) continue
    next ??= { ...rec }
    delete next[k]
  }
  return next ?? rec
}

function hasTabWithPty(state: AppState, ptyId: string): boolean {
  for (const tabs of Object.values(state.tabsByWorkspace)) {
    if (tabs.some((t) => t.ptyId === ptyId)) return true
  }
  return false
}

function forgetTabsPatch(state: AppState, gone: Tab[]): Partial<AppState> {
  if (gone.length === 0) return {}
  const tabIds = gone.map((t) => t.id)
  const ptyIds = gone.map((t) => t.ptyId).filter((id) => id && !hasTabWithPty(state, id))
  const patch: Partial<AppState> = {}
  const viewerFileByTab = omitKeys(state.viewerFileByTab, tabIds)
  if (viewerFileByTab !== state.viewerFileByTab) patch.viewerFileByTab = viewerFileByTab
  const liveByTab = omitKeys(state.liveByTab, tabIds)
  if (liveByTab !== state.liveByTab) patch.liveByTab = liveByTab
  const logAutoFollowByTab = omitKeys(state.logAutoFollowByTab, tabIds)
  if (logAutoFollowByTab !== state.logAutoFollowByTab) patch.logAutoFollowByTab = logAutoFollowByTab
  const markdownViewByTab = omitKeys(state.markdownViewByTab, tabIds)
  if (markdownViewByTab !== state.markdownViewByTab) patch.markdownViewByTab = markdownViewByTab
  const agentHookStatusByPty = omitKeys(state.agentHookStatusByPty, ptyIds)
  if (agentHookStatusByPty !== state.agentHookStatusByPty) patch.agentHookStatusByPty = agentHookStatusByPty
  if (ptyIds.some((id) => state.exitedPtyIds.includes(id))) {
    const drop = new Set(ptyIds)
    patch.exitedPtyIds = state.exitedPtyIds.filter((id) => !drop.has(id))
  }
  return patch
}

function zoneToSplit(zone: DropZone): [SplitDirection, 'first' | 'second'] {
  switch (zone) {
    case 'left':
      return ['horizontal', 'first']
    case 'right':
      return ['horizontal', 'second']
    case 'top':
      return ['vertical', 'first']
    case 'bottom':
      return ['vertical', 'second']
    default:
      return ['horizontal', 'second']
  }
}

function endTabBackingSession(tab: Tab): void {
  if (tab.contentType === 'unity-instance-player' || tab.contentType === 'unity-scratchpad') {
    for (const iid of sessionIdsForGroup(tab.ptyId)) {
      void window.api.unity.stop(iid)
      releaseUnityHost(iid)
      forgetUnityRetry(iid)
    }
  } else if (tab.contentType === 'unity-console') forgetConsoleView(tab.ptyId)
  else if (tab.contentType === 'terminal') void window.api.pty.kill(tab.ptyId)
}

function splitDirectionForGroup(groupId: string): SplitDirection {
  if (typeof document === 'undefined') return 'horizontal'
  const el = document.querySelector(`[data-group-id="${CSS.escape(groupId)}"]`)
  if (!el) return 'horizontal'
  const rect = el.getBoundingClientRect()
  return rect.width >= rect.height ? 'horizontal' : 'vertical'
}

export const createTabsSlice: StateCreator<AppState, [], [], TabsSlice> = (set, get) => ({
  tabsByWorkspace: {},
  groupsByWorkspace: {},
  layoutByWorkspace: {},
  activeGroupIdByWorkspace: {},
  fullscreenGroupIdByWorkspace: {},
  draggingTabId: null,
  externalDropTarget: null,
  exitedPtyIds: [],

  ensureWorkbench: (workspaceId) => {
    const st = get()
    const layout = st.layoutByWorkspace[workspaceId]
    const groups = st.groupsByWorkspace[workspaceId]
    if (layout && groups && groups.length > 0) {
      const active = st.activeGroupIdByWorkspace[workspaceId]
      const gid = active && groups.some((g) => g.id === active) ? active : findFirstLeaf(layout)
      if (gid !== active) {
        set((s) => ({
          activeGroupIdByWorkspace: { ...s.activeGroupIdByWorkspace, [workspaceId]: gid }
        }))
      }
      return gid
    }
    const groupId = uid()
    const group: TabGroup = { id: groupId, activeTabId: null, tabOrder: [] }
    set((s) => ({
      groupsByWorkspace: { ...s.groupsByWorkspace, [workspaceId]: [group] },
      layoutByWorkspace: { ...s.layoutByWorkspace, [workspaceId]: { type: 'leaf', groupId } },
      activeGroupIdByWorkspace: { ...s.activeGroupIdByWorkspace, [workspaceId]: groupId }
    }))
    return groupId
  },

  createTab: (workspaceId, worktreeId, opts) => {
    const groupId = opts?.groupId ?? get().ensureWorkbench(workspaceId)
    const tabId = uid()
    const count = (get().tabsByWorkspace[workspaceId]?.length ?? 0) + 1
    const tab: Tab = {
      id: tabId,
      worktreeId,
      groupId,
      contentType: opts?.contentType ?? 'terminal',
      ptyId: uid(),
      label: opts?.label ?? `Terminal ${count}`,
      customLabel: null,
      agentId: opts?.agentId ?? null,
      ...(opts?.claudeSessionId ? { claudeSessionId: opts.claudeSessionId } : {}),
      ...(opts?.tuner ? { tuner: opts.tuner } : {}),
      ...(opts?.scratchpadId ? { scratchpadId: opts.scratchpadId } : {}),
      ...(opts?.plugin ? { plugin: opts.plugin } : {}),
      preview: opts?.preview ?? false,
      sortOrder: count,
      createdAt: Date.now()
    }
    set((s) => ({
      tabsByWorkspace: {
        ...s.tabsByWorkspace,
        [workspaceId]: [...(s.tabsByWorkspace[workspaceId] ?? []), tab]
      },
      groupsByWorkspace: {
        ...s.groupsByWorkspace,
        [workspaceId]: (s.groupsByWorkspace[workspaceId] ?? []).map((g) =>
          g.id === groupId
            ? { ...g, tabOrder: [...g.tabOrder, tabId], activeTabId: tabId, hidden: false }
            : g
        )
      },
      activeGroupIdByWorkspace: { ...s.activeGroupIdByWorkspace, [workspaceId]: groupId }
    }))
    return tab
  },

  openTabBeside: (workspaceId, sourceGroupId, worktreeId, opts) => {
    const st = get()
    const source = (st.groupsByWorkspace[workspaceId] ?? []).find((g) => g.id === sourceGroupId)
    const layout = st.layoutByWorkspace[workspaceId]
    if (!layout || !source || source.tabOrder.length === 0) {
      get().exitFullscreen(workspaceId)
      return get().createTab(workspaceId, worktreeId, { ...opts, groupId: sourceGroupId })
    }
    const newGroupId = uid()
    const newGroup: TabGroup = { id: newGroupId, activeTabId: null, tabOrder: [] }
    const direction = splitDirectionForGroup(sourceGroupId)
    set((s) => ({
      groupsByWorkspace: {
        ...s.groupsByWorkspace,
        [workspaceId]: [...(s.groupsByWorkspace[workspaceId] ?? []), newGroup]
      },
      layoutByWorkspace: {
        ...s.layoutByWorkspace,
        [workspaceId]: replaceLeaf(
          layout,
          sourceGroupId,
          buildSplitNode(sourceGroupId, newGroupId, direction, 'second')
        )
      },
      activeGroupIdByWorkspace: { ...s.activeGroupIdByWorkspace, [workspaceId]: newGroupId }
    }))
    get().exitFullscreen(workspaceId)
    return get().createTab(workspaceId, worktreeId, { ...opts, groupId: newGroupId })
  },

  openTabSplit: (workspaceId, groupId, worktreeId, direction, ratio, opts) => {
    const st = get()
    const layout = st.layoutByWorkspace[workspaceId]
    const source = (st.groupsByWorkspace[workspaceId] ?? []).find((g) => g.id === groupId)
    if (!layout || !source) return get().createTab(workspaceId, worktreeId, { ...opts, groupId: get().ensureWorkbench(workspaceId) })
    const newGroupId = uid()
    const newGroup: TabGroup = { id: newGroupId, activeTabId: null, tabOrder: [] }
    set((s) => ({
      groupsByWorkspace: {
        ...s.groupsByWorkspace,
        [workspaceId]: [...(s.groupsByWorkspace[workspaceId] ?? []), newGroup]
      },
      layoutByWorkspace: {
        ...s.layoutByWorkspace,
        [workspaceId]: replaceLeaf(layout, groupId, {
          type: 'split',
          direction,
          first: { type: 'leaf', groupId },
          second: { type: 'leaf', groupId: newGroupId },
          ratio
        })
      },
      activeGroupIdByWorkspace: { ...s.activeGroupIdByWorkspace, [workspaceId]: newGroupId }
    }))
    get().exitFullscreen(workspaceId)
    return get().createTab(workspaceId, worktreeId, { ...opts, groupId: newGroupId })
  },

  activateTab: (tabId) => {
    const loc = locateTab(get(), tabId)
    if (!loc) return
    const { workspaceId, tab } = loc
    set((s) => ({
      groupsByWorkspace: {
        ...s.groupsByWorkspace,
        [workspaceId]: (s.groupsByWorkspace[workspaceId] ?? []).map((g) =>
          g.id === tab.groupId ? { ...g, activeTabId: tabId, hidden: false } : g
        )
      },
      activeGroupIdByWorkspace: { ...s.activeGroupIdByWorkspace, [workspaceId]: tab.groupId }
    }))
    get().clearAgentPulse(tab.ptyId)
  },

  promoteTab: (tabId) => {
    const loc = locateTab(get(), tabId)
    if (!loc || !loc.tab.preview) return
    const { workspaceId } = loc
    set((s) => ({
      tabsByWorkspace: {
        ...s.tabsByWorkspace,
        [workspaceId]: (s.tabsByWorkspace[workspaceId] ?? []).map((t) =>
          t.id === tabId ? { ...t, preview: false } : t
        )
      }
    }))
  },

  closeGroup: (workspaceId, groupId) => {
    const st = get()
    const groups = st.groupsByWorkspace[workspaceId] ?? []
    const group = groups.find((g) => g.id === groupId)
    if (!group || group.tabOrder.length > 0 || groups.length <= 1) return
    const layout = st.layoutByWorkspace[workspaceId]
    const sibling = layout ? findSiblingGroupId(layout, groupId) : null
    const collapsed = layout ? removeLeaf(layout, groupId) : null
    set((s) => {
      const nextGroups = (s.groupsByWorkspace[workspaceId] ?? []).filter((g) => g.id !== groupId)
      const nextLayout = { ...s.layoutByWorkspace }
      if (collapsed) nextLayout[workspaceId] = collapsed
      else delete nextLayout[workspaceId]
      return {
        groupsByWorkspace: { ...s.groupsByWorkspace, [workspaceId]: nextGroups },
        layoutByWorkspace: nextLayout,
        activeGroupIdByWorkspace: {
          ...s.activeGroupIdByWorkspace,
          [workspaceId]: sibling ?? nextGroups[0]?.id ?? ''
        },
        fullscreenGroupIdByWorkspace:
          s.fullscreenGroupIdByWorkspace[workspaceId] === groupId
            ? { ...s.fullscreenGroupIdByWorkspace, [workspaceId]: null }
            : s.fullscreenGroupIdByWorkspace
      }
    })
  },

  closeTab: (tabId, opts) => {
    get().dropReportSegments(tabId)
    const found = locateTab(get(), tabId)
    if (found?.tab.attachedTo) {
      const owner = (get().tabsByWorkspace[found.workspaceId] ?? []).find((t) => t.id === found.tab.attachedTo)
      const file = get().viewerFileByTab[tabId]
      const closed = owner?.reportGroup?.closed ?? []
      if (owner && file && !closed.includes(file)) get().setReportGroup(owner.id, { closed: [...closed, file] })
    }
    const st = get()
    const loc = locateTab(st, tabId)
    if (!loc) return
    const { workspaceId, tab } = loc
    const groups = st.groupsByWorkspace[workspaceId] ?? []
    const group = groups.find((g) => g.id === tab.groupId)
    if (!group) return

    endTabBackingSession(tab)

    const newOrder = group.tabOrder.filter((id) => id !== tabId)
    const tabsLeft = (st.tabsByWorkspace[workspaceId] ?? []).filter((t) => t.id !== tabId)

    if (newOrder.length === 0 && groups.length > 1 && !opts?.keepGroup) {
      const layout = st.layoutByWorkspace[workspaceId]
      const sibling = layout ? findSiblingGroupId(layout, tab.groupId) : null
      const collapsed = layout ? removeLeaf(layout, tab.groupId) : null
      set((s) => {
        const nextGroups = groups.filter((g) => g.id !== tab.groupId)
        const nextLayout = { ...s.layoutByWorkspace }
        if (collapsed) nextLayout[workspaceId] = collapsed
        else delete nextLayout[workspaceId]
        return {
          tabsByWorkspace: { ...s.tabsByWorkspace, [workspaceId]: tabsLeft },
          groupsByWorkspace: { ...s.groupsByWorkspace, [workspaceId]: nextGroups },
          layoutByWorkspace: nextLayout,
          activeGroupIdByWorkspace: {
            ...s.activeGroupIdByWorkspace,
            [workspaceId]: sibling ?? nextGroups[0]?.id ?? ''
          },
          fullscreenGroupIdByWorkspace:
            s.fullscreenGroupIdByWorkspace[workspaceId] === tab.groupId
              ? { ...s.fullscreenGroupIdByWorkspace, [workspaceId]: null }
              : s.fullscreenGroupIdByWorkspace
        }
      })
      get().forgetTabs([tab])
      return
    }

    const nextActive =
      group.activeTabId === tabId ? pickRecentTab(group.tabOrder, tabId) : group.activeTabId
    set((s) => ({
      tabsByWorkspace: { ...s.tabsByWorkspace, [workspaceId]: tabsLeft },
      groupsByWorkspace: {
        ...s.groupsByWorkspace,
        [workspaceId]: (s.groupsByWorkspace[workspaceId] ?? []).map((g) =>
          g.id === tab.groupId ? { ...g, tabOrder: newOrder, activeTabId: nextActive } : g
        )
      }
    }))
    get().forgetTabs([tab])
  },

  moveTab: (tabId, targetGroupId, beforeTabId) => {
    const loc = locateTab(get(), tabId)
    if (!loc) return
    const followers = (get().tabsByWorkspace[loc.workspaceId] ?? []).filter((t) => t.attachedTo === tabId)
    const wasActive = (get().groupsByWorkspace[loc.workspaceId] ?? []).find((g) => g.id === loc.tab.groupId)?.activeTabId ?? null
    get().moveSingleTab(tabId, targetGroupId, beforeTabId)
    if (followers.length === 0) return
    for (const f of followers) if (f.groupId !== targetGroupId) get().moveSingleTab(f.id, targetGroupId, beforeTabId)
    const ids = new Set(followers.map((f) => f.id))
    const active = wasActive && ids.has(wasActive) ? wasActive : tabId
    set((s) => ({
      groupsByWorkspace: {
        ...s.groupsByWorkspace,
        [loc.workspaceId]: (s.groupsByWorkspace[loc.workspaceId] ?? []).map((g) => {
          if (g.id !== targetGroupId) return g
          const rest = g.tabOrder.filter((id) => !ids.has(id))
          const at = rest.indexOf(tabId)
          const kept = g.tabOrder.filter((id) => ids.has(id))
          return { ...g, tabOrder: [...rest.slice(0, at + 1), ...kept, ...rest.slice(at + 1)], activeTabId: active }
        })
      }
    }))
  },

  dropReportSegments: (ownerTabId) => {
    const st = get()
    const loc = locateTab(st, ownerTabId)
    if (!loc) return
    const followers = (st.tabsByWorkspace[loc.workspaceId] ?? []).filter((t) => t.attachedTo === ownerTabId)
    if (followers.length === 0) return
    const gone = new Set(followers.map((f) => f.id))
    for (const f of followers) endTabBackingSession(f)
    set((s) => ({
      tabsByWorkspace: { ...s.tabsByWorkspace, [loc.workspaceId]: (s.tabsByWorkspace[loc.workspaceId] ?? []).filter((t) => !gone.has(t.id)) },
      groupsByWorkspace: {
        ...s.groupsByWorkspace,
        [loc.workspaceId]: (s.groupsByWorkspace[loc.workspaceId] ?? []).map((g) =>
          g.tabOrder.some((id) => gone.has(id))
            ? { ...g, tabOrder: g.tabOrder.filter((id) => !gone.has(id)), activeTabId: g.activeTabId && gone.has(g.activeTabId) ? ownerTabId : g.activeTabId }
            : g
        )
      }
    }))
    get().forgetTabs(followers)
  },

  setReportGroup: (ownerTabId, patch) => {
    const loc = locateTab(get(), ownerTabId)
    if (!loc) return
    set((s) => ({
      tabsByWorkspace: {
        ...s.tabsByWorkspace,
        [loc.workspaceId]: (s.tabsByWorkspace[loc.workspaceId] ?? []).map((t) =>
          t.id === ownerTabId ? { ...t, reportGroup: { ...(t.reportGroup ?? {}), ...patch } } : t
        )
      }
    }))
  },

  attachReportSegment: (ownerTabId, file, opts) => {
    const st = get()
    const loc = locateTab(st, ownerTabId)
    if (!loc || loc.tab.contentType !== 'terminal') return null
    const { workspaceId, tab: owner } = loc
    const norm = (p: string): string => p.replace(/\\/g, '/')
    const want = norm(file)
    const tabs = st.tabsByWorkspace[workspaceId] ?? []
    const shows = (t: Tab): boolean => t.contentType === 'file-viewer' && !!st.viewerFileByTab[t.id] && norm(st.viewerFileByTab[t.id]) === want
    const existing = tabs.find((t) => t.attachedTo === ownerTabId && shows(t)) ?? tabs.find((t) => shows(t) && t.id !== ownerTabId)
    if (existing) {
      if (existing.groupId !== owner.groupId) {
        const prevActive = (st.groupsByWorkspace[workspaceId] ?? []).find((g) => g.id === owner.groupId)?.activeTabId ?? null
        get().moveSingleTab(existing.id, owner.groupId)
        if (!opts.activate && prevActive) {
          set((s) => ({
            groupsByWorkspace: {
              ...s.groupsByWorkspace,
              [workspaceId]: (s.groupsByWorkspace[workspaceId] ?? []).map((g) => (g.id === owner.groupId ? { ...g, activeTabId: prevActive } : g))
            }
          }))
        }
      }
      if (existing.attachedTo !== ownerTabId || existing.preview) {
        set((s) => ({
          tabsByWorkspace: {
            ...s.tabsByWorkspace,
            [workspaceId]: (s.tabsByWorkspace[workspaceId] ?? []).map((t) => (t.id === existing.id ? { ...t, attachedTo: ownerTabId, preview: false } : t))
          }
        }))
      }
      if (opts.activate) get().activateTab(existing.id)
      return existing.id
    }
    const id = uid()
    const tab: Tab = {
      id,
      worktreeId: owner.worktreeId,
      groupId: owner.groupId,
      contentType: 'file-viewer',
      ptyId: uid(),
      label: 'Viewer',
      customLabel: null,
      agentId: null,
      attachedTo: ownerTabId,
      preview: false,
      sortOrder: tabs.length + 1,
      createdAt: Date.now()
    }
    set((s) => ({
      tabsByWorkspace: { ...s.tabsByWorkspace, [workspaceId]: [...(s.tabsByWorkspace[workspaceId] ?? []), tab] },
      groupsByWorkspace: {
        ...s.groupsByWorkspace,
        [workspaceId]: (s.groupsByWorkspace[workspaceId] ?? []).map((g) => {
          if (g.id !== owner.groupId) return g
          const at = g.tabOrder.indexOf(ownerTabId)
          let end = at
          while (end + 1 < g.tabOrder.length && tabs.some((t) => t.id === g.tabOrder[end + 1] && t.attachedTo === ownerTabId)) end++
          return { ...g, tabOrder: [...g.tabOrder.slice(0, end + 1), id, ...g.tabOrder.slice(end + 1)] }
        })
      }
    }))
    get().setViewerFile(id, file)
    if (opts.activate) get().activateTab(id)
    return id
  },

  moveSingleTab: (tabId, targetGroupId, beforeTabId) => {
    const st = get()
    const loc = locateTab(st, tabId)
    if (!loc) return
    const { workspaceId, tab } = loc
    const sourceGroupId = tab.groupId
    const groups = st.groupsByWorkspace[workspaceId] ?? []
    const target = groups.find((g) => g.id === targetGroupId)
    if (!target) return

    const insert = (order: string[]): string[] => {
      const next = order.filter((id) => id !== tabId)
      const idx = beforeTabId ? next.indexOf(beforeTabId) : -1
      if (idx >= 0) next.splice(idx, 0, tabId)
      else next.push(tabId)
      return next
    }

    if (sourceGroupId === targetGroupId) {
      set((s) => ({
        groupsByWorkspace: {
          ...s.groupsByWorkspace,
          [workspaceId]: (s.groupsByWorkspace[workspaceId] ?? []).map((g) =>
            g.id === targetGroupId ? { ...g, tabOrder: insert(g.tabOrder), activeTabId: tabId } : g
          )
        }
      }))
      return
    }

    const source = groups.find((g) => g.id === sourceGroupId)
    if (!source) return
    const newSourceOrder = source.tabOrder.filter((id) => id !== tabId)
    const sourceActive =
      source.activeTabId === tabId ? pickRecentTab(source.tabOrder, tabId) : source.activeTabId
    const sourceEmpties = newSourceOrder.length === 0 && groups.length > 1

    set((s) => {
      const tabs = (s.tabsByWorkspace[workspaceId] ?? []).map((t) =>
        t.id === tabId ? { ...t, groupId: targetGroupId } : t
      )
      let nextGroups = (s.groupsByWorkspace[workspaceId] ?? []).map((g) => {
        if (g.id === sourceGroupId) return { ...g, tabOrder: newSourceOrder, activeTabId: sourceActive }
        if (g.id === targetGroupId) return { ...g, tabOrder: insert(g.tabOrder), activeTabId: tabId }
        return g
      })
      let layoutByWorkspace = s.layoutByWorkspace
      if (sourceEmpties) {
        const layout = s.layoutByWorkspace[workspaceId]
        const collapsed = layout ? removeLeaf(layout, sourceGroupId) : null
        nextGroups = nextGroups.filter((g) => g.id !== sourceGroupId)
        const nl = { ...s.layoutByWorkspace }
        if (collapsed) nl[workspaceId] = collapsed
        else delete nl[workspaceId]
        layoutByWorkspace = nl
      }
      return {
        tabsByWorkspace: { ...s.tabsByWorkspace, [workspaceId]: tabs },
        groupsByWorkspace: { ...s.groupsByWorkspace, [workspaceId]: nextGroups },
        layoutByWorkspace,
        activeGroupIdByWorkspace: {
          ...s.activeGroupIdByWorkspace,
          [workspaceId]: targetGroupId
        }
      }
    })
  },

  moveTabToSplit: (tabId, targetGroupId, direction, position) => {
    const st = get()
    const loc = locateTab(st, tabId)
    if (!loc) return
    const { workspaceId, tab } = loc
    const layout = st.layoutByWorkspace[workspaceId]
    if (!layout) return
    const source = (st.groupsByWorkspace[workspaceId] ?? []).find((g) => g.id === tab.groupId)
    if (tab.groupId === targetGroupId && (source?.tabOrder.length ?? 0) <= 1) return

    const newGroupId = uid()
    const newGroup: TabGroup = { id: newGroupId, activeTabId: null, tabOrder: [] }
    set((s) => ({
      groupsByWorkspace: {
        ...s.groupsByWorkspace,
        [workspaceId]: [...(s.groupsByWorkspace[workspaceId] ?? []), newGroup]
      },
      layoutByWorkspace: {
        ...s.layoutByWorkspace,
        [workspaceId]: replaceLeaf(layout, targetGroupId, buildSplitNode(targetGroupId, newGroupId, direction, position))
      }
    }))
    get().moveTab(tabId, newGroupId)
  },

  moveTabToRootSplit: (tabId, direction, position) => {
    const st = get()
    const loc = locateTab(st, tabId)
    if (!loc) return
    const { workspaceId, tab } = loc
    const layout = st.layoutByWorkspace[workspaceId]
    if (!layout) return
    const groups = st.groupsByWorkspace[workspaceId] ?? []
    const source = groups.find((g) => g.id === tab.groupId)
    if (groups.length <= 1 && (source?.tabOrder.length ?? 0) <= 1) return

    const newGroupId = uid()
    const newGroup: TabGroup = { id: newGroupId, activeTabId: null, tabOrder: [] }
    set((s) => ({
      groupsByWorkspace: {
        ...s.groupsByWorkspace,
        [workspaceId]: [...(s.groupsByWorkspace[workspaceId] ?? []), newGroup]
      },
      layoutByWorkspace: {
        ...s.layoutByWorkspace,
        [workspaceId]: wrapRootSplit(layout, newGroupId, direction, position)
      }
    }))
    get().moveTab(tabId, newGroupId)
  },

  setDraggingTabId: (tabId) => set({ draggingTabId: tabId }),

  openChildAgentTab: (order) => {
    const st = get()
    let workspaceId: string | null = null
    let caller: Tab | undefined
    for (const [wsId, tabs] of Object.entries(st.tabsByWorkspace)) {
      caller = tabs.find((t) => t.ptyId === order.callerPtyId)
      if (caller) {
        workspaceId = wsId
        break
      }
    }
    if (!workspaceId || !caller) return null
    const layout = st.layoutByWorkspace[workspaceId]
    if (!layout) return null
    const placed = placeChildTab({
      layout,
      groups: st.groupsByWorkspace[workspaceId] ?? [],
      caller,
      placement: order.placement,
      tabId: uid(),
      ptyId: order.ptyId,
      newGroupId: uid(),
      agentId: order.agentId,
      label: order.label,
      customLabel: order.customLabel,
      sortOrder: (st.tabsByWorkspace[workspaceId]?.length ?? 0) + 1,
      now: Date.now()
    })
    if (!placed) return null
    const wsId = workspaceId
    set((s) => ({
      tabsByWorkspace: {
        ...s.tabsByWorkspace,
        [wsId]: [...(s.tabsByWorkspace[wsId] ?? []), placed.tab]
      },
      groupsByWorkspace: { ...s.groupsByWorkspace, [wsId]: placed.groups },
      layoutByWorkspace: { ...s.layoutByWorkspace, [wsId]: placed.layout }
    }))
    return placed.tab
  },

  setExternalDropTarget: (target) => set({ externalDropTarget: target }),

  openFileViewerSplit: (workspaceId, sourceGroupId, worktreeId, firstRatio = 0.3) => {
    const layout = get().layoutByWorkspace[workspaceId]
    if (!layout) return null
    const newGroupId = uid()
    const newGroup: TabGroup = { id: newGroupId, activeTabId: null, tabOrder: [] }
    const splitNode = {
      ...buildSplitNode(sourceGroupId, newGroupId, 'horizontal', 'second'),
      ratio: firstRatio
    }
    set((s) => ({
      groupsByWorkspace: {
        ...s.groupsByWorkspace,
        [workspaceId]: [...(s.groupsByWorkspace[workspaceId] ?? []), newGroup]
      },
      layoutByWorkspace: {
        ...s.layoutByWorkspace,
        [workspaceId]: replaceLeaf(layout, sourceGroupId, splitNode)
      },
      activeGroupIdByWorkspace: { ...s.activeGroupIdByWorkspace, [workspaceId]: newGroupId }
    }))
    return get().createTab(workspaceId, worktreeId, {
      groupId: newGroupId,
      contentType: 'file-viewer',
      label: 'Viewer',
      preview: true
    })
  },

  setActiveGroup: (workspaceId, groupId) =>
    set((s) => ({
      activeGroupIdByWorkspace: { ...s.activeGroupIdByWorkspace, [workspaceId]: groupId }
    })),

  toggleGroupFullscreen: (workspaceId, groupId) =>
    set((s) => {
      const next = s.fullscreenGroupIdByWorkspace[workspaceId] === groupId ? null : groupId
      const groups = s.groupsByWorkspace[workspaceId] ?? []
      return {
        fullscreenGroupIdByWorkspace: {
          ...s.fullscreenGroupIdByWorkspace,
          [workspaceId]: next
        },
        activeGroupIdByWorkspace: next
          ? { ...s.activeGroupIdByWorkspace, [workspaceId]: groupId }
          : s.activeGroupIdByWorkspace,
        groupsByWorkspace:
          next && groups.some((g) => g.id === groupId && g.hidden)
            ? {
                ...s.groupsByWorkspace,
                [workspaceId]: groups.map((g) => (g.id === groupId ? { ...g, hidden: false } : g))
              }
            : s.groupsByWorkspace
      }
    }),

  toggleGroupHidden: (workspaceId, groupId) =>
    set((s) => {
      const groups = s.groupsByWorkspace[workspaceId] ?? []
      const group = groups.find((g) => g.id === groupId)
      if (!group) return s
      const hidden = !group.hidden
      return {
        groupsByWorkspace: {
          ...s.groupsByWorkspace,
          [workspaceId]: groups.map((g) => (g.id === groupId ? { ...g, hidden } : g))
        },
        fullscreenGroupIdByWorkspace:
          hidden && s.fullscreenGroupIdByWorkspace[workspaceId] === groupId
            ? { ...s.fullscreenGroupIdByWorkspace, [workspaceId]: null }
            : s.fullscreenGroupIdByWorkspace
      }
    }),

  exitFullscreen: (workspaceId) =>
    set((s) =>
      s.fullscreenGroupIdByWorkspace[workspaceId]
        ? {
            fullscreenGroupIdByWorkspace: {
              ...s.fullscreenGroupIdByWorkspace,
              [workspaceId]: null
            }
          }
        : s
    ),

  detachTab: (tabId) => {
    get().dropReportSegments(tabId)
    const st = get()
    const loc = locateTab(st, tabId)
    if (!loc) return
    const { workspaceId, tab } = loc
    const groups = st.groupsByWorkspace[workspaceId] ?? []
    const group = groups.find((g) => g.id === tab.groupId)
    if (!group) return

    const newOrder = group.tabOrder.filter((id) => id !== tabId)
    const tabsLeft = (st.tabsByWorkspace[workspaceId] ?? []).filter((t) => t.id !== tabId)

    if (newOrder.length === 0 && groups.length > 1) {
      const layout = st.layoutByWorkspace[workspaceId]
      const sibling = layout ? findSiblingGroupId(layout, tab.groupId) : null
      const collapsed = layout ? removeLeaf(layout, tab.groupId) : null
      set((s) => {
        const nextGroups = groups.filter((g) => g.id !== tab.groupId)
        const nextLayout = { ...s.layoutByWorkspace }
        if (collapsed) nextLayout[workspaceId] = collapsed
        else delete nextLayout[workspaceId]
        return {
          tabsByWorkspace: { ...s.tabsByWorkspace, [workspaceId]: tabsLeft },
          groupsByWorkspace: { ...s.groupsByWorkspace, [workspaceId]: nextGroups },
          layoutByWorkspace: nextLayout,
          activeGroupIdByWorkspace: {
            ...s.activeGroupIdByWorkspace,
            [workspaceId]: sibling ?? nextGroups[0]?.id ?? ''
          },
          fullscreenGroupIdByWorkspace:
            s.fullscreenGroupIdByWorkspace[workspaceId] === tab.groupId
              ? { ...s.fullscreenGroupIdByWorkspace, [workspaceId]: null }
              : s.fullscreenGroupIdByWorkspace
        }
      })
      get().forgetTabs([tab])
      return
    }

    const nextActive =
      group.activeTabId === tabId ? pickRecentTab(group.tabOrder, tabId) : group.activeTabId
    set((s) => ({
      tabsByWorkspace: { ...s.tabsByWorkspace, [workspaceId]: tabsLeft },
      groupsByWorkspace: {
        ...s.groupsByWorkspace,
        [workspaceId]: (s.groupsByWorkspace[workspaceId] ?? []).map((g) =>
          g.id === tab.groupId ? { ...g, tabOrder: newOrder, activeTabId: nextActive } : g
        )
      }
    }))
    get().forgetTabs([tab])
  },

  importPanel: (panel) => {
    const incoming = panel?.tabs ?? []
    if (incoming.length === 0) return

    for (const t of incoming) {
      if (t.contentType === 'terminal' && t.scrollback) seedTerminalSnapshot(t.ptyId, t.scrollback)
    }

    const now = Date.now()
    const groupId = uid()
    const newTabs: Tab[] = incoming.map((t, i) => ({
      id: uid(),
      worktreeId: '',
      groupId,
      contentType: t.contentType,
      ptyId: t.ptyId,
      label: t.label,
      generatedLabel: t.generatedLabel ?? null,
      customLabel: t.customLabel ?? null,
      agentId: t.agentId ?? null,
      claudeSessionId: t.claudeSessionId ?? null,
      parentPtyId: t.parentPtyId ?? null,
      tuner: t.tuner ?? null,
      scratchpadId: t.scratchpadId ?? null,
      plugin: t.plugin ?? null,
      sortOrder: i + 1,
      createdAt: now
    }))
    let activeIdx = Math.min(Math.max(panel.activeTabIndex ?? 0, 0), newTabs.length - 1)
    const group: TabGroup = {
      id: groupId,
      activeTabId: newTabs[activeIdx]?.id ?? null,
      tabOrder: newTabs.map((t) => t.id)
    }

    const viewerFilePatch: Record<string, string> = {}
    const markdownPatch: Record<string, 'preview' | 'source'> = {}
    const draftPatch: Record<string, string> = {}
    const blamePatch: Record<string, boolean> = {}
    incoming.forEach((t, i) => {
      const file = t.viewerFile
      if (!file) return
      viewerFilePatch[newTabs[i].id] = file
      if (t.markdownView) markdownPatch[newTabs[i].id] = t.markdownView
      if (typeof t.draft === 'string') draftPatch[file] = t.draft
      if (t.blameEnabled) blamePatch[file] = true
    })
    if (Object.keys(viewerFilePatch).length > 0) {
      set((s) => ({
        viewerFileByTab: { ...s.viewerFileByTab, ...viewerFilePatch },
        markdownViewByTab: { ...s.markdownViewByTab, ...markdownPatch },
        draftsByPath: { ...s.draftsByPath, ...draftPatch },
        blameEnabledByPath: { ...s.blameEnabledByPath, ...blamePatch }
      }))
    }

    const st = get()
    const externalDrop = st.externalDropTarget
    const existingWsId =
      st.activeWorkspaceId && st.workspaces.some((w) => w.id === st.activeWorkspaceId)
        ? st.activeWorkspaceId
        : null

    if (!existingWsId) {
      const first = incoming[0]
      const workspaceId = uid()
      const wtByPath = new Map<string, Worktree>()
      for (const t of incoming) {
        if (!wtByPath.has(t.worktreePath)) {
          wtByPath.set(t.worktreePath, {
            id: uid(),
            workspaceId,
            name: t.worktreeName || 'main',
            path: t.worktreePath,
            createdAt: now
          })
        }
      }
      newTabs.forEach((nt, i) => {
        nt.worktreeId = wtByPath.get(incoming[i].worktreePath)!.id
      })
      const adoptedFolder = panel.originFolderPath || first.worktreePath
      const adoptedWorktree = panel.originWorktreePath || first.worktreePath
      const ws: Workspace = {
        id: workspaceId,
        name: folderWorkspaceName(adoptedFolder),
        folderPath: adoptedFolder,
        worktreePath: adoptedWorktree,
        createdAt: now
      }
      set((s) => ({
        workspaces: [...s.workspaces, ws],
        activeWorkspaceId: workspaceId,
        worktreesByWorkspace: {
          ...s.worktreesByWorkspace,
          [workspaceId]: [...wtByPath.values()]
        },
        tabsByWorkspace: { ...s.tabsByWorkspace, [workspaceId]: newTabs },
        groupsByWorkspace: { ...s.groupsByWorkspace, [workspaceId]: [group] },
        layoutByWorkspace: { ...s.layoutByWorkspace, [workspaceId]: { type: 'leaf', groupId } },
        activeGroupIdByWorkspace: { ...s.activeGroupIdByWorkspace, [workspaceId]: groupId },
        externalDropTarget: null
      }))
      return
    }

    const wid = existingWsId
    const current = st.worktreesByWorkspace[wid] ?? []
    const wtByPath = new Map(current.map((w) => [w.path, w] as const))
    const addedWorktrees: Worktree[] = []
    for (const t of incoming) {
      if (!wtByPath.has(t.worktreePath)) {
        const w: Worktree = {
          id: uid(),
          workspaceId: wid,
          name: t.worktreeName || 'main',
          path: t.worktreePath,
          createdAt: now
        }
        wtByPath.set(t.worktreePath, w)
        addedWorktrees.push(w)
      }
    }
    newTabs.forEach((nt, i) => {
      nt.worktreeId = wtByPath.get(incoming[i].worktreePath)!.id
    })

    const merged = new Set<string>()
    for (const nt of newTabs) {
      if (nt.contentType !== 'unity-console') continue
      const existing = consoleTabFor(st.tabsByWorkspace[wid] ?? [], nt.worktreeId)
      if (!existing) continue
      merged.add(nt.id)
      get().setTabScratchpad(existing.id, nt.scratchpadId ?? null)
      get().activateTab(existing.id)
      get().pulseAgentPane(existing.ptyId, 'opened')
    }
    if (merged.size > 0) {
      const placedTabs = newTabs.filter((nt) => !merged.has(nt.id))
      if (placedTabs.length === 0) {
        set({ externalDropTarget: null })
        return
      }
      const wasActive = newTabs[activeIdx]
      newTabs.splice(0, newTabs.length, ...placedTabs)
      activeIdx = Math.max(0, newTabs.indexOf(wasActive))
      group.tabOrder = newTabs.map((t) => t.id)
      group.activeTabId = newTabs[activeIdx]?.id ?? null
    }

    const layout = st.layoutByWorkspace[wid]
    const groups = st.groupsByWorkspace[wid] ?? []
    const rootDrop = externalDrop?.scope === 'root' ? externalDrop : null
    const drop =
      externalDrop?.scope === 'leaf' && groups.some((g) => g.id === externalDrop.groupId)
        ? externalDrop
        : null
    const anchorGroupId =
      drop?.groupId ?? st.activeGroupIdByWorkspace[wid] ?? (layout ? findFirstLeaf(layout) : '')

    if (drop && drop.zone === 'center') {
      for (const nt of newTabs) nt.groupId = anchorGroupId
      set((s) => ({
        worktreesByWorkspace: {
          ...s.worktreesByWorkspace,
          [wid]: [...(s.worktreesByWorkspace[wid] ?? []), ...addedWorktrees]
        },
        tabsByWorkspace: {
          ...s.tabsByWorkspace,
          [wid]: [...(s.tabsByWorkspace[wid] ?? []), ...newTabs]
        },
        groupsByWorkspace: {
          ...s.groupsByWorkspace,
          [wid]: (s.groupsByWorkspace[wid] ?? []).map((g) =>
            g.id === anchorGroupId
              ? {
                  ...g,
                  tabOrder: [...g.tabOrder, ...newTabs.map((t) => t.id)],
                  activeTabId: newTabs[activeIdx]?.id ?? g.activeTabId
                }
              : g
          )
        },
        activeGroupIdByWorkspace: { ...s.activeGroupIdByWorkspace, [wid]: anchorGroupId },
        externalDropTarget: null
      }))
      return
    }

    const [dir, pos] = (rootDrop ?? drop)
      ? zoneToSplit((rootDrop ?? drop)!.zone)
      : (['horizontal', 'second'] as const)
    set((s) => {
      const nextLayout: TabGroupLayoutNode =
        rootDrop && layout
          ? wrapRootSplit(layout, groupId, dir, pos)
          : layout && anchorGroupId
            ? replaceLeaf(layout, anchorGroupId, buildSplitNode(anchorGroupId, groupId, dir, pos))
            : { type: 'leaf', groupId }
      return {
        worktreesByWorkspace: {
          ...s.worktreesByWorkspace,
          [wid]: [...(s.worktreesByWorkspace[wid] ?? []), ...addedWorktrees]
        },
        tabsByWorkspace: {
          ...s.tabsByWorkspace,
          [wid]: [...(s.tabsByWorkspace[wid] ?? []), ...newTabs]
        },
        groupsByWorkspace: {
          ...s.groupsByWorkspace,
          [wid]: [...(s.groupsByWorkspace[wid] ?? []), group]
        },
        layoutByWorkspace: { ...s.layoutByWorkspace, [wid]: nextLayout },
        activeGroupIdByWorkspace: { ...s.activeGroupIdByWorkspace, [wid]: groupId },
        externalDropTarget: null
      }
    })
  },

  importWorkspace: (moved) => {
    const ws = moved?.workspace
    if (!ws || !isValidLayoutNode(moved.layout)) return
    if (get().workspaces.some((w) => w.id === ws.id)) return

    for (const [ptyId, data] of Object.entries(moved.scrollbackByPty ?? {})) {
      if (data) seedTerminalSnapshot(ptyId, data)
    }

    set((s) => ({
      workspaces: [...s.workspaces, ws],
      activeWorkspaceId: ws.id,
      worktreesByWorkspace: { ...s.worktreesByWorkspace, [ws.id]: moved.worktrees ?? [] },
      tabsByWorkspace: { ...s.tabsByWorkspace, [ws.id]: moved.tabs ?? [] },
      groupsByWorkspace: { ...s.groupsByWorkspace, [ws.id]: moved.groups ?? [] },
      layoutByWorkspace: { ...s.layoutByWorkspace, [ws.id]: moved.layout },
      activeGroupIdByWorkspace: { ...s.activeGroupIdByWorkspace, [ws.id]: moved.activeGroupId },
      viewerFileByTab: { ...s.viewerFileByTab, ...(moved.viewerFileByTab ?? {}) },
      markdownViewByTab: { ...s.markdownViewByTab, ...(moved.markdownViewByTab ?? {}) },
      selectedFileByWorktree: { ...s.selectedFileByWorktree, ...(moved.selectedFileByWorktree ?? {}) },
      expandedDirsByWorktree: { ...s.expandedDirsByWorktree, ...(moved.expandedDirsByWorktree ?? {}) },
      draftsByPath: { ...s.draftsByPath, ...(moved.draftsByPath ?? {}) }
    }))
  },

  setLayoutRatio: (workspaceId, path, ratio) => {
    const layout = get().layoutByWorkspace[workspaceId]
    if (!layout) return
    set((s) => ({
      layoutByWorkspace: {
        ...s.layoutByWorkspace,
        [workspaceId]: updateSplitRatio(layout, path, ratio)
      }
    }))
  },

  setTabLabel: (tabId, label) => {
    const loc = locateTab(get(), tabId)
    if (!loc) return
    const { workspaceId } = loc
    const trimmed = label.trim()
    set((s) => ({
      tabsByWorkspace: {
        ...s.tabsByWorkspace,
        [workspaceId]: (s.tabsByWorkspace[workspaceId] ?? []).map((t) =>
          t.id === tabId ? { ...t, customLabel: trimmed || null } : t
        )
      }
    }))
  },

  setTabTuner: (tabId, tuner, label, scratchpadId) => {
    const loc = locateTab(get(), tabId)
    if (!loc) return
    const { workspaceId } = loc
    set((s) => ({
      tabsByWorkspace: {
        ...s.tabsByWorkspace,
        [workspaceId]: (s.tabsByWorkspace[workspaceId] ?? []).map((t) =>
          t.id === tabId
            ? { ...t, tuner, label, ...(scratchpadId !== undefined ? { scratchpadId } : {}) }
            : t
        )
      }
    }))
  },

  setTabContent: (tabId, contentType, tuner, label) => {
    const loc = locateTab(get(), tabId)
    if (!loc) return
    const { workspaceId } = loc
    set((s) => ({
      tabsByWorkspace: {
        ...s.tabsByWorkspace,
        [workspaceId]: (s.tabsByWorkspace[workspaceId] ?? []).map((t) =>
          t.id === tabId ? { ...t, contentType, tuner, label, scratchpadId: null } : t
        )
      }
    }))
  },

  setTabScratchpad: (tabId, scratchpadId) => {
    const loc = locateTab(get(), tabId)
    if (!loc) return
    const { workspaceId } = loc
    set((s) => ({
      tabsByWorkspace: {
        ...s.tabsByWorkspace,
        [workspaceId]: (s.tabsByWorkspace[workspaceId] ?? []).map((t) =>
          t.id === tabId ? { ...t, scratchpadId } : t
        )
      }
    }))
  },

  setTabGeneratedLabel: (ptyId, title) => {
    const next = title.trim() || null
    const st = get()
    for (const [workspaceId, tabs] of Object.entries(st.tabsByWorkspace)) {
      const tab = tabs.find((t) => t.ptyId === ptyId)
      if (!tab) continue
      if (tab.generatedLabel === next) return
      set((s) => ({
        tabsByWorkspace: {
          ...s.tabsByWorkspace,
          [workspaceId]: (s.tabsByWorkspace[workspaceId] ?? []).map((t) =>
            t.ptyId === ptyId ? { ...t, generatedLabel: next } : t
          )
        }
      }))
      return
    }
  },

  setTabClaudeSession: (ptyId, sessionId) => {
    const st = get()
    for (const [workspaceId, tabs] of Object.entries(st.tabsByWorkspace)) {
      const tab = tabs.find((t) => t.ptyId === ptyId)
      if (!tab) continue
      if ((tab.claudeSessionId ?? null) === sessionId) return
      set((s) => ({
        tabsByWorkspace: {
          ...s.tabsByWorkspace,
          [workspaceId]: (s.tabsByWorkspace[workspaceId] ?? []).map((t) =>
            t.ptyId === ptyId ? { ...t, claudeSessionId: sessionId } : t
          )
        }
      }))
      return
    }
  },

  replaceTabPty: (tabId) => {
    const located = locateTab(get(), tabId)
    if (!located) return null
    const ptyId = uid()
    const oldPtyId = located.tab.ptyId
    set((s) => ({
      tabsByWorkspace: {
        ...s.tabsByWorkspace,
        [located.workspaceId]: (s.tabsByWorkspace[located.workspaceId] ?? []).map((t) =>
          t.id === tabId ? { ...t, ptyId } : t
        )
      },
      exitedPtyIds: s.exitedPtyIds.filter((id) => id !== oldPtyId)
    }))
    return ptyId
  },

  markPtyExited: (ptyId) =>
    set((s) =>
      s.exitedPtyIds.includes(ptyId) || !hasTabWithPty(s, ptyId)
        ? s
        : { exitedPtyIds: [...s.exitedPtyIds, ptyId] }
    ),

  hydrateTabs: (state) => {
    const layouts = state.layoutByWorkspace ?? {}
    const groups = state.groupsByWorkspace ?? {}
    const tabs = state.tabsByWorkspace ?? {}
    const activeGroups = state.activeGroupIdByWorkspace ?? {}

    const layoutByWorkspace: typeof layouts = {}
    const groupsByWorkspace: typeof groups = {}
    const tabsByWorkspace: typeof tabs = {}
    const activeGroupIdByWorkspace: typeof activeGroups = {}

    for (const [wsId, layout] of Object.entries(layouts)) {
      if (!isValidLayoutNode(layout)) continue
      const wsGroups = groups[wsId] ?? []
      const groupIds = new Set(wsGroups.map((g) => g.id))
      if (!collectGroupIds(layout).every((id) => groupIds.has(id))) continue
      layoutByWorkspace[wsId] = layout
      groupsByWorkspace[wsId] = wsGroups
      tabsByWorkspace[wsId] = (tabs[wsId] ?? []).map((t) => withCurrentTabLabel(withCurrentTunerTab(t)))
      if (activeGroups[wsId]) activeGroupIdByWorkspace[wsId] = activeGroups[wsId]
    }

    const livePtyIds = new Set<string>()
    for (const wsTabs of Object.values(tabsByWorkspace)) for (const t of wsTabs) livePtyIds.add(t.ptyId)

    set({
      tabsByWorkspace,
      groupsByWorkspace,
      layoutByWorkspace,
      activeGroupIdByWorkspace,
      exitedPtyIds: Array.isArray(state.exitedPtyIds)
        ? state.exitedPtyIds.filter((id) => livePtyIds.has(id))
        : []
    })

    for (const [wsId, wsTabs] of Object.entries(tabsByWorkspace)) {
      for (const id of duplicateConsoleTabIds(wsTabs, groupsByWorkspace[wsId] ?? [])) get().closeTab(id)
      for (const id of duplicateTunerTabIds(wsTabs, groupsByWorkspace[wsId] ?? [])) get().closeTab(id)
      for (const t of wsTabs) if (!isKnownTabType(t.contentType)) get().closeTab(t.id)
    }
  },

  removeWorkspaceTabs: (workspaceId) => {
    const removed = get().tabsByWorkspace[workspaceId] ?? []
    for (const tab of removed) endTabBackingSession(tab)
    set((s) => {
      const tabsByWorkspace = { ...s.tabsByWorkspace }
      const groupsByWorkspace = { ...s.groupsByWorkspace }
      const layoutByWorkspace = { ...s.layoutByWorkspace }
      const activeGroupIdByWorkspace = { ...s.activeGroupIdByWorkspace }
      const fullscreenGroupIdByWorkspace = { ...s.fullscreenGroupIdByWorkspace }
      delete tabsByWorkspace[workspaceId]
      delete groupsByWorkspace[workspaceId]
      delete layoutByWorkspace[workspaceId]
      delete activeGroupIdByWorkspace[workspaceId]
      delete fullscreenGroupIdByWorkspace[workspaceId]
      return {
        tabsByWorkspace,
        groupsByWorkspace,
        layoutByWorkspace,
        activeGroupIdByWorkspace,
        fullscreenGroupIdByWorkspace
      }
    })
    get().forgetTabs(removed)
  },

  forgetTabs: (tabs) => {
    for (const t of tabs) {
      forgetTabUse(t.id)
      forgetTuner(t.id)
      forgetDriftTab(t.id)
    }
    const patch = forgetTabsPatch(get(), tabs)
    if (Object.keys(patch).length > 0) set(patch)
  }
})
