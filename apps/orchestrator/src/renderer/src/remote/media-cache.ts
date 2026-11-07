import type { RemoteMediaChunk, RemoteMediaInfo, RemoteVideoPlan, RemoteVideoStill } from '@shared/remote-protocol'
import { censusGauge, censusTrack } from '@shared/census'
import { MEDIA_TIERS, noteHeldChange, type MediaDownloaded, type MediaHeld, type MediaLoader, type MediaProgress, type MediaRange, type MediaScope, type MediaTag, type MediaTier } from '../lib/media-loader'
import { onRemoteLink, remoteLink } from '../lib/remote-link'
import { invokeRemote, noteBulkFlow } from './ws-transport'

interface Entry {
  path: string
  url: string | null
  bytes: number
  refs: number
  idleAt: number
  loading: Promise<string> | null
  progress: MediaProgress
  listeners: Set<(p: MediaProgress) => void>
}

interface FileId {
  size: number
  mtime: number
  type: string
}

interface Waiter {
  bytes: number
  urgent: boolean
  go: () => void
}

interface Kept {
  path: string
  size: number
  mtime: number
  bytes: number
  of?: string
  q?: MediaTier
}

export const MEDIA_BLOCK = 128 * 1024
const WINDOW_START = 256 * 1024
const WINDOW_MAX = 4 * 1024 * 1024
const CALM_MS = 700
const BACKED_UP_MS = 1500
const NOTE_MS = 5000
const CHANNEL_TIMEOUT_MS = 15_000
const RELAY_TIMEOUT_MS = 15_000
const ATTEMPTS = 3
const ID_FRESH_MS = 15_000
const OFFLINE_WAIT_MS = 30_000
const KEEP_IDLE_MS = 60_000
const URL_BUDGET = 160 * 1024 * 1024
const DISK_BUDGET = 768 * 1024 * 1024
const CACHE_NAME = 'satura-media'
const REFUSED = /outside|not a media type|absolute|not a file|no such file|ENOENT|changed on the desktop/i

const entries = new Map<string, Entry>()
const tags = new Map<string, MediaTag>()
const ids = new Map<string, { at: number; id: Promise<FileId> }>()
const jobs = new Map<string, Promise<Uint8Array>>()
const unsaved = new Map<string, Uint8Array>()
const UNSAVED_BUDGET = 384 * 1024 * 1024
let unsavedBytes = 0
let diskKeeps: boolean | null = null
const queued = new Map<string, Waiter>()
const pace = { window: WINDOW_START, flight: 0, waiting: [] as Waiter[], done: 0, busyMs: 0, mark: 0, noted: 0 }
let sweepTimer = 0
let offlineNotedAt = 0
let channel: RTCDataChannel | null = null
let nextAsk = 1
const asks = new Map<number, { resolve: (c: RemoteMediaChunk) => void; reject: (e: Error) => void; timer: number }>()
const infos = new Map<string, { at: number; info: Promise<RemoteMediaInfo | null> }>()
censusTrack('phone.mediaFiles', entries)
censusTrack('phone.mediaAsks', asks)
censusTrack('phone.mediaJobs', jobs)
censusGauge('phone.mediaMB', () => Math.round([...entries.values()].reduce((n, e) => n + e.bytes, 0) / 1e6))
censusGauge('phone.mediaWindowKB', () => Math.round(pace.window / 1024))

const nameOf = (path: string): string => path.split('/').slice(-2).join('/')
const aborted = (): Error => new DOMException('The load was cancelled', 'AbortError')

export function channelOpen(): boolean {
  return channel?.readyState === 'open'
}

function failAsks(why: string): void {
  for (const [id, a] of asks) {
    asks.delete(id)
    window.clearTimeout(a.timer)
    a.reject(new Error(why))
  }
}

export function setMediaChannel(ch: RTCDataChannel): void {
  ch.binaryType = 'arraybuffer'
  channel = ch
  ch.onopen = () => console.info('[media] WebRTC channel open, media skips the relay')
  ch.onclose = () => {
    if (channel === ch) channel = null
    failAsks('The media channel closed')
  }
  ch.onmessage = (e) => {
    if (!(e.data instanceof ArrayBuffer)) return
    const view = new DataView(e.data)
    const headLen = view.getUint32(0, true)
    const head = JSON.parse(new TextDecoder().decode(new Uint8Array(e.data, 4, headLen))) as Partial<RemoteMediaChunk> & { id: number; error?: string }
    const a = asks.get(head.id)
    if (!a) return
    asks.delete(head.id)
    window.clearTimeout(a.timer)
    if (head.error) a.reject(new Error(head.error))
    else a.resolve({ size: Number(head.size), mtime: Number(head.mtime), type: String(head.type), offset: Number(head.offset), data: new Uint8Array(e.data, 4 + headLen), ...(head.info !== undefined ? { info: head.info } : {}) })
  }
}

function askChannel(req: Record<string, unknown>): Promise<RemoteMediaChunk> | null {
  const ch = channel
  if (!ch || ch.readyState !== 'open') return null
  const id = nextAsk++
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      asks.delete(id)
      reject(new Error('The media channel timed out'))
    }, CHANNEL_TIMEOUT_MS)
    asks.set(id, { resolve, reject, timer })
    ch.send(JSON.stringify({ id, ...req }))
  })
}

function overRelay(req: Record<string, unknown>): Promise<RemoteMediaChunk> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error('The desktop did not answer in time')), RELAY_TIMEOUT_MS)
    invokeRemote<RemoteMediaChunk>('remote:readMedia', req).then(
      (c) => {
        window.clearTimeout(timer)
        resolve(c)
      },
      (e: unknown) => {
        window.clearTimeout(timer)
        reject(e instanceof Error ? e : new Error(String(e)))
      }
    )
  })
}

function untilOnline(): Promise<void> {
  if (remoteLink()?.online !== false) return Promise.resolve()
  return new Promise((resolve) => {
    const done = (): void => {
      window.clearTimeout(timer)
      off()
      resolve()
    }
    const timer = window.setTimeout(done, OFFLINE_WAIT_MS)
    const off = onRemoteLink(() => {
      if (remoteLink()?.online !== false) done()
    })
  })
}

