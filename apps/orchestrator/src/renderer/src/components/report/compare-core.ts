import { ZoomPan, attachGestures, clamp, esc, fromHtml, lineScale, typing, zoomLabel, type GestureOptions } from './zoom-pan'

export type CompareMode = 'wipe' | 'side' | 'flip' | 'diff'

export interface CompareOptions {
  before: string
  after: string
  beforeLabel?: string
  afterLabel?: string
  mode?: CompareMode
  onError?: (message: string) => void
  onMode?: (mode: CompareMode) => void
}

const MODES: CompareMode[] = ['wipe', 'side', 'flip', 'diff']

export function compareMode(mode?: string): CompareMode {
  return mode && MODES.includes(mode as CompareMode) ? (mode as CompareMode) : 'wipe'
}

export function compareRatios(aspect: number | undefined, mode: CompareMode): Record<string, string> {
  if (!aspect || !(aspect > 0) || !Number.isFinite(aspect)) return {}
  return { '--src-ar': String((mode === 'side' ? 2 : 1) * aspect), '--src-ar-stacked': String(aspect / 2) }
}

export class CompareCore {
  private r: Record<string, HTMLElement> = {}
  private u = 0.5
  private mode: CompareMode
  private flipB = false
  private hintGone = false
  private disposed = false
  private offs: (() => void)[] = []
  private zp: ZoomPan
  private probe: HTMLImageElement

