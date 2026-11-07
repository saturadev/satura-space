import { CustomSource, EncodedPacketSink, Input, MATROSKA, MP4, QTFF, VideoSampleSink, WEBM, type InputVideoTrack, type VideoSample } from 'mediabunny'
import { coveredBy, videoCoverage, type Coverage } from './mp4-coverage'

export interface FrameBytes {
  size: number
  read: (start: number, end: number) => Promise<Uint8Array>
  have: () => number
  done: () => boolean
  onMore: (cb: () => void) => () => void
  close?: () => void
}

export interface FrameSource {
  name: string
  eager: boolean
  open: () => Promise<FrameBytes>
}

export interface DecoderInfo {
  width: number
  height: number
  duration: number
  first: number
  fps: number
  codec: string
  keyEvery: number
}

const KNOWN_FPS = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 72, 90, 100, 120, 144, 240]
const BLOCK = 256 * 1024
const BLOCKS_KEPT = 48

export function snapFps(raw: number): number {
  if (!(raw > 0)) return 30
  const snap = KNOWN_FPS.reduce((best, f) => (Math.abs(f - raw) < Math.abs(best - raw) ? f : best))
  return Math.abs(snap - raw) / snap < 0.012 ? snap : Math.round(raw)
}

async function stepRate(packets: EncodedPacketSink): Promise<number> {
  const steps: number[] = []
  let prev: number | null = null
  for await (const p of packets.packets(undefined, undefined, { metadataOnly: true })) {
    if (prev != null && p.timestamp > prev) steps.push(p.timestamp - prev)
    prev = p.timestamp
    if (steps.length >= 240) break
  }
  if (!steps.length) return 0
  steps.sort((a, b) => a - b)
  return 1 / steps[Math.floor(steps.length / 2)]
}

export function canDecodeFrames(codec?: string): Promise<boolean> {
  if (typeof VideoDecoder !== 'function' || !codec) return Promise.resolve(false)
  return VideoDecoder.isConfigSupported({ codec }).then(
    (r) => !!r.supported,
    () => false
  )
}

class BlockReader {
  private blocks = new Map<number, Promise<Uint8Array>>()
  reads = 0
  readMs = 0

  constructor(private bytes: FrameBytes) {}

  async read(start: number, end: number): Promise<Uint8Array> {
    const first = Math.floor(start / BLOCK)
    const last = Math.floor((end - 1) / BLOCK)
    const parts: Uint8Array[] = []
    for (let i = first; i <= last; i++) parts.push(await this.block(i, Math.min(BLOCK, end - i * BLOCK)))
    if (parts.length === 1) return parts[0].subarray(start - first * BLOCK, end - first * BLOCK)
    const out = new Uint8Array(end - start)
    parts.forEach((b, k) => {
      const base = (first + k) * BLOCK
      const from = Math.max(0, start - base)
      const to = Math.min(b.length, end - base)
      if (to > from) out.set(b.subarray(from, to), base + from - start)
    })
    return out
  }

  private async block(i: number, need: number): Promise<Uint8Array> {
    const hit = this.blocks.get(i)
    if (hit) {
      const data = await hit.catch(() => null)
      if (data && data.length >= need) {
        if (this.blocks.get(i) === hit) {
          this.blocks.delete(i)
          this.blocks.set(i, hit)
        }
        return data
      }
      if (this.blocks.get(i) === hit) this.blocks.delete(i)
    }
    const from = i * BLOCK
    const full = Math.min(this.bytes.size, from + BLOCK) - from
    const ready = this.bytes.done() ? full : Math.max(0, Math.min(full, this.bytes.have() - from))
    const t0 = performance.now()
    const job = this.bytes.read(from, from + Math.max(need, ready)).then((d) => {
      this.reads++
      this.readMs += performance.now() - t0
      return d
    })
    this.blocks.set(i, job)
    job.catch(() => {
      if (this.blocks.get(i) === job) this.blocks.delete(i)
    })
    while (this.blocks.size > BLOCKS_KEPT) this.blocks.delete(this.blocks.keys().next().value as number)
    return job
  }
}

export class FrameDecoder {
  disposed = false

  private constructor(
    readonly bytes: FrameBytes,
    readonly input: Input,
    readonly track: InputVideoTrack,
    readonly sink: VideoSampleSink,
    readonly info: DecoderInfo,
    private coverage: Coverage | null,
    private reader: BlockReader
  ) {}

  io(): { reads: number; readMs: number } {
    return { reads: this.reader.reads, readMs: this.reader.readMs }
  }

