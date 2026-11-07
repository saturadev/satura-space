import { ZoomPan, attachGestures, clamp, cssZoom, esc, fmtTime, fromHtml, isMouseWheel, lineScale, typing, zoomLabel } from './zoom-pan'
import { swipeAxis, type SwipeAxis } from './seek-swipe'
import { FrameDecoder, snapFps, type FrameSource, type ShownNote } from './frame-decoder'
import { DecodedMedia, ElementMedia, type MediaAngle, type MediaMeta, type MediaStatus, type PlayerMedia } from './frame-media'

export interface PlayerEvent {
  label: string
  frame?: number
  t?: number
  kind?: string
}

export interface PlayerLogLine {
  msg: string
  level?: string
  frame?: number
  t?: number
  src?: string
}

export interface FramePlayerOptions {
  src: string
  source?: FrameSource | null
  fps?: number
  duration?: number
  aspect?: number
  poster?: string | null
  list?: boolean
  events?: PlayerEvent[]
  log?: PlayerLogLine[]
  initialFrame?: number
  onFrame?: (frame: number) => void
  onError?: (message: string) => void
  onExpand?: () => void
  onLog?: (line: string) => void
  label?: string
  angles?: AngleSource[]
}

export interface AngleSource {
  src: string
  source?: FrameSource | null
  label?: string
  offset?: number
}

interface Angle {
  i: number
  el: HTMLElement
  content: HTMLElement
  zp: ZoomPan
  offset: number
  n: number
}

interface Decode {
  at: number
  angle: number
  want: number
  shown: number
  ms: number
  reads?: number
  readMs?: number
}

const cores = new WeakMap<HTMLElement, FramePlayerCore>()

export function playerCore(el: Element | null): FramePlayerCore | null {
  return el instanceof HTMLElement ? (cores.get(el) ?? null) : null
}

const ICON = {
  play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15a1 1 0 0 0 1.5.86l12-7.5a1 1 0 0 0 0-1.72l-12-7.5A1 1 0 0 0 7 4.5z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4.5" height="16" rx="1"/><rect x="13.5" y="4" width="4.5" height="16" rx="1"/></svg>',
  stepB: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 6l-6 6 6 6"/></svg>',
  stepF: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>',
  evB: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6l-6 6 6 6"/><path d="M7 5v14"/></svg>',
  evF: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 6l6 6-6 6"/><path d="M17 5v14"/></svg>',
  loop: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 2l3 3-3 3"/><path d="M4 11V9a4 4 0 0 1 4-4h12"/><path d="M7 22l-3-3 3-3"/><path d="M20 13v2a4 4 0 0 1-4 4H4"/></svg>',
  expand: '<svg class="sr-i-expand" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg><svg class="sr-i-collapse" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/></svg>',
  help: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6"/><circle cx="12" cy="17" r=".6" fill="currentColor"/></svg>'
}

function wholeFrame(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0
}

const HIDDEN_VIDEO = 'position:fixed;left:0;top:0;width:2px;height:2px;opacity:0;pointer-events:none'
const PREVIEW_H = 96
const SETTLE_MS = 450
const DECODES_KEPT = 400

function estimateFps(src: string, parent: HTMLElement): { promise: Promise<number>; cancel: () => void } {
  let finish: () => void = () => {}
  const promise = new Promise<number>((resolve) => {
    const v = document.createElement('video') as HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: (now: number, meta: { presentedFrames: number; mediaTime: number }) => void) => number
    }
    if (!v.requestVideoFrameCallback) {
      resolve(30)
      return
    }
    v.muted = true
    v.playsInline = true
    v.preload = 'auto'
    v.style.cssText = HIDDEN_VIDEO
    const deltas: number[] = []
    let last: { presentedFrames: number; mediaTime: number } | null = null
    let done = false
    finish = (): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      v.pause()
      v.removeAttribute('src')
      v.load()
      v.remove()
      if (!deltas.length) return resolve(30)
      deltas.sort((a, b) => a - b)
      resolve(snapFps(1 / deltas[Math.floor(deltas.length / 2)]))
    }
    const timer = setTimeout(finish, 4000)
    const onFrame = (_now: number, meta: { presentedFrames: number; mediaTime: number }): void => {
      if (done) return
      if (last && meta.presentedFrames === last.presentedFrames + 1) {
        const d = meta.mediaTime - last.mediaTime
        if (d > 0.001) deltas.push(d)
      }
      last = meta
      if (deltas.length >= 12) finish()
      else v.requestVideoFrameCallback?.(onFrame)
    }
    v.addEventListener('error', finish)
    v.addEventListener('ended', finish)
    v.src = src
    parent.appendChild(v)
    v.requestVideoFrameCallback(onFrame)
    v.play().catch(finish)
  })
  return { promise, cancel: () => finish() }
}

type Refs = Record<string, HTMLElement> & { frameIn: HTMLInputElement; filter: HTMLInputElement }

interface TimedEvent extends PlayerEvent {
  frame: number
}

interface TimedLine extends PlayerLogLine {
  frame: number
}

export class FramePlayerCore {
  fps = 30
  frame = 0
  pos = 0
  n = 1
  ready = false
  disposed = false
  events: TimedEvent[] = []
  log: TimedLine[] = []
  media: PlayerMedia | null = null
  zp!: ZoomPan
  private r!: Refs
  private vp!: HTMLElement
  private root!: HTMLElement
  private offs: (() => void)[] = []
  private fpsProbe: { cancel: () => void } | null = null
  private pendingPlay = false
  private follow = true
  private listSeek = false
  private angles: Angle[] = []
  private focused: number | null = null
  private scrubbing = false
  private snapT = 0
  private autoScrolling = false
  private aspect = 16 / 9
  private hoverF: number | null = null
  private evEls: HTMLElement[] = []
  private logEls: HTMLElement[] = []
  private lastLogCur: HTMLElement | null = null
  private lastEvCur: HTMLElement | null = null
  private reportedFrame = -1
  private pendingGoto: { frame?: number; t?: number } | null = null
  private raf = 0
  private sized = false
  private status: MediaStatus = null
  private decodes: Decode[] = []
  private burst: Decode[] = []
  private burstT = 0
  private lastLine = ''
  private fellBack = ''

