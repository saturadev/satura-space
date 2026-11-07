import { app } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, open, readFile, readdir, rename, rm, stat, statfs, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, extname, isAbsolute, join } from 'node:path'
import type { RemoteRenditionId, RemoteVideoPlan, RemoteVideoPlanAsk, RemoteVideoRendition, RemoteVideoVersion } from '@shared/remote-protocol'
import { probeContainer } from './container-probe'
import { probeVideo, type VideoProbe } from './media-info'
import { AVCONVERT, containerOf, noWayNote, videoTools, waysFor, webCodecsDecodes, type Recipe, type Way } from './phone-video-tools'
import { convertWithWebCodecs, stopConverter, type WebCodecsSize } from './phone-video-web'

interface Target extends WebCodecsSize {
  id: RemoteRenditionId
}

interface Meta {
  src: string
  size: number
  mtime: number
  recipe: Recipe
  bytes: number
  label: string
  lastUsed: number
  width?: number
  height?: number
}

interface Job {
  key: string
  src: string
  recipe: Recipe
  estimate: number
  state: 'queued' | 'preparing' | 'skipped' | 'failed'
  progress: number
  note?: string
  proc?: ChildProcess
  target?: Target
  ways: Way[]
}

const PRESETS: Record<Recipe, string> = { remux: 'PresetPassthrough', encode: 'Preset1920x1080', web: 'PresetPassthrough', r1080: 'Preset1920x1080', r720: 'Preset1280x720', r480: 'Preset640x480' }
const RENDITIONS: { id: RemoteRenditionId; short: number; bitrate: number }[] = [
  { id: '1080', short: 1080, bitrate: 6e6 },
  { id: '720', short: 720, bitrate: 3e6 },
  { id: '480', short: 480, bitrate: 1.2e6 }
]
const AUDIO_BITRATE = 128e3
const MAX_PIXELS = 1920 * 1200
const MAX_BITRATE = 12e6
const ENCODED_BITRATE = 11e6
const WEB_BITRATE = 8e6
const FAILED_RETRY_MS = 60_000
const PROBES_KEPT = 200
const VIDEO_EXTS = new Set(['.mp4', '.m4v', '.mov', '.webm', '.mkv', '.ogv'])
const H264 = /^avc[13]\./
const HEVC_TAGGED = /^hvc1/
const PHONE_AUDIO = /^(mp4a|ac-3|ec-3|alac|opus|\.mp3|mp3)/
const CODEC_NAMES: [RegExp, string][] = [
  [/^ap(4h|4x|ch|cn|cs|co)/, 'ProRes'],
  [/^hev1/, 'HEVC (hev1)'],
  [/^hvc1/, 'HEVC'],
  [/^av01/, 'AV1'],
  [/^vp0?9/, 'VP9'],
  [/^vp0?8/, 'VP8'],
  [/^mp4v/, 'MPEG-4'],
  [/^jpeg|^mjp/, 'Motion JPEG']
]

export const phoneVideoLimits = {
  capBytes: 2e9,
  minFreeBytes: 10e9
}

const jobs = new Map<string, Job>()
const failedAt = new Map<string, number>()
const probes = new Map<string, Promise<VideoProbe | null>>()
const asking = new Map<string, Promise<void>>()
const queue: Job[] = []
let running: Job | null = null
let ready: Promise<string> | null = null
let quitHooked = false

const log = (msg: string): void => console.log(`[phone-video] ${msg}`)
const mbps = (bits: number): string => `${bits >= 1e7 ? Math.round(bits / 1e6) : (bits / 1e6).toFixed(1)} Mbps`
const mb = (bytes: number): string => (bytes >= 1e10 ? `${(bytes / 1e9).toFixed(1)} GB` : `${(bytes / 1e6).toFixed(1)} MB`)

export function cacheDir(): string {
  const data = app.getPath('userData')
  return process.platform === 'darwin' ? join(homedir(), 'Library', 'Caches', basename(data), 'phone-videos') : join(data, 'phone-videos')
}

function dir(): Promise<string> {
  ready ??= (async () => {
    const d = cacheDir()
    await mkdir(d, { recursive: true })
    for (const name of await readdir(d)) {
      if (name.includes('.part.')) await rm(join(d, name), { force: true })
    }
    return d
  })()
  return ready
}

