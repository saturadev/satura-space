import type { Tab } from '@shared/types'
import { useAppStore } from '../../store'
import { viewerFileForTab } from './viewer-file'
import { requestChoice, requestConfirm, type ConfirmAnchor, type ConfirmFile } from '../confirm/confirm-store'
import { fileName, projectInfo } from '../tuner/unsaved'
import { parentDir, relativePath } from '../file-explorer/copy-paths'

export type UnsavedFilesReason = 'close' | 'workspace' | 'window'

const TITLES: Record<UnsavedFilesReason, string> = {
  close: 'Save changes before closing?',
  workspace: 'Save changes before closing the workspace?',
  window: 'Save changes before closing the window?'
}

function under(path: string, root: string): boolean {
  const base = root.replace(/[/\\]+$/, '')
  return !!base && (path === base || path.startsWith(base + '/') || path.startsWith(base + '\\'))
}

export function unsavedFilesOf(closing: (tab: Tab) => boolean, roots: string[] = []): string[] {
  const s = useAppStore.getState()
  const kept = new Set<string>()
  const gone = new Set<string>()
  for (const tabs of Object.values(s.tabsByWorkspace)) {
    for (const t of tabs) {
      const file = viewerFileForTab(t, s.viewerFileByTab)
      if (file) (closing(t) ? gone : kept).add(file)
    }
  }
  return Object.keys(s.draftsByPath).filter((f) => !kept.has(f) && (gone.has(f) || roots.some((r) => under(f, r))))
}

export function windowUnsavedFiles(): string[] {
  const s = useAppStore.getState()
  const roots = s.workspaces.flatMap((w) => [w.worktreePath ?? '', ...(s.worktreesByWorkspace[w.id] ?? []).map((t) => t.path)])
  return unsavedFilesOf(() => true, roots.filter(Boolean))
}

export function dropMovedDraft(file: string | null): void {
  if (!file) return
  const s = useAppStore.getState()
  const shown = Object.values(s.tabsByWorkspace).some((tabs) => tabs.some((t) => viewerFileForTab(t, s.viewerFileByTab) === file))
  if (!shown) s.setDraft(file, null)
}

function fileRow(path: string, root: string | null): ConfirmFile {
  const dir = root && under(path, root) ? relativePath(root, parentDir(path)) : parentDir(path).replace(/^\/Users\/[^/]+/, '~')
  return { kind: 'asset', name: fileName(path), note: dir || undefined }
}

export async function resolveUnsavedFiles(
  files: string[],
  reason: UnsavedFilesReason,
  opts: { anchor?: ConfirmAnchor | null; root?: string | null; note?: string } = {}
): Promise<boolean> {
  if (files.length === 0) return true
  const root = opts.root || null
  const lost = files.length === 1 ? `your changes to ${fileName(files[0])} are lost` : `your changes to these ${files.length} files are lost`
  const choice = await requestChoice({
    title: TITLES[reason],
    project: root ? projectInfo(root) : undefined,
    files: files.map((f) => fileRow(f, root)),
    message: `If you don’t save, ${lost}.${opts.note ? ` ${opts.note}` : ''}`,
    confirmLabel: files.length === 1 ? 'Save' : 'Save All',
    secondaryLabel: 'Don’t Save',
    cancelLabel: 'Cancel',
    danger: false,
    anchor: opts.anchor ?? null
  })
  const said = choice === 'confirm' ? 'save' : choice === 'secondary' ? 'don’t save' : 'cancel'
  console.info(`[editor] unsaved ${reason}: ${said} for ${files.length} file(s): ${files.map(fileName).join(', ')}`)
  if (choice === 'cancel') return false
  if (choice === 'secondary') {
    for (const f of files) useAppStore.getState().setDraft(f, null)
    return true
  }
  const errors: string[] = []
  for (const f of files) {
    const content = useAppStore.getState().draftsByPath[f]
    if (content === undefined) continue
    try {
      const expected = useAppStore.getState().draftMetaByPath[f]?.base
      const res = await window.api.fs.writeFile(f, content, expected !== undefined ? { expected } : undefined)
      if (!res.ok) {
        console.info(`[editor] save of ${fileName(f)} refused: it changed on disk since the edit began`)
        errors.push(`${fileName(f)}: it changed on disk since you began editing. Open it to choose which version to keep.`)
        continue
      }
      if (useAppStore.getState().draftsByPath[f] === content) useAppStore.getState().setDraft(f, null)
    } catch (err) {
      errors.push(`${fileName(f)}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  if (errors.length === 0) return true
  await requestConfirm({
    title: 'Could not save',
    message: errors.join('\n'),
    confirmLabel: 'OK',
    hideCancel: true,
    danger: false
  })
  return false
}
