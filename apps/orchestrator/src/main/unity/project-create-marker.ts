import { existsSync } from 'node:fs'
import { join } from 'node:path'

export function isFinishedProject(target: string): boolean {
  return existsSync(join(target, 'ProjectSettings', 'ProjectVersion.txt'))
}

export function shouldRemovePartialProject(m: { existed?: unknown; target?: unknown }, finished: (target: string) => boolean = isFinishedProject): boolean {
  if (m.existed !== false || typeof m.target !== 'string' || !m.target) return false
  if (!existsSync(m.target)) return false
  return !finished(m.target)
}