function hookQuit(): void {
  if (quitHooked) return
  quitHooked = true
  app.on('will-quit', () => {
    running?.proc?.kill('SIGTERM')
    stopConverter()
  })
}

function sizeLabel(w: number, h: number): string {
  const short = Math.min(w, h)
  if (short >= 2000) return '4K'
  return `${short}p`
}

function codecName(codec: string): string {
  return CODEC_NAMES.find(([re]) => re.test(codec))?.[1] ?? (codec.split('.')[0] || 'unknown codec')
}

function describe(p: VideoProbe): string {
  const kind = H264.test(p.video) ? '' : ` ${codecName(p.video)}`
  return `${sizeLabel(p.width, p.height)}${kind} · ${mbps(p.bitrate)}`
}

interface Verdict {
  reasons: string[]
  recipe: Recipe | null
  plays: boolean
}

function judge(path: string, p: VideoProbe | null, ask: RemoteVideoPlanAsk): Verdict {
  const container = containerOf(path)
  if (container === 'WebM' && ask.webm && p && !p.audio) return { reasons: [], recipe: null, plays: true }
  if (container) return { reasons: [container], recipe: 'web', plays: false }
  if (!p) return { reasons: [], recipe: null, plays: true }
  const codecOk = H264.test(p.video) || (HEVC_TAGGED.test(p.video) && !!ask.hevc)
  const audioOk = !p.audio || PHONE_AUDIO.test(p.audio)
  const reasons: string[] = []
  if (!codecOk) reasons.push(codecName(p.video))
  if (!audioOk) reasons.push(`${p.audio.split('.')[0]} audio`)
  if (p.width * p.height > MAX_PIXELS) reasons.push(sizeLabel(p.width, p.height))
  if (p.bitrate > MAX_BITRATE) reasons.push(mbps(p.bitrate))
  const heavy = reasons.length > 0
  if (!p.faststart) reasons.push('not set up for streaming')
  return { reasons, recipe: heavy ? 'encode' : reasons.length ? 'remux' : null, plays: codecOk }
}

function keyOf(src: string, size: number, mtime: number, recipe: Recipe): string {
  return createHash('sha1').update(`${src}\n${size}\n${mtime}\n${recipe}\n${PRESETS[recipe]}`).digest('hex').slice(0, 24)
}

async function readMeta(d: string, key: string): Promise<Meta | null> {
  try {
    const meta = JSON.parse(await readFile(join(d, `${key}.json`), 'utf8')) as Meta
    const st = await stat(join(d, `${key}.mp4`))
    return st.size === meta.bytes ? meta : null
  } catch {
    return null
  }
}

async function cached(d: string): Promise<{ key: string; meta: Meta }[]> {
  const out: { key: string; meta: Meta }[] = []
  for (const name of await readdir(d)) {
    if (!name.endsWith('.json')) continue
    const key = name.slice(0, -5)
    const meta = await readMeta(d, key)
    if (meta) out.push({ key, meta })
    else await forget(d, key)
  }
  return out
}

async function forget(d: string, key: string): Promise<void> {
  await rm(join(d, `${key}.mp4`), { force: true })
  await rm(join(d, `${key}.json`), { force: true })
}

async function makeRoom(d: string, need: number, keep: string): Promise<boolean> {
  if (need > phoneVideoLimits.capBytes) return false
  const all = (await cached(d)).sort((a, b) => a.meta.lastUsed - b.meta.lastUsed)
  let total = all.reduce((n, e) => n + e.meta.bytes, 0)
  for (const e of all) {
    if (total + need <= phoneVideoLimits.capBytes) break
    if (e.key === keep) continue
    await forget(d, e.key)
    total -= e.meta.bytes
    log(`evicted ${basename(e.meta.src)} (${mb(e.meta.bytes)}, last used ${new Date(e.meta.lastUsed).toISOString()}) to stay under ${mb(phoneVideoLimits.capBytes)}`)
  }
  return total + need <= phoneVideoLimits.capBytes
}

async function freeBytes(d: string): Promise<number> {
  const s = await statfs(d)
  return Number(s.bavail) * Number(s.bsize)
}