async function readChunk(path: string, offset: number, length: number, info: boolean, scope: MediaScope): Promise<RemoteMediaChunk> {
  const req = { path, offset, length, ...(info ? { info } : {}), ...(scope.report ? { report: scope.report } : {}) }
  let last: unknown
  for (let i = 0; i < ATTEMPTS; i++) {
    if (scope.signal?.aborted) throw aborted()
    try {
      if (remoteLink()?.online === false && !channelOpen()) {
        if (Date.now() - offlineNotedAt > NOTE_MS) {
          offlineNotedAt = Date.now()
          console.info(`[media] ${nameOf(path)} waits for the desktop to reconnect before reading at ${(offset / 1e6).toFixed(1)} MB`)
        }
        await untilOnline()
      }
      const chunk = await (askChannel(req) ?? overRelay(req))
      if (!chunk || !(chunk.data instanceof Uint8Array)) throw new Error('The desktop sent no data')
      if (chunk.data.length !== Math.min(length, chunk.size - offset)) throw new Error(`The desktop sent ${chunk.data.length} of ${length} bytes at ${offset}`)
      noteBulkFlow()
      return chunk
    } catch (e) {
      last = e
      if (REFUSED.test(e instanceof Error ? e.message : String(e))) break
      await new Promise((r) => setTimeout(r, 400 * (i + 1)))
    }
  }
  throw last instanceof Error ? last : new Error(String(last))
}

function admits(w: Waiter): boolean {
  return pace.flight === 0 || pace.flight + w.bytes <= pace.window
}

function begin(bytes: number): void {
  if (!pace.flight) pace.mark = performance.now()
  pace.flight += bytes
}

function wake(): void {
  while (pace.waiting.length) {
    const urgent = pace.waiting.findIndex((w) => w.urgent)
    const at = urgent >= 0 ? urgent : 0
    const w = pace.waiting[at]
    if (!admits(w)) return
    pace.waiting.splice(at, 1)
    begin(w.bytes)
    w.go()
  }
}

function settle(bytes: number, ms: number, ok: boolean): void {
  const now = performance.now()
  pace.busyMs += now - pace.mark
  pace.mark = now
  pace.flight -= bytes
  if (ok) {
    pace.done += bytes
    if (ms < CALM_MS) pace.window = Math.min(WINDOW_MAX, pace.window + bytes / 2)
    else if (ms > BACKED_UP_MS) pace.window = Math.max(MEDIA_BLOCK, Math.round(pace.window * 0.7))
    if (pace.busyMs > 20_000) {
      pace.done /= 2
      pace.busyMs /= 2
    }
    if (now - pace.noted > NOTE_MS) {
      pace.noted = now
      console.info(`[media] link ${Math.round(linkBytesPerSecond() / 1024)} KB/s ${channelOpen() ? 'over WebRTC' : 'over the relay'}, window ${Math.round(pace.window / 1024)} KB, last block ${Math.round(ms)} ms, ${pace.waiting.length} blocks waiting`)
    }
  }
  wake()
}

function paced<T>(key: string, bytes: number, urgent: boolean, signal: AbortSignal | undefined, run: () => Promise<T>): Promise<T> {
  return new Promise<void>((resolve, reject) => {
    const w: Waiter = { bytes, urgent, go: resolve }
    if (!pace.waiting.length && admits(w)) {
      begin(bytes)
      resolve()
      return
    }
    pace.waiting.push(w)
    queued.set(key, w)
    signal?.addEventListener(
      'abort',
      () => {
        const i = pace.waiting.indexOf(w)
        if (i < 0) return
        pace.waiting.splice(i, 1)
        reject(aborted())
      },
      { once: true }
    )
  }).then(async () => {
    queued.delete(key)
    const started = performance.now()
    let ok = false
    try {
      const out = await run()
      ok = true
      return out
    } finally {
      settle(bytes, performance.now() - started, ok)
    }
  }, (e: unknown) => {
    queued.delete(key)
    throw e
  })
}

export function linkBytesPerSecond(): number {
  return pace.busyMs > 2000 && pace.done > 512 * 1024 ? (pace.done / pace.busyMs) * 1000 : 0
}

function slowLink(bitrate?: number): boolean {
  const c = (navigator as Navigator & { connection?: { type?: string; effectiveType?: string; saveData?: boolean } }).connection
  if (c?.saveData || c?.type === 'cellular' || /^(slow-)?[23]g$/.test(c?.effectiveType ?? '')) return true
  const rate = linkBytesPerSecond()
  if (rate) return rate * 8 < (bitrate || 4e6) * 1.5
  return !channelOpen()
}

let disk: Promise<Cache | null> | null = null
let index: Map<string, Kept> | null = null
let indexTimer = 0

function cache(): Promise<Cache | null> {
  disk ??= typeof caches === 'undefined' ? Promise.resolve(null) : caches.open(CACHE_NAME).catch(() => null)
  return disk
}

const scopeUrl = (): string => new URL('./', location.href).href
const indexKey = (): string => `${CACHE_NAME}:${new URL(scopeUrl()).pathname}`
const fileKey = (path: string, id: FileId): string => `${path}\n${id.size}\n${id.mtime}`
const blockUrl = (path: string, id: { size: number; mtime: number }, i: number): string => `${scopeUrl()}media-cache/${encodeURIComponent(path)}?s=${id.size}&m=${id.mtime}&b=${i}`

function kept(): Map<string, Kept> {
  if (index) return index
  try {
    index = new Map(JSON.parse(localStorage.getItem(indexKey()) ?? '[]') as [string, Kept][])
  } catch {
    index = new Map()
  }
  return index
}

function writeIndex(): void {
  window.clearTimeout(indexTimer)
  indexTimer = 0
  try {
    localStorage.setItem(indexKey(), JSON.stringify([...kept()]))
  } catch {
  }
}

function saveIndex(now = false): void {
  if (now) return writeIndex()
  window.clearTimeout(indexTimer)
  indexTimer = window.setTimeout(writeIndex, 1000)
}

function forgetFile(c: Cache, key: string, e: Kept): Promise<unknown> {
  kept().delete(key)
  return Promise.all(Array.from({ length: Math.ceil(e.size / MEDIA_BLOCK) }, (_, i) => c.delete(blockUrl(e.path, e, i)).catch(() => false)))
}

let heldTimer = 0

function heldChanged(): void {
  window.clearTimeout(heldTimer)
  heldTimer = window.setTimeout(noteHeldChange, 120)
}

