import { frameOf, type TunerAnimChannel, type TunerAnimClip, type TunerAnimKey, type TunerAnimProp, type TunerBezier } from '@shared/tuner-animator'
import { channelColor, cubicBezier, evalSegment, selId, tOf, xOf, type TimeScale } from './animator'

export const TM_FREE = 0
export const TM_AUTO = 1
export const TM_LINEAR = 2
export const TM_CONSTANT = 3
export const TM_CLAMPED = 4
export const TANGENT_PX = 50
export const WEIGHT_MIN_PX = 10
export const HIT_PX = 7

export const isAutoMode = (m: number): boolean => m === TM_AUTO || m === TM_CLAMPED

export const EASE_PRESETS: Record<string, TunerBezier> = {
  linear: [0, 0, 1, 1],
  ease: [0.25, 0.1, 0.25, 1],
  easeIn: [0.42, 0, 1, 1],
  easeOut: [0, 0, 0.58, 1],
  easeInOut: [0.42, 0, 0.58, 1],
  backIn: [0.36, 0, 0.66, -0.56],
  backOut: [0.34, 1.56, 0.64, 1]
}

export const cloneKey = (k: TunerAnimKey): TunerAnimKey => ({ ...k })

function slopeTo(a: TunerAnimKey, b: TunerAnimKey): number {
  const dt = b.t - a.t
  return Math.abs(dt) < 1e-9 ? 0 : (b.v - a.v) / dt
}

function clampedAutoSlope(keys: readonly TunerAnimKey[], i: number): number {
  const k = keys[i]
  const p = keys[i - 1]
  const q = keys[i + 1]
  if (!p || !q) return 0
  const dx1 = k.t - p.t
  const dy1 = k.v - p.v
  const dx2 = q.t - k.t
  const dy2 = q.v - k.v
  const m1 = dx1 > 1e-9 ? dy1 / dx1 : 0
  const m2 = dx2 > 1e-9 ? dy2 / dx2 : 0
  if (!((m1 > 0 && m2 > 0) || (m1 < 0 && m2 < 0))) return 0
  const dy = dy1 + dy2
  let m = dx1 + dx2 > 1e-9 ? dy / (dx1 + dx2) : 0
  const d = dy1 / dy
  if (d > 0.75) m *= (1 - d) * 4
  else if (d < 0.25) m *= d * 4
  return m
}

export function autoSlope(keys: readonly TunerAnimKey[], i: number): number {
  const k = keys[i]
  const p = keys[i - 1]
  const q = keys[i + 1]
  if (!p && !q) return 0
  if (!p) return slopeTo(k, q)
  if (!q) return slopeTo(p, k)
  return (slopeTo(p, k) + slopeTo(k, q)) / 2
}

export function updateTangents(keys: TunerAnimKey[]): void {
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i]
    if (k.lm === TM_LINEAR && i > 0) k.in = slopeTo(keys[i - 1], k)
    if (k.rm === TM_LINEAR && i < keys.length - 1) k.out = slopeTo(k, keys[i + 1])
    if (isAutoMode(k.lm) || isAutoMode(k.rm)) {
      const clamped = k.lm === TM_CLAMPED || k.rm === TM_CLAMPED
      const m = clamped ? clampedAutoSlope(keys, i) : autoSlope(keys, i)
      k.in = m
      k.out = m
      if (clamped || i > 0) k.inW = 1 / 3
      if (clamped || i < keys.length - 1) k.outW = 1 / 3
    }
    if (k.lm === TM_FREE && k.rm === TM_FREE && !k.broken) k.out = k.in
    if (k.lm === TM_CONSTANT) k.in = null
    if (k.rm === TM_CONSTANT) k.out = null
  }
}

export function evalKeys(keys: readonly TunerAnimKey[], t: number): number {
  if (keys.length === 0) return 0
  if (t <= keys[0].t) return keys[0].v
  const last = keys[keys.length - 1]
  if (t >= last.t) return last.v
  let lo = 0
  let hi = keys.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (keys[mid].t <= t) lo = mid
    else hi = mid
  }
  return evalSegment(keys[lo], keys[hi], t)
}

