import { DecodedPicture, DecodedThumbs, FrameDecoder, type FrameSource, type ShownNote } from './frame-decoder'

export interface MediaMeta {
  width: number
  height: number
  duration: number
}

export type MediaStatus = { kind: 'load' | 'wait' | 'error'; text: string } | null

export interface MediaHooks {
  ready: (meta: MediaMeta) => void
  drawn: () => void
  angleReady: (i: number, meta: MediaMeta) => void
  playState: () => void
  shown: (angle: number, note: ShownNote) => void
  status: (s: MediaStatus) => void
  buffered: (seconds: number) => void
  angleOut: (i: number, out: boolean) => void
  thumb: () => void
  log: (line: string) => void
  failed: (message: string) => boolean
}

export interface PlayerMedia {
  readonly kind: 'decoded' | 'element'
  readonly ready: boolean
  readonly playing: boolean
  rate: number
  loop: boolean
  mount: (contents: HTMLElement[]) => void
  seek: (f: number) => void
  play: () => void
  pause: () => void
  time: () => number
  tick: () => void
  angleFrames: () => number[]
  shownFrame: () => number
  thumb: (f: number | null, h: number) => HTMLCanvasElement | null
  retry: () => void
  info: () => Record<string, unknown>
  dispose: () => void
}

export interface MediaAngle {
  src: string
  source?: FrameSource | null
  decoder?: FrameDecoder | null
  offset: number
}

const HIDDEN_VIDEO = 'position:fixed;left:0;top:0;width:2px;height:2px;opacity:0;pointer-events:none'
const preloadFor = (src: string): 'auto' | 'metadata' => (src.includes('/media-stream/') ? 'metadata' : 'auto')
const LAZY_DATA = typeof navigator !== 'undefined' && /AppleWebKit/.test(navigator.userAgent) && !/Chrome|Chromium|Electron/.test(navigator.userAgent)
const clamp = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, v))
const nameOf = (src: string): string => decodeURIComponent(src.split('?')[0].split('/').pop() ?? src) || 'the video'

function primeData(v: HTMLVideoElement): void {
  if (!LAZY_DATA || v.readyState >= 2) return
  const p = v.play()
  v.pause()
  p?.catch(() => {})
}

function dropVideo(v: HTMLVideoElement): void {
  v.pause()
  v.removeAttribute('src')
  v.load()
}

class ElementThumbs {
  cache = new Map<number, HTMLCanvasElement>()
  wanted: number[] = []
  busy = false
  loaded = false
  th = 0
  cur = 0
  v: HTMLVideoElement

  constructor(
    src: string,
    private fps: number,
    private onReady: () => void,
    parent: HTMLElement
  ) {
    const v = document.createElement('video')
    v.muted = true
    v.preload = preloadFor(src)
    v.playsInline = true
    v.style.cssText = HIDDEN_VIDEO
    v.src = src
    parent.appendChild(v)
    this.v = v
    v.addEventListener('loadedmetadata', () => primeData(v))
    v.addEventListener('loadeddata', () => {
      this.loaded = true
      this.pump()
    })
    v.addEventListener('seeked', () => this.grab())
  }

  setSize(th: number): void {
    if (th === this.th) return
    this.th = th
    this.cache.clear()
  }

  want(list: number[]): void {
    this.wanted = list
    this.pump()
  }

  dispose(): void {
    this.wanted = []
    this.cache.clear()
    this.onReady = () => {}
    dropVideo(this.v)
    this.v.remove()
  }

  pump(): void {
    if (!this.loaded || this.busy || !this.th) return
    const f = this.wanted.find((x) => !this.cache.has(x))
    if (f === undefined) return
    this.busy = true
    this.cur = f
    this.v.currentTime = (f + 0.5) / this.fps
  }

  grab(): void {
    const dpr = devicePixelRatio
    const c = document.createElement('canvas')
    c.height = Math.round(this.th * dpr)
    c.width = Math.round(c.height * (this.v.videoWidth / this.v.videoHeight))
    c.getContext('2d')?.drawImage(this.v, 0, 0, c.width, c.height)
    this.cache.set(this.cur, c)
    if (this.cache.size > 120) this.cache.delete(this.cache.keys().next().value as number)
    this.busy = false
    this.onReady()
    this.pump()
  }
}

