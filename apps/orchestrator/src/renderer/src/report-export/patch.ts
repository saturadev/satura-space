export interface PatchLine {
  kind: 'add' | 'del' | 'ctx'
  text: string
  old?: number
  new?: number
}

export interface PatchHunk {
  header: string
  lines: PatchLine[]
}

export interface ParsedPatch {
  hunks: PatchHunk[]
  binary: boolean
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/

export function parsePatch(text: string): ParsedPatch {
  const hunks: PatchHunk[] = []
  let binary = false
  let cur: PatchHunk | null = null
  let a = 0
  let b = 0
  for (const raw of text.split('\n')) {
    const m = HUNK.exec(raw)
    if (m) {
      a = Number(m[1])
      b = Number(m[2])
      cur = { header: raw, lines: [] }
      hunks.push(cur)
      continue
    }
    if (!cur) {
      if (/^Binary files .* differ$/.test(raw) || raw.startsWith('GIT binary patch')) binary = true
      continue
    }
    const c = raw[0]
    if (c === '+') cur.lines.push({ kind: 'add', text: raw.slice(1), new: b++ })
    else if (c === '-') cur.lines.push({ kind: 'del', text: raw.slice(1), old: a++ })
    else if (c === ' ') cur.lines.push({ kind: 'ctx', text: raw.slice(1), old: a++, new: b++ })
    else if (c === '\\') continue
    else if (raw.startsWith('diff --git')) cur = null
  }
  return { hunks, binary: binary && !hunks.length }
}

export interface SplitRow {
  a?: PatchLine
  b?: PatchLine
}

export function splitRows(h: PatchHunk): SplitRow[] {
  const out: SplitRow[] = []
  let dels: PatchLine[] = []
  let adds: PatchLine[] = []
  const flush = (): void => {
    for (let i = 0; i < Math.max(dels.length, adds.length); i++) out.push({ a: dels[i], b: adds[i] })
    dels = []
    adds = []
  }
  for (const l of h.lines) {
    if (l.kind === 'del') {
      if (adds.length) flush()
      dels.push(l)
    } else if (l.kind === 'add') adds.push(l)
    else {
      flush()
      out.push({ a: l, b: l })
    }
  }
  flush()
  return out
}
