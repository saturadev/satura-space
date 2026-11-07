import { openFileInWorkbench } from './open-file'

export function openFileFromExplorer(
  workspaceId: string,
  worktreeId: string,
  explorerGroupId: string,
  filePath: string,
  opts?: { live?: boolean; preview?: boolean; text?: boolean; asset?: boolean }
): void {
  openFileInWorkbench({
    file: filePath,
    workspaceId,
    worktreeId,
    sourceGroupId: explorerGroupId,
    preview: opts?.preview !== false,
    live: opts?.live,
    text: opts?.text,
    asset: opts?.asset
  })
}
