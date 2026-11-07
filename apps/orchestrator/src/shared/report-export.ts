import type { CodeFileResult, CodeRefResolution } from './report-code'
import { reportFallbackTitle } from './report-compile'

export interface ReportExportSnapshot {
  git: Record<string, unknown>
  refs: Record<string, CodeRefResolution>
  code: Record<string, CodeFileResult>
}

export interface ReportExportPage {
  file: string
  title: string
  code?: string
  error?: string
  savedAt?: number
  links: string[]
  snapshot: ReportExportSnapshot
}

export interface ReportExportPayload {
  file: string
  root: string
  pages: ReportExportPage[]
  media: string[]
}

export interface ReportExportScan {
  links: string[]
  media: string[]
}

export type ReportExportResult =
  | { ok: true; file: string; bytes: number; pages: number; media: number; mediaBytes: number; warnings: string[] }
  | { ok: false; error: string }

export interface ReportExportAsset {
  id: number
  type: string
  size: number
  chunks: number
}

export interface ReportExportData {
  v: 1
  title: string
  root: string
  start: string
  exportedAt: number
  pages: (ReportExportPage & { id: string })[]
  assets: Record<string, ReportExportAsset>
}

export const EXPORT_DATA_ID = 'sspace-export-data'
export const EXPORT_ASSET_PREFIX = 'sspace-asset-'
export const EXPORT_CHUNK = 1 << 22
export const EXPORT_WARN_BYTES = 100 * 1024 * 1024

export const EXPORT_MEDIA_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  ogv: 'video/ogg',
  mkv: 'video/x-matroska',
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4'
}

export function exportMediaType(path: string): string | undefined {
  const dot = path.lastIndexOf('.')
  return dot < 0 ? undefined : EXPORT_MEDIA_TYPES[path.slice(dot + 1).toLowerCase()]
}

export function gitCallKey(method: string, args: unknown[]): string {
  return `${method}:${JSON.stringify(args)}`
}

export function emptySnapshot(): ReportExportSnapshot {
  return { git: {}, refs: {}, code: {} }
}

export function exportPageId(file: string, taken: Set<string>): string {
  const parts = file.replace(/\\/g, '/').split('/')
  const base = parts[parts.length - 1] ?? ''
  const own = base.toLowerCase() === 'report.tsx' ? parts[parts.length - 2] ?? 'report' : base.replace(/\.report\.tsx$/i, '')
  const slug = own.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'report'
  let id = slug
  for (let n = 2; taken.has(id); n++) id = `${slug}-${n}`
  taken.add(id)
  return id
}

export function exportFileName(file: string): string {
  const name = reportFallbackTitle(file).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')
  return `${name || 'report'}.html`
}