function tagPath(path: string, tag: MediaTag | undefined): void {
  if (!tag) return
  const had = tags.get(path)
  if (had?.of === tag.of && had.q === tag.q) return
  tags.set(path, tag)
  let moved = false
  for (const e of kept().values()) {
    if (e.path !== path || (e.of === tag.of && e.q === tag.q)) continue
    e.of = tag.of
    e.q = tag.q
    moved = true
  }
  if (!moved) return
  saveIndex()
  heldChanged()
}

function tagOf(path: string): Pick<Kept, 'of' | 'q'> {
  const t = tags.get(path)
  return t ? { of: t.of, q: t.q } : {}
}

function holdUnsaved(key: string, data: Uint8Array): void {
  if (unsaved.has(key)) return
  unsaved.set(key, data)
  unsavedBytes += data.byteLength
  while (unsavedBytes > UNSAVED_BUDGET && unsaved.size) {
    const [k, v] = unsaved.entries().next().value as [string, Uint8Array]
    unsaved.delete(k)
    unsavedBytes -= v.byteLength
  }
}

async function keepBlock(path: string, id: FileId, i: number, data: Uint8Array): Promise<boolean> {
  if (diskKeeps === false) return false
  const c = await cache()
  if (!c) return false
  const url = blockUrl(path, id, i)
  const tag = tags.get(path)
  try {
    await c.put(url, new Response(data as BlobPart, { headers: { 'content-type': 'application/octet-stream', ...(tag ? { 'x-satura-of': encodeURIComponent(tag.of), 'x-satura-q': tag.q } : {}) } }))
  } catch {
    return false
  }
  if (diskKeeps === null) {
    const back = !!(await c.match(url).catch(() => undefined))
    if (diskKeeps === null) {
      diskKeeps = back
      if (!back) console.warn("[media] this phone's cache storage loses what it is given, downloaded video stays in memory for this session")
    }
    if (!back) return false
  }
  const all = kept()
  const key = fileKey(path, id)
  let e = all.get(key)
  if (!e) {
    for (const [k, old] of all) if (old.path === path) void forgetFile(c, k, old)
    e = { path, size: id.size, mtime: id.mtime, bytes: 0, ...tagOf(path) }
    heldChanged()
  }
  e.bytes += data.length
  all.delete(key)
  all.set(key, e)
  let total = 0
  for (const x of all.values()) total += x.bytes
  for (const [k, x] of all) {
    if (total <= DISK_BUDGET || k === key) break
    total -= x.bytes
    void forgetFile(c, k, x)
    console.info(`[media] ${nameOf(x.path)} left this phone's cache (${mbOf(x.bytes)} MB) to keep report media under ${mbOf(DISK_BUDGET)} MB`)
    heldChanged()
  }
  saveIndex()
  return true
}

function noteId(path: string, c: RemoteMediaChunk): FileId {
  const id = { size: c.size, mtime: c.mtime, type: c.type }
  ids.set(path, { at: Date.now(), id: Promise.resolve(id) })
  if (ids.size > 400) ids.delete(ids.keys().next().value as string)
  return id
}

function fileId(path: string, scope: MediaScope): Promise<FileId> {
  const hit = ids.get(path)
  if (hit && Date.now() - hit.at < ID_FRESH_MS) return hit.id
  const id = readChunk(path, 0, 1, false, scope).then((c) => noteId(path, c))
  ids.set(path, { at: Date.now(), id })
  id.catch(() => {
    if (ids.get(path)?.id === id) ids.delete(path)
  })
  return id
}

function block(path: string, id: FileId, i: number, scope: MediaScope, urgent: boolean): Promise<Uint8Array> {
  const key = `${fileKey(path, id)}\n${i}`
  const job = jobs.get(key)
  if (job) {
    const w = queued.get(key)
    if (urgent && w) w.urgent = true
    return job
  }
  const forget = (): void => {
    if (jobs.get(key) === run) jobs.delete(key)
  }
  const run: Promise<Uint8Array> = (async () => {
    const c = await cache()
    const hit = await c?.match(blockUrl(path, id, i)).catch(() => undefined)
    if (hit) {
      forget()
      return new Uint8Array(await hit.arrayBuffer())
    }
    const len = Math.min(MEDIA_BLOCK, id.size - i * MEDIA_BLOCK)
    const chunk = await paced(key, len, urgent, scope.signal, () => readChunk(path, i * MEDIA_BLOCK, len, false, scope))
    if (chunk.size !== id.size || chunk.mtime !== id.mtime) {
      ids.delete(path)
      throw new Error(`${nameOf(path)} changed on the desktop while it loaded`)
    }
    void keepBlock(path, id, i, chunk.data)
      .then((kept) => {
        if (!kept) holdUnsaved(key, chunk.data)
      })
      .finally(forget)
    return chunk.data
  })()
  run.catch(forget)
  jobs.set(key, run)
  return run
}

async function readRange(path: string, start: number, end: number, scope: MediaScope = {}): Promise<MediaRange> {
  const id = await fileId(path, scope)
  const stop = Math.min(end, id.size)
  if (start >= stop) return { size: id.size, type: id.type, data: new Uint8Array(0) }
  const first = Math.floor(start / MEDIA_BLOCK)
  const last = Math.floor((stop - 1) / MEDIA_BLOCK)
  let got = 0
  const parts = await Promise.all(
    Array.from({ length: last - first + 1 }, (_, k) =>
      block(path, id, first + k, scope, true).then((b) => {
        got += b.length
        scope.progress?.(got, stop - start)
        return b
      })
    )
  )
  const end2 = Math.min(Math.ceil(id.size / MEDIA_BLOCK) - 1, last + (scope.ahead ?? 0))
  for (let i = last + 1; i <= end2; i++) void block(path, id, i, scope, false).catch(() => {})
  if (first === last && start === first * MEDIA_BLOCK && stop === start + parts[0].length) return { size: id.size, type: id.type, data: parts[0] }
  const out = new Uint8Array(stop - start)
  parts.forEach((b, k) => {
    const base = (first + k) * MEDIA_BLOCK
    const from = Math.max(0, start - base)
    const to = Math.min(b.length, stop - base)
    if (to > from) out.set(b.subarray(from, to), base + from - start)
  })
  return { size: id.size, type: id.type, data: out }
}

export { readRange as readMediaRange }

interface Sub {
  progress?: (got: number, total: number) => void
  resolve: (d: MediaDownloaded) => void
  reject: (e: Error) => void
}

interface Want {
  end: number
  progress?: (got: number, total: number) => void
  resolve: () => void
  reject: (e: Error) => void
}