export function keysRange(keys: readonly TunerAnimKey[]): [number, number] {
  if (keys.length === 0) return [0, 0]
  let lo = Infinity
  let hi = -Infinity
  for (const k of keys) {
    lo = Math.min(lo, k.v)
    hi = Math.max(hi, k.v)
  }
  for (let i = 0; i < keys.length - 1; i++)
    for (let j = 1; j < 16; j++) {
      const v = evalSegment(keys[i], keys[i + 1], keys[i].t + ((keys[i + 1].t - keys[i].t) * j) / 16)
      lo = Math.min(lo, v)
      hi = Math.max(hi, v)
    }
  return [lo, hi]
}

export interface CurveMap {
  o: number
  s: number
}

export const IDENTITY_MAP: CurveMap = { o: 0, s: 1 }

export function normMap(keys: readonly TunerAnimKey[]): CurveMap {
  const [lo, hi] = keysRange(keys)
  const half = (hi - lo) / 2
  return half > 1e-9 ? { o: (lo + hi) / 2, s: 1 / half } : { o: lo, s: 1 }
}

export interface ValueView {
  lo: number
  hi: number
}

export interface CurveChan {
  id: string
  keys: TunerAnimKey[]
  color: string
  label: string
  name: string
  discrete: boolean
  m: CurveMap
}

export interface CurveRegion {
  y: number
  h: number
  ts: TimeScale
  vv: ValueView
  chans: CurveChan[]
}

export function vy(R: CurveRegion, m: CurveMap, v: number): number {
  return R.y + R.h - (((v - m.o) * m.s - R.vv.lo) / (R.vv.hi - R.vv.lo)) * R.h
}

export function py(R: CurveRegion, p: number): number {
  return R.y + R.h - ((p - R.vv.lo) / (R.vv.hi - R.vv.lo)) * R.h
}

export function pAt(R: CurveRegion, y: number): number {
  return R.vv.lo + ((R.y + R.h - y) / R.h) * (R.vv.hi - R.vv.lo)
}

export function vAt(R: CurveRegion, m: CurveMap, y: number): number {
  return pAt(R, y) / m.s + m.o
}

export function niceStep(range: number, px: number, target: number): number {
  const raw = (Math.max(1e-9, range) * target) / Math.max(1, px)
  const p = Math.pow(10, Math.floor(Math.log10(raw)))
  for (const m of [1, 2, 5, 10]) if (m * p >= raw) return m * p
  return 10 * p
}

export function fitRange(chans: readonly CurveChan[], t0: number, t1: number): ValueView {
  let lo = Infinity
  let hi = -Infinity
  for (const c of chans) {
    if (c.keys.length === 0) continue
    for (let i = 0; i <= 64; i++) {
      const p = (evalKeys(c.keys, t0 + ((t1 - t0) * i) / 64) - c.m.o) * c.m.s
      lo = Math.min(lo, p)
      hi = Math.max(hi, p)
    }
    for (const k of c.keys) {
      if (k.t < t0 - 1e-6 || k.t > t1 + 1e-6) continue
      const p = (k.v - c.m.o) * c.m.s
      lo = Math.min(lo, p)
      hi = Math.max(hi, p)
    }
  }
  if (!Number.isFinite(lo)) return { lo: -1, hi: 1 }
  let pad = (hi - lo) * 0.12
  if (hi - lo < 1e-6) pad = Math.max(0.5, Math.abs(hi) * 0.25)
  return { lo: lo - pad, hi: hi + pad }
}

export function fitSelected(chans: readonly CurveChan[], sel: ReadonlySet<string>, fps: number): ValueView | null {
  let lo = Infinity
  let hi = -Infinity
  for (const c of chans)
    for (const k of c.keys) {
      if (!sel.has(selId(c.id, frameOf(k.t, fps)))) continue
      const p = (k.v - c.m.o) * c.m.s
      lo = Math.min(lo, p)
      hi = Math.max(hi, p)
    }
  if (!Number.isFinite(lo)) return null
  let pad = (hi - lo) * 0.2
  if (hi - lo < 1e-6) pad = Math.max(0.25, Math.abs(hi) * 0.2)
  return { lo: lo - pad, hi: hi + pad }
}

