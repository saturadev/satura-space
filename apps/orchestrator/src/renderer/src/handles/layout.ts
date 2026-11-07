import type { Tab, TabContentType, TabGroupLayoutNode } from '@shared/types'
import { useAppStore, type AppState } from '../store'
import { paneModelOf } from '../lib/agent-exec/panes'
import { moveTabToWindow } from '../lib/panel-move'
import { removeLeaf, shownTab } from '../lib/tab-tree'
import { GIT_TAB_LABEL } from '../lib/tab-label'
import { defineHandle, workspaceByPath, type RendererCtx } from './registry'
import { sceneTunerTab } from '../lib/tuner/tuner-target'

const KINDS: Record<string, { type: TabContentType; label?: string; single: boolean }> = {
  terminal: { type: 'terminal', single: false },
  unity: { type: 'unity-instance-player', label: 'Unity Player', single: true },
  console: { type: 'unity-console', label: 'Unity Console', single: true },
  git: { type: 'git-scm', label: GIT_TAB_LABEL, single: true },
  tuner: { type: 'tuner', label: 'Tuner', single: false },
  scratchpads: { type: 'unity-scratchpad', label: 'Scratchpads', single: true },
  dashboard: { type: 'dashboard', label: 'Dashboard', single: true }
}

export function settle(): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 150)
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        clearTimeout(timer)
        resolve()
      })
    )
  })
}

function workspaceOfTab(s: AppState, tabId: string): string | null {
  for (const [ws, tabs] of Object.entries(s.tabsByWorkspace)) if (tabs.some((t) => t.id === tabId)) return ws
  return null
}

export function tabInfo(s: AppState, tab: Tab): Record<string, unknown> {
  const ws = workspaceOfTab(s, tab.id) ?? ''
  const all = s.tabsByWorkspace[ws] ?? []
  const group = (s.groupsByWorkspace[ws] ?? []).find((g) => g.id === tab.groupId)
  const full = s.fullscreenGroupIdByWorkspace[ws]
  return {
    id: tab.id,
    ptyId: tab.ptyId,
    groupId: tab.groupId,
    kind: tab.contentType,
    label: tab.customLabel ?? tab.generatedLabel ?? tab.label,
    agentId: tab.agentId ?? null,
    exited: s.exitedPtyIds.includes(tab.ptyId),
    shown: !!group && !group.hidden && (!full || full === group.id) && shownTab(group, all)?.id === tab.id,
    ...(tab.tuner ? { tuner: tab.tuner } : {}),
    ...(s.viewerFileByTab[tab.id] ? { file: s.viewerFileByTab[tab.id] } : {})
  }
}

export function panes(ws: string): unknown {
  return paneModelOf(useAppStore.getState(), ws)
}

function findTab(id: unknown): { tab: Tab; ws: string } {
  const s = useAppStore.getState()
  for (const [ws, tabs] of Object.entries(s.tabsByWorkspace)) {
    const tab = tabs.find((t) => t.id === id || t.ptyId === id)
    if (tab) return { tab, ws }
  }
  throw new Error(`There is no tab ${String(id)}. app.state lists the tabs.`)
}

function dockRight(ws: string, groupId: string, share: number): void {
  const s = useAppStore.getState()
  const layout = s.layoutByWorkspace[ws]
  if (!layout) throw new Error('The workspace has no layout yet.')
  let left = removeLeaf(layout, groupId)
  if (!left) return
  const tabs = s.tabsByWorkspace[ws] ?? []
  const unity = (s.groupsByWorkspace[ws] ?? []).find((g) => g.id !== groupId && tabs.find((t) => t.id === g.activeTabId)?.contentType === 'unity-instance-player')?.id
  const others = unity ? removeLeaf(left, unity) : null
  if (unity && others) left = { type: 'split', direction: 'vertical', first: { type: 'leaf', groupId: unity }, second: others, ratio: 0.6 }
  const next: TabGroupLayoutNode = { type: 'split', direction: 'horizontal', first: left, second: { type: 'leaf', groupId }, ratio: 1 - share }
  s.setSidebarOpen(false)
  if (s.fullscreenGroupIdByWorkspace[ws]) s.exitFullscreen(ws)
  useAppStore.setState({ layoutByWorkspace: { ...useAppStore.getState().layoutByWorkspace, [ws]: next } })
}

