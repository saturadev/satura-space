import type { MovedWorkspace, WindowSession, WindowSnapshot } from '@shared/api'
import { sameWorkspace, type WorkspaceIdentity } from '@shared/workspace-identity'
import { normWorkspacePath } from '@shared/workspace-topology'
import { loadState, saveState } from './persistence'
import type { WindowBounds } from './window/window-manager'
import { censusTrack } from '@shared/census'

const live = new Map<string, WindowSnapshot>()
censusTrack('session-registry.live', live)

export function emptyWindowSession(): WindowSession {
  return {
    workspace: {
      workspaces: [],
      activeWorkspaceId: null,
      worktreesByWorkspace: {},
      tabsByWorkspace: {},
      groupsByWorkspace: {},
      layoutByWorkspace: {},
      activeGroupIdByWorkspace: {}
    },
    files: {
      viewerFileByTab: {},
      markdownViewByTab: {},
      selectedFileByWorktree: {},
      expandedDirsByWorktree: {},
      blameEnabledByPath: {},
      draftsByPath: {}
    },
    terminalSnapshots: {}
  }
}

function persistLive(): void {
  saveState({ ...loadState(), session: { windows: [...live.values()] } })
}

export function registerSessionWindow(windowId: string, snapshot: WindowSnapshot): void {
  live.set(windowId, snapshot)
  persistLive()
}

export function updateSessionBounds(
  windowId: string,
  bounds: WindowBounds | null,
  maximized: boolean
): void {
  const snap = live.get(windowId)
  if (!snap) return
  if (bounds) snap.bounds = bounds
  snap.maximized = maximized
  persistLive()
}

export function updateSessionMeta(
  windowId: string,
  identity: WorkspaceIdentity | null,
  label: string
): void {
  const snap = live.get(windowId)
  if (!snap) return
  snap.identity = identity
  snap.label = identity ? label : ''
  persistLive()
}

export function putWindowSession(
  windowId: string,
  session: WindowSession,
  meta?: { identity: WorkspaceIdentity | null; label: string } | null
): void {
  const snap = live.get(windowId)
  if (!snap) return
  const terminalSnapshots = session.terminalSnapshots ?? snap.session?.terminalSnapshots ?? {}
  snap.session = { ...session, terminalSnapshots }
  if (meta) {
    snap.identity = meta.identity
    snap.label = meta.label
  }
  persistLive()
}

export function getLiveWindowSession(windowId: string): WindowSession | null {
  const session = live.get(windowId)?.session
  if (!session) return null
  return (session.workspace?.workspaces?.length ?? 0) > 0 ? session : null
}

export function removeSessionWindow(windowId: string): void {
  if (live.delete(windowId)) persistLive()
}

export function takeAllSessionWindows(): WindowSnapshot[] {
  const snaps = [...live.values()]
  live.clear()
  return snaps
}

export function listSessionWindows(): { id: string; snapshot: WindowSnapshot }[] {
  return [...live.entries()].map(([id, snapshot]) => ({ id, snapshot }))
}

export function windowHasWorkspaces(windowId: string): boolean {
  return (live.get(windowId)?.session?.workspace?.workspaces?.length ?? 0) > 0
}

export function windowHasDrafts(windowId: string): boolean {
  return Object.keys(live.get(windowId)?.session?.files?.draftsByPath ?? {}).length > 0
}

const CLAIM_SETTLE_MS = 2000
const claims: { key: string; windowId: string; at: number }[] = []

function workspaceIdentityKey(identity: WorkspaceIdentity): string {
  return `${normWorkspacePath(identity.folderPath)}|${normWorkspacePath(identity.worktreePath)}`
}

function pruneClaims(): void {
  const now = Date.now()
  for (let i = claims.length - 1; i >= 0; i--) {
    if (!live.has(claims[i].windowId) || now - claims[i].at > CLAIM_SETTLE_MS) claims.splice(i, 1)
  }
}

