import type { StateCreator } from 'zustand'
import type { Worktree } from '@shared/types'
import type { AppState } from '../index'
import { uid } from '../../lib/id'

export interface WorktreesSlice {
  worktreesByWorkspace: Record<string, Worktree[]>
  createWorktree: (workspaceId: string, path: string, name?: string) => Worktree
  removeWorktree: (workspaceId: string, worktreeId: string) => void
  removeWorkspaceWorktrees: (workspaceId: string) => void
}

function basename(path: string): string {
  const parts = path.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] || path
}

export const createWorktreesSlice: StateCreator<AppState, [], [], WorktreesSlice> = (set, get) => ({
  worktreesByWorkspace: {},

  createWorktree: (workspaceId, path, name) => {
    const worktree: Worktree = {
      id: uid(),
      workspaceId,
      name: name?.trim() || basename(path),
      path,
      createdAt: Date.now()
    }
    set((s) => ({
      worktreesByWorkspace: {
        ...s.worktreesByWorkspace,
        [workspaceId]: [...(s.worktreesByWorkspace[workspaceId] ?? []), worktree]
      }
    }))
    return worktree
  },

  removeWorktree: (workspaceId, worktreeId) => {
    const remaining = (get().worktreesByWorkspace[workspaceId] ?? []).filter(
      (w) => w.id !== worktreeId
    )
    set((s) => ({
      worktreesByWorkspace: { ...s.worktreesByWorkspace, [workspaceId]: remaining }
    }))
  },

  removeWorkspaceWorktrees: (workspaceId) =>
    set((s) => {
      const next = { ...s.worktreesByWorkspace }
      delete next[workspaceId]
      return { worktreesByWorkspace: next }
    })
})
