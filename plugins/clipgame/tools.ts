import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { applyCliAugmentedPath, resolveCliCommand, type MainPlugin } from '@satura/plugin'

export type Report = (stage: string, text: string, percent?: number) => void

export class ClipError extends Error {
  constructor(
    message: string,
    readonly code: string
  ) {
    super(message)
  }
}

const templateFiles: Record<string, string> = {
  ...import.meta.glob('./video/package.json', { query: '?raw', import: 'default', eager: true }),
  ...import.meta.glob('./video/src/*.{ts,tsx}', { query: '?raw', import: 'default', eager: true })
}

const WIN = process.platform === 'win32'
const MIN_NODE = 18
const KEEP_TAIL = 6000
const MAX_OUT = 32 * 1024 * 1024

export interface RunOptions {
  cwd?: string
  env?: Record<string, string>
  signal?: AbortSignal
  onLine?: (line: string) => void
  shell?: boolean
}

export interface RunResult {
  code: number
  out: string
  err: string
}

export function childEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string') env[k] = v
  applyCliAugmentedPath(env)
  return { ...env, ...extra }
}

export function run(cmd: string, args: string[], o: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    if (o.signal?.aborted) {
      reject(new ClipError('Cancelled.', 'cancelled'))
      return
    }
    const proc = spawn(cmd, args, { cwd: o.cwd, env: childEnv(o.env), shell: o.shell ?? false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    const pending = { out: '', err: '' }
    const feed = (which: 'out' | 'err', chunk: string): void => {
      if (!o.onLine) return
      const parts = (pending[which] + chunk).split(/[\r\n]+/)
      pending[which] = parts.pop() ?? ''
      for (const line of parts) if (line.trim()) o.onLine(line)
    }
    const onAbort = (): void => {
      proc.kill()
    }
    o.signal?.addEventListener('abort', onAbort)
    proc.stdout.setEncoding('utf8')
    proc.stderr.setEncoding('utf8')
    proc.stdout.on('data', (c: string) => {
      if (out.length < MAX_OUT) out += c
      feed('out', c)
    })
    proc.stderr.on('data', (c: string) => {
      err = (err + c).slice(-KEEP_TAIL)
      feed('err', c)
    })
    proc.on('error', (e: NodeJS.ErrnoException) => {
      o.signal?.removeEventListener('abort', onAbort)
      reject(new ClipError(e.code === 'ENOENT' ? `${cmd} was not found.` : e.message, e.code === 'ENOENT' ? 'missing' : 'spawn'))
    })
    proc.on('close', (code) => {
      o.signal?.removeEventListener('abort', onAbort)
      if (o.signal?.aborted) reject(new ClipError('Cancelled.', 'cancelled'))
      else resolve({ code: code ?? 1, out, err })
    })
  })
}

export interface NodeTools {
  node: string
  npm: string
}

export async function nodeTools(): Promise<NodeTools> {
  const node = resolveCliCommand('node')
  let major = 0
  try {
    const r = await run(node, ['-v'])
    major = Number(/^v(\d+)/.exec(r.out.trim())?.[1] ?? 0)
  } catch {
    major = 0
  }
  if (major < MIN_NODE) {
    const why = major ? `Node.js ${major} is too old.` : 'Satura Space did not find Node.js.'
    throw new ClipError(`${why} Making the video needs Node.js ${MIN_NODE} or newer. Install it from https://nodejs.org, then try again.`, 'no-node')
  }
  return { node, npm: resolveCliCommand('npm') }
}

const YT_BASE = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/'

function ytAsset(): string {
  if (process.platform === 'darwin') return 'yt-dlp_macos'
  if (WIN) return process.arch === 'ia32' ? 'yt-dlp_x86.exe' : 'yt-dlp.exe'
  return process.arch === 'arm64' ? 'yt-dlp_linux_aarch64' : 'yt-dlp_linux'
}

