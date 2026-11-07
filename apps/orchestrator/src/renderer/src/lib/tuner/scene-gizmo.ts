import type { Quat, Vec3 } from '@shared/tuner'
import { orbitRotation, type Orbit } from './orbit'
import { rotate } from './space'

export type GizmoPart = number | 'cube' | 'label'

type V2 = [number, number]

const GIZMO_DIRS: Vec3[] = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
  [-1, 0, 0],
  [0, -1, 0],
  [0, 0, -1]
]
export const GIZMO_VIEW_NAMES = ['Right', 'Top', 'Front', 'Left', 'Bottom', 'Back']
const SNAP_ANGLES: V2[] = [
  [-90, 0],
  [0, 90],
  [180, 0],
  [90, 0],
  [0, -90],
  [0, 0]
]

export const GIZMO_GEOMETRY = { right: 54, top: 50, cube: 7, apex: 9.5, base: 27, radius: 6.5, axisLabel: 37, caption: 48 }
const SIDES = 20
const LIGHT: Vec3 = normalize([-0.4, 0.55, -0.75])
const FONT = '600 11px ui-sans-serif, system-ui, sans-serif'
export const GIZMO_CAPTION_FONT = '500 11px ui-sans-serif, system-ui, sans-serif'

export interface GizmoColors {
  axes: number[]
  negative: number
  cube: number
  hover: number
}

interface Poly {
  pts: V2[]
  fill: string
}

export interface GizmoItem {
  part: GizmoPart
  z: number
  alpha: number
  polys: Poly[]
  hull: V2[]
  center: V2
}

export interface GizmoScene {
  cx: number
  cy: number
  items: GizmoItem[]
  labels: { text: string; x: number; y: number; color: string; alpha: number }[]
  caption: { text: string; ortho: boolean; x: number; y: number; w: number; h: number; hover: boolean }
}

function normalize(v: Vec3): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1
  return [v[0] / l, v[1] / l, v[2] / l]
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

function add(a: Vec3, b: Vec3, k = 1): Vec3 {
  return [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k]
}

function scale(a: Vec3, k: number): Vec3 {
  return [a[0] * k, a[1] * k, a[2] * k]
}

function shade(color: number, n: Vec3, dim = 1): string {
  const b = (0.6 + 0.4 * Math.max(0, dot(normalize(n), LIGHT))) * dim
  const r = Math.min(255, Math.round(((color >> 16) & 255) * b))
  const g = Math.min(255, Math.round(((color >> 8) & 255) * b))
  const bl = Math.min(255, Math.round((color & 255) * b))
  return `rgb(${r},${g},${bl})`
}

function hex(color: number): string {
  return `#${color.toString(16).padStart(6, '0')}`
}

export function snapOrbit(o: Orbit, dir: number): Orbit {
  const [yaw, pitch] = SNAP_ANGLES[dir]
  return { ...o, yaw, pitch }
}

function gizmoView(o: Orbit): number {
  const q = orbitRotation(o)
  for (let i = 0; i < 6; i++) {
    const s = orbitRotation(snapOrbit(o, i))
    if (Math.abs(q[0] * s[0] + q[1] * s[1] + q[2] * s[2] + q[3] * s[3]) > 0.99998) return i
  }
  return -1
}

export function gizmoClickDir(o: Orbit, dir: number): number {
  return gizmoView(o) === dir ? (dir + 3) % 6 : dir
}

export function gizmoCaption(o: Orbit, ortho: boolean): string {
  if (!ortho) return 'Persp'
  const v = gizmoView(o)
  return v >= 0 ? GIZMO_VIEW_NAMES[v] : 'Iso'
}

export function convexHull(points: V2[]): V2[] {
  const p = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1])
  if (p.length < 3) return p
  const cross = (o: V2, a: V2, b: V2): number => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  const lower: V2[] = []
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop()
    lower.push(q)
  }
  const upper: V2[] = []
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i]
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop()
    upper.push(q)
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)]
}

