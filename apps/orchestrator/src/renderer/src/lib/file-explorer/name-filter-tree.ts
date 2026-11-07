import type { DirEntry } from '@shared/api'
import { joinPath } from './copy-paths'

export interface NameFilterNode {
  entry: DirEntry
  children: NameFilterNode[]
}

export interface NameFilterTree {
  roots: NameFilterNode[]
  dirs: string[]
}

export function buildNameFilterTree(rootPath: string, relPaths: string[]): NameFilterTree {
  const roots: NameFilterNode[] = []
  const byPath = new Map<string, NameFilterNode>()
  const dirs = new Set<string>()

  for (const rel of relPaths) {
    const segments = rel.split('/').filter(Boolean)
    if (segments.length === 0) continue
    let siblings = roots
    let abs = rootPath
    for (let i = 0; i < segments.length; i++) {
      const name = segments[i]
      abs = joinPath(abs, name)
      const isDirectory = i < segments.length - 1
      let node = byPath.get(abs)
      if (!node) {
        node = { entry: { name, path: abs, isDirectory }, children: [] }
        byPath.set(abs, node)
        siblings.push(node)
      }
      if (isDirectory) dirs.add(abs)
      siblings = node.children
    }
  }

  sortTree(roots)
  return { roots, dirs: [...dirs] }
}

function sortTree(nodes: NameFilterNode[]): void {
  nodes.sort((a, b) =>
    a.entry.isDirectory === b.entry.isDirectory
      ? a.entry.name.localeCompare(b.entry.name, undefined, { sensitivity: 'base' })
      : a.entry.isDirectory
        ? -1
        : 1
  )
  for (const n of nodes) sortTree(n.children)
}