export function sideEditable(keys: readonly TunerAnimKey[], i: number, side: 'in' | 'out'): boolean {
  const k = keys[i]
  if (!k) return false
  if (side === 'in' && i < 1) return false
  if (side === 'out' && i >= keys.length - 1) return false
  const m = side === 'in' ? k.lm : k.rm
  return m === TM_FREE || isAutoMode(m)
}

export function handlePt(R: CurveRegion, c: CurveChan, i: number, side: 'in' | 'out'): { x: number; y: number; weighted: boolean } | null {
  const ks = c.keys
  const k = ks[i]
  if (!sideEditable(ks, i, side)) return null
  const slope = side === 'in' ? k.in : k.out
  if (slope === null) return null
  const sign = side === 'in' ? -1 : 1
  const kx = xOf(R.ts, k.t)
  const ky = vy(R, c.m, k.v)
  const pxPerT = R.ts.width / R.ts.span
  const pxPerV = (R.h * c.m.s) / (R.vv.hi - R.vv.lo)
  const dx = pxPerT
  const dy = -slope * pxPerV
  const l = Math.hypot(dx, dy) || 1
  const weighted = side === 'in' ? (k.wm & 1) !== 0 : (k.wm & 2) !== 0
  if (weighted) {
    const nb = side === 'in' ? ks[i - 1] : ks[i + 1]
    const dt = Math.abs(nb.t - k.t) * (side === 'in' ? k.inW : k.outW)
    const bx = sign * dt * pxPerT
    const by = sign * -slope * dt * pxPerV
    if (Math.hypot(bx, by) > WEIGHT_MIN_PX) return { x: kx + bx, y: ky + by, weighted }
    return { x: kx + (sign * dx * WEIGHT_MIN_PX) / l, y: ky + (sign * dy * WEIGHT_MIN_PX) / l, weighted }
  }
  return { x: kx + (sign * dx * TANGENT_PX) / l, y: ky + (sign * dy * TANGENT_PX) / l, weighted }
}

export function tangentFromPointer(R: CurveRegion, c: CurveChan, i: number, side: 'in' | 'out', x: number, y: number): { slope: number; weight: number } {
  const ks = c.keys
  const k = ks[i]
  const nb = side === 'in' ? ks[i - 1] : ks[i + 1]
  const minDt = R.ts.span / Math.max(1, R.ts.width)
  const dir = side === 'out' ? tOf(R.ts, x) - k.t : k.t - tOf(R.ts, x)
  const dt = Math.max(minDt, dir)
  const dv = vAt(R, c.m, y) - k.v
  const slope = side === 'out' ? dv / dt : -dv / dt
  const span = nb ? Math.abs(nb.t - k.t) : 1
  return { slope, weight: Math.max(0, Math.min(1, dt / Math.max(1e-9, span))) }
}

export function applyTangentDrag(keys: TunerAnimKey[], i: number, side: 'in' | 'out', slope: number, weight: number): void {
  const k = keys[i]
  if (side === 'in') {
    k.in = slope
    k.inW = weight
    k.lm = TM_FREE
    if (!k.broken) {
      k.out = slope
      k.rm = TM_FREE
    }
  } else {
    k.out = slope
    k.outW = weight
    k.rm = TM_FREE
    if (!k.broken) {
      k.in = slope
      k.lm = TM_FREE
    }
  }
}

export type CurveHit =
  | { kind: 'tan'; c: CurveChan; i: number; side: 'in' | 'out' }
  | { kind: 'key'; c: CurveChan; i: number }
  | { kind: 'seg'; c: CurveChan; i: number; t: number }

function distSeg(px: number, py0: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax
  const dy = by - ay
  const l = dx * dx + dy * dy
  const u = l ? Math.max(0, Math.min(1, ((px - ax) * dx + (py0 - ay) * dy) / l)) : 0
  return Math.hypot(px - (ax + u * dx), py0 - (ay + u * dy))
}

