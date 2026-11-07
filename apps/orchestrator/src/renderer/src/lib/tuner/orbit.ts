import { Euler, MathUtils, Quaternion } from 'three'
import type { Quat, TunerBounds, TunerCamera, Vec3 } from '@shared/tuner'
import { qarr, rotate } from './space'

export interface Orbit {
  target: Vec3
  yaw: number
  pitch: number
  distance: number
  fov: number
  ortho?: number
  orthographic?: boolean
}

type Cam = Pick<TunerCamera, 'position' | 'rotation' | 'fov' | 'ortho'>

export const DEFAULT_FOV = 60
export const MIN_DISTANCE = 0.05
export const MAX_DISTANCE = 5000
export const MIN_ORTHO = 0.005
export const MAX_ORTHO = 1_000_000
export const PLANAR_DISTANCE = 1000
export const PLANAR_RAY_BACK = 100_000
export const MAX_OUTPUT = 1600
export const MIN_OUTPUT = 64

function clampOrtho(v: number): number {
  return Math.max(MIN_ORTHO, Math.min(MAX_ORTHO, v))
}

export function planarOrbit(o: Orbit): Orbit {
  if (o.ortho) return o
  const ortho = clampOrtho(o.distance * Math.tan(MathUtils.degToRad(o.fov) / 2))
  return { target: [...o.target] as Vec3, yaw: 0, pitch: 0, distance: PLANAR_DISTANCE, fov: o.fov, ortho }
}

export function perspectiveOrbit(o: Orbit): Orbit {
  if (!o.ortho) return o
  const distance = Math.max(MIN_DISTANCE, Math.min(MAX_DISTANCE, o.ortho / Math.tan(MathUtils.degToRad(o.fov) / 2)))
  return { target: [...o.target] as Vec3, yaw: 0, pitch: 0, distance, fov: o.fov }
}

export function planarPoint(o: Orbit, ndcX: number, ndcY: number, aspect: number): Vec3 {
  const s = o.ortho ?? 1
  const rot = orbitRotation(o)
  const right = rotate(rot, [1, 0, 0])
  const up = rotate(rot, [0, 1, 0])
  const x = ndcX * s * aspect
  const y = ndcY * s
  return [0, 1, 2].map((i) => o.target[i] + right[i] * x + up[i] * y) as Vec3
}

export function planarSnap(ortho: number): number {
  return 10 ** Math.floor(Math.log10(Math.max(ortho, 1e-6) / 10))
}

export const DEFAULT_VIEW_SIZE = 10

export function defaultOrbit(target: Vec3 = [0, 0, 0]): Orbit {
  return { target, yaw: -135, pitch: MathUtils.radToDeg(Math.asin(0.7 / Math.hypot(1, 0.7, 1))), distance: sizeDistance(DEFAULT_VIEW_SIZE, DEFAULT_FOV), fov: DEFAULT_FOV }
}

export function sceneFov(fov: number, aspect: number): number {
  if (aspect >= 1) return fov
  return MathUtils.radToDeg(2 * Math.atan(Math.tan(MathUtils.degToRad(fov) / 2) / Math.max(0.05, aspect)))
}

export function sizeDistance(size: number, fov: number): number {
  return size / Math.sin(MathUtils.degToRad(fov) / 2)
}

export function orbitSize(o: Orbit): number {
  return o.distance * Math.sin(MathUtils.degToRad(o.fov) / 2)
}

export function orbitRotation(o: Orbit): Quat {
  const q = new Quaternion().setFromEuler(new Euler(MathUtils.degToRad(o.pitch), MathUtils.degToRad(o.yaw), 0, 'YXZ'))
  return qarr(q)
}

export function orbitForward(o: Orbit): Vec3 {
  const y = MathUtils.degToRad(o.yaw)
  const p = MathUtils.degToRad(o.pitch)
  return [Math.sin(y) * Math.cos(p), -Math.sin(p), Math.cos(y) * Math.cos(p)]
}