export function claimWorkspaceIdentity(identity: WorkspaceIdentity, windowId: string): void {
  claims.push({ key: workspaceIdentityKey(identity), windowId, at: Date.now() })
}

export function findWorkspaceHolder(
  identity: WorkspaceIdentity,
  exceptWindowId: string | null,
  isEligible: (windowId: string) => boolean
): string | null {
  const key = workspaceIdentityKey(identity)
  pruneClaims()
  for (const c of claims) {
    if (c.key === key && c.windowId !== exceptWindowId && isEligible(c.windowId)) return c.windowId
  }
  for (const [id, snap] of live) {
    if (id === exceptWindowId || !isEligible(id)) continue
    for (const w of snap.session?.workspace?.workspaces ?? []) {
      const wsKey = workspaceIdentityKey({
        folderPath: w.folderPath ?? '',
        worktreePath: w.worktreePath ?? w.folderPath ?? ''
      })
      if (wsKey === key) return id
    }
  }
  return null
}

export function windowWorkspaceIdentities(windowId: string): WorkspaceIdentity[] {
  const workspaces = live.get(windowId)?.session?.workspace?.workspaces ?? []
  return workspaces.map((w) => ({
    folderPath: w.folderPath ?? '',
    worktreePath: w.worktreePath ?? w.folderPath ?? ''
  }))
}

export function sessionHasWorkspaceIdentity(
  windowId: string,
  identity: WorkspaceIdentity
): boolean {
  return windowWorkspaceIdentities(windowId).some((w) => sameWorkspace(w, identity))
}

export function mergeMovedWorkspaceIntoSession(windowId: string, moved: MovedWorkspace): void {
  const snap = live.get(windowId)
  const id = moved?.workspace?.id
  if (!snap || !id) return
  const ws = snap.session.workspace
  if (ws.workspaces.some((w) => w.id === id)) return
  ws.workspaces = [...ws.workspaces, moved.workspace]
  ws.activeWorkspaceId = id
  ws.worktreesByWorkspace = { ...ws.worktreesByWorkspace, [id]: moved.worktrees ?? [] }
  ws.tabsByWorkspace = { ...ws.tabsByWorkspace, [id]: moved.tabs ?? [] }
  ws.groupsByWorkspace = { ...ws.groupsByWorkspace, [id]: moved.groups ?? [] }
  ws.layoutByWorkspace = { ...ws.layoutByWorkspace, [id]: moved.layout }
  ws.activeGroupIdByWorkspace = { ...ws.activeGroupIdByWorkspace, [id]: moved.activeGroupId }
  const files = snap.session.files
  if (files) {
    files.viewerFileByTab = { ...files.viewerFileByTab, ...(moved.viewerFileByTab ?? {}) }
    files.markdownViewByTab = { ...files.markdownViewByTab, ...(moved.markdownViewByTab ?? {}) }
    files.selectedFileByWorktree = {
      ...files.selectedFileByWorktree,
      ...(moved.selectedFileByWorktree ?? {})
    }
    files.expandedDirsByWorktree = {
      ...files.expandedDirsByWorktree,
      ...(moved.expandedDirsByWorktree ?? {})
    }
    files.draftsByPath = { ...files.draftsByPath, ...(moved.draftsByPath ?? {}) }
  }
  snap.session.terminalSnapshots = {
    ...(snap.session.terminalSnapshots ?? {}),
    ...(moved.scrollbackByPty ?? {})
  }
  persistLive()
}

export function hasAnyWorkspaces(): boolean {
  for (const id of live.keys()) if (windowHasWorkspaces(id)) return true
  return false
}

export function hasLiveTerminals(): boolean {
  for (const snapshot of live.values()) {
    const workspace = snapshot.session?.workspace
    if (!workspace) continue
    const exited = new Set(workspace.exitedPtyIds ?? [])
    for (const tabs of Object.values(workspace.tabsByWorkspace ?? {})) {
      for (const tab of tabs) {
        if (tab.contentType === 'terminal' && tab.ptyId && !exited.has(tab.ptyId)) return true
      }
    }
  }
  return false
}