interface Download {
  path: string
  key: string
  id: FileId
  blocks: number
  have: number
  landed: Set<number>
  flight: Set<number>
  subs: Set<Sub>
  wants: Set<Want>
  ctl: AbortController
  error: Error | null
  done: boolean
  fromDesk: number
  fromPhone: number
  startedAt: number
  notedAt: number
  toldAt: number
  tellTimer: number
  report?: MediaScope['report']
  told: boolean
  scanned: boolean
}

const DOWNLOAD_AHEAD = 32
const HOT_BLOCKS = 64
const TELL_MS = 120
const DOWNLOADS_KEPT = 64
const LOUD_BYTES = 1e6
const downloads = new Map<string, Download>()
const hot = new Map<string, Uint8Array>()
censusTrack('phone.mediaDownloads', downloads)

const mbOf = (n: number): string => (n / 1e6).toFixed(1)
const isAbort = (e: unknown): boolean => e instanceof DOMException && e.name === 'AbortError'

function keepHot(key: string, data: Uint8Array): void {
  hot.delete(key)
  hot.set(key, data)
  if (hot.size > HOT_BLOCKS) hot.delete(hot.keys().next().value as string)
}

function wanted(d: Download): boolean {
  return !d.done && !d.error && (d.subs.size > 0 || d.wants.size > 0)
}

function tell(d: Download, now = false): void {
  const send = (): void => {
    d.tellTimer = 0
    d.toldAt = performance.now()
    for (const s of d.subs) s.progress?.(d.have, d.id.size)
    for (const w of d.wants) w.progress?.(d.have, d.id.size)
  }
  if (now || performance.now() - d.toldAt >= TELL_MS) {
    window.clearTimeout(d.tellTimer)
    send()
  } else if (!d.tellTimer) d.tellTimer = window.setTimeout(send, TELL_MS)
}

function noteRate(d: Download): void {
  const now = performance.now()
  if (now - d.notedAt < NOTE_MS || d.id.size < LOUD_BYTES) return
  d.notedAt = now
  const secs = (now - d.startedAt) / 1000
  console.info(`[media] ${nameOf(d.path)} downloading ${mbOf(d.have)} of ${mbOf(d.id.size)} MB, ${secs > 0 ? (d.fromDesk / 1e6 / secs).toFixed(2) : '0'} MB/s ${channelOpen() ? 'over WebRTC' : 'over the relay'}`)
}

function finishDownload(d: Download): void {
  d.done = true
  tell(d, true)
  const secs = (performance.now() - d.startedAt) / 1000
  if (d.id.size >= LOUD_BYTES) console.info(
    d.fromDesk
      ? `[media] ${nameOf(d.path)} downloaded, ${mbOf(d.id.size)} MB: ${mbOf(d.fromDesk)} MB from the desktop in ${secs.toFixed(1)} s ${channelOpen() ? 'over WebRTC' : 'over the relay'}${d.fromPhone ? `, ${mbOf(d.fromPhone)} MB was already on this phone` : ''}`
      : `[media] ${nameOf(d.path)} is on this phone (${mbOf(d.id.size)} MB), nothing to download`
  )
  for (const s of d.subs) s.resolve({ size: d.id.size, type: d.id.type })
  d.subs.clear()
  for (const w of d.wants) w.resolve()
  d.wants.clear()
  saveIndex(true)
  heldChanged()
  const tag = tags.get(d.path)
  if (tag?.q === 'best') void dropLower(d.path, tag.of)
}

function failDownload(d: Download, e: Error): void {
  if (d.error || d.done) return
  d.error = e
  d.ctl.abort()
  ids.delete(d.path)
  console.warn(`[media] ${nameOf(d.path)} download stopped at ${mbOf(d.have)} of ${mbOf(d.id.size)} MB: ${e.message}`)
  for (const s of d.subs) s.reject(e)
  d.subs.clear()
  for (const w of d.wants) w.reject(e)
  d.wants.clear()
}

function release(d: Download, why: string): void {
  if (d.done || d.error || d.subs.size || d.wants.size) return
  d.ctl.abort()
  d.ctl = new AbortController()
  if (d.id.size >= LOUD_BYTES) console.info(`[media] ${nameOf(d.path)} download paused at ${mbOf(d.have)} of ${mbOf(d.id.size)} MB (${why})`)
}

function advance(d: Download): void {
  let i = Math.floor(d.have / MEDIA_BLOCK)
  while (d.landed.has(i)) {
    d.landed.delete(i)
    i++
    d.have = Math.min(d.id.size, i * MEDIA_BLOCK)
  }
  for (const w of d.wants) {
    if (d.have < w.end) continue
    d.wants.delete(w)
    w.resolve()
  }
  if (d.have >= d.id.size) return finishDownload(d)
  tell(d)
  noteRate(d)
}

async function present(d: Download, i: number): Promise<boolean> {
  const key = `${d.key}\n${i}`
  if (hot.has(key) || unsaved.has(key)) return true
  const c = await cache()
  return !!(await c?.match(blockUrl(d.path, d.id, i)).catch(() => undefined))
}

async function land(d: Download, i: number, signal: AbortSignal): Promise<'phone' | 'desk'> {
  if (await present(d, i)) return 'phone'
  if (signal.aborted) throw aborted()
  if (!d.told && d.id.size >= LOUD_BYTES) {
    d.told = true
    console.info(`[media] ${nameOf(d.path)} download from the desktop starts at ${mbOf(i * MEDIA_BLOCK)} of ${mbOf(d.id.size)} MB${i ? `, the first ${mbOf(Math.min(d.have, i * MEDIA_BLOCK))} MB were on this phone` : ''}, in order to the end`)
  }
  keepHot(`${d.key}\n${i}`, await block(d.path, d.id, i, { report: d.report, signal }, true))
  return 'desk'
}

function pumpDownload(d: Download): void {
  if (!wanted(d)) return
  const first = Math.floor(d.have / MEDIA_BLOCK)
  const stop = Math.min(d.blocks, first + DOWNLOAD_AHEAD)
  for (let i = first; i < stop && d.flight.size < DOWNLOAD_AHEAD; i++) {
    if (d.landed.has(i) || d.flight.has(i)) continue
    d.flight.add(i)
    const ctl = d.ctl
    land(d, i, ctl.signal).then(
      (from) => {
        d.flight.delete(i)
        if (d.done || d.error) return
        const len = Math.min(MEDIA_BLOCK, d.id.size - i * MEDIA_BLOCK)
        if (from === 'phone') d.fromPhone += len
        else d.fromDesk += len
        d.landed.add(i)
        advance(d)
        pumpDownload(d)
      },
      (e: unknown) => {
        d.flight.delete(i)
        if (ctl.signal.aborted && isAbort(e)) return pumpDownload(d)
        failDownload(d, e instanceof Error ? e : new Error(String(e)))
      }
    )
  }
}