export function orbitPosition(o: Orbit): Vec3 {
  const f = orbitForward(o)
  return [0, 1, 2].map((i) => o.target[i] - f[i] * o.distance) as Vec3
}

export function outputSize(cssWidth: number, cssHeight: number, dpr: number): [number, number] {
  let w = Math.max(1, cssWidth * dpr)
  let h = Math.max(1, cssHeight * dpr)
  const long = Math.max(w, h)
  if (long > MAX_OUTPUT) {
    w = (w * MAX_OUTPUT) / long
    h = (h * MAX_OUTPUT) / long
  }
  const short = Math.min(w, h)
  if (short < MIN_OUTPUT) {
    const k = MIN_OUTPUT / short
    w = Math.min(MAX_OUTPUT, w * k)
    h = Math.min(MAX_OUTPUT, h * k)
  }
  return [Math.round(w), Math.round(h)]
}

export function orbitOrthoSize(o: Orbit, aspect = 1): number {
  return clampOrtho(orbitSize(o) / Math.min(1, Math.max(0.05, aspect)))
}

export function orbitCamera(o: Orbit, width: number, height: number, clip?: [number, number] | null): TunerCamera {
  const aspect = width / Math.max(1, height)
  const cam: TunerCamera = { position: orbitPosition(o), rotation: orbitRotation(o), fov: sceneFov(o.fov, aspect), width, height }
  if (o.ortho) cam.ortho = o.ortho
  else if (o.orthographic) {
    const size = orbitSize(o)
    const f = orbitForward(o)
    cam.position = [0, 1, 2].map((i) => o.target[i] - f[i] * 2 * size) as Vec3
    cam.ortho = orbitOrthoSize(o, aspect)
    cam.clip = clip ?? clipPlanes(size)
  } else cam.clip = clip ?? clipPlanes(orbitSize(o))
  return cam
}

export function clipPlanes(size: number): [number, number] {
  const far = Math.min(1.8e19, Math.max(1000, 2000 * size))
  return [Math.max(1e-5, far * 0.000005), far]
}

export function orbitFromLookAt(position: Vec3, lookAt: Vec3, fov = DEFAULT_FOV): Orbit {
  const d: Vec3 = [lookAt[0] - position[0], lookAt[1] - position[1], lookAt[2] - position[2]]
  const dist = Math.hypot(...d)
  if (dist < 1e-6) return { ...defaultOrbit(lookAt), fov }
  return {
    target: [...lookAt] as Vec3,
    yaw: MathUtils.radToDeg(Math.atan2(d[0], d[2])),
    pitch: MathUtils.radToDeg(Math.asin(Math.max(-1, Math.min(1, -d[1] / dist)))),
    distance: dist,
    fov
  }
}

const DEG_PER_PX = MathUtils.radToDeg(0.003)

export function orbitRotate(o: Orbit, dx: number, dy: number): Orbit {
  if (o.ortho) return o
  const pitch = Math.max(-89, Math.min(89, o.pitch + dy * DEG_PER_PX))
  let yaw = o.yaw + dx * DEG_PER_PX
  yaw = ((((yaw + 180) % 360) + 360) % 360) - 180
  return { ...o, yaw, pitch }
}

export function orbitLook(o: Orbit, dx: number, dy: number): Orbit {
  if (o.ortho) return o
  const eye = orbitPosition(o)
  const turned = orbitRotate(o, dx, dy)
  const f = orbitForward(turned)
  return { ...turned, target: [0, 1, 2].map((i) => eye[i] + f[i] * o.distance) as Vec3 }
}

export function unitsPerPixel(distance: number, fov: number, heightPx: number): number {
  return (2 * distance * Math.tan(MathUtils.degToRad(fov) / 2)) / Math.max(1, heightPx)
}

