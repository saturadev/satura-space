import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, extname, isAbsolute, join } from 'node:path'
import type { RemoteVideoStill } from '@shared/remote-protocol'
import { cacheDir } from './phone-video'
import { AVCONVERT, containerOf, stillWays, videoTools, type StillWay } from './phone-video-tools'
import { stillWithWebCodecs } from './phone-video-web'

interface StillMeta {
  src: string
  size: number
  mtime: number
  width: number
  height: number
  bytes: number
  made: 'WebCodecs' | 'avconvert and WebCodecs'
}

const STILL_MAX = 1080
const HEAD_SECONDS = '0.5'
const STILLS_KEPT = 400
const AT_ONCE = 2
const FAILED_RETRY_MS = 5 * 60_000
const VIDEO_EXTS = new Set(['.mp4', '.m4v', '.mov', '.webm', '.mkv', '.ogv'])
const MADE: Record<StillWay, StillMeta['made']> = { webcodecs: 'WebCodecs', 'avconvert-head-then-webcodecs': 'avconvert and WebCodecs' }
const making = new Map<string, Promise<RemoteVideoStill>>()
const failed = new Map<string, { at: number; why: string }>()
const waiting: (() => void)[] = []
let running = 0
let ready: Promise<string> | null = null

const log = (msg: string): void => console.log(`[phone-video] ${msg}`)
const kb = (n: number): string => `${Math.round(n / 1024)} KB`

function dir(): Promise<string> {
  ready ??= (async () => {
    const d = join(cacheDir(), 'stills')
    await mkdir(d, { recursive: true })
    for (const name of await readdir(d)) if (name.includes('.part.')) await rm(join(d, name), { force: true })
    return d
  })()
  return ready
}

function slot(): Promise<() => void> {
  return new Promise((resolve) => {
    const go = (): void => {
      running++
      resolve(() => {
        running--
        waiting.shift()?.()
      })
    }
    if (running < AT_ONCE) go()
    else waiting.push(go)
  })
}

async function trim(d: string): Promise<void> {
  const names = (await readdir(d)).filter((n) => n.endsWith('.jpg'))
  if (names.length <= STILLS_KEPT) return
  const aged = await Promise.all(names.map(async (n) => ({ n, at: (await stat(join(d, n)).catch(() => null))?.mtimeMs ?? 0 })))
  for (const { n } of aged.sort((a, b) => a.at - b.at).slice(0, names.length - STILLS_KEPT)) {
    await rm(join(d, n), { force: true })
    await rm(join(d, n.replace(/\.jpg$/, '.json')), { force: true })
  }
}

function head(src: string, out: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(AVCONVERT, ['--source', src, '--output', out, '--preset', 'Preset1920x1080', '--duration', HEAD_SECONDS, '--replace'], { stdio: ['ignore', 'ignore', 'pipe'] })
    let tail = ''
    proc.stderr.on('data', (b: Buffer) => (tail = (tail + b.toString()).slice(-300)))
    proc.on('error', reject)
    proc.on('close', (code) => (code === 0 && existsSync(out) ? resolve() : reject(new Error(tail.trim().split('\n').pop() || `avconvert exited with ${code}`))))
  })
}

async function viaAvconvert(src: string, out: string, d: string, key: string): Promise<{ width: number; height: number }> {
  const clip = join(d, `${key}.part.head.mp4`)
  try {
    await head(src, clip)
    return await stillWithWebCodecs(clip, out, STILL_MAX)
  } finally {
    await rm(clip, { force: true })
  }
}

async function make(src: string, size: number, mtime: number, key: string, d: string): Promise<RemoteVideoStill> {
  const release = await slot()
  const out = join(d, `${key}.jpg`)
  const part = join(d, `${key}.part.jpg`)
  const started = Date.now()
  try {
    const ways = stillWays(videoTools(), containerOf(src))
    let made: StillMeta['made'] = 'WebCodecs'
    let dims: { width: number; height: number } | null = null
    for (const [i, way] of ways.entries()) {
      try {
        made = MADE[way]
        dims = way === 'webcodecs' ? await stillWithWebCodecs(src, part, STILL_MAX) : await viaAvconvert(src, part, d, key)
        break
      } catch (e) {
        await rm(part, { force: true })
        if (i === ways.length - 1) throw e
        log(`${MADE[way]} couldn't make a still of ${basename(src)} (${e instanceof Error ? e.message : String(e)}), converting its first ${HEAD_SECONDS} s with avconvert first`)
      }
    }
    if (!dims) throw new Error('no way to make a still here')
    const bytes = (await stat(part)).size
    await rename(part, out)
    const meta: StillMeta = { src, size, mtime, ...dims, bytes, made }
    await writeFile(join(d, `${key}.json`), JSON.stringify(meta))
    log(`made the first frame still of ${basename(src)}: ${dims.width}x${dims.height}, ${kb(bytes)} with ${made} in ${Date.now() - started} ms`)
    void trim(d)
    return { path: out, width: dims.width, height: dims.height, bytes }
  } catch (e) {
    await rm(part, { force: true })
    log(`couldn't make a still of ${basename(src)}: ${e instanceof Error ? e.message : String(e)}`)
    throw e
  } finally {
    release()
  }
}

export async function videoStill(ask: { path?: string }): Promise<RemoteVideoStill> {
  const src = String(ask?.path ?? '')
  if (!src || !isAbsolute(src)) throw new Error('Pass an absolute video path')
  if (!VIDEO_EXTS.has(extname(src).toLowerCase())) throw new Error(`${extname(src) || 'That file'} is not a video`)
  const st = await stat(src)
  if (!st.isFile()) throw new Error('Not a file')
  const key = createHash('sha1').update(`${src}\n${st.size}\n${st.mtimeMs}\nstill-${STILL_MAX}`).digest('hex').slice(0, 24)
  const d = await dir()
  try {
    const meta = JSON.parse(await readFile(join(d, `${key}.json`), 'utf8')) as StillMeta
    const out = join(d, `${key}.jpg`)
    if ((await stat(out)).size === meta.bytes) return { path: out, width: meta.width, height: meta.height, bytes: meta.bytes }
  } catch {
  }
  const miss = failed.get(key)
  if (miss && Date.now() - miss.at < FAILED_RETRY_MS) throw new Error(miss.why)
  let p = making.get(key)
  if (!p) {
    p = make(src, st.size, st.mtimeMs, key, d)
      .catch((e: unknown) => {
        failed.set(key, { at: Date.now(), why: e instanceof Error ? e.message : String(e) })
        if (failed.size > STILLS_KEPT) failed.delete(failed.keys().next().value as string)
        throw e
      })
      .finally(() => making.delete(key))
    making.set(key, p)
  }
  return p
}

export async function phoneVideoStills(): Promise<{ dir: string; count: number; totalBytes: number; stills: { src: string; width: number; height: number; bytes: number; made: string }[] }> {
  const d = await dir()
  const stills: { src: string; width: number; height: number; bytes: number; made: string }[] = []
  for (const name of await readdir(d)) {
    if (!name.endsWith('.json')) continue
    try {
      const m = JSON.parse(await readFile(join(d, name), 'utf8')) as StillMeta
      stills.push({ src: m.src, width: m.width, height: m.height, bytes: m.bytes, made: m.made })
    } catch {
    }
  }
  return { dir: d, count: stills.length, totalBytes: stills.reduce((n, s) => n + s.bytes, 0), stills }
}

export async function clearPhoneVideoStills(): Promise<void> {
  const d = await dir()
  for (const name of await readdir(d)) await rm(join(d, name), { force: true })
  failed.clear()
}
