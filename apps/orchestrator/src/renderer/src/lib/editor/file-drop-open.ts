import { isPlayableAudio, isPlayableVideo } from '@shared/media-url'
import { useAppStore } from '../../store'
import { toPosixPath } from '../path'
import { openFileInWorkbench } from './open-file'
import { debugLog } from '@shared/debug-log'

export async function viewerSupports(file: string): Promise<boolean> {
  if (isPlayableVideo(file) || isPlayableAudio(file)) {
    const info = await window.api.fs.statPath(file).catch(() => null)
    return !!info?.exists && info.isFile
  }
  const res = await window.api.fs.readFile(file).catch(() => null)
  if (!res || res.notFound || res.tooLarge) return false
  return !!res.isImage || !res.isBinary
}

function ownerWorkspace(file: string): string | null {
  const s = useAppStore.getState()
  for (const [workspaceId, wts] of Object.entries(s.worktreesByWorkspace)) {
    for (const wt of wts) {
      const root = toPosixPath(wt.path).replace(/\/+$/, '')
      if (root && (file === root || file.startsWith(`${root}/`))) return workspaceId
    }
  }
  return null
}

export async function openDroppedFiles(paths: string[]): Promise<void> {
  for (const raw of paths) {
    const file = toPosixPath(raw)
    if (!(await viewerSupports(file))) {
      debugLog(`[file-drop] skip ${file}: not viewable`)
      continue
    }
    const owner = ownerWorkspace(file)
    const ok = openFileInWorkbench({ file, preview: false })
    debugLog(`[file-drop] ${ok ? 'open' : 'fail'} ${file} ${owner ? `workspace=${owner}` : 'external'}`)
  }
}

export function installFileDropOpen(): () => void {
  const onDrop = (e: DragEvent): void => {
    const files = Array.from(e.dataTransfer?.files ?? [])
    if (!files.length) return
    e.preventDefault()
    const paths = files.map((f) => window.api.ui.getPathForFile(f)).filter(Boolean)
    if (paths.length) void openDroppedFiles(paths)
  }
  window.addEventListener('drop', onDrop)
  return () => window.removeEventListener('drop', onDrop)
}
