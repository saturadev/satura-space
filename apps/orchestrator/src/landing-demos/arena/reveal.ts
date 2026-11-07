import type { Drift } from '../../main/satura-exec/page/drift'
import type { WorkspaceScope } from '../../main/satura-exec/page/scope'
import { anchorOn, whole } from './aim'
import { clientRect } from '../../main/satura-exec/page/rect'

export interface View {
  left: number
  top: number
  right: number
  bottom: number
}

interface Plan {
  pane: HTMLElement
  view: View
  dx: number
  dy: number
}

type Aimed = { __driftAim?: Element | null }

export function aimAt(el: Element | null): void {
  ;(window as unknown as Aimed).__driftAim = el
}

function scrolls(el: HTMLElement, axis: 'x' | 'y'): boolean {
  const s = getComputedStyle(el)
  const o = axis === 'y' ? s.overflowY : s.overflowX
  if (!/(auto|scroll|overlay)/.test(o)) return false
  return axis === 'y' ? el.scrollHeight > el.clientHeight + 1 : el.scrollWidth > el.clientWidth + 1
}

export function scrollers(el: Element): HTMLElement[] {
  const out: HTMLElement[] = []
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) if (scrolls(p, 'y') || scrolls(p, 'x')) out.push(p)
  return out
}

function stickyBottom(pane: HTMLElement, top: number): number {
  let bottom = top
  for (const c of pane.children) {
    if (getComputedStyle(c).position !== 'sticky') continue
    for (const e of [c, ...c.querySelectorAll('*')]) {
      const r = clientRect(e)
      if (r.height > 0 && r.width > 0 && r.top < top + 1 + clientRect(pane).height / 2) bottom = Math.max(bottom, r.bottom)
    }
  }
  return bottom
}

function scaleOf(pane: HTMLElement): number {
  const w = pane.offsetWidth
  return w > 0 ? clientRect(pane).width / w : 1
}

export function viewOf(pane: HTMLElement): View {
  const r = clientRect(pane)
  const k = scaleOf(pane)
  const top = r.top + pane.clientTop * k
  const left = r.left + pane.clientLeft * k
  return { left, top: stickyBottom(pane, top), right: left + pane.clientWidth * k, bottom: top + pane.clientHeight * k }
}

function need(a0: number, a1: number, v0: number, v1: number, pad: number): number {
  const p = Math.min(pad, Math.max(0, (v1 - v0 - (a1 - a0)) / 2))
  const end = Math.min(a1, a0 + (v1 - v0) - 2 * p)
  if (a0 < v0 + p) return a0 - v0 - p
  if (end > v1 - p) return end - v1 + p
  return 0
}

function clamp(pane: HTMLElement, sx: number, sy: number): { dx: number; dy: number } {
  const k = scaleOf(pane) || 1
  const dx = sx / k
  const dy = sy / k
  const y = Math.max(0, Math.min(pane.scrollHeight - pane.clientHeight, pane.scrollTop + dy))
  const x = Math.max(0, Math.min(pane.scrollWidth - pane.clientWidth, pane.scrollLeft + dx))
  return { dx: Math.round(x - pane.scrollLeft), dy: Math.round(y - pane.scrollTop) }
}

function plan(el: Element, pad: number): Plan | null {
  const r = clientRect(el)
  for (const pane of scrollers(el)) {
    const view = viewOf(pane)
    const raw = {
      dx: scrolls(pane, 'x') ? need(r.left, r.right, view.left, view.right, pad) : 0,
      dy: scrolls(pane, 'y') ? need(r.top, r.bottom, view.top, view.bottom, pad) : 0
    }
    const { dx, dy } = clamp(pane, raw.dx, raw.dy)
    if (dx || dy) return { pane, view, dx, dy }
  }
  return null
}

function ease(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
}

function spot(e: Element, f: { x: number; y: number }): { x: number; y: number; width: number; height: number } | null {
  const r = whole(e)
  return r ? { x: r.x + f.x * r.width - 8, y: r.y + f.y * r.height - 8, width: 16, height: 16 } : null
}

export function nudge(el: Element): boolean {
  const p = plan(el, 4)
  if (!p) return false
  p.pane.scrollTop += p.dy
  p.pane.scrollLeft += p.dx
  return true
}

export async function reveal(drift: Drift, el: Element, frame: () => Promise<void>, scope: WorkspaceScope, pad = 28): Promise<void> {
  for (let pass = 0; pass < 4; pass++) {
    const p = plan(el, pad)
    if (!p) return
    const { pane, view } = p
    const r = clientRect(el)
    const cx = Math.max(view.left + 30, Math.min(view.right - 30, r.left + Math.min(60, r.width / 2)))
    const cy = view.top + (view.bottom - view.top) * (p.dy > 0 ? 0.62 : p.dy < 0 ? 0.38 : 0.5)
    aimAt(pane)
    const pr = clientRect(pane)
    const f = { x: pr.width > 0 ? (cx - pr.left) / pr.width : 0.5, y: pr.height > 0 ? (cy - pr.top) / pr.height : 0.5 }
    const shown = drift.point({ x: cx, y: cy, box: null, text: '', mark: false, target: anchorOn(pane, (e) => spot(e, f), { x: 0.5, y: 0.5 }, 'the list it scrolls', scope) })
    aimAt(null)
    const t0 = performance.now()
    while (performance.now() - t0 < shown.travel) await frame()
    const y0 = pane.scrollTop
    const x0 = pane.scrollLeft
    const ms = Math.max(320, Math.min(900, 240 + Math.hypot(p.dx, p.dy) * 0.9))
    const s0 = performance.now()
    let stroked = -1
    for (;;) {
      const t = Math.min(1, (performance.now() - s0) / ms)
      const beat = Math.floor((t * ms) / 260)
      if (beat !== stroked && t < 0.9) {
        stroked = beat
        drift.stroke(p.dx, p.dy)
      }
      const k = ease(t)
      pane.scrollTop = y0 + p.dy * k
      pane.scrollLeft = x0 + p.dx * k
      if (t >= 1) break
      await frame()
    }
    await frame()
    await frame()
  }
}
