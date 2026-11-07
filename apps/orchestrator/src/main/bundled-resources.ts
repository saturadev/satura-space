import { app } from 'electron'
import { join } from 'node:path'

export function resolveResource(...segments: string[]): string {
  const base = app.isPackaged ? process.resourcesPath : join(app.getAppPath(), 'resources')
  return join(base, ...segments)
}

export function repoPackagePath(pkgDir: string): string {
  return join(app.getAppPath(), '..', '..', 'packages', pkgDir)
}