function noteStart(d: Download): void {
  d.startedAt = performance.now()
  d.notedAt = d.startedAt
  d.fromDesk = 0
  d.fromPhone = 0
  d.told = false
}

async function scan(d: Download): Promise<void> {
  if (d.scanned || d.done || d.have) return
  d.scanned = true
  let i = 0
  while (i < d.blocks && (await present(d, i))) i++
  if (wanted(d) || d.have) return
  d.have = Math.min(d.id.size, i * MEDIA_BLOCK)
  if (d.have >= d.id.size) d.done = true
}

async function openDownload(path: string, scope: MediaScope): Promise<Download> {
  tagPath(path, scope.tag)
  const had = downloads.get(path)
  if (had?.done && remoteLink()?.online === false) return had
  const id = await fileId(path, scope)
  if (scope.signal?.aborted) throw aborted()
  let d = downloads.get(path)
  if (d && (d.id.size !== id.size || d.id.mtime !== id.mtime)) {
    failDownload(d, new Error(`${nameOf(path)} changed on the desktop`))
    downloads.delete(path)
    d = undefined
  }
  if (!d) {
    const now = performance.now()
    d = { path, key: fileKey(path, id), id, blocks: Math.ceil(id.size / MEDIA_BLOCK), have: 0, landed: new Set(), flight: new Set(), subs: new Set(), wants: new Set(), ctl: new AbortController(), error: null, done: id.size === 0, fromDesk: 0, fromPhone: 0, startedAt: now, notedAt: now, toldAt: 0, tellTimer: 0, report: scope.report, told: false, scanned: false }
    downloads.set(path, d)
    for (const [p, old] of downloads) {
      if (downloads.size <= DOWNLOADS_KEPT) break
      if (!wanted(old)) downloads.delete(p)
    }
  }
  if (d.error) {
    d.error = null
    d.ctl = new AbortController()
  }
  if (scope.report) d.report = scope.report
  return d
}

function attach(d: Download, scope: MediaScope, add: () => void, remove: () => boolean, why: string): void {
  const idle = !d.subs.size && !d.wants.size
  add()
  scope.signal?.addEventListener(
    'abort',
    () => {
      if (remove()) release(d, why)
    },
    { once: true }
  )
  if (idle) noteStart(d)
  pumpDownload(d)
}

function downloadFile(path: string, scope: MediaScope, progress?: (got: number, total: number) => void): Promise<MediaDownloaded> {
  return openDownload(path, scope).then(
    (d) =>
      new Promise<MediaDownloaded>((resolve, reject) => {
        progress?.(d.have, d.id.size)
        if (d.done) {
          if (d.id.size >= LOUD_BYTES) console.info(`[media] ${nameOf(d.path)} is on this phone (${mbOf(d.id.size)} MB), nothing to download`)
          const tag = tags.get(path)
          if (tag?.q === 'best') void dropLower(path, tag.of, true)
          return resolve({ size: d.id.size, type: d.id.type })
        }
        if (scope.signal?.aborted) return reject(aborted())
        const sub: Sub = { progress, resolve, reject }
        attach(
          d,
          scope,
          () => d.subs.add(sub),
          () => {
            if (!d.subs.delete(sub)) return false
            reject(aborted())
            return true
          },
          'the phone stopped the video'
        )
      })
  )
}

async function blockData(d: Download, i: number): Promise<Uint8Array> {
  const key = `${d.key}\n${i}`
  const held = hot.get(key) ?? unsaved.get(key)
  if (held) return held
  const c = await cache()
  const hit = await c?.match(blockUrl(d.path, d.id, i)).catch(() => undefined)
  if (hit) {
    const data = new Uint8Array(await hit.arrayBuffer())
    keepHot(key, data)
    return data
  }
  console.warn(`[media] ${nameOf(d.path)} lost block ${i} from this phone's cache, reading it from the desktop again`)
  return block(d.path, d.id, i, { report: d.report }, true)
}

async function readDownloaded(path: string, offset: number, length: number, scope: MediaScope = {}): Promise<MediaRange> {
  const d = await openDownload(path, scope)
  const end = Math.min(d.id.size, offset + length)
  if (offset >= end) return { size: d.id.size, type: d.id.type, data: new Uint8Array(0) }
  if (d.have < end) {
    await new Promise<void>((resolve, reject) => {
      if (d.error) return reject(d.error)
      if (scope.signal?.aborted) return reject(aborted())
      const want: Want = { end, progress: scope.progress, resolve, reject }
      attach(
        d,
        scope,
        () => d.wants.add(want),
        () => {
          if (!d.wants.delete(want)) return false
          reject(aborted())
          return true
        },
        'the phone stopped the video'
      )
    })
  }
  scope.progress?.(end, end)
  const first = Math.floor(offset / MEDIA_BLOCK)
  const last = Math.floor((end - 1) / MEDIA_BLOCK)
  const parts = await Promise.all(Array.from({ length: last - first + 1 }, (_, k) => blockData(d, first + k)))
  if (first === last && offset === first * MEDIA_BLOCK && end === offset + parts[0].length) return { size: d.id.size, type: d.id.type, data: parts[0] }
  const out = new Uint8Array(end - offset)
  parts.forEach((b, k) => {
    const base = (first + k) * MEDIA_BLOCK
    const from = Math.max(0, offset - base)
    const to = Math.min(b.length, end - base)
    if (to > from) out.set(b.subarray(from, to), base + from - offset)
  })
  return { size: d.id.size, type: d.id.type, data: out }
}

