import { realpath, stat } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'

export type OpenPathResult = 'opened' | 'revealed' | 'missing'

export interface OpenPathPlan {
  action: 'open' | 'reveal' | 'missing'
  resolved: string
  reason: string
}

async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

export async function planOpenPath(path: string): Promise<OpenPathPlan> {
  if (typeof path !== 'string' || !path) return { action: 'missing', resolved: '', reason: 'no path' }
  let resolved: string
  try {
    resolved = await realpath(path)
  } catch {
    return { action: 'missing', resolved: path, reason: 'not found' }
  }
  let info
  try {
    info = await stat(resolved)
  } catch {
    return { action: 'missing', resolved, reason: 'not found' }
  }
  if (!info.isDirectory()) return { action: 'reveal', resolved, reason: 'a file, which the system would open or run with its default app' }
  const ext = extname(basename(resolved))
  if (ext) return { action: 'reveal', resolved, reason: `a ${ext} folder, which the system may launch as an app or package` }
  if (await isDir(join(resolved, 'Contents'))) return { action: 'reveal', resolved, reason: 'a bundle folder (it has Contents/)' }
  return { action: 'open', resolved, reason: 'a plain folder' }
}