export function orbitPan(o: Orbit, dx: number, dy: number, heightPx: number, widthPx = heightPx): Orbit {
  const rot = orbitRotation(o)
  const right = rotate(rot, [1, 0, 0])
  const up = rotate(rot, [0, 1, 0])
  const k = o.ortho ? (2 * o.ortho) / Math.max(1, heightPx) : o.orthographic ? (2 * orbitOrthoSize(o, widthPx / Math.max(1, heightPx))) / Math.max(1, heightPx) : unitsPerPixel(o.distance, sceneFov(o.fov, widthPx / Math.max(1, heightPx)), heightPx)
  const target = [0, 1, 2].map((i) => o.target[i] - right[i] * dx * k + up[i] * dy * k) as Vec3
  return { ...o, target }
}

export const WHEEL_UNITS_PER_PX = 3 / 40

function zoomFactor(deltaPx: number): number {
  return Math.max(0.0001, 1 + deltaPx * WHEEL_UNITS_PER_PX * 0.015)
}

export function orbitZoom(o: Orbit, deltaY: number, anchor?: Vec3): Orbit {
  if (o.ortho) {
    const ortho = clampOrtho(o.ortho * zoomFactor(deltaY))
    if (!anchor) return { ...o, ortho }
    const k = ortho / o.ortho
    const target: Vec3 = [anchor[0] + (o.target[0] - anchor[0]) * k, anchor[1] + (o.target[1] - anchor[1]) * k, o.target[2]]
    return { ...o, ortho, target }
  }
  const distance = Math.max(MIN_DISTANCE, Math.min(MAX_DISTANCE, o.distance * zoomFactor(deltaY)))
  return { ...o, distance }
}

export interface DollyDrag {
  start: number
  speed: number
  total: number
  ySign?: boolean
}

export function dollyStart(o: Orbit): DollyDrag {
  const size = o.ortho ?? orbitSize(o)
  return { start: size, speed: Math.max(size, 0.3), total: 0 }
}

export function orbitDolly(o: Orbit, d: DollyDrag, dx: number, dy: number, shift: boolean): Orbit {
  const mx = -dx
  const my = -dy
  const mag = Math.hypot(mx, my)
  if (mag === 0) return o
  if (Math.abs(Math.abs(mx) - Math.abs(my)) / Math.max(Math.abs(mx), Math.abs(my)) > 0.1) d.ySign = Math.abs(mx) <= Math.abs(my)
  const zoom = Math.sign(d.ySign === false ? mx : my) * mag * 0.25 * (shift ? 4 : 1) * (shift ? 9 : 3)
  if (o.ortho) return { ...o, ortho: clampOrtho(Math.max(0.0001, o.ortho * (1 + zoom * 0.001))) }
  d.total += zoom
  const size = d.total < 0 ? d.start * (1 + d.total * 0.001) : orbitSize(o) + zoom * d.speed * 0.003
  return { ...o, distance: Math.max(MIN_DISTANCE, Math.min(MAX_DISTANCE, sizeDistance(Math.max(1e-4, size), o.fov))) }
}

export function orbitZoomAt(o: Orbit, deltaY: number, ndcX: number, ndcY: number, aspect: number): Orbit {
  const next = orbitZoom(o, deltaY)
  if (o.ortho || next.distance === o.distance) return next
  const k = next.distance / o.distance
  const t = Math.tan(MathUtils.degToRad(sceneFov(o.fov, aspect)) / 2) * o.distance * (1 - k)
  const rot = orbitRotation(o)
  const right = rotate(rot, [1, 0, 0])
  const up = rotate(rot, [0, 1, 0])
  const ax = ndcX * t * aspect
  const ay = ndcY * t
  return { ...next, target: [0, 1, 2].map((i) => o.target[i] + right[i] * ax + up[i] * ay) as Vec3 }
}

export function orbitFly(o: Orbit, move: Vec3, step: number): Orbit {
  const rot = orbitRotation(o)
  const right = rotate(rot, [1, 0, 0])
  const up = rotate(rot, [0, 1, 0])
  const fwd = orbitForward(o)
  return { ...o, target: [0, 1, 2].map((i) => o.target[i] + (right[i] * move[0] + up[i] * move[1] + fwd[i] * move[2]) * step) as Vec3 }
}