function clampShare(raw: unknown, fallback: number): number {
  const n = Number(raw)
  return Number.isFinite(n) && n > 0.1 && n < 0.9 ? n : fallback
}

defineHandle({
  name: 'app.state',
  side: 'renderer',
  description:
    'Reads the window state: every workspace (id, name, folder, active), and for the project workspace its tabs (id, ptyId, group, kind, label, agent, exited, shown, and file for a viewer tab), groups, layout tree, active and fullscreen group, sidebar, and the pane model with pixel sizes. Returns that object.',
  params: {},
  async run(_p, ctx: RendererCtx) {
    const s = useAppStore.getState()
    const ws = ctx.workspaceId
    return {
      activeWorkspace: s.activeWorkspaceId,
      workspace: ws || null,
      workspaces: s.workspaces.map((w) => ({ id: w.id, name: w.name, folder: w.folderPath, active: w.id === s.activeWorkspaceId, tabs: (s.tabsByWorkspace[w.id] ?? []).length })),
      sidebar: { open: s.sidebarOpen },
      tabs: (s.tabsByWorkspace[ws] ?? []).map((t) => tabInfo(s, t)),
      groups: (s.groupsByWorkspace[ws] ?? []).map((g) => ({ id: g.id, activeTabId: g.activeTabId, tabs: g.tabOrder, hidden: !!g.hidden })),
      activeGroup: s.activeGroupIdByWorkspace[ws] ?? null,
      fullscreenGroup: s.fullscreenGroupIdByWorkspace[ws] ?? null,
      layout: s.layoutByWorkspace[ws] ?? null,
      panes: ws ? panes(ws) : null
    }
  }
})

defineHandle({
  name: 'layout.open',
  side: 'renderer',
  description:
    "Opens a panel the way the New session menu does. kind is terminal, unity, console, git, tuner, scratchpads or dashboard; unity, console, git, scratchpads and dashboard reuse an open tab of that kind, and tuner reuses the open scene Tuner whatever its target (the project or a scratchpad), since there is only one. folder opens or creates a workspace for that folder first; otherwise it uses the project workspace. dock is beside (a new split next to the active group), tab (a tab in the active group) or right (a split docked right at share of the width). Returns the tab, whether it was reused, the workspace id and the pane model.",
  params: { kind: 'terminal', folder: '', dock: 'beside', share: 0.4 },
  async run(p, ctx: RendererCtx) {
    if (/^(files?|explorer|file-hierarchy)$/i.test(String(p.kind)))
      throw new Error(`There's no ${String(p.kind)} panel. The file explorer is part of the sidebar, and layout.dock { sidebar: true } opens it.`)
    const kind = KINDS[String(p.kind)]
    if (!kind) throw new Error(`Unknown kind ${String(p.kind)}. Use ${Object.keys(KINDS).join(', ')}.`)
    let s = useAppStore.getState()
    const folder = String(p.folder ?? '').trim()
    const ws = folder ? (workspaceByPath(s, folder) ?? s.createWorkspace(undefined, folder, folder)) : ctx.workspaceId
    if (!ws) throw new Error('There is no workspace to open the panel in. Pass folder, or open the project first.')
    if (useAppStore.getState().activeWorkspaceId !== ws) useAppStore.getState().setActiveWorkspace(ws)
    s = useAppStore.getState()
    const want = (folder || ctx.projectRoot).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
    const worktrees = s.worktreesByWorkspace[ws] ?? []
    const worktreeId = (worktrees.find((w) => w.path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() === want) ?? worktrees[0])?.id
    if (!worktreeId) throw new Error('The workspace has no folder to open the panel for.')
    const existing = kind.single
      ? (s.tabsByWorkspace[ws] ?? []).find((t) => t.contentType === kind.type && t.worktreeId === worktreeId)
      : kind.type === 'tuner'
        ? sceneTunerTab(s.tabsByWorkspace[ws] ?? [], worktreeId, undefined, s.groupsByWorkspace[ws] ?? []) ?? undefined
        : undefined
    let tab: Tab
    if (existing) {
      s.activateTab(existing.id)
      tab = existing
    } else {
      const group = s.activeGroupIdByWorkspace[ws] ?? s.ensureWorkbench(ws)
      const opts = { contentType: kind.type, ...(kind.label ? { label: kind.label } : {}) }
      tab = p.dock === 'tab' ? s.createTab(ws, worktreeId, { ...opts, groupId: group }) : s.openTabBeside(ws, group, worktreeId, opts)
    }
    if (p.dock === 'right') dockRight(ws, tab.groupId, clampShare(p.share, 0.4))
    await settle()
    const now = useAppStore.getState()
    const fresh = (now.tabsByWorkspace[ws] ?? []).find((t) => t.id === tab.id) ?? tab
    return { tab: tabInfo(now, fresh), reused: !!existing, workspace: ws, panes: panes(ws) }
  }
})