async function fetchFile(e: Entry, scope: MediaScope): Promise<string> {
  const started = performance.now()
  try {
    const id = await fileId(e.path, scope)
    e.progress = { got: 0, total: id.size }
    for (const l of e.listeners) l(e.progress)
    const n = Math.ceil(id.size / MEDIA_BLOCK)
    const parts = await Promise.all(
      Array.from({ length: n }, (_, i) =>
        block(e.path, id, i, scope, true).then((b) => {
          e.progress = { got: e.progress.got + b.length, total: id.size }
          for (const l of e.listeners) l(e.progress)
          return b
        })
      )
    )
    const blob = new Blob(parts as BlobPart[], { type: id.type })
    e.bytes = blob.size
    e.url = URL.createObjectURL(blob)
    const ms = performance.now() - started
    console.info(`[media] ${nameOf(e.path)} ${(blob.size / 1e6).toFixed(2)} MB ${id.type} in ${Math.round(ms)} ms ${channelOpen() ? 'over WebRTC' : 'over the relay'} or from this phone's cache`)
    sweep()
    return e.url
  } catch (err) {
    console.warn(`[media] ${e.path} failed: ${err instanceof Error ? err.message : String(err)}`)
    entries.delete(e.path)
    throw err
  } finally {
    e.loading = null
  }
}

function entry(path: string): Entry {
  let e = entries.get(path)
  if (!e) {
    e = { path, url: null, bytes: 0, refs: 0, idleAt: Date.now(), loading: null, progress: { got: 0, total: 0 }, listeners: new Set() }
    entries.set(path, e)
  }
  return e
}

function sweep(): void {
  const now = Date.now()
  let total = 0
  for (const e of entries.values()) total += e.bytes
  const idle = [...entries.values()].filter((e) => e.refs === 0 && e.url && !e.loading).sort((a, b) => a.idleAt - b.idleAt)
  for (const e of idle) {
    if (total <= URL_BUDGET && now - e.idleAt < KEEP_IDLE_MS) break
    total -= e.bytes
    if (e.url) URL.revokeObjectURL(e.url)
    entries.delete(e.path)
  }
  window.clearTimeout(sweepTimer)
  if (entries.size) sweepTimer = window.setTimeout(sweep, KEEP_IDLE_MS)
}

const WEBP_TURNED = 'data:image/webp;base64,UklGRlAAAABXRUJQVlA4WAoAAAAIAAAAAQAAAAAAVlA4TA8AAAAvAQAAAAcQ/Y/+ByKi/wEARVhJRhoAAABJSSoACAAAAAEAEgEDAAEAAAAGAAAAAAAAAA=='
let webpExif: Promise<boolean> | null = null

function turnsWebp(): Promise<boolean> {
  webpExif ??= new Promise<boolean>((resolve) => {
    const img = new Image()
    img.onload = () => resolve(img.naturalHeight > img.naturalWidth)
    img.onerror = () => resolve(true)
    img.src = WEBP_TURNED
  }).then((yes) => {
    console.info(`[media] this phone ${yes ? 'turns' : "doesn't turn"} WebP photos by their EXIF orientation`)
    return yes
  })
  return webpExif
}

function readInfo(path: string, scope: MediaScope = {}): Promise<RemoteMediaInfo | null> {
  const hit = infos.get(path)
  if (hit && Date.now() - hit.at < ID_FRESH_MS) return hit.info
  const info = readChunk(path, 0, 1, true, scope).then(
    async (c) => {
      noteId(path, c)
      const got = c.info ?? null
      return got?.exifTurned && !(await turnsWebp()) ? { width: got.height, height: got.width } : got
    },
    (e: unknown) => {
      infos.delete(path)
      throw e
    }
  )
  infos.set(path, { at: Date.now(), info })
  if (infos.size > 200) infos.delete(infos.keys().next().value as string)
  return info
}

let caps: { hevc: boolean; webm: boolean } | null = null

function phoneCaps(): { hevc: boolean; webm: boolean } {
  if (caps) return caps
  const v = document.createElement('video')
  caps = { hevc: !!v.canPlayType('video/mp4; codecs="hvc1.1.6.L93.B0"'), webm: v.canPlayType('video/webm; codecs="vp9"') === 'probably' }
  console.info(`[media] this phone plays HEVC: ${caps.hevc ? 'yes' : 'no'}, WebM VP9: ${caps.webm ? 'yes' : 'no'}`)
  return caps
}

const reportOf = (scope?: MediaScope): { report?: MediaScope['report'] } => (scope?.report ? { report: scope.report } : {})

const VIDEO_FILE = /\.(mp4|m4v|mov|webm|mkv|ogv)$/i
const IMAGE_FILE = /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i
const TIER_NAMES: Record<MediaTier, string> = { best: 'Best', '1080': '1080p', '720': '720p', '480': '480p', phone: 'phone version' }
const DELETE_BATCH = 48

export type MediaShelf = MediaTier | 'videos' | 'images' | 'other' | 'elsewhere' | 'extra'

export const MEDIA_SHELVES: MediaShelf[] = [...MEDIA_TIERS, 'videos', 'images', 'other', 'elsewhere', 'extra']

export interface MediaShelfUse {
  bytes: number
  files: number
}

export interface MediaUsage {
  shelves: Record<MediaShelf, MediaShelfUse>
  media: number
  index: number
  memory: number
  keeps: boolean | null
  usage: number | null
  quota: number | null
}

interface Block {
  cache: Cache
  req: Request
  bytes: number
  shelf: MediaShelf
  file: string
  own: { key: string; path: string; size: number; mtime: number } | null
}

function shelfOf(path: string, key: string): MediaShelf {
  const q = kept().get(key)?.q ?? tags.get(path)?.q
  if (q) return q
  return VIDEO_FILE.test(path) ? 'videos' : IMAGE_FILE.test(path) ? 'images' : 'other'
}

async function walkBlocks(): Promise<Block[]> {
  if (typeof caches === 'undefined') return []
  const mine = new URL(scopeUrl()).pathname
  const out: Block[] = []
  for (const name of await caches.keys().catch(() => [] as string[])) {
    const c = await caches.open(name).catch(() => null)
    if (!c) continue
    for (const req of await c.keys().catch(() => [] as readonly Request[])) {
      const u = new URL(req.url)
      const at = u.pathname.indexOf('/media-cache/')
      const size = Number(u.searchParams.get('s'))
      const mtime = Number(u.searchParams.get('m'))
      const b = Number(u.searchParams.get('b'))
      if (name !== CACHE_NAME || at < 0 || !Number.isFinite(size) || !Number.isFinite(b)) {
        const bytes = (await (await c.match(req).catch(() => undefined))?.blob().catch(() => null))?.size ?? 0
        out.push({ cache: c, req, bytes, shelf: 'extra', file: `${name}\n${req.url}`, own: null })
        continue
      }
      const scope = u.pathname.slice(0, at + 1)
      const path = decodeURIComponent(u.pathname.slice(at + '/media-cache/'.length))
      const bytes = Math.max(0, Math.min(MEDIA_BLOCK, size - b * MEDIA_BLOCK))
      const key = fileKey(path, { size, mtime, type: '' })
      const own = scope === mine ? { key, path, size, mtime } : null
      out.push({ cache: c, req, bytes, shelf: own ? shelfOf(path, key) : 'elsewhere', file: `${scope}\n${key}`, own })
    }
  }
  return out
}

