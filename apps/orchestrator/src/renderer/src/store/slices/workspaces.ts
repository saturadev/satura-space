import type {
  Workspace,
  Worktree,
  Tab,
  TabGroup,
  TabGroupLayoutNode,
  TabContentType,
  AgentId
} from '@shared/types'
import type { WindowSession } from '@shared/api'
import type { StateCreator } from 'zustand'
import type { AppState } from '../index'
import { uid } from '../../lib/id'
import { linearSplit } from '../../lib/tab-tree'
import { folderWorkspaceName } from '../../lib/path'
import { setPendingCommand } from '../../lib/terminal/pending-commands'
import {
  captureTerminalSnapshotsForPersistence,
  pruneSeededTerminalSnapshots,
  seedTerminalSnapshots
} from '../../lib/terminal/serialize'

export interface TerminalAgentLaunch {
  command: string
  label: string
  agentId: AgentId
}

function findWorkspaceByIdentity(
  workspaces: Workspace[],
  folderPath: string,
  worktreePath: string
): Workspace | undefined {
  if (!worktreePath) return undefined
  return workspaces.find(
    (w) => (w.folderPath ?? '') === folderPath && (w.worktreePath ?? '') === worktreePath
  )
}

export interface WorkspacesSlice {
  workspaces: Workspace[]
  activeWorkspaceId: string | null
  worktreeBusy: boolean
  setWorktreeBusy: (busy: boolean) => void

  createWorkspace: (name?: string, folderPath?: string, worktreePath?: string) => string

  createWorkspaceWithGrid: (
    folderPath: string | undefined,
    worktreePath: string | undefined,
    rows: number,
    cols: number,
    terminalAgents?: (TerminalAgentLaunch | null)[]
  ) => string

  createWorkspaceWithDefaultView: (
    folderPath: string | undefined,
    worktreePath: string | undefined,
    rows: number,
    cols: number,
    terminalAgents?: (TerminalAgentLaunch | null)[]
  ) => string
  deleteWorkspace: (id: string) => void
  closeAllWorkspaces: () => void

  detachWorkspace: (id: string) => void
  setActiveWorkspace: (id: string | null) => void
  moveWorkspace: (id: string, beforeId: string | null) => void

  buildWindowSession: (opts?: { terminalSnapshots?: boolean }) => WindowSession
  hydrateWindowSession: (session: WindowSession) => void

  hydrationSucceeded: boolean
  setHydrationSucceeded: (value: boolean) => void
}

