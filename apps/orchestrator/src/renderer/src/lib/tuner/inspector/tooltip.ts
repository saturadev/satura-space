import type { TiSection, TiStyleDraw } from '@shared/tuner-inspector'
import { contains } from './model'
import { driftDriving, onDriftDriving } from '../../drift-driving'
import { attachFloating } from '../../floating'
import type { VirtualElement } from '../../floating-ui/dom/index'

export interface TipBox {
  left: number
  top: number
  width: number
  height: number
}

export interface TipPoint {
  x: number
  y: number
}

export interface TipRequest {
  text: string
  anchor: TipBox
  pointer?: TipPoint
  owner: unknown
  key: string
  scope?: Element | null
}

export const TIP_EDGE = 8
export const TITLE_HELD = 'data-title-held'
const NATIVE_TITLE = 'iframe,webview,embed,object'
export const TIP_GAP = 6
export const TIP_MAX_WIDTH = 360
export const TIP_DELAY_MS = 500
export const TIP_WARM_MS = 90
export const TIP_TALL = 40
const TIP_WARM_WINDOW_MS = 300
const TIP_WATCH_MS = 200
export const TIP_CLASS =
  'pointer-events-none fixed z-[120] whitespace-pre-wrap break-words rounded border border-white/10 bg-elevated px-2 py-1 text-left text-[11px] leading-[15px] text-ink shadow-lg'

export function tipMaxWidth(viewportWidth: number): number {
  return Math.max(80, Math.min(TIP_MAX_WIDTH, viewportWidth - 2 * TIP_EDGE))
}

function rectRef(left: number, top: number, right: number, bottom: number): VirtualElement {
  return { getBoundingClientRect: () => ({ x: left, y: top, left, top, right, bottom, width: right - left, height: bottom - top }) }
}

export function tipReference(anchor: TipBox, pointer?: TipPoint): VirtualElement {
  const tall = !!pointer && anchor.height > TIP_TALL
  const top = tall ? pointer.y - 4 : anchor.top
  const bottom = tall ? pointer.y + 18 : anchor.top + anchor.height
  const left = pointer ? pointer.x - 10 : anchor.left
  return rectRef(left, top, left, bottom)
}

export function floatTipReference(at: TipPoint): VirtualElement {
  return rectRef(at.x - 28, at.y - 24, at.x, at.y)
}

export const FLOAT_TIP_OPTIONS = { placement: 'bottom-start', gap: 0, crossGap: 28, fitHeight: false, origin: false } as const

export function imguiTipAt(sec: Pick<TiSection, 'draws'>, lx: number, ly: number): TiStyleDraw | undefined {
  let hit: TiStyleDraw | undefined
  for (const d of sec.draws ?? []) {
    if (d.k !== 's' || d.c !== undefined || !d.tip || !contains(d, lx, ly)) continue
    hit = d
  }
  return hit
}

function boxOf(el: Element): TipBox {
  const r = el.getBoundingClientRect()
  return { left: r.left, top: r.top, width: r.width, height: r.height }
}

export class TipController {
  private el: HTMLDivElement | null = null
  private unplace: (() => void) | null = null
  private held: Element | null = null
  private heldWatch: MutationObserver | null = null
  private shown: TipRequest | null = null
  private pending: TipRequest | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private watch: ReturnType<typeof setInterval> | null = null
  private hiddenAt = -Infinity
  private installed = false
  private offDrift: (() => void) | null = null

  get current(): TipRequest | null {
    return this.shown
  }

  get waiting(): TipRequest | null {
    return this.pending
  }

  owns(owner: unknown): boolean {
    return this.shown?.owner === owner || this.pending?.owner === owner
  }

  schedule(req: TipRequest, delay = TIP_DELAY_MS): void {
    if (driftDriving()) return
    if (this.shown && this.shown.owner === req.owner && this.shown.key === req.key) return
    if (this.pending && this.pending.owner === req.owner && this.pending.key === req.key) {
      this.pending = req
      return
    }
    const warm = this.shown !== null || Date.now() - this.hiddenAt < TIP_WARM_WINDOW_MS
    this.hide()
    this.pending = req
    this.timer = setTimeout(
      () => {
        this.timer = null
        const next = this.pending
        this.pending = null
        if (next) this.show(next)
      },
      warm ? Math.min(delay, TIP_WARM_MS) : delay
    )
  }

  hide(owner?: unknown): void {
    if (owner !== undefined && !this.owns(owner)) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.pending = null
    if (this.watch) clearInterval(this.watch)
    this.watch = null
    if (this.shown) this.hiddenAt = Date.now()
    this.shown = null
    this.unplace?.()
    this.unplace = null
    if (this.el) {
      this.el.remove()
      this.el = null
    }
  }

  install(): void {
    if (this.installed || typeof window === 'undefined') return
    this.installed = true
    this.offDrift = onDriftDriving((on) => {
      if (!on) return
      this.hide()
      this.releaseTitle()
    })
    window.addEventListener('pointerover', this.onOver, true)
    window.addEventListener('pointerout', this.onOut, true)
    window.addEventListener('scroll', this.onScroll, true)
    window.addEventListener('pointerdown', this.hideAll, true)
    window.addEventListener('wheel', this.hideAll, { capture: true, passive: true })
    window.addEventListener('keydown', this.hideAll, true)
    window.addEventListener('blur', this.hideAll)
    window.addEventListener('resize', this.hideAll)
  }