export function hitCurves(R: CurveRegion, x: number, y: number, sel: ReadonlySet<string>, fps: number): CurveHit | null {
  let best: CurveHit | null = null
  let bd = HIT_PX
  const top = [...R.chans].reverse()
  for (const c of top)
    c.keys.forEach((k, i) => {
      if (!sel.has(selId(c.id, frameOf(k.t, fps)))) return
      for (const side of ['in', 'out'] as const) {
        const hp = handlePt(R, c, i, side)
        if (!hp) continue
        const d = Math.hypot(x - hp.x, y - hp.y)
        if (d < bd) {
          bd = d
          best = { kind: 'tan', c, i, side }
        }
      }
    })
  if (best) return best
  bd = HIT_PX
  for (const c of top)
    c.keys.forEach((k, i) => {
      const d = Math.hypot(x - xOf(R.ts, k.t), y - vy(R, c.m, k.v))
      if (d < bd - 0.01) {
        bd = d
        best = { kind: 'key', c, i }
      }
    })
  if (best) return best
  bd = 5
  for (const c of top) {
    const ks = c.keys
    for (let i = 0; i < ks.length - 1; i++) {
      const a = ks[i]
      const b = ks[i + 1]
      const xa = xOf(R.ts, a.t)
      const xb = xOf(R.ts, b.t)
      if (x < xa - 4 || x > xb + 4) continue
      const n = Math.max(6, Math.min(80, Math.round((xb - xa) / 3)))
      let lx = xa
      let ly = vy(R, c.m, a.v)
      for (let j = 1; j <= n; j++) {
        const t = a.t + ((b.t - a.t) * j) / n
        const sx = xOf(R.ts, t)
        const sy = vy(R, c.m, evalSegment(a, b, Math.min(t, b.t - 1e-9)))
        const d = distSeg(x, y, lx, ly, sx, sy)
        if (d < bd) {
          bd = d
          best = { kind: 'seg', c, i, t: tOf(R.ts, x) }
        }
        lx = sx
        ly = sy
      }
      if (a.out === null || b.in === null) {
        const d = distSeg(x, y, xb, vy(R, c.m, a.v), xb, vy(R, c.m, b.v))
        if (d < bd) {
          bd = d
          best = { kind: 'seg', c, i, t: tOf(R.ts, x) }
        }
      }
    }
  }
  return best
}

export function curveKeysInRect(R: CurveRegion, fps: number, x0: number, y0: number, x1: number, y1: number): string[] {
  const [ax, bx] = x0 < x1 ? [x0, x1] : [x1, x0]
  const [ay, by] = y0 < y1 ? [y0, y1] : [y1, y0]
  const out: string[] = []
  for (const c of R.chans)
    for (const k of c.keys) {
      const x = xOf(R.ts, k.t)
      const y = vy(R, c.m, k.v)
      if (x >= ax && x <= bx && y >= ay && y <= by) out.push(selId(c.id, frameOf(k.t, fps)))
    }
  return out
}

export type SegShape = { step: true } | { flat: true } | { b: TunerBezier }

function segBezier(a: TunerAnimKey, b: TunerAnimKey): SegShape {
  const dt = b.t - a.t
  const dv = b.v - a.v
  if (a.out === null || b.in === null) return { step: true }
  if (Math.abs(dv) < 1e-9 || dt <= 0) return { flat: true }
  const ow = a.wm & 2 ? a.outW : 1 / 3
  const iw = b.wm & 1 ? b.inW : 1 / 3
  return { b: [ow, (a.out * ow * dt) / dv, 1 - iw, 1 - (b.in * iw * dt) / dv] }
}

export function sideMode(k: TunerAnimKey, left: boolean, mode: number): void {
  if (left) {
    k.lm = mode
    if (isAutoMode(k.rm)) k.rm = TM_FREE
  } else {
    k.rm = mode
    if (isAutoMode(k.lm)) k.lm = TM_FREE
  }
  k.broken = true
  if (mode === TM_CONSTANT) {
    if (left) k.in = null
    else k.out = null
  }
  if (mode === TM_FREE) {
    if (left && k.in === null) k.in = 0
    if (!left && k.out === null) k.out = 0
  }
}