interface ElementAngle {
  video: HTMLVideoElement
  offset: number
  n: number
  pending: boolean
}

export class ElementMedia implements PlayerMedia {
  readonly kind = 'element'
  ready = false
  private video!: HTMLVideoElement
  private angles: ElementAngle[] = []
  private want = 0
  private thumbs: ElementThumbs | null = null
  private stateT = 0
  private offs: (() => void)[] = []
  private disposed = false
  private everLoaded = false

  constructor(
    private hooks: MediaHooks,
    private list: MediaAngle[],
    private fps: number,
    private parent: HTMLElement
  ) {}

  get playing(): boolean {
    return !!this.video && !this.video.paused && !this.video.ended
  }

  get rate(): number {
    return this.video?.playbackRate ?? 1
  }

  set rate(r: number) {
    if (this.video) this.video.playbackRate = r
    this.syncAngles()
  }

  get loop(): boolean {
    return !!this.video?.loop
  }

  set loop(on: boolean) {
    if (this.video) this.video.loop = on
  }

  private listen(target: EventTarget, type: string, fn: (e: Event) => void): void {
    target.addEventListener(type, fn)
    this.offs.push(() => target.removeEventListener(type, fn))
  }

  mount(contents: HTMLElement[]): void {
    contents.forEach((content, i) => {
      const v = document.createElement('video')
      v.preload = 'auto'
      v.playsInline = true
      v.muted = true
      content.appendChild(v)
      const a = this.list[i]
      if (i === 0) this.video = v
      else this.angles.push({ video: v, offset: a.offset, n: 1, pending: false })
    })
    this.bindMain()
    this.angles.forEach((a, k) => this.bindAngle(a, k + 1))
  }

  private bindMain(): void {
    const v = this.video
    const src = this.list[0]?.src ?? ''
    const name = nameOf(src)
    this.listen(v, 'error', () => {
      const code = v.error?.code
      if (!code || code === 1 || this.disposed) return
      const why = code === 2 ? 'The connection dropped while it loaded.' : code === 3 ? 'The file looks damaged.' : "The file is damaged or in a format this browser can't play."
      this.hooks.status({ kind: 'error', text: `Can't play ${name}. ${why}` })
    })
    this.listen(v, 'loadedmetadata', () => {
      primeData(v)
      this.everLoaded = true
      this.hooks.ready({ width: v.videoWidth, height: v.videoHeight, duration: v.duration })
      this.ready = true
    })
    this.listen(v, 'loadeddata', () => this.hooks.drawn())
    if (LAZY_DATA)
      this.listen(v, 'loadeddata', () => {
        if (!this.playing) v.currentTime = (this.want + 0.5) / this.fps
      })
    this.listen(v, 'seeked', () => {
      const got = Math.floor(v.currentTime * this.fps + 1e-4)
      if (!this.playing && got !== this.want) v.currentTime = (this.want + 0.5) / this.fps
      else this.hooks.shown(0, { want: this.want, shown: got, ms: 0 })
    })
    for (const t of ['play', 'pause', 'ended']) this.listen(v, t, () => {
      this.syncAngles()
      this.hooks.playState()
    })
    const clear = (): void => {
      window.clearTimeout(this.stateT)
      if (!v.error) this.hooks.status(null)
    }
    const later = (): void => {
      window.clearTimeout(this.stateT)
      this.stateT = window.setTimeout(() => {
        if (this.disposed || v.error) return
        if (v.seeking || (!v.paused && v.readyState < 3)) this.hooks.status({ kind: 'wait', text: v.seeking ? 'Loading this frame' : 'Buffering' })
      }, 500)
    }
    for (const t of ['loadeddata', 'canplay', 'seeked', 'playing']) this.listen(v, t, clear)
    this.listen(v, 'waiting', later)
    this.listen(v, 'seeking', later)
    this.hooks.status({ kind: 'load', text: 'Loading the video' })
    if (src) {
      v.preload = preloadFor(src)
      v.src = src
    }
  }