const FLY_SPEED = 9
const FLY_MAX = 5000

export interface FlyOptions {
  speed: number
  shift: boolean
  acceleration: boolean
  accelerationSpeed: number
  easing: boolean
  easingDuration: number
  speedModifier: number
}

export interface FlyMotion {
  boost: number
  vel: Vec3
}

export const FLY_REST: FlyMotion = { boost: 0, vel: [0, 0, 0] }

export function flyStep(m: FlyMotion, move: Vec3, dt: number, f: FlyOptions): FlyMotion {
  const len = Math.hypot(move[0], move[1], move[2])
  const boost = len > 0 ? (f.acceleration ? Math.min(FLY_MAX, m.boost < 1e-6 ? FLY_SPEED : m.boost * Math.pow(f.accelerationSpeed + 1, dt)) : FLY_SPEED) : 0
  const k = len > 0 ? (boost * f.speed * (f.shift ? f.speedModifier : 1)) / len : 0
  const a = f.easing ? Math.min(1, dt / f.easingDuration) : 1
  return { boost, vel: [0, 1, 2].map((i) => m.vel[i] + (move[i] * k - m.vel[i]) * a) as Vec3 }
}

export function frameBounds(o: Orbit, bounds: TunerBounds, aspect: number, pad = 1): Orbit {
  if (o.ortho) {
    const hx = Math.abs(bounds.size[0]) / 2
    const hy = Math.abs(bounds.size[1]) / 2
    return { ...o, target: [...bounds.center] as Vec3, ortho: clampOrtho(Math.max(hy, hx / Math.max(0.1, aspect), 0.05) * 1.1 * pad) }
  }
  const half = bounds.size.map((s) => Math.abs(s) / 2)
  const extent = Math.hypot(half[0], half[1], half[2])
  const radius = extent < 1e-6 ? DEFAULT_VIEW_SIZE : extent
  const distance = Math.max(MIN_DISTANCE, Math.min(MAX_DISTANCE, sizeDistance(radius, o.fov) * pad))
  return { ...o, target: [...bounds.center] as Vec3, distance }
}

export interface Ray {
  origin: Vec3
  dir: Vec3
}

export function screenRay(cam: Cam, ndcX: number, ndcY: number, aspect: number): Ray {
  if (cam.ortho) {
    const right = rotate(cam.rotation, [1, 0, 0])
    const up = rotate(cam.rotation, [0, 1, 0])
    const fwd = rotate(cam.rotation, [0, 0, 1])
    const x = ndcX * cam.ortho * aspect
    const y = ndcY * cam.ortho
    return {
      origin: [0, 1, 2].map((i) => cam.position[i] + right[i] * x + up[i] * y - fwd[i] * PLANAR_RAY_BACK) as Vec3,
      dir: fwd
    }
  }
  const t = Math.tan(MathUtils.degToRad(cam.fov) / 2)
  const local: Vec3 = [ndcX * t * aspect, ndcY * t, 1]
  const d = rotate(cam.rotation, local)
  const m = Math.hypot(...d)
  return { origin: [...cam.position] as Vec3, dir: [d[0] / m, d[1] / m, d[2] / m] }
}

export function projectPoint(cam: Cam, p: Vec3, aspect: number): [number, number, number] | null {
  const inv: Quat = [-cam.rotation[0], -cam.rotation[1], -cam.rotation[2], cam.rotation[3]]
  const local = rotate(inv, [p[0] - cam.position[0], p[1] - cam.position[1], p[2] - cam.position[2]])
  if (cam.ortho) return [local[0] / (cam.ortho * aspect), local[1] / cam.ortho, local[2]]
  if (local[2] <= 1e-6) return null
  const t = Math.tan(MathUtils.degToRad(cam.fov) / 2)
  return [local[0] / (local[2] * t * aspect), local[1] / (local[2] * t), local[2]]
}

