import { promises as fsp } from 'node:fs'
import { dirname, extname } from 'node:path'
import { protocol } from 'electron'
import { REPORT_SCHEME, isHtmlPage, reportPathFromUrl } from '@shared/report-url'
import { fileSize, serveRange } from '../media-protocol'
import { insideAnyRoot, openScope, type OpenScope } from '../open-roots'

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.ogv': 'video/ogg',
  '.mkv': 'video/x-matroska',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf'
}

const NO_STORE = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }

const SCROLLBAR_CSS =
  '<style data-satura-scrollbar>' +
  '::-webkit-scrollbar{width:8px;height:8px;background:transparent}' +
  '::-webkit-scrollbar-button{display:none}' +
  '::-webkit-scrollbar-track,::-webkit-scrollbar-corner{background:transparent}' +
  '::-webkit-scrollbar-thumb{background-color:rgba(140,140,140,.3);background-clip:padding-box;border:2px solid transparent;border-radius:999px}' +
  '::-webkit-scrollbar-thumb:vertical{min-height:28px}::-webkit-scrollbar-thumb:horizontal{min-width:28px}' +
  ':hover::-webkit-scrollbar-thumb{background-color:rgba(140,140,140,.45)}' +
  '::-webkit-scrollbar-thumb:hover{background-color:rgba(160,160,160,.7)}' +
  '::-webkit-scrollbar-thumb:active{background-color:rgba(180,180,180,.85)}' +
  '</style>'

export function withScrollbarCss(html: string): string {
  const head = /<head[^>]*>/i.exec(html)
  if (head) return html.slice(0, head.index + head[0].length) + SCROLLBAR_CSS + html.slice(head.index + head[0].length)
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html)
  if (doctype) return doctype[0] + SCROLLBAR_CSS + html.slice(doctype[0].length)
  return SCROLLBAR_CSS + html
}

async function serveFile(file: string, request: Request): Promise<Response> {
  const type = TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream'
  const size = await fileSize(file)
  if (size === null) return new Response('Not found', { status: 404 })
  const rangeHeader = request.headers.get('range')
  if (type.startsWith('text/html') && !rangeHeader) {
    const html = withScrollbarCss(await fsp.readFile(file, 'utf8'))
    return new Response(html, { status: 200, headers: { 'Content-Type': type, ...NO_STORE } })
  }
  return serveRange(file, size, rangeHeader, { 'Content-Type': type, ...NO_STORE })
}

export function reportServable(file: string, scope: OpenScope): boolean {
  const pageDirs = scope.files.filter(isHtmlPage).map((f) => dirname(f))
  return insideAnyRoot(scope.roots, file) || insideAnyRoot(pageDirs, file)
}

export function registerReportProtocol(): void {
  protocol.handle(REPORT_SCHEME, async (request) => {
    const file = reportPathFromUrl(request.url)
    if (!file) return new Response('Not found', { status: 404 })
    if (!reportServable(file, openScope())) {
      console.log(`[report] satura-report refused ${file}: outside the folders open in Satura`)
      return new Response('Not found', { status: 404 })
    }
    return serveFile(file, request)
  })
}
