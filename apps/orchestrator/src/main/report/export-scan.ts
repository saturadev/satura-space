import { promises as fsp } from 'node:fs'
import { isReactReport } from '@shared/report-compile'
import { resolveReportPath } from '@shared/report-link'
import { exportFileName, type ReportExportScan } from '@shared/report-export'
import { reportLinks } from './list'

const MEDIA_LITERAL = /["'`]([^"'`\n$]+\.(?:png|jpe?g|gif|webp|avif|svg|mp4|m4v|mov|webm|ogv|mkv|wav|mp3|ogg|m4a))["'`]/gi
const MAX_SOURCE = 2 * 1024 * 1024

async function isFile(path: string): Promise<boolean> {
  return fsp.stat(path).then((s) => s.isFile(), () => false)
}

export async function scanReport(file: string): Promise<ReportExportScan> {
  let source = ''
  try {
    const info = await fsp.stat(file)
    if (info.size <= MAX_SOURCE) source = await fsp.readFile(file, 'utf8')
  } catch {
    return { links: [], media: [] }
  }
  const links: string[] = []
  for (const l of reportLinks(file, source)) if (isReactReport(l) && (await isFile(l))) links.push(l)
  const media = new Set<string>()
  for (const m of source.matchAll(MEDIA_LITERAL)) {
    const path = resolveReportPath(file, m[1])
    if (!media.has(path) && (await isFile(path))) media.add(path)
  }
  return { links, media: [...media] }
}

export { exportFileName }
