import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { ReportEntry } from '@shared/report-compile'
import { resolveReportTarget } from '@shared/report-link'
import { migrateSessionIndex } from './sessions'

const MAX_REPORTS = 300
const MAX_SOURCE = 1024 * 1024

const LINK_ATTR = /\breport\s*=\s*(?:"([^"]+)"|'([^']+)'|\{\s*(?:"([^"]+)"|'([^']+)'|`([^`$]+)`)\s*\})/g
const LINK_KEY = /["']?\breport["']?\s*:\s*(?:"([^"\n]+)"|'([^'\n]+)'|`([^`$\n]+)`)/g
const LINK_PATH = /["'`]([^"'`\s]*(?:^|\/|\.)report\.tsx)["'`]/gi
const LINK_MD = /\]\(\s*<?([^)\s>]*?(?:^|\/|\.)report\.tsx)>?(?:#[^)\s]*)?\s*\)/gi

export function reportLinks(file: string, source: string): string[] {
  const out = new Set<string>()
  for (const m of source.matchAll(LINK_ATTR)) {
    const target = m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5]
    if (target) out.add(resolveReportTarget(file, target))
  }
  for (const m of source.matchAll(LINK_KEY)) {
    const target = m[1] ?? m[2] ?? m[3]
    if (target && !/^[a-z][a-z0-9+.-]*:/i.test(target)) out.add(resolveReportTarget(file, target))
  }
  for (const m of source.matchAll(LINK_PATH)) out.add(resolveReportTarget(file, m[1]))
  for (const m of source.matchAll(LINK_MD)) {
    let target = m[1]
    try {
      target = decodeURIComponent(target)
    } catch {
      continue
    }
    if (!/^[a-z][a-z0-9+.-]*:/i.test(target) || /^[A-Za-z]:[\\/]/.test(target)) out.add(resolveReportTarget(file, target))
  }
  out.delete(resolveReportTarget(file, file))
  return [...out]
}

function attr(src: string, name: string): string {
  const re = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|\\{\\s*(?:"([^"]*)"|'([^']*)'|\`([^\`$]*)\`)\\s*\\})`)
  const m = re.exec(src)
  if (!m) return ''
  return (m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5] ?? '').replace(/\s+/g, ' ').trim()
}

export function reportHeader(source: string): { title: string; status: string; subtitle: string; session: string } {
  const at = source.search(/<Report\b/)
  if (at < 0) return { title: '', status: '', subtitle: '', session: '' }
  const rest = source.slice(at, at + 4000)
  const close = rest.search(/["'}\s]>\s*(\n|$)/)
  const head = close > 0 ? rest.slice(0, close + 1) : rest
  return { title: attr(head, 'title'), status: attr(head, 'status'), subtitle: attr(head, 'subtitle'), session: attr(head, 'session') }
}

const MAX_TEXT = 64 * 1024
const STRING_LIT = /"((?:[^"\\\n]|\\.){2,})"|'((?:[^'\\\n]|\\.){2,})'|`((?:[^`\\]|\\.){2,})`/g
const JSX_TEXT = />([^<>{}]*[\p{L}\p{N}][^<>{}]*)</gu

export function reportSearchText(source: string): string {
  const body = source.replace(/^\s*import\b[^\n]*$/gm, '')
  const parts: string[] = []
  for (const m of body.matchAll(STRING_LIT)) parts.push(m[1] ?? m[2] ?? m[3] ?? '')
  for (const m of body.matchAll(JSX_TEXT)) parts.push(m[1])
  return parts
    .join(' ')
    .replace(/\\n/g, ' ')
    .replace(/\$\{[^}]*\}/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TEXT)
}

async function reportFiles(dir: string, depth: number, out: string[]): Promise<void> {
  if (out.length >= MAX_REPORTS) return
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const e of entries) {
    if (out.length >= MAX_REPORTS) return
    const p = join(dir, e.name)
    if (e.isFile() && /^(report|.+\.report)\.tsx$/i.test(e.name)) out.push(p)
    else if (e.isDirectory() && depth > 0 && !e.name.startsWith('.') && e.name !== 'node_modules') await reportFiles(p, depth - 1, out)
  }
}

export async function listReports(root: string): Promise<ReportEntry[]> {
  const base = join(root, '.sspace', 'reports')
  const files: string[] = []
  await migrateSessionIndex(base).catch(() => undefined)
  await reportFiles(base, 2, files)
  const rows = await Promise.all(
    files.map(async (file): Promise<ReportEntry | null> => {
      const info = await stat(file).catch(() => null)
      if (!info) return null
      const source = await readFile(file, 'utf8').then((s) => s.slice(0, MAX_SOURCE)).catch(() => '')
      const head = reportHeader(source)
      const rel = file.slice(base.length + 1).replace(/\\/g, '/')
      const name = rel.replace(/\/?(report|[^/]+\.report)\.tsx$/i, (_m, f: string) => (f.toLowerCase() === 'report' ? '' : `/${f.replace(/\.report$/i, '')}`)).replace(/^\//, '')
      return { file, name: name || rel, title: head.title, status: head.status, subtitle: head.subtitle, mtimeMs: info.mtimeMs, links: reportLinks(file, source), text: reportSearchText(source), session: head.session || null }
    })
  )
  const list = rows.filter((r): r is ReportEntry => !!r)
  const norm = (p: string): string => p.replace(/\\/g, '/')
  const known = new Map(list.map((r) => [norm(r.file), r.file]))
  for (const r of list) r.links = r.links.map((l) => known.get(norm(l))).filter((l): l is string => !!l && l !== r.file)
  return list.sort((a, b) => b.mtimeMs - a.mtimeMs)
}
