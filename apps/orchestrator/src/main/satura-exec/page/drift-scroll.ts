import type { Box } from './bubble'

type Win = Window & typeof globalThis

export type Axis = 'x' | 'y'

export interface Thumb {
  box: Box
  center: { x: number; y: number }
  native: boolean
}

export interface ScrollState {
  pos: number
  max: number
  view: number
  full: number
}

export const MIN_THUMB = 18
export const GOAL_ATTR = 'data-drift-goal'
export const GOAL_EVENT = 'satura-drift-goal'
const OVERLAY_THUMB = 6

const SCROLLS = /^(auto|scroll|overlay)$/

export function stateOf(el: Element, axis: Axis): ScrollState {
  const view = axis === 'y' ? el.clientHeight : el.clientWidth
  const full = axis === 'y' ? el.scrollHeight : el.scrollWidth
  const pos = axis === 'y' ? el.scrollTop : el.scrollLeft
  return { pos, max: Math.max(0, full - view), view, full }
}

export function setPos(el: Element, axis: Axis, v: number): number {
  if (axis === 'y') el.scrollTop = v
  else el.scrollLeft = v
  return axis === 'y' ? el.scrollTop : el.scrollLeft
}

function scrollable(win: Win, el: Element, axis: Axis): boolean {
  const s = stateOf(el, axis)
  if (s.max < 1) return false
  if (el === win.document.scrollingElement) return true
  const cs = win.getComputedStyle(el)
  return SCROLLS.test(axis === 'y' ? cs.overflowY : cs.overflowX)
}

function parentOf(el: Element): Element | null {
  if (el.parentElement) return el.parentElement
  const root = el.getRootNode()
  return root instanceof ShadowRoot ? root.host : null
}

export function alive(win: Win, el: Element): boolean {
  if (!el.isConnected) return false
  const r = el.getBoundingClientRect()
  if (r.width < 2 || r.height < 2) return false
  const check = (el as Element & { checkVisibility?: (o: object) => boolean }).checkVisibility
  if (check && !check.call(el, { checkOpacity: false, checkVisibilityCSS: true })) return false
  return r.right > 0 && r.bottom > 0 && r.left < win.innerWidth && r.top < win.innerHeight
}

const OWN_WHEEL = '[data-drift-wheel], [data-scene-viewport]'

function ownsWheel(el: Element, x: number, y: number): boolean {
  if (el.matches(OWN_WHEEL)) return true
  const areas = el.getAttribute('data-drift-wheel-areas')
  if (!areas) return false
  const r = el.getBoundingClientRect()
  const lx = x - r.left
  const ly = y - r.top
  return areas.split(';').some((a) => {
    const [ax, ay, aw, ah] = a.split(',').map(Number)
    return lx >= ax && ly >= ay && lx <= ax + aw && ly <= ay + ah
  })
}

export function scrollerAt(win: Win, x: number, y: number, axis: Axis, sign: number): Element | null {
  let el: Element | null = win.document.elementFromPoint(x, y)
  while (el) {
    if (ownsWheel(el, x, y)) return null
    if (scrollable(win, el, axis)) {
      const s = stateOf(el, axis)
      if ((sign > 0 && s.pos < s.max - 0.5) || (sign < 0 && s.pos > 0.5)) return el
    }
    el = parentOf(el)
  }
  return null
}

export function scrollerFor(win: Win, node: Element, axis: Axis): Element | null {
  const r = node.getBoundingClientRect()
  let el = parentOf(node)
  while (el) {
    if (scrollable(win, el, axis)) {
      const c = innerBox(win, el)
      const lo = axis === 'y' ? r.top : r.left
      const hi = axis === 'y' ? r.bottom : r.right
      const clo = axis === 'y' ? c.y : c.x
      const chi = axis === 'y' ? c.y + c.height : c.x + c.width
      if (lo < clo - 0.5 || hi > chi + 0.5) return el
    }
    el = parentOf(el)
  }
  return null
}

export function innerBox(win: Win, el: Element): Box {
  if (el === win.document.scrollingElement) return { x: 0, y: 0, width: win.innerWidth, height: win.innerHeight }
  const r = el.getBoundingClientRect()
  const cs = win.getComputedStyle(el)
  const bl = parseFloat(cs.borderLeftWidth) || 0
  const bt = parseFloat(cs.borderTopWidth) || 0
  return { x: r.left + bl, y: r.top + bt, width: el.clientWidth, height: el.clientHeight }
}

export function thumbOf(win: Win, el: Element, axis: Axis): Thumb {
  const c = innerBox(win, el)
  const s = stateOf(el, axis)
  const root = el === win.document.scrollingElement
  const r = root ? { left: 0, top: 0, right: win.innerWidth, bottom: win.innerHeight } : el.getBoundingClientRect()
  const cs = root ? null : win.getComputedStyle(el)
  const br = cs ? parseFloat(cs.borderRightWidth) || 0 : 0
  const bb = cs ? parseFloat(cs.borderBottomWidth) || 0 : 0
  const bar = axis === 'y' ? r.right - br - (c.x + c.width) : r.bottom - bb - (c.y + c.height)
  const native = bar >= 3
  const track = s.view
  const len = Math.min(track, Math.max(MIN_THUMB, (track * s.view) / Math.max(1, s.full)))
  const at = s.max > 0 ? (s.pos / s.max) * (track - len) : 0
  const w = native ? bar : OVERLAY_THUMB
  if (axis === 'y') {
    const x = native ? c.x + c.width : c.x + c.width - w - 2
    const box = { x, y: c.y + at, width: w, height: len }
    return { box, center: { x: x + w / 2, y: c.y + at + len / 2 }, native }
  }
  const y = native ? c.y + c.height : c.y + c.height - w - 2
  const box = { x: c.x + at, y, width: len, height: w }
  return { box, center: { x: c.x + at + len / 2, y: y + w / 2 }, native }
}

export function wantFor(win: Win, el: Element, node: Element, axis: Axis, rect?: Box | null, always = false): number | null {
  const c = innerBox(win, el)
  const nr = node.getBoundingClientRect()
  const r = rect ? { left: nr.left + rect.x, top: nr.top + rect.y, width: rect.width, height: rect.height } : { left: nr.left, top: nr.top, width: nr.width, height: nr.height }
  const s = stateOf(el, axis)
  const lo = axis === 'y' ? r.top - c.y : r.left - c.x
  const size = axis === 'y' ? r.height : r.width
  if (!always && lo >= -0.5 && lo + size <= s.view + 0.5) return null
  const want = s.pos + lo - (s.view - size) / 2
  return clamp(want, 0, s.max)
}

const clamp = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, v))

export function goalAttr(el: Element, s: ScrollState): number {
  const raw = el.getAttribute(GOAL_ATTR)
  const v = raw === null ? NaN : Number(raw)
  return Number.isFinite(v) ? clamp(v, 0, s.max) : s.pos
}

export function landGoal(el: Element, axis: Axis): void {
  const raw = el.getAttribute(GOAL_ATTR)
  el.removeAttribute(GOAL_ATTR)
  const v = raw === null ? NaN : Number(raw)
  if (Number.isFinite(v)) setPos(el, axis, v)
}
