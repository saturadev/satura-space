import type { TunerBounds, TunerCamera, TunerShadow, Vec3 } from '@shared/tuner'
import { TUNER_SHADOW_LIGHT } from '@shared/tuner'
import { projectPoint, unitsPerPixel } from './orbit'

export const DOT_RADIUS = 3.5
export const DOT_PICK_PX = 8
export const SHADOW_RADIUS_PX = 11

export type DotState = 'idle' | 'hover' | 'selected'

export interface MarkerObject {
  id: string
  position: Vec3
  bounds: TunerBounds | null
  active: boolean
  error?: string
}

export interface ScreenDot {
  id: string
  x: number
  y: number
  depth: number
  state: DotState
}

export interface ScreenShadow {
  id: string
  from: [number, number]
  to: [number, number] | null
  outline: [number, number][]
  strength: number
  surface: TunerShadow['surface']
}

export interface MarkerLayout {
  dots: ScreenDot[]
  shadows: ScreenShadow[]
}

type Cam = Pick<TunerCamera, 'position' | 'rotation' | 'fov' | 'ortho'>

export function toScreen(cam: Cam, p: Vec3, width: number, height: number): [number, number, number] | null {
  const s = projectPoint(cam, p, width / Math.max(1, height))
  if (!s) return null
  return [(s[0] * 0.5 + 0.5) * width, (1 - (s[1] * 0.5 + 0.5)) * height, s[2]]
}

export function isEmptyObject(o: MarkerObject): boolean {
  return !o.error && !o.bounds && o.active
}

export function groundShadow(position: Vec3, light: Vec3 = TUNER_SHADOW_LIGHT): TunerShadow['point'] {
  if (Math.abs(light[1]) < 1e-6) return [position[0], 0, position[2]]
  const t = -position[1] / light[1]
  return [position[0] + light[0] * t, 0, position[2] + light[2] * t]
}

function basis(n: Vec3): [Vec3, Vec3] {
  const m = Math.hypot(n[0], n[1], n[2]) || 1
  const nn: Vec3 = [n[0] / m, n[1] / m, n[2] / m]
  const a: Vec3 = Math.abs(nn[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]
  const u: Vec3 = [nn[1] * a[2] - nn[2] * a[1], nn[2] * a[0] - nn[0] * a[2], nn[0] * a[1] - nn[1] * a[0]]
  const um = Math.hypot(u[0], u[1], u[2]) || 1
  const uu: Vec3 = [u[0] / um, u[1] / um, u[2] / um]
  const v: Vec3 = [nn[1] * uu[2] - nn[2] * uu[1], nn[2] * uu[0] - nn[0] * uu[2], nn[0] * uu[1] - nn[1] * uu[0]]
  return [uu, v]
}

export function shadowOutline(cam: Cam, point: Vec3, normal: Vec3, width: number, height: number, radiusPx = SHADOW_RADIUS_PX, steps = 28): [number, number][] {
  const dist = Math.hypot(point[0] - cam.position[0], point[1] - cam.position[1], point[2] - cam.position[2])
  const r = unitsPerPixel(dist, cam.fov, height) * radiusPx
  const m = Math.hypot(normal[0], normal[1], normal[2]) || 1
  const off = r * 0.08 + 0.002
  const c: Vec3 = [point[0] + (normal[0] / m) * off, point[1] + (normal[1] / m) * off, point[2] + (normal[2] / m) * off]
  const [u, v] = basis(normal)
  const out: [number, number][] = []
  for (let k = 0; k < steps; k++) {
    const a = (k / steps) * Math.PI * 2
    const cs = Math.cos(a) * r
    const sn = Math.sin(a) * r
    const p: Vec3 = [c[0] + u[0] * cs + v[0] * sn, c[1] + u[1] * cs + v[1] * sn, c[2] + u[2] * cs + v[2] * sn]
    const s = toScreen(cam, p, width, height)
    if (!s) return []
    out.push([s[0], s[1]])
  }
  return out
}

export function markerLayout(
  cam: Cam,
  width: number,
  height: number,
  objects: MarkerObject[],
  selected: string | null,
  hovered: string | null,
  shadow: TunerShadow | null,
  also?: ReadonlySet<string>
): MarkerLayout {
  const dots: ScreenDot[] = []
  const shadows: ScreenShadow[] = []
  for (const o of objects) {
    if (!isEmptyObject(o)) continue
    const s = toScreen(cam, o.position, width, height)
    if (!s) continue
    const state: DotState = o.id === selected || also?.has(o.id) ? 'selected' : o.id === hovered ? 'hover' : 'idle'
    dots.push({ id: o.id, x: s[0], y: s[1], depth: s[2], state })
    if (o.id !== selected || cam.ortho) continue
    const engine = shadow && shadow.id === o.id ? shadow : null
    const point = engine ? engine.point : groundShadow(o.position)
    const normal: Vec3 = engine ? engine.normal : [0, 1, 0]
    const to = toScreen(cam, point, width, height)
    shadows.push({
      id: o.id,
      from: [s[0], s[1]],
      to: to ? [to[0], to[1]] : null,
      outline: shadowOutline(cam, point, normal, width, height),
      strength: 1,
      surface: engine ? engine.surface : 'ground'
    })
  }
  dots.sort((a, b) => b.depth - a.depth)
  return { dots, shadows }
}

export function pickDot(layout: MarkerLayout, x: number, y: number, radius = DOT_PICK_PX): string | null {
  let best: string | null = null
  let bestD = radius
  for (const d of layout.dots) {
    const dd = Math.hypot(d.x - x, d.y - y)
    if (dd <= bestD) {
      bestD = dd
      best = d.id
    }
  }
  return best
}

export interface MarkerColors {
  accent: [number, number, number]
  ring: [number, number, number]
}

const DEFAULT_MARKER_COLORS: MarkerColors = { accent: [56, 189, 248], ring: [8, 10, 14] }

function rgba(c: [number, number, number], a: number): string {
  return `rgba(${c[0]},${c[1]},${c[2]},${a})`
}

function lift(c: [number, number, number], t: number): [number, number, number] {
  return [Math.round(c[0] + (255 - c[0]) * t), Math.round(c[1] + (255 - c[1]) * t), Math.round(c[2] + (255 - c[2]) * t)]
}

export function drawMarkers(
  ctx: CanvasRenderingContext2D,
  layout: MarkerLayout,
  dpr: number,
  colors: MarkerColors = DEFAULT_MARKER_COLORS
): void {
  if (layout.dots.length === 0) return
  ctx.save()
  ctx.scale(dpr, dpr)
  for (const d of layout.dots) {
    const r = d.state === 'selected' ? DOT_RADIUS + 1 : DOT_RADIUS
    ctx.beginPath()
    ctx.arc(d.x, d.y, r + 1.5, 0, Math.PI * 2)
    ctx.fillStyle = rgba(colors.ring, 0.85)
    ctx.fill()
    ctx.beginPath()
    ctx.arc(d.x, d.y, r, 0, Math.PI * 2)
    ctx.fillStyle = rgba(d.state === 'idle' ? colors.accent : lift(colors.accent, d.state === 'hover' ? 0.35 : 0.8), 1)
    ctx.fill()
    if (d.state === 'selected') {
      ctx.beginPath()
      ctx.arc(d.x, d.y, r + 3.5, 0, Math.PI * 2)
      ctx.strokeStyle = rgba(lift(colors.accent, 0.35), 0.7)
      ctx.lineWidth = 1.25
      ctx.stroke()
    }
  }
  ctx.restore()
}
