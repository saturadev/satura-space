import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

export const EXCLUDED_DIRS = new Set([
  '.git',
  'node_modules',
  'Library',
  'Temp',
  'Obj',
  'obj',
  'Build',
  'Logs',
  '.gradle',
  '.idea',
  'dist',
  'out',
  'bin'
])

function onIncludedLineage(rel: string, prefixes: string[]): boolean {
  return prefixes.some((p) => p === rel || rel.startsWith(`${p}/`) || p.startsWith(`${rel}/`))
}

export async function* walkFiles(
  root: string,
  forceIncludePrefixes: string[] = []
): AsyncGenerator<{ abs: string; rel: string }> {
  const stack: { dir: string; prefix: string }[] = [{ dir: root, prefix: '' }]
  while (stack.length) {
    const { dir, prefix } = stack.pop()!
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue
      const rel = prefix ? `${prefix}/${e.name}` : e.name
      if (e.isDirectory()) {
        if (rel === '.sspace/worktrees' || rel === '.sspace/agent-worktrees') continue
        if (EXCLUDED_DIRS.has(e.name) && !onIncludedLineage(rel, forceIncludePrefixes)) continue
        stack.push({ dir: join(dir, e.name), prefix: rel })
      } else if (e.isFile()) {
        yield { abs: join(dir, e.name), rel }
      }
    }
  }
}
