import { EXPORT_ASSET_PREFIX, EXPORT_CHUNK, EXPORT_DATA_ID, exportPageId, type ReportExportAsset, type ReportExportData, type ReportExportPayload } from '@shared/report-export'

export const CHUNK_BYTES = (EXPORT_CHUNK / 4) * 3

export interface ExportMedia {
  path: string
  type: string
  size: number
}

export function escapeJson(json: string): string {
  return json.replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export function exportData(payload: ReportExportPayload, media: ExportMedia[], now: number): ReportExportData {
  const taken = new Set<string>()
  const pages = payload.pages.map((p) => ({ ...p, id: exportPageId(p.file, taken) }))
  const assets: Record<string, ReportExportAsset> = {}
  media.forEach((m, id) => {
    assets[m.path] = { id, type: m.type, size: m.size, chunks: Math.max(1, Math.ceil(m.size / CHUNK_BYTES)) }
  })
  const start = pages.find((p) => p.file === payload.file) ?? pages[0]
  return { v: 1, title: start?.title ?? 'Report', root: payload.root, start: payload.file, exportedAt: now, pages, assets }
}

export function needsMarkdown(pages: { code?: string }[]): boolean {
  return pages.some((p) => !!p.code && /\b(Markdown|Code)\b/.test(p.code))
}

const RUNTIME_CSS_ID = 'satura-runtime-css'
const RUNTIME_JS_ID = 'satura-runtime-js'

export function packed(id: string, gzipBase64: string): string {
  return `<script type="application/octet-stream" id="${id}">${gzipBase64}</script>\n`
}

export function htmlHead(title: string, cssGzipBase64: string): string {
  return [
    '<!doctype html>',
    '<html lang="en" data-theme="dark">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="generator" content="Satura Space">',
    `<title>${escapeHtml(title)}</title>`,
    '<style>body{background:#1a1c20;color:#d4d4d8;font-family:system-ui,sans-serif}</style>',
    '</head>',
    '<body>',
    '<div id="root"></div>',
    packed(RUNTIME_CSS_ID, cssGzipBase64)
  ].join('\n')
}

export function dataScript(data: ReportExportData): string {
  return `<script type="application/json" id="${EXPORT_DATA_ID}">${escapeJson(JSON.stringify(data))}</script>\n`
}

export function assetChunk(id: number, k: number, base64: string): string {
  return `<script type="application/octet-stream" id="${EXPORT_ASSET_PREFIX}${id}-${k}">${base64}</script>\n`
}

const LOADER = `(async () => {
  const unpack = async (id) => {
    const bin = atob(document.getElementById(id).textContent.trim())
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text()
  }
  try {
    const [css, js] = await Promise.all([unpack('${RUNTIME_CSS_ID}'), unpack('${RUNTIME_JS_ID}')])
    const style = document.createElement('style')
    style.textContent = css
    document.head.appendChild(style)
    const script = document.createElement('script')
    script.textContent = js
    document.body.appendChild(script)
  } catch (e) {
    document.getElementById('root').textContent = 'This report needs a current browser (Chrome, Edge, Firefox, or Safari 16.4 or later). ' + e
  }
})()`

export function htmlTail(jsGzipBase64: string): string {
  return `${packed(RUNTIME_JS_ID, jsGzipBase64)}<script>${LOADER}</script>\n</body>\n</html>\n`
}
