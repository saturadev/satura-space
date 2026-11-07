import { createWriteStream, existsSync, promises as fsp, statSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { gzipSync } from 'node:zlib'
import { basename, dirname, join, resolve } from 'node:path'
import { app } from 'electron'
import { EXPORT_WARN_BYTES, exportMediaType, type ReportExportPayload, type ReportExportResult } from '@shared/report-export'
import { assetChunk, CHUNK_BYTES, dataScript, exportData, htmlHead, htmlTail, needsMarkdown, type ExportMedia } from './export-html'

function runtimeDir(): string {
  return resolve(__dirname, '../report-export')
}

function appDir(): string {
  return resolve(__dirname, '../..')
}

async function newestSource(dir: string): Promise<number> {
  let newest = 0
  const walk = async (d: string): Promise<void> => {
    for (const e of await fsp.readdir(d, { withFileTypes: true }).catch(() => [])) {
      const p = join(d, e.name)
      if (e.isDirectory()) {
        if (e.name !== 'node_modules') await walk(p)
      } else if (/\.(tsx?|css)$/.test(e.name)) newest = Math.max(newest, statSync(p).mtimeMs)
    }
  }
  await walk(dir)
  return newest
}

let building: Promise<void> | null = null

async function buildRuntime(): Promise<void> {
  const dir = appDir()
  const vite = join(dir, 'node_modules', 'vite', 'bin', 'vite.js')
  const config = join(dir, 'vite.report-export.config.ts')
  if (!existsSync(vite) || !existsSync(config)) throw new Error('The report export runtime is missing from this build.')
  for (const mode of ['production', 'lite']) await buildMode(dir, vite, config, mode)
}

async function buildMode(dir: string, vite: string, config: string, mode: string): Promise<void> {
  await new Promise<void>((done, fail) => {
    const child = spawn(process.execPath, [vite, 'build', '-c', config, '--mode', mode], {
      cwd: dir,
      env: { ...process.env, NODE_ENV: 'production', ELECTRON_RUN_AS_NODE: '1', SATURA_REPORT_EXPORT_OUT: runtimeDir() },
      stdio: ['ignore', 'ignore', 'pipe']
    })
    let err = ''
    child.stderr.on('data', (d: Buffer) => {
      err = (err + d.toString()).slice(-4000)
    })
    child.on('error', fail)
    child.on('exit', (code) => (code === 0 ? done() : fail(new Error(`Building the export runtime failed (${code}): ${err.trim().split('\n').slice(-6).join('\n')}`))))
  })
}

async function ensureRuntime(lite: boolean): Promise<{ js: string; css: string }> {
  const name = lite ? 'runtime-lite' : 'runtime'
  const js = join(runtimeDir(), `${name}.js`)
  const css = join(runtimeDir(), `${name}.css`)
  const lastBuilt = join(runtimeDir(), 'runtime-lite.js')
  if (!app.isPackaged) {
    const built = existsSync(js) && existsSync(css) && existsSync(lastBuilt) ? Math.min(statSync(join(runtimeDir(), 'runtime.js')).mtimeMs, statSync(lastBuilt).mtimeMs) : 0
    const src = await newestSource(join(appDir(), 'src', 'renderer', 'src'))
    const shared = await newestSource(join(appDir(), 'src', 'shared'))
    if (!built || Math.max(src, shared) > built) {
      building ??= buildRuntime().finally(() => {
        building = null
      })
      await building
    }
  }
  const [jsBytes, cssBytes] = await Promise.all([fsp.readFile(js), fsp.readFile(css)])
  const pack = (b: Buffer): string => gzipSync(b, { level: 9 }).toString('base64')
  return { js: pack(jsBytes), css: pack(cssBytes) }
}

async function mediaOf(paths: string[]): Promise<ExportMedia[]> {
  const out: ExportMedia[] = []
  const seen = new Set<string>()
  for (const path of paths) {
    if (seen.has(path)) continue
    seen.add(path)
    const type = exportMediaType(path)
    if (!type) continue
    const info = await fsp.stat(path).catch(() => null)
    if (info?.isFile()) out.push({ path, type, size: info.size })
  }
  return out
}

function mb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)} MB`
}

async function writeAll(out: string, parts: AsyncIterable<string>): Promise<number> {
  await fsp.mkdir(dirname(out), { recursive: true })
  const tmp = `${out}.${process.pid}.part`
  const stream = createWriteStream(tmp)
  let bytes = 0
  try {
    for await (const part of parts) {
      bytes += Buffer.byteLength(part)
      if (!stream.write(part)) await new Promise<void>((r) => stream.once('drain', () => r()))
    }
    await new Promise<void>((done, fail) => {
      stream.once('error', fail)
      stream.end(() => done())
    })
    await fsp.rename(tmp, out)
  } catch (e) {
    stream.destroy()
    await fsp.rm(tmp, { force: true })
    throw e
  }
  return bytes
}

async function* assetParts(media: ExportMedia[]): AsyncIterable<string> {
  for (const [id, m] of media.entries()) {
    const fh = await fsp.open(m.path, 'r')
    try {
      const buf = Buffer.alloc(CHUNK_BYTES)
      let k = 0
      for (let pos = 0; pos < m.size || k === 0; pos += CHUNK_BYTES) {
        const { bytesRead } = await fh.read(buf, 0, Math.min(CHUNK_BYTES, m.size - pos), pos)
        yield assetChunk(id, k++, buf.subarray(0, bytesRead).toString('base64'))
        if (bytesRead === 0) break
      }
    } finally {
      await fh.close()
    }
  }
}

export async function writeReportExport(out: string, payload: ReportExportPayload): Promise<ReportExportResult> {
  try {
    if (!out || !payload?.pages?.length) return { ok: false, error: 'Nothing to export.' }
    const runtime = await ensureRuntime(!needsMarkdown(payload.pages))
    const media = await mediaOf(payload.media ?? [])
    const data = exportData(payload, media, Date.now())
    const mediaBytes = media.reduce((n, m) => n + m.size, 0)
    async function* parts(): AsyncIterable<string> {
      yield htmlHead(data.title, runtime.css)
      yield dataScript(data)
      yield* assetParts(media)
      yield htmlTail(runtime.js)
    }
    let bytes: number
    try {
      bytes = await writeAll(out, parts())
    } catch (e) {
      const code = (e as NodeJS.ErrnoException)?.code
      if (code === 'ENOENT' || code === 'EACCES' || code === 'EPERM' || code === 'EROFS' || code === 'ENOTDIR' || code === 'EISDIR') {
        return { ok: false, error: `Couldn't save the report to ${out}: ${code === 'ENOENT' ? "its folder can't be created" : code === 'EISDIR' ? 'that path is a folder' : 'no permission to write there'}. Pass out as a file path in a folder you can write to.` }
      }
      throw e
    }
    const warnings: string[] = []
    if (bytes > EXPORT_WARN_BYTES) warnings.push(`The file is ${mb(bytes)}, mostly embedded media (${mb(mediaBytes)}). Large pages open slowly.`)
    const broken = payload.pages.filter((p) => p.error && !p.code).map((p) => basename(dirname(p.file)))
    if (broken.length) warnings.push(`Some linked reports have errors and show them instead: ${broken.join(', ')}`)
    console.log(`[report-export] ${out}: ${payload.pages.length} page(s), ${media.length} media file(s), ${mb(bytes)}`)
    return { ok: true, file: out, bytes, pages: payload.pages.length, media: media.length, mediaBytes, warnings }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
