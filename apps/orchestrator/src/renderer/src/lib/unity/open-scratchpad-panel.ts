import { useAppStore } from '../../store'
import { IS_PRIMARY_WINDOW } from '../window-role'
import { toPosixPath } from '../path'
import { debugLog } from '@shared/debug-log'

function samePath(a: string, b: string): boolean {
  const norm = (p: string): string => toPosixPath(p).replace(/\/+$/, '')
  return norm(a) === norm(b)
}

export function openScratchpadPanel(req: { projectPath: string; id: string }): boolean {
  if (!IS_PRIMARY_WINDOW) return false
  const s = useAppStore.getState()
  const order = [
    ...(s.activeWorkspaceId ? [s.activeWorkspaceId] : []),
    ...Object.keys(s.worktreesByWorkspace).filter((id) => id !== s.activeWorkspaceId)
  ]
  for (const workspaceId of order) {
    const wt = (s.worktreesByWorkspace[workspaceId] ?? []).find((w) => samePath(w.path, req.projectPath))
    if (!wt) continue
    const tabs = s.tabsByWorkspace[workspaceId] ?? []
    if (tabs.some((t) => t.contentType === 'unity-scratchpad' && t.worktreeId === wt.id)) return true
    const groupId = s.activeGroupIdByWorkspace[workspaceId] ?? s.ensureWorkbench(workspaceId)
    const tab = s.openTabBeside(workspaceId, groupId, wt.id, {
      label: 'Scratchpads',
      contentType: 'unity-scratchpad',
      scratchpadId: req.id
    })
    useAppStore.getState().pulseAgentPane(tab.ptyId, 'opened')
    debugLog(`[scratchpad] opened the Scratchpads panel for ${req.projectPath}`)
    return true
  }
  return false
}