export const FOCUS_DISTANCE = 3
export const FOCUS_MIN_DISTANCE = 1.5
export const FOCUS_MAX_DISTANCE = 12
export const FOCUS_MS = 320

export function focusDistance(position: Vec3, others: (TunerBounds | null)[]): number {
  let best: TunerBounds | null = null
  let bestD = Infinity
  for (const b of others) {
    if (!b) continue
    const d = Math.hypot(b.center[0] - position[0], b.center[1] - position[1], b.center[2] - position[2])
    if (d < bestD) {
      bestD = d
      best = b
    }
  }
  if (!best) return FOCUS_DISTANCE
  const radius = Math.hypot(best.size[0], best.size[1], best.size[2]) / 2
  return Math.max(FOCUS_MIN_DISTANCE, Math.min(FOCUS_MAX_DISTANCE, radius * 2.5))
}

export const CAMERA_FRAME_SIZE = 14
export const EMPTY_FRAME_SIZE = 10

interface Framable {
  bounds: TunerBounds | null
  position: Vec3
  components: { type: string }[]
}

function isCamera(o: Framable): boolean {
  return o.components.some((c) => c.type === 'Camera' || c.type === 'UnityEngine.Camera')
}

export function cameraFrameBounds(o: Framable): TunerBounds | null {
  if (o.bounds || !isCamera(o)) return o.bounds
  return { center: [...o.position] as Vec3, size: [CAMERA_FRAME_SIZE, CAMERA_FRAME_SIZE, CAMERA_FRAME_SIZE] }
}

export function focusObjectOrbit(o: Orbit, obj: Framable, others: (TunerBounds | null)[], aspect: number): Orbit {
  if (o.ortho && !obj.bounds) {
    const size = isCamera(obj) ? Math.hypot(CAMERA_FRAME_SIZE, CAMERA_FRAME_SIZE, CAMERA_FRAME_SIZE) / 2 : EMPTY_FRAME_SIZE
    return { ...o, target: [...obj.position] as Vec3, ortho: clampOrtho(size / Math.min(1, Math.max(0.1, aspect))) }
  }
  return focusOrbit(o, cameraFrameBounds(obj), obj.position, others, aspect)
}

function focusOrbit(o: Orbit, bounds: TunerBounds | null, position: Vec3, others: (TunerBounds | null)[], aspect: number): Orbit {
  if (bounds) return frameBounds(o, bounds, aspect)
  if (o.ortho) return { ...o, target: [...position] as Vec3, ortho: clampOrtho(focusDistance(position, others) * Math.tan(MathUtils.degToRad(o.fov) / 2)) }
  return { ...o, target: [...position] as Vec3, distance: focusDistance(position, others) }
}

export function easeOutCubic(t: number): number {
  const k = Math.max(0, Math.min(1, t))
  return 1 - (1 - k) ** 3
}

export function easeInOutCubic(t: number): number {
  const k = Math.max(0, Math.min(1, t))
  return k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2
}

export function lerpOrbit(a: Orbit, b: Orbit, t: number): Orbit {
  const k = Math.max(0, Math.min(1, t))
  let dyaw = b.yaw - a.yaw
  dyaw = ((((dyaw + 180) % 360) + 360) % 360) - 180
  const out: Orbit = {
    target: [0, 1, 2].map((i) => a.target[i] + (b.target[i] - a.target[i]) * k) as Vec3,
    yaw: a.yaw + dyaw * k,
    pitch: a.pitch + (b.pitch - a.pitch) * k,
    distance: Math.exp(Math.log(a.distance) + (Math.log(b.distance) - Math.log(a.distance)) * k),
    fov: a.fov + (b.fov - a.fov) * k
  }
  if (b.ortho) out.ortho = a.ortho ? Math.exp(Math.log(a.ortho) + (Math.log(b.ortho) - Math.log(a.ortho)) * k) : b.ortho
  if (b.orthographic) out.orthographic = true
  return out
}

