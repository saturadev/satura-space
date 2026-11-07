import { createHash } from 'node:crypto'
import { isAbsolute, relative } from 'node:path'
import type { ReportDiagnostic } from '@shared/report-compile'

const KIT_VERSION = '1'

export function displayPath(file: string, root?: string): string {
  if (root && isAbsolute(root)) {
    const rel = relative(root, file)
    if (rel && !rel.startsWith('..') && !isAbsolute(rel)) return rel.replace(/\\/g, '/')
  }
  return file.replace(/\\/g, '/')
}

export function hashOf(text: string): string {
  return createHash('sha1').update(KIT_VERSION).update('\0').update(text).digest('hex').slice(0, 16)
}

export function formatDiagnostics(list: ReportDiagnostic[]): string {
  return list
    .map((d) => `${d.file}${d.line ? `:${d.line}:${d.column}` : ''} - ${d.code ? `${d.code}: ` : ''}${d.message}`)
    .join('\n')
}