  constructor(
    private host: HTMLElement,
    private opts: FramePlayerOptions
  ) {
    cores.set(host, this)
    host.dataset.videoName = decodeURIComponent((opts.source?.name ?? opts.src).split('?')[0].split('/').pop() ?? '')
    const fps = Number(opts.fps)
    if (opts.source?.eager) this.openFirst(fps)
    else if (opts.source && fps > 0) this.start(fps)
    else if (fps > 0) this.start(fps)
    else this.probeFps()
  }

  private probe(text: string): void {
    this.host.querySelector(':scope > .srv-probe')?.remove()
    this.host.appendChild(fromHtml(`<div class="sr-scope srv-probe" data-probe><span>${esc(text)}</span><span class="srv-bar"><span></span></span></div>`))
  }

  private probeFps(): void {
    this.probe('Loading the video')
    const probe = estimateFps(this.opts.src, this.host)
    this.fpsProbe = probe
    void probe.promise.then((f) => {
      this.fpsProbe = null
      if (!this.disposed) this.start(f)
    })
  }

  private openFirst(fps: number): void {
    this.probe('Opening the video')
    const angles = this.opts.angles ?? []
    const list = [this.opts.source, ...angles.map((a) => a.source)]
    void Promise.all(list.map((s) => (s ? FrameDecoder.open(s, fps > 0 ? fps : undefined) : Promise.reject(new Error('no byte source'))))).then(
      (decs) => {
        if (this.disposed) {
          decs.forEach((d) => d.dispose())
          return
        }
        this.start(fps > 0 ? fps : decs[0].info.fps, decs)
      },
      (e: unknown) => {
        if (this.disposed) return
        const why = e instanceof Error ? e.message : String(e)
        this.fallBack(why, fps)
      }
    )
  }

  private fallBack(why: string, fps: number): void {
    this.fellBack = why
    if (!this.opts.src) {
      this.probe(`Can't show this video: ${why}`)
      this.host.querySelector('.srv-probe')?.setAttribute('data-probe', 'error')
      this.opts.onError?.(`Can't show this video: ${why}`)
      return
    }
    this.note(`plays through the video element: ${why}`)
    if (fps > 0) this.start(fps)
    else this.probeFps()
  }

  private start(fps: number, decoders?: FrameDecoder[]): void {
    this.fps = fps
    this.events = (this.opts.events ?? [])
      .map((m) => ({ ...m, frame: wholeFrame(m.frame ?? Math.round(Number(m.t ?? 0) * fps)) }))
      .sort((a, b) => a.frame - b.frame)
    this.log = (this.opts.log ?? []).map((l) => ({ ...l, frame: wholeFrame(l.frame ?? Math.floor(Number(l.t ?? 0) * fps)) }))
    this.build(decoders)
  }

  private note(line: string): void {
    if (line === this.lastLine) return
    this.lastLine = line
    const name = decodeURIComponent((this.opts.source?.name ?? this.opts.src).split('?')[0].split('/').pop() ?? '') || 'video'
    this.opts.onLog?.(`[video] ${name} ${line}`)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.fpsProbe?.cancel()
    cancelAnimationFrame(this.raf)
    clearTimeout(this.snapT)
    clearTimeout(this.burstT)
    for (const off of this.offs) off()
    this.offs = []
    this.zp?.dispose()
    for (const a of this.angles) a.zp.dispose()
    this.angles = []
    this.media?.dispose()
    this.media = null
    cores.delete(this.host)
    this.host.replaceChildren()
  }

  private listen<K extends keyof HTMLElementEventMap>(
    target: EventTarget,
    type: K | string,
    fn: (e: never) => void,
    opts?: AddEventListenerOptions
  ): void {
    const h = fn as unknown as EventListener
    target.addEventListener(type, h, opts)
    this.offs.push(() => target.removeEventListener(type, h, opts))
  }

  playFromStart(): void {
    if (!this.media || !this.sized) {
      this.pendingPlay = true
      return
    }
    this.seek(0)
    this.media.play()
  }

