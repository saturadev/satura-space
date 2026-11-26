import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, extname, join, resolve } from 'node:path'
import type { MainPlugin, PluginPage } from '@satura/plugin'
import { bundle, runtimeBytes, runtimeSources, toolSources } from './bundle'
import { inside, layout, PlayableError, rel, type Layout, type PlayableConfig } from './project'

export interface PackFile {
  name: string
  kind: string
  source: string
  bytes: Buffer
}

export interface Encoded {
  bytes: Buffer
  mime: string
  note?: string
}

export interface PackContext {
  config: PlayableConfig
  layout: Layout
  tool(): Promise<ToolPage>
  log(line: string): void
}

export type Encoder = (file: PackFile, ctx: PackContext) => Promise<Encoded | null>

export const encoders = new Map<string, Encoder>()

export interface ToolPage {
  page: PluginPage
  call<T = unknown>(fn: string, ...args: unknown[]): Promise<T>
}

export interface SizeRow {
  name: string
  kind: string
  source: string
  raw: number
  packed: number
  mime: string
  note?: string
}

export interface PackParts {
  title: string
  background: string
  fontFaces: string
  payload: Record<string, unknown>
  runtimeConfig: Record<string, unknown>
  script: string
}

export interface PackResult {
  path: string
  bytes: number
  budget: number
  overBudget: boolean
  rows: SizeRow[]
  scripts: { file: string; bytes: number }[]
  warnings: string[]
  report: string
}

const MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ttf': 'font/ttf', '.otf': 'font/otf', '.woff': 'font/woff', '.woff2': 'font/woff2', '.json': 'application/json', '.bin': 'application/octet-stream', '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.opus': 'audio/ogg' }

const TOOL_BASE = `const b64 = (bytes) => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = (text) => { const bin = atob(text); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; };
const tools = {};
window.tools = tools;
`

export function dataUrl(mime: string, bytes: Buffer): string {
  return `data:${mime};base64,${bytes.toString('base64')}`
}

function inlineJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/[\u2028\u2029]/g, (c) => '\\u' + c.charCodeAt(0).toString(16))
}

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
}

export function renderHtml(parts: PackParts, options: { head?: string; config?: Record<string, unknown>; bodyEnd?: string } = {}): string {
  const config = { ...parts.runtimeConfig, ...(options.config ?? {}) }
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover">' +
    (options.head ?? '') +
    '<title>' + escapeHtml(parts.title) + '</title>' +
    '<style>' + parts.fontFaces +
    'html,body{margin:0;width:100%;height:100%;overflow:hidden;background:' + parts.background + ';touch-action:none;' +
    '-webkit-user-select:none;user-select:none;-webkit-tap-highlight-color:transparent;-webkit-touch-callout:none}' +
    '#stage{position:absolute;overflow:hidden}#game{position:absolute;left:0;top:0;width:100%;height:100%;display:block;touch-action:none}' +
    '#game3d{position:absolute;left:0;top:0;width:100%;height:100%;display:block;pointer-events:none}' +
    '</style></head><body><div id="stage"><canvas id="game"></canvas></div>' +
    '<script>window.__PLAYABLE__=' + inlineJson({ ...parts.payload, config }) + ';</script>' +
    '<script>(()=>{"use strict";\n' + parts.script + '\n})();</script>' +
    (options.bodyEnd ?? '') +
    '</body></html>'
  )
}

