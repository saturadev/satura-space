export const clamp = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, v))

export const isMouseWheel = (e: WheelEvent): boolean => {
  const wheelDeltaY = (e as WheelEvent & { wheelDeltaY?: number }).wheelDeltaY ?? 0
  return e.deltaMode === 1 || (e.deltaX === 0 && wheelDeltaY !== 0 && Math.abs(wheelDeltaY) % 120 === 0)
}

export const lineScale = (e: WheelEvent): number => (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1)

export const typing = (e: Event): boolean => {
  const t = e.target as HTMLElement | null
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)
}

export const fmtTime = (sec: number): string => {
  const m = Math.floor(sec / 60)
  const s = sec - m * 60
  return `${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`
}

export const esc = (s: unknown): string =>
  String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c)

export function fromHtml(html: string): HTMLElement {
  const t = document.createElement('template')
  t.innerHTML = html.trim()
  return t.content.firstElementChild as HTMLElement
}

export class ZoomPan {
  w = 1
  h = 1
  vw = 1
  vh = 1
  z = 1
  tx = 0
  ty = 0
  anim = 0
  private settle: ReturnType<typeof setTimeout> | null = null

  constructor(
    private contents: HTMLElement[],
    private onChange?: (zp: ZoomPan) => void
  ) {}

  get base(): number {
    return Math.min(this.vw / this.w, this.vh / this.h) || 1
  }
  get s(): number {
    return this.base * this.z
  }
  get maxZ(): number {
    return Math.max(4, 48 / (this.base * devicePixelRatio))
  }
  get pixelZoom(): number {
    return this.s * devicePixelRatio
  }

  setNatural(w: number, h: number): void {
    this.w = w
    this.h = h
    for (const c of this.contents) {
      c.style.width = `${w}px`
      c.style.height = `${h}px`
    }
    this.fit()
  }

  setViewport(vw: number, vh: number): void {
    if (vw < 2 || vh < 2) return
    const cx = (vw / 2 - this.tx) / this.s
    const cy = (vh / 2 - this.ty) / this.s
    const keep = this.z > 1.0001
    this.vw = vw
    this.vh = vh
    if (keep) {
      this.tx = vw / 2 - cx * this.s
      this.ty = vh / 2 - cy * this.s
      this.clampPan()
      this.apply()
    } else this.fit()
  }

  fit(): void {
    this.z = 1
    this.clampPan()
    this.apply()
  }

  clampPan(): void {
    const cw = this.w * this.s
    const ch = this.h * this.s
    this.tx = cw <= this.vw ? (this.vw - cw) / 2 : clamp(this.tx, this.vw - cw, 0)
    this.ty = ch <= this.vh ? (this.vh - ch) / 2 : clamp(this.ty, this.vh - ch, 0)
  }

  zoomAt(px: number, py: number, nz: number): void {
    nz = clamp(nz, 1, this.maxZ)
    const s0 = this.s
    const s1 = this.base * nz
    this.tx = px - (px - this.tx) * (s1 / s0)
    this.ty = py - (py - this.ty) * (s1 / s0)
    this.z = nz
    this.clampPan()
    this.live()
    this.apply()
  }

  panBy(dx: number, dy: number): void {
    this.tx -= dx
    this.ty -= dy
    this.clampPan()
    this.live()
    this.apply()
  }

  private live(): void {
    if (this.settle) clearTimeout(this.settle)
    else for (const c of this.contents) c.classList.add('sr-live')
    this.settle = setTimeout(() => this.rest(), 220)
  }

  private rest(): void {
    if (this.settle) clearTimeout(this.settle)
    this.settle = null
    for (const c of this.contents) c.classList.remove('sr-live')
  }

  animateTo(px: number, py: number, nz: number): void {
    cancelAnimationFrame(this.anim)
    const z0 = this.z
    const t0 = performance.now()
    const step = (now: number): void => {
      const k = Math.min(1, (now - t0) / 180)
      const e = 1 - Math.pow(1 - k, 3)
      this.zoomAt(px, py, z0 + (nz - z0) * e)
      if (k < 1) this.anim = requestAnimationFrame(step)
    }
    this.anim = requestAnimationFrame(step)
  }

  apply(): void {
    const t = `translate(${this.tx}px, ${this.ty}px) scale(${this.s})`
    for (const c of this.contents) c.style.transform = t
    this.onChange?.(this)
  }

