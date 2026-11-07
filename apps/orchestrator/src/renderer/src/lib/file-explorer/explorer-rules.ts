import type { DirEntry } from '@shared/api'
import type { DirState } from '../../store/slices/files'
import { opensInSatura, unityAssetKind } from '@shared/unity-assets'
import { scratchpadOfRel } from '@shared/scratchpads'
import { isUnityYamlAsset } from '../../components/workbench/explorer-icons'
import { parentDir, relativePath } from './copy-paths'

export const HIDDEN_DIRS = new Set(['.sspace/worktrees', '.sspace/agent-worktrees'])

function isPathIgnored(ignored: Set<string>, rel: string): boolean {
  if (ignored.size === 0 || !rel) return false
  if (ignored.has(rel)) return true
  let candidate = rel
  for (;;) {
    const idx = candidate.lastIndexOf('/')
    if (idx <= 0) return false
    candidate = candidate.slice(0, idx)
    if (ignored.has(candidate)) return true
  }
}

export function isTreeIgnored(ignored: Set<string>, rel: string, isDir: boolean): boolean {
  const pad = scratchpadOfRel(rel)
  if (!pad || (!pad.inner && !isDir)) return isPathIgnored(ignored, rel)
  return !!pad.inner && isPathIgnored(ignored, pad.inner)
}

export function projectRel(rootPath: string, path: string): string {
  const rel = relativePath(rootPath, path)
  return scratchpadOfRel(rel)?.inner || rel
}

export function isAlwaysDim(name: string): boolean {
  return name === '.git' || name === '.DS_Store'
}

export function isMetaFile(name: string): boolean {
  return /\.meta$/i.test(name)
}

const BINARY_EXTS = new Set(['dll', 'so', 'dylib', 'a', 'lib', 'bundle', 'jar', 'aar', 'zip', 'pdb', 'mdb'])

export function opensAsUnityAsset(node: DirEntry, rootPath: string, childrenByDir: Record<string, DirState>): boolean {
  if (opensInSatura(node.name)) return false
  if (isUnityYamlAsset(node.name)) return true
  if (unityAssetKind(node.name) || BINARY_EXTS.has(fileExt(node.name))) return false
  if (!/^(Assets|Packages)\//.test(projectRel(rootPath, node.path))) return false
  const kids = childrenByDir[parentDir(node.path)]
  return Array.isArray(kids) && kids.some((k) => k.path === `${node.path}.meta`)
}

export function opensInSaturaWithMeta(node: DirEntry, rootPath: string, childrenByDir: Record<string, DirState>): boolean {
  if (!opensInSatura(node.name) || !/^(Assets|Packages)\//.test(projectRel(rootPath, node.path))) return false
  const kids = childrenByDir[parentDir(node.path)]
  return Array.isArray(kids) && kids.some((k) => k.path === `${node.path}.meta`)
}

export function fileExt(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : ''
}

export function sortByDim(entries: DirEntry[], isDimmed: (e: DirEntry) => boolean): DirEntry[] {
  return entries
    .map((e) => ({ e, dim: isDimmed(e) }))
    .sort((a, b) => Number(a.dim) - Number(b.dim))
    .map((x) => x.e)
}
