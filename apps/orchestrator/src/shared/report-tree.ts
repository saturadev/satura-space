import type { ReportEntry } from './report-compile'

export interface ReportNode {
  r: ReportEntry
  children: ReportNode[]
  latest: number
}

export function buildReportTree(list: ReportEntry[]): ReportNode[] {
  const nodes = new Map(list.map((r) => [r.file, { r, children: [] as ReportNode[], latest: r.mtimeMs }]))
  const parent = new Map<string, string>()
  const linksOf = (f: string): string[] => nodes.get(f)?.r.links ?? []
  const isAncestor = (maybe: string, of: string): boolean => {
    let cur: string | undefined = of
    const seen = new Set<string>()
    while (cur && !seen.has(cur)) {
      if (cur === maybe) return true
      seen.add(cur)
      cur = parent.get(cur)
    }
    return false
  }
  const oneWay = (a: string, b: string): boolean => linksOf(a).includes(b) && !linksOf(b).includes(a)
  const reaches = (from: string, to: string): boolean => {
    const seen = new Set<string>([from])
    const stack = [from]
    while (stack.length) {
      const cur = stack.pop() as string
      for (const next of linksOf(cur)) {
        if (!oneWay(cur, next) || seen.has(next)) continue
        if (next === to) return true
        seen.add(next)
        stack.push(next)
      }
    }
    return false
  }
  for (const r of list) {
    const candidates = list.filter((a) => a.file !== r.file && oneWay(a.file, r.file))
    const deepest = candidates.filter((a) => !candidates.some((b) => b !== a && reaches(a.file, b.file) && !reaches(b.file, a.file)))
    const pick = (deepest.length ? deepest : candidates)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .find((a) => !isAncestor(r.file, a.file))
    if (pick) parent.set(r.file, pick.file)
  }
  const roots: ReportNode[] = []
  for (const [file, node] of nodes) {
    const p = parent.get(file)
    const pn = p ? nodes.get(p) : undefined
    if (pn) pn.children.push(node)
    else roots.push(node)
  }
  const settle = (n: ReportNode): number => {
    for (const c of n.children) n.latest = Math.max(n.latest, settle(c))
    n.children.sort((a, b) => b.latest - a.latest)
    return n.latest
  }
  roots.forEach(settle)
  return roots.sort((a, b) => b.latest - a.latest)
}

export function nestedCount(nodes: ReportNode[], file: string): number {
  const all = (n: ReportNode): number => n.children.reduce((sum, c) => sum + 1 + all(c), 0)
  const stack = [...nodes]
  while (stack.length) {
    const n = stack.pop() as ReportNode
    if (n.r.file === file) return all(n)
    stack.push(...n.children)
  }
  return 0
}