export function applyEaseLocal(keys: TunerAnimKey[], i: number, bz: TunerBezier): void {
  const a = keys[i]
  const b = keys[i + 1]
  if (!a || !b) return
  const dt = b.t - a.t
  const dv = b.v - a.v
  if (dt <= 0) return
  const x1 = Math.max(0, Math.min(1, bz[0]))
  const y1 = bz[1]
  const x2 = Math.max(0, Math.min(1, bz[2]))
  const y2 = bz[3]
  sideMode(a, false, TM_FREE)
  sideMode(b, true, TM_FREE)
  const ow = Math.max(1e-4, Math.min(1, x1))
  const iw = Math.max(1e-4, Math.min(1, 1 - x2))
  a.outW = ow
  a.out = x1 < 1e-3 && Math.abs(y1) < 1e-3 ? (y2 * dv) / (Math.max(x2, 1e-3) * dt) : (y1 * dv) / (ow * dt)
  a.wm |= 2
  b.inW = iw
  b.in = 1 - x2 < 1e-3 && Math.abs(1 - y2) < 1e-3 ? ((1 - y1) * dv) / (Math.max(1 - x1, 1e-3) * dt) : ((1 - y2) * dv) / (iw * dt)
  b.wm |= 1
}

export function bezierMode(b: TunerBezier): string {
  const n = (v: number): string => {
    const r = Number(v.toFixed(4))
    return String(Object.is(r, -0) ? 0 : r)
  }
  return `bezier ${n(Math.max(0, Math.min(1, b[0])))} ${n(b[1])} ${n(Math.max(0, Math.min(1, b[2])))} ${n(b[3])}`
}

export const EASE_LABELS: [string, string][] = [
  ['linear', 'Linear'],
  ['ease', 'Ease'],
  ['easeIn', 'Ease In'],
  ['easeOut', 'Ease Out'],
  ['easeInOut', 'In Out'],
  ['backIn', 'Back In'],
  ['backOut', 'Back Out'],
  ['step', 'Step'],
  ['auto', 'Auto']
]

export function easeName(a: TunerAnimKey, b: TunerAnimKey): string {
  const sb = segBezier(a, b)
  if ('step' in sb) return 'Step'
  if ('flat' in sb) return 'Hold'
  if (isAutoMode(a.rm) && isAutoMode(b.lm)) return 'Auto'
  if (a.rm === TM_LINEAR && b.lm === TM_LINEAR) return 'Linear'
  for (const [name, label] of EASE_LABELS) {
    const p = EASE_PRESETS[name]
    if (p && p.every((v, j) => Math.abs(v - sb.b[j]) < 0.02)) return label
  }
  return 'Custom'
}

export function sampleEase(shape: SegShape, u: number): number {
  if ('step' in shape) return u < 1 ? 0 : 1
  if ('flat' in shape) return 0
  return cubicBezier(shape.b, u)
}

export interface EaseTarget {
  id: string
  fa: number
  fb: number
}

export interface EaseSeg {
  row: string
  label: string
  fa: number
  fb: number
  targets: EaseTarget[]
}

export function segKeys(ch: TunerAnimChannel | undefined, fa: number, fb: number, fps: number): [TunerAnimKey, TunerAnimKey, number] | null {
  if (!ch) return null
  const i = ch.keys.findIndex((k) => frameOf(k.t, fps) === fa)
  if (i < 0) return null
  const b = ch.keys[i + 1]
  if (!b || frameOf(b.t, fps) !== fb) return null
  return [ch.keys[i], b, i]
}

export function rowSegments(channels: readonly TunerAnimChannel[], fps: number, row: string, label: string): EaseSeg[] {
  const frames = new Set<number>()
  for (const c of channels) for (const k of c.keys) frames.add(frameOf(k.t, fps))
  const sorted = [...frames].sort((a, b) => a - b)
  const out: EaseSeg[] = []
  for (let i = 0; i < sorted.length - 1; i++) {
    const fa = sorted[i]
    const fb = sorted[i + 1]
    const targets: EaseTarget[] = []
    for (const c of channels) if (segKeys(c, fa, fb, fps)) targets.push({ id: c.id, fa, fb })
    if (targets.length > 0) out.push({ row, label, fa, fb, targets })
  }
  return out
}