  private bindAngle(a: ElementAngle, i: number): void {
    const v = a.video
    this.listen(v, 'loadedmetadata', () => {
      a.n = Math.max(1, Math.round(v.duration * this.fps))
      this.hooks.angleReady(i, { width: v.videoWidth, height: v.videoHeight, duration: v.duration })
      this.syncAngles()
    })
    this.listen(v, 'seeked', () => {
      if (a.pending) {
        a.pending = false
        this.syncAngles()
      } else this.hooks.shown(i, { want: this.want, shown: Math.floor(v.currentTime * this.fps + 1e-4), ms: 0 })
    })
    const src = this.list[i]?.src
    if (src) {
      v.preload = preloadFor(src)
      v.src = src
    }
  }

  private syncAngles(): void {
    if (!this.angles.length || !this.video) return
    const playing = this.playing
    const base = playing ? this.video.currentTime : (this.want + 0.5) / this.fps
    this.angles.forEach((a, k) => {
      const v = a.video
      if (v.readyState < 1) return
      const raw = base + a.offset
      const frame = clamp(Math.floor(raw * this.fps + 1e-4), 0, a.n - 1)
      const out = raw < 0 || raw >= v.duration - 0.5 / this.fps
      this.hooks.angleOut(k + 1, out)
      if (!playing || out) {
        if (!v.paused) v.pause()
        const t = (frame + 0.5) / this.fps
        if (Math.abs(v.currentTime - t) > 0.25 / this.fps) {
          if (v.seeking) a.pending = true
          else v.currentTime = t
        }
        return
      }
      if (v.playbackRate !== this.video.playbackRate) v.playbackRate = this.video.playbackRate
      if (Math.abs(v.currentTime - raw) > 2 / this.fps && !v.seeking) v.currentTime = raw
      if (v.paused) v.play().catch(() => {})
    })
  }

  seek(f: number): void {
    if (!this.video) return
    this.want = f
    if (LAZY_DATA && this.video.readyState < 2) primeData(this.video)
    else if (!this.video.seeking || this.playing) this.video.currentTime = (f + 0.5) / this.fps
    this.syncAngles()
  }

  play(): void {
    this.video?.play().catch(() => {})
  }

  tick(): void {
    this.syncAngles()
  }

  pause(): void {
    this.video?.pause()
  }

  time(): number {
    return this.video?.currentTime ?? 0
  }

  angleFrames(): number[] {
    const own = (v: HTMLVideoElement): number => Math.floor(v.currentTime * this.fps + 1e-4)
    return this.video ? [own(this.video), ...this.angles.map((a) => own(a.video))] : []
  }

  shownFrame(): number {
    return this.video ? Math.floor(this.video.currentTime * this.fps + 1e-4) : -1
  }

  thumb(f: number | null, h: number): HTMLCanvasElement | null {
    if (!this.thumbs && this.ready && f != null) {
      this.thumbs = new ElementThumbs(this.list[0]?.src ?? '', this.fps, () => this.hooks.thumb(), this.parent)
      this.thumbs.setSize(h)
    }
    if (!this.thumbs) return null
    this.thumbs.want(f == null ? [] : [f])
    return f == null ? null : nearest(this.thumbs.cache, f, this.fps)
  }

  retry(): void {
    const v = this.video
    const src = this.list[0]?.src
    if (!v || !src) return
    this.hooks.status({ kind: 'load', text: 'Loading the video' })
    const at = this.want
    dropVideo(v)
    v.src = src
    if (this.everLoaded) v.addEventListener('loadedmetadata', () => this.seek(at), { once: true })
  }

  info(): Record<string, unknown> {
    return { kind: this.kind, src: nameOf(this.list[0]?.src ?? ''), readyState: this.video?.readyState ?? 0 }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    window.clearTimeout(this.stateT)
    for (const off of this.offs) off()
    this.offs = []
    this.thumbs?.dispose()
    this.thumbs = null
    for (const a of this.angles) dropVideo(a.video)
    if (this.video) dropVideo(this.video)
  }
}

function nearest(cache: Map<number, HTMLCanvasElement>, f: number, fps: number): HTMLCanvasElement | null {
  const hit = cache.get(f)
  if (hit) return hit
  let best: HTMLCanvasElement | null = null
  let d = Infinity
  for (const [k, c] of cache) {
    if (Math.abs(k - f) < d) {
      d = Math.abs(k - f)
      best = c
    }
  }
  return d > fps * 2 ? null : best
}

interface Lane {
  source: FrameSource | null
  offset: number
  dec: FrameDecoder | null
  pic: DecodedPicture | null
  content: HTMLElement | null
  out: boolean
  error: string
  told: boolean
}

