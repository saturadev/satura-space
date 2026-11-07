import type { Vec3 } from '@shared/tuner'
import type { TunerRectInfo, V2 } from '@shared/tuner-rect'
import {
  anchorCornersParent,
  anchorLines,
  anchorPercentLabels,
  distanceLabels,
  fusedState,
  toWorld,
  type RectHandle,
  type RectLabel,
  type Side
} from './rect-tool'

export type Project = (p: Vec3) => V2 | null

export interface RectScreenAnchor {
  x: Side
  y: Side
  at: V2
  tri: V2[] | null
}

export interface RectScreen {
  corners: V2[]
  pivot: V2
  parent: V2[] | null
  anchors: RectScreenAnchor[]
}

export const ANCHOR_PX = 5
export const PIVOT_HIT = 8
export const CORNER_HIT = 7
export const EDGE_HIT = 5
export const ROTATE_HIT = 26

const SIDES: { x: Side; y: Side }[] = [
  { x: 0, y: 0 },
  { x: 2, y: 0 },
  { x: 2, y: 2 },
  { x: 0, y: 2 }
]

const EDGES: { x: Side; y: Side }[] = [
  { x: 1, y: 0 },
  { x: 2, y: 1 },
  { x: 1, y: 2 },
  { x: 0, y: 1 }
]

function sub(a: V2, b: V2): V2 {
  return [a[0] - b[0], a[1] - b[1]]
}

function unit(a: V2): V2 {
  const l = Math.hypot(a[0], a[1])
  return l < 1e-9 ? [0, 0] : [a[0] / l, a[1] / l]
}

function dist(a: V2, b: V2): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1])
}

export function segmentDistance(p: V2, a: V2, b: V2): { d: number; t: number } {
  const ab = sub(b, a)
  const l2 = ab[0] * ab[0] + ab[1] * ab[1]
  if (l2 < 1e-9) return { d: dist(p, a), t: 0 }
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1]) / l2))
  return { d: dist(p, [a[0] + ab[0] * t, a[1] + ab[1] * t]), t }
}

export function insidePolygon(p: V2, poly: V2[]): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]
    const b = poly[j]
    if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside
  }
  return inside
}

function anchorTriangle(at: V2, right: V2, up: V2, x: 0 | 1, y: 0 | 1, s = ANCHOR_PX): V2[] {
  const sx = x * 2 - 1
  const sy = y * 2 - 1
  let pos: V2 = [at[0] + right[0] * s * sx + up[0] * s * sy, at[1] + right[1] * s * sx + up[1] * s * sy]
  let r: V2 = [right[0] * s * 2 * sx, right[1] * s * 2 * sx]
  let u: V2 = [up[0] * s * 2 * sy, up[1] * s * 2 * sy]
  pos = [pos[0] - u[0] * 0.5 - r[0] * 0.5, pos[1] - u[1] * 0.5 - r[1] * 0.5]
  u = [u[0] * 1.4, u[1] * 1.4]
  r = [r[0] * 1.4, r[1] * 1.4]
  return [pos, [pos[0] + u[0] + r[0] * 0.5, pos[1] + u[1] + r[1] * 0.5], [pos[0] + r[0] + u[0] * 0.5, pos[1] + r[1] + u[1] * 0.5]]
}

export function rectScreen(info: TunerRectInfo, project: Project): RectScreen | null {
  const f = info.frame
  const r = info.rect
  const corners: V2[] = []
  for (const s of SIDES) {
    const p = project(toWorld(f, r[0] + (r[2] * s.x) / 2, r[1] + (r[3] * s.y) / 2))
    if (!p) return null
    corners.push(p)
  }
  const pivot = project(f.origin)
  if (!pivot) return null
  let parent: V2[] | null = null
  const anchors: RectScreenAnchor[] = []
  const p = info.renderer ? null : info.parent
  if (p) {
    const pc: V2[] = []
    for (const s of SIDES) {
      const q = project(toWorld(p, p.rect[0] + (p.rect[2] * s.x) / 2, p.rect[1] + (p.rect[3] * s.y) / 2))
      if (q) pc.push(q)
    }
    parent = pc.length === 4 ? pc : null
    for (const a of anchorCornersParent(info)) {
      const at = project(toWorld(p, a.p[0], a.p[1]))
      const ar = project(toWorld(p, a.p[0] + 1, a.p[1]))
      const au = project(toWorld(p, a.p[0], a.p[1] + 1))
      if (!at || !ar || !au) continue
      anchors.push({ x: a.x, y: a.y, at, tri: anchorTriangle(at, unit(sub(ar, at)), unit(sub(au, at)), a.x, a.y) })
    }
    const fused = fusedState(info)
    const min = anchors.find((a) => a.x === 0 && a.y === 0)
    const max = anchors.find((a) => a.x === 1 && a.y === 1)
    if (min && max) {
      if (fused === 'all') anchors.push({ x: 2, y: 2, at: min.at, tri: null })
      if (fused === 'horizontal') {
        anchors.push({ x: 2, y: 0, at: min.at, tri: null })
        anchors.push({ x: 2, y: 1, at: max.at, tri: null })
      }
      if (fused === 'vertical') {
        anchors.push({ x: 0, y: 2, at: min.at, tri: null })
        anchors.push({ x: 1, y: 2, at: max.at, tri: null })
      }
    }
  }
  return { corners, pivot, parent, anchors }
}

