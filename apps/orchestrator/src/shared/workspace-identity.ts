
export interface WorkspaceIdentity {
  folderPath: string
  worktreePath: string
}

export function sameWorkspace(
  a: WorkspaceIdentity | null | undefined,
  b: WorkspaceIdentity | null | undefined
): boolean {
  return !!a && !!b && a.folderPath === b.folderPath && a.worktreePath === b.worktreePath
}
