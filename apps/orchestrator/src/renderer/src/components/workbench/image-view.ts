export interface View {
  scale: number
  x: number
  y: number
}

interface Point {
  x: number
  y: number
}

const MIN_SCALE = 0.02
const MAX_SCALE = 64
export const FIT_PAD = 16
export const TOUCH_MAX_ZOOM = 8
const TOUCH_MIN_ZOOM = 0.5
const TOUCH_OVER_ZOOM = 1.5
const DOUBLE_TAP_ZOOM = 3
const SETTLE_MS = 260
const TAP_PX = 10
const TAP_MS = 300
const DOUBLE_TAP_MS = 350
const DOUBLE_TAP_PX = 40
const SWIPE_PX = 60

export function clampScale(s: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, s))
}

export function fitView(cw: number, ch: number, iw: number, ih: number, pad = FIT_PAD): View {
  const scale = clampScale(Math.min(1, (cw - pad * 2) / Math.max(1, iw), (ch - pad * 2) / Math.max(1, ih)))
  return { scale, x: (cw - iw * scale) / 2, y: (ch - ih * scale) / 2 }
}

export function zoomAt(v: View, factor: number, px: number, py: number): View {
  const scale = clampScale(v.scale * factor)
  const k = scale / v.scale
  return { scale, x: px - (px - v.x) * k, y: py - (py - v.y) * k }
}

export function settleView(v: View, cw: number, ch: number, iw: number, ih: number, min: number, max: number, px: number, py: number): View {
  const scale = Math.min(max, Math.max(min, v.scale))
  const k = scale / v.scale
  const w = iw * scale
  const h = ih * scale
  const x = px - (px - v.x) * k
  const y = py - (py - v.y) * k
  return {
    scale,
    x: w <= cw ? (cw - w) / 2 : Math.min(0, Math.max(cw - w, x)),
    y: h <= ch ? (ch - h) / 2 : Math.min(0, Math.max(ch - h, y))
  }
}

function mixView(a: View, b: View, k: number): View {
  return { scale: a.scale + (b.scale - a.scale) * k, x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k }
}

export interface TouchZoomHost {
  view: () => View | null
  natural: () => { w: number; h: number } | null
  show: (v: View, fitted: boolean) => void
  pad: number
  onSwipe?: (dir: 1 | -1) => boolean
}