defineHandle({
  name: 'layout.move',
  side: 'renderer',
  description:
    "Moves a tab (by tab id or ptyId). group moves it into that group; split: left, right, up or down splits the target group (group, or the active group) and puts the tab on that side; window: 'new' or a window id moves it to another window. Returns the tab and the pane model.",
  params: { tab: '', group: '', split: '', window: '' },
  async run(p) {
    const { tab, ws } = findTab(p.tab)
    const s = useAppStore.getState()
    if (p.window) {
      const ok = await moveTabToWindow(tab.id, String(p.window))
      if (!ok) throw new Error(`Could not move the tab to window ${String(p.window)}.`)
      return { moved: 'window', window: String(p.window) }
    }
    const group = String(p.group || s.activeGroupIdByWorkspace[ws] || '')
    if (!group) throw new Error('Pass group: the workspace has no active group.')
    if (p.split) {
      const side = String(p.split)
      const dirs: Record<string, ['horizontal' | 'vertical', 'first' | 'second']> = { left: ['horizontal', 'first'], right: ['horizontal', 'second'], up: ['vertical', 'first'], down: ['vertical', 'second'] }
      const how = dirs[side]
      if (!how) throw new Error('split is left, right, up or down.')
      s.moveTabToSplit(tab.id, group, how[0], how[1])
    } else s.moveTab(tab.id, group)
    await settle()
    const now = useAppStore.getState()
    const moved = (now.tabsByWorkspace[ws] ?? []).find((t) => t.id === tab.id)
    return { tab: moved ? tabInfo(now, moved) : null, panes: panes(ws) }
  }
})

defineHandle({
  name: 'layout.dock',
  side: 'renderer',
  description:
    "Changes the layout around a panel. With tab or group it docks that group on the right at share of the width, closing the sidebar, the way the Tuner opens beside the game. sidebar: true or false opens or closes the sidebar; fullscreen: true or false toggles the group's fullscreen. Returns the pane model.",
  params: { tab: '', group: '', share: 0.4, sidebar: null, fullscreen: null },
  async run(p, ctx: RendererCtx) {
    let ws = ctx.workspaceId
    let group = String(p.group ?? '')
    if (p.tab) {
      const found = findTab(p.tab)
      ws = found.ws
      group = found.tab.groupId
    }
    const s = useAppStore.getState()
    if (group && p.fullscreen === null) dockRight(ws, group, clampShare(p.share, 0.4))
    if (group && typeof p.fullscreen === 'boolean' && (s.fullscreenGroupIdByWorkspace[ws] === group) !== p.fullscreen) s.toggleGroupFullscreen(ws, group)
    if (typeof p.sidebar === 'boolean') useAppStore.getState().setSidebarOpen(p.sidebar)
    await settle()
    return panes(ws)
  }
})

defineHandle({
  name: 'layout.close',
  side: 'renderer',
  description: 'Closes a tab by tab id or ptyId, like its close button but without the confirm for unsaved Tuner edits. Returns the pane model.',
  params: { tab: '' },
  async run(p) {
    const { tab, ws } = findTab(p.tab)
    useAppStore.getState().closeTab(tab.id)
    await settle()
    return panes(ws)
  }
})