const SLOW_OPEN_MS = 400

export class DecodedMedia implements PlayerMedia {
  readonly kind = 'decoded'
  rate = 1
  loop = false
  private lanes: Lane[]
  private opening: Promise<boolean> | null = null
  private want = 0
  private clock: { wall: number; media: number; last: number } | null = null
  private raf = 0
  private thumbs: DecodedThumbs | null = null
  private waiting: number | null = null
  private limited = false
  private disposed = false
  private offs: (() => void)[] = []
  private intent: 'seek' | 'play' = 'seek'
  private failed = ''
  private group: { busy: boolean; want: number | null; held: number | null } = { busy: false, want: null, held: null }

  constructor(
    private hooks: MediaHooks,
    list: MediaAngle[],
    private fps: number
  ) {
    this.lanes = list.map((a) => ({ source: a.source ?? null, offset: a.offset, dec: a.decoder ?? null, pic: null, content: null, out: false, error: '', told: false }))
  }

  get ready(): boolean {
    return !!this.lanes[0]?.pic
  }

  get playing(): boolean {
    return !!this.clock
  }

  mount(contents: HTMLElement[]): void {
    contents.forEach((c, i) => {
      if (this.lanes[i]) this.lanes[i].content = c
    })
    for (const [i, l] of this.lanes.entries()) if (l.dec) this.attach(i, l)
    if (this.lanes.some((l) => !l.dec && l.source?.eager)) void this.open()
    else if (this.lanes.every((l) => l.dec)) this.afterOpen()
  }

  private attach(i: number, l: Lane): void {
    if (!l.dec || l.pic || !l.content) return
    const pic = new DecodedPicture(l.dec, {
      drawn: () => {
        if (i === 0) this.hooks.drawn()
      },
      shown: (n) => this.hooks.shown(i, n),
      waiting: (f) => {
        if (i === 0) this.noteWaiting(f)
      },
      error: (m) => this.fail(i, m)
    })
    l.pic = pic
    l.content.appendChild(pic.canvas)
    this.offs.push(
      l.dec.bytes.onMore(() => {
        this.noteBuffered()
        if (this.group.held != null && !this.group.busy) {
          this.group.want ??= this.group.held
          void this.showAll()
        }
      })
    )
  }

  private fail(i: number, m: string): void {
    const l = this.lanes[i]
    if (!l || l.error) return
    l.error = m
    this.hooks.log(`${i ? `angle ${i + 1}` : 'video'} failed: ${m}`)
    if (i === 0) {
      if (!this.ready && this.hooks.failed(m)) return
      this.failed = m
      this.stopClock()
      this.hooks.status({ kind: 'error', text: `Can't show this video: ${m}` })
      this.hooks.playState()
    }
  }

  private open(): Promise<boolean> {
    if (this.opening) return this.opening
    const started = performance.now()
    const slow = window.setTimeout(() => {
      if (!this.ready && !this.disposed) this.hooks.status({ kind: 'load', text: this.lanes[0]?.source?.eager ? 'Opening the video' : 'Starting the download' })
    }, SLOW_OPEN_MS)
    this.opening = Promise.all(
      this.lanes.map(async (l, i) => {
        if (l.dec || !l.source) return
        try {
          l.dec = await FrameDecoder.open(l.source, this.fps)
          if (this.disposed) {
            l.dec.dispose()
            return
          }
          this.attach(i, l)
          const d = l.dec.info
          this.hooks.log(`${i ? `angle ${i + 1} (${l.source.name})` : 'opened'}: WebCodecs ${d.codec} ${d.width}x${d.height}, ${d.fps} fps, ${d.duration.toFixed(2)} s, a key frame every ${d.keyEvery || '?'} frames, open in ${Math.round(performance.now() - started)} ms`)
        } catch (e) {
          this.fail(i, e instanceof Error ? e.message : String(e))
        }
      })
    ).then(() => {
      window.clearTimeout(slow)
      if (this.disposed) return false
      this.afterOpen()
      return !this.failed
    })
    return this.opening
  }