export function attachTouchZoom(el: HTMLElement, host: TouchZoomHost): () => void {
  let pinch: { d: number; s: number; u: Point; mid: Point } | null = null
  let pan: Point | null = null
  let free = false
  let start: { t: number; p: Point } | null = null
  let moved = false
  let lastTap: { t: number; p: Point } | null = null
  let anim = 0

  const local = (t: { clientX: number; clientY: number }): Point => {
    const r = el.getBoundingClientRect()
    const k = el.offsetWidth > 0 ? r.width / el.offsetWidth : 1
    return { x: (t.clientX - r.left) / k, y: (t.clientY - r.top) / k }
  }
  const pair = (list: TouchList): { mid: Point; d: number } => {
    const a = local(list[0])
    const b = local(list[1])
    return { mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, d: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)) }
  }
  const limits = (): { w: number; h: number; cw: number; ch: number; fit: View; max: number } | null => {
    const n = host.natural()
    const cw = el.clientWidth
    const ch = el.clientHeight
    if (!n || cw < 2 || ch < 2) return null
    const fit = fitView(cw, ch, n.w, n.h, host.pad)
    return { w: n.w, h: n.h, cw, ch, fit, max: Math.max(fit.scale * TOUCH_MAX_ZOOM, 4) }
  }
  const zoomOf = (v: View, fit: View): string => `${(v.scale / fit.scale).toFixed(2)}x`
  const stop = (): void => {
    cancelAnimationFrame(anim)
    anim = 0
  }
  const animate = (to: View, fitted: boolean): void => {
    stop()
    const from = host.view()
    if (!from || (Math.abs(from.scale - to.scale) < 1e-4 && Math.abs(from.x - to.x) < 0.5 && Math.abs(from.y - to.y) < 0.5)) {
      host.show(to, fitted)
      return
    }
    const t0 = performance.now()
    const step = (now: number): void => {
      const k = Math.min(1, (now - t0) / SETTLE_MS)
      host.show(k >= 1 ? to : mixView(from, to, 1 - Math.pow(1 - k, 3)), fitted && k >= 1)
      anim = k < 1 ? requestAnimationFrame(step) : 0
    }
    anim = requestAnimationFrame(step)
  }
  const settle = (at: Point, why: string): void => {
    const l = limits()
    const v = host.view()
    if (!l || !v) return
    const to = settleView(v, l.cw, l.ch, l.w, l.h, l.fit.scale, l.max, at.x, at.y)
    const fitted = to.scale <= l.fit.scale * 1.001
    animate(fitted ? l.fit : to, fitted)
    console.info(`[image-viewer] ${why} ${fitted ? 'back to fit' : `at ${zoomOf(to, l.fit)} of fit`}`)
  }
  const beginPinch = (list: TouchList): void => {
    const v = host.view()
    if (!v) return
    const g = pair(list)
    pinch = { d: g.d, s: v.scale, u: { x: (g.mid.x - v.x) / v.scale, y: (g.mid.y - v.y) / v.scale }, mid: g.mid }
  }
  const doubleTap = (p: Point): void => {
    const l = limits()
    const v = host.view()
    if (!l || !v) return
    if (v.scale > l.fit.scale * 1.01) {
      animate(l.fit, true)
      console.info(`[image-viewer] double tap from ${zoomOf(v, l.fit)} back to fit`)
      return
    }
    const target = Math.min(l.max, l.fit.scale * DOUBLE_TAP_ZOOM)
    const k = target / v.scale
    const to = settleView({ scale: target, x: p.x - (p.x - v.x) * k, y: p.y - (p.y - v.y) * k }, l.cw, l.ch, l.w, l.h, target, target, 0, 0)
    animate(to, false)
    console.info(`[image-viewer] double tap zooms to ${zoomOf(to, l.fit)} at ${Math.round(p.x)},${Math.round(p.y)}`)
  }

  const onStart = (e: TouchEvent): void => {
    if (e.cancelable) e.preventDefault()
    stop()
    if (e.touches.length >= 2) {
      beginPinch(e.touches)
      pan = null
      start = null
      lastTap = null
      return
    }
    const p = local(e.touches[0])
    start = { t: performance.now(), p }
    moved = false
    pan = p
  }
  const onMove = (e: TouchEvent): void => {
    if (e.cancelable) e.preventDefault()
    const l = limits()
    const v = host.view()
    if (!l || !v) return
    if (pinch && e.touches.length >= 2) {
      const g = pair(e.touches)
      const s = Math.min(l.max * TOUCH_OVER_ZOOM, Math.max(l.fit.scale * TOUCH_MIN_ZOOM, (pinch.s * g.d) / pinch.d))
      pinch.mid = g.mid
      host.show({ scale: s, x: g.mid.x - pinch.u.x * s, y: g.mid.y - pinch.u.y * s }, false)
      return
    }
    if (e.touches.length !== 1 || !pan) return
    const p = local(e.touches[0])
    if (start && !moved && Math.hypot(p.x - start.p.x, p.y - start.p.y) < TAP_PX) return
    moved = true
    const dx = p.x - pan.x
    const dy = p.y - pan.y
    pan = p
    if (free) {
      host.show({ scale: v.scale, x: v.x + dx, y: v.y + dy }, false)
      return
    }
    if (v.scale <= l.fit.scale * 1.001) return
    host.show(settleView({ scale: v.scale, x: v.x + dx, y: v.y + dy }, l.cw, l.ch, l.w, l.h, v.scale, v.scale, 0, 0), false)
  }
  const onEnd = (e: TouchEvent): void => {
    if (pinch) {
      if (e.touches.length >= 2) {
        beginPinch(e.touches)
        return
      }
      const at = pinch.mid
      pinch = null
      if (e.touches.length === 1) {
        pan = local(e.touches[0])
        free = true
        start = null
        return
      }
      settle(at, 'pinch')
      return
    }
    if (e.touches.length) return
    const s = start
    const last = pan
    start = null
    pan = null
    if (free) {
      free = false
      settle(last ?? { x: el.clientWidth / 2, y: el.clientHeight / 2 }, 'pinch')
      return
    }
    if (!s || e.type === 'touchcancel') {
      lastTap = null
      return
    }
    const end = e.changedTouches[0] ? local(e.changedTouches[0]) : s.p
    if (moved) {
      lastTap = null
      const dx = end.x - s.p.x
      const dy = end.y - s.p.y
      const v = host.view()
      const l = limits()
      if (v && l && v.scale <= l.fit.scale * 1.001 && Math.abs(dx) > SWIPE_PX && Math.abs(dx) > Math.abs(dy) * 1.5 && host.onSwipe?.(dx < 0 ? 1 : -1))
        console.info(`[image-viewer] swipe to the ${dx < 0 ? 'next' : 'previous'} image`)
      return
    }
    const now = performance.now()
    if (now - s.t > TAP_MS) {
      lastTap = null
      return
    }
    if (lastTap && now - lastTap.t < DOUBLE_TAP_MS && Math.hypot(lastTap.p.x - s.p.x, lastTap.p.y - s.p.y) < DOUBLE_TAP_PX) {
      lastTap = null
      doubleTap(s.p)
      return
    }
    lastTap = { t: now, p: s.p }
  }
  const onGesture = (e: Event): void => e.preventDefault()

  const opts = { passive: false } as const
  el.addEventListener('touchstart', onStart, opts)
  el.addEventListener('touchmove', onMove, opts)
  el.addEventListener('touchend', onEnd, opts)
  el.addEventListener('touchcancel', onEnd, opts)
  el.addEventListener('gesturestart', onGesture, opts)
  el.addEventListener('gesturechange', onGesture, opts)
  return () => {
    stop()
    el.removeEventListener('touchstart', onStart)
    el.removeEventListener('touchmove', onMove)
    el.removeEventListener('touchend', onEnd)
    el.removeEventListener('touchcancel', onEnd)
    el.removeEventListener('gesturestart', onGesture)
    el.removeEventListener('gesturechange', onGesture)
  }
}
