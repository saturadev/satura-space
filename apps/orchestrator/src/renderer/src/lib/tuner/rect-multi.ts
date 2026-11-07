import { Matrix4, Quaternion, Vector3 } from 'three'
import type { Quat, Vec3 } from '@shared/tuner'
import type { Rect4, TunerRectInfo, TunerRectItem, TunerRectValues } from '@shared/tuner-rect'
import { add3, changedValues, cross3, dot3, norm3, rectValues, sub3, toWorld, type ResizeFactors } from './rect-tool'
import { qarr, quat, rotate } from './space'

export const MULTI_ID = 'multi'

const EPS = 1e-9
const IDENTITY: Quat = [0, 0, 0, 1]

function invert(q: Quat): Quat {
  return qarr(quat(q).invert())
}

function rectCorners(info: TunerRectInfo): Vec3[] {
  const r = info.rect
  return [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1]
  ].map(([u, v]) => toWorld(info.frame, r[0] + r[2] * u, r[1] + r[3] * v))
}

export function basisRotation(ux: Vec3, uy: Vec3): Quat {
  const x = norm3(ux)
  if (dot3(x, x) < EPS) return IDENTITY
  let z = norm3(cross3(x, uy))
  if (dot3(z, z) < EPS) z = norm3(cross3(x, Math.abs(x[2]) < 0.9 ? [0, 0, 1] : [0, 1, 0]))
  const y = cross3(z, x)
  const m = new Matrix4().makeBasis(new Vector3(...x), new Vector3(...y), new Vector3(...z))
  return qarr(new Quaternion().setFromRotationMatrix(m))
}

export function frameInfo(origin: Vec3, rotation: Quat, rect: Rect4): TunerRectInfo {
  const w = rect[2]
  const h = rect[3]
  return {
    id: MULTI_ID,
    anchorMin: [0, 0],
    anchorMax: [0, 0],
    anchoredPosition: [0, 0],
    sizeDelta: [w, h],
    pivot: [Math.abs(w) > EPS ? -rect[0] / w : 0.5, Math.abs(h) > EPS ? -rect[1] / h : 0.5],
    localRotation: rotation,
    localPositionZ: 0,
    rect,
    localScale: [1, 1, 1],
    frame: { origin, ux: rotate(rotation, [1, 0, 0]), uy: rotate(rotation, [0, 1, 0]), uz: rotate(rotation, [0, 0, 1]) },
    parent: null,
    renderer: true
  }
}

export function multiFrameOf(infos: TunerRectInfo[], pivot: Vec3 | null, rotation: Quat): TunerRectInfo | null {
  const pts = infos.flatMap(rectCorners)
  if (pts.length === 0) return null
  let origin = pivot
  if (!origin) {
    const lo: Vec3 = [Infinity, Infinity, Infinity]
    const hi: Vec3 = [-Infinity, -Infinity, -Infinity]
    for (const p of pts)
      for (let i = 0; i < 3; i++) {
        lo[i] = Math.min(lo[i], p[i])
        hi[i] = Math.max(hi[i], p[i])
      }
    origin = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2]
  }
  const back = invert(rotation)
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const p of pts) {
    const l = rotate(back, sub3(p, origin))
    x0 = Math.min(x0, l[0])
    y0 = Math.min(y0, l[1])
    x1 = Math.max(x1, l[0])
    y1 = Math.max(y1, l[1])
  }
  return frameInfo(origin, rotation, [x0, y0, x1 - x0, y1 - y0])
}

export function parentLocal(info: TunerRectInfo, w: Vec3): Vec3 {
  const p = info.parent
  if (!p) return w
  const bc = cross3(p.uy, p.uz)
  const det = dot3(p.ux, bc)
  if (Math.abs(det) < EPS) return w
  return [dot3(w, bc) / det, dot3(p.ux, cross3(w, p.uz)) / det, dot3(p.ux, cross3(p.uy, w)) / det]
}

function shiftWorld(info: TunerRectInfo, v: TunerRectValues, w: Vec3): void {
  const d = parentLocal(info, w)
  v.anchoredPosition = [v.anchoredPosition[0] + d[0], v.anchoredPosition[1] + d[1]]
  v.localPositionZ = v.localPositionZ + d[2]
}

export function multiMoveValues(starts: TunerRectInfo[], w: Vec3): TunerRectValues[] {
  return starts.map((info) => {
    const v = rectValues(info)
    shiftWorld(info, v, w)
    return v
  })
}