function centroid(t: V2[]): V2 {
  return [(t[0][0] + t[1][0] + t[2][0]) / 3, (t[0][1] + t[1][1] + t[2][1]) / 3]
}

export function hitRect(sc: RectScreen, x: number, y: number, canRotate = true, canPivot = true): RectHandle | null {
  const m: V2 = [x, y]
  let best: { h: RectHandle; d: number } | null = null
  const offer = (h: RectHandle, d: number, limit: number): void => {
    if (d <= limit && (!best || d < best.d)) best = { h, d }
  }
  if (canPivot) offer({ kind: 'pivot' }, dist(m, sc.pivot), PIVOT_HIT)
  for (const a of sc.anchors) {
    if (a.tri) {
      const inside = insidePolygon(m, a.tri)
      offer({ kind: 'anchor', x: a.x, y: a.y }, inside ? 0 : dist(m, centroid(a.tri)), ANCHOR_PX + 2)
    } else offer({ kind: 'anchor', x: a.x, y: a.y }, dist(m, a.at) + 0.5, ANCHOR_PX * 0.6)
  }
  sc.corners.forEach((c, i) => offer({ kind: 'resize', x: SIDES[i].x, y: SIDES[i].y }, dist(m, c), CORNER_HIT))
  if (best) return (best as { h: RectHandle }).h
  for (let i = 0; i < 4; i++) {
    const s = segmentDistance(m, sc.corners[i], sc.corners[(i + 1) % 4])
    const len = dist(sc.corners[i], sc.corners[(i + 1) % 4])
    const margin = len > 4 * CORNER_HIT ? CORNER_HIT / len : 0
    if (s.d <= EDGE_HIT && s.t >= margin && s.t <= 1 - margin) offer({ kind: 'resize', x: EDGES[i].x, y: EDGES[i].y }, s.d, EDGE_HIT)
  }
  if (best) return (best as { h: RectHandle }).h
  const inside = insidePolygon(m, sc.corners)
  if (inside) return { kind: 'move' }
  if (!canRotate) return null
  sc.corners.forEach((c, i) => offer({ kind: 'rotate', x: SIDES[i].x as 0 | 2, y: SIDES[i].y as 0 | 2 }, dist(m, c), ROTATE_HIT))
  return best ? (best as { h: RectHandle }).h : null
}

export function sameRectHandle(a: RectHandle | null, b: RectHandle | null): boolean {
  if (!a || !b) return a === b
  if (a.kind !== b.kind) return false
  if (a.kind === 'move' || a.kind === 'pivot') return true
  const bb = b as { x: number; y: number }
  return a.x === bb.x && a.y === bb.y
}

export function rectCursor(h: RectHandle | null, sc: RectScreen | null, dragging: boolean): string {
  if (!h) return 'default'
  if (h.kind === 'move') return dragging ? 'grabbing' : 'move'
  if (h.kind === 'pivot' || h.kind === 'anchor') return dragging ? 'grabbing' : 'pointer'
  if (h.kind === 'rotate') return dragging ? 'grabbing' : 'alias'
  if (!sc) return 'move'
  const c = sc.corners
  const mid = (i: number): V2 => [(c[i][0] + c[(i + 1) % 4][0]) / 2, (c[i][1] + c[(i + 1) % 4][1]) / 2]
  const centre: V2 = [(c[0][0] + c[2][0]) / 2, (c[0][1] + c[2][1]) / 2]
  let p: V2
  if (h.x !== 1 && h.y !== 1) p = c[SIDES.findIndex((s) => s.x === h.x && s.y === h.y)]
  else p = mid(EDGES.findIndex((s) => s.x === h.x && s.y === h.y))
  const a = (Math.atan2(p[1] - centre[1], p[0] - centre[0]) * 180) / Math.PI
  const k = ((Math.round(a / 45) % 4) + 4) % 4
  return ['ew-resize', 'nwse-resize', 'ns-resize', 'nesw-resize'][k]
}

export interface RectColors {
  accent: string
  outline: string
  parent: string
  label: string
  labelBg: string
  shadow: string
}

export type RectLabels = 'none' | 'distances' | 'anchors'

function strokePoly(ctx: CanvasRenderingContext2D, pts: V2[], closed: boolean): void {
  ctx.beginPath()
  pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])))
  if (closed) ctx.closePath()
  ctx.stroke()
}

function parentPoint(info: TunerRectInfo, project: Project, p: V2): V2 | null {
  return info.parent ? project(toWorld(info.parent, p[0], p[1])) : null
}

