import type { ResourceWorkspaceInfo } from './api'
import { scratchpadParentProject } from './scratchpads'

export function normWorkspacePath(value: string | undefined | null): string {
  return (value ?? '').replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase()
}

export function workspaceBasename(value: string | undefined | null): string {
  const trimmed = (value ?? '').replace(/[\\/]+$/g, '')
  if (!trimmed) return ''
  return trimmed.split(/[\\/]/).filter(Boolean).at(-1) ?? ''
}

export interface WorkspacePathSets {
  primary: Set<string>
  fallback: Set<string>
}

export function workspacePathSets(
  workspace: { folderPath?: string; worktreePath?: string },
  worktreePaths: (string | undefined | null)[]
): WorkspacePathSets {
  const primary = new Set<string>()
  const cwd = normWorkspacePath(workspace.worktreePath || workspace.folderPath)
  if (cwd) primary.add(cwd)
  for (const p of worktreePaths) {
    const n = normWorkspacePath(p)
    if (n) primary.add(n)
  }
  const fallback = new Set<string>()
  const folder = normWorkspacePath(workspace.folderPath)
  if (folder && !primary.has(folder)) fallback.add(folder)
  return { primary, fallback }
}

export function describeWorkspace(workspace: {
  id: string
  name: string
  folderPath?: string
  worktreePath?: string
}): ResourceWorkspaceInfo {
  const folder = normWorkspacePath(workspace.folderPath)
  const cwd = normWorkspacePath(workspace.worktreePath)
  const isWorktree = !!cwd && !!folder && cwd !== folder
  return {
    id: workspace.id,
    name: workspace.name || 'Workspace',
    isWorktree,
    worktreeLabel: isWorktree ? workspaceBasename(workspace.worktreePath) || null : null
  }
}

export function unityOwnerCandidates(projectPath: string | undefined | null): string[] {
  const p = normWorkspacePath(projectPath)
  if (!p) return []
  const parent = normWorkspacePath(scratchpadParentProject(projectPath ?? ''))
  return parent && parent !== p ? [p, parent] : [p]
}
