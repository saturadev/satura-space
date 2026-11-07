import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

export function computeDaemonBuildId(appVersion: string, entryPath: string): string {
  let hash = 'nohash'
  try {
    hash = createHash('sha256').update(readFileSync(entryPath)).digest('hex').slice(0, 12)
  } catch {
  }
  return `${appVersion || 'unknown'}+${hash}`
}