export const POINT_LEVELS = 2
export const OBJECT_CLOSER = 0.5

export function orbitScale(o: Orbit, factor: number, anchor?: Vec3): Orbit {
  if (o.ortho) {
    const ortho = clampOrtho(o.ortho * factor)
    if (!anchor) return { ...o, ortho }
    const k = ortho / o.ortho
    const target: Vec3 = [anchor[0] + (o.target[0] - anchor[0]) * k, anchor[1] + (o.target[1] - anchor[1]) * k, o.target[2]]
    return { ...o, ortho, target }
  }
  return { ...o, distance: Math.max(MIN_DISTANCE, Math.min(MAX_DISTANCE, o.distance * factor)) }
}

export function framePoint(o: Orbit, center: Vec3, span: number, aspect: number): Orbit {
  const s = Math.max(1e-3, span)
  if (o.ortho) return { ...o, target: [...center] as Vec3, ortho: clampOrtho((s / 2) * Math.max(1, 1 / Math.max(0.1, aspect))) }
  const vfov = MathUtils.degToRad(o.fov)
  const narrow = Math.min(Math.tan(vfov / 2), Math.tan(vfov / 2) * Math.max(0.1, aspect))
  const distance = Math.max(MIN_DISTANCE, Math.min(MAX_DISTANCE, s / (2 * narrow)))
  return { ...o, target: [...center] as Vec3, distance }
}

function closerOrbit(o: Orbit, k = OBJECT_CLOSER): Orbit {
  return orbitScale(o, k)
}

export function sameOrbit(a: Orbit | null, b: Orbit | null): boolean {
  if (!a || !b) return false
  const near = (x: number, y: number, eps: number): boolean => Math.abs(x - y) <= eps * Math.max(1, Math.abs(x), Math.abs(y))
  return (
    near(a.target[0], b.target[0], 1e-6) &&
    near(a.target[1], b.target[1], 1e-6) &&
    near(a.target[2], b.target[2], 1e-6) &&
    near(a.distance, b.distance, 1e-6) &&
    near(a.yaw, b.yaw, 1e-6) &&
    near(a.pitch, b.pitch, 1e-6) &&
    near(a.ortho ?? 0, b.ortho ?? 0, 1e-6)
  )
}

export interface FrameMemo {
  key: string
  level: number
  orbit: Orbit
}

export function nextFrameLevel(memo: FrameMemo | null, key: string, now: Orbit | null, animating: boolean): number {
  if (!memo || memo.key !== key) return 1
  if (!animating && !sameOrbit(now, memo.orbit)) return 1
  return (memo.level % POINT_LEVELS) + 1
}

export const FOCUS_AGAIN_SIZE = Math.hypot(0.5, 0.5, 0.5)

export function frameLevel(level1: Orbit, level: number, k?: number): Orbit {
  if (level < 2) return level1
  if (k !== undefined) return closerOrbit(level1, k)
  if (level1.ortho) return { ...level1, ortho: clampOrtho(FOCUS_AGAIN_SIZE) }
  return { ...level1, distance: Math.max(MIN_DISTANCE, sizeDistance(FOCUS_AGAIN_SIZE, level1.fov)) }
}

export const SHOT_PAD = 1.5
export const SHOT_SMALL_PAD = 2.2
export const SHOT_SMALL_RADIUS = 0.5
export const SHOT_BIG_RADIUS = 12
const SHOT_MAX_DISTANCE = 120
export const SHOT_PITCH = 24
export const SHOT_BIG_PITCH = 35

interface Shootable {
  bounds: TunerBounds
  rotation: Quat
}

function wrapYaw(y: number): number {
  return ((((y + 180) % 360) + 360) % 360) - 180
}

function yawOfLook(d: number[]): number | null {
  return Math.hypot(d[0], d[2]) < 1e-3 ? null : (Math.atan2(d[0], d[2]) * 180) / Math.PI
}

