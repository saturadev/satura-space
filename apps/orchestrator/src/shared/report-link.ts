export interface ReportLocation {
  video?: string
  frame?: number
  t?: number
}

function posix(path: string): string {
  return path.replace(/\\/g, '/')
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:\//.test(path)
}

function normalize(path: string): string {
  const drive = /^[A-Za-z]:/.exec(path)?.[0] ?? ''
  const rest = path.slice(drive.length)
  const out: string[] = []
  for (const part of rest.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return `${drive}/${out.join('/')}`
}

export function reportDir(file: string): string {
  const p = posix(file)
  return p.slice(0, p.lastIndexOf('/')) || '/'
}

export function resolveReportPath(reportFile: string, src: string): string {
  const s = posix(src.trim())
  if (isAbsolutePath(s)) return normalize(s)
  return normalize(`${reportDir(reportFile)}/${s}`)
}

export function resolveReportTarget(reportFile: string, target: string): string {
  const path = resolveReportPath(reportFile, target)
  return /\.(tsx|html?)$/i.test(path) ? path : `${path}/report.tsx`
}
