export function isHotReloadGuardableFile(rootPath: string, filePath: string): boolean {
  if (!filePath.toLowerCase().endsWith('.cs')) return false
  const file = filePath.replace(/\\/g, '/')
  const root = (rootPath || '').replace(/\\/g, '/').replace(/\/+$/, '')
  if (!root || !file.toLowerCase().startsWith(root.toLowerCase() + '/')) return false
  const segments = file
    .slice(root.length)
    .replace(/^\/+/, '')
    .split('/')
  if (segments[0] !== 'Assets' && segments[0] !== 'Packages') return false
  if (segments.some((s) => s === 'Editor' || s.startsWith('.') || s.endsWith('~'))) return false
  return true
}
