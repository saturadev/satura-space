import { lstatSync, readlinkSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, parse, relative, resolve } from 'node:path'
import { listSessionWindows } from './session-registry'
import { isInside } from './safe-fs'

export interface OpenScope {
  roots: string[]
  files: string[]
}

function usableRoot(p: unknown): p is string {
  if (typeof p !== 'string' || !p || !isAbsolute(p)) return false
  const r = resolve(p)
  return parse(r).root !== r
}

export function openScope(): OpenScope {
  const roots = new Set<string>()
  const files = new Set<string>()
  for (const { snapshot } of listSessionWindows()) {
    const ws = snapshot.session?.workspace
    for (const w of ws?.workspaces ?? []) {
      if (usableRoot(w.folderPath)) roots.add(resolve(w.folderPath))
      if (usableRoot(w.worktreePath)) roots.add(resolve(w.worktreePath))
    }
    for (const list of Object.values(ws?.worktreesByWorkspace ?? {}))
      for (const t of list ?? []) if (usableRoot(t?.path)) roots.add(resolve(t.path))
    for (const f of Object.values(snapshot.session?.files?.viewerFileByTab ?? {}))
      if (typeof f === 'string' && isAbsolute(f)) files.add(resolve(f))
  }
  return { roots: [...roots], files: [...files] }
}

function present(p: string): boolean {
  try {
    lstatSync(p)
    return true
  } catch {
    return false
  }
}

function realish(p: string, depth = 0): string {
  const full = resolve(p)
  let cur = full
  while (!present(cur)) {
    const up = dirname(cur)
    if (up === cur) return full
    cur = up
  }
  try {
    return join(realpathSync(cur), relative(cur, full))
  } catch {
    if (depth > 8) return full
    try {
      if (lstatSync(cur).isSymbolicLink()) return realish(join(resolve(dirname(cur), readlinkSync(cur)), relative(cur, full)), depth + 1)
    } catch {
    }
    return full
  }
}

export function insideRoot(root: string, path: string): boolean {
  if (!root || typeof path !== 'string' || !isAbsolute(path)) return false
  return isInside(root, realish(path), { allowRoot: true })
}

export function insideAnyRoot(roots: readonly string[], path: string): boolean {
  return roots.some((r) => insideRoot(r, path))
}

export function sameFile(a: string, b: string): boolean {
  return insideRoot(a, b) && insideRoot(b, a)
}

export function scopeAllows(scope: OpenScope, path: string, use: 'read' | 'write' | 'media', mediaDir: string): boolean {
  return (
    insideAnyRoot(scope.roots, path) ||
    (use !== 'write' && scope.files.some((f) => sameFile(f, path))) ||
    (use === 'media' && insideRoot(mediaDir, path))
  )
}