async function download(url: string, ua: string, signal: AbortSignal | undefined, onProgress?: (done: number, total: number) => void): Promise<Buffer> {
  let res: Response
  try {
    res = await fetch(url, { headers: { 'User-Agent': ua }, signal })
  } catch (e) {
    if (signal?.aborted) throw new ClipError('Cancelled.', 'cancelled')
    throw new ClipError(`Could not reach ${new URL(url).host}. Check the internet connection and try again.`, 'network')
  }
  if (!res.ok || !res.body) throw new ClipError(`${new URL(url).host} answered ${res.status} for ${new URL(url).pathname.split('/').slice(-1)[0]}.`, 'network')
  const total = Number(res.headers.get('content-length')) || 0
  const chunks: Buffer[] = []
  let done = 0
  const reader = res.body.getReader()
  try {
    for (;;) {
      const { value, done: end } = await reader.read()
      if (end) break
      chunks.push(Buffer.from(value))
      done += value.length
      onProgress?.(done, total)
    }
  } catch (e) {
    if (signal?.aborted) throw new ClipError('Cancelled.', 'cancelled')
    throw new ClipError(`The download of ${new URL(url).pathname.split('/').slice(-1)[0]} broke off. Try again.`, 'network')
  }
  return Buffer.concat(chunks)
}

export function toolsPaths(p: MainPlugin): { ytdlp: string; cache: string } {
  return { ytdlp: join(p.cacheDir, 'tools', WIN ? 'yt-dlp.exe' : 'yt-dlp'), cache: join(p.cacheDir, 'ytdlp-cache') }
}

let lastRefresh = 0
let ytLoading: Promise<string> | null = null

export function ensureYtDlp(p: MainPlugin, report: Report, signal: AbortSignal | undefined, refresh = false): Promise<string> {
  if (ytLoading) return ytLoading
  const path = toolsPaths(p).ytdlp
  const load = async (): Promise<string> => {
    if (existsSync(path) && !refresh) return path
    if (refresh && Date.now() - lastRefresh < 10 * 60_000) return path
    const asset = ytAsset()
    const ua = `SaturaSpace/${p.appVersion}`
    report('tools', refresh ? 'Updating the video downloader…' : 'Downloading the video downloader (first time only)…', 0)
    const bin = await download(YT_BASE + asset, ua, signal, (done, total) => report('tools', refresh ? 'Updating the video downloader…' : 'Downloading the video downloader (first time only)…', total ? Math.round((done / total) * 100) : undefined))
    const sums = (await download(YT_BASE + 'SHA2-256SUMS', ua, signal)).toString('utf8')
    const want = sums.split('\n').map((l) => l.trim().split(/\s+/)).find((c) => c[1] === asset)?.[0]
    const got = createHash('sha256').update(bin).digest('hex')
    if (!want || want.toLowerCase() !== got) throw new ClipError('The downloaded video downloader did not match its published checksum, so it was not used. Try again.', 'tools')
    await mkdir(join(p.cacheDir, 'tools'), { recursive: true })
    const tmp = `${path}.part`
    await writeFile(tmp, bin)
    await chmod(tmp, 0o755)
    await rename(tmp, path)
    lastRefresh = Date.now()
    p.log(`yt-dlp ${asset} installed (${bin.length} bytes)`)
    return path
  }
  ytLoading = load().finally(() => {
    ytLoading = null
  })
  return ytLoading
}

export interface Remotion {
  dir: string
  cli: string
  node: string
  ffmpegDir: string
  ffmpeg: string
  ffprobe: string
  ytFfmpeg: string
  env: Record<string, string>
}

function templateHash(): string {
  const h = createHash('sha256')
  for (const k of Object.keys(templateFiles).sort()) h.update(k).update(templateFiles[k])
  return h.digest('hex').slice(0, 10)
}

async function compositorDir(dir: string): Promise<string | null> {
  const rem = join(dir, 'node_modules', '@remotion')
  const names = await readdir(rem).catch(() => [] as string[])
  const hit = names.find((n) => n.startsWith('compositor-'))
  return hit ? join(rem, hit) : null
}