function probe(path: string, size: number, mtime: number): Promise<VideoProbe | null> {
  const key = `${path}\n${size}\n${mtime}`
  let p = probes.get(key)
  if (!p) {
    p = (async () => {
      const h = await open(path, 'r')
      try {
        return containerOf(path) ? await probeContainer(h, size) : await probeVideo(h, size)
      } catch {
        return null
      } finally {
        await h.close()
      }
    })()
    probes.set(key, p)
    if (probes.size > PROBES_KEPT) probes.delete(probes.keys().next().value as string)
  }
  return p
}

function avconvert(job: Job, src: string, out: string, from = 0, preset = PRESETS[job.recipe]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(AVCONVERT, ['--source', src, '--output', out, '--preset', preset, '--replace', '--progress'], { stdio: ['ignore', 'pipe', 'pipe'] })
    job.proc = proc
    let tail = ''
    const onData = (b: Buffer): void => {
      const text = b.toString()
      tail = (tail + text).slice(-600)
      const all = [...text.matchAll(/progress:\s+([\d.]+)%/g)]
      const last = all[all.length - 1]
      if (last) job.progress = Math.min(0.999, from + ((1 - from) * Number(last[1])) / 100)
    }
    proc.stdout.on('data', onData)
    proc.stderr.on('data', onData)
    proc.on('error', reject)
    proc.on('close', (code) => {
      job.proc = undefined
      const clean = tail.replace(/\r/g, '\n').split('\n').map((l) => l.trim()).filter((l) => l && !l.includes('progress:'))
      if (code === 0 && !/error:\s*-?[1-9]/.test(tail) && existsSync(out)) resolve()
      else reject(new Error(clean[clean.length - 1] || `avconvert exited with ${code}`))
    })
  })
}

function whatOf(job: Job): string {
  return job.target ? `the ${job.target.id}p rendition` : 'a phone version'
}

async function makeWith(job: Job, way: Way, out: string, raw: string): Promise<void> {
  const t = job.target
  const size = t ? { width: t.width, height: t.height, bitrate: t.bitrate } : undefined
  const spec = t ? `${t.width}x${t.height}, ${mbps(t.bitrate)}` : 'H.264 up to 1080p'
  if (way === 'avconvert') {
    log(`making ${whatOf(job)} of ${basename(job.src)} with avconvert ${PRESETS[job.recipe]}`)
    return avconvert(job, job.src, out)
  }
  if (way === 'webcodecs-in-memory') {
    log(`making ${whatOf(job)} of ${basename(job.src)} with WebCodecs (${spec}), index first in memory`)
    return convertWithWebCodecs(job.src, out, (p) => {
      job.progress = Math.min(0.999, p)
    }, size, 'in-memory')
  }
  log(`making ${whatOf(job)} of ${basename(job.src)} with WebCodecs (${spec}), then avconvert PresetPassthrough`)
  await convertWithWebCodecs(job.src, raw, (p) => {
    job.progress = Math.min(0.95, p * 0.95)
  }, size)
  await avconvert(job, raw, out, 0.95, PRESETS.remux)
  await rm(raw, { force: true })
}