  static async open(source: FrameSource, fps?: number): Promise<FrameDecoder> {
    if (typeof VideoDecoder !== 'function') throw new Error('this browser has no WebCodecs video decoder')
    const bytes = await source.open()
    const reader = new BlockReader(bytes)
    const input = new Input({
      formats: [MP4, QTFF, WEBM, MATROSKA],
      source: new CustomSource({ getSize: () => bytes.size, read: (s, e) => reader.read(s, e), prefetchProfile: 'none', maxCacheSize: 4 * 1024 * 1024 })
    })
    try {
      const track = await input.getPrimaryVideoTrack()
      if (!track) throw new Error('the file has no video track')
      const codec = (await track.getCodecParameterString()) ?? track.codec ?? 'unknown'
      if (!(await track.canDecode())) throw new Error(`this browser can't decode ${codec}`)
      const width = await track.getDisplayWidth()
      const height = await track.getDisplayHeight()
      const first = await track.getFirstTimestamp()
      const duration = await track.computeDuration()
      const packets = new EncodedPacketSink(track)
      let rate = Number(fps)
      if (!(rate > 0)) rate = snapFps((await stepRate(packets)) || (await track.computePacketStats(240)).averagePacketRate)
      const k0 = await packets.getFirstKeyPacket({ metadataOnly: true })
      const k1 = k0 && (await packets.getNextKeyPacket(k0, { metadataOnly: true }))
      const keyEvery = k0 && k1 ? Math.max(1, Math.round((k1.timestamp - k0.timestamp) * rate)) : 0
      const coverage = bytes.done() ? null : await videoCoverage((s, e) => reader.read(s, e), bytes.size)
      return new FrameDecoder(bytes, input, track, new VideoSampleSink(track), { width, height, duration, first, fps: rate, codec, keyEvery }, coverage, reader)
    } catch (e) {
      input.dispose()
      bytes.close?.()
      throw e
    }
  }

  available(): number {
    if (this.bytes.done()) return Infinity
    return this.coverage ? coveredBy(this.coverage, this.bytes.have()) : 0
  }

  sample(t: number): Promise<VideoSample | null> {
    return this.sink.getSample(Math.max(this.info.first, t))
  }

  samples(t: number): AsyncGenerator<VideoSample, void, unknown> {
    return this.sink.samples(Math.max(this.info.first, t))
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.input.dispose()
    this.bytes.close?.()
  }
}

export interface ShownNote {
  want: number
  shown: number
  ms: number
  reads?: number
  readMs?: number
}

