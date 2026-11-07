import { Matrix4, Quaternion, Vector3, type Camera } from 'three'
import type { Vec3 } from '@shared/tuner'

export interface ColliderState {
  type: 'BoxCollider' | 'SphereCollider' | 'CapsuleCollider' | 'MeshCollider'
  enabled: boolean
  trigger: boolean
  center: Vec3
  size: Vec3
  radius: number
  height: number
  direction: number
}

export interface Handle {
  id: number
  axis: number
  sign: number
  kind: 'size' | 'radius' | 'height'
  world: Vector3
  dir: Vector3
}

const SEG = 48

function frame(m: Matrix4): { pos: Vector3; rot: Quaternion; scl: Vector3 } {
  const pos = new Vector3()
  const rot = new Quaternion()
  const scl = new Vector3()
  m.decompose(pos, rot, scl)
  return { pos, rot, scl }
}

function axisVec(i: number): Vector3 {
  return new Vector3(i === 0 ? 1 : 0, i === 1 ? 1 : 0, i === 2 ? -1 : 0)
}

function localPoint(c: Vec3): Vector3 {
  return new Vector3(c[0], c[1], -c[2])
}

function capsuleDims(c: ColliderState, scl: Vector3): { r: number; h: number } {
  const s = [Math.abs(scl.x), Math.abs(scl.y), Math.abs(scl.z)]
  const others = [0, 1, 2].filter((i) => i !== c.direction).map((i) => s[i])
  const r = c.radius * Math.max(...others)
  const h = Math.max(c.height * s[c.direction], r * 2)
  return { r, h }
}

function circle(out: number[], center: Vector3, a: Vector3, b: Vector3, r: number, from = 0, to = Math.PI * 2): void {
  const n = Math.max(8, Math.round((SEG * (to - from)) / (Math.PI * 2)))
  let prev: Vector3 | null = null
  for (let i = 0; i <= n; i++) {
    const t = from + ((to - from) * i) / n
    const p = center.clone().addScaledVector(a, Math.cos(t) * r).addScaledVector(b, Math.sin(t) * r)
    if (prev) out.push(prev.x, prev.y, prev.z, p.x, p.y, p.z)
    prev = p
  }
}

export function colliderLines(c: ColliderState, world: Matrix4, out: number[], eye?: Vector3): void {
  if (c.type === 'BoxCollider') {
    const pts: Vector3[] = []
    for (const sx of [-0.5, 0.5])
      for (const sy of [-0.5, 0.5])
        for (const sz of [-0.5, 0.5]) pts.push(localPoint([c.center[0] + c.size[0] * sx, c.center[1] + c.size[1] * sy, c.center[2] + c.size[2] * sz]).applyMatrix4(world))
    const edges = [
      [0, 1], [2, 3], [4, 5], [6, 7],
      [0, 2], [1, 3], [4, 6], [5, 7],
      [0, 4], [1, 5], [2, 6], [3, 7]
    ]
    for (const [a, b] of edges) out.push(pts[a].x, pts[a].y, pts[a].z, pts[b].x, pts[b].y, pts[b].z)
    return
  }
  const { rot, scl } = frame(world)
  const center = localPoint(c.center).applyMatrix4(world)
  const ax = [0, 1, 2].map((i) => axisVec(i).applyQuaternion(rot).normalize())
  if (c.type === 'SphereCollider') {
    const r = c.radius * Math.max(Math.abs(scl.x), Math.abs(scl.y), Math.abs(scl.z))
    circle(out, center, ax[0], ax[1], r)
    circle(out, center, ax[1], ax[2], r)
    circle(out, center, ax[0], ax[2], r)
    if (eye) {
      const v = center.clone().sub(eye)
      const d = v.length()
      if (d > r) {
        const n = v.normalize()
        const rr = (r * Math.sqrt(d * d - r * r)) / d
        const cc = center.clone().addScaledVector(n, (-r * r) / d)
        const a = new Vector3().crossVectors(n, Math.abs(n.y) < 0.9 ? new Vector3(0, 1, 0) : new Vector3(1, 0, 0)).normalize()
        const b = new Vector3().crossVectors(n, a).normalize()
        circle(out, cc, a, b, rr)
      }
    }
    return
  }
  if (c.type === 'CapsuleCollider') {
    const { r, h } = capsuleDims(c, scl)
    const d = ax[c.direction]
    const [o1, o2] = [0, 1, 2].filter((i) => i !== c.direction).map((i) => ax[i])
    const half = h / 2 - r
    const top = center.clone().addScaledVector(d, half)
    const bot = center.clone().addScaledVector(d, -half)
    circle(out, top, o1, o2, r)
    circle(out, bot, o1, o2, r)
    for (const o of [o1, o2])
      for (const s of [-1, 1]) {
        const a = top.clone().addScaledVector(o, r * s)
        const b = bot.clone().addScaledVector(o, r * s)
        out.push(a.x, a.y, a.z, b.x, b.y, b.z)
      }
    for (const o of [o1, o2]) {
      circle(out, top, o, d, r, 0, Math.PI)
      circle(out, bot, o, d.clone().negate(), r, 0, Math.PI)
    }
  }
}