async function run(job: Job): Promise<void> {
  const d = await dir()
  const out = join(d, `${job.key}.part.mp4`)
  const raw = join(d, `${job.key}.part.web.mp4`)
  const started = Date.now()
  try {
    const free = await freeBytes(d)
    if (free - job.estimate < phoneVideoLimits.minFreeBytes) {
      job.state = 'skipped'
      job.note = 'This computer is low on disk space.'
      failedAt.set(job.key, Date.now())
      log(`skipped ${basename(job.src)}: ${mb(free)} free, a phone version needs about ${mb(job.estimate)} and the Mac keeps ${mb(phoneVideoLimits.minFreeBytes)} free`)
      return
    }
    if (!(await makeRoom(d, job.estimate, job.key))) {
      job.state = 'skipped'
      job.note = 'The video is too long for a phone version.'
      failedAt.set(job.key, Date.now())
      log(`skipped ${basename(job.src)}: about ${mb(job.estimate)} doesn't fit the ${mb(phoneVideoLimits.capBytes)} cache`)
      return
    }
    job.state = 'preparing'
    const ways = job.ways
    for (const [i, way] of ways.entries()) {
      try {
        await makeWith(job, way, out, raw)
        break
      } catch (e) {
        await rm(raw, { force: true })
        await rm(out, { force: true })
        if (i === ways.length - 1) throw e
        log(`${way} couldn't make ${whatOf(job)} of ${basename(job.src)} (${e instanceof Error ? e.message : String(e)}), trying ${ways[i + 1]}`)
        job.progress = 0
      }
    }
    const st = await stat(out)
    const fh = await open(out, 'r')
    let made: VideoProbe | null = null
    try {
      made = await probeVideo(fh, st.size)
    } finally {
      await fh.close()
    }
    const src = await stat(job.src)
    if (job.target && !made?.width) throw new Error('the rendition came out without a picture')
    const label = made ? `${sizeLabel(made.width, made.height)} · ${mbps(made.bitrate)}` : mb(st.size)
    const final = join(d, `${job.key}.mp4`)
    await rename(out, final)
    const meta: Meta = { src: job.src, size: src.size, mtime: src.mtimeMs, recipe: job.recipe, bytes: st.size, label, lastUsed: Date.now(), ...(made ? { width: made.width, height: made.height } : {}) }
    await writeFile(join(d, `${job.key}.json`), JSON.stringify(meta))
    log(`made ${whatOf(job)} of ${basename(job.src)}: ${mb(src.size)} → ${mb(st.size)} (${label}, ${made?.faststart ? 'moov first' : 'moov at the end'}) in ${((Date.now() - started) / 1000).toFixed(1)} s`)
    await makeRoom(d, 0, job.key)
    jobs.delete(job.key)
  } catch (e) {
    await rm(out, { force: true })
    await rm(raw, { force: true })
    job.state = 'failed'
    job.note = videoTools().avconvert ? "Your Mac couldn't make a phone version." : "This computer couldn't make a phone version."
    failedAt.set(job.key, Date.now())
    log(`failed on ${basename(job.src)}: ${e instanceof Error ? e.message : String(e)}`)
  }
}

function pump(): void {
  if (running) return
  const next = queue.shift()
  if (!next) return
  running = next
  void run(next).finally(() => {
    running = null
    pump()
  })
}

function enqueue(key: string, src: string, recipe: Recipe, estimate: number, ways: Way[], target?: Target): Job {
  hookQuit()
  const job: Job = { key, src, recipe, estimate, ways, state: 'queued', progress: 0, ...(target ? { target } : {}) }
  jobs.set(key, job)
  queue.push(job)
  pump()
  return job
}

function asVersion(job: Job): RemoteVideoVersion {
  return { state: job.state, progress: job.progress, ...(job.recipe === 'remux' ? { lossless: true } : {}), ...(job.note ? { note: job.note } : {}) }
}

function hurry(job: Job | undefined): void {
  const i = job && job.state === 'queued' ? queue.indexOf(job) : -1
  if (i <= 0) return
  queue.splice(i, 1)
  queue.unshift(job!)
  log(`${basename(job!.src)}: the phone is waiting for it, moved to the front of the queue`)
}

function targetOf(p: VideoProbe, short: number, bitrate: number, id: RemoteRenditionId): Target {
  const k = short / Math.min(p.width, p.height)
  const width = Math.max(2, Math.round((p.width * k) / 2) * 2)
  const height = Math.max(2, Math.round((p.height * k) / 2) * 2)
  return { id, width, height, bitrate: Math.round((bitrate * width * height) / ((short * short * 16) / 9)) }
}