export function shotYaw(base: Orbit, obj: Shootable, sun: Vec3 | null): number {
  const half = obj.bounds.size.map((s) => Math.abs(s) / 2)
  const radius = Math.hypot(half[0], half[1], half[2])
  const cands: number[] = []
  if (radius <= SHOT_BIG_RADIUS) {
    const f = rotate(obj.rotation, [0, 0, 1])
    const r = rotate(obj.rotation, [1, 0, 0])
    for (const side of [1, -1]) {
      const y = yawOfLook([-(f[0] * 0.82 + side * r[0] * 0.57), 0, -(f[2] * 0.82 + side * r[2] * 0.57)])
      if (y !== null) cands.push(y)
    }
  }
  if (!cands.length) {
    cands.push(base.yaw)
    if (sun && Math.hypot(sun[0], sun[2]) > 0.05) {
      cands.push(wrapYaw(base.yaw + 40), wrapYaw(base.yaw - 40))
    }
  }
  const sunYaw = sun ? yawOfLook(sun) : null
  let best = cands[0]
  let score = -Infinity
  for (const y of cands) {
    const turn = Math.cos(MathUtils.degToRad(wrapYaw(y - base.yaw)))
    const lit = sunYaw === null ? 0 : Math.cos(MathUtils.degToRad(wrapYaw(y - sunYaw)))
    const s = lit + 0.35 * turn
    if (s > score) {
      score = s
      best = y
    }
  }
  return best
}

function boxDistance(o: Orbit, b: TunerBounds, aspect: number, limit: number): number {
  const corners: Vec3[] = []
  for (let i = 0; i < 8; i++) corners.push([0, 1, 2].map((k) => b.center[k] + ((i >> k) & 1 ? 0.5 : -0.5) * Math.abs(b.size[k])) as Vec3)
  const w = 1000 * Math.max(0.05, aspect)
  const fits = (d: number): boolean => {
    const cam = orbitCamera({ ...o, distance: d }, w, 1000)
    for (const c of corners) {
      const n = projectPoint(cam, c, aspect)
      if (!n || Math.abs(n[0]) > limit || Math.abs(n[1]) > limit) return false
    }
    return true
  }
  let lo = MIN_DISTANCE
  let hi = MAX_DISTANCE
  if (fits(lo)) return lo
  if (!fits(hi)) return hi
  for (let i = 0; i < 40; i++) {
    const mid = Math.sqrt(lo * hi)
    if (fits(mid)) hi = mid
    else lo = mid
  }
  return hi
}

export function shotOrbit(base: Orbit, obj: Shootable, aspect: number, scene: TunerBounds | null): Orbit {
  const b = obj.bounds
  const half = b.size.map((s) => Math.abs(s) / 2)
  const radius = Math.max(0.05, Math.hypot(half[0], half[1], half[2]))
  const yaw = shotYaw(base, obj, scene?.sun ?? null)
  const pitch = radius > SHOT_BIG_RADIUS ? SHOT_BIG_PITCH : SHOT_PITCH
  const pad = radius < SHOT_SMALL_RADIUS ? SHOT_SMALL_PAD : SHOT_PAD
  const fit = boxDistance({ ...base, target: [...b.center] as Vec3, yaw, pitch }, b, aspect, 1 / pad)
  const cap = Math.min(SHOT_MAX_DISTANCE, scene?.fogClear && scene.fogClear > 0 ? scene.fogClear : Infinity)
  if (fit <= cap) return { ...base, target: [...b.center] as Vec3, yaw, pitch, distance: Math.max(MIN_DISTANCE, fit) }
  const lo = b.center.map((c, i) => c - half[i])
  const hi = b.center.map((c, i) => c + half[i])
  const near = base.target.map((v, i) => Math.max(lo[i], Math.min(hi[i], v))) as Vec3
  return { ...base, target: near, yaw, pitch, distance: Math.max(MIN_DISTANCE, cap * 0.85) }
}
