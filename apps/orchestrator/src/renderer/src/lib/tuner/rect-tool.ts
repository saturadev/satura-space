import { Quaternion, Vector3 } from 'three'
import type { Quat, Vec3 } from '@shared/tuner'
import type { Rect4, TunerRectFrame, TunerRectInfo, TunerRectValues, V2 } from '@shared/tuner-rect'
import type { Ray } from './orbit'
import { qarr, quat, rotate } from './space'

export type Side = 0 | 1 | 2

export type RectHandle =
  | { kind: 'move' }
  | { kind: 'resize'; x: Side; y: Side }
  | { kind: 'pivot' }
  | { kind: 'anchor'; x: Side; y: Side }
  | { kind: 'rotate'; x: 0 | 2; y: 0 | 2 }

export interface RectMods {
  shift: boolean
  alt: boolean
  action: boolean
}

export const ROTATE_STEP = 15
const EPS = 1e-9

export function add3(a: Vec3, b: Vec3, k = 1): Vec3 {
  return [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k]
}

export function sub3(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

export function dot3(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

export function cross3(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

export function norm3(a: Vec3): Vec3 {
  const l = Math.hypot(a[0], a[1], a[2])
  return l < EPS ? [0, 0, 0] : [a[0] / l, a[1] / l, a[2] / l]
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

export function rectValues(info: TunerRectValues): TunerRectValues {
  return {
    anchorMin: [...info.anchorMin],
    anchorMax: [...info.anchorMax],
    anchoredPosition: [...info.anchoredPosition],
    sizeDelta: [...info.sizeDelta],
    pivot: [...info.pivot],
    localRotation: [...info.localRotation],
    localPositionZ: info.localPositionZ
  }
}

export function parentSize(info: Pick<TunerRectInfo, 'parent'>): V2 {
  return info.parent ? [info.parent.rect[2], info.parent.rect[3]] : [0, 0]
}

function rectOfValues(v: TunerRectValues, psize: V2): Rect4 {
  const w = psize[0] * (v.anchorMax[0] - v.anchorMin[0]) + v.sizeDelta[0]
  const h = psize[1] * (v.anchorMax[1] - v.anchorMin[1]) + v.sizeDelta[1]
  return [-v.pivot[0] * w, -v.pivot[1] * h, w, h]
}

export function offsets(v: TunerRectValues): { min: V2; max: V2 } {
  return {
    min: [v.anchoredPosition[0] - v.sizeDelta[0] * v.pivot[0], v.anchoredPosition[1] - v.sizeDelta[1] * v.pivot[1]],
    max: [v.anchoredPosition[0] + v.sizeDelta[0] * (1 - v.pivot[0]), v.anchoredPosition[1] + v.sizeDelta[1] * (1 - v.pivot[1])]
  }
}

export function anchorPoint(parentRect: Rect4, a: V2): V2 {
  return [parentRect[0] + parentRect[2] * a[0], parentRect[1] + parentRect[3] * a[1]]
}

function parentLocalPosition(v: TunerRectValues, parentRect: Rect4): Vec3 {
  const ref = anchorPoint(parentRect, [lerp(v.anchorMin[0], v.anchorMax[0], v.pivot[0]), lerp(v.anchorMin[1], v.anchorMax[1], v.pivot[1])])
  return [ref[0] + v.anchoredPosition[0], ref[1] + v.anchoredPosition[1], v.localPositionZ]
}

export function toWorld(f: TunerRectFrame, x: number, y: number, z = 0): Vec3 {
  return add3(add3(add3(f.origin, f.ux, x), f.uy, y), f.uz, z)
}

export function frameVector(f: TunerRectFrame, v: Vec3): Vec3 {
  return add3(add3([f.ux[0] * v[0], f.ux[1] * v[0], f.ux[2] * v[0]], f.uy, v[1]), f.uz, v[2])
}

export function localVector(info: Pick<TunerRectInfo, 'localRotation' | 'localScale'>, x: number, y: number): Vec3 {
  return rotate(info.localRotation, [x * info.localScale[0], y * info.localScale[1], 0])
}

function frameOfValues(info: TunerRectInfo, v: TunerRectValues): TunerRectFrame {
  const p = info.parent
  if (!p) return info.frame
  const lp = parentLocalPosition(v, p.rect)
  const s = info.localScale
  return {
    origin: toWorld(p, lp[0], lp[1], lp[2]),
    ux: frameVector(p, rotate(v.localRotation, [s[0], 0, 0])),
    uy: frameVector(p, rotate(v.localRotation, [0, s[1], 0])),
    uz: frameVector(p, rotate(v.localRotation, [0, 0, s[2]]))
  }
}

export function withValues(info: TunerRectInfo, v: TunerRectValues): TunerRectInfo {
  return { ...info, ...v, rect: rectOfValues(v, parentSize(info)), frame: frameOfValues(info, v) }
}

export function planeLocal(f: Pick<TunerRectFrame, 'origin' | 'ux' | 'uy'>, ray: Ray): V2 | null {
  const n = cross3(f.ux, f.uy)
  const denom = dot3(n, ray.dir)
  if (Math.abs(denom) < EPS * Math.max(1, dot3(n, n))) return null
  const t = dot3(sub3(f.origin, ray.origin), n) / denom
  const hit = add3(ray.origin, ray.dir, t)
  return solveLocal(f, sub3(hit, f.origin))
}

export function solveLocal(f: Pick<TunerRectFrame, 'ux' | 'uy'>, d: Vec3): V2 | null {
  const uu = dot3(f.ux, f.ux)
  const uv = dot3(f.ux, f.uy)
  const vv = dot3(f.uy, f.uy)
  const det = uu * vv - uv * uv
  if (Math.abs(det) < EPS) return null
  const du = dot3(d, f.ux)
  const dv = dot3(d, f.uy)
  return [(du * vv - dv * uv) / det, (dv * uu - du * uv) / det]
}

export function handlePoint(r: Rect4, x: Side, y: Side): V2 {
  return [r[0] + (r[2] * x) / 2, r[1] + (r[3] * y) / 2]
}

function shiftPosition(start: TunerRectInfo, out: TunerRectValues, local: V2): void {
  const pv = localVector(start, local[0], local[1])
  out.anchoredPosition = [start.anchoredPosition[0] + pv[0], start.anchoredPosition[1] + pv[1]]
  out.localPositionZ = start.localPositionZ + pv[2]
}

export function moveValues(start: TunerRectInfo, m0: V2, m1: V2, lockAxis: -1 | 0 | 1 = -1): TunerRectValues {
  const out = rectValues(start)
  const d: V2 = [m1[0] - m0[0], m1[1] - m0[1]]
  if (lockAxis >= 0) d[1 - lockAxis] = 0
  shiftPosition(start, out, d)
  return out
}

export function moveLockAxis(m0: V2, m1: V2, scale: V2 = [1, 1]): 0 | 1 {
  return Math.abs((m1[0] - m0[0]) * scale[0]) >= Math.abs((m1[1] - m0[1]) * scale[1]) ? 0 : 1
}

export interface ResizeFactors {
  sx: number
  sy: number
  sp: V2
}

export function resizeValues(start: TunerRectInfo, h: { x: Side; y: Side }, m0: V2, m1: V2, mods: Pick<RectMods, 'shift' | 'alt'>): TunerRectValues {
  const out = rectValues(start)
  const r = start.rect
  const { sx, sy, sp } = resizeFactors(r, h, m0, m1, mods)
  out.sizeDelta = [start.sizeDelta[0] + r[2] * (sx - 1), start.sizeDelta[1] + r[3] * (sy - 1)]
  shiftPosition(start, out, [sp[0] * (1 - sx), sp[1] * (1 - sy)])
  return out
}

export function resizeFactors(r: Rect4, h: { x: Side; y: Side }, m0: V2, m1: V2, mods: Pick<RectMods, 'shift' | 'alt'>): ResizeFactors {
  const op = handlePoint(r, h.x, h.y)
  let np: V2 = [op[0] + (h.x !== 1 ? m1[0] - m0[0] : 0), op[1] + (h.y !== 1 ? m1[1] - m0[1] : 0)]
  const sp: V2 = mods.alt ? [0, 0] : handlePoint(r, (2 - h.x) as Side, (2 - h.y) as Side)
  const dir: V2 = [op[0] - sp[0], op[1] - sp[1]]
  if (mods.shift) {
    const dd = dir[0] * dir[0] + dir[1] * dir[1]
    if (dd > EPS) {
      const t = ((np[0] - sp[0]) * dir[0] + (np[1] - sp[1]) * dir[1]) / dd
      np = [sp[0] + dir[0] * t, sp[1] + dir[1] * t]
    }
  }
  let sx = 1
  let sy = 1
  if (h.x !== 1 && Math.abs(dir[0]) > EPS) sx = (np[0] - sp[0]) / dir[0]
  if (h.y !== 1 && Math.abs(dir[1]) > EPS) sy = (np[1] - sp[1]) / dir[1]
  if (mods.shift) {
    const ref = h.x === 1 ? sy : sx
    sx = ref
    sy = ref
  }
  return { sx, sy, sp }
}

export const PIVOT_SNAPS = [0, 0.5, 1]

export function snapPivot(v: number, threshold: number): number {
  for (const s of PIVOT_SNAPS) if (Math.abs(v - s) <= threshold) return s
  return v
}

export function pivotValues(start: TunerRectInfo, m0: V2, m1: V2, snap: V2 = [0, 0]): TunerRectValues {
  const out = rectValues(start)
  const r = start.rect
  const want: V2 = [
    start.pivot[0] + (Math.abs(r[2]) > EPS ? (m1[0] - m0[0]) / r[2] : 0),
    start.pivot[1] + (Math.abs(r[3]) > EPS ? (m1[1] - m0[1]) / r[3] : 0)
  ]
  out.pivot = [snapPivot(want[0], snap[0]), snapPivot(want[1], snap[1])]
  const dp: V2 = [out.pivot[0] - start.pivot[0], out.pivot[1] - start.pivot[1]]
  const ps = parentSize(start)
  const own = localVector(start, -dp[0] * r[2], -dp[1] * r[3])
  const shift: Vec3 = [ps[0] * (start.anchorMax[0] - start.anchorMin[0]) * dp[0] + own[0], ps[1] * (start.anchorMax[1] - start.anchorMin[1]) * dp[1] + own[1], own[2]]
  out.anchoredPosition = [start.anchoredPosition[0] - shift[0], start.anchoredPosition[1] - shift[1]]
  out.localPositionZ = start.localPositionZ - shift[2]
  return out
}

function roundPermille(v: number): number {
  const k = v * 1000
  return Math.abs(Math.round(k) - k) < 0.1 ? Math.round(k) / 1000 : v
}

function setAnchorSmart(
  w: TunerRectValues,
  start: TunerRectInfo,
  value: number,
  axis: 0 | 1,
  isMax: boolean,
  smart: boolean,
  together: boolean
): void {
  const ps = parentSize(start)[axis]
  let offsetSize = 0
  let offsetPos = 0
  if (smart && ps > EPS) {
    value = roundPermille(value)
    const old = isMax ? w.anchorMax[axis] : w.anchorMin[axis]
    offsetSize = (value - old) * ps
    offsetPos = together ? offsetSize : isMax ? offsetSize * w.pivot[axis] : offsetSize * (1 - w.pivot[axis])
  }
  if (isMax) {
    w.anchorMax[axis] = value
    if (together) w.anchorMin[axis] = start.anchorMin[axis] + value - start.anchorMax[axis]
  } else {
    w.anchorMin[axis] = value
    if (together) w.anchorMax[axis] = start.anchorMax[axis] + value - start.anchorMin[axis]
  }
  if (smart) {
    w.anchoredPosition[axis] -= offsetPos
    if (!together) w.sizeDelta[axis] += offsetSize * (isMax ? -1 : 1)
  }
}

export function anchorValues(start: TunerRectInfo, h: { x: Side; y: Side }, p0: V2, p1: V2, mods: Pick<RectMods, 'shift' | 'action'>): TunerRectValues {
  const w = rectValues(start)
  const ps = parentSize(start)
  for (const axis of [0, 1] as const) {
    if (ps[axis] <= EPS) continue
    const mm = axis === 0 ? h.x : h.y
    const offset = (p1[axis] - p0[axis]) / ps[axis]
    const isMax = mm === 1
    const old = isMax ? start.anchorMax[axis] : start.anchorMin[axis]
    let value = old + offset
    const startValue = mm === 1 ? start.anchorMax[axis] : start.anchorMin[axis]
    const outside = startValue < -0.001 || startValue > 1.001
    if (!mods.action && !outside) value = Math.max(0, Math.min(1, value))
    if (mm === 0) value = Math.min(value, w.anchorMax[axis])
    if (mm === 1) value = Math.max(value, w.anchorMin[axis])
    if (mm === 2) {
      setAnchorSmart(w, start, value, axis, false, !mods.shift, mods.action)
      setAnchorSmart(w, start, value, axis, true, !mods.shift, mods.action)
    } else setAnchorSmart(w, start, value, axis, isMax, !mods.shift, mods.action)
  }
  return w
}

export function planeAngle(f: Pick<TunerRectFrame, 'ux' | 'uy'>, a: Vec3, b: Vec3): number {
  const n = norm3(cross3(f.ux, f.uy))
  const e1 = norm3(f.ux)
  const e2 = cross3(n, e1)
  const ax = dot3(a, e1)
  const ay = dot3(a, e2)
  const bx = dot3(b, e1)
  const by = dot3(b, e2)
  return (Math.atan2(ax * by - ay * bx, ax * bx + ay * by) * 180) / Math.PI
}

export function rotateValues(start: TunerRectInfo, degrees: number, snap: boolean): TunerRectValues {
  const out = rectValues(start)
  const deg = snap ? Math.round(degrees / ROTATE_STEP) * ROTATE_STEP : degrees
  const spin = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), (deg * Math.PI) / 180)
  out.localRotation = qarr(quat(start.localRotation).multiply(spin))
  return out
}

export function zAngle(q: Quat): number {
  const [x, y, z, w] = q
  return (Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z)) * 180) / Math.PI
}

