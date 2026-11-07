import { joinPath } from './scm-resource'

const MAX_DEPTH = 64

export function parentDir(p: string): string | null {
  const trimmed = p.replace(/[\\/]+$/, '')
  const i = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  if (i < 0) return null
  if (i === 0) return trimmed.length > 1 ? trimmed.slice(0, 1) : null
  const parent = trimmed.slice(0, i)
  return /^[A-Za-z]:$/.test(parent) ? `${parent}${trimmed[i]}` : parent
}

export async function findScmRoot(
  projectPath: string,
  exists: (path: string) => Promise<boolean>
): Promise<string | null> {
  let dir: string | null = projectPath
  for (let depth = 0; dir && depth < MAX_DEPTH; depth++) {
    if (await exists(joinPath(dir, '.git'))) return dir
    dir = parentDir(dir)
  }
  return null
}
