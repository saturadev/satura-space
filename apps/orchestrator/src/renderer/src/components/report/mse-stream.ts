import { Log, MP4BoxBuffer, createFile, type Movie } from 'mp4box'
import { coverageOf, coveredBy, type Coverage } from './mp4-coverage'

export interface PipeSource {
  read: (offset: number, length: number) => Promise<{ data: Uint8Array; size: number }>
  have: () => number
  log: (line: string) => void
  fail: (why: string) => void
  late: () => void
}

export interface Pipe {
  stop: () => void
  timeAt: (bytes: number) => number
  ready: () => boolean
  lateIndex: () => boolean
}

interface Track {
  sb: SourceBuffer
  queue: ArrayBuffer[]
  last: boolean
}

type MediaSourceCtor = typeof MediaSource

const READ = 512 * 1024
const AHEAD_S = 30
const LOW_S = 2
const KEEP_BEHIND_S = 30
const QUEUED_MAX = 8 * 1024 * 1024
const OPEN_MS = 4000
const SEEK_SETTLE_MS = 120
const NATIVE_TIME = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime') as PropertyDescriptor

Log.setLogLevel(Log.error)

function sourceCtor(): MediaSourceCtor | null {
  const w = window as Window & { ManagedMediaSource?: MediaSourceCtor; MediaSource?: MediaSourceCtor }
  return w.ManagedMediaSource ?? w.MediaSource ?? null
}

export function canStream(): boolean {
  return !!sourceCtor()
}

function attach(video: HTMLVideoElement, ms: MediaSource): string | null {
  try {
    video.srcObject = ms as unknown as MediaStream
    if (video.srcObject === (ms as unknown)) return null
  } catch {
  }
  const url = URL.createObjectURL(ms)
  video.src = url
  return url
}

