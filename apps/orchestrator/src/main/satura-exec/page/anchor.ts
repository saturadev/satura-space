import type { Box } from './bubble'
import type { WorkspaceScope } from './scope'
import { clientRect } from './rect'

type Win = Window & typeof globalThis

export interface Point {
  x: number
  y: number
}

export type AnchorState = 'ok' | 'gone' | 'hidden' | 'offscreen'

export interface AnchorRead {
  state: AnchorState
  box: Box | null
  point: Point | null
  refound: boolean
  clip?: Box | null
  keep?: Box | null
  via?: string
}

export type PartBox = Box & { keep?: Box | null; via?: string }

export interface FrameHop {
  rect: Box
  inset: Point
  scale: Point
}

const LOST_MS = 180
export const MOVE_EPS = 0.5
const OVERFLOW = /(auto|scroll|hidden|clip|overlay)/

export function anchorPoint(box: Box, f: Point): Point {
  return { x: box.x + f.x * box.width, y: box.y + f.y * box.height }
}

const EDGE_FRAC = 0.4

function along(p: number, size: number, base: number, f: number): number {
  if (!(base > 0) || f >= EDGE_FRAC && f <= 1 - EDGE_FRAC) return p + f * size
  const at = f < EDGE_FRAC ? p + f * base : p + size - (1 - f) * base
  return clamp(at, p, p + size)
}

export function edgePoint(box: Box, base: Box | null, f: Point): Point {
  if (!base) return anchorPoint(box, f)
  return { x: along(box.x, box.width, base.width, f.x), y: along(box.y, box.height, base.height, f.y) }
}

export function fracOf(box: Box | null, p: Point): Point {
  if (!box) return { x: 0.5, y: 0.5 }
  return {
    x: box.width > 0 ? clamp((p.x - box.x) / box.width, 0, 1) : 0.5,
    y: box.height > 0 ? clamp((p.y - box.y) / box.height, 0, 1) : 0.5
  }
}

export function sameBox(a: Box | null, b: Box | null, eps = MOVE_EPS): boolean {
  if (!a || !b) return a === b
  return Math.abs(a.x - b.x) < eps && Math.abs(a.y - b.y) < eps && Math.abs(a.width - b.width) < eps && Math.abs(a.height - b.height) < eps
}

export function intersect(a: Box | null, b: Box | null): Box | null {
  if (!a || !b) return null
  const x0 = Math.max(a.x, b.x)
  const y0 = Math.max(a.y, b.y)
  const x1 = Math.min(a.x + a.width, b.x + b.width)
  const y1 = Math.min(a.y + a.height, b.y + b.height)
  return x1 - x0 > 0 && y1 - y0 > 0 ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : null
}

function clampInto(p: Point, box: Box): Point {
  return { x: clamp(p.x, box.x, box.x + box.width), y: clamp(p.y, box.y, box.y + box.height) }
}

function throughFrames(box: Box, hops: FrameHop[]): Box {
  let b = box
  for (const h of hops) {
    b = {
      x: h.rect.x + (h.inset.x + b.x) * h.scale.x,
      y: h.rect.y + (h.inset.y + b.y) * h.scale.y,
      width: b.width * h.scale.x,
      height: b.height * h.scale.y
    }
  }
  return b
}

function visiblePart(box: Box, clips: Box[]): Box | null {
  let v: Box | null = box
  for (const c of clips) v = intersect(v, c)
  return v
}

export function settle(state: AnchorState, badSince: number | null, now: number, graceMs = LOST_MS): { state: AnchorState; badSince: number | null } {
  if (state === 'ok') return { state, badSince: null }
  const since = badSince ?? now
  return { state: now - since >= graceMs ? state : 'ok', badSince: since }
}

function clamp(v: number, a: number, b: number): number {
  return Math.max(a, Math.min(b, v))
}

function toBox(r: DOMRect): Box {
  return { x: r.x, y: r.y, width: r.width, height: r.height }
}

function set(v: string | undefined): boolean {
  return !!v && v !== 'none'
}

function holdsFixed(s: CSSStyleDeclaration): boolean {
  return set(s.transform) || set(s.perspective) || set(s.filter) || set(s.backdropFilter) || /paint|layout|strict|content/.test(s.contain || '') || /transform|perspective|filter/.test(s.willChange || '') || (!!s.containerType && s.containerType !== 'normal')
}

function parentOf(el: Element): Element | null {
  if (el.parentElement) return el.parentElement
  const root = el.parentNode
  return root && (root as ShadowRoot).host ? (root as ShadowRoot).host : null
}