export const createWorkspacesSlice: StateCreator<AppState, [], [], WorkspacesSlice> = (set, get) => ({
  workspaces: [],
  activeWorkspaceId: null,
  worktreeBusy: false,
  setWorktreeBusy: (busy) => set({ worktreeBusy: busy }),

  hydrationSucceeded: false,
  setHydrationSucceeded: (value) => set({ hydrationSucceeded: value }),

  createWorkspace: (name, folderPath, worktreePath) => {
    const cwd = worktreePath ?? folderPath ?? ''
    const existing = findWorkspaceByIdentity(get().workspaces, folderPath ?? '', cwd)
    if (existing) {
      set({ activeWorkspaceId: existing.id })
      return existing.id
    }
    const id = uid()
    const trimmed = name?.trim()
    const ws: Workspace = {
      id,
      name: trimmed || folderWorkspaceName(folderPath),
      folderPath: folderPath ?? '',
      worktreePath: cwd,
      createdAt: Date.now()
    }
    if (folderPath) window.api.recents.add(folderPath)
    set((s) => ({ workspaces: [...s.workspaces, ws], activeWorkspaceId: id }))
    const worktree = get().createWorktree(id, cwd, 'main')
    get().createTab(id, worktree.id)
    return id
  },

  createWorkspaceWithGrid: (folderPath, worktreePath, rows, cols, terminalAgents) => {
    const now = Date.now()
    const cwd = worktreePath ?? folderPath ?? ''
    const existing = findWorkspaceByIdentity(get().workspaces, folderPath ?? '', cwd)
    if (existing) {
      set({ activeWorkspaceId: existing.id })
      return existing.id
    }
    const id = uid()
    const ws: Workspace = {
      id,
      name: folderWorkspaceName(folderPath),
      folderPath: folderPath ?? '',
      worktreePath: cwd,
      createdAt: now
    }
    if (folderPath) window.api.recents.add(folderPath)
    const worktree: Worktree = {
      id: uid(),
      workspaceId: id,
      name: 'main',
      path: cwd,
      createdAt: now
    }

    const groups: TabGroup[] = []
    const tabs: Tab[] = []
    let sortOrder = 0

    let firstTerminalGroupId = ''
    const rowNodes = Array.from({ length: rows }, (_, r) => {
      const cellLeaves = Array.from({ length: cols }, (_, c) => {
        const groupId = uid()
        const tabId = uid()
        const ptyId = uid()
        const n = r * cols + c + 1
        const agent = terminalAgents?.[n - 1] ?? null
        if (!firstTerminalGroupId) firstTerminalGroupId = groupId
        sortOrder += 1
        tabs.push({
          id: tabId,
          worktreeId: worktree.id,
          groupId,
          contentType: 'terminal',
          ptyId,
          label: agent?.label ?? `Terminal ${n}`,
          customLabel: null,
          agentId: agent?.agentId ?? null,
          sortOrder,
          createdAt: now
        })
        if (agent) setPendingCommand(ptyId, agent.command)
        groups.push({ id: groupId, activeTabId: tabId, tabOrder: [tabId] })
        return { type: 'leaf' as const, groupId }
      })
      return linearSplit(cellLeaves, 'horizontal')
    })
    const layout: TabGroupLayoutNode = linearSplit(rowNodes, 'vertical')

    set((s) => ({
      workspaces: [...s.workspaces, ws],
      activeWorkspaceId: id,
      worktreesByWorkspace: { ...s.worktreesByWorkspace, [id]: [worktree] },
      tabsByWorkspace: { ...s.tabsByWorkspace, [id]: tabs },
      groupsByWorkspace: { ...s.groupsByWorkspace, [id]: groups },
      layoutByWorkspace: { ...s.layoutByWorkspace, [id]: layout },
      activeGroupIdByWorkspace: {
        ...s.activeGroupIdByWorkspace,
        [id]: firstTerminalGroupId
      }
    }))
    return id
  },

  createWorkspaceWithDefaultView: (folderPath, worktreePath, rows, cols, terminalAgents) => {
    const now = Date.now()
    const cwd = worktreePath ?? folderPath ?? ''
    const existing = findWorkspaceByIdentity(get().workspaces, folderPath ?? '', cwd)
    if (existing) {
      set({ activeWorkspaceId: existing.id })
      return existing.id
    }
    const id = uid()
    const ws: Workspace = {
      id,
      name: folderWorkspaceName(folderPath),
      folderPath: folderPath ?? '',
      worktreePath: cwd,
      createdAt: now
    }
    if (folderPath) window.api.recents.add(folderPath)
    const worktree: Worktree = {
      id: uid(),
      workspaceId: id,
      name: 'main',
      path: cwd,
      createdAt: now
    }

    const groups: TabGroup[] = []
    const tabs: Tab[] = []
    let sortOrder = 0
    const pane = (
      contentType: TabContentType,
      label: string,
      agent?: TerminalAgentLaunch | null
    ): TabGroupLayoutNode => {
      const groupId = uid()
      const tabId = uid()
      const ptyId = uid()
      sortOrder += 1
      tabs.push({
        id: tabId,
        worktreeId: worktree.id,
        groupId,
        contentType,
        ptyId,
        label,
        customLabel: null,
        agentId: agent?.agentId ?? null,
        sortOrder,
        createdAt: now
      })
      if (agent?.command) setPendingCommand(ptyId, agent.command)
      groups.push({ id: groupId, activeTabId: tabId, tabOrder: [tabId] })
      return { type: 'leaf', groupId }
    }

    const total = rows * cols
    const terminalGrid = linearSplit(
      Array.from({ length: rows }, (_, r) =>
        linearSplit(
          Array.from({ length: cols }, (_, c) => {
            const n = r * cols + c + 1
            const agent = terminalAgents?.[n - 1] ?? null
            const label = agent?.label ?? (total === 1 ? 'Terminal' : `Terminal ${n}`)
            return pane('terminal', label, agent)
          }),
          'horizontal'
        )
      ),
      'vertical'
    )
    const unityColumn = linearSplit(
      [pane('unity-instance-player', 'Unity Player'), pane('unity-console', 'Unity Console')],
      'vertical'
    )
    const layout: TabGroupLayoutNode = linearSplit([terminalGrid, unityColumn], 'horizontal')

    set((s) => ({
      workspaces: [...s.workspaces, ws],
      activeWorkspaceId: id,
      worktreesByWorkspace: { ...s.worktreesByWorkspace, [id]: [worktree] },
      tabsByWorkspace: { ...s.tabsByWorkspace, [id]: tabs },
      groupsByWorkspace: { ...s.groupsByWorkspace, [id]: groups },
      layoutByWorkspace: { ...s.layoutByWorkspace, [id]: layout },
      activeGroupIdByWorkspace: { ...s.activeGroupIdByWorkspace, [id]: groups[0].id }
    }))
    return id
  },

  deleteWorkspace: (id) => {
    const ws = get().workspaces.find((w) => w.id === id)
    const worktrees = get().worktreesByWorkspace[id] ?? []
    get().removeWorkspaceTabs(id)
    get().removeWorkspaceWorktrees(id)
    const paths = new Set([ws?.worktreePath ?? '', ...worktrees.map((w) => w.path)])
    for (const p of paths) {
      if (p && /[\\/]\.sspace[\\/]worktrees[\\/]/.test(p)) {
        void window.api.git.releaseWorktreeProcesses(p)
      }
    }
    get().clearWorktreeFiles(worktrees.map((w) => w.id))
    set((s) => {
      const workspaces = s.workspaces.filter((w) => w.id !== id)
      const activeWorkspaceId =
        s.activeWorkspaceId === id ? (workspaces[0]?.id ?? null) : s.activeWorkspaceId
      return { workspaces, activeWorkspaceId }
    })
  },

  closeAllWorkspaces: () => {
    for (const id of get().workspaces.map((w) => w.id)) get().deleteWorkspace(id)
  },

  detachWorkspace: (id) => {
    const worktreeIds = (get().worktreesByWorkspace[id] ?? []).map((w) => w.id)
    const detachedTabs = get().tabsByWorkspace[id] ?? []
    set((s) => {
      const workspaces = s.workspaces.filter((w) => w.id !== id)
      const activeWorkspaceId =
        s.activeWorkspaceId === id ? (workspaces[0]?.id ?? null) : s.activeWorkspaceId
      const tabsByWorkspace = { ...s.tabsByWorkspace }
      const groupsByWorkspace = { ...s.groupsByWorkspace }
      const layoutByWorkspace = { ...s.layoutByWorkspace }
      const activeGroupIdByWorkspace = { ...s.activeGroupIdByWorkspace }
      const worktreesByWorkspace = { ...s.worktreesByWorkspace }
      delete tabsByWorkspace[id]
      delete groupsByWorkspace[id]
      delete layoutByWorkspace[id]
      delete activeGroupIdByWorkspace[id]
      delete worktreesByWorkspace[id]
      return {
        workspaces,
        activeWorkspaceId,
        tabsByWorkspace,
        groupsByWorkspace,
        layoutByWorkspace,
        activeGroupIdByWorkspace,
        worktreesByWorkspace
      }
    })
    get().clearWorktreeFiles(worktreeIds)
    get().forgetTabs(detachedTabs)
  },

  setActiveWorkspace: (id) => {
    if (get().worktreeBusy) return
    if (id) get().clearWorkspaceAlert(id)
    set({ activeWorkspaceId: id })
  },

  moveWorkspace: (id, beforeId) => {
    if (id === beforeId) return
    set((s) => {
      const moving = s.workspaces.find((w) => w.id === id)
      if (!moving) return {}
      const rest = s.workspaces.filter((w) => w.id !== id)
      const at = beforeId ? rest.findIndex((w) => w.id === beforeId) : -1
      const workspaces = at < 0 ? [...rest, moving] : [...rest.slice(0, at), moving, ...rest.slice(at)]
      if (workspaces.every((w, i) => w === s.workspaces[i])) return {}
      return { workspaces }
    })
  },

  buildWindowSession: (opts) => {
    const s = get()
    const session: WindowSession = {
      workspace: {
        workspaces: s.workspaces,
        activeWorkspaceId: s.activeWorkspaceId,
        worktreesByWorkspace: s.worktreesByWorkspace,
        tabsByWorkspace: s.tabsByWorkspace,
        groupsByWorkspace: s.groupsByWorkspace,
        layoutByWorkspace: s.layoutByWorkspace,
        activeGroupIdByWorkspace: s.activeGroupIdByWorkspace,
        exitedPtyIds: s.exitedPtyIds
      },
      files: {
        viewerFileByTab: s.viewerFileByTab,
        markdownViewByTab: s.markdownViewByTab,
        selectedFileByWorktree: s.selectedFileByWorktree,
        expandedDirsByWorktree: s.expandedDirsByWorktree,
        blameEnabledByPath: s.blameEnabledByPath,
        draftsByPath: s.draftsByPath,
        draftMetaByPath: s.draftMetaByPath,
        liveByTab: s.liveByTab
      }
    }
    if (opts?.terminalSnapshots !== false) {
      session.terminalSnapshots = captureTerminalSnapshotsForPersistence(liveTerminalPtyIds(s))
    }
    return session
  },

  hydrateWindowSession: (session) => {
    seedTerminalSnapshots(session.terminalSnapshots)
    const ws = session.workspace
    set({
      workspaces: ws.workspaces ?? [],
      activeWorkspaceId: ws.activeWorkspaceId ?? null,
      worktreesByWorkspace: ws.worktreesByWorkspace ?? {}
    })
    get().hydrateTabs(ws)
    const f = session.files
    if (f) {
      const tabIds = new Set<string>()
      for (const tabs of Object.values(get().tabsByWorkspace)) for (const t of tabs) tabIds.add(t.id)
      set({
        viewerFileByTab: pickKeys(f.viewerFileByTab ?? {}, tabIds),
        markdownViewByTab: pickKeys(f.markdownViewByTab ?? {}, tabIds),
        selectedFileByWorktree: f.selectedFileByWorktree ?? {},
        expandedDirsByWorktree: f.expandedDirsByWorktree ?? {},
        blameEnabledByPath: f.blameEnabledByPath ?? {},
        draftsByPath: f.draftsByPath ?? {},
        draftMetaByPath: pickKeys(f.draftMetaByPath ?? {}, new Set(Object.keys(f.draftsByPath ?? {}))),
        liveByTab: pickKeys(f.liveByTab ?? {}, tabIds)
      })
    }
    pruneSeededTerminalSnapshots(liveTerminalPtyIds(get()))
    set({ hydrationSucceeded: true })
  }
})

function pickKeys<T>(record: Record<string, T>, keep: ReadonlySet<string>): Record<string, T> {
  const out: Record<string, T> = {}
  for (const [key, value] of Object.entries(record)) if (keep.has(key)) out[key] = value
  return out
}

function liveTerminalPtyIds(s: AppState): Set<string> {
  const ids = new Set<string>()
  for (const tabs of Object.values(s.tabsByWorkspace)) {
    for (const t of tabs) if (t.contentType === 'terminal' && t.ptyId) ids.add(t.ptyId)
  }
  return ids
}
