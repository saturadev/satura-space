export const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico']

const EXT = '[A-Za-z][A-Za-z0-9_]{0,9}'

const ABSOLUTE_START = /^(?:[A-Za-z]:[\\/]|~[\\/]|\/)/

const DELIMITED: { re: RegExp; paren: boolean }[] = [
  { re: new RegExp(`\\(([^()\\n]+?\\.${EXT})\\)`, 'g'), paren: true },
  { re: new RegExp(`"([^"\\n]+?\\.${EXT})"`, 'g'), paren: false },
  { re: new RegExp(`'([^'\\n]+?\\.${EXT})'`, 'g'), paren: false },
  { re: new RegExp('`([^`\\n]+?\\.' + EXT + ')`', 'g'), paren: false }
]

const BARE = new RegExp(
  `(?<![\\w/\\\\.~:@-])((?:[A-Za-z]:[\\\\/]|~[\\\\/]|\\.{1,2}[\\\\/]|/)?[^\\s"'\`()<>\\[\\]{}|,;*?:]*?\\.${EXT})(?::(\\d+)(?::(\\d+))?)?(?![\\w/\\\\-]|\\.\\w)`,
  'g'
)

export interface PathMatch {
  start: number
  end: number
  path: string
  line?: number
  column?: number
}

export function isImagePath(path: string): boolean {
  const ext = path.split('.').at(-1)?.toLowerCase() ?? ''
  return IMAGE_EXTENSIONS.includes(ext)
}

function isPathLike(candidate: string, allowSpaces: boolean, toolArg: boolean): boolean {
  if (!candidate || candidate !== candidate.trim()) return false
  if (candidate.includes('://')) return false
  const absolute = ABSOLUTE_START.test(candidate)
  if (/\s/.test(candidate) && !(allowSpaces && absolute)) return false
  const base = candidate.split(/[\\/]/).at(-1) ?? ''
  if (!/^[^.\s]|^\.[^.]/.test(base) || base.lastIndexOf('.') <= 0) return false
  return toolArg || isImagePath(candidate) || /[\\/]/.test(candidate)
}

function overlaps(a: PathMatch, b: PathMatch): boolean {
  return a.start < b.end && b.start < a.end
}

function findFilePaths(text: string): PathMatch[] {
  const out: PathMatch[] = []
  for (const { re, paren } of DELIMITED) {
    re.lastIndex = 0
    for (let m = re.exec(text); m; m = re.exec(text)) {
      const path = m[1]
      const toolArg = paren && /[A-Za-z]/.test(text[m.index - 1] ?? '')
      if (!isPathLike(path, true, toolArg)) continue
      const start = m.index + 1
      const match = { start, end: start + path.length, path }
      if (!out.some((o) => overlaps(o, match))) out.push(match)
    }
  }
  BARE.lastIndex = 0
  for (let m = BARE.exec(text); m; m = BARE.exec(text)) {
    const path = m[1]
    if (!isPathLike(path, false, false)) continue
    const match: PathMatch = { start: m.index, end: m.index + path.length, path }
    if (m[2]) match.line = Number(m[2])
    if (m[3]) match.column = Number(m[3])
    if (!out.some((o) => overlaps(o, match))) out.push(match)
  }
  return out.sort((a, b) => a.start - b.start)
}

export interface LinkRow {
  text: string
  cells: number[]
  wrapped: boolean
}

export interface RowLink {
  path: string
  line?: number
  column?: number
  start: { row: number; x: number }
  end: { row: number; x: number }
}

const PATH_CHAR = /[^\s"'`<>|]/

function lastNonSpace(text: string): number {
  for (let i = text.length - 1; i >= 0; i--) if (text[i] !== ' ') return i
  return -1
}

function isHardContinuation(prev: LinkRow, cur: LinkRow, cols: number): boolean {
  const last = lastNonSpace(prev.text)
  if (last < 0) return false
  if ((prev.cells[last] ?? 0) < cols - 2) return false
  if (!PATH_CHAR.test(prev.text[last])) return false
  const tail = prev.text.slice(0, last + 1).split(/\s/).at(-1) ?? ''
  if (!/[\\/]/.test(tail)) return false
  const head = cur.text.trimStart()
  return head.length > 0 && PATH_CHAR.test(head[0])
}

interface Joined {
  text: string
  pos: { row: number; x: number }[]
}

function joinSegment(rows: LinkRow[], from: number, to: number): Joined {
  const joined: Joined = { text: '', pos: [] }
  for (let r = from; r <= to; r++) {
    const row = rows[r]
    let begin = 0
    let text = row.text
    if (r > from && !row.wrapped) begin = row.text.length - row.text.trimStart().length
    if (r < to && !rows[r + 1].wrapped) text = row.text.slice(0, lastNonSpace(row.text) + 1)
    for (let i = begin; i < text.length; i++) {
      joined.text += text[i]
      joined.pos.push({ row: r, x: row.cells[i] ?? i })
    }
  }
  return joined
}

function comparePos(a: { row: number; x: number }, b: { row: number; x: number }): number {
  return a.row - b.row || a.x - b.x
}

function toRowLinks(joined: Joined, matches: PathMatch[]): RowLink[] {
  return matches.map((m) => ({
    path: m.path,
    line: m.line,
    column: m.column,
    start: joined.pos[m.start],
    end: joined.pos[m.end - 1]
  }))
}

const URL_RE = /\bhttps?:\/\/[^\s"'`<>()\[\]{}|\\^]+/g

export function findUrls(text: string): PathMatch[] {
  const out: PathMatch[] = []
  URL_RE.lastIndex = 0
  for (let m = URL_RE.exec(text); m; m = URL_RE.exec(text)) {
    const path = m[0].replace(/[.,;:!?'"]+$/, '')
    if (path.length > 10) out.push({ start: m.index, end: m.index + path.length, path })
  }
  return out
}

export function findFileLinksInRows(rows: LinkRow[], cols: number): RowLink[] {
  return findLinksInRows(rows, cols, findFilePaths)
}

export function findUrlLinksInRows(rows: LinkRow[], cols: number): RowLink[] {
  return findLinksInRows(rows, cols, findUrls)
}

function findLinksInRows(rows: LinkRow[], cols: number, find: (text: string) => PathMatch[]): RowLink[] {
  const out: RowLink[] = []
  let from = 0
  while (from < rows.length) {
    let to = from
    while (
      to + 1 < rows.length &&
      (rows[to + 1].wrapped || isHardContinuation(rows[to], rows[to + 1], cols))
    ) {
      to++
    }
    const joined = joinSegment(rows, from, to)
    const matches = find(joined.text)
    const links = toRowLinks(joined, matches)
    out.push(...links)
    if (to > from) {
      for (let r = from; r <= to; r++) {
        const single = joinSegment(rows, r, r)
        for (const link of toRowLinks(single, find(single.text))) {
          const covered = links.some(
            (l) => comparePos(l.start, link.end) <= 0 && comparePos(l.end, link.start) >= 0
          )
          if (!covered) out.push(link)
        }
      }
    }
    from = to + 1
  }
  return out
}

export function resolveTerminalPath(path: string, cwd: string | undefined): string | null {
  if (ABSOLUTE_START.test(path)) return path
  if (!cwd) return null
  const base = cwd.replace(/[\\/]+$/, '')
  const parts = base.split(/[\\/]/)
  for (const seg of path.split(/[\\/]/)) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      if (parts.length > 1) parts.pop()
      continue
    }
    parts.push(seg)
  }
  return parts.join('/') || '/'
}