async function renditionsFor(path: string, size: number, mtime: number, p: VideoProbe, ask: RemoteVideoPlanAsk): Promise<RemoteVideoRendition[]> {
  if (!p.width || !p.height) return []
  const d = await dir()
  const tools = videoTools()
  const out: RemoteVideoRendition[] = []
  for (const r of RENDITIONS) {
    if (Math.min(p.width, p.height) <= r.short) continue
    const recipe = `r${r.id}` as Recipe
    const key = keyOf(path, size, mtime, recipe)
    const t = targetOf(p, r.short, r.bitrate, r.id)
    const estimate = Math.round(((p.duration || 60) * (t.bitrate + (p.audio ? AUDIO_BITRATE : 0))) / 8)
    const ways = waysFor(recipe, tools, estimate, containerOf(path), webCodecsDecodes(p.video))
    if (!ways.length) continue
    const base = { id: r.id, width: t.width, height: t.height, bitrate: t.bitrate, bytes: estimate }
    const wanted = ask.rendition === r.id && ask.prepare !== false && !ask.drop
    const meta = await readMeta(d, key)
    if (meta) {
      if (wanted) {
        meta.lastUsed = Date.now()
        await writeFile(join(d, `${key}.json`), JSON.stringify(meta))
      }
      out.push({ ...base, width: meta.width ?? t.width, height: meta.height ?? t.height, bitrate: Math.round((meta.bytes * 8) / (p.duration || 1)), bytes: meta.bytes, state: 'ready', path: join(d, `${key}.mp4`) })
      continue
    }
    let job = jobs.get(key)
    if (ask.drop && ask.rendition === r.id && job?.state === 'queued') {
      const at = queue.indexOf(job)
      if (at >= 0) queue.splice(at, 1)
      jobs.delete(key)
      job = undefined
      log(`${basename(path)}: dropped the queued ${r.id}p rendition, the phone left it without playing`)
    } else if (ask.drop && ask.rendition === r.id && job?.state === 'preparing') log(`${basename(path)}: kept the ${r.id}p rendition the phone left, it had already started`)
    const stale = (job?.state === 'failed' || job?.state === 'skipped') && Date.now() - (failedAt.get(key) ?? 0) >= FAILED_RETRY_MS
    if (wanted && (!job || stale)) {
      log(`${basename(path)}: the phone wants the ${r.id}p rendition (${t.width}x${t.height}, about ${mb(estimate)})`)
      job = enqueue(key, path, recipe, estimate, ways, t)
    }
    if (wanted && ask.urgent) hurry(job)
    out.push(job ? { ...base, state: job.state, progress: job.progress, ...(job.note ? { note: job.note } : {}) } : { ...base, state: 'none' })
  }
  return out
}

function estimateOf(recipe: Recipe, size: number, p: VideoProbe | null): number {
  if (recipe === 'remux') return size
  if (recipe === 'web') return p?.duration ? Math.max(8e6, (p.duration * (WEB_BITRATE + AUDIO_BITRATE)) / 8) : 8e6 + size * 4
  return Math.max(8e6, ((p?.duration ?? 60) * Math.min(p?.bitrate ?? ENCODED_BITRATE, ENCODED_BITRATE)) / 8)
}

export function videoPlan(ask: RemoteVideoPlanAsk): Promise<RemoteVideoPlan> {
  const path = String(ask?.path ?? '')
  const next = (asking.get(path) ?? Promise.resolve()).then(() => planOf(ask))
  const done = next.then(
    () => {},
    () => {}
  )
  asking.set(path, done)
  void done.then(() => {
    if (asking.get(path) === done) asking.delete(path)
  })
  return next
}