async function storedTag(b: Block): Promise<Pick<Kept, 'of' | 'q'>> {
  const h = (await b.cache.match(b.req).catch(() => undefined))?.headers
  const of = h?.get('x-satura-of')
  const q = h?.get('x-satura-q') as MediaTier | null | undefined
  return of && q && MEDIA_TIERS.includes(q) ? { of: decodeURIComponent(of), q } : {}
}

async function audit(blocks: Block[]): Promise<void> {
  const real = new Map<string, NonNullable<Block['own']> & { bytes: number; first: Block }>()
  for (const b of blocks) {
    if (!b.own) continue
    const r = real.get(b.own.key) ?? { ...b.own, bytes: 0, first: b }
    r.bytes += b.bytes
    real.set(b.own.key, r)
  }
  const all = kept()
  let said = 0
  let fixed = 0
  for (const [k, e] of [...all]) {
    said += e.bytes
    const r = real.get(k)
    if (!r) {
      all.delete(k)
      fixed++
    } else if (r.bytes !== e.bytes) {
      e.bytes = r.bytes
      fixed++
    }
  }
  for (const [k, r] of real) {
    if (all.has(k)) continue
    const tag = tagOf(r.path).q ? tagOf(r.path) : await storedTag(r.first)
    all.set(k, { path: r.path, size: r.size, mtime: r.mtime, bytes: r.bytes, ...tag })
    fixed++
  }
  if (!fixed) return
  const now = [...all.values()].reduce((n, e) => n + e.bytes, 0)
  console.info(`[media] this phone's cache index said ${mbOf(said)} MB, the cache holds ${mbOf(now)} MB; fixed ${fixed} entries`)
  saveIndex(true)
  heldChanged()
}

let audited: Promise<void> | null = null

function auditOnce(): Promise<void> {
  audited ??= walkBlocks().then(audit, () => {})
  return audited
}

function forgetMemory(path: string): void {
  const d = downloads.get(path)
  const busy = !!d && wanted(d)
  if (d && !busy) downloads.delete(path)
  const head = `${path}\n`
  if (!busy) for (const k of [...hot.keys()]) if (k.startsWith(head)) hot.delete(k)
  for (const [k, v] of [...unsaved]) {
    if (!k.startsWith(head)) continue
    unsaved.delete(k)
    unsavedBytes -= v.byteLength
  }
  const e = entries.get(path)
  if (e && !e.refs && e.url && !e.loading) {
    URL.revokeObjectURL(e.url)
    entries.delete(path)
  }
}

async function dropLower(path: string, of: string, quiet = false): Promise<void> {
  const c = await cache()
  if (!c) return
  const all = kept()
  if (quiet && ![...all.values()].some((e) => e.of === of && e.path !== path)) return
  const total = (): number => [...all.values()].reduce((n, e) => n + e.bytes, 0)
  const before = total()
  const gone: string[] = []
  const work: Promise<unknown>[] = []
  for (const [k, e] of [...all]) {
    if (e.of !== of || e.path === path) continue
    const d = downloads.get(e.path)
    const what = TIER_NAMES[e.q ?? 'best']
    if (d && wanted(d)) {
      console.info(`[media] ${nameOf(of)} keeps its ${what} copy while it still downloads`)
      continue
    }
    work.push(forgetFile(c, k, e))
    forgetMemory(e.path)
    gone.push(`${what} (${mbOf(e.bytes)} MB)`)
  }
  await Promise.all(work)
  saveIndex(true)
  heldChanged()
  const best = [...all.values()].find((e) => e.path === path)
  console.info(`[media] ${nameOf(of)} has Best on this phone (${mbOf(best?.bytes ?? 0)} MB)${gone.length ? `, deleted the lower ${gone.join(', ')}` : ', nothing lower to delete'}; report media on this phone ${mbOf(before)} -> ${mbOf(total())} MB`)
}

async function stillHere(c: Cache, key: string, e: Kept): Promise<void> {
  const has = (i: number): Promise<boolean> => c.match(blockUrl(e.path, e, i)).then((r) => !!r, () => false)
  const blocks = Math.ceil(e.size / MEDIA_BLOCK)
  if (!blocks || ((await has(0)) && (e.bytes < e.size || (await has(blocks - 1))))) return
  let bytes = 0
  for (let i = 0; i < blocks; i++) if (await has(i)) bytes += Math.min(MEDIA_BLOCK, e.size - i * MEDIA_BLOCK)
  console.info(`[media] ${nameOf(e.path)} has ${mbOf(bytes)} of the ${mbOf(e.bytes)} MB this phone's index listed; the browser cleared the rest`)
  if (bytes) e.bytes = bytes
  else kept().delete(key)
  saveIndex(true)
}

async function heldOf(of: string): Promise<MediaHeld[]> {
  await auditOnce()
  const c = await cache()
  const mine = [...kept()].filter(([, e]) => e.of === of && e.q)
  if (c) await Promise.all(mine.map(([k, e]) => stillHere(c, k, e)))
  const out: MediaHeld[] = []
  for (const e of kept().values()) if (e.of === of && e.q) out.push({ path: e.path, q: e.q, bytes: Math.min(e.bytes, e.size), size: e.size })
  return out
}