export function playMp4(video: HTMLVideoElement, src: PipeSource): Pipe {
  const Ctor = sourceCtor() as MediaSourceCtor
  const ms = new Ctor()
  const managed = Ctor !== (window as Window & { MediaSource?: MediaSourceCtor }).MediaSource
  if (managed) video.disableRemotePlayback = true
  const file = createFile(true)
  const tracks = new Map<number, Track>()
  let coverage: Coverage[] = []
  let stopped = false
  let open = false
  let opened = false
  let ready = false
  let reading = false
  let streaming = true
  let gen = 0
  let next = 0
  let size = 0
  let error = ''
  let retry = 0
  let seekTimer = 0
  let openTimer = 0
  let late = false
  let gapAt: number | null = null

  const now = (): number => NATIVE_TIME.get!.call(video) as number
  const bufferedAhead = (t: number): number => {
    const b = video.buffered
    for (let i = 0; i < b.length; i++) if (b.start(i) <= t + 0.25 && b.end(i) > t) return b.end(i) - t
    return 0
  }
  const bufferedEnd = (): number => {
    const b = video.buffered
    return b.length ? b.end(b.length - 1) : 0
  }
  const fail = (why: string): void => {
    if (stopped || error) return
    error = why
    window.clearTimeout(openTimer)
    src.log(`stream failed: ${why}`)
    src.fail(why)
  }
  const queued = (): number => [...tracks.values()].reduce((n, t) => n + t.queue.reduce((m, b) => m + b.byteLength, 0), 0)
  const wanted = (): boolean => {
    if (!ready) return true
    if (queued() >= QUEUED_MAX) return false
    const ahead = bufferedAhead(now())
    return ahead < LOW_S || (streaming && ahead < AHEAD_S)
  }

  const finish = (): void => {
    if (ms.readyState !== 'open') return
    for (const t of tracks.values()) if (!t.last || t.queue.length || t.sb.updating) return
    try {
      ms.endOfStream()
      src.log('every frame is in the player')
    } catch {
    }
  }

  const trim = (t: Track): boolean => {
    const keepFrom = now() - KEEP_BEHIND_S
    const b = t.sb.buffered
    if (keepFrom <= 0 || !b.length || b.start(0) >= keepFrom) return false
    t.sb.remove(0, keepFrom)
    return true
  }

  const pump = (t: Track): void => {
    if (stopped || t.sb.updating || ms.readyState === 'closed') return
    const buf = t.queue.shift()
    if (!buf) {
      finish()
      void feed()
      return
    }
    try {
      t.sb.appendBuffer(buf)
    } catch (e) {
      if (e instanceof DOMException && e.name === 'QuotaExceededError') {
        t.queue.unshift(buf)
        if (!trim(t)) retry = window.setTimeout(() => pump(t), 1000)
        return
      }
      fail(`the phone refused a piece of the video (${e instanceof Error ? e.message : String(e)})`)
    }
  }

  file.onError = (_module: string, message: string) => fail(`couldn't read the video file (${message})`)
  file.onReady = (info: Movie) => {
    if (info.timescale && info.duration) ms.duration = info.duration / info.timescale
    const picture = info.tracks.find((t) => t.video)
    if (!picture) return fail('the file has no video track')
    const perSegment = Math.max(15, Math.round(picture.nb_samples / Math.max(1, picture.duration / picture.timescale) || 30))
    for (const t of info.tracks) {
      const kind = t.video ? 'video' : t.audio ? 'audio' : ''
      if (!kind) continue
      const mime = `${kind}/mp4; codecs="${t.codec}"`
      if (!Ctor.isTypeSupported(mime)) return fail(`this phone can't play ${t.codec}`)
      const track: Track = { sb: ms.addSourceBuffer(mime), queue: [], last: false }
      track.sb.addEventListener('updateend', () => pump(track))
      tracks.set(t.id, track)
      file.setSegmentOptions(t.id, track, { nbSamples: perSegment })
    }
    coverage = coverageOf(file, [...tracks.keys()])
    for (const seg of file.initializeSegmentation('per-track')) {
      const track = seg.user as Track
      track.queue.push(seg.buffer)
      pump(track)
    }
    ready = true
    src.log(`stream ready: ${info.tracks.map((t) => t.codec).join(', ')}, ${(ms.duration || 0).toFixed(1)} s, ${(size / 1e6).toFixed(1)} MB, index ${info.isProgressive ? 'first' : 'at the end'}`)
    file.start()
  }
  file.onSegment = (id: number, user: unknown, buffer: ArrayBuffer, nextSample: number, last: boolean) => {
    const track = user as Track
    track.queue.push(buffer)
    if (last) track.last = true
    file.releaseUsedSamples(id, nextSample)
    pump(track)
  }

  const feed = async (): Promise<void> => {
    if (stopped || error || reading || !open || (size && next >= size) || !wanted()) return
    reading = true
    const my = gen
    const at = next
    try {
      const r = await src.read(at, size ? Math.min(READ, size - at) : READ)
      if (stopped || my !== gen) return
      size = r.size
      if (!r.data.length) throw new Error(`the file ended at ${at} of ${size} bytes`)
      const end = at + r.data.length
      const ab = r.data.byteOffset === 0 && r.data.byteLength === r.data.buffer.byteLength ? (r.data.buffer as ArrayBuffer) : (r.data.slice().buffer as ArrayBuffer)
      const want = file.appendBuffer(MP4BoxBuffer.fromArrayBuffer(ab, at), false)
      next = typeof want === 'number' && want !== at ? want : end
      if (!ready && !late && next > end + READ) {
        late = true
        src.log(`has its index at the end (${(next / 1e6).toFixed(1)} MB in), it plays once the download gets there`)
        src.late()
      }
      if (next >= size) {
        file.flush()
        for (const t of tracks.values()) t.last = true
        finish()
      }
    } catch (e) {
      if (!stopped && my === gen) fail(e instanceof Error ? e.message : String(e))
      return
    } finally {
      if (my === gen) reading = false
    }
    void feed()
  }

  const fill = (t: number, why: string): void => {
    gen++
    reading = false
    for (const tr of tracks.values()) {
      tr.queue = []
      tr.last = false
      if (tr.sb.updating) {
        try {
          tr.sb.abort()
        } catch {
        }
      }
    }
    const { offset } = file.seek(t, true)
    next = offset
    const have = src.have()
    src.log(`${why} ${t.toFixed(2)} s reads from ${(offset / 1e6).toFixed(2)} MB, ${offset < have ? 'already on this phone' : `waits for the download to get there (it is at ${(have / 1e6).toFixed(2)} MB)`}`)
    file.start()
    void feed()
  }
  const settle = (why: string): void => {
    seekTimer = 0
    if (!ready || stopped || error) return
    const t = now()
    if (bufferedAhead(t) > 0.5) return void feed()
    gapAt = null
    fill(t, why)
  }
  const onSeeking = (): void => {
    window.clearTimeout(seekTimer)
    seekTimer = window.setTimeout(() => settle('seek to'), SEEK_SETTLE_MS)
  }
  const onWaiting = (): void => {
    if (!ready || seekTimer || video.seeking) return
    const t = now()
    if (bufferedAhead(t) > 0.5 || t >= bufferedEnd() - 0.25) return
    seekTimer = window.setTimeout(() => settle('no frames in the player at'), SEEK_SETTLE_MS)
  }
  const onTick = (): void => {
    if (ready && !stopped && !error && !seekTimer && !video.seeking) {
      const t = now()
      const ahead = bufferedAhead(t)
      const end = t + ahead
      if (ahead >= LOW_S) gapAt = null
      else if (ahead > 0 && end < bufferedEnd() - 0.25 && (gapAt === null || Math.abs(gapAt - end) > 0.5)) {
        gapAt = end
        return fill(end, 'fills the gap at')
      }
    }
    void feed()
  }
  const onOpen = (): void => {
    open = true
    window.clearTimeout(openTimer)
    if (!opened) src.log(`stream opened (${managed ? 'managed source' : 'media source'}${url ? ', object URL' : ', srcObject'})`)
    opened = true
    void feed()
  }
  const onStart = (): void => {
    streaming = true
    void feed()
  }
  const onEnd = (): void => {
    streaming = false
  }
  ms.addEventListener('sourceopen', onOpen)
  ms.addEventListener('startstreaming', onStart)
  ms.addEventListener('endstreaming', onEnd)
  video.addEventListener('seeking', onSeeking)
  video.addEventListener('waiting', onWaiting)
  video.addEventListener('timeupdate', onTick)
  video.addEventListener('progress', onTick)
  video.preload = 'auto'
  const url = attach(video, ms)
  video.load()
  openTimer = window.setTimeout(() => fail(`the phone didn't open the video stream in ${OPEN_MS / 1000} s`), OPEN_MS)

  return {
    ready: () => ready,
    lateIndex: () => late && !ready,
    timeAt: (bytes) => {
      if (!coverage.length) return 0
      if (size && bytes >= size) return Math.max(...coverage.map((c) => (c.times.length ? c.times[c.times.length - 1] : 0)))
      return Math.min(...coverage.map((c) => coveredBy(c, bytes)))
    },
    stop: () => {
      stopped = true
      window.clearTimeout(retry)
      window.clearTimeout(openTimer)
      window.clearTimeout(seekTimer)
      ms.removeEventListener('sourceopen', onOpen)
      ms.removeEventListener('startstreaming', onStart)
      ms.removeEventListener('endstreaming', onEnd)
      video.removeEventListener('seeking', onSeeking)
      video.removeEventListener('waiting', onWaiting)
      video.removeEventListener('timeupdate', onTick)
      video.removeEventListener('progress', onTick)
      file.stop()
      tracks.clear()
      video.srcObject = null
      video.removeAttribute('src')
      video.load()
      if (url) URL.revokeObjectURL(url)
    }
  }
}
