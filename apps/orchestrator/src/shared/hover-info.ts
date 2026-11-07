export interface GitPathInfo {
  root: string
  branch: string | null
  worktree: boolean
  status?: string | null
}

export interface PathHoverInfo {
  exists: boolean
  isDirectory: boolean
  size?: number
  mtimeMs?: number
  home: string
  git: GitPathInfo | null
}

export interface ReportHoverInfo {
  bytes: number | null
  mtimeMs: number | null
  owner: string | null
  links: number
  nested: number
  home: string
}

export interface PtyHoverInfo {
  cwd: string
  process: string | null
  shell: string | null
  home: string
}

const XY_LABEL: Record<string, string> = {
  M: 'Modified',
  T: 'Type changed',
  A: 'Added',
  D: 'Deleted',
  R: 'Renamed',
  C: 'Copied'
}

export function gitStatusLabel(porcelain: string): string {
  const line = porcelain.split('\n').find((l) => l.length >= 2)
  if (!line) return 'Unchanged'
  const x = line[0]
  const y = line[1]
  if (x === '?' && y === '?') return 'Untracked'
  if (x === '!' && y === '!') return 'Ignored'
  if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')) return 'Merge conflict'
  if (y !== ' ' && XY_LABEL[y]) return x !== ' ' && XY_LABEL[x] ? `${XY_LABEL[y]}, partly staged` : XY_LABEL[y]
  if (XY_LABEL[x]) return `${XY_LABEL[x]}, staged`
  return 'Unchanged'
}

export function tildePath(path: string, home: string): string {
  if (!home) return path
  const h = home.replace(/[\\/]+$/, '')
  if (path === h) return '~'
  if (path.startsWith(`${h}/`) || path.startsWith(`${h}\\`)) return `~${path.slice(h.length)}`
  return path
}

export function relativeTo(path: string, root: string): string | null {
  if (!root) return null
  const r = root.replace(/[\\/]+$/, '')
  if (path.startsWith(`${r}/`) || path.startsWith(`${r}\\`)) return path.slice(r.length + 1)
  return null
}

export function shortenPath(path: string, max = 52): string {
  if (path.length <= max) return path
  const sep = path.includes('/') ? '/' : '\\'
  const parts = path.split(sep)
  if (parts.length <= 3) return `…${path.slice(path.length - max + 1)}`
  const head = parts[0] === '' ? `${sep}${parts[1]}` : parts[0]
  const rest = parts[0] === '' ? parts.slice(2) : parts.slice(1)
  let tail = rest[rest.length - 1]
  for (let i = rest.length - 2; i >= 0; i--) {
    const next = `${rest[i]}${sep}${tail}`
    if (head.length + next.length + 3 > max) break
    tail = next
  }
  const out = `${head}${sep}…${sep}${tail}`
  return out.length <= max ? out : `…${path.slice(path.length - max + 1)}`
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}