  private afterOpen(): void {
    const intent = this.intent
    for (const [i, l] of this.lanes.entries()) {
      if (!l.dec || l.told) continue
      l.told = true
      const meta = { width: l.dec.info.width, height: l.dec.info.height, duration: l.dec.info.duration }
      if (i === 0) this.hooks.ready(meta)
      else this.hooks.angleReady(i, meta)
    }
    if (this.failed || !this.ready) return
    if (this.waiting == null) this.hooks.status(null)
    this.noteBuffered()
    if (intent === 'play') this.play()
    else this.seek(this.want)
  }

  private noteBuffered(): void {
    const d = this.lanes[0]?.dec
    if (!d) return
    const a = d.available()
    this.hooks.buffered(a === Infinity ? d.info.duration : Math.min(a, d.info.duration))
  }

  private noteWaiting(f: number | null): void {
    this.waiting = f
    if (f == null) {
      if (!this.failed && !this.limited) this.hooks.status(null)
    } else this.hooks.status({ kind: 'wait', text: `Waiting for the download to reach F ${f}` })
  }

  private dur(l: Lane): number {
    return l.dec?.info.duration ?? 0
  }

  private laneFrame(l: Lane, f: number, i: number): number {
    if (!i || !l.dec || !l.pic) return f
    const t = (f + 0.5) / this.fps + l.offset
    return clamp(Math.floor(t * this.fps + 1e-4), 0, l.pic.frames() - 1)
  }

  private laneOut(l: Lane, t: number): boolean {
    return t < 0 || t >= this.dur(l) - 0.5 / this.fps
  }

  seek(f: number): void {
    this.want = f
    this.intent = 'seek'
    if (this.failed) return
    if (!this.ready) {
      void this.open()
      return
    }
    if (this.clock) {
      this.startClock(this.timeOfFrame(f))
      return
    }
    this.lanes.forEach((l, i) => {
      if (!l.pic || !i) return
      const out = this.laneOut(l, (f + 0.5) / this.fps + l.offset)
      if (out !== l.out) {
        l.out = out
        this.hooks.angleOut(i, out)
      }
    })
    const live = this.lanes.filter((l) => l.pic)
    if (live.length < 2) {
      this.lanes[0].pic?.show(f)
      return
    }
    this.group.want = f
    void this.showAll()
  }

  private async showAll(): Promise<void> {
    const g = this.group
    if (g.busy) return
    g.busy = true
    try {
      while (g.want != null && !this.clock && !this.disposed) {
        const f = g.want
        const lanes = this.lanes.map((l, i) => ({ l, i, frame: this.laneFrame(l, f, i) })).filter((x) => x.l.pic && !x.l.pic.at(x.frame))
        if (!lanes.length) {
          g.want = null
          continue
        }
        if (!lanes.every((x) => x.l.pic!.has(x.frame))) {
          if (g.held !== f) {
            g.held = f
            this.noteWaiting(f)
          }
          return
        }
        if (g.held != null) {
          g.held = null
          this.noteWaiting(null)
        }
        g.want = null
        const t0 = performance.now()
        const got = await Promise.all(lanes.map((x) => x.l.pic!.fetch(x.frame).catch((e: unknown) => (this.fail(x.i, e instanceof Error ? e.message : String(e)), null))))
        const ms = performance.now() - t0
        if (this.clock || this.disposed) {
          got.forEach((s) => s?.close())
          return
        }
        lanes.forEach((x, k) => x.l.pic!.commit(x.frame, got[k], ms))
      }
    } finally {
      g.busy = false
    }
  }

  private timeOfFrame(f: number): number {
    return clamp((f + 0.5) / this.fps, 0, Math.max(0, this.dur(this.lanes[0]) - 0.5 / this.fps))
  }

  play(): void {
    this.intent = 'play'
    if (this.failed) return
    if (!this.ready) {
      void this.open()
      return
    }
    const main = this.lanes[0]
    let t = this.timeOfFrame(this.want)
    if (t >= this.dur(main) - 1 / this.fps) t = 0
    this.startClock(t)
    this.hooks.playState()
  }

  private startClock(t: number): void {
    cancelAnimationFrame(this.raf)
    const now = performance.now()
    this.clock = { wall: now, media: t, last: t }
    this.lanes.forEach((l, i) => {
      if (!l.pic) return
      const lt = t + (i ? l.offset : 0)
      if (i && this.laneOut(l, lt)) {
        l.pic.stop()
        l.pic.show(this.laneFrame(l, Math.floor(t * this.fps), i))
        if (!l.out) this.hooks.angleOut(i, (l.out = true))
        return
      }
      if (i && l.out) this.hooks.angleOut(i, (l.out = false))
      l.pic.play(Math.max(0, lt))
    })
    this.raf = requestAnimationFrame(this.step)
  }

