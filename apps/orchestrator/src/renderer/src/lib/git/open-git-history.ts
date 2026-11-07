import { useAppStore } from '../../store'
import { GIT_TAB_LABEL } from '../tab-label'
import { postGitCommitRequest, postGitHistoryRequest } from './history-request'

function openGitTab(workspaceId: string, worktreeId: string): string | undefined {
  const s = useAppStore.getState()
  const worktrees = s.worktreesByWorkspace[workspaceId] ?? []
  const projectPath = worktrees.find((w) => w.id === worktreeId)?.path
  if (!projectPath) return undefined
  const pathOf = (id: string): string | undefined => worktrees.find((w) => w.id === id)?.path
  const tabs = s.tabsByWorkspace[workspaceId] ?? []
  const existing = tabs.find((t) => t.contentType === 'git-scm' && pathOf(t.worktreeId) === projectPath)
  if (existing) s.activateTab(existing.id)
  else {
    const groupId = s.activeGroupIdByWorkspace[workspaceId] ?? s.ensureWorkbench(workspaceId)
    s.openTabBeside(workspaceId, groupId, worktreeId, { label: GIT_TAB_LABEL, contentType: 'git-scm' })
  }
  return projectPath
}

export function openGitHistory(workspaceId: string, worktreeId: string, absPaths: string[]): void {
  if (absPaths.length === 0) return
  const projectPath = openGitTab(workspaceId, worktreeId)
  if (projectPath) postGitHistoryRequest(projectPath, absPaths)
}

export function openGitCommitFromTab(tabId: string, hash: string): void {
  const s = useAppStore.getState()
  for (const [workspaceId, tabs] of Object.entries(s.tabsByWorkspace)) {
    const tab = tabs.find((t) => t.id === tabId)
    if (!tab) continue
    const projectPath = openGitTab(workspaceId, tab.worktreeId)
    if (projectPath) postGitCommitRequest(projectPath, hash)
    return
  }
}