async function planOf(ask: RemoteVideoPlanAsk): Promise<RemoteVideoPlan> {
  const path = String(ask?.path ?? '')
  if (!path || !isAbsolute(path)) throw new Error('Pass an absolute video path')
  if (!VIDEO_EXTS.has(extname(path).toLowerCase())) throw new Error(`${extname(path) || 'That file'} is not a video`)
  const st = await stat(path)
  if (!st.isFile()) throw new Error('Not a file')
  const p = await probe(path, st.size, st.mtimeMs)
  const v = judge(path, p, ask)
  const plan: RemoteVideoPlan = {
    path,
    reason: v.reasons.join(', '),
    plays: v.plays,
    label: p ? describe(p) : containerOf(path) || mb(st.size),
    audio: p ? !!p.audio : true,
    bytes: st.size,
    ...(p?.bitrate ? { bitrate: Math.round(p.bitrate) } : {}),
    ...(p?.width && p.height ? { width: p.width, height: p.height } : {}),
    renditions: p ? await renditionsFor(path, st.size, st.mtimeMs, p, ask) : []
  }
  if (!v.reasons.length || !v.recipe) return plan
  const estimate = estimateOf(v.recipe, st.size, p)
  const tools = videoTools()
  const decodable = webCodecsDecodes(p?.video ?? '')
  const ways = waysFor(v.recipe, tools, estimate, containerOf(path), decodable)
  if (!ways.length) {
    plan.version = { state: 'skipped', note: noWayNote(v.recipe, tools, decodable) }
    return plan
  }
  const key = keyOf(path, st.size, st.mtimeMs, v.recipe)
  const d = await dir()
  const meta = await readMeta(d, key)
  if (meta) {
    meta.lastUsed = Date.now()
    await writeFile(join(d, `${key}.json`), JSON.stringify(meta))
    plan.version = { state: 'ready', path: join(d, `${key}.mp4`), label: meta.label, bytes: meta.bytes, ...(v.recipe === 'remux' ? { lossless: true } : {}) }
    return plan
  }
  const job = jobs.get(key)
  if (job && (job.state === 'queued' || job.state === 'preparing')) {
    if (ask.urgent && !ask.rendition) hurry(job)
    plan.version = asVersion(job)
    return plan
  }
  if (job && (job.state === 'skipped' || (job.state === 'failed' && Date.now() - (failedAt.get(key) ?? 0) < FAILED_RETRY_MS))) {
    plan.version = asVersion(job)
    if (job.state === 'skipped') jobs.delete(key)
    return plan
  }
  if (ask.prepare === false) {
    plan.version = { state: 'queued', progress: 0, ...(v.recipe === 'remux' ? { lossless: true } : {}) }
    return plan
  }
  log(`${basename(path)} needs a phone version (${plan.reason}; ${plan.label}), ${v.recipe === 'remux' ? 'moving the index to the front' : v.recipe === 'web' ? 'converting it to H.264' : 'encoding to 1080p H.264'}`)
  plan.version = asVersion(enqueue(key, path, v.recipe, estimate, ways))
  return plan
}

export async function phoneVideoCache(): Promise<{ dir: string; totalBytes: number; capBytes: number; minFreeBytes: number; freeBytes: number; files: { src: string; recipe: string; bytes: number; label: string; lastUsed: number }[]; jobs: { src: string; recipe: string; state: string; progress: number; note?: string }[] }> {
  const d = await dir()
  const all = await cached(d)
  return {
    dir: d,
    totalBytes: all.reduce((n, e) => n + e.meta.bytes, 0),
    capBytes: phoneVideoLimits.capBytes,
    minFreeBytes: phoneVideoLimits.minFreeBytes,
    freeBytes: await freeBytes(d),
    files: all.sort((a, b) => b.meta.lastUsed - a.meta.lastUsed).map((e) => ({ src: e.meta.src, recipe: e.meta.recipe, bytes: e.meta.bytes, label: e.meta.label, lastUsed: e.meta.lastUsed })),
    jobs: [...jobs.values()].map((j) => ({ src: j.src, recipe: j.recipe, state: j.state, progress: j.progress, ...(j.note ? { note: j.note } : {}) }))
  }
}

export async function clearPhoneVideos(): Promise<void> {
  const d = await dir()
  for (const { key } of await cached(d)) await forget(d, key)
  jobs.clear()
  failedAt.clear()
}

export type PhoneVideoKind = 'versions' | 'r1080' | 'r720' | 'r480'

const kindOf = (recipe: Recipe): PhoneVideoKind => (recipe === 'r1080' || recipe === 'r720' || recipe === 'r480' ? recipe : 'versions')

export async function phoneVideoKinds(): Promise<Record<PhoneVideoKind, { bytes: number; files: number }>> {
  const out: Record<PhoneVideoKind, { bytes: number; files: number }> = { versions: { bytes: 0, files: 0 }, r1080: { bytes: 0, files: 0 }, r720: { bytes: 0, files: 0 }, r480: { bytes: 0, files: 0 } }
  for (const { meta } of await cached(await dir())) {
    const k = out[kindOf(meta.recipe)]
    k.bytes += meta.bytes
    k.files++
  }
  return out
}

export async function clearPhoneVideoKinds(kinds: PhoneVideoKind[]): Promise<{ files: number; bytes: number }> {
  const d = await dir()
  let files = 0
  let bytes = 0
  for (const { key, meta } of await cached(d)) {
    if (!kinds.includes(kindOf(meta.recipe))) continue
    await forget(d, key)
    files++
    bytes += meta.bytes
  }
  log(`deleted ${files} cached ${kinds.join(', ')} file${files === 1 ? '' : 's'}, ${mb(bytes)}`)
  return { files, bytes }
}
