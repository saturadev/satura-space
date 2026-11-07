import { useEffect } from 'react'
import { clamp, ZoomPan } from './zoom-pan'

const MAX_ZOOM = 5
const TAP_MS = 300
const DOUBLE_MS = 400
const TAP_PX = 12
const DOUBLE_PX = 40
const QUIET_CLICK_MS = 400

interface Point {
  x: number
  y: number
}

export function attachMediaZoom(surface: HTMLElement, target: HTMLElement, opts: { ignore?: string; clicks?: string; name?: string } = {}): () => void {
  const zp = new ZoomPan([], (z) => {
    const on = z.z > 1.0001
    target.style.transformOrigin = on ? '0 0' : ''
    target.style.transform = on ? `translate(${z.tx}px, ${z.ty}px) scale(${z.s})` : ''
    surface.toggleAttribute('data-media-zoomed', on)
  })
  const scale = (): number => {
    const w = surface.offsetWidth
    return w > 0 ? surface.getBoundingClientRect().width / w : 1
  }
  const local = (p: { clientX: number; clientY: number }): Point => {
    const r = surface.getBoundingClientRect()
    const k = scale()
    return { x: (p.clientX - r.left) / k, y: (p.clientY - r.top) / k }
  }
  const mid = (list: TouchList): Point => {
    const a = local(list[0])
    const b = local(list[1])
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
  }
  const dist = (list: TouchList): number => {
    const a = local(list[0])
    const b = local(list[1])
    return Math.hypot(a.x - b.x, a.y - b.y)
  }
  const ignored = (list: TouchList): boolean => {
    if (!opts.ignore) return false
    for (let i = 0; i < list.length; i++) {
      const t = list[i].target
      if (t instanceof Element && t.closest(opts.ignore)) return true
    }
    return false
  }
  const zoomed = (): boolean => zp.z > 1.0001
  const report = (why: string, z = zp.z): void => console.info(`[media-zoom] ${opts.name ?? target.tagName.toLowerCase()} ${why} ${Math.round(z * 100)}%`)

  let pinch: { d: number; z: number; at: Point } | null = null
  let pan: Point | null = null
  let start: { t: number; p: Point } | null = null
  let moved = false
  let lastTap: { t: number; p: Point } | null = null
  let gestureAt = 0

  const onStart = (e: TouchEvent): void => {
    if (e.touches.length < 2 && ignored(e.touches)) {
      pan = null
      start = null
      return
    }
    if (e.touches.length >= 2) {
      e.preventDefault()
      pinch = { d: Math.max(1, dist(e.touches)), z: zp.z, at: mid(e.touches) }
      pan = null
      start = null
      cancelAnimationFrame(zp.anim)
      return
    }
    const p = local(e.touches[0])
    start = { t: performance.now(), p }
    moved = false
    pan = zoomed() ? p : null
  }
  const onMove = (e: TouchEvent): void => {
    if (pinch && e.touches.length >= 2) {
      e.preventDefault()
      const at = mid(e.touches)
      zp.zoomAt(at.x, at.y, clamp((pinch.z * dist(e.touches)) / pinch.d, 1, MAX_ZOOM))
      zp.panBy(pinch.at.x - at.x, pinch.at.y - at.y)
      pinch.at = at
      gestureAt = performance.now()
      return
    }
    if (e.touches.length !== 1 || !start) return
    const p = local(e.touches[0])
    if (Math.hypot(p.x - start.p.x, p.y - start.p.y) > TAP_PX) moved = true
    if (!pan || !zoomed()) return
    e.preventDefault()
    zp.panBy(pan.x - p.x, pan.y - p.y)
    pan = p
    gestureAt = performance.now()
  }
  const onEnd = (e: TouchEvent): void => {
    if (pinch) {
      if (e.touches.length >= 2) return
      pinch = null
      gestureAt = performance.now()
      if (zp.z < 1.05) zp.fit()
      report(zoomed() ? 'zoomed to' : 'back to')
      pan = e.touches.length === 1 && zoomed() ? local(e.touches[0]) : null
      start = null
      return
    }
    if (e.touches.length) return
    pan = null
    const s = start
    start = null
    if (!s || moved || e.type === 'touchcancel' || performance.now() - s.t > TAP_MS) {
      lastTap = null
      return
    }
    const now = performance.now()
    if (lastTap && now - lastTap.t < DOUBLE_MS && Math.hypot(lastTap.p.x - s.p.x, lastTap.p.y - s.p.y) < DOUBLE_PX && zoomed()) {
      e.preventDefault()
      lastTap = null
      gestureAt = now
      report(`double tap from ${Math.round(zp.z * 100)}% back to`, 1)
      zp.animateTo(s.p.x, s.p.y, 1)
      return
    }
    lastTap = { t: now, p: s.p }
  }
  const onClick = (e: MouseEvent): void => {
    const pass = [opts.ignore, opts.clicks].filter(Boolean).join(', ')
    if (pass && e.target instanceof Element && e.target.closest(pass)) return
    if (!zoomed() && performance.now() - gestureAt > QUIET_CLICK_MS) return
    e.preventDefault()
    e.stopPropagation()
  }
  const onDouble = (e: MouseEvent): void => {
    if (!zoomed() || performance.now() - gestureAt < QUIET_CLICK_MS) return
    e.preventDefault()
    const p = local(e)
    gestureAt = performance.now()
    report(`double tap from ${Math.round(zp.z * 100)}% back to`, 1)
    zp.animateTo(p.x, p.y, 1)
  }
  const size = (): void => {
    const w = surface.clientWidth
    const h = surface.clientHeight
    if (w < 2 || h < 2) return
    if (w === zp.vw && h === zp.vh && w === zp.w && h === zp.h) return
    zp.setViewport(w, h)
    zp.setNatural(w, h)
  }
  const ro = new ResizeObserver(size)
  ro.observe(surface)
  size()
  const touchAction = surface.style.touchAction
  surface.style.touchAction = 'pan-x pan-y'
  surface.setAttribute('data-media-surface', '')
  const live = { passive: false } as const
  surface.addEventListener('touchstart', onStart, live)
  surface.addEventListener('touchmove', onMove, live)
  surface.addEventListener('touchend', onEnd, live)
  surface.addEventListener('touchcancel', onEnd, live)
  surface.addEventListener('click', onClick, true)
  surface.addEventListener('dblclick', onDouble)
  return () => {
    ro.disconnect()
    zp.dispose()
    surface.removeEventListener('touchstart', onStart)
    surface.removeEventListener('touchmove', onMove)
    surface.removeEventListener('touchend', onEnd)
    surface.removeEventListener('touchcancel', onEnd)
    surface.removeEventListener('click', onClick, true)
    surface.removeEventListener('dblclick', onDouble)
    surface.removeAttribute('data-media-zoomed')
    surface.removeAttribute('data-media-surface')
    surface.style.touchAction = touchAction
    target.style.transform = ''
    target.style.transformOrigin = ''
  }
}

export function useMediaZoom(surface: HTMLElement | null, target: HTMLElement | null, clicks?: string): void {
  useEffect(() => (surface && target ? attachMediaZoom(surface, target, { clicks }) : undefined), [surface, target, clicks])
}