  uninstall(): void {
    if (!this.installed) return
    this.installed = false
    this.hide()
    this.releaseTitle()
    this.offDrift?.()
    this.offDrift = null
    window.removeEventListener('pointerover', this.onOver, true)
    window.removeEventListener('pointerout', this.onOut, true)
    window.removeEventListener('scroll', this.onScroll, true)
    window.removeEventListener('pointerdown', this.hideAll, true)
    window.removeEventListener('wheel', this.hideAll, { capture: true })
    window.removeEventListener('keydown', this.hideAll, true)
    window.removeEventListener('blur', this.hideAll)
    window.removeEventListener('resize', this.hideAll)
  }

  private readonly hideAll = (): void => this.hide()

  private show(req: TipRequest): void {
    if (driftDriving()) return
    if (req.scope && !req.scope.isConnected) return
    if (req.owner instanceof Element && !req.owner.isConnected) return
    for (const stray of document.querySelectorAll('[data-ti-tooltip]')) stray.remove()
    const el = document.createElement('div')
    el.setAttribute('data-ti-tooltip', '')
    el.setAttribute('role', 'tooltip')
    el.className = TIP_CLASS
    el.textContent = req.text
    el.style.maxWidth = `${tipMaxWidth(window.innerWidth)}px`
    el.style.left = '0px'
    el.style.top = '0px'
    el.style.visibility = 'hidden'
    document.body.appendChild(el)
    this.unplace = attachFloating(tipReference(req.anchor, req.pointer), el, {
      placement: 'bottom-start',
      gap: TIP_GAP,
      fitHeight: false,
      origin: false,
      onPlaced: (p) => el.setAttribute('data-ti-tip-side', p.startsWith('top') ? 'above' : 'below')
    })
    this.el = el
    this.shown = req
    this.watch = setInterval(() => {
      const s = this.shown
      if (!s) return
      if ((s.scope && !s.scope.isConnected) || (s.owner instanceof Element && !s.owner.isConnected)) this.hide()
    }, TIP_WATCH_MS)
  }

  private holdTitle(el: Element, text: string): void {
    if (this.held === el) return
    this.releaseTitle()
    el.setAttribute(TITLE_HELD, text)
    el.removeAttribute('title')
    this.held = el
    this.heldWatch = new MutationObserver(() => {
      const next = el.getAttribute('title')
      if (next === null) return
      el.setAttribute(TITLE_HELD, next)
      el.removeAttribute('title')
      if (this.owns(el) && next.trim()) this.schedule({ text: next.trim(), anchor: boxOf(el), owner: el, key: next, scope: el })
      else if (this.owns(el)) this.hide(el)
    })
    this.heldWatch.observe(el, { attributes: true, attributeFilter: ['title'] })
  }

  releaseTitle(): void {
    const el = this.held
    if (!el) return
    this.held = null
    this.heldWatch?.disconnect()
    this.heldWatch = null
    const text = el.getAttribute(TITLE_HELD)
    el.removeAttribute(TITLE_HELD)
    if (text !== null && !el.hasAttribute('title')) el.setAttribute('title', text)
    this.hide(el)
  }

  private readonly onOver = (e: PointerEvent): void => {
    if (e.pointerType === 'touch') return
    const el = (e.target as Element | null)?.closest?.(`[data-ti-tip],[title],[${TITLE_HELD}]`)
    if (this.held && this.held !== el) this.releaseTitle()
    if (!el) return
    const tip = el.getAttribute('data-ti-tip')
    if (tip !== null) {
      if (tip) this.schedule({ text: tip, anchor: boxOf(el), pointer: { x: e.clientX, y: e.clientY }, owner: el, key: tip, scope: el })
      return
    }
    if (driftDriving() || el.matches(NATIVE_TITLE) || !el.isConnected) return
    const raw = el.getAttribute('title') ?? el.getAttribute(TITLE_HELD) ?? ''
    const text = raw.trim()
    if (!text) return
    this.holdTitle(el, raw)
    this.schedule({ text, anchor: boxOf(el), pointer: { x: e.clientX, y: e.clientY }, owner: el, key: raw, scope: el })
  }

  private readonly onOut = (e: PointerEvent): void => {
    const to = e.relatedTarget as Node | null
    const held = this.held
    if (held && held.contains(e.target as Node) && !(to && held.contains(to))) this.releaseTitle()
    const el = (e.target as Element | null)?.closest?.('[data-ti-tip]')
    if (!el) return
    if (to && el.contains(to)) return
    this.hide(el)
  }

  private readonly onScroll = (e: Event): void => {
    const s = this.shown ?? this.pending
    if (!s) return
    const t = e.target
    const scope = s.scope ?? (s.owner instanceof Element ? s.owner : null)
    if (!scope || t === document || t === window || (t instanceof Node && t.contains(scope))) this.hide()
  }
}

export const tunerTip = new TipController()

let tipUsers = 0

export function installTunerTips(): () => void {
  tipUsers++
  tunerTip.install()
  let done = false
  return () => {
    if (done) return
    done = true
    tipUsers--
    if (tipUsers === 0) tunerTip.uninstall()
  }
}