export interface PictureHooks {
  drawn: () => void
  shown: (n: ShownNote) => void
  waiting: (frame: number | null) => void
  error: (message: string) => void
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export class DecodedPicture {
  readonly canvas: HTMLCanvasElement
  shown = -1
  drawn = false
  private ctx: CanvasRenderingContext2D | null
  private want = -1
  private settled = -1
  private busy = false
  private held = -1
  private disposed = false
  private stream: AsyncGenerator<VideoSample, void, unknown> | null = null
  private queue: VideoSample[] = []
  private pumping = -1
  private ended = false
  private gen = 0
  private offMore: () => void

  constructor(
    readonly dec: FrameDecoder,
    private hooks: PictureHooks
  ) {
    const c = document.createElement('canvas')
    c.width = dec.info.width
    c.height = dec.info.height
    this.canvas = c
    this.ctx = c.getContext('2d', { alpha: false })
    this.offMore = dec.bytes.onMore(() => {
      if (this.held >= 0 && !this.stream) void this.run()
    })
  }

  get fps(): number {
    return this.dec.info.fps
  }

  frames(): number {
    return Math.max(1, Math.round(this.dec.info.duration * this.fps))
  }

  timeOf(f: number): number {
    return Math.min(Math.max(0, (f + 0.5) / this.fps), Math.max(0, this.dec.info.duration - 0.25 / this.fps))
  }

  frameOf(t: number): number {
    return Math.round(t * this.fps)
  }

  waitingFor(): number {
    return this.held
  }

  show(f: number): void {
    if (this.disposed) return
    this.stop()
    this.want = f
    if (f === this.settled && this.held < 0) return
    if (!this.busy) void this.run()
  }

  at(f: number): boolean {
    return f === this.settled && this.held < 0 && !this.stream
  }

  has(f: number): boolean {
    return this.timeOf(f) <= this.dec.available()
  }

  fetch(f: number): Promise<VideoSample | null> {
    return this.dec.sample(this.timeOf(f))
  }

  commit(f: number, s: VideoSample | null, ms: number): void {
    if (this.disposed) {
      s?.close()
      return
    }
    this.stop()
    if (s) {
      this.draw(s)
      s.close()
    }
    this.want = f
    this.settled = f
    this.hooks.shown({ want: f, shown: this.shown, ms })
  }

  private draw(s: VideoSample): void {
    if (!this.ctx) return
    s.drawWithFit(this.ctx, { fit: 'fill' })
    this.shown = this.frameOf(s.timestamp)
    if (this.drawn) return
    this.drawn = true
    this.hooks.drawn()
  }

  private async run(): Promise<void> {
    if (this.busy || this.disposed) return
    this.busy = true
    try {
      while (!this.disposed && !this.stream && this.want >= 0 && this.want !== this.settled) {
        const f = this.want
        const t = this.timeOf(f)
        if (t > this.dec.available()) {
          if (this.held !== f) {
            this.held = f
            this.hooks.waiting(f)
          }
          return
        }
        if (this.held >= 0) {
          this.held = -1
          this.hooks.waiting(null)
        }
        const t0 = performance.now()
        const io = this.dec.io()
        const s = await this.dec.sample(t)
        if (this.disposed || this.stream) {
          s?.close()
          return
        }
        if (s) {
          this.draw(s)
          s.close()
        }
        this.settled = f
        const after = this.dec.io()
        this.hooks.shown({ want: f, shown: this.shown, ms: performance.now() - t0, reads: after.reads - io.reads, readMs: after.readMs - io.readMs })
      }
    } catch (e) {
      if (!this.disposed) this.hooks.error(errText(e))
    } finally {
      this.busy = false
    }
  }

  play(t: number): void {
    this.stop()
    if (this.held >= 0) {
      this.held = -1
      this.hooks.waiting(null)
    }
    const my = ++this.gen
    this.ended = false
    this.stream = this.dec.samples(t)
    void this.pump(my)
  }

  private async pump(my: number): Promise<void> {
    if (this.pumping === my) return
    this.pumping = my
    try {
      while (my === this.gen && this.stream && this.queue.length < 2) {
        const r = await this.stream.next()
        if (my !== this.gen) {
          if (!r.done) r.value.close()
          return
        }
        if (r.done) {
          this.ended = true
          return
        }
        this.queue.push(r.value)
      }
    } catch (e) {
      if (my === this.gen && !this.disposed) this.hooks.error(errText(e))
    } finally {
      if (this.pumping === my) this.pumping = -1
    }
  }

  present(t: number): 'ok' | 'behind' | 'end' {
    if (!this.stream) return 'ok'
    const q = this.queue
    while (q.length > 1 && q[1].timestamp <= t + 1e-6) q.shift()?.close()
    const s = q[0]
    let out: 'ok' | 'behind' | 'end' = 'ok'
    if (!s) out = this.ended ? 'end' : 'behind'
    else {
      if (s.timestamp <= t + 1e-6 && this.frameOf(s.timestamp) !== this.shown) this.draw(s)
      if (q.length === 1 && s.timestamp + s.duration <= t + 1e-6) out = this.ended ? 'end' : 'behind'
    }
    void this.pump(this.gen)
    return out
  }

  playing(): boolean {
    return !!this.stream
  }

  stop(): void {
    if (!this.stream) return
    const it = this.stream
    this.stream = null
    this.gen++
    for (const s of this.queue) s.close()
    this.queue = []
    void it.return(undefined).catch(() => undefined)
    this.want = this.shown
    this.settled = this.shown
  }

  dispose(): void {
    if (this.disposed) return
    this.stop()
    this.disposed = true
    this.offMore()
  }
}

export class DecodedThumbs {
  cache = new Map<number, HTMLCanvasElement>()
  private want: number | null = null
  private busy = false
  private th = 0
  private disposed = false

  constructor(
    private dec: FrameDecoder,
    private onReady: () => void
  ) {}

  setSize(th: number): void {
    if (th === this.th) return
    this.th = th
    this.cache.clear()
  }

  wantFrame(f: number | null): void {
    this.want = f
    if (!this.busy) void this.run()
  }

  private async run(): Promise<void> {
    this.busy = true
    try {
      while (!this.disposed && this.want != null && !this.cache.has(this.want) && this.th) {
        const f = this.want
        const t = Math.min((f + 0.5) / this.dec.info.fps, this.dec.info.duration - 0.001)
        if (t > this.dec.available()) return
        const s = await this.dec.sample(t)
        if (!s) {
          this.cache.set(f, document.createElement('canvas'))
          continue
        }
        const dpr = devicePixelRatio
        const c = document.createElement('canvas')
        c.height = Math.round(this.th * dpr)
        c.width = Math.round(c.height * (this.dec.info.width / this.dec.info.height))
        const ctx = c.getContext('2d')
        if (ctx) s.drawWithFit(ctx, { fit: 'fill' })
        s.close()
        if (this.disposed) return
        this.cache.set(f, c)
        if (this.cache.size > 120) this.cache.delete(this.cache.keys().next().value as number)
        this.onReady()
      }
    } catch {
    } finally {
      this.busy = false
    }
  }

  dispose(): void {
    this.disposed = true
    this.want = null
    this.cache.clear()
  }
}