function axisFactor(a: Vec3, f: ResizeFactors): number {
  const x = Math.abs(a[0])
  const y = Math.abs(a[1])
  const z = Math.abs(a[2])
  if (z > x && z > y) return 1
  return x >= y ? f.sx : f.sy
}

export function scalePoint(frame: TunerRectInfo, f: ResizeFactors, p: Vec3): Vec3 {
  const rot = frame.localRotation
  const sp = toWorld(frame.frame, f.sp[0], f.sp[1])
  const l = rotate(invert(rot), sub3(p, sp))
  return add3(sp, rotate(rot, [l[0] * f.sx, l[1] * f.sy, l[2]]))
}

export function multiResizeValues(starts: TunerRectInfo[], frame: TunerRectInfo, f: ResizeFactors): TunerRectValues[] {
  const back = invert(frame.localRotation)
  return starts.map((info) => {
    const v = rectValues(info)
    const p = info.frame.origin
    const moved = scalePoint(frame, f, p)
    const kx = axisFactor(rotate(back, norm3(info.frame.ux)), f)
    const ky = axisFactor(rotate(back, norm3(info.frame.uy)), f)
    v.sizeDelta = info.renderer
      ? [info.sizeDelta[0] * kx, info.sizeDelta[1] * ky]
      : [info.sizeDelta[0] + info.rect[2] * (kx - 1), info.sizeDelta[1] + info.rect[3] * (ky - 1)]
    shiftWorld(info, v, sub3(moved, p))
    return v
  })
}

function spin(frame: TunerRectInfo, degrees: number): Quaternion {
  return new Quaternion().setFromAxisAngle(new Vector3(...norm3(frame.frame.uz)), (degrees * Math.PI) / 180)
}

export function multiRotateValues(starts: TunerRectInfo[], frame: TunerRectInfo, degrees: number): TunerRectValues[] {
  const d = spin(frame, degrees)
  const dq = qarr(d)
  const pivot = frame.frame.origin
  return starts.map((info) => {
    const v = rectValues(info)
    const p = info.frame.origin
    const moved = add3(pivot, rotate(dq, sub3(p, pivot)))
    const pr = info.parent ? quat(basisRotation(info.parent.ux, info.parent.uy)) : new Quaternion()
    const local = pr.clone().invert().multiply(d).multiply(pr)
    v.localRotation = qarr(local.multiply(quat(info.localRotation)))
    shiftWorld(info, v, sub3(moved, p))
    return v
  })
}

export function movedFrame(frame: TunerRectInfo, w: Vec3): TunerRectInfo {
  return frameInfo(add3(frame.frame.origin, w), frame.localRotation, [...frame.rect])
}

export function resizedFrame(frame: TunerRectInfo, f: ResizeFactors, origin: Vec3 | 'center' | null): TunerRectInfo {
  const r = frame.rect
  let x = f.sp[0] + (r[0] - f.sp[0]) * f.sx
  let y = f.sp[1] + (r[1] - f.sp[1]) * f.sy
  let w = r[2] * f.sx
  let h = r[3] * f.sy
  if (w < 0) {
    x += w
    w = -w
  }
  if (h < 0) {
    y += h
    h = -h
  }
  if (!origin) return frameInfo(frame.frame.origin, frame.localRotation, [x, y, w, h])
  const to = origin === 'center' ? toWorld(frame.frame, x + w / 2, y + h / 2) : origin
  const l = rotate(invert(frame.localRotation), sub3(to, frame.frame.origin))
  return frameInfo(to, frame.localRotation, [x - l[0], y - l[1], w, h])
}

export function rotatedFrame(frame: TunerRectInfo, degrees: number): TunerRectInfo {
  return frameInfo(frame.frame.origin, qarr(spin(frame, degrees).multiply(quat(frame.localRotation))), [...frame.rect])
}

export function rectItems(starts: TunerRectInfo[], next: TunerRectValues[], sent: Set<keyof TunerRectValues>): TunerRectItem[] {
  starts.forEach((s, i) => {
    for (const k of Object.keys(changedValues(s, next[i])) as (keyof TunerRectValues)[]) sent.add(k)
  })
  return starts.map((s, i) => {
    const item: TunerRectItem = { id: s.id }
    for (const k of sent) (item as Record<string, unknown>)[k] = next[i][k]
    return item
  })
}

export function mergeRectInfos(infos: TunerRectInfo[], fresh: TunerRectInfo[]): TunerRectInfo[] {
  const byId = new Map(fresh.map((f) => [f.id, f]))
  return infos.map((i) => byId.get(i.id) ?? i)
}
