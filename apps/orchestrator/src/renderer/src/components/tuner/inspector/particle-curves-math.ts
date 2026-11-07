import type { TunerCurve } from '@shared/tuner-inspector-popups'
import type { TiPsCurve, TiPsCurves } from '@shared/tuner-inspector'
import { decodeCurve, evaluate, updateTangents } from './popups/curve-math'
import type { Rgba } from '../../../lib/tuner/inspector/model'

export const PSC_MARGIN = { left: 40, right: 25, top: 25, bottom: 25 }

export type PsSel = [number, number][]

export interface PsItem {
  data: TiPsCurve
  ids: number[]
  rank: number
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

export function flatSel(sel: PsSel): number[] {
  return sel.flatMap(([id, key]) => [id, key])
}

export function pairSel(flat: number[] | undefined): PsSel {
  const out: PsSel = []
  if (!flat) return out
  for (let i = 0; i + 1 < flat.length; i += 2) out.push([flat[i], flat[i + 1]])
  return out
}

export function sameSel(a: PsSel, b: PsSel): boolean {
  if (a.length !== b.length) return false
  const k = (s: [number, number]): string => `${s[0]}:${s[1]}`
  const set = new Set(a.map(k))
  return b.every((s) => set.has(k(s)))
}

export function orderedItems(psc: TiPsCurves, front: number | null): PsItem[] {
  const pos = new Map<number, number>()
  psc.order.forEach((id, i) => pos.set(id, i))
  const items = psc.curves.map((c, i) => {
    const ids = c.minId > 0 ? [c.id, c.minId] : [c.id]
    const rank = Math.max(...ids.map((id) => pos.get(id) ?? -1000 + i))
    return { data: c, ids, rank }
  })
  if (front !== null) {
    const f = items.find((it) => it.ids.includes(front))
    if (f) f.rank = Number.MAX_SAFE_INTEGER
  }
  return items.sort((a, b) => a.rank - b.rank)
}

export function curveOf(item: PsItem, id: number, local: Map<number, TunerCurve>): TunerCurve | null {
  const l = local.get(id)
  if (l) return l
  if (id === item.data.id) return decodeCurve(item.data.max)
  if (id === item.data.minId && item.data.min) return decodeCurve(item.data.min)
  return null
}

export interface KeyMap {
  time: (t: number) => number
  value: (v: number) => number
  flipX?: boolean
  flipY?: boolean
}

export function transformKeys(curve: TunerCurve, idx: number[], map: KeyMap, vmin: number): { curve: TunerCurve; idx: number[] } {
  const marked = curve.keys.map((k, i) => ({ k: { ...k }, s: idx.includes(i) }))
  for (const m of marked) {
    if (!m.s) continue
    const k = m.k
    const src = { ...k }
    k.time = clamp(map.time(src.time), 0, 1)
    k.value = clamp(map.value(src.value), vmin, 1)
    if (map.flipX) {
      k.inTangent = src.outTangent !== Infinity ? -src.outTangent : Infinity
      k.outTangent = src.inTangent !== Infinity ? -src.inTangent : Infinity
      k.inWeight = src.outWeight
      k.outWeight = src.inWeight
      k.weightedMode = src.weightedMode === 1 ? 2 : src.weightedMode === 2 ? 1 : src.weightedMode
    }
    if (map.flipY) {
      k.inTangent = k.inTangent !== Infinity ? -k.inTangent : Infinity
      k.outTangent = k.outTangent !== Infinity ? -k.outTangent : Infinity
    }
  }
  const moved = marked.filter((m) => m.s)
  const kept = marked.filter((m) => !m.s && !moved.some((x) => Math.abs(x.k.time - m.k.time) < 1e-6))
  const all = [...kept, ...moved].sort((a, b) => a.k.time - b.k.time)
  const keys = updateTangents(all.map((m) => m.k))
  return { curve: { ...curve, keys }, idx: all.flatMap((m, i) => (m.s ? [i] : [])) }
}

export function moveKeys(curve: TunerCurve, idx: number[], dt: number, dv: number, vmin: number): { curve: TunerCurve; idx: number[] } {
  return transformKeys(curve, idx, { time: (t) => t + dt, value: (v) => v + dv }, vmin)
}

export function scaleAbout(pivot: number, picked: number, to: number, offset: number): number | null {
  const den = picked - pivot
  if (Math.abs(den) < 1e-9) return null
  const s = (to - offset - pivot) / den
  return Math.abs(s) < 1e-3 ? null : s
}

export interface View {
  t0: number
  t1: number
  v0: number
  v1: number
}

export const MIN_VIEW = 0.05

export function enforceView(v: View, vmin: number): View {
  const fit = (a: number, b: number, lo: number, hi: number, min: number): [number, number] => {
    let w = Math.min(Math.max(b - a, min), hi - lo)
    let x = a + (b - a - w) / 2
    if (x < lo) x = lo
    if (x + w > hi) x = hi - w
    return [x, x + w]
  }
  const [t0, t1] = fit(v.t0, v.t1, 0, 1, MIN_VIEW)
  const [v0, v1] = fit(v.v0, v.v1, vmin, 1, 1e-4)
  return { t0, t1, v0, v1 }
}

export function zoomView(v: View, ft: number, fv: number, scale: number, lockH: boolean, lockV: boolean, vmin: number): View {
  const k = 1 / scale
  if (!lockH && (v.t1 - v.t0) * k <= MIN_VIEW) return v
  const next = {
    t0: lockH ? v.t0 : ft + (v.t0 - ft) * k,
    t1: lockH ? v.t1 : ft + (v.t1 - ft) * k,
    v0: lockV ? v.v0 : fv + (v.v0 - fv) * k,
    v1: lockV ? v.v1 : fv + (v.v1 - fv) * k
  }
  return enforceView(next, vmin)
}

export function panView(v: View, dt: number, dv: number, vmin: number): View {
  const w = v.t1 - v.t0
  const h = v.v1 - v.v0
  const t0 = clamp(v.t0 + dt, 0, 1 - w)
  const v0 = clamp(v.v0 + dv, vmin, 1 - h)
  return { t0, t1: t0 + w, v0, v1: v0 + h }
}

export interface Box {
  t0: number
  t1: number
  v0: number
  v1: number
}

export function boundsOf(points: [number, number][]): Box | null {
  if (!points.length) return null
  let t0 = Infinity
  let t1 = -Infinity
  let v0 = Infinity
  let v1 = -Infinity
  for (const [t, v] of points) {
    t0 = Math.min(t0, t)
    t1 = Math.max(t1, t)
    v0 = Math.min(v0, v)
    v1 = Math.max(v1, v)
  }
  return { t0, t1, v0, v1 }
}

export function samplesBetween(c: TunerCurve, a: number, b: number, n = 24): [number, number][] {
  const out: [number, number][] = []
  if (!(b > a)) return out
  for (let i = 0; i <= n; i++) {
    const t = a + ((b - a) * i) / n
    out.push([t, evaluate(c, t)])
  }
  return out
}

export function frameBox(box: Box | null): View | null {
  if (!box) return null
  const w = Math.max(box.t1 - box.t0, 0.1)
  const h = Math.max(box.v1 - box.v0, 0.1)
  const ct = (box.t0 + box.t1) / 2
  const cv = (box.v0 + box.v1) / 2
  return { t0: ct - w / 2, t1: ct + w / 2, v0: cv - h / 2, v1: cv + h / 2 }
}

export const TICK_MODULOS = [
  0.0000001, 0.0000005, 0.000001, 0.000005, 0.00001, 0.00005, 0.0001, 0.0005, 0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5, 10, 50, 100, 500, 1000, 5000, 10000, 50000,
  100000, 500000, 1000000, 5000000, 10000000
]

export interface TickLevel {
  period: number
  strength: number
  ticks: number[]
}

export function tickLevels(min: number, max: number, pixels: number, distMin = 10, distFull = 80): TickLevel[] {
  const span = max - min
  if (!(span > 0) || !(pixels > 0)) return []
  const m = TICK_MODULOS
  const strength: number[] = []
  let smallest = 0
  let biggest = m.length - 1
  for (let i = m.length - 1; i >= 0; i--) {
    const spacing = (m[i] * pixels) / span
    strength[i] = (spacing - distMin) / (distFull - distMin)
    if (strength[i] >= 1) biggest = i
    if (spacing <= distMin) {
      smallest = i
      break
    }
  }
  const out: TickLevel[] = []
  for (let i = smallest; i <= biggest; i++) {
    const s = clamp(strength[i], 0, 1)
    const next = i < biggest ? Math.round(m[i + 1] / m[i]) : 0
    const list: number[] = []
    const a = Math.floor(min / m[i])
    const b = Math.ceil(max / m[i])
    for (let j = a; j <= b; j++) {
      if (next && j % next === 0) continue
      list.push(j * m[i])
    }
    out.push({ period: m[i], strength: s, ticks: list })
  }
  return out
}

export function labelPeriod(min: number, max: number, pixels: number, distLabel: number): number {
  const span = max - min
  if (!(span > 0) || !(pixels > 0)) return 1
  for (const p of TICK_MODULOS) if ((p * pixels) / span >= distLabel) return p
  return TICK_MODULOS[TICK_MODULOS.length - 1]
}

export function shiftCurve(curve: TunerCurve, dv: number): TunerCurve {
  return { ...curve, keys: curve.keys.map((k) => ({ ...k, value: k.value + dv })) }
}

export function shiftRange(curves: TunerCurve[], dv: number, vmin: number): number {
  let lo = -Infinity
  let hi = Infinity
  for (const c of curves)
    for (const k of c.keys) {
      lo = Math.max(lo, vmin - k.value)
      hi = Math.min(hi, 1 - k.value)
    }
  if (lo > hi) return 0
  return clamp(dv, lo, hi)
}

export function deleteKeys(curve: TunerCurve, idx: number[]): TunerCurve {
  const left = curve.keys.filter((_, i) => !idx.includes(i))
  if (left.length === 0) return curve
  return { ...curve, keys: updateTangents(left) }
}

export function decimalsFor(step: number): number {
  return clamp(-Math.floor(Math.log10(Math.abs(step))), 0, 15)
}

export function fmtAxis(v: number, decimals: number): string {
  return v.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
}

export function scaled(c: Rgba, k: number, a?: number): Rgba {
  return { r: c.r * k, g: c.g * k, b: c.b * k, a: a ?? c.a * k }
}

export function towardWhite(c: Rgba, t: number): Rgba {
  return { r: c.r + (1 - c.r) * t, g: c.g + (1 - c.g) * t, b: c.b + (1 - c.b) * t, a: c.a + (1 - c.a) * t }
}

export function regionContains(max: TunerCurve, min: TunerCurve, t: number, v: number): boolean {
  const a = evaluate(max, t)
  const b = evaluate(min, t)
  return v >= Math.min(a, b) && v <= Math.max(a, b)
}

export function axisScalarFor(items: PsItem[], sel: PsSel): { x: number; y: number; ids: number[]; editable: boolean } | null {
  const curvesSel = [...new Set(sel.map(([id]) => id))]
  if (curvesSel.length <= 1) {
    const top = items[items.length - 1]
    if (!top) return null
    return { x: top.data.sx, y: top.data.sy, ids: [top.data.id], editable: top.data.set && top.data.sy >= 0 }
  }
  const owners = items.filter((it) => it.ids.some((id) => curvesSel.includes(id)))
  if (owners.length === 0) return null
  const same = (k: 'sx' | 'sy'): number => (owners.some((o) => Math.abs(o.data[k] - owners[0].data[k]) > 1e-5) ? -1 : owners[0].data[k])
  const y = same('sy')
  return { x: same('sx'), y, ids: y >= 0 ? owners.map((o) => o.data.id) : [], editable: y >= 0 && owners.every((o) => o.data.set) }
}