async function describe(dir: string, node: string): Promise<Remotion | null> {
  if (!existsSync(join(dir, '.ready'))) return null
  const ffmpegDir = await compositorDir(dir)
  const cli = join(dir, 'node_modules', '@remotion', 'cli', 'remotion-cli.js')
  if (!ffmpegDir || !existsSync(cli)) return null
  const ext = WIN ? '.exe' : ''
  const libs: Record<string, string> = process.platform === 'darwin' ? { DYLD_LIBRARY_PATH: ffmpegDir } : WIN ? {} : { LD_LIBRARY_PATH: ffmpegDir }
  let ytFfmpeg = ffmpegDir
  if (!WIN) {
    ytFfmpeg = join(dir, 'bin')
    await mkdir(ytFfmpeg, { recursive: true })
    const libVar = process.platform === 'darwin' ? 'DYLD_LIBRARY_PATH' : 'LD_LIBRARY_PATH'
    for (const name of ['ffmpeg', 'ffprobe']) {
      const file = join(ytFfmpeg, name)
      await writeFile(file, `#!/bin/sh\nexport ${libVar}='${ffmpegDir.replace(/'/g, `'\\''`)}'\nexec '${join(ffmpegDir, name).replace(/'/g, `'\\''`)}' "$@"\n`)
      await chmod(file, 0o755)
    }
  }
  return { dir, cli, node, ffmpegDir, ffmpeg: join(ffmpegDir, `ffmpeg${ext}`), ffprobe: join(ffmpegDir, `ffprobe${ext}`), ytFfmpeg, env: libs }
}

let remotionLoading: Promise<Remotion> | null = null

export function ensureRemotion(p: MainPlugin, report: Report, signal: AbortSignal | undefined): Promise<Remotion> {
  if (remotionLoading) return remotionLoading
  const load = async (): Promise<Remotion> => {
    const tools = await nodeTools()
    const root = join(p.cacheDir, 'remotion')
    const dir = join(root, templateHash())
    const ready = await describe(dir, tools.node)
    if (ready) return ready
    const msg = 'Setting up the video tools (first time only)…'
    report('tools', msg)
    await rm(dir, { recursive: true, force: true })
    await mkdir(join(dir, 'src'), { recursive: true })
    for (const [k, text] of Object.entries(templateFiles)) await writeFile(join(dir, k.replace(/^\.\/video\//, '')), text)
    const tail: string[] = []
    const onLine = (line: string): void => {
      tail.push(line)
      if (tail.length > 12) tail.shift()
    }
    const install = await run(tools.npm, ['install', '--no-audit', '--no-fund', '--no-progress', '--loglevel=error'], { cwd: dir, signal, onLine, shell: WIN })
    if (install.code !== 0) throw new ClipError(`Installing the video tools failed (npm exit ${install.code}). ${tail.slice(-4).join(' ')}`.trim(), 'install')
    report('tools', 'Downloading the video renderer browser (first time only)…')
    const cli = join(dir, 'node_modules', '@remotion', 'cli', 'remotion-cli.js')
    const browser = await run(tools.node, [cli, 'browser', 'ensure'], { cwd: dir, signal, onLine: (line) => report('tools', 'Downloading the video renderer browser (first time only)…', Number(/(\d+)%/.exec(line)?.[1]) || undefined) })
    if (browser.code !== 0) throw new ClipError(`Downloading the renderer browser failed. ${browser.err.trim().split('\n').slice(-2).join(' ')}`.trim(), 'install')
    await writeFile(join(dir, '.ready'), new Date().toISOString())
    for (const old of await readdir(root).catch(() => [] as string[])) if (join(root, old) !== dir) await rm(join(root, old), { recursive: true, force: true })
    const found = await describe(dir, tools.node)
    if (!found) throw new ClipError('The video tools installed but ffmpeg was not among them.', 'install')
    p.log(`remotion tools ready in ${dir}`)
    return found
  }
  remotionLoading = load().finally(() => {
    remotionLoading = null
  })
  return remotionLoading
}

export async function toolStatus(p: MainPlugin): Promise<Record<string, unknown>> {
  const paths = toolsPaths(p)
  let node: string | null = null
  try {
    const r = await run(resolveCliCommand('node'), ['-v'])
    node = r.out.trim()
  } catch {
    node = null
  }
  const root = join(p.cacheDir, 'remotion')
  const dirs = await readdir(root).catch(() => [] as string[])
  const ready = dirs.filter((d) => existsSync(join(root, d, '.ready')))
  const yt = existsSync(paths.ytdlp) ? ((await stat(paths.ytdlp)).mtime.toISOString()) : null
  return { node, ytdlp: yt ? { path: paths.ytdlp, installed: yt } : null, remotion: ready.length ? { dir: join(root, ready[0]) } : null, template: templateHash() }
}

export async function readText(path: string): Promise<string | null> {
  return readFile(path, 'utf8').catch(() => null)
}
