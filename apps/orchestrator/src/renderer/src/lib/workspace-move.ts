import type { MovedWorkspace } from '@shared/api'
import { useAppStore } from '../store'
import { captureTerminalSnapshot } from './terminal/serialize'
import { showDropFeedback } from './drop-feedback'
import { dropMovedDraft } from './editor/unsaved-files'

function isUnderRoot(path: string, roots: string[]): boolean {
  return roots.some((root) => {
    const base = root.replace(/[/\\]+$/, '')
    return path === base || path.startsWith(base + '/') || path.startsWith(base + '\\')
  })
}

function pickByKey<V>(src: Record<string, V>, keys: Set<string>): Record<string, V> {
  const out: Record<string, V> = {}
  for (const [k, v] of Object.entries(src)) if (keys.has(k)) out[k] = v
  return out
}

function buildMovedWorkspace(workspaceId: string): MovedWorkspace | null {
  const st = useAppStore.getState()
  const ws = st.workspaces.find((w) => w.id === workspaceId)
  const layout = st.layoutByWorkspace[workspaceId]
  if (!ws || !layout) return null

  const tabs = st.tabsByWorkspace[workspaceId] ?? []
  const groups = st.groupsByWorkspace[workspaceId] ?? []
  const worktrees = st.worktreesByWorkspace[workspaceId] ?? []
  const activeGroupId = st.activeGroupIdByWorkspace[workspaceId] ?? ''

  const scrollbackByPty: Record<string, string> = {}
  for (const t of tabs) {
    if (t.contentType !== 'terminal') continue
    const snap = captureTerminalSnapshot(t.ptyId)
    if (snap) scrollbackByPty[t.ptyId] = snap
  }

  const tabIds = new Set(tabs.map((t) => t.id))
  const worktreeIds = new Set(worktrees.map((w) => w.id))
  const roots = worktrees.map((w) => w.path).filter(Boolean)
  const draftsByPath: Record<string, string> = {}
  for (const [path, content] of Object.entries(st.draftsByPath)) {
    if (isUnderRoot(path, roots)) draftsByPath[path] = content
  }

  return {
    workspace: ws,
    worktrees,
    tabs,
    groups,
    layout,
    activeGroupId,
    scrollbackByPty,
    viewerFileByTab: pickByKey(st.viewerFileByTab, tabIds),
    markdownViewByTab: pickByKey(st.markdownViewByTab, tabIds),
    selectedFileByWorktree: pickByKey(st.selectedFileByWorktree, worktreeIds),
    expandedDirsByWorktree: pickByKey(st.expandedDirsByWorktree, worktreeIds),
    draftsByPath
  }
}

export async function moveWorkspaceToNewWindow(workspaceId: string): Promise<boolean> {
  const moved = buildMovedWorkspace(workspaceId)
  if (!moved) return false
  await window.api.window.moveWorkspaceToNewWindow(moved)
  useAppStore.getState().detachWorkspace(workspaceId)
  for (const path of Object.keys(moved.draftsByPath)) dropMovedDraft(path)
  return true
}

export async function moveWorkspaceToWindow(
  workspaceId: string,
  targetWindowId: string
): Promise<boolean> {
  const moved = buildMovedWorkspace(workspaceId)
  if (!moved) return false
  const result = await window.api.window.moveWorkspaceToWindow(targetWindowId, moved)
  if (!result.ok) {
    showDropFeedback(
      result.reason === 'duplicate'
        ? 'That window already has this workspace'
        : "Couldn't move — that window is no longer available"
    )
    return false
  }
  useAppStore.getState().detachWorkspace(workspaceId)
  for (const path of Object.keys(moved.draftsByPath)) dropMovedDraft(path)
  window.api.window.focus(targetWindowId)
  return true
}