  dispose(): void {
    cancelAnimationFrame(this.anim)
    this.rest()
    this.onChange = undefined
  }
}

export interface GesturePoint {
  clientX: number
  clientY: number
  target: EventTarget | null
}

export interface GestureOptions {
  onActivity?: () => void
  onSwipe?: (e: WheelEvent) => void
  passY?: boolean
  touchScroll?: boolean
  onTap?: () => void
  onDragStart?: (e: GesturePoint, touch: boolean) => boolean
  onDragMove?: (e: GesturePoint) => void
}

const TOUCH_TAP_PX = 10
const TOUCH_TAP_MS = 400

type GestureEvent = UIEvent & { scale: number; clientX: number; clientY: number }

export function cssZoom(el: Element | null | undefined): number {
  const z = (el as (Element & { currentCSSZoom?: number }) | null | undefined)?.currentCSSZoom
  return typeof z === 'number' && z > 0 ? z : 1
}

export function attachGestures(vp: HTMLElement, zp: ZoomPan, opts: GestureOptions = {}): () => void {
  const local = (e: { clientX: number; clientY: number }): [number, number] => {
    const r = vp.getBoundingClientRect()
    const z = cssZoom(vp)
    return [(e.clientX - r.left) / z, (e.clientY - r.top) / z]
  }
  const onWheel = (e: WheelEvent): void => {
    if (opts.passY && !e.ctrlKey && zp.z <= 1.0001 && Math.abs(e.deltaY) > Math.abs(e.deltaX)) return
    e.preventDefault()
    opts.onActivity?.()
    const [px, py] = local(e)
    if (e.ctrlKey) {
      const f = clamp(Math.exp(-e.deltaY * lineScale(e) * 0.01), 0.5, 2)
      cancelAnimationFrame(zp.anim)
      zp.zoomAt(px, py, zp.z * f)
      return
    }
    if (zp.z > 1.0001 && !e.altKey && !isMouseWheel(e)) {
      zp.panBy(e.deltaX * lineScale(e), e.deltaY * lineScale(e))
      return
    }
    opts.onSwipe?.(e)
  }
  let g0 = 1
  let fingers = 0
  const onGestureStart = (e: Event): void => {
    e.preventDefault()
    g0 = zp.z
  }
  const onGestureChange = (e: Event): void => {
    e.preventDefault()
    if (fingers) return
    const g = e as GestureEvent
    const [px, py] = local(g)
    zp.zoomAt(px, py, g0 * g.scale)
  }
  let drag: { x: number; y: number; moved: boolean; custom: boolean; id: number } | null = null
  const onDown = (e: PointerEvent): void => {
    if (e.button !== 0 || (opts.touchScroll && e.pointerType === 'touch')) return
    const custom = opts.onDragStart ? opts.onDragStart(e, false) : false
    drag = { x: e.clientX, y: e.clientY, moved: false, custom, id: e.pointerId }
    try {
      vp.setPointerCapture(e.pointerId)
    } catch {
      drag = null
    }
  }
  const onMove = (e: PointerEvent): void => {
    if (!drag || e.pointerId !== drag.id) return
    const z = cssZoom(vp)
    const dx = (e.clientX - drag.x) / z
    const dy = (e.clientY - drag.y) / z
    if (!drag.moved && Math.hypot(dx, dy) < 3) return
    drag.moved = true
    if (drag.custom) {
      opts.onDragMove?.(e)
      return
    }
    if (zp.z > 1.0001) {
      vp.classList.add('panning')
      zp.panBy(-dx, -dy)
      drag.x = e.clientX
      drag.y = e.clientY
    }
  }
  const onEnd = (e: PointerEvent): void => {
    if (!drag || e.pointerId !== drag.id) return
    vp.classList.remove('panning')
    if (!drag.moved && !drag.custom) opts.onTap?.()
    drag = null
  }
  let pinch: { d: number; z: number; x: number; y: number } | null = null
  let pan: [number, number] | null = null
  let grab = false
  let tap: { x: number; y: number; t: number } | null = null
  const pair = (t: TouchList): { d: number; x: number; y: number } => {
    const [ax, ay] = local(t[0])
    const [bx, by] = local(t[1])
    return { d: Math.max(1, Math.hypot(ax - bx, ay - by)), x: (ax + bx) / 2, y: (ay + by) / 2 }
  }
  const onTouchStart = (e: TouchEvent): void => {
    fingers = e.touches.length
    if (e.touches.length >= 2) {
      e.preventDefault()
      opts.onActivity?.()
      cancelAnimationFrame(zp.anim)
      pinch = { ...pair(e.touches), z: zp.z }
      grab = false
      pan = null
      tap = null
      return
    }
    const t = e.touches[0]
    tap = { x: t.clientX, y: t.clientY, t: performance.now() }
    grab = !!opts.onDragStart?.(t, true)
    pan = !grab && zp.z > 1.0001 ? local(t) : null
  }
  const onTouchMove = (e: TouchEvent): void => {
    if (pinch && e.touches.length >= 2) {
      e.preventDefault()
      const p = pair(e.touches)
      zp.zoomAt(p.x, p.y, (pinch.z * p.d) / pinch.d)
      zp.panBy(pinch.x - p.x, pinch.y - p.y)
      pinch.x = p.x
      pinch.y = p.y
      return
    }
    if (e.touches.length !== 1) return
    const t = e.touches[0]
    if (tap && Math.hypot(t.clientX - tap.x, t.clientY - tap.y) > TOUCH_TAP_PX) tap = null
    if (grab) {
      e.preventDefault()
      opts.onDragMove?.(t)
      return
    }
    if (!pan || zp.z <= 1.0001) return
    e.preventDefault()
    const p = local(t)
    vp.classList.add('panning')
    zp.panBy(pan[0] - p[0], pan[1] - p[1])
    pan = p
  }
  const onTouchEnd = (e: TouchEvent): void => {
    fingers = e.touches.length
    if (pinch) {
      if (e.touches.length >= 2) return
      pinch = null
      if (zp.z < 1.05) zp.fit()
      pan = e.touches.length === 1 && zp.z > 1.0001 ? local(e.touches[0]) : null
      return
    }
    if (e.touches.length) return
    vp.classList.remove('panning')
    const t = e.changedTouches[0]
    const tapped = !grab && !!tap && !!t && e.type === 'touchend' && performance.now() - tap.t < TOUCH_TAP_MS && Math.hypot(t.clientX - tap.x, t.clientY - tap.y) <= TOUCH_TAP_PX
    grab = false
    pan = null
    tap = null
    if (tapped) opts.onTap?.()
  }
  const onDbl = (e: MouseEvent): void => {
    const [px, py] = local(e)
    if (zp.z > 1.01) zp.animateTo(px, py, 1)
    else {
      const one = 1 / (zp.base * devicePixelRatio)
      zp.animateTo(px, py, one > 1.5 ? one : 4)
    }
  }
  vp.addEventListener('wheel', onWheel, { passive: false })
  vp.addEventListener('gesturestart', onGestureStart)
  vp.addEventListener('gesturechange', onGestureChange)
  vp.addEventListener('pointerdown', onDown)
  vp.addEventListener('pointermove', onMove)
  vp.addEventListener('pointerup', onEnd)
  vp.addEventListener('pointercancel', onEnd)
  vp.addEventListener('dblclick', onDbl)
  const live = { passive: false } as const
  if (opts.touchScroll) {
    vp.addEventListener('touchstart', onTouchStart, live)
    vp.addEventListener('touchmove', onTouchMove, live)
    vp.addEventListener('touchend', onTouchEnd)
    vp.addEventListener('touchcancel', onTouchEnd)
  }
  const ro = new ResizeObserver(() => zp.setViewport(vp.clientWidth, vp.clientHeight))
  ro.observe(vp)
  return () => {
    ro.disconnect()
    vp.removeEventListener('touchstart', onTouchStart)
    vp.removeEventListener('touchmove', onTouchMove)
    vp.removeEventListener('touchend', onTouchEnd)
    vp.removeEventListener('touchcancel', onTouchEnd)
    vp.removeEventListener('wheel', onWheel)
    vp.removeEventListener('gesturestart', onGestureStart)
    vp.removeEventListener('gesturechange', onGestureChange)
    vp.removeEventListener('pointerdown', onDown)
    vp.removeEventListener('pointermove', onMove)
    vp.removeEventListener('pointerup', onEnd)
    vp.removeEventListener('pointercancel', onEnd)
    vp.removeEventListener('dblclick', onDbl)
  }
}

export function zoomLabel(zp: ZoomPan): string {
  return zp.z <= 1.0001 ? 'Fit' : `${Math.round(zp.pixelZoom * 100)}%`
}