export function segRep(seg: EaseSeg, idx: ReadonlyMap<string, TunerAnimChannel>, fps: number): [TunerAnimKey, TunerAnimKey, number] | null {
  let first: [TunerAnimKey, TunerAnimKey, number] | null = null
  for (const t of seg.targets) {
    const sk = segKeys(idx.get(t.id), t.fa, t.fb, fps)
    if (!sk) continue
    if (Math.abs(sk[1].v - sk[0].v) > 1e-9) return sk
    first ??= sk
  }
  return first
}

export function shapeOf(seg: EaseSeg, idx: ReadonlyMap<string, TunerAnimChannel>, fps: number): SegShape {
  let flat: SegShape | null = null
  for (const t of seg.targets) {
    const sk = segKeys(idx.get(t.id), t.fa, t.fb, fps)
    if (!sk) continue
    const shape = segBezier(sk[0], sk[1])
    if ('flat' in shape) {
      flat = shape
      continue
    }
    return shape
  }
  return flat ?? { flat: true }
}

function hashHue(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return Math.abs(h) % 360
}

export function curveColor(ch: TunerAnimChannel, prop: TunerAnimProp): string {
  return channelColor(ch.label) ?? `hsl(${hashHue(prop.id + ch.prop)} 70% 62%)`
}

export function channelName(prop: TunerAnimProp, ch: TunerAnimChannel): string {
  return prop.channels.length > 1 && ch.label ? `${prop.label}.${ch.label}` : prop.label
}

export function channelsOfRowKey(clip: TunerAnimClip | null, key: string): string[] {
  if (!clip) return []
  const all = clip.props.filter((p) => !p.pptr)
  if (key === 'summary') return all.flatMap((p) => p.channels.map((c) => c.id))
  if (key.startsWith('o:')) {
    const path = key.slice(2)
    return all.filter((p) => p.path === path).flatMap((p) => p.channels.map((c) => c.id))
  }
  if (key.startsWith('c:')) {
    const rest = key.slice(2)
    return all.filter((p) => `${p.path}|${p.type}` === rest).flatMap((p) => p.channels.map((c) => c.id))
  }
  if (key.startsWith('s:')) {
    const rest = key.slice(2)
    return all.filter((p) => p.section && `${p.path}|${p.type}|${p.section}` === rest).flatMap((p) => p.channels.map((c) => c.id))
  }
  if (key.startsWith('g:')) {
    const id = key.slice(2)
    return all.filter((p) => p.id === id).flatMap((p) => p.channels.map((c) => c.id))
  }
  if (key.startsWith('ch:')) {
    const id = key.slice(3)
    return all.some((p) => p.channels.some((c) => c.id === id)) ? [id] : []
  }
  return []
}

export function withOverlay(clip: TunerAnimClip | null, over: ReadonlyMap<string, TunerAnimKey[]> | null): TunerAnimClip | null {
  if (!clip || !over || over.size === 0) return clip
  return {
    ...clip,
    props: clip.props.map((p) =>
      p.channels.some((c) => over.has(c.id)) ? { ...p, channels: p.channels.map((c) => (over.has(c.id) ? { ...c, keys: over.get(c.id)! } : c)) } : p
    )
  }
}

export function moveKeysLocal(base: readonly TunerAnimKey[], frames: ReadonlySet<number>, df: number, dv: number, fps: number): TunerAnimKey[] {
  const moved: TunerAnimKey[] = []
  const stay: TunerAnimKey[] = []
  for (const k of base) {
    const f = frameOf(k.t, fps)
    if (frames.has(f)) moved.push({ ...k, t: Math.max(0, f + df) / fps, v: k.v + dv })
    else stay.push({ ...k })
  }
  const taken = new Set(moved.map((k) => frameOf(k.t, fps)))
  const out = stay.filter((k) => !taken.has(frameOf(k.t, fps))).concat(moved)
  out.sort((a, b) => a.t - b.t)
  updateTangents(out)
  return out
}