export function anchorCornersParent(info: TunerRectInfo): { x: 0 | 1; y: 0 | 1; p: V2 }[] {
  if (!info.parent) return []
  const out: { x: 0 | 1; y: 0 | 1; p: V2 }[] = []
  for (const y of [0, 1] as const)
    for (const x of [0, 1] as const)
      out.push({ x, y, p: anchorPoint(info.parent.rect, [x ? info.anchorMax[0] : info.anchorMin[0], y ? info.anchorMax[1] : info.anchorMin[1]]) })
  return out
}

export function fusedState(info: Pick<TunerRectValues, 'anchorMin' | 'anchorMax'>): 'all' | 'horizontal' | 'vertical' | 'none' {
  const fx = info.anchorMin[0] === info.anchorMax[0]
  const fy = info.anchorMin[1] === info.anchorMax[1]
  return fx && fy ? 'all' : fx ? 'horizontal' : fy ? 'vertical' : 'none'
}

export interface RectLabel {
  a: V2
  b: V2
  text: string
}

function fmt(v: number): string {
  const r = Math.round(v * 100) / 100
  return `${Object.is(r, -0) ? 0 : r}`
}

export function distanceLabels(info: TunerRectInfo): RectLabel[] {
  const p = info.parent
  if (!p) return []
  const pr = p.rect
  const lp = parentLocalPosition(info, pr)
  const rp: Rect4 = [info.rect[0] + lp[0], info.rect[1] + lp[1], info.rect[2], info.rect[3]]
  const off = offsets(info)
  const out: RectLabel[] = []
  for (const axis of [0, 1] as const) {
    const stretched = info.anchorMin[axis] !== info.anchorMax[axis]
    const lo = pr[axis] + pr[axis + 2] * info.anchorMin[axis]
    const hi = pr[axis] + pr[axis + 2] * info.anchorMax[axis]
    if (!stretched) {
      const pivot: V2 = [rp[0] + rp[2] * info.pivot[0], rp[1] + rp[3] * info.pivot[1]]
      const a: V2 = [...pivot]
      a[axis] = lo
      out.push({ a, b: pivot, text: fmt(info.anchoredPosition[axis]) })
      continue
    }
    const c: V2 = [rp[0] + rp[2] / 2, rp[1] + rp[3] / 2]
    const a0: V2 = [...c]
    const b0: V2 = [...c]
    a0[axis] = lo
    b0[axis] = rp[axis]
    out.push({ a: a0, b: b0, text: fmt(off.min[axis]) })
    const a1: V2 = [...c]
    const b1: V2 = [...c]
    a1[axis] = hi
    b1[axis] = rp[axis] + rp[axis + 2]
    out.push({ a: a1, b: b1, text: fmt(-off.max[axis]) })
  }
  return out.filter((l) => l.a[0] !== l.b[0] || l.a[1] !== l.b[1])
}

