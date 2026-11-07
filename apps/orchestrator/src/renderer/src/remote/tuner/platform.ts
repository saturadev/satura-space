import type { TunerFrameEvent, TunerLiveEvent } from '@shared/tuner'
import type { RvTunerMeta } from '@shared/remote-video'
import { tunerSurfaceKey } from '@shared/tuner-frame'
import { onTunerMeta, restartVideo, sendVideo, videoTrouble } from '../video/link'

type FrameCb = (e: TunerFrameEvent) => void

const FIRST_FRAME_MS = 20_000
const FONT_DB = 'satura-tuner-fonts'

interface FirstFrameWatch {
  projectPath: string
  session: string
  timer: ReturnType<typeof setTimeout> | null
  trouble: boolean
}

const liveCbs = new Set<(e: TunerLiveEvent) => void>()
const firstFrame = new Map<string, FirstFrameWatch>()

function emitLive(e: TunerLiveEvent): void {
  for (const cb of liveCbs) {
    try {
      cb(e)
    } catch (err) {
      console.warn(`[tuner] live subscriber failed: ${(err as Error).message}`)
    }
  }
}

function unwatchFirstFrame(key: string): FirstFrameWatch | undefined {
  const w = firstFrame.get(key)
  if (!w) return undefined
  if (w.timer) clearTimeout(w.timer)
  firstFrame.delete(key)
  return w
}

function watchFirstFrame(projectPath: string, session: string): void {
  const key = tunerSurfaceKey(projectPath, session)
  const prev = unwatchFirstFrame(key)
  if (prev?.trouble) restartVideo('Try again on the Tuner')
  const w: FirstFrameWatch = { projectPath, session, timer: null, trouble: false }
  w.timer = setTimeout(() => {
    w.timer = null
    w.trouble = true
    const why = videoTrouble()
    console.warn(`[tuner] phone scene video has no first frame after ${FIRST_FRAME_MS / 1000} s: ${why}`)
    emitLive({ projectPath, session, frameTrouble: why })
  }, FIRST_FRAME_MS)
  firstFrame.set(key, w)
}

function firstFrameShown(key: string): void {
  const w = unwatchFirstFrame(key)
  if (!w) return
  if (w.trouble) {
    console.log('[tuner] phone scene video shows its first frame after the trouble note')
    emitLive({ projectPath: w.projectPath, session: w.session, frameTrouble: null })
  }
}

const subscribers = new Set<FrameCb>()
let unsub: (() => void) | null = null
let frames = 0
const sentCams: { p: number[]; at: number }[] = []
const trips: number[] = []
let tripLogAt = 0
let askedAt = 0
let lastAskAt = 0
let lastFrame = ''
const ASK_BURST_MS = 3000

function noteAsk(): void {
  const now = performance.now()
  if (!askedAt || now - lastAskAt > ASK_BURST_MS) askedAt = now
  lastAskAt = now
}

export function phoneTunerWait(): { waited: number; idle: number } {
  const now = performance.now()
  return { waited: askedAt ? now - askedAt : 0, idle: now - lastAskAt }
}

export function resetPhoneTunerWait(): void {
  askedAt = 0
}

function noteCameraFrame(cam: { position?: number[] } | undefined): void {
  const p = cam?.position
  if (!p || !sentCams.length) return
  const i = sentCams.findIndex((c) => Math.abs(c.p[0] - p[0]) + Math.abs(c.p[1] - p[1]) + Math.abs(c.p[2] - p[2]) < 1e-3)
  if (i < 0) return
  trips.push(performance.now() - sentCams[i].at)
  sentCams.splice(0, i + 1)
  const now = performance.now()
  if (now - tripLogAt < 2000 || trips.length < 3) return
  tripLogAt = now
  const sorted = [...trips].sort((a, b) => a - b)
  console.log(`[tuner] camera round trip phone->Unity->phone: ${trips.length} moves, median ${Math.round(sorted[sorted.length >> 1])} ms, p95 ${Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))])} ms`)
  trips.length = 0
}

function emit(m: RvTunerMeta): void {
  frames++
  const id = `${m.meta.session}:${m.meta.seq}`
  if (id !== lastFrame) {
    lastFrame = id
    askedAt = 0
  }
  if (firstFrame.size) firstFrameShown(m.key)
  noteCameraFrame(m.meta.camera as { position?: number[] } | undefined)
  const e: TunerFrameEvent = {
    projectPath: m.projectPath,
    meta: m.meta,
    surface: { key: m.key, surfaceId: frames, generation: 0, flipY: m.flipY }
  }
  for (const cb of subscribers) {
    try {
      cb(e)
    } catch (err) {
      console.warn(`[tuner] frame subscriber failed: ${(err as Error).message}`)
    }
  }
}

