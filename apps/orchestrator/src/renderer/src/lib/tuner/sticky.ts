export const STICKY_MAX_ROWS = 7
export const STICKY_MAX_RATIO = 0.4

export interface StickyTree {
  parent: Int32Array
  end: Int32Array
}

export interface StickyRow {
  index: number
  position: number
}

export interface StickyView {
  scrollTop: number
  height: number
  rowHeight: number
  padTop: number
}

export function stickyTree(rows: readonly { key: string; parent: string | null }[]): StickyTree {
  const n = rows.length
  const parent = new Int32Array(n).fill(-1)
  const end = new Int32Array(n)
  const at = new Map<string, number>()
  for (let i = 0; i < n; i++) {
    at.set(rows[i].key, i)
    end[i] = i
    const p = rows[i].parent
    parent[i] = p == null ? -1 : (at.get(p) ?? -1)
  }
  for (let i = n - 1; i >= 0; i--) {
    const p = parent[i]
    if (p >= 0 && end[i] > end[p]) end[p] = end[i]
  }
  return { parent, end }
}

export function stickyDepth(tree: StickyTree, index: number, max = STICKY_MAX_ROWS): number {
  let n = 0
  for (let p = tree.parent[index]; p >= 0 && n < max; p = tree.parent[p]) n++
  return n
}

function ancestorUnder(tree: StickyTree, node: number, prev: number): number {
  let cur = node
  let p = tree.parent[cur]
  while (p >= 0) {
    if (p === prev) return cur
    cur = p
    p = tree.parent[cur]
  }
  return prev < 0 ? cur : -1
}

export function stickyRows(tree: StickyTree, view: StickyView, max = STICKY_MAX_ROWS): StickyRow[] {
  const count = tree.parent.length
  const { scrollTop, height, rowHeight: h, padTop } = view
  if (count === 0 || height <= 0 || scrollTop <= padTop) return []
  const top = (i: number): number => padTop + i * h
  const nodeAt = (y: number): number => {
    const i = Math.floor((scrollTop + y - padTop) / h)
    return i < 0 || i >= count ? -1 : i
  }
  const place = (node: number, stacked: number): StickyRow => {
    const bottom = top(tree.end[node]) + h - scrollTop
    const position = stacked + h > bottom && stacked <= bottom ? bottom - h : stacked
    return { index: node, position }
  }
  const next = (under: number, prev: number, stacked: number): StickyRow | null => {
    const node = ancestorUnder(tree, under, prev)
    if (node < 0) return null
    if (node === under) {
      if (tree.end[node] <= node) return null
      if (Math.abs(scrollTop - (top(node) - stacked)) < 0.5) return null
    }
    return place(node, stacked)
  }
  const out: StickyRow[] = []
  let under = nodeAt(0)
  if (under < 0) return out
  let stacked = 0
  let row = next(under, -1, stacked)
  while (row) {
    out.push(row)
    stacked += h
    if (out.length >= max) break
    under = nodeAt(row.position + h)
    if (under < 0) break
    row = next(under, row.index, stacked)
  }
  const limit = height * STICKY_MAX_RATIO
  for (let i = 0; i < out.length; i++) if (out[i].position + h > limit) return out.slice(0, i)
  return out
}

export function sameSticky(a: readonly StickyRow[], b: readonly StickyRow[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i].index !== b[i].index || a[i].position !== b[i].position) return false
  return true
}