function drawLabel(ctx: CanvasRenderingContext2D, info: TunerRectInfo, project: Project, l: RectLabel, colors: RectColors, dotted: boolean): void {
  const a = parentPoint(info, project, l.a)
  const b = parentPoint(info, project, l.b)
  if (!a || !b) return
  if (dotted) {
    ctx.save()
    ctx.setLineDash([3, 3])
    ctx.strokeStyle = colors.shadow
    ctx.lineWidth = 1
    strokePoly(ctx, [[a[0] + 1, a[1] + 1], [b[0] + 1, b[1] + 1]], false)
    ctx.strokeStyle = colors.outline
    strokePoly(ctx, [a, b], false)
    ctx.restore()
  }
  const cx = (a[0] + b[0]) / 2
  const cy = (a[1] + b[1]) / 2
  ctx.font = '600 10px ui-sans-serif, system-ui, sans-serif'
  const w = ctx.measureText(l.text).width + 8
  ctx.fillStyle = colors.labelBg
  ctx.beginPath()
  ctx.roundRect(cx - w / 2, cy - 7.5, w, 15, 3)
  ctx.fill()
  ctx.fillStyle = colors.label
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(l.text, cx, cy + 0.5)
}

export function drawRectTool(
  ctx: CanvasRenderingContext2D,
  info: TunerRectInfo,
  sc: RectScreen,
  project: Project,
  opts: { hover: RectHandle | null; active: RectHandle | null; labels: RectLabels; colors: RectColors; dpr: number }
): void {
  const { colors } = opts
  ctx.save()
  ctx.scale(opts.dpr, opts.dpr)
  ctx.lineJoin = 'round'
  if (sc.parent) {
    ctx.strokeStyle = colors.parent
    ctx.lineWidth = 1
    strokePoly(ctx, sc.parent, true)
  }
  if (opts.labels !== 'none' && info.parent) {
    ctx.save()
    ctx.setLineDash([4, 3])
    ctx.lineWidth = 1
    for (const [a, b] of anchorLines(info)) {
      const pa = parentPoint(info, project, a)
      const pb = parentPoint(info, project, b)
      if (!pa || !pb) continue
      ctx.strokeStyle = colors.shadow
      strokePoly(ctx, [[pa[0] + 1, pa[1] + 1], [pb[0] + 1, pb[1] + 1]], false)
      ctx.strokeStyle = colors.outline
      strokePoly(ctx, [pa, pb], false)
    }
    ctx.restore()
  }
  ctx.lineWidth = 1
  ctx.strokeStyle = colors.shadow
  strokePoly(ctx, sc.corners.map((p) => [p[0] + 1, p[1] + 1] as V2), true)
  ctx.lineWidth = 1.5
  ctx.strokeStyle = colors.accent
  strokePoly(ctx, sc.corners, true)
  const hot = opts.active ?? opts.hover
  sc.corners.forEach((c, i) => {
    const on = hot?.kind === 'resize' && hot.x === SIDES[i].x && hot.y === SIDES[i].y
    ctx.beginPath()
    ctx.arc(c[0], c[1], on ? 4.5 : 3.5, 0, Math.PI * 2)
    ctx.fillStyle = colors.accent
    ctx.fill()
    ctx.lineWidth = 1
    ctx.strokeStyle = colors.shadow
    ctx.stroke()
  })
  for (const a of sc.anchors) {
    if (!a.tri) continue
    const on = hot?.kind === 'anchor' && (hot.x === a.x || hot.x === 2) && (hot.y === a.y || hot.y === 2)
    ctx.beginPath()
    a.tri.forEach((p, i) => (i ? ctx.lineTo(p[0] + 1, p[1] + 1) : ctx.moveTo(p[0] + 1, p[1] + 1)))
    ctx.closePath()
    ctx.fillStyle = colors.shadow
    ctx.fill()
    ctx.beginPath()
    a.tri.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])))
    ctx.closePath()
    ctx.fillStyle = on ? colors.accent : '#ffffff'
    ctx.fill()
  }
  const pivotOn = hot?.kind === 'pivot'
  ctx.beginPath()
  ctx.arc(sc.pivot[0], sc.pivot[1], pivotOn ? 6 : 5, 0, Math.PI * 2)
  ctx.lineWidth = 3
  ctx.strokeStyle = colors.shadow
  ctx.stroke()
  ctx.lineWidth = 1.75
  ctx.strokeStyle = colors.accent
  ctx.stroke()
  ctx.beginPath()
  ctx.arc(sc.pivot[0], sc.pivot[1], 1.5, 0, Math.PI * 2)
  ctx.fillStyle = colors.accent
  ctx.fill()
  if (opts.labels === 'distances') for (const l of distanceLabels(info)) drawLabel(ctx, info, project, l, colors, true)
  if (opts.labels === 'anchors') for (const l of anchorPercentLabels(info)) drawLabel(ctx, info, project, l, colors, false)
  ctx.restore()
}