  private step = (now: number): void => {
    const c = this.clock
    const main = this.lanes[0]
    if (!c || !main.pic || this.disposed) return
    let t = c.media + ((now - c.wall) / 1000) * this.rate
    const end = this.dur(main)
    if (t >= end - 0.5 / this.fps) {
      if (this.loop) {
        this.startClock(0)
        return
      }
      this.want = Math.max(0, Math.round(end * this.fps) - 1)
      this.stopClock()
      this.seek(this.want)
      this.hooks.playState()
      return
    }
    const avail = main.dec?.available() ?? 0
    if (t > avail - 0.05) {
      t = Math.max(c.last, avail - 0.05)
      c.media = t
      c.wall = now
      if (!this.limited) {
        this.limited = true
        this.hooks.status({ kind: 'wait', text: 'Waiting for the download' })
      }
    } else if (this.limited) {
      this.limited = false
      if (this.waiting == null && !this.failed) this.hooks.status(null)
    }
    let behind = false
    this.lanes.forEach((l, i) => {
      if (!l.pic) return
      const lt = t + (i ? l.offset : 0)
      if (i) {
        const out = this.laneOut(l, lt)
        if (out !== l.out) {
          l.out = out
          this.hooks.angleOut(i, out)
          if (out) {
            l.pic.stop()
            l.pic.show(this.laneFrame(l, Math.floor(t * this.fps), i))
          } else l.pic.play(Math.max(0, lt))
          return
        }
        if (out) return
      }
      if (l.pic.present(lt) === 'behind') behind = true
    })
    if (behind) {
      c.media = c.last
      c.wall = now
    } else c.last = t
    this.raf = requestAnimationFrame(this.step)
  }

  private stopClock(): void {
    cancelAnimationFrame(this.raf)
    if (!this.clock) return
    this.clock = null
    this.limited = false
    for (const l of this.lanes) l.pic?.stop()
  }

  pause(): void {
    this.intent = 'seek'
    if (!this.clock) return
    const t = this.clock.last
    this.stopClock()
    this.want = Math.floor(t * this.fps + 1e-4)
    this.hooks.playState()
  }

  tick(): void {}

  time(): number {
    if (this.clock) return this.clock.last
    return (this.want + 0.5) / this.fps
  }

  angleFrames(): number[] {
    return this.lanes.map((l) => l.pic?.shown ?? -1)
  }

  shownFrame(): number {
    return this.lanes[0]?.pic?.shown ?? -1
  }

  thumb(f: number | null, h: number): HTMLCanvasElement | null {
    const d = this.lanes[0]?.dec
    if (!d) return null
    if (!this.thumbs) {
      this.thumbs = new DecodedThumbs(d, () => this.hooks.thumb())
      this.thumbs.setSize(h)
    }
    this.thumbs.wantFrame(f)
    return f == null ? null : nearest(this.thumbs.cache, f, this.fps)
  }

  retry(): void {
    if (!this.failed) return
    this.failed = ''
    this.opening = null
    for (const l of this.lanes) {
      if (!l.error) continue
      l.error = ''
      l.told = false
      l.pic?.dispose()
      l.pic?.canvas.remove()
      l.pic = null
      l.dec?.dispose()
      l.dec = null
    }
    void this.open()
  }

  info(): Record<string, unknown> {
    const d = this.lanes[0]?.dec?.info
    return {
      kind: this.kind,
      codec: d?.codec ?? null,
      size: d ? `${d.width}x${d.height}` : null,
      fps: d?.fps ?? this.fps,
      duration: d?.duration ?? null,
      keyEvery: d?.keyEvery ?? null,
      buffered: this.lanes[0]?.dec ? Math.min(this.lanes[0].dec.available(), d?.duration ?? 0) : 0,
      waitingFor: this.waiting,
      error: this.failed || null
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.stopClock()
    for (const off of this.offs) off()
    this.offs = []
    this.thumbs?.dispose()
    for (const l of this.lanes) {
      l.pic?.dispose()
      l.dec?.dispose()
    }
  }
}