export function colliderHandles(c: ColliderState, world: Matrix4): Handle[] {
  const { rot, scl } = frame(world)
  const center = localPoint(c.center).applyMatrix4(world)
  const ax = [0, 1, 2].map((i) => axisVec(i).applyQuaternion(rot).normalize())
  const s = [Math.abs(scl.x), Math.abs(scl.y), Math.abs(scl.z)]
  const out: Handle[] = []
  let id = 0
  if (c.type === 'BoxCollider') {
    for (let i = 0; i < 3; i++)
      for (const sign of [1, -1]) out.push({ id: id++, axis: i, sign, kind: 'size', dir: ax[i].clone().multiplyScalar(sign), world: center.clone().addScaledVector(ax[i], (sign * c.size[i] * s[i]) / 2) })
    return out
  }
  if (c.type === 'SphereCollider') {
    const r = c.radius * Math.max(...s)
    for (let i = 0; i < 3; i++) for (const sign of [1, -1]) out.push({ id: id++, axis: i, sign, kind: 'radius', dir: ax[i].clone().multiplyScalar(sign), world: center.clone().addScaledVector(ax[i], sign * r) })
    return out
  }
  if (c.type === 'CapsuleCollider') {
    const { r, h } = capsuleDims(c, scl)
    for (let i = 0; i < 3; i++)
      for (const sign of [1, -1]) {
        const height = i === c.direction
        out.push({ id: id++, axis: i, sign, kind: height ? 'height' : 'radius', dir: ax[i].clone().multiplyScalar(sign), world: center.clone().addScaledVector(ax[i], sign * (height ? h / 2 : r)) })
      }
  }
  return out
}

export function rayAxisParam(origin: Vector3, rayDir: Vector3, p0: Vector3, axis: Vector3): number {
  const w0 = p0.clone().sub(origin)
  const a = axis.dot(axis)
  const b = axis.dot(rayDir)
  const c = rayDir.dot(rayDir)
  const d = axis.dot(w0)
  const e = rayDir.dot(w0)
  const den = a * c - b * b
  if (Math.abs(den) < 1e-9) return 0
  return (b * e - c * d) / den
}

export interface DragStart {
  handle: Handle
  center: Vector3
  start: ColliderState
  param0: number
}

export function applyDrag(drag: DragStart, c: ColliderState, world: Matrix4, param: number, symmetric: boolean): void {
  const { scl } = frame(world)
  const s = [Math.abs(scl.x), Math.abs(scl.y), Math.abs(scl.z)]
  const h = drag.handle
  const st = drag.start
  const delta = param - drag.param0
  const along = h.sign
  if (h.kind === 'size') {
    const k = s[h.axis] || 1
    const dLocal = delta / k
    const size = [...st.size] as Vec3
    const center = [...st.center] as Vec3
    if (symmetric) size[h.axis] = Math.max(0, st.size[h.axis] + dLocal * 2)
    else {
      size[h.axis] = Math.max(0, st.size[h.axis] + dLocal)
      center[h.axis] = st.center[h.axis] + (along * (size[h.axis] - st.size[h.axis])) / 2
    }
    c.size = size
    c.center = center
    return
  }
  if (c.type === 'SphereCollider') {
    const k = Math.max(...s) || 1
    c.radius = Math.max(0, st.radius + delta / k)
    return
  }
  if (h.kind === 'radius') {
    const others = [0, 1, 2].filter((i) => i !== c.direction).map((i) => s[i])
    const k = Math.max(...others) || 1
    c.radius = Math.max(0, st.radius + delta / k)
    return
  }
  const k = s[c.direction] || 1
  const dLocal = delta / k
  if (symmetric) c.height = Math.max(0, st.height + dLocal * 2)
  else {
    c.height = Math.max(0, st.height + dLocal)
    const center = [...st.center] as Vec3
    center[c.direction] = st.center[c.direction] + (along * (c.height - st.height)) / 2
    c.center = center
  }
}

export function project(p: Vector3, cam: Camera, w: number, h: number): { x: number; y: number; z: number } {
  const v = p.clone().project(cam)
  return { x: ((v.x + 1) / 2) * w, y: ((1 - v.y) / 2) * h, z: v.z }
}