  private build(decoders?: FrameDecoder[]): void {
    const root = fromHtml(`
      <div class="srv">
        <div class="srv-main">
          <div class="sr-viewport" data-empty>
            <div class="sr-content"></div>
            <div class="srv-empty" data-r="empty"><span data-r="emptytext">Loading the video</span><span class="srv-bar"><span></span></span></div>
            <div class="sr-hud tr"><button class="sr-chip" data-r="zoom" title="Fit (0) · double-click toggles 1:1">Fit</button></div>
          </div>
          <div class="srv-transport">
            <button class="sr-btn" data-a="evB" title="Previous event (↑)">${ICON.evB}</button>
            <button class="sr-btn" data-a="stepB" title="Previous frame (←, ⇧← = 10)">${ICON.stepB}</button>
            <button class="sr-btn primary" data-a="play" title="Play / pause (Space)">${ICON.play}</button>
            <button class="sr-btn" data-a="stepF" title="Next frame (→, ⇧→ = 10)">${ICON.stepF}</button>
            <button class="sr-btn" data-a="evF" title="Next event (↓)">${ICON.evF}</button>
            <span class="sr-sep"></span>
            <label class="srv-frame">F <input data-r="frameIn" inputmode="numeric" spellcheck="false"> <span data-r="frameN">/ 0</span></label>
            <span class="srv-tc" data-r="tc">00:00.00</span>
            <span class="srv-status" data-r="status" hidden><span data-r="statustext"></span><button class="sr-btn" data-r="retry" hidden>Try again</button></span>
            <span class="srv-evnow" data-r="evnow" hidden><span class="sr-dot"></span><span></span></span>
            <span class="sr-spacer"></span>
            <div class="sr-seg srv-hide-narrow" data-r="speed">
              <button class="sr-btn" data-speed="0.25">¼×</button>
              <button class="sr-btn" data-speed="0.5">½×</button>
              <button class="sr-btn on" data-speed="1">1×</button>
              <button class="sr-btn" data-speed="2">2×</button>
            </div>
            <button class="sr-btn" data-a="loop" title="Loop">${ICON.loop}</button>
            ${this.opts.onExpand ? `<button class="sr-btn" data-a="expand" title="Full screen (F)">${ICON.expand}</button>` : ''}
            <button class="sr-btn" data-a="help" title="Gestures and keys (?)">${ICON.help}</button>
            <div class="sr-pop" data-r="help" popover="manual">
              <h4>Trackpad · over the video</h4>
              <dl>
                <dt>Pinch</dt><dd>zoom at the cursor, up to raw pixels</dd>
                <dt>Two-finger swipe ↔</dt><dd>step frames (zoomed: pan)</dd>
                <dt>⌥ + swipe</dt><dd>step frames while zoomed</dd>
                <dt>Double-click</dt><dd>1:1 pixels ↔ fit</dd>
                <dt>Drag</dt><dd>pan when zoomed · click plays / pauses</dd>
              </dl>
              <h4>Trackpad · over the timeline</h4>
              <dl>
                <dt>Hover</dt><dd>preview the frame under the cursor</dd>
                <dt>Two-finger swipe</dt><dd>scrub through the whole run</dd>
                <dt>Click / drag</dt><dd>jump / scrub to a frame</dd>
              </dl>
              <h4>Touch</h4>
              <dl>
                <dt>Drag the timeline</dt><dd>scrub frame by frame</dd>
                <dt>Pinch the picture</dt><dd>zoom, drag to pan</dd>
              </dl>
              <h4>Keys (click the player first)</h4>
              <dl>
                <dt><span class="sr-kbd">←</span> <span class="sr-kbd">→</span></dt><dd>one frame (<span class="sr-kbd">⇧</span> ten)</dd>
                <dt data-help="events"><span class="sr-kbd">↑</span> <span class="sr-kbd">↓</span></dt><dd data-help="events">previous / next event</dd>
                <dt><span class="sr-kbd">Space</span></dt><dd>play / pause</dd>
                <dt><span class="sr-kbd">0</span> <span class="sr-kbd">1</span> <span class="sr-kbd">+</span> <span class="sr-kbd">−</span></dt><dd>fit · 1:1 · zoom</dd>
                <dt data-help="expand"><span class="sr-kbd">F</span></dt><dd data-help="expand">full screen (<span class="sr-kbd">Esc</span> closes)</dd>
              </dl>
            </div>
          </div>
          <div class="srv-overview" data-r="ov">
            <div class="track"></div><div class="got" data-r="ovgot"></div><div class="fill" data-r="ovfill"></div>
            <div data-r="ovmk"></div>
            <div class="head" data-r="ovhead"></div>
            <div class="tip" data-r="ovtip" hidden><div class="pv" data-r="pv"></div><span data-r="pvlabel"></span></div>
          </div>
        </div>
        <div class="srv-side">
          <div class="srv-tabs">
            <div class="sr-seg">
              <button class="sr-btn on" data-tab="events">Events <span class="count">${this.events.length}</span></button>
              <button class="sr-btn" data-tab="log">Log <span class="count">${this.log.length}</span></button>
            </div>
          </div>
          <div class="srv-log-tools" data-r="logtools" hidden><input data-r="filter" placeholder="Filter log"></div>
          <div class="srv-list" data-r="events"></div>
          <div class="srv-list" data-r="log" hidden></div>
        </div>
      </div>`)
    if (!this.opts.onExpand) root.querySelectorAll('[data-help="expand"]').forEach((el) => el.remove())
    if (!this.events.length) root.querySelectorAll('[data-a="evB"],[data-a="evF"],[data-help="events"]').forEach((el) => el.remove())
    if ((!this.events.length && !this.log.length) || this.opts.list === false) root.classList.add('srv-bare')
    if (!this.events.length && this.log.length) {
      root.querySelector('[data-tab="events"]')?.classList.remove('on')
      root.querySelector('[data-tab="log"]')?.classList.add('on')
    }
    this.host.querySelector(':scope > .srv-probe')?.remove()
    this.host.appendChild(root)
    this.root = root
    const r = {} as Refs
    root.querySelectorAll<HTMLElement>('[data-r]').forEach((el) => {
      r[el.dataset.r as string] = el
    })
    this.r = r
    if (!this.events.length && this.log.length) {
      r.events.hidden = true
      r.log.hidden = false
      r.logtools.hidden = false
    }
    this.vp = root.querySelector('.sr-viewport') as HTMLElement
    const content = root.querySelector('.sr-content') as HTMLElement
    if (this.opts.poster) this.vp.style.setProperty('--srv-poster', `url("${this.opts.poster.replace(/"/g, '%22')}")`)

    this.zp = new ZoomPan([content], (zp) => {
      r.zoom.textContent = zoomLabel(zp)
      this.vp.classList.toggle('zoomed', zp.z > 1.0001)
      this.vp.classList.toggle('pixelated', zp.pixelZoom >= 3)
    })
    this.offs.push(
      attachGestures(this.vp, this.zp, {
        onSwipe: (e) => this.swipe(e, 1 / 7),
        passY: true,
        onTap: () => (this.opts.angles?.length ? this.tapAngle(0) : this.togglePlay())
      })
    )
    const contents = [content]
    if (this.opts.angles?.length) contents.push(...this.buildAngles())
    const known = Number(this.opts.duration)
    const ratio = this.opts.aspect && this.opts.aspect > 0 ? this.opts.aspect : 16 / 9
    this.zp.setNatural(Math.round(720 * ratio), 720)
    this.aspect = ratio
    this.frame = wholeFrame(this.opts.initialFrame ?? 0)
    if (known > 0) this.layout(known)

    const list: MediaAngle[] = [
      { src: this.opts.src, source: this.opts.source ?? null, decoder: decoders?.[0] ?? null, offset: 0 },
      ...(this.opts.angles ?? []).map((a, k) => ({ src: a.src, source: a.source ?? null, decoder: decoders?.[k + 1] ?? null, offset: Number(a.offset) || 0 }))
    ]
    const decoded = !!this.opts.source && !this.fellBack
    this.media = decoded ? new DecodedMedia(this.hooks(), list, this.fps) : new ElementMedia(this.hooks(), list, this.fps, this.host)
    this.host.dataset.decode = this.media.kind
    r.emptytext.textContent = this.idleText()
    this.media.mount(contents)

    const transport = root.querySelector('.srv-transport') as HTMLElement
    transport.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-a],[data-speed]')
      if (!b) return
      b.classList.remove('sr-press')
      void b.offsetWidth
      b.classList.add('sr-press')
      if (b.dataset.speed) {
        if (this.media) this.media.rate = Number(b.dataset.speed)
        r.speed.querySelectorAll('.sr-btn').forEach((x) => x.classList.toggle('on', x === b))
        return
      }
      const a = b.dataset.a
      if (a === 'play') this.togglePlay()
      if (a === 'stepB') this.step(-1)
      if (a === 'stepF') this.step(1)
      if (a === 'evB') this.jumpEvent(-1)
      if (a === 'evF') this.jumpEvent(1)
      if (a === 'loop' && this.media) {
        this.media.loop = !this.media.loop
        b.classList.toggle('on', this.media.loop)
      }
      if (a === 'expand') this.opts.onExpand?.()
      if (a === 'help') this.toggleHelp()
    })
    r.retry.addEventListener('click', (e) => {
      e.stopPropagation()
      this.media?.retry()
    })
    this.listen(document, 'pointerdown', (e: PointerEvent) => {
      if (this.helpOpen() && !(e.target as HTMLElement | null)?.closest?.('[data-r="help"],[data-a="help"]')) this.toggleHelp(false)
    })
    this.listen(window, 'keydown', (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !this.helpOpen()) return
      e.preventDefault()
      e.stopPropagation()
      this.toggleHelp(false)
    }, { capture: true })
    this.listen(window, 'resize', () => this.helpOpen() && this.placeHelp())
    r.zoom.addEventListener('click', () => this.zp.animateTo(this.zp.vw / 2, this.zp.vh / 2, 1))
    r.frameIn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const v = parseInt(r.frameIn.value, 10)
        if (!Number.isNaN(v)) this.seek(v, true)
        r.frameIn.blur()
      }
      if (e.key === 'Escape') r.frameIn.blur()
    })
    r.frameIn.addEventListener('blur', () => (r.frameIn.value = String(this.frame)))

    const tabs = root.querySelector('.srv-tabs') as HTMLElement
    tabs.addEventListener('click', (e) => {
      const target = e.target as HTMLElement
      const t = target.closest<HTMLElement>('[data-tab]')
      if (t) {
        root.querySelectorAll('[data-tab]').forEach((x) => x.classList.toggle('on', x === t))
        const log = t.dataset.tab === 'log'
        r.events.hidden = log
        r.log.hidden = !log
        r.logtools.hidden = !log
        this.syncLists(true)
        return
      }
    })
    const onListClick = (e: MouseEvent): void => {
      const el = (e.target as HTMLElement).closest<HTMLElement>('[data-f]')
      if (!el) return
      this.listSeek = true
      this.seek(Number(el.dataset.f), true)
      this.listSeek = false
    }
    r.events.addEventListener('click', onListClick)
    r.log.addEventListener('click', onListClick)
    const unfollow = (): void => {
      if (!this.autoScrolling) this.follow = false
    }
    r.log.addEventListener('wheel', unfollow, { passive: true })
    r.events.addEventListener('wheel', unfollow, { passive: true })
    r.filter.addEventListener('input', () => this.renderLog())

    this.bindOverview()
    this.bindKeys()
    this.listen(this.host, 'frame-player:play', () => this.playFromStart())
    this.update()
    this.host.dispatchEvent(new Event('frame-player:built'))
  }

  private layout(duration: number): void {
    const n = Math.max(1, Math.round(duration * this.fps))
    const first = !this.sized
    this.sized = true
    if (n === this.n && !first) return
    this.n = n
    this.frame = clamp(this.frame, 0, n - 1)
    this.pos = this.frame
    this.r.frameN.textContent = `/ ${n - 1}`
    this.host.dataset.frames = String(n)
    this.host.dataset.fps = String(this.fps)
    this.renderEvents()
    this.renderLog()
    this.renderOverviewMarkers()
    this.update()
    if (first) this.whenSized()
  }

  private whenSized(): void {
    if (this.pendingGoto) {
      const g = this.pendingGoto
      this.pendingGoto = null
      this.goto(g)
    }
    if (this.pendingPlay) {
      this.pendingPlay = false
      this.seek(0)
      this.media?.play()
    }
  }

  private hooks() {
    return {
      ready: (m: MediaMeta) => this.onReady(m),
      drawn: () => this.onDrawn(),
      angleReady: (i: number, m: MediaMeta) => {
        const a = this.angles[i - 1]
        if (!a) return
        a.n = Math.max(1, Math.round(m.duration * this.fps))
        if (m.width && m.height) a.zp.setNatural(m.width, m.height)
      },
      playState: () => this.onPlayState(),
      shown: (angle: number, note: ShownNote) => this.onShown(angle, note),
      status: (st: MediaStatus) => this.showStatus(st),
      buffered: (sec: number) => this.showBuffered(sec),
      angleOut: (i: number, out: boolean) => this.angles[i - 1]?.el.classList.toggle('srv-out', out),
      thumb: () => this.showPreview(),
      log: (line: string) => this.note(line),
      failed: (m: string) => {
        if (!this.opts.src || this.fellBack) return false
        this.swapToElement(m)
        return true
      }
    }
  }

  private swapToElement(why: string): void {
    this.fellBack = why
    this.note(`plays through the video element: ${why}`)
    const old = this.media
    this.media = null
    queueMicrotask(() => {
      old?.dispose()
      if (this.disposed) return
      const contents = [this.root.querySelector('.srv-main .sr-viewport:not(.srv-tile) > .sr-content, .srv-main .sr-viewport[data-angle="0"] > .sr-content') as HTMLElement, ...this.angles.map((a) => a.content)]
      for (const c of contents) c?.replaceChildren()
      const list: MediaAngle[] = [{ src: this.opts.src, offset: 0 }, ...(this.opts.angles ?? []).map((a) => ({ src: a.src, offset: Number(a.offset) || 0 }))]
      this.media = new ElementMedia(this.hooks(), list, this.fps, this.host)
      this.host.dataset.decode = this.media.kind
      this.media.mount(contents.filter(Boolean))
    })
  }

  private onReady(m: MediaMeta): void {
    if (m.width && m.height) {
      this.zp.setNatural(m.width, m.height)
      this.aspect = m.width / m.height || 16 / 9
    }
    this.layout(m.duration)
    this.ready = true
    this.host.dataset.ready = ''
    this.host.dispatchEvent(new Event('frame-player:built'))
    this.seek(this.frame)
  }

  setPoster(url: string | null | undefined): void {
    this.opts.poster = url
    if (!this.vp?.hasAttribute('data-empty')) return
    if (url) this.vp.style.setProperty('--srv-poster', `url("${url.replace(/"/g, '%22')}")`)
    else this.vp.style.removeProperty('--srv-poster')
    this.showStatus(this.status)
  }

  private onDrawn(): void {
    if (!this.vp.hasAttribute('data-empty')) return
    this.vp.removeAttribute('data-empty')
    this.vp.style.removeProperty('--srv-poster')
    this.showStatus(this.status)
  }

  private onShown(angle: number, note: ShownNote): void {
    if (angle === 0) this.onDrawn()
    if (angle === 0) this.host.dataset.shownFrame = String(note.shown)
    this.reportAngles()
    if (this.media?.kind !== 'decoded') return
    const d: Decode = { at: Math.round(performance.now()), angle, want: note.want, shown: note.shown, ms: Math.round(note.ms * 10) / 10, ...(note.reads ? { reads: note.reads, readMs: Math.round((note.readMs ?? 0) * 10) / 10 } : {}) }
    this.decodes.push(d)
    if (this.decodes.length > DECODES_KEPT) this.decodes.shift()
    this.burst.push(d)
    clearTimeout(this.burstT)
    this.burstT = window.setTimeout(() => this.flushBurst(), SETTLE_MS)
  }

  private flushBurst(): void {
    const b = this.burst
    this.burst = []
    if (!b.length) return
    const main = b.filter((d) => d.angle === 0)
    const ms = b.map((d) => d.ms).sort((x, y) => x - y)
    const last = main[main.length - 1] ?? b[b.length - 1]
    const exact = main.filter((d) => d.want === d.shown).length
    this.note(`showed ${main.length} frame(s)${this.angles.length ? ` and ${b.length - main.length} angle frame(s)` : ''}, decode median ${ms[Math.floor(ms.length / 2)]} ms, max ${ms[ms.length - 1]} ms, ${exact}/${main.length} exact, last F ${last.want} shown F ${last.shown}`)
  }

  private showStatus(st: MediaStatus): void {
    this.status = st
    const r = this.r
    const bare = this.vp.hasAttribute('data-empty') && !this.vp.style.getPropertyValue('--srv-poster')
    r.status.hidden = !st || (bare && st.kind === 'load')
    r.status.dataset.state = st?.kind ?? ''
    r.statustext.textContent = st?.text ?? ''
    r.retry.hidden = st?.kind !== 'error'
    r.empty.dataset.state = st?.kind ?? (this.opts.source && !this.opts.source.eager && !this.media?.ready ? 'idle' : '')
    r.emptytext.textContent = st?.text ?? this.idleText()
    if (st?.kind === 'error') this.opts.onError?.(st.text)
    if (st) this.note(`${st.kind}: ${st.text}`)
  }

  private idleText(): string {
    return this.opts.source && !this.opts.source.eager && !this.media?.ready ? 'Play or drag the timeline to load the video' : 'Loading the video'
  }

  private showBuffered(sec: number): void {
    const dur = this.n / this.fps
    const x = dur > 0 ? clamp(sec / dur, 0, 1) * 100 : 0
    this.r.ovgot.style.width = `${x}%`
    this.host.dataset.buffered = sec.toFixed(2)
  }

  private buildAngles(): HTMLElement[] {
    const stage = document.createElement('div')
    stage.className = 'srv-stage'
    this.vp.replaceWith(stage)
    stage.appendChild(this.vp)
    this.vp.classList.add('srv-tile')
    this.vp.dataset.angle = '0'
    this.vp.appendChild(fromHtml(`<div class="sr-hud bl"><button class="sr-chip srv-label" data-focus="0">${esc(this.opts.label || 'Angle 1')}</button></div>`))
    const list = this.opts.angles ?? []
    const out: HTMLElement[] = []
    list.forEach((src, k) => {
      const i = k + 1
      const el = fromHtml(`
        <div class="sr-viewport srv-tile" data-angle="${i}">
          <div class="sr-content"></div>
          <div class="sr-hud bl"><button class="sr-chip srv-label" data-focus="${i}">${esc(src.label || `Angle ${i + 1}`)}</button></div>
        </div>`)
      stage.appendChild(el)
      const content = el.querySelector('.sr-content') as HTMLElement
      const zp = new ZoomPan([content], (z) => {
        el.classList.toggle('zoomed', z.z > 1.0001)
        el.classList.toggle('pixelated', z.pixelZoom >= 3)
      })
      zp.setNatural(Math.round(720 * (this.opts.aspect || 16 / 9)), 720)
      const a: Angle = { i, el, content, zp, offset: Number(src.offset) || 0, n: 1 }
      this.angles.push(a)
      out.push(content)
      this.offs.push(
        attachGestures(el, zp, {
          onSwipe: (e) => this.swipe(e, 1 / 7),
          passY: true,
          onTap: () => this.tapAngle(i)
        })
      )
    })
    stage.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-focus]')
      if (!b) return
      e.stopPropagation()
      this.tapAngle(Number(b.dataset.focus))
    })
    this.layoutAngles()
    return out
  }

  private tapAngle(i: number): void {
    this.focus(this.focused === i ? null : i)
  }

  focus(i: number | null): void {
    if (!this.angles.length) return
    this.focused = i != null && i >= 0 && i <= this.angles.length ? i : null
    this.layoutAngles()
  }

  private layoutAngles(): void {
    const stage = this.vp.parentElement
    if (!stage) return
    const n = this.angles.length + 1
    const tiles = [this.vp, ...this.angles.map((a) => a.el)]
    stage.classList.toggle('focus', this.focused != null)
    stage.style.setProperty('--cols', String(n <= 1 ? 1 : n <= 4 ? 2 : 3))
    stage.style.setProperty('--thumbs', String(n - 1))
    tiles.forEach((t, k) => {
      const big = this.focused === k
      t.classList.toggle('big', big)
      t.title = big ? 'Click to show all angles' : 'Click to enlarge this angle'
    })
    this.host.dataset.focus = this.focused == null ? '' : String(this.focused)
  }

  angleFrames(): number[] {
    return this.media?.angleFrames() ?? []
  }

  private reportAngles(): void {
    if (this.angles.length) this.host.dataset.angleFrames = this.angleFrames().join(',')
  }

  state(): Record<string, unknown> {
    return {
      ...(this.media?.info() ?? { kind: null }),
      fellBack: this.fellBack || null,
      fps: this.fps,
      frames: this.n,
      frame: this.frame,
      shown: this.media?.shownFrame() ?? -1,
      angleFrames: this.angleFrames(),
      playing: this.playing,
      time: Math.round((this.media?.time() ?? 0) * 1000) / 1000,
      rate: this.media?.rate ?? 1,
      status: this.status,
      ready: this.ready
    }
  }

  decodeLog(since = 0): Decode[] {
    return this.decodes.filter((d) => d.at >= since)
  }

  pulse(): void {
    const head = this.r?.ovhead
    if (!head) return
    head.classList.remove('sr-pulse')
    void head.offsetWidth
    head.classList.add('sr-pulse')
    head.addEventListener('animationend', () => head.classList.remove('sr-pulse'), { once: true })
  }

  private helpOpen(): boolean {
    return !!this.r?.help?.matches(':popover-open')
  }

  private toggleHelp(open = !this.helpOpen()): void {
    const pop = this.r.help
    if (open === this.helpOpen()) return
    this.root.querySelector('[data-a="help"]')?.classList.toggle('on', open)
    if (!open) {
      pop.hidePopover()
      return
    }
    pop.showPopover()
    this.placeHelp()
  }

  private placeHelp(): void {
    const pop = this.r.help
    const btn = this.root.querySelector('[data-a="help"]') as HTMLElement | null
    if (!btn) return
    const z = cssZoom(pop) || 1
    const m = 8
    const W = window.innerWidth
    const H = window.innerHeight
    pop.style.maxHeight = `${(H - m * 2) / z}px`
    const b = btn.getBoundingClientRect()
    const p = pop.getBoundingClientRect()
    let top = b.top - p.height - 6
    if (top < m) top = b.bottom + 6 + p.height <= H - m ? b.bottom + 6 : Math.max(m, H - m - p.height)
    const left = clamp(b.right - p.width, m, Math.max(m, W - m - p.width))
    pop.style.left = `${left / z}px`
    pop.style.top = `${top / z}px`
  }

  get playing(): boolean {
    return !!this.media?.playing
  }

  togglePlay(): void {
    const m = this.media
    if (!m) return
    if (m.playing) m.pause()
    else {
      if (this.sized && this.frame >= this.n - 1) this.seek(0)
      this.follow = true
      this.root.querySelector('[data-a="play"]')?.toggleAttribute('data-pending', !m.ready)
      m.play()
    }
  }

  private onPlayState(): void {
    const btn = this.root.querySelector('[data-a="play"]')
    if (btn) {
      btn.innerHTML = this.playing ? ICON.pause : ICON.play
      btn.removeAttribute('data-pending')
    }
    this.host.toggleAttribute('data-playing', this.playing)
    cancelAnimationFrame(this.raf)
    if (this.playing) {
      const tick = (): void => {
        if (this.disposed || !this.media) return
        this.media.tick()
        const t = this.media.time()
        this.frame = clamp(Math.floor(t * this.fps + 1e-4), 0, this.n - 1)
        if (!this.playing) {
          this.pos = this.frame
          this.update()
          return
        }
        this.pos = clamp(t * this.fps - 0.5, 0, this.n - 1)
        this.host.dataset.shownFrame = String(this.media.shownFrame())
        this.update()
        this.raf = requestAnimationFrame(tick)
      }
      this.raf = requestAnimationFrame(tick)
      return
    }
    if (!this.media) return
    this.frame = clamp(Math.floor(this.media.time() * this.fps + 1e-4), 0, this.n - 1)
    this.pos = this.frame
    if (this.media.kind === 'decoded') this.media.seek(this.frame)
    this.update()
  }

  seek(f: number, pause?: boolean, keepPos?: boolean): void {
    const m = this.media
    if (!m) return
    f = clamp(Math.round(f), 0, this.n - 1)
    if (!this.listSeek) this.follow = true
    if (pause || this.scrubbing) m.pause()
    this.frame = f
    if (!keepPos) this.pos = f
    m.seek(f)
    this.update()
  }

  goto(loc: { frame?: number; t?: number }, pause = true): string {
    if (this.disposed) return 'seek failed: the player is closed'
    if (!this.sized || !this.media) {
      this.pendingGoto = loc
      return 'waiting for the video to load'
    }
    if (loc.frame != null) this.seek(loc.frame, pause)
    else if (loc.t != null) this.seekTime(loc.t, pause)
    else return 'seek failed: no frame or t'
    return this.ready ? `seeked to frame ${this.frame}` : `opening the video at frame ${this.frame}`
  }

  seekTime(t: number, pause?: boolean): void {
    this.seek(Math.round(t * this.fps), pause)
  }

  step(d: number): void {
    this.media?.pause()
    this.seek(this.frame + d)
  }

  private jumpEvent(dir: number): void {
    const ev =
      dir > 0
        ? this.events.find((m) => m.frame > this.frame)
        : [...this.events].reverse().find((m) => m.frame < this.frame)
    if (ev) this.seek(ev.frame, true)
  }

  private swipe(e: WheelEvent, framesPerPx: number): void {
    if (isMouseWheel(e)) {
      this.step(Math.sign(e.deltaY || e.deltaX))
      return
    }
    const d = Math.abs(e.deltaX) >= Math.abs(e.deltaY) ? e.deltaX : 0
    if (!d) return
    this.scrubBy(d * lineScale(e) * framesPerPx)
  }

  private scrubBy(df: number): void {
    if (this.playing) this.media?.pause()
    this.scrubbing = true
    this.pos = clamp(this.pos + df, 0, this.n - 1)
    const f = Math.round(this.pos)
    if (f !== this.frame) this.seek(f, false, true)
    else this.update()
    clearTimeout(this.snapT)
    this.snapT = window.setTimeout(() => this.snap(), 140)
  }

  private snap(): void {
    this.scrubbing = false
    this.pos = this.frame
  }

  private update(): void {
    const r = this.r
    if (!r) return
    const t = this.frame / this.fps
    if (this.reportedFrame !== this.frame) {
      this.reportedFrame = this.frame
      this.host.dataset.frame = String(this.frame)
      this.opts.onFrame?.(this.frame)
    }
    if (document.activeElement !== r.frameIn) r.frameIn.value = String(this.frame)
    r.tc.textContent = fmtTime(t)
    const x = ((this.frame + 0.5) / this.n) * 100
    r.ovhead.style.left = `${x}%`
    r.ovfill.style.width = `${x}%`
    const near = this.events.find((m) => Math.abs(m.frame - this.frame) <= Math.max(3, this.fps * 0.25))
    if (near) {
      r.evnow.className = `srv-evnow k-${near.kind || 'info'}`
      const dot = r.evnow.querySelector('.sr-dot')
      if (dot) dot.className = `sr-dot k-${near.kind || 'info'}`
      if (r.evnow.lastElementChild) r.evnow.lastElementChild.textContent = near.label
      r.evnow.hidden = false
    } else r.evnow.hidden = true
    this.syncLists(false)
    this.reportAngles()
  }

  private renderEvents(): void {
    this.r.events.innerHTML = this.events
      .map(
        (m) => `
        <div class="srv-ev k-${esc(m.kind || 'info')}" data-f="${esc(String(m.frame))}">
          <span class="sr-dot k-${esc(m.kind || 'info')}"></span>
          <span class="t">${fmtTime(m.frame / this.fps).slice(1)}</span>
          <span class="l">${esc(m.label)}</span>
        </div>`
      )
      .join('')
    this.evEls = [...this.r.events.children] as HTMLElement[]
  }

  private renderLog(): void {
    const q = this.r.filter.value.trim().toLowerCase()
    const rows = this.log.filter((l) => !q || `${l.src ?? ''} ${l.msg}`.toLowerCase().includes(q))
    this.r.log.innerHTML = rows
      .map(
        (l) => `
        <div class="srv-ln lv-${esc(l.level || 'info')}" data-f="${esc(String(l.frame))}">
          <span class="t">${(l.frame / this.fps).toFixed(2)}</span>
          <span class="s">${esc(l.src || '')}</span>
          <span class="m">${esc(l.msg)}</span>
        </div>`
      )
      .join('')
    this.logEls = [...this.r.log.children] as HTMLElement[]
    this.lastLogCur = null
    this.syncLists(true)
  }

  private renderOverviewMarkers(): void {
    this.r.ovmk.innerHTML = this.events
      .map((m) => `<div class="mk k-${esc(m.kind || 'info')}" style="left:${((m.frame + 0.5) / this.n) * 100}%"></div>`)
      .join('')
  }

  private syncLists(force: boolean): void {
    if (!this.evEls) return
    let cur: HTMLElement | null = null
    for (const el of this.evEls) if (Number(el.dataset.f) <= this.frame) cur = el
    for (const el of this.evEls) el.classList.toggle('cur', el === cur)
    let lcur: HTMLElement | null = null
    for (const el of this.logEls) {
      const fut = Number(el.dataset.f) > this.frame
      el.classList.toggle('future', fut)
      if (!fut) lcur = el
    }
    if (lcur !== this.lastLogCur) {
      this.lastLogCur?.classList.remove('cur')
      lcur?.classList.add('cur')
    }
    const changed = lcur !== this.lastLogCur || cur !== this.lastEvCur
    this.lastLogCur = lcur
    this.lastEvCur = cur
    if (this.follow && (changed || force)) {
      this.autoScrolling = true
      const list = this.r.log.hidden ? this.r.events : this.r.log
      const el = this.r.log.hidden ? cur : lcur
      if (el) list.scrollTop = el.offsetTop - list.clientHeight / 2 + el.offsetHeight / 2
      requestAnimationFrame(() => (this.autoScrolling = false))
    }
  }

  private bindOverview(): void {
    const ov = this.r.ov
    const frameAt = (e: PointerEvent): number => {
      const r = ov.getBoundingClientRect()
      return clamp(Math.floor(((e.clientX - r.left) / r.width) * this.n), 0, this.n - 1)
    }
    let down = false
    let touch: { id: number; x: number; y: number; axis: SwipeAxis | null } | null = null
    const capture = (id: number): void => {
      try {
        ov.setPointerCapture(id)
      } catch {
      }
    }
    ov.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'mouse') {
        touch = { id: e.pointerId, x: e.clientX, y: e.clientY, axis: null }
        return
      }
      down = true
      capture(e.pointerId)
      this.seek(frameAt(e), true)
    })
    ov.addEventListener('pointermove', (e) => {
      if (e.pointerType !== 'mouse') {
        if (!touch || touch.id !== e.pointerId) return
        if (!touch.axis) {
          touch.axis = swipeAxis(e.clientX - touch.x, e.clientY - touch.y)
          if (touch.axis === 'x') {
            down = true
            capture(e.pointerId)
          }
        }
        if (touch.axis !== 'x') return
      }
      const f = frameAt(e)
      if (e.pointerType === 'mouse' && !down) {
        const r = ov.getBoundingClientRect()
        const z = ov.offsetWidth > 0 ? r.width / ov.offsetWidth : cssZoom(ov)
        const x = (e.clientX - r.left) / z
        const host = (ov.closest('.sr-player') as HTMLElement | null)?.getBoundingClientRect() ?? r
        const half = (PREVIEW_H * this.aspect) / 2 + 4
        const lo = (host.left - r.left) / z + half
        const hi = (host.right - r.left) / z - half
        this.r.ovtip.hidden = false
        this.r.ovtip.style.left = `${lo <= hi ? clamp(x, lo, hi) : x}px`
        ov.style.setProperty('--hx', `${x}px`)
        this.hoverF = f
        this.showPreview()
      }
      if (down) {
        if (!this.r.ovtip.hidden) leave()
        this.seek(f, true)
      }
    })
    ov.addEventListener('pointerup', (e) => {
      if (touch?.id === e.pointerId && !touch.axis) this.seek(frameAt(e), true)
      touch = null
      down = false
    })
    const leave = (): void => {
      this.r.ovtip.hidden = true
      this.hoverF = null
      this.media?.thumb(null, PREVIEW_H)
    }
    ov.addEventListener('pointercancel', () => {
      touch = null
      down = false
      leave()
    })
    ov.addEventListener('pointerleave', leave)
    ov.addEventListener(
      'wheel',
      (e) => {
        if (!e.ctrlKey && Math.abs(e.deltaY) > Math.abs(e.deltaX)) return
        e.preventDefault()
        if (isMouseWheel(e)) this.step(Math.sign(e.deltaX))
        else this.scrubBy((e.deltaX * this.n) / ov.clientWidth)
      },
      { passive: false }
    )
  }

  private showPreview(): void {
    const f = this.hoverF
    if (f == null || !this.media) return
    this.r.pvlabel.textContent = `F ${f} · ${fmtTime(f / this.fps)}`
    const best = this.ready ? this.media.thumb(f, PREVIEW_H) : null
    const pv = this.r.pv
    pv.style.width = `${Math.round(PREVIEW_H * this.aspect)}px`
    if (pv.firstChild !== best) pv.replaceChildren(...(best ? [best] : []))
  }

  private bindKeys(): void {
    this.listen(this.host, 'keydown', (e: KeyboardEvent) => {
      if (typing(e) || e.metaKey || e.ctrlKey) return
      const k = e.key
      const zp = this.zp
      if (k === ' ') this.togglePlay()
      else if (k === 'ArrowLeft' || k === ',') this.step(e.shiftKey ? -10 : -1)
      else if (k === 'ArrowRight' || k === '.') this.step(e.shiftKey ? 10 : 1)
      else if (k === 'ArrowUp' && this.events.length) this.jumpEvent(-1)
      else if (k === 'ArrowDown' && this.events.length) this.jumpEvent(1)
      else if (k === 'Home') this.seek(0, true)
      else if (k === 'End') this.seek(this.n - 1, true)
      else if (k === '0') zp.animateTo(zp.vw / 2, zp.vh / 2, 1)
      else if (k === '1') zp.animateTo(zp.vw / 2, zp.vh / 2, Math.max(1, 1 / (zp.base * devicePixelRatio)))
      else if (k === '+' || k === '=') zp.animateTo(zp.vw / 2, zp.vh / 2, zp.z * 1.5)
      else if (k === '-') zp.animateTo(zp.vw / 2, zp.vh / 2, zp.z / 1.5)
      else if (k === '?') this.toggleHelp()
      else if ((k === 'f' || k === 'F') && this.opts.onExpand) this.opts.onExpand()
      else return
      e.preventDefault()
      e.stopPropagation()
    })
  }
}
