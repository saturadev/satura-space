
export function toPosixPath(value: string): string {
  return value.replace(/\\/g, '/')
}

export function pathBasename(value: string): string {
  const trimmed = value.replace(/[\\/]+$/g, '')
  if (!trimmed) return ''
  return trimmed.split(/[\\/]/).filter(Boolean).at(-1) ?? ''
}

export function folderWorkspaceName(folderPath: string | undefined): string {
  return pathBasename(folderPath ?? '') || 'Home'
}

export function workspaceTitle(ws: {
  name: string
  folderPath?: string
  worktreePath?: string
}): string {
  const wt = ws.worktreePath
  if (wt && wt !== ws.folderPath) return `${ws.name} – ${pathBasename(wt)}`
  return ws.name
}