export function anchorPercentLabels(info: TunerRectInfo): RectLabel[] {
  const p = info.parent
  if (!p) return []
  const pr = p.rect
  const out: RectLabel[] = []
  for (const axis of [0, 1] as const) {
    const other = (1 - axis) as 0 | 1
    const at = pr[axis] + pr[axis + 2] * info.anchorMin[axis]
    const ticks = [0, info.anchorMin[other], info.anchorMax[other], 1]
    const values = [
      Math.round(info.anchorMin[other] * 100),
      Math.round((info.anchorMax[other] - info.anchorMin[other]) * 100),
      Math.round((1 - info.anchorMax[other]) * 100)
    ]
    for (let i = 0; i < 3; i++) {
      if (values[i] <= 0) continue
      const a: V2 = [0, 0]
      const b: V2 = [0, 0]
      a[axis] = at
      b[axis] = at
      a[other] = pr[other] + pr[other + 2] * ticks[i]
      b[other] = pr[other] + pr[other + 2] * ticks[i + 1]
      out.push({ a, b, text: `${values[i]}%` })
    }
  }
  return out
}

export function anchorLines(info: TunerRectInfo): [V2, V2][] {
  const p = info.parent
  if (!p) return []
  const pr = p.rect
  const lines: [V2, V2][] = []
  for (const axis of [0, 1] as const) {
    const other = (1 - axis) as 0 | 1
    const from = pr[other] + pr[other + 2] * Math.min(0, info.anchorMin[other])
    const to = pr[other] + pr[other + 2] * Math.max(1, info.anchorMax[other])
    const values = info.anchorMin[axis] === info.anchorMax[axis] ? [info.anchorMin[axis]] : [info.anchorMin[axis], info.anchorMax[axis]]
    for (const v of values) {
      const at = pr[axis] + pr[axis + 2] * v
      const a: V2 = [0, 0]
      const b: V2 = [0, 0]
      a[axis] = at
      b[axis] = at
      a[other] = from
      b[other] = to
      lines.push([a, b])
    }
  }
  return lines
}

export function changedValues(start: TunerRectValues, next: TunerRectValues): Partial<TunerRectValues> {
  const out: Partial<TunerRectValues> = {}
  const near = (x: number[], y: number[]): boolean => x.every((v, i) => Math.abs(v - y[i]) <= 1e-7)
  if (!near(start.anchorMin, next.anchorMin)) out.anchorMin = next.anchorMin
  if (!near(start.anchorMax, next.anchorMax)) out.anchorMax = next.anchorMax
  if (!near(start.anchoredPosition, next.anchoredPosition)) out.anchoredPosition = next.anchoredPosition
  if (!near(start.sizeDelta, next.sizeDelta)) out.sizeDelta = next.sizeDelta
  if (!near(start.pivot, next.pivot)) out.pivot = next.pivot
  if (!near(start.localRotation, next.localRotation)) out.localRotation = next.localRotation
  if (Math.abs(start.localPositionZ - next.localPositionZ) > 1e-7) out.localPositionZ = next.localPositionZ
  return out
}
