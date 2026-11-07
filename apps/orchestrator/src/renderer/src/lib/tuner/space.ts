import { Quaternion, Vector3 } from 'three'
import type { Quat, TunerBounds, Vec3 } from '@shared/tuner'
import { normalizeQuat, threeToUnity, unityToThree } from './rotation-math'

export function vec(a: Vec3): Vector3 {
  return new Vector3(a[0], a[1], a[2])
}

export function arr(v: Vector3): Vec3 {
  return [v.x, v.y, v.z]
}

export function quat(q: Quat): Quaternion {
  return new Quaternion(q[0], q[1], q[2], q[3]).normalize()
}

export function qarr(q: Quaternion): Quat {
  return normalizeQuat([q.x, q.y, q.z, q.w])
}

export function rotate(q: Quat, v: Vec3): Vec3 {
  return arr(vec(v).applyQuaternion(quat(q)))
}

export function unityPosToThree(p: Vec3): Vector3 {
  return new Vector3(p[0], p[1], -p[2])
}

export function threePosToUnity(v: Vector3): Vec3 {
  return [v.x, v.y, -v.z]
}

export function unityRotToThree(q: Quat): Quaternion {
  return unityToThree(q)
}

export function threeRotToUnity(q: Quaternion): Quat {
  return threeToUnity(q)
}

export function unionBounds(list: (TunerBounds | null | undefined)[]): TunerBounds | null {
  let min: Vec3 | null = null
  let max: Vec3 | null = null
  for (const b of list) {
    if (!b) continue
    const lo: Vec3 = [0, 1, 2].map((i) => b.center[i] - Math.abs(b.size[i]) / 2) as Vec3
    const hi: Vec3 = [0, 1, 2].map((i) => b.center[i] + Math.abs(b.size[i]) / 2) as Vec3
    min = min ? (min.map((m, i) => Math.min(m, lo[i])) as Vec3) : lo
    max = max ? (max.map((m, i) => Math.max(m, hi[i])) as Vec3) : hi
  }
  if (!min || !max) return null
  const lo = min
  const hi = max
  return {
    center: [0, 1, 2].map((i) => (lo[i] + hi[i]) / 2) as Vec3,
    size: [0, 1, 2].map((i) => hi[i] - lo[i]) as Vec3
  }
}

export function pointBounds(points: Vec3[], pad: number): TunerBounds | null {
  return unionBounds(points.map((p) => ({ center: p, size: [pad * 2, pad * 2, pad * 2] as Vec3 })))
}

export function movedBounds(b: TunerBounds, fromPos: Vec3, fromRot: Quat, toPos: Vec3, toRot: Quat): TunerBounds {
  const delta = quat(toRot).multiply(quat(fromRot).invert())
  const corners: TunerBounds[] = []
  for (const sx of [-0.5, 0.5])
    for (const sy of [-0.5, 0.5])
      for (const sz of [-0.5, 0.5]) {
        const c = vec([b.center[0] + b.size[0] * sx, b.center[1] + b.size[1] * sy, b.center[2] + b.size[2] * sz])
        const p = c.sub(vec(fromPos)).applyQuaternion(delta).add(vec(toPos))
        corners.push({ center: arr(p), size: [0, 0, 0] })
      }
  return unionBounds(corners) ?? b
}