export function insidePoly(poly: V2[], x: number, y: number): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]
    const [xj, yj] = poly[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

function axisFade(depth: number): number {
  return Math.max(0, Math.min(1, (0.985 - Math.abs(depth)) / 0.085))
}

export function gizmoScene(
  rotation: Quat,
  width: number,
  caption: string,
  ortho: boolean,
  hover: GizmoPart | null,
  colors: GizmoColors,
  measure: (text: string) => number,
  size = 1
): GizmoScene {
  const G = size === 1 ? GIZMO_GEOMETRY : (Object.fromEntries(Object.entries(GIZMO_GEOMETRY).map(([k, v]) => [k, v * size])) as typeof GIZMO_GEOMETRY)
  const cx = width - G.right
  const cy = G.top
  const inv: Quat = [-rotation[0], -rotation[1], -rotation[2], rotation[3]]
  const axes = GIZMO_DIRS.map((d) => rotate(inv, d))
  const screen = (v: Vec3): V2 => [cx + v[0], cy - v[1]]
  const items: GizmoItem[] = []
  const labels: GizmoScene['labels'] = []

  const cubeColor = hover === 'cube' ? colors.hover : colors.cube
  const cubePolys: Poly[] = []
  const corners: V2[] = []
  for (let k = 0; k < 6; k++) {
    const n = axes[k]
    const u = axes[(k + 1) % 3]
    const w = axes[(k + 2) % 3]
    const c = scale(n, G.cube)
    const quad: Vec3[] = [add(add(c, u, G.cube), w, G.cube), add(add(c, u, -G.cube), w, G.cube), add(add(c, u, -G.cube), w, -G.cube), add(add(c, u, G.cube), w, -G.cube)]
    const pts = quad.map(screen)
    corners.push(...pts)
    if (n[2] < -1e-4) cubePolys.push({ pts, fill: shade(cubeColor, n) })
  }
  items.push({ part: 'cube', z: 0, alpha: 1, polys: cubePolys, hull: convexHull(corners), center: [cx, cy] })

  for (let i = 0; i < 6; i++) {
    const d = axes[i]
    const alpha = axisFade(d[2])
    const a = axes[(i + 1) % 3]
    const b = axes[(i + 2) % 3]
    const apex = scale(d, G.apex)
    const base = scale(d, G.base)
    const slant = G.base - G.apex
    const color = hover === i ? colors.hover : i < 3 ? colors.axes[i] : colors.negative
    const dim = 1 - 0.3 * Math.max(0, d[2])
    const rim: Vec3[] = []
    for (let j = 0; j < SIDES; j++) {
      const t = (j / SIDES) * Math.PI * 2
      rim.push(add(base, add(scale(a, Math.cos(t)), b, Math.sin(t)), G.radius))
    }
    const polys: Poly[] = []
    for (let j = 0; j < SIDES; j++) {
      const t = ((j + 0.5) / SIDES) * Math.PI * 2
      const r = add(scale(a, Math.cos(t)), b, Math.sin(t))
      const n = add(scale(r, slant), d, -G.radius)
      if (n[2] < 0) polys.push({ pts: [screen(apex), screen(rim[j]), screen(rim[(j + 1) % SIDES])], fill: shade(color, n, dim) })
    }
    if (d[2] < 0) polys.push({ pts: rim.map(screen), fill: shade(color, d, dim * 0.92) })
    const mid = screen(scale(d, (G.apex + G.base) / 2))
    items.push({ part: i, z: d[2] * (G.apex + G.base) * 0.5, alpha, polys, hull: convexHull([screen(apex), ...rim.map(screen)]), center: mid })
    if (i < 3 && alpha > 0.01) {
      const [lx, ly] = screen(scale(d, G.axisLabel))
      labels.push({ text: 'xyz'[i], x: lx, y: ly, color: hex(hover === i ? colors.hover : colors.axes[i]), alpha })
    }
  }
  items.sort((p, q) => q.z - p.z)

  const tw = measure(caption)
  const w = 12 + tw
  return {
    cx,
    cy,
    items,
    labels,
    caption: { text: caption, ortho, x: cx - w / 2, y: cy + G.caption - 8, w, h: 16, hover: hover === 'label' }
  }
}

export function gizmoHit(scene: GizmoScene, x: number, y: number): GizmoPart | null {
  const c = scene.caption
  if (x >= c.x - 4 && x <= c.x + c.w + 4 && y >= c.y && y <= c.y + c.h) return 'label'
  for (let i = scene.items.length - 1; i >= 0; i--) {
    const it = scene.items[i]
    if (it.alpha < 0.35) continue
    if (insidePoly(it.hull, x, y)) return it.part
  }
  return null
}

let scratch: HTMLCanvasElement | null = null

function paintItem(ctx: CanvasRenderingContext2D, it: GizmoItem): void {
  ctx.lineWidth = 0.6
  ctx.lineJoin = 'round'
  for (const p of it.polys) {
    ctx.beginPath()
    ctx.moveTo(p.pts[0][0], p.pts[0][1])
    for (let k = 1; k < p.pts.length; k++) ctx.lineTo(p.pts[k][0], p.pts[k][1])
    ctx.closePath()
    ctx.fillStyle = p.fill
    ctx.strokeStyle = p.fill
    ctx.fill()
    ctx.stroke()
  }
}

export function drawGizmo(ctx: CanvasRenderingContext2D, scene: GizmoScene, dpr: number): void {
  ctx.save()
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  const box = 2 * (GIZMO_GEOMETRY.base + GIZMO_GEOMETRY.radius + 2)
  const ox = scene.cx - box / 2
  const oy = scene.cy - box / 2
  for (const it of scene.items) {
    if (it.alpha <= 0.01 || it.polys.length === 0) continue
    if (it.alpha >= 0.999) {
      paintItem(ctx, it)
      continue
    }
    const sw = Math.ceil(box * dpr)
    if (!scratch) scratch = document.createElement('canvas')
    if (scratch.width !== sw || scratch.height !== sw) {
      scratch.width = sw
      scratch.height = sw
    }
    const sc = scratch.getContext('2d')
    if (!sc) continue
    sc.setTransform(1, 0, 0, 1, 0, 0)
    sc.clearRect(0, 0, sw, sw)
    const px = Math.round(ox * dpr)
    const py = Math.round(oy * dpr)
    sc.setTransform(dpr, 0, 0, dpr, -px, -py)
    paintItem(sc, it)
    ctx.save()
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.globalAlpha = it.alpha
    ctx.drawImage(scratch, px, py)
    ctx.restore()
  }
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.font = FONT
  ctx.shadowColor = 'rgba(0,0,0,0.55)'
  ctx.shadowBlur = 2
  for (const l of scene.labels) {
    ctx.globalAlpha = l.alpha
    ctx.fillStyle = l.color
    ctx.fillText(l.text, l.x, l.y)
  }
  ctx.globalAlpha = 1
  const c = scene.caption
  const ink = c.hover ? 'rgba(255,255,255,1)' : 'rgba(228,228,232,0.9)'
  const gx = c.x
  const my = c.y + c.h / 2
  ctx.strokeStyle = ink
  ctx.fillStyle = ink
  ctx.lineWidth = 1.2
  ctx.lineCap = 'round'
  ctx.beginPath()
  if (c.ortho) {
    for (const dy of [-3, 0, 3]) {
      ctx.moveTo(gx + 1, my + dy)
      ctx.lineTo(gx + 8, my + dy)
    }
  } else {
    ctx.moveTo(gx + 8, my - 4)
    ctx.lineTo(gx + 1, my)
    ctx.lineTo(gx + 8, my + 4)
  }
  ctx.stroke()
  ctx.font = GIZMO_CAPTION_FONT
  ctx.textAlign = 'left'
  ctx.fillText(c.text, gx + 12, my + 0.5)
  ctx.restore()
}
