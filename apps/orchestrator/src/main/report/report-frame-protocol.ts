import { existsSync, promises as fsp, statSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { basename, extname, isAbsolute, join, resolve } from 'node:path'
import { app, protocol } from 'electron'
import { MEDIA_SCHEME, MEDIA_TYPES, mediaPathFromUrl } from '@shared/media-url'
import { REPORT_FRAME_CSP, REPORT_FRAME_SCHEME, frameDocumentHtml } from '@shared/report-frame'
import type { RemoteMediaInfo } from '@shared/remote-protocol'
import { mediaInfo } from '../remote/media-info'
import { fileSize, serveRange } from '../media-protocol'
import { insideAnyRoot, insideRoot, openScope } from '../open-roots'
import { projectRootOf } from './code-refs'

const RUNTIME_FILES: Record<string, string> = {
  'runtime.js': 'text/javascript; charset=utf-8',
  'runtime.css': 'text/css; charset=utf-8',
  'monaco.js': 'text/javascript; charset=utf-8'
}

const BASE_HEADERS = { 'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'cross-origin' }

const tokens = new Map<string, string>()
const tokenByRoot = new Map<string, string>()

export function runtimeDir(): string {
  return resolve(__dirname, '../report-frame')
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

function buildMode(mode: string): Promise<void> {
  const dir = appDir()
  const vite = join(dir, 'node_modules', 'vite', 'bin', 'vite.js')
  const config = join(dir, 'vite.report-frame.config.ts')
  if (!existsSync(vite) || !existsSync(config)) return Promise.reject(new Error('The report frame runtime is missing from this build.'))
  return new Promise<void>((done, fail) => {
    const child = spawn(process.execPath, [vite, 'build', '-c', config, '--mode', mode], {
      cwd: dir,
      env: { ...process.env, NODE_ENV: 'production', ELECTRON_RUN_AS_NODE: '1', SATURA_REPORT_FRAME_OUT: runtimeDir() },
      stdio: ['ignore', 'ignore', 'pipe']
    })
    let err = ''
    child.stderr.on('data', (d: Buffer) => {
      err = (err + d.toString()).slice(-4000)
    })
    child.on('error', fail)
    child.on('exit', (code) => (code === 0 ? done() : fail(new Error(`Building the report frame failed (${code}): ${err.trim().split('\n').slice(-6).join('\n')}`))))
  })
}

async function ensureRuntime(): Promise<void> {
  if (app.isPackaged) return
  const files = Object.keys(RUNTIME_FILES).map((f) => join(runtimeDir(), f))
  const built = files.every((f) => existsSync(f)) ? Math.min(...files.map((f) => statSync(f).mtimeMs)) : 0
  const src = Math.max(await newestSource(join(appDir(), 'src', 'renderer', 'src')), await newestSource(join(appDir(), 'src', 'shared')))
  if (built && built > src) return
  building ??= (async () => {
    const started = Date.now()
    console.log('[report] building the report frame runtime')
    await buildMode('production')
    await buildMode('monaco')
    console.log(`[report] report frame runtime built in ${Date.now() - started} ms`)
  })().finally(() => {
    building = null
  })
  await building
}

export function frameMediaBase(file: string, root: string): string {
  if (typeof file !== 'string' || !isAbsolute(file)) throw new Error('The report path must be absolute')
  const project = resolve(projectRootOf(file, typeof root === 'string' && root ? root : undefined))
  const scope = openScope()
  if (!insideAnyRoot(scope.roots, project) && !scope.files.some((f) => insideRoot(project, f))) throw new Error(`${project} is not open in Satura`)
  let token = tokenByRoot.get(project)
  if (!token) {
    token = randomBytes(18).toString('base64url')
    tokenByRoot.set(project, token)
    tokens.set(token, project)
  }
  return `${REPORT_FRAME_SCHEME}://media/${token}/`
}

export async function reportStat(file: string, root: string, path: string): Promise<{ exists: boolean; outside?: boolean }> {
  if (typeof file !== 'string' || typeof path !== 'string' || !isAbsolute(file) || !isAbsolute(path)) return { exists: false }
  const project = projectRootOf(file, typeof root === 'string' && root ? root : undefined)
  if (!insideRoot(project, path)) {
    console.log(`[report] refused a stat outside ${project}: ${path}`)
    return { exists: false, outside: true }
  }
  try {
    await fsp.stat(path)
    return { exists: true }
  } catch {
    return { exists: false }
  }
}

const MEDIA_READ_MAX = 4 * 1024 * 1024

function reportMediaFile(file: string, root: string, path: string, pictures = false): { path: string; type: string } {
  if (typeof file !== 'string' || typeof path !== 'string' || !isAbsolute(file) || !isAbsolute(path)) throw new Error('Pass absolute paths')
  const project = resolve(projectRootOf(file, typeof root === 'string' && root ? root : undefined))
  const scope = openScope()
  if (!insideAnyRoot(scope.roots, project) && !scope.files.some((f) => insideRoot(project, f))) throw new Error(`${project} is not open in Satura`)
  if (!insideRoot(project, path)) {
    console.log(`[report] refused a media read outside ${project}: ${path}`)
    throw new Error('That file is outside the project')
  }
  const type = MEDIA_TYPES[extname(path).toLowerCase()]
  if (!type || !(type.startsWith('video/') || type.startsWith('audio/') || (pictures && type.startsWith('image/')))) throw new Error(`${extname(path) || 'That file'} is not a ${pictures ? 'video or picture' : 'video'}`)
  return { path, type }
}

export async function reportSaveMedia(file: string, root: string, path: string, dest: string): Promise<{ file: string; bytes: number }> {
  if (typeof dest !== 'string' || !isAbsolute(dest)) throw new Error('Pick where to save it')
  const m = reportMediaFile(file, root, path, true)
  const st = await fsp.stat(m.path)
  if (!st.isFile()) throw new Error('Not a file')
  await fsp.copyFile(m.path, dest)
  console.log(`[report] saved ${basename(m.path)} (${(st.size / 1e6).toFixed(1)} MB) to ${dest}`)
  return { file: dest, bytes: st.size }
}

export async function reportMediaInfo(file: string, root: string, path: string): Promise<RemoteMediaInfo | null> {
  const m = reportMediaFile(file, root, path)
  const h = await fsp.open(m.path, 'r')
  try {
    const st = await h.stat()
    return st.isFile() ? await mediaInfo(h, st.size, m.type) : null
  } finally {
    await h.close()
  }
}

export async function reportMediaRead(file: string, root: string, path: string, offset: number, length: number): Promise<{ data: Uint8Array; size: number }> {
  const m = reportMediaFile(file, root, path)
  const h = await fsp.open(m.path, 'r')
  try {
    const st = await h.stat()
    if (!st.isFile()) throw new Error('Not a file')
    const from = Math.max(0, Math.min(st.size, Math.floor(Number(offset) || 0)))
    const n = Math.max(0, Math.min(MEDIA_READ_MAX, st.size - from, Math.floor(Number(length) || 0)))
    const data = new Uint8Array(n)
    let got = 0
    while (got < n) {
      const { bytesRead } = await h.read(data, got, n - got, from + got)
      if (!bytesRead) break
      got += bytesRead
    }
    return { data: got === n ? data : data.subarray(0, got), size: st.size }
  } finally {
    await h.close()
  }
}

export function mediaForToken(url: string): string | null {
  const prefix = `${REPORT_FRAME_SCHEME}://media/`
  if (!url.startsWith(prefix)) return null
  const rest = url.slice(prefix.length)
  const slash = rest.indexOf('/')
  if (slash <= 0) return null
  const root = tokens.get(rest.slice(0, slash))
  if (!root) return null
  const path = mediaPathFromUrl(`${MEDIA_SCHEME}://file/${rest.slice(slash + 1)}`)
  if (!path || !insideRoot(root, path)) return null
  return path
}

async function serveMedia(request: Request): Promise<Response> {
  const file = mediaForToken(request.url)
  const type = file ? MEDIA_TYPES[extname(file).toLowerCase()] : undefined
  if (!file || !type) {
    console.log(`[report] report frame media refused ${request.url.slice(0, 200)}`)
    return new Response('Not found', { status: 404, headers: BASE_HEADERS })
  }
  const size = await fileSize(file)
  if (size === null) return new Response('Not found', { status: 404, headers: BASE_HEADERS })
  return serveRange(file, size, request.headers.get('range'), { 'Content-Type': type, ...BASE_HEADERS })
}

async function serveApp(request: Request): Promise<Response> {
  const url = new URL(request.url)
  const name = url.pathname.replace(/^\/+/, '')
  if (name === 'frame.html') {
    let version = app.getVersion()
    if (!app.isPackaged) {
      await ensureRuntime().catch(() => undefined)
      version = String(Math.round(statSync(join(runtimeDir(), 'runtime.js'), { throwIfNoEntry: false })?.mtimeMs ?? 0))
    }
    return new Response(frameDocumentHtml(version), {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': REPORT_FRAME_CSP, 'Cache-Control': 'no-store', ...BASE_HEADERS }
    })
  }
  const type = RUNTIME_FILES[name]
  if (!type) return new Response('Not found', { status: 404, headers: BASE_HEADERS })
  try {
    await ensureRuntime()
  } catch (e) {
    console.log(`[report] ${(e as Error).message}`)
    return new Response('Build failed', { status: 500, headers: BASE_HEADERS })
  }
  const body = await fsp.readFile(join(runtimeDir(), name)).catch(() => null)
  if (!body) return new Response('Not found', { status: 404, headers: BASE_HEADERS })
  return new Response(body, { status: 200, headers: { 'Content-Type': type, 'Cache-Control': app.isPackaged ? 'max-age=31536000' : 'no-store', ...BASE_HEADERS } })
}

export function registerReportFrameProtocol(): void {
  protocol.handle(REPORT_FRAME_SCHEME, (request) => {
    if (request.url.startsWith(`${REPORT_FRAME_SCHEME}://media/`)) return serveMedia(request)
    if (request.url.startsWith(`${REPORT_FRAME_SCHEME}://app/`)) return serveApp(request)
    return new Response('Not found', { status: 404, headers: BASE_HEADERS })
  })
  if (!app.isPackaged) void ensureRuntime().catch((e: unknown) => console.log(`[report] ${(e as Error).message}`))
}
