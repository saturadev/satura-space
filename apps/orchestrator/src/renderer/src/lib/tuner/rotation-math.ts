import { Euler, MathUtils, Quaternion } from 'three'

export type Quat = [number, number, number, number]
export type Vec3 = [number, number, number]

export const IDENTITY: Quat = [0, 0, 0, 1]

export function normalizeQuat(q: readonly (number | null)[] | null | undefined): Quat {
  const [x, y, z, w] = [q?.[0] ?? 0, q?.[1] ?? 0, q?.[2] ?? 0, q?.[3] ?? 1]
  const m = Math.hypot(x, y, z, w)
  return m < 1e-9 ? [...IDENTITY] : [x / m, y / m, z / m, w / m]
}

export function unityToThree(q: Quat): Quaternion {
  return new Quaternion(-q[0], -q[1], q[2], q[3])
}

export function threeToUnity(q: Quaternion): Quat {
  return normalizeQuat([-q.x, -q.y, q.z, q.w])
}

export function eulerToQuat(e: Vec3): Quat {
  const q = new Quaternion().setFromEuler(
    new Euler(MathUtils.degToRad(e[0]), MathUtils.degToRad(e[1]), MathUtils.degToRad(e[2]), 'YXZ')
  )
  return normalizeQuat([q.x, q.y, q.z, q.w])
}

function wrapNear(deg: number, near: number): number {
  let d = deg
  while (d - near > 180) d -= 360
  while (d - near < -180) d += 360
  return d
}

function wrap180(deg: number): number {
  const d = ((deg % 360) + 360) % 360
  return d > 180 ? d - 360 : d
}

export function quatToEuler(q: Quat, near?: Vec3): Vec3 {
  const e = new Euler().setFromQuaternion(new Quaternion(q[0], q[1], q[2], q[3]).normalize(), 'YXZ')
  const raw: Vec3 = [MathUtils.radToDeg(e.x), MathUtils.radToDeg(e.y), MathUtils.radToDeg(e.z)]
  if (!near) return raw.map((d) => round(wrap180(d))) as Vec3
  const a = raw.map((d, i) => wrapNear(d, near[i])) as Vec3
  const alt = [180 - raw[0], raw[1] + 180, raw[2] + 180].map((d, i) => wrapNear(d, near[i])) as Vec3
  const dist = (v: Vec3): number => v.reduce((s, d, i) => s + Math.abs(d - near[i]), 0)
  return (dist(alt) < dist(a) ? alt : a).map(round) as Vec3
}

function round(d: number): number {
  const r = Math.round(d * 1000) / 1000
  return Object.is(r, -0) ? 0 : r
}
