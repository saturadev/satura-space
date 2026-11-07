
export const QUICK_OPEN_LIMIT = 50

function score(query: string, pathLower: string): number {
  let qi = 0
  let s = 0
  let lastIdx = -1
  for (let ti = 0; ti < pathLower.length && qi < query.length; ti++) {
    if (pathLower[ti] !== query[qi]) continue
    const gap = lastIdx === -1 ? 0 : ti - lastIdx - 1
    s -= gap
    const prev = ti > 0 ? pathLower[ti - 1] : '/'
    if (prev === '/' || prev === '.' || prev === '-' || prev === '_') s += 8
    lastIdx = ti
    qi++
  }
  if (qi < query.length) return -Infinity
  const slash = pathLower.lastIndexOf('/')
  const filename = slash === -1 ? pathLower : pathLower.slice(slash + 1)
  if (filename.includes(query)) s += 30
  s -= pathLower.length * 0.05
  return s
}

export function rankQuickOpenFiles(query: string, files: string[]): string[] {
  const q = query.trim().toLowerCase()
  if (!q) return files.slice(0, QUICK_OPEN_LIMIT)
  const scored: { rel: string; s: number }[] = []
  for (const rel of files) {
    const s = score(q, rel.toLowerCase())
    if (s > -Infinity) scored.push({ rel, s })
  }
  scored.sort((a, b) => b.s - a.s)
  return scored.slice(0, QUICK_OPEN_LIMIT).map((x) => x.rel)
}
