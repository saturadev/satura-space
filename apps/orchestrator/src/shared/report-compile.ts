export interface ReportDiagnostic {
  file: string
  line: number
  column: number
  code: string
  message: string
}

export interface ReportCompileResult {
  ok: boolean
  file: string
  stamp: string
  code?: string
  map?: string
  diagnostics: ReportDiagnostic[]
  text: string
  ms: number
  mtimeMs?: number
}

export interface ReportEntry {
  file: string
  name: string
  title: string
  status: string
  subtitle: string
  mtimeMs: number
  links: string[]
  text: string
  session?: string | null
}

export function reportFallbackTitle(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/')
  const base = parts[parts.length - 1] ?? ''
  const own = base.toLowerCase() === 'report.tsx' ? parts[parts.length - 2] ?? base : base.replace(/\.report\.tsx$/i, '')
  return own.replace(/[-_]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase())
}

export function isReactReport(path: string): boolean {
  return /(^|[\\/.])report\.tsx$/i.test(path)
}