export async function mediaUsage(): Promise<MediaUsage> {
  const started = performance.now()
  const blocks = await walkBlocks()
  await audit(blocks)
  for (const b of blocks) if (b.own) b.shelf = shelfOf(b.own.path, b.own.key)
  const shelves = Object.fromEntries(MEDIA_SHELVES.map((k) => [k, { bytes: 0, files: 0 }])) as Record<MediaShelf, MediaShelfUse>
  const seen = new Set<string>()
  for (const b of blocks) {
    shelves[b.shelf].bytes += b.bytes
    if (seen.has(b.file)) continue
    seen.add(b.file)
    shelves[b.shelf].files++
  }
  const media = blocks.reduce((n, b) => n + b.bytes, 0)
  const index = [...kept().values()].reduce((n, e) => n + e.bytes, 0)
  const est = await navigator.storage?.estimate?.().catch(() => null)
  const out: MediaUsage = { shelves, media, index, memory: unsavedBytes, keeps: diskKeeps, usage: est?.usage ?? null, quota: est?.quota ?? null }
  const list = MEDIA_SHELVES.filter((k) => shelves[k].bytes).map((k) => `${k} ${mbOf(shelves[k].bytes)} MB (${shelves[k].files})`)
  console.info(`[media] storage on this phone: report media ${mbOf(media)} MB in ${blocks.length} blocks${list.length ? ` = ${list.join(', ')}` : ''}; index ${mbOf(index)} MB; in memory ${mbOf(unsavedBytes)} MB; storage.estimate ${out.usage == null ? 'unknown' : `${mbOf(out.usage)} MB of ${mbOf(out.quota ?? 0)} MB`}; measured in ${Math.round(performance.now() - started)} ms`)
  return out
}

export async function clearMedia(which: MediaShelf[], progress?: (done: number, total: number) => void): Promise<{ files: number; bytes: number }> {
  const blocks = await walkBlocks()
  const before = blocks.reduce((n, b) => n + b.bytes, 0)
  const doomed = blocks.filter((b) => which.includes(b.shelf))
  const files = new Set(doomed.map((b) => b.file))
  const bytes = doomed.reduce((n, b) => n + b.bytes, 0)
  progress?.(0, doomed.length)
  for (let i = 0; i < doomed.length; i += DELETE_BATCH) {
    await Promise.all(doomed.slice(i, i + DELETE_BATCH).map((b) => b.cache.delete(b.req).catch(() => false)))
    progress?.(Math.min(doomed.length, i + DELETE_BATCH), doomed.length)
  }
  const all = kept()
  const paths = new Set<string>()
  for (const b of doomed) {
    if (!b.own) continue
    all.delete(b.own.key)
    paths.add(b.own.path)
  }
  for (const p of paths) forgetMemory(p)
  if (which.includes('images') || which.includes('other')) for (const e of [...entries.values()]) if (!VIDEO_FILE.test(e.path)) forgetMemory(e.path)
  saveIndex(true)
  heldChanged()
  console.info(`[media] deleted ${which.join(', ')} from this phone: ${files.size} files, ${mbOf(bytes)} MB; report media on this phone ${mbOf(before)} -> ${mbOf(before - bytes)} MB`)
  return { files: files.size, bytes }
}

export async function fileBlob(path: string, scope: MediaScope = {}): Promise<{ blob: Blob; type: string }> {
  const d = await openDownload(path, scope)
  if (!d.done) throw new Error(`${nameOf(path)} isn't all on this phone yet`)
  const c = await cache()
  const parts: BlobPart[] = []
  for (let i = 0; i < d.blocks; i++) {
    const key = `${d.key}\n${i}`
    const held = hot.get(key) ?? unsaved.get(key)
    if (held) {
      parts.push(held as BlobPart)
      continue
    }
    const hit = await c?.match(blockUrl(d.path, d.id, i)).catch(() => undefined)
    parts.push(hit ? await hit.blob() : ((await block(d.path, d.id, i, { report: d.report }, true)) as BlobPart))
  }
  const blob = new Blob(parts, { type: d.id.type })
  if (blob.size !== d.id.size) throw new Error(`${nameOf(path)} came out ${blob.size} of ${d.id.size} bytes`)
  return { blob, type: d.id.type }
}

export { downloadFile as downloadMedia }

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => indexTimer && writeIndex())
  document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && indexTimer && writeIndex())
  window.addEventListener('storage', (e) => {
    if (e.key !== indexKey() || !index) return
    const before = index
    index = null
    const now = kept()
    const gone = [...before].filter(([k]) => !now.has(k))
    for (const [, x] of gone) forgetMemory(x.path)
    if (gone.length) console.info(`[media] another Satura Remote window deleted ${gone.length} file${gone.length === 1 ? '' : 's'} from this phone's cache (${mbOf(gone.reduce((n, [, x]) => n + x.bytes, 0))} MB)`)
    heldChanged()
  })
}

export const phoneMediaLoader: MediaLoader = {
  plan(path, prepare, want, scope) {
    return invokeRemote<RemoteVideoPlan>('remote:videoPlan', { path, prepare, ...phoneCaps(), ...(want?.rendition ? { rendition: want.rendition } : {}), ...(want?.urgent ? { urgent: true } : {}), ...(want?.drop ? { drop: true } : {}), ...reportOf(scope) }).then((p) => ({ ...p, slow: slowLink(p.bitrate) }))
  },
  still(path, scope) {
    return invokeRemote<RemoteVideoStill>('remote:videoStill', { path, ...reportOf(scope) })
  },
  cached(path) {
    return entries.get(path)?.url ?? null
  },
  info: readInfo,
  read: readDownloaded,
  download: (path, onProgress, scope) => downloadFile(path, scope ?? {}, onProgress ? (got, total) => onProgress({ got, total }) : undefined),
  async saved(path, scope) {
    const d = downloads.get(path) ?? (await openDownload(path, scope ?? {}).catch(() => null))
    if (!d) return null
    await scan(d)
    return d.have ? { got: d.have, total: d.id.size } : null
  },
  stop(path, why) {
    void invokeRemote('remote:mediaStop', { path, why }).catch(() => {})
  },
  held: heldOf,
  load(path, onProgress, scope) {
    const e = entry(path)
    if (e.url) return Promise.resolve(e.url)
    if (onProgress) {
      e.listeners.add(onProgress)
      if (e.progress.total) onProgress(e.progress)
    }
    e.loading ??= fetchFile(e, scope ?? {})
    return e.loading.finally(() => {
      if (onProgress) e.listeners.delete(onProgress)
    })
  },
  acquire(path) {
    const e = entry(path)
    e.refs++
    let done = false
    return () => {
      if (done) return
      done = true
      e.refs = Math.max(0, e.refs - 1)
      if (!e.refs) e.idleAt = Date.now()
      window.clearTimeout(sweepTimer)
      sweepTimer = window.setTimeout(sweep, KEEP_IDLE_MS)
    }
  }
}