export function onPhoneTunerFrame(cb: FrameCb): () => void {
  subscribers.add(cb)
  unsub ??= onTunerMeta(emit)
  return () => {
    subscribers.delete(cb)
    if (subscribers.size || !unsub) return
    unsub()
    unsub = null
  }
}

export function phoneTunerSurface(): void {
  sendVideo({ t: 'key' })
}

type Font = Awaited<ReturnType<Window['api']['tunerInspector']['fonts']>>[number]

function fontStore<T>(mode: IDBTransactionMode, use: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(FONT_DB, 1)
    open.onupgradeneeded = () => open.result.createObjectStore('fonts')
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const db = open.result
      const req = use(db.transaction('fonts', mode).objectStore('fonts'))
      req.onsuccess = () => {
        db.close()
        resolve(req.result)
      }
      req.onerror = () => {
        db.close()
        reject(req.error)
      }
    }
  })
}

async function fontDbExists(): Promise<boolean> {
  const list = await (indexedDB as IDBFactory & { databases?: () => Promise<IDBDatabaseInfo[]> }).databases?.().catch(() => null)
  return !list || list.some((d) => d.name === FONT_DB)
}

export async function tunerFontCache(): Promise<{ bytes: number; files: number }> {
  if (!(await fontDbExists())) return { bytes: 0, files: 0 }
  const all = await fontStore<Font[][]>('readonly', (s) => s.getAll())
  let bytes = 0
  let files = 0
  for (const list of all) for (const f of Array.isArray(list) ? list : []) {
    bytes += f?.data?.byteLength ?? 0
    files++
  }
  return { bytes, files }
}

export async function clearTunerFontCache(): Promise<void> {
  if (await fontDbExists()) await fontStore('readwrite', (s) => s.clear())
  console.info('[tuner] inspector font cache deleted from this phone')
}

function cachedFonts(fetchFonts: Window['api']['tunerInspector']['fonts']): Window['api']['tunerInspector']['fonts'] {
  return async (fontDir) => {
    try {
      const hit = await fontStore<Font[] | undefined>('readonly', (s) => s.get(fontDir))
      if (Array.isArray(hit) && hit.length) {
        console.info(`[tuner] inspector fonts from the phone cache: ${hit.length} files`)
        return hit
      }
    } catch (e) {
      console.info(`[tuner] inspector font cache unavailable: ${(e as Error)?.message ?? e}`)
    }
    const list = await fetchFonts(fontDir)
    if (list.length) void fontStore('readwrite', (s) => s.put(list, fontDir)).catch(() => {})
    return list
  }
}

export function installTunerShims(api: Window['api']): void {
  api.tunerInspector.fonts = cachedFonts(api.tunerInspector.fonts)
  const t = api.tuner
  const visibility = t.visibility
  t.start = (projectPath, session) => {
    watchFirstFrame(projectPath, session)
    return t.attach(projectPath, session)
  }
  t.stop = async (projectPath, session) => {
    unwatchFirstFrame(tunerSurfaceKey(projectPath, session))
    visibility(projectPath, session, false)
  }
  const onLive = t.onLive
  t.onLive = (cb) => {
    liveCbs.add(cb)
    const off = onLive(cb)
    return () => {
      liveCbs.delete(cb)
      off()
    }
  }
  const animator = t.animator
  t.animator = async (projectPath, session, req) => {
    const at = performance.now()
    const r = await animator(projectPath, session, req)
    console.log(`[tuner] animator ${(req as { op?: string }).op ?? '?'}${(req as { time?: number }).time != null ? ` t=${(req as { time?: number }).time}` : ''} round trip ${Math.round(performance.now() - at)} ms ${r.ok ? 'ok' : r.error}`)
    return r
  }
  const camera = t.camera
  t.camera = (projectPath, session, cam) => {
    const p = (cam as { position?: number[] }).position
    if (p) {
      sentCams.push({ p: [...p], at: performance.now() })
      if (sentCams.length > 120) sentCams.splice(0, sentCams.length - 120)
    }
    noteAsk()
    camera(projectPath, session, cam)
  }
  const transform = t.transform
  t.transform = (projectPath, session, tr) => {
    noteAsk()
    transform(projectPath, session, tr)
  }
}
