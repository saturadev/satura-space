import { useAppStore } from '../../store'
import { showDropFeedback } from '../drop-feedback'
import { pathBasename } from '../path'
import { assetFileName, isUnityAssetPath } from '@shared/unity-assets'
import { assetProjectRoot } from '@shared/scratchpads'
import { renameRefusal } from '../file-explorer/rename-refusal'

function remapPath(p: string, from: string, to: string): string | null {
  if (p === from) return to
  if (p.startsWith(from + '/')) return to + p.slice(from.length)
  return null
}

function remapWorkspacePaths(workspaceId: string, from: string, to: string): void {
  const s = useAppStore.getState()

  const roots = new Map((s.worktreesByWorkspace[workspaceId] ?? []).map((w) => [w.id, w.path.replace(/\\/g, '/').replace(/\/+$/, '')]))
  for (const tab of s.tabsByWorkspace[workspaceId] ?? []) {
    if (tab.contentType === 'tuner' && tab.tuner?.kind === 'file') {
      const base = roots.get(tab.worktreeId)
      const root = base ? assetProjectRoot(base, tab.scratchpadId) : undefined
      const next = root ? remapPath(`${root}/${tab.tuner.id}`, from, to) : null
      const rel = root && next?.startsWith(root + '/') ? next.slice(root.length + 1) : null
      if (rel && isUnityAssetPath(rel)) s.setTabTuner(tab.id, { kind: 'file', id: rel }, assetFileName(rel))
      continue
    }
    if (tab.contentType !== 'file-viewer') continue
    const cur = s.viewerFileByTab[tab.id]
    const next = cur ? remapPath(cur, from, to) : null
    if (next) s.setViewerFile(tab.id, next, { live: s.liveByTab[tab.id] })
  }

  for (const wt of s.worktreesByWorkspace[workspaceId] ?? []) {
    const cur = s.selectedFileByWorktree[wt.id]
    const next = cur ? remapPath(cur, from, to) : null
    if (next) s.openFileInWorktree(wt.id, next)
  }
}

export function remapMovedPath(from: string, to: string): number {
  if (!from || !to || from === to) return 0
  const s = useAppStore.getState()
  for (const workspaceId of Object.keys(s.tabsByWorkspace)) remapWorkspacePaths(workspaceId, from, to)
  let drafts = 0
  for (const p of Object.keys(s.draftsByPath)) {
    const next = remapPath(p, from, to)
    if (!next) continue
    const now = useAppStore.getState()
    const content = now.draftsByPath[p]
    const meta = now.draftMetaByPath[p]
    now.setDraft(p, null)
    now.setDraft(next, content, meta)
    drafts++
  }
  return drafts
}

export async function moveExplorerPath(
  sourcePath: string,
  destPath: string,
  afterRefresh: () => void
): Promise<boolean> {
  const name = pathBasename(sourcePath)
  let result
  try {
    result = await window.api.fs.move(sourcePath, destPath)
  } catch (err) {
    console.error('[fs] move failed:', err)
    showDropFeedback(`Couldn't move “${name}”.`)
    return false
  }
  if (result.ok === false) {
    if (result.code === 'exists') {
      showDropFeedback(`A file named “${name}” already exists in this location.`)
    } else if (result.code === 'locked') {
      showDropFeedback(`Can't move “${name}” — file is in use by another process.`)
    } else {
      showDropFeedback(result.message ?? `Couldn't move “${name}”.`)
    }
    return false
  }
  remapMovedPath(sourcePath, destPath)
  afterRefresh()
  return true
}

export async function renameExplorerPath(sourcePath: string, destPath: string): Promise<{ ok: boolean; message: string | null }> {
  const res = await window.api.fs.rename(sourcePath, destPath)
  const message = renameRefusal(res, pathBasename(sourcePath), pathBasename(destPath))
  if (message) {
    console.info(`[fs] rename of ${sourcePath} to ${destPath} refused: ${message}`)
    showDropFeedback(message)
    return { ok: false, message }
  }
  const drafts = remapMovedPath(sourcePath, destPath)
  console.info(`[fs] renamed ${sourcePath} to ${destPath}${drafts ? `, ${drafts} unsaved edit(s) moved along` : ''}`)
  return { ok: true, message: null }
}