  constructor(
    private host: HTMLElement,
    private opts: CompareOptions
  ) {
    this.mode = compareMode(opts.mode)
    const la = opts.beforeLabel || 'Before'
    const lb = opts.afterLabel || 'After'
    const touchUi = matchMedia('(pointer: coarse)').matches
    const root = fromHtml(`
      <div class="src">
        <div class="src-bar">
          <div class="sr-seg" data-r="modes">
            <button class="sr-btn" data-mode="wipe">Wipe</button>
            <button class="sr-btn" data-mode="side">Side by side</button>
            <button class="sr-btn" data-mode="flip">Flip</button>
            <button class="sr-btn" data-mode="diff">Difference</button>
          </div>
          <span class="sr-spacer"></span>
          <button class="sr-chip" data-r="zoom" title="Fit (0)">Fit</button>
        </div>
        <div class="src-stage">
          <div class="sr-viewport" data-r="v1">
            <div class="sr-content" data-r="c1"><img src="${esc(opts.before)}" draggable="false" decoding="async"></div>
            <span class="sr-chip src-cap l" data-r="capL">${esc(la)}</span>
            <span class="sr-chip src-cap r" data-r="capR">${esc(lb)}</span>
            <div class="src-wipe" data-r="wipe"><div class="src-grip" data-r="grip"></div></div>
            <div class="sr-hud bc" data-r="hintwrap"><div class="sr-hint" data-r="hint">${touchUi ? 'Drag the handle · pinch to zoom' : 'Swipe sideways or drag to move the split · pinch to zoom'}</div></div>
          </div>
          <div class="sr-viewport" data-r="v2" hidden>
            <div class="sr-content" data-r="c2"></div>
            <span class="sr-chip src-cap l">${esc(lb)}</span>
          </div>
        </div>
      </div>`)
    host.appendChild(root)
    const r = this.r
    root.querySelectorAll<HTMLElement>('[data-r]').forEach((el) => {
      r[el.dataset.r as string] = el
    })
    r.modes.querySelector(`[data-mode="${this.mode}"]`)?.classList.add('on')
    this.zp = new ZoomPan([r.c1, r.c2], (zp) => {
      r.zoom.textContent = zoomLabel(zp)
      for (const v of [r.v1, r.v2]) {
        v.classList.toggle('zoomed', zp.z > 1.0001)
        v.classList.toggle('pixelated', zp.pixelZoom >= 3)
      }
      this.layout()
    })
    const img = new Image()
    img.onload = () => {
      if (this.disposed) return
      this.zp.setNatural(img.naturalWidth, img.naturalHeight)
      this.layout()
    }
    img.onerror = () => {
      if (!this.disposed) opts.onError?.(`Can't load ${opts.before.split('?')[0].split('/').pop()}`)
    }
    img.src = opts.before
    this.probe = img
    const hint = (): void => {
      if (this.hintGone) return
      this.hintGone = true
      r.hint.classList.add('gone')
      setTimeout(() => r.hintwrap.remove(), 450)
    }
    let grabDx = 0
    const setU = (clientX: number): void => {
      const rc = r.v1.getBoundingClientRect()
      this.u = clamp((clientX - grabDx - rc.left) / rc.width, 0, 1)
      this.layout()
    }
    const common = (v: HTMLElement): GestureOptions => ({
      touchScroll: true,
      onActivity: hint,
      onSwipe: (e) => {
        if (this.mode === 'wipe' && v === r.v1) {
          const d = Math.abs(e.deltaX) >= Math.abs(e.deltaY) ? e.deltaX : e.deltaY
          this.u = clamp(this.u - (d * lineScale(e)) / r.v1.clientWidth, 0, 1)
          this.layout()
        }
      },
      onTap: () => {
        if (this.mode === 'flip') {
          this.flipB = !this.flipB
          this.layout()
        }
      },
      onDragStart: (e, touch) => {
        if (this.mode !== 'wipe' || v !== r.v1) return false
        if (touch) {
          if (!(e.target instanceof Element && r.grip.contains(e.target))) return false
          const rc = r.wipe.getBoundingClientRect()
          grabDx = e.clientX - (rc.left + rc.width / 2)
          hint()
          return true
        }
        grabDx = 0
        if ((e.target instanceof Node && r.wipe.contains(e.target)) || this.zp.z <= 1.0001) {
          hint()
          setU(e.clientX)
          return true
        }
        return false
      },
      onDragMove: (e) => setU(e.clientX)
    })
    this.offs.push(attachGestures(r.v1, this.zp, common(r.v1)))
    this.offs.push(attachGestures(r.v2, this.zp, common(r.v2)))
    r.modes.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-mode]')
      if (b) this.setMode(b.dataset.mode as CompareMode)
    })
    r.zoom.addEventListener('click', () => this.zp.animateTo(this.zp.vw / 2, this.zp.vh / 2, 1))
    const onKey = (e: KeyboardEvent): void => {
      if (typing(e) || e.metaKey || e.ctrlKey) return
      if (e.key >= '1' && e.key <= '4') this.setMode(MODES[Number(e.key) - 1])
      else if (e.key === '0') this.zp.animateTo(this.zp.vw / 2, this.zp.vh / 2, 1)
      else if (e.key === ' ' && this.mode === 'flip') {
        this.flipB = !this.flipB
        this.layout()
      } else if (this.mode === 'wipe' && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        this.u = clamp(this.u + (e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 0.1 : 0.02), 0, 1)
        this.layout()
      } else return
      e.preventDefault()
      e.stopPropagation()
    }
    host.addEventListener('keydown', onKey)
    this.offs.push(() => host.removeEventListener('keydown', onKey))
    this.layout()
  }

  setMode(mode: CompareMode): void {
    if (!MODES.includes(mode)) return
    this.mode = mode
    this.opts.onMode?.(mode)
    this.r.modes.querySelectorAll('.sr-btn').forEach((x) => x.classList.toggle('on', (x as HTMLElement).dataset.mode === mode))
    this.layout()
  }

  private afterImg(parent: HTMLElement): HTMLImageElement {
    const img = document.createElement('img')
    img.src = this.opts.after
    img.draggable = false
    img.decoding = 'async'
    img.addEventListener('error', () => {
      if (!this.disposed) this.opts.onError?.(`Can't load ${this.opts.after.split('?')[0].split('/').pop()}`)
    })
    parent.appendChild(img)
    return img
  }

  private topImg(): HTMLElement {
    if (!this.r.top) this.r.top = this.afterImg(this.r.c1)
    return this.r.top
  }

  private layout(): void {
    const r = this.r
    if (!r.v1 || this.disposed) return
    const m = this.mode
    if (this.zp.w > 1 && this.zp.h > 1) for (const [k, v] of Object.entries(compareRatios(this.zp.w / this.zp.h, m))) this.host.style.setProperty(k, v)
    if (this.host.dataset.mode !== m) this.host.dataset.mode = m
    const prevSide = !r.v2.hidden
    if (m === 'side' && !r.c2.firstChild) this.afterImg(r.c2)
    r.v2.hidden = m !== 'side'
    if (prevSide !== !r.v2.hidden) requestAnimationFrame(() => !this.disposed && this.zp.setViewport(r.v1.clientWidth, r.v1.clientHeight))
    r.wipe.hidden = m !== 'wipe'
    r.c1.classList.toggle('src-diff', m === 'diff')
    r.capR.hidden = m === 'side' || m === 'diff' || (m === 'flip' && !this.flipB)
    r.capL.hidden = m === 'flip' && this.flipB
    r.capL.textContent = m === 'diff' ? 'Difference' : this.opts.beforeLabel || 'Before'
    if (m === 'side') {
      if (r.top) {
        r.top.style.clipPath = ''
        r.top.style.visibility = 'hidden'
      }
      return
    }
    const top = this.topImg()
    if (m === 'wipe') {
      const vw = r.v1.clientWidth
      r.wipe.style.left = `${this.u * vw}px`
      const cx = (this.u * vw - this.zp.tx) / this.zp.s
      top.style.clipPath = `inset(0 0 0 ${Math.max(0, cx)}px)`
      top.style.visibility = 'visible'
    } else if (m === 'flip') {
      top.style.clipPath = ''
      top.style.visibility = this.flipB ? 'visible' : 'hidden'
    } else {
      top.style.clipPath = ''
      top.style.visibility = 'visible'
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const off of this.offs) off()
    this.offs = []
    this.zp.dispose()
    this.probe.onload = null
    this.probe.onerror = null
    this.probe.src = ''
    this.host.replaceChildren()
  }
}
