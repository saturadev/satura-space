import { Quaternion } from 'three'
import type { Quat, TunerBounds, Vec3 } from '@shared/tuner'
import type { Ray } from './orbit'
import { qarr, quat, rotate, vec } from './space'

export type HandleMode = 'move' | 'rotate' | 'scale' | 'rect'
export type HandleSpace = 'local' | 'global'
export type HandlePivot = 'pivot' | 'center'
export type Axis = 0 | 1 | 2
export type HandleId = { kind: 'axis'; axis: Axis } | { kind: 'plane'; axis: Axis } | { kind: 'ring'; axis: Axis } | { kind: 'scale'; axis: Axis | 3 }

export const MOVE_SNAP = 0.25
export const ROTATE_SNAP = 15
export const SCALE_SNAP = 0.1
export const SCALE_MIN = 0.001
export const AXIS_NAMES = ['X', 'Y', 'Z'] as const

const UNIT: Vec3[] = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1]
]

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

function add(a: Vec3, b: Vec3, k = 1): Vec3 {
  return [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k]
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

function handleAxes(rotation: Quat, space: HandleSpace): [Vec3, Vec3, Vec3] {
  if (space === 'global') return [UNIT[0], UNIT[1], UNIT[2]]
  return [rotate(rotation, UNIT[0]), rotate(rotation, UNIT[1]), rotate(rotation, UNIT[2])]
}

export function snapStep(v: number, step: number): number {
  const r = Math.round(v / step) * step
  return Object.is(r, -0) ? 0 : r
}

function axisParam(ray: Ray, origin: Vec3, axis: Vec3): number | null {
  const w0 = sub(origin, ray.origin)
  const a = dot(axis, axis)
  const b = dot(axis, ray.dir)
  const c = dot(ray.dir, ray.dir)
  const d = dot(axis, w0)
  const e = dot(ray.dir, w0)
  const denom = a * c - b * b
  if (denom < 1e-4) return null
  return (b * e - c * d) / denom
}

function planeHit(ray: Ray, point: Vec3, normal: Vec3): Vec3 | null {
  const denom = dot(normal, ray.dir)
  if (Math.abs(denom) < 1e-4) return null
  const t = dot(sub(point, ray.origin), normal) / denom
  if (t < 0) return null
  return add(ray.origin, ray.dir, t)
}

export function moveAlongAxis(start: Vec3, axis: Vec3, s0: number, s1: number, snap: boolean, step = MOVE_SNAP): Vec3 {
  const delta = snap ? snapStep(s1 - s0, step) : s1 - s0
  return add(start, axis, delta)
}

export function moveInPlane(start: Vec3, hit0: Vec3, hit1: Vec3, u: Vec3, v: Vec3, snap: boolean, step = MOVE_SNAP): Vec3 {
  const d = sub(hit1, hit0)
  let a = dot(d, u)
  let b = dot(d, v)
  if (snap) {
    a = snapStep(a, step)
    b = snapStep(b, step)
  }
  return add(add(start, u, a), v, b)
}

function signedAngle(a: Vec3, b: Vec3, normal: Vec3): number {
  return (Math.atan2(dot(cross(a, b), normal), dot(a, b)) * 180) / Math.PI
}

function rotateAbout(start: Quat, axis: Vec3, deg: number): Quat {
  const r = new Quaternion().setFromAxisAngle(vec(axis).normalize(), (deg * Math.PI) / 180)
  return qarr(r.multiply(quat(start)))
}

export function wrapDeg(d: number): number {
  let x = d
  while (x > 180) x -= 360
  while (x < -180) x += 360
  return x
}

export function planeAxes(i: Axis): [Axis, Axis] {
  return i === 0 ? [1, 2] : i === 1 ? [0, 2] : [0, 1]
}

function rayAabb(ray: Ray, b: TunerBounds): number | null {
  let tmin = -Infinity
  let tmax = Infinity
  for (let i = 0; i < 3; i++) {
    const half = Math.max(Math.abs(b.size[i]) / 2, 1e-4)
    const lo = b.center[i] - half
    const hi = b.center[i] + half
    const o = ray.origin[i]
    const d = ray.dir[i]
    if (Math.abs(d) < 1e-12) {
      if (o < lo || o > hi) return null
      continue
    }
    let t1 = (lo - o) / d
    let t2 = (hi - o) / d
    if (t1 > t2) [t1, t2] = [t2, t1]
    tmin = Math.max(tmin, t1)
    tmax = Math.min(tmax, t2)
    if (tmin > tmax) return null
  }
  if (tmax < 0) return null
  return tmin >= 0 ? tmin : 0
}

export function pickNearest<T extends { id: string; bounds: TunerBounds | null }>(ray: Ray, objects: T[]): string | null {
  let best: string | null = null
  let bestT = Infinity
  let bestVol = Infinity
  for (const o of objects) {
    if (!o.bounds) continue
    const t = rayAabb(ray, o.bounds)
    if (t == null) continue
    const vol = Math.abs(o.bounds.size[0] * o.bounds.size[1] * o.bounds.size[2])
    if (t === 0 && bestT === 0 ? vol < bestVol : t < bestT) {
      best = o.id
      bestT = t
      bestVol = vol
    }
  }
  return best
}

export function pickPlanar<T extends { id: string; bounds: TunerBounds | null }>(
  x: number,
  y: number,
  objects: T[],
  pad = 0
): string | null {
  let best: string | null = null
  let bestArea = Infinity
  for (const o of objects) {
    if (!o.bounds) continue
    const hx = Math.abs(o.bounds.size[0]) / 2
    const hy = Math.abs(o.bounds.size[1]) / 2
    if (Math.abs(x - o.bounds.center[0]) > hx + pad || Math.abs(y - o.bounds.center[1]) > hy + pad) continue
    const area = hx * hy
    if (area <= bestArea) {
      best = o.id
      bestArea = area
    }
  }
  return best
}

export interface DragStart {
  handle: HandleId
  position: Vec3
  rotation: Quat
  scale: Vec3
  size: number
  axes: [Vec3, Vec3, Vec3]
  param: number | null
  hit: Vec3 | null
  x: number
  y: number
  total: number
  last: number
}

export interface DragResult {
  position?: Vec3
  rotation?: Quat
  localScale?: Vec3
  readout: string
}

function fmt(n: number): string {
  const r = Math.round(n * 1000) / 1000
  return `${r > 0 ? '+' : ''}${Object.is(r, -0) ? 0 : r}`
}

export function beginDrag(
  handle: HandleId,
  position: Vec3,
  rotation: Quat,
  space: HandleSpace,
  ray: Ray,
  x: number,
  y: number,
  scale: Vec3 = [1, 1, 1],
  size = 1
): DragStart {
  const axes = handleAxes(rotation, handle.kind === 'scale' ? 'local' : space)
  const base: DragStart = { handle, position, rotation, scale, size: Math.max(1e-6, size), axes, param: null, hit: null, x, y, total: 0, last: 0 }
  if (handle.kind === 'axis') return { ...base, param: axisParam(ray, position, axes[handle.axis]) }
  if (handle.kind === 'scale') return handle.axis === 3 ? base : { ...base, param: axisParam(ray, position, axes[handle.axis]) }
  return { ...base, hit: planeHit(ray, position, axes[handle.axis]) }
}

export function updateDrag(
  d: DragStart,
  ray: Ray,
  x: number,
  y: number,
  snap: boolean,
  cameraForward: Vec3,
  step = MOVE_SNAP,
  unit = ' m'
): DragResult | null {
  const { handle, axes } = d
  if (handle.kind === 'scale') {
    let f: number
    if (handle.axis === 3) f = 1 + ((x - d.x) - (y - d.y)) / 100
    else {
      const s = axisParam(ray, d.position, axes[handle.axis])
      if (s == null || d.param == null) return null
      f = 1 + (s - d.param) / d.size
    }
    if (snap) f = snapStep(f, SCALE_SNAP)
    const k = (v: number): number => (Math.abs(v * f) < SCALE_MIN ? Math.sign(v || 1) * SCALE_MIN : v * f)
    const localScale: Vec3 =
      handle.axis === 3 ? [k(d.scale[0]), k(d.scale[1]), k(d.scale[2])] : (d.scale.map((v, i) => (i === handle.axis ? k(v) : v)) as Vec3)
    const name = handle.axis === 3 ? 'Scale' : `Scale ${AXIS_NAMES[handle.axis]}`
    return { localScale, readout: `${name} ×${Math.round(f * 1000) / 1000}` }
  }
  if (handle.kind === 'axis') {
    const s = axisParam(ray, d.position, axes[handle.axis])
    if (s == null || d.param == null) return null
    const position = moveAlongAxis(d.position, axes[handle.axis], d.param, s, snap, step)
    const delta = dot(sub(position, d.position), axes[handle.axis])
    return { position, readout: `${AXIS_NAMES[handle.axis]} ${fmt(delta)}${unit}` }
  }
  if (handle.kind === 'plane') {
    const hit = planeHit(ray, d.position, axes[handle.axis])
    if (!hit || !d.hit) return null
    const [i, j] = planeAxes(handle.axis)
    const position = moveInPlane(d.position, d.hit, hit, axes[i], axes[j], snap, step)
    const delta = sub(position, d.position)
    return {
      position,
      readout: `${AXIS_NAMES[i]} ${fmt(dot(delta, axes[i]))} · ${AXIS_NAMES[j]} ${fmt(dot(delta, axes[j]))}${unit}`
    }
  }
  const n = axes[handle.axis]
  const hit = planeHit(ray, d.position, n)
  if (d.hit && hit && Math.abs(dot(ray.dir, n)) > 0.08) {
    const a = signedAngle(sub(d.hit, d.position), sub(hit, d.position), n)
    d.total += wrapDeg(a - d.last)
    d.last = a
  } else if (!d.hit) {
    const facing = dot(n, cameraForward) >= 0 ? 1 : -1
    d.total = ((x - d.x) - (y - d.y)) * 0.5 * facing
  }
  const deg = snap ? snapStep(d.total, ROTATE_SNAP) : d.total
  return { rotation: rotateAbout(d.rotation, n, deg), readout: `${AXIS_NAMES[handle.axis]} ${fmt(Math.round(deg * 10) / 10)}°` }
}