export function viewportBox(el: Element, stop: Window | null = null): Box {
  const hops: FrameHop[] = []
  let win: Window | null = el.ownerDocument.defaultView
  while (win && win !== stop && win !== win.parent && win.frameElement) {
    const f = win.frameElement as HTMLElement
    const r = clientRect(f)
    const s = win.parent.getComputedStyle(f)
    const ow = f.offsetWidth || r.width
    const oh = f.offsetHeight || r.height
    hops.push({
      rect: toBox(r),
      inset: { x: f.clientLeft + (parseFloat(s.paddingLeft) || 0), y: f.clientTop + (parseFloat(s.paddingTop) || 0) },
      scale: { x: ow > 0 ? r.width / ow : 1, y: oh > 0 ? r.height / oh : 1 }
    })
    win = win.parent
  }
  return throughFrames(toBox(clientRect(el)), hops)
}

export class Anchor {
  el: Element
  private _frac: Point
  private _base: Box | null = null
  private _clips: Element[]
  private _badSince: number | null = null
  private _last: AnchorRead | null = null
  refound = 0

  constructor(
    private readonly _win: Win,
    el: Element,
    frac: Point,
    readonly desc: string,
    private readonly _scope: WorkspaceScope,
    private readonly _find: (() => Element | null) | null,
    private readonly _describe: (el: Element) => string,
    private readonly _part: ((el: Element) => PartBox | null) | null = null
  ) {
    this.el = el
    this._frac = frac
    this._clips = this._clipsOf(el)
  }

  get frac(): Point {
    return this._frac
  }

  set frac(f: Point) {
    this._frac = f
    this._base = null
  }

  get exact(): boolean {
    return !!this._part
  }

  private _clipsOf(el: Element): Element[] {
    const out: Element[] = []
    let pos = this._win.getComputedStyle(el).position
    for (let p = parentOf(el); p && p !== this._win.document.documentElement; p = parentOf(p)) {
      const s = this._win.getComputedStyle(p)
      if (pos === 'fixed' ? !holdsFixed(s) : pos === 'absolute' && (!s.position || s.position === 'static') && !holdsFixed(s)) continue
      pos = s.position
      if (OVERFLOW.test(s.overflowX) || OVERFLOW.test(s.overflowY)) out.push(p)
    }
    return out
  }

  private _shows(el: Element): boolean {
    if (!el.isConnected || !this._scope.owns(el)) return false
    const check = (el as Element & { checkVisibility?: (o: object) => boolean }).checkVisibility
    if (check && !check.call(el, { checkVisibilityCSS: true })) return false
    const r = clientRect(el)
    return r.width > 0 || r.height > 0
  }

  private _refind(): boolean {
    const next = this._find?.() ?? null
    if (!next || next === this.el || !this._shows(next)) return false
    this.el = next
    this._base = null
    this._clips = this._clipsOf(next)
    this.refound++
    return true
  }

  read(now: number): AnchorRead {
    let refound = false
    if (!this._shows(this.el)) refound = this._refind()
    let raw: AnchorState = 'ok'
    let box: Box | null = null
    let point: Point | null = null
    let clip: Box | null = null
    let part: PartBox | null = null
    if (!this.el.isConnected) raw = 'gone'
    else if (!this._shows(this.el)) raw = 'hidden'
    else if (this._part && !(box = part = this._part(this.el))) raw = 'hidden'
    else {
      box = box ?? viewportBox(this.el, this._win)
      const view = this._scope.info().rect
      const outer = this._clips.filter((c) => c.isConnected).map((c) => toBox(clientRect(c)))
      outer.push({ x: 0, y: 0, width: this._win.innerWidth, height: this._win.innerHeight })
      if (view && this._scope.id) outer.push(view)
      const clips = this._part ? [...outer, viewportBox(this.el, this._win)] : outer
      const seen = visiblePart(box, clips)
      clip = visiblePart({ x: -1e6, y: -1e6, width: 2e6, height: 2e6 }, outer)
      if (!seen) raw = 'offscreen'
      else {
        if (!this._base) this._base = { ...box }
        point = clampInto(edgePoint(box, this._base, this._frac), seen)
      }
    }
    const s = settle(raw, this._badSince, now)
    this._badSince = s.badSince
    if (s.state === 'ok' && raw !== 'ok' && this._last) return { ...this._last, refound }
    const ok = s.state === 'ok'
    const keep = ok && part?.keep ? visiblePart(part.keep, [viewportBox(this.el, this._win)]) : null
    const r: AnchorRead = { state: s.state, box: ok ? (part ? { x: part.x, y: part.y, width: part.width, height: part.height } : box) : null, point: ok ? point : null, refound, clip: ok ? clip : null, keep, via: part?.via }
    if (r.state === 'ok') this._last = { ...r, refound: false }
    return r
  }

  hit(p: Point): { ok: boolean; by: string } {
    const hit = this._scope.hitTest(p.x, p.y)
    if (!hit) return { ok: false, by: 'nothing' }
    for (let el: Element | null = hit; el; el = el.assignedSlot ?? parentOf(el)) if (el === this.el) return { ok: true, by: '' }
    if (hit.contains(this.el) && this._win.getComputedStyle(this.el).pointerEvents === 'none') return { ok: true, by: '' }
    return { ok: false, by: this._describe(hit) }
  }
}
