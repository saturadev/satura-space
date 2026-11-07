import { createReadStream, promises as fsp } from 'node:fs'
import { extname } from 'node:path'
import { Readable } from 'node:stream'
import { protocol } from 'electron'
import { MEDIA_SCHEME, MEDIA_TYPES, mediaPathFromUrl } from '@shared/media-url'
import { REPORT_SCHEME } from '@shared/report-url'
import { REPORT_FRAME_SCHEME } from '@shared/report-frame'
import { insideAnyRoot, openScope, sameFile, type OpenScope } from './open-roots'

protocol.registerSchemesAsPrivileged([
  { scheme: MEDIA_SCHEME, privileges: { stream: true, supportFetchAPI: true, standard: true, secure: true } },
  { scheme: REPORT_SCHEME, privileges: { stream: true, standard: true, secure: true } },
  { scheme: REPORT_FRAME_SCHEME, privileges: { stream: true, standard: true, secure: true, codeCache: true } }
])

function parseRange(header: string | null, size: number): { start: number; end: number } | null {
  const m = header ? /^bytes=(\d*)-(\d*)$/.exec(header.trim()) : null
  if (!m) return null
  let start = m[1] ? Number(m[1]) : NaN
  let end = m[2] ? Number(m[2]) : size - 1
  if (Number.isNaN(start)) {
    start = Math.max(0, size - end)
    end = size - 1
  }
  end = Math.min(end, size - 1)
  if (start > end || start >= size) return null
  return { start, end }
}

export async function fileSize(file: string): Promise<number | null> {
  try {
    const stat = await fsp.stat(file)
    return stat.isFile() ? stat.size : null
  } catch {
    return null
  }
}

export function serveRange(
  file: string,
  size: number,
  rangeHeader: string | null,
  extra: Record<string, string>
): Response {
  const range = parseRange(rangeHeader, size)
  if (rangeHeader && !range) {
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } })
  }
  const start = range?.start ?? 0
  const end = range?.end ?? size - 1
  const body = Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream<Uint8Array>
  const headers: Record<string, string> = {
    'Content-Length': String(end - start + 1),
    'Accept-Ranges': 'bytes',
    ...extra
  }
  if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`
  return new Response(body, { status: range ? 206 : 200, headers })
}

export function mediaServable(file: string, scope: OpenScope): boolean {
  return insideAnyRoot(scope.roots, file) || scope.files.some((f) => sameFile(f, file))
}

export function registerMediaProtocol(): void {
  protocol.handle(MEDIA_SCHEME, async (request) => {
    const file = mediaPathFromUrl(request.url)
    const type = file ? MEDIA_TYPES[extname(file).toLowerCase()] : undefined
    if (!file || !type) return new Response('Not found', { status: 404 })
    if (!mediaServable(file, openScope())) {
      console.log(`[media] satura-media refused ${file}: outside the folders and files open in Satura`)
      return new Response('Not found', { status: 404 })
    }
    const size = await fileSize(file)
    if (size === null) return new Response('Not found', { status: 404 })
    return serveRange(file, size, request.headers.get('range'), { 'Content-Type': type })
  })
}
