export const CODE_EXTENSIONS = new Set([
  'cs',
  'shader',
  'hlsl',
  'cginc',
  'compute',
  'shadergraph',
  'uss',
  'uxml',
  'asmdef',
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'py',
  'json',
  'yaml',
  'yml',
  'xml',
  'glsl',
  'lua',
  'md',
  'txt'
])

export interface CodeRefResolution {
  ref: string
  status: 'ok' | 'missing' | 'ambiguous'
  rel?: string
  candidates?: string[]
}

export type CodeFileResult =
  | { ok: true; rel: string; path: string; text: string }
  | { ok: false; error: 'missing' | 'ambiguous' | 'too-large'; rel?: string; candidates?: string[] }

export interface CodeRefMatch {
  start: number
  end: number
  path: string
  line?: number
  endLine?: number
}

const EXT = [...CODE_EXTENSIONS].sort((a, b) => b.length - a.length).join('|')
const REF_RE = new RegExp(
  `(?<![\\w/.\\\\-])((?:[A-Za-z]:)?(?:[\\w.@-]+[\\\\/])*[\\w@-][\\w.@-]*\\.(?:${EXT}))(?:(?::(\\d+)(?:-(\\d+))?)|(?:\\((\\d+),\\d+\\)))?(?![\\w/\\\\])`,
  'gi'
)

export function findCodeRefs(text: string): CodeRefMatch[] {
  const out: CodeRefMatch[] = []
  if (!text) return out
  REF_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = REF_RE.exec(text))) {
    const before = text.slice(Math.max(0, m.index - 8), m.index)
    if (/[a-z]+:\/\/\S*$/i.test(before)) continue
    const line = m[2] ?? m[4]
    out.push({
      start: m.index,
      end: m.index + m[0].length,
      path: m[1].replace(/\\/g, '/'),
      line: line ? Number(line) : undefined,
      endLine: m[3] ? Number(m[3]) : undefined
    })
  }
  return out
}
