import { useAppStore } from '../../store'
import { assetProjectRoot } from '@shared/scratchpads'

export function closeViewersForDeletedPath(workspaceId: string, deletedPath: string): void {
  const s = useAppStore.getState()
  const under = (p: string | undefined | null): boolean =>
    !!p && (p === deletedPath || p.startsWith(deletedPath + '/'))

  const roots = new Map((s.worktreesByWorkspace[workspaceId] ?? []).map((w) => [w.id, w.path.replace(/\\/g, '/').replace(/\/+$/, '')]))
  for (const tab of s.tabsByWorkspace[workspaceId] ?? []) {
    const asset = tab.contentType === 'tuner' && tab.tuner?.kind === 'file' ? `${assetProjectRoot(roots.get(tab.worktreeId) ?? '', tab.scratchpadId)}/${tab.tuner.id}` : null
    if ((tab.contentType === 'file-viewer' && under(s.viewerFileByTab[tab.id])) || (asset && under(asset))) {
      s.closeTab(tab.id)
    }
  }

  for (const p of Object.keys(s.draftsByPath)) {
    if (under(p)) s.setDraft(p, null)
  }

  for (const wt of s.worktreesByWorkspace[workspaceId] ?? []) {
    if (under(s.selectedFileByWorktree[wt.id])) s.openFileInWorktree(wt.id, '')
  }
}
