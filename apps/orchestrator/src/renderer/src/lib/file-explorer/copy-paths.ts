
export function relativePath(rootPath: string, abs: string): string {
  const root = rootPath.replace(/\\/g, '/')
  const p = abs.replace(/\\/g, '/')
  if (root && p.startsWith(root)) {
    return p.slice(root.length).replace(/^\/+/, '')
  }
  return p
}

export function parentDir(abs: string): string {
  return abs.replace(/[\\/]+$/, '').replace(/[\\/][^\\/]*$/, '')
}

export function joinPath(dir: string, name: string): string {
  return `${dir.replace(/\\/g, '/').replace(/\/+$/, '')}/${name}`
}

export function copyAbsolutePath(abs: string): void {
  void window.api.ui.writeClipboardText(abs)
}

export function copyRelativePath(rootPath: string, abs: string): void {
  void window.api.ui.writeClipboardText(relativePath(rootPath, abs))
}