export async function openTool(p: MainPlugin): Promise<ToolPage> {
  const file = join(p.cacheDir, 'tool.html')
  await mkdir(p.cacheDir, { recursive: true })
  const sources = await toolSources(p.sourceDir)
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>playables tool</title></head><body><script>${TOOL_BASE}${Object.values(sources).join('\n')}</script></body></html>`
  if ((await readFile(file, 'utf8').catch(() => '')) !== html) await writeFile(file, html)
  const page = await p.page({ width: 64, height: 64 })
  await page.load(file)
  return {
    page,
    call: (fn, ...args) => page.evaluate(`window.tools.${fn}(...${JSON.stringify(args)})`, 300_000)
  }
}

async function webp(tool: ToolPage, bytes: Buffer, mime: string, quality: number): Promise<Buffer> {
  const r = await tool.call<{ data: string; mime: string }>('image', bytes.toString('base64'), mime, quality, 0, 0)
  if (r.mime !== 'image/webp') throw new PlayableError('This computer could not encode WebP.', 'webp')
  return Buffer.from(r.data, 'base64')
}

export const ENCODED_KINDS = new Set(['atlas', 'texture'])

encoders.set('atlas', async (file, ctx) => {
  const quality = Number(ctx.config.webpQuality ?? 85)
  if (!(quality > 0)) return null
  const out = await webp(await ctx.tool(), file.bytes, MIME[extname(file.name).toLowerCase()] ?? 'image/png', Math.min(100, quality))
  return out.length < file.bytes.length ? { bytes: out, mime: 'image/webp', note: `webp q${quality}` } : null
})

const toolEncoder: Encoder = async (file, ctx) => {
  const tool = await ctx.tool()
  const has = await tool.page.evaluate<boolean>(`typeof window.tools[${JSON.stringify(file.kind)}] === 'function'`)
  if (!has) return null
  const r = await tool.call<{ data: string; mime: string; note?: string } | null>(file.kind, { data: file.bytes.toString('base64'), name: file.name, source: file.source, config: ctx.config })
  if (!r) return null
  return { bytes: Buffer.from(r.data, 'base64'), mime: r.mime, ...(r.note ? { note: r.note } : {}) }
}

export async function buildParts(p: MainPlugin, lay: Layout, log: (line: string) => void): Promise<{ parts: PackParts; rows: SizeRow[]; scripts: { file: string; bytes: number }[]; warnings: string[] }> {
  const config = lay.config
  const text = await readFile(join(lay.build, 'scene.json'), 'utf8').catch(() => null)
  if (text === null) throw new PlayableError('There is no export yet (Playable/build/scene.json is missing). Run playables.export() first.', 'no-export')
  const data = JSON.parse(text) as Record<string, any>
  const warnings: string[] = (data.warnings ?? []).map(String)
  delete data.warnings
  const fileRows: { file: string; bytes: number; kind: string; source: string }[] = data.files ?? []
  delete data.files

  let tool: ToolPage | null = null
  const ctx: PackContext = {
    config,
    layout: lay,
    tool: async () => (tool ??= await openTool(p)),
    log
  }
  const rows: SizeRow[] = []
  const encoded = new Map<string, Encoded & { raw: number }>()
  try {
    for (const f of fileRows) {
      if (f.kind === 'font') continue
      const bytes = await readFile(join(lay.build, f.file))
      const file: PackFile = { name: f.file, kind: f.kind, source: f.source, bytes }
      const enc = encoders.get(f.kind) ?? toolEncoder
      let out: Encoded | null = null
      if (enc) {
        try {
          out = await enc(file, ctx)
        } catch (e) {
          warnings.push(`${f.file}: ${f.kind} encoder failed (${(e as Error).message}), kept the exported file`)
        }
      }
      const result = out ?? { bytes, mime: MIME[extname(f.file).toLowerCase()] ?? 'application/octet-stream' }
      encoded.set(f.file, { ...result, raw: bytes.length })
      rows.push({ name: f.file, kind: f.kind, source: f.source, raw: bytes.length, packed: result.bytes.length, mime: result.mime, ...(result.note ? { note: result.note } : {}) })
    }
  } finally {
    ;(tool as ToolPage | null)?.page.close()
  }

  const atlases = (data.atlases ?? []).map((atlas: { file: string }) => {
    const e = encoded.get(atlas.file)
    if (!e) throw new PlayableError(`The export lists ${atlas.file} but it is not in Playable/build.`, 'export')
    return dataUrl(e.mime, e.bytes)
  })
  const files: Record<string, string> = {}
  for (const [name, e] of encoded) if (!(data.atlases ?? []).some((a: { file: string }) => a.file === name)) files[name] = dataUrl(e.mime, e.bytes)

  const faces: string[] = []
  for (const [index, font] of (data.fonts ?? []).entries() as IterableIterator<[number, { name: string; file?: string; path?: string }]>) {
    if (!font.file) continue
    const override = (config.fontFiles ?? {})[font.name]
    const file = override ? inside(lay.root, join('Playable', override)) : join(lay.build, font.file)
    const bytes = await readFile(file).catch(() => null)
    if (!bytes) throw new PlayableError(`The font file ${override ?? font.file} is missing.`, 'font')
    const ext = extname(file).slice(1).toLowerCase()
    const format = ({ ttf: 'truetype', otf: 'opentype', woff: 'woff', woff2: 'woff2' } as Record<string, string>)[ext] ?? 'truetype'
    faces.push(`@font-face{font-family:"pf${index}";src:url(data:font/${ext};base64,${bytes.toString('base64')}) format("${format}");font-display:block}`)
    rows.push({ name: font.file, kind: 'font', source: override ? `Playable/${override}` : font.path ?? '', raw: bytes.length, packed: bytes.length, mime: `font/${ext}` })
  }

  const runtimeConfig: Record<string, unknown> = {}
  for (const key of ['name', 'title', 'startScene', 'seed', 'stage', 'overrides', 'clipOverrides', 'cta', 'endCard', 'hint', 'storeUrl', 'audio', 'render', 'game']) {
    if (config[key] !== undefined) runtimeConfig[key] = config[key]
  }
  const entry = inside(lay.dir, config.entry || 'game/main.js')
  const sources = await runtimeSources(p.sourceDir)
  const b = await bundle(entry, lay.dir, sources)
  const sceneBytes = Buffer.byteLength(JSON.stringify(data))
  rows.push({ name: 'scene.json', kind: 'scene', source: config.scenes.join(', '), raw: Buffer.byteLength(text), packed: sceneBytes, mime: 'application/json' })
  const runtimeUsed = b.files.filter((f) => f.file.startsWith('runtime/')).reduce((n, f) => n + f.bytes, 0)
  const game = b.files.filter((f) => !f.file.startsWith('runtime/')).reduce((n, f) => n + f.bytes, 0)
  rows.push({ name: 'runtime', kind: 'script', source: `${b.files.filter((f) => f.file.startsWith('runtime/')).length} runtime modules of ${runtimeBytes(sources)} bytes`, raw: runtimeUsed, packed: runtimeUsed, mime: 'text/javascript' })
  rows.push({ name: 'game', kind: 'script', source: `${b.files.filter((f) => !f.file.startsWith('runtime/')).length} game modules`, raw: game, packed: game, mime: 'text/javascript' })

  return {
    parts: {
      title: String(config.title || config.name),
      background: String((config.stage as { background?: string } | undefined)?.background || '#000'),
      fontFaces: faces.join(''),
      payload: { data, atlases, files },
      runtimeConfig,
      script: b.code
    },
    rows,
    scripts: b.files,
    warnings
  }
}

export async function pack(p: MainPlugin, root: string, log: (line: string) => void): Promise<PackResult & { parts: PackParts; layout: Layout }> {
  const lay = await layout(root)
  const { parts, rows, scripts, warnings } = await buildParts(p, lay, log)
  const html = renderHtml(parts)
  const path = join(lay.out, `${lay.config.name}.html`)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, html)
  const bytes = (await stat(path)).size
  const budget = Number(lay.config.budget ?? 5_000_000)
  const base64 = rows.filter((r) => r.kind !== 'scene' && r.kind !== 'script').reduce((n, r) => n + Math.ceil(r.packed / 3) * 4, 0)
  const report = {
    file: rel(root, path),
    bytes,
    budget,
    overBudget: bytes > budget,
    base64Overhead: base64 - rows.filter((r) => r.kind !== 'scene' && r.kind !== 'script').reduce((n, r) => n + r.packed, 0),
    rows: [...rows].sort((a, b) => b.packed - a.packed),
    scripts,
    warnings,
    at: new Date().toISOString()
  }
  const reportPath = join(lay.out, 'report.json')
  await writeFile(reportPath, JSON.stringify(report, null, 2))
  log(`packed ${report.file}: ${bytes} bytes of ${budget}${bytes > budget ? ' (over budget)' : ''}`)
  return { path, bytes, budget, overBudget: bytes > budget, rows: report.rows, scripts, warnings, report: rel(root, reportPath), parts, layout: lay }
}

export async function sizeReport(root: string): Promise<unknown> {
  const lay = await layout(root)
  const text = await readFile(join(lay.out, 'report.json'), 'utf8').catch(() => null)
  if (!text) throw new PlayableError('There is no pack report yet. Run playables.pack() first.', 'no-pack')
  const report = JSON.parse(text) as { bytes: number; budget: number; rows: SizeRow[] }
  const exported = await readFile(join(lay.build, 'scene.json'), 'utf8').then((t) => (JSON.parse(t).files ?? []) as { file: string; source: string }[]).catch(() => [])
  const bySource = new Map<string, number>()
  for (const row of report.rows) {
    for (const src of String(row.source || row.name).split(',')) bySource.set(src.trim(), (bySource.get(src.trim()) ?? 0) + Math.round(row.packed / Math.max(1, String(row.source || row.name).split(',').length)))
  }
  const hints: string[] = []
  const over = report.bytes - report.budget
  if (over > 0) hints.push(`${over} bytes over the budget of ${report.budget}.`)
  for (const row of report.rows.slice(0, 5)) {
    if (row.kind === 'atlas' && row.packed > 300_000) hints.push(`${row.name} is ${row.packed} bytes: lower webpQuality, set spriteScale or a spriteScales rule for the biggest source textures (${row.source.split(',').slice(0, 3).join(', ')}).`)
    if (row.kind === 'audio' && row.packed > 150_000) hints.push(`${row.name} is ${row.packed} bytes: lower audio.bitrate or audio.maxSeconds.`)
    if (row.kind === 'mesh' && row.packed > 200_000) hints.push(`${row.name} is ${row.packed} bytes: set meshes.decimate below 1 for it.`)
    if (row.kind === 'texture' && row.packed > 200_000) hints.push(`${row.name} is ${row.packed} bytes: lower textures.maxSize.`)
    if (row.kind === 'font' && row.packed > 60_000) hints.push(`${row.name} is ${row.packed} bytes: point fontFiles at a subset woff2.`)
  }
  return { ...report, exportedFiles: exported.length, bySource: [...bySource].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([source, bytes]) => ({ source, bytes })), hints }
}

export function playablePath(root: string, lay: Layout, given?: string): string {
  return given ? inside(root, given) : resolve(lay.out, `${lay.config.name}.html`)
}
