import { TANGENT, WEIGHTED, WRAP, type TunerCurve, type TunerCurveKey } from '@shared/tuner-inspector-popups'

export const DEFAULT_WEIGHT = 1 / 3

export interface Bounds {
  tMin: number
  tMax: number
  vMin: number
  vMax: number
}

export function leftMode(k: TunerCurveKey): number {
  return k.left ?? TANGENT.free
}

export function rightMode(k: TunerCurveKey): number {
  return k.right ?? TANGENT.free
}

export function isAuto(mode: number): boolean {
  return mode === TANGENT.auto || mode === TANGENT.clampedAuto
}

function slope(a: TunerCurveKey, b: TunerCurveKey): number {
  const dt = b.time - a.time
  return dt === 0 ? 0 : (b.value - a.value) / dt
}

function autoTangent(keys: TunerCurveKey[], i: number): number {
  const n = keys.length
  if (n < 2) return 0
  if (i === 0) return slope(keys[0], keys[1])
  if (i === n - 1) return slope(keys[n - 2], keys[n - 1])
  return 0.5 * slope(keys[i - 1], keys[i]) + 0.5 * slope(keys[i], keys[i + 1])
}

function clampedAutoTangent(keys: TunerCurveKey[], i: number): number {
  const n = keys.length
  if (n < 3 || i === 0 || i === n - 1) return 0
  const prev = keys[i - 1]
  const key = keys[i]
  const next = keys[i + 1]
  const dy1 = key.value - prev.value
  const dy2 = next.value - key.value
  if (dy1 * dy2 <= 0) return 0
  const span = next.time - prev.time
  if (span <= 0) return 0
  const central = (next.value - prev.value) / span
  const limit = (4 * Math.min(Math.abs(dy1), Math.abs(dy2))) / span
  return Math.sign(central) * Math.min(Math.abs(central), limit)
}

export function linearIn(keys: TunerCurveKey[], i: number): number | null {
  return i > 0 ? slope(keys[i - 1], keys[i]) : null
}

export function linearOut(keys: TunerCurveKey[], i: number): number | null {
  return i < keys.length - 1 ? slope(keys[i], keys[i + 1]) : null
}

export function sortKeys(keys: TunerCurveKey[]): TunerCurveKey[] {
  return [...keys].sort((a, b) => a.time - b.time)
}

export function updateTangents(keys: TunerCurveKey[]): TunerCurveKey[] {
  return keys.map((k, i) => {
    const l = leftMode(k)
    const r = rightMode(k)
    const next = { ...k }
    if (isAuto(l) || isAuto(r)) {
      const clamped = l === TANGENT.clampedAuto || r === TANGENT.clampedAuto
      const s = clamped ? clampedAutoTangent(keys, i) : autoTangent(keys, i)
      next.inTangent = s
      next.outTangent = s
      next.inWeight = DEFAULT_WEIGHT
      next.outWeight = DEFAULT_WEIGHT
      return next
    }
    if (l === TANGENT.linear) {
      const s = linearIn(keys, i)
      if (s !== null) next.inTangent = s
    }
    if (r === TANGENT.linear) {
      const s = linearOut(keys, i)
      if (s !== null) next.outTangent = s
    }
    if (l === TANGENT.constant) next.inTangent = Infinity
    if (r === TANGENT.constant) next.outTangent = Infinity
    return next
  })
}

function outWeight(k: TunerCurveKey): number {
  return (k.weightedMode & WEIGHTED.out) !== 0 ? k.outWeight : DEFAULT_WEIGHT
}

function inWeight(k: TunerCurveKey): number {
  return (k.weightedMode & WEIGHTED.in) !== 0 ? k.inWeight : DEFAULT_WEIGHT
}

export function isStep(a: TunerCurveKey, b: TunerCurveKey): boolean {
  return !Number.isFinite(a.outTangent) || !Number.isFinite(b.inTangent)
}

export function segmentControls(a: TunerCurveKey, b: TunerCurveKey): [number, number, number, number, number, number, number, number] {
  const dt = b.time - a.time
  const w0 = outWeight(a)
  const w1 = inWeight(b)
  return [a.time, a.value, a.time + w0 * dt, a.value + w0 * dt * a.outTangent, b.time - w1 * dt, b.value - w1 * dt * b.inTangent, b.time, b.value]
}

function bez(p0: number, p1: number, p2: number, p3: number, u: number): number {
  const m = 1 - u
  return m * m * m * p0 + 3 * m * m * u * p1 + 3 * m * u * u * p2 + u * u * u * p3
}

function bezD(p0: number, p1: number, p2: number, p3: number, u: number): number {
  const m = 1 - u
  return 3 * m * m * (p1 - p0) + 6 * m * u * (p2 - p1) + 3 * u * u * (p3 - p2)
}

export function evaluateSegment(a: TunerCurveKey, b: TunerCurveKey, t: number): number {
  const dt = b.time - a.time
  if (dt <= 0) return a.value
  if (isStep(a, b)) return t >= b.time ? b.value : a.value
  const hermite = (a.weightedMode & WEIGHTED.out) === 0 && (b.weightedMode & WEIGHTED.in) === 0
  if (hermite) {
    const u = (t - a.time) / dt
    const u2 = u * u
    const u3 = u2 * u
    const m0 = a.outTangent * dt
    const m1 = b.inTangent * dt
    return (2 * u3 - 3 * u2 + 1) * a.value + (u3 - 2 * u2 + u) * m0 + (-2 * u3 + 3 * u2) * b.value + (u3 - u2) * m1
  }
  const [x0, y0, x1, y1, x2, y2, x3, y3] = segmentControls(a, b)
  let lo = 0
  let hi = 1
  let u = (t - a.time) / dt
  for (let i = 0; i < 24; i++) {
    const x = bez(x0, x1, x2, x3, u) - t
    if (Math.abs(x) < 1e-7) break
    if (x > 0) hi = u
    else lo = u
    const d = bezD(x0, x1, x2, x3, u)
    let nu = d !== 0 ? u - x / d : (lo + hi) / 2
    if (nu <= lo || nu >= hi) nu = (lo + hi) / 2
    u = nu
  }
  return bez(y0, y1, y2, y3, u)
}

function wrapTime(t: number, t0: number, t1: number, mode: number): number {
  const len = t1 - t0
  if (len <= 0) return t0
  if (mode === WRAP.loop) {
    const r = (((t - t0) % len) + len) % len
    return t0 + r
  }
  if (mode === WRAP.pingPong) {
    const r = (((t - t0) % (2 * len)) + 2 * len) % (2 * len)
    return t0 + (r <= len ? r : 2 * len - r)
  }
  return t < t0 ? t0 : t > t1 ? t1 : t
}

export function evaluate(curve: TunerCurve, t: number): number {
  const keys = curve.keys
  if (keys.length === 0) return 0
  if (keys.length === 1) return keys[0].value
  const first = keys[0]
  const last = keys[keys.length - 1]
  if (t < first.time) t = wrapTime(t, first.time, last.time, curve.preWrapMode)
  else if (t > last.time) t = wrapTime(t, first.time, last.time, curve.postWrapMode)
  if (t <= first.time) return first.value
  if (t >= last.time) return last.value
  let i = 0
  while (i < keys.length - 2 && keys[i + 1].time <= t) i++
  return evaluateSegment(keys[i], keys[i + 1], t)
}

export function slopeAt(curve: TunerCurve, t: number): number {
  const e = 1e-4
  return (evaluate(curve, t + e) - evaluate(curve, t - e)) / (2 * e)
}

export function modeForNewKey(keys: TunerCurveKey[], index: number): number {
  const prev = index > 0 ? keys[index - 1] : null
  const next = index < keys.length - 1 ? keys[index + 1] : null
  const all = (mode: number): boolean => (!prev || rightMode(prev) === mode) && (!next || leftMode(next) === mode)
  if (all(TANGENT.clampedAuto)) return TANGENT.clampedAuto
  if (all(TANGENT.auto)) return TANGENT.auto
  return TANGENT.free
}

export function addKey(curve: TunerCurve, time: number, value: number): { curve: TunerCurve; index: number } {
  const s = curve.keys.length >= 2 ? slopeAt(curve, time) : 0
  const key: TunerCurveKey = {
    time,
    value,
    inTangent: s,
    outTangent: s,
    inWeight: DEFAULT_WEIGHT,
    outWeight: DEFAULT_WEIGHT,
    weightedMode: WEIGHTED.none
  }
  const keys = [...curve.keys.filter((k) => Math.abs(k.time - time) > 1e-6), key].sort((a, b) => a.time - b.time)
  const index = keys.indexOf(key)
  const mode = curve.keys.length === 0 ? TANGENT.clampedAuto : modeForNewKey(keys, index)
  keys[index] = { ...key, left: mode, right: mode, broken: false }
  return { curve: { ...curve, keys: updateTangents(keys) }, index }
}

export function removeKey(curve: TunerCurve, index: number): TunerCurve {
  return { ...curve, keys: updateTangents(curve.keys.filter((_, i) => i !== index)) }
}

export function moveKey(curve: TunerCurve, index: number, time: number, value: number): { curve: TunerCurve; index: number } {
  const moved = { ...curve.keys[index], time, value }
  const rest = curve.keys.filter((_, i) => i !== index).filter((k) => Math.abs(k.time - time) > 1e-6)
  const keys = [...rest, moved].sort((a, b) => a.time - b.time)
  return { curve: { ...curve, keys: updateTangents(keys) }, index: keys.indexOf(moved) }
}

export type TangentAction =
  | 'clampedAuto'
  | 'auto'
  | 'freeSmooth'
  | 'flat'
  | 'broken'
  | 'leftFree'
  | 'leftLinear'
  | 'leftConstant'
  | 'leftWeighted'
  | 'rightFree'
  | 'rightLinear'
  | 'rightConstant'
  | 'rightWeighted'
  | 'bothFree'
  | 'bothLinear'
  | 'bothConstant'
  | 'bothWeighted'

export const KEY_MENU: { label: string; action: TangentAction | 'delete' | null }[] = [
  { label: 'Delete Key', action: 'delete' },
  { label: '', action: null },
  { label: 'Clamped Auto', action: 'clampedAuto' },
  { label: 'Auto', action: 'auto' },
  { label: 'Free Smooth', action: 'freeSmooth' },
  { label: 'Flat', action: 'flat' },
  { label: 'Broken', action: 'broken' },
  { label: '', action: null },
  { label: 'Left Tangent/Free', action: 'leftFree' },
  { label: 'Left Tangent/Linear', action: 'leftLinear' },
  { label: 'Left Tangent/Constant', action: 'leftConstant' },
  { label: 'Left Tangent/Weighted', action: 'leftWeighted' },
  { label: 'Right Tangent/Free', action: 'rightFree' },
  { label: 'Right Tangent/Linear', action: 'rightLinear' },
  { label: 'Right Tangent/Constant', action: 'rightConstant' },
  { label: 'Right Tangent/Weighted', action: 'rightWeighted' },
  { label: 'Both Tangents/Free', action: 'bothFree' },
  { label: 'Both Tangents/Linear', action: 'bothLinear' },
  { label: 'Both Tangents/Constant', action: 'bothConstant' },
  { label: 'Both Tangents/Weighted', action: 'bothWeighted' }
]

export function tangentState(k: TunerCurveKey): Record<TangentAction, boolean> {
  const l = leftMode(k)
  const r = rightMode(k)
  const broken = k.broken === true
  const lw = (k.weightedMode & WEIGHTED.in) !== 0
  const rw = (k.weightedMode & WEIGHTED.out) !== 0
  return {
    clampedAuto: l === TANGENT.clampedAuto && r === TANGENT.clampedAuto,
    auto: l === TANGENT.auto && r === TANGENT.auto,
    freeSmooth: !broken && l === TANGENT.free && r === TANGENT.free,
    flat: !broken && l === TANGENT.free && r === TANGENT.free && k.inTangent === 0 && k.outTangent === 0,
    broken,
    leftFree: broken && l === TANGENT.free,
    leftLinear: broken && l === TANGENT.linear,
    leftConstant: broken && l === TANGENT.constant,
    leftWeighted: lw,
    rightFree: broken && r === TANGENT.free,
    rightLinear: broken && r === TANGENT.linear,
    rightConstant: broken && r === TANGENT.constant,
    rightWeighted: rw,
    bothFree: broken && l === TANGENT.free && r === TANGENT.free,
    bothLinear: broken && l === TANGENT.linear && r === TANGENT.linear,
    bothConstant: broken && l === TANGENT.constant && r === TANGENT.constant,
    bothWeighted: lw && rw
  }
}

function smooth(k: TunerCurveKey): number {
  const i = Number.isFinite(k.inTangent) ? k.inTangent : 0
  const o = Number.isFinite(k.outTangent) ? k.outTangent : 0
  return (i + o) * 0.5
}

export function applyTangentAction(curve: TunerCurve, index: number, action: TangentAction): TunerCurve {
  const keys = curve.keys.map((k) => ({ ...k }))
  const k = keys[index]
  if (!k) return curve
  const on = tangentState(k)
  const setBoth = (mode: number, broken: boolean): void => {
    k.left = mode
    k.right = mode
    k.broken = broken
  }
  const freeLeftFromAuto = (): void => {
    if (isAuto(leftMode(k))) k.left = TANGENT.free
  }
  const freeRightFromAuto = (): void => {
    if (isAuto(rightMode(k))) k.right = TANGENT.free
  }
  switch (action) {
    case 'clampedAuto':
      setBoth(TANGENT.clampedAuto, false)
      break
    case 'auto':
      setBoth(TANGENT.auto, false)
      break
    case 'freeSmooth': {
      const s = smooth(k)
      setBoth(TANGENT.free, false)
      k.inTangent = s
      k.outTangent = s
      break
    }
    case 'flat':
      setBoth(TANGENT.free, false)
      k.inTangent = 0
      k.outTangent = 0
      break
    case 'broken':
      k.broken = true
      freeLeftFromAuto()
      freeRightFromAuto()
      break
    case 'leftFree':
    case 'leftLinear':
    case 'leftConstant':
      k.broken = true
      freeRightFromAuto()
      k.left = action === 'leftFree' ? TANGENT.free : action === 'leftLinear' ? TANGENT.linear : TANGENT.constant
      if (action === 'leftFree' && !Number.isFinite(k.inTangent)) k.inTangent = 0
      break
    case 'rightFree':
    case 'rightLinear':
    case 'rightConstant':
      k.broken = true
      freeLeftFromAuto()
      k.right = action === 'rightFree' ? TANGENT.free : action === 'rightLinear' ? TANGENT.linear : TANGENT.constant
      if (action === 'rightFree' && !Number.isFinite(k.outTangent)) k.outTangent = 0
      break
    case 'bothFree':
    case 'bothLinear':
    case 'bothConstant': {
      const mode = action === 'bothFree' ? TANGENT.free : action === 'bothLinear' ? TANGENT.linear : TANGENT.constant
      setBoth(mode, true)
      if (mode === TANGENT.free) {
        if (!Number.isFinite(k.inTangent)) k.inTangent = 0
        if (!Number.isFinite(k.outTangent)) k.outTangent = 0
      }
      break
    }
    case 'leftWeighted':
      k.weightedMode = on.leftWeighted ? k.weightedMode & ~WEIGHTED.in : k.weightedMode | WEIGHTED.in
      freeLeftFromAuto()
      break
    case 'rightWeighted':
      k.weightedMode = on.rightWeighted ? k.weightedMode & ~WEIGHTED.out : k.weightedMode | WEIGHTED.out
      freeRightFromAuto()
      break
    case 'bothWeighted':
      k.weightedMode = on.bothWeighted ? WEIGHTED.none : WEIGHTED.both
      freeLeftFromAuto()
      freeRightFromAuto()
      break
  }
  if ((k.weightedMode & WEIGHTED.in) !== 0 && !(k.inWeight > 0)) k.inWeight = DEFAULT_WEIGHT
  if ((k.weightedMode & WEIGHTED.out) !== 0 && !(k.outWeight > 0)) k.outWeight = DEFAULT_WEIGHT
  return { ...curve, keys: updateTangents(keys) }
}

export function dragTangent(curve: TunerCurve, index: number, side: 'in' | 'out', dt: number, dv: number): TunerCurve {
  const keys = curve.keys.map((k) => ({ ...k }))
  const k = keys[index]
  if (!k) return curve
  const neighbor = side === 'in' ? keys[index - 1] : keys[index + 1]
  const span = neighbor ? Math.abs(neighbor.time - k.time) : 1
  const tx = side === 'in' ? Math.min(-1e-6, dt) : Math.max(1e-6, dt)
  const m = dv / tx
  const weighted = side === 'in' ? (k.weightedMode & WEIGHTED.in) !== 0 : (k.weightedMode & WEIGHTED.out) !== 0
  if (isAuto(leftMode(k)) || isAuto(rightMode(k))) {
    k.left = TANGENT.free
    k.right = TANGENT.free
  }
  if (side === 'in') {
    k.left = TANGENT.free
    k.inTangent = m
    if (weighted && span > 0) k.inWeight = Math.max(0.01, Math.min(1, Math.abs(tx) / span))
    if (!k.broken) {
      k.outTangent = m
      k.right = TANGENT.free
    }
  } else {
    k.right = TANGENT.free
    k.outTangent = m
    if (weighted && span > 0) k.outWeight = Math.max(0.01, Math.min(1, Math.abs(tx) / span))
    if (!k.broken) {
      k.inTangent = m
      k.left = TANGENT.free
    }
  }
  return { ...curve, keys: updateTangents(keys) }
}

export function curveBounds(curve: TunerCurve, ranges?: { x: number; y: number; w: number; h: number }): Bounds {
  if (ranges && ranges.w > 0 && ranges.h > 0) return { tMin: ranges.x, tMax: ranges.x + ranges.w, vMin: ranges.y, vMax: ranges.y + ranges.h }
  const keys = curve.keys
  if (keys.length === 0) return { tMin: 0, tMax: 1, vMin: 0, vMax: 1 }
  let tMin = keys[0].time
  let tMax = keys[keys.length - 1].time
  let vMin = Infinity
  let vMax = -Infinity
  const steps = 64
  for (let i = 0; i <= steps; i++) {
    const v = evaluate(curve, tMin + ((tMax - tMin) * i) / steps)
    if (v < vMin) vMin = v
    if (v > vMax) vMax = v
  }
  for (const k of keys) {
    vMin = Math.min(vMin, k.value)
    vMax = Math.max(vMax, k.value)
  }
  if (tMax - tMin < 1e-4) {
    tMin -= 0.5
    tMax += 0.5
  }
  if (vMax - vMin < 1e-4) {
    vMin -= 0.5
    vMax += 0.5
  }
  return { tMin, tMax, vMin, vMax }
}

export function clampToRanges(time: number, value: number, ranges?: { x: number; y: number; w: number; h: number }): [number, number] {
  if (!ranges || ranges.w <= 0 || ranges.h <= 0) return [time, value]
  return [Math.max(ranges.x, Math.min(ranges.x + ranges.w, time)), Math.max(ranges.y, Math.min(ranges.y + ranges.h, value))]
}

export function niceStep(span: number, pixels: number, minPx = 40): number {
  if (!(span > 0) || !(pixels > 0)) return 1
  const raw = (span * minPx) / pixels
  const p = Math.pow(10, Math.floor(Math.log10(raw)))
  for (const m of [1, 2, 5, 10]) if (m * p >= raw) return m * p
  return 10 * p
}

function key(time: number, value: number, inTangent: number, outTangent: number, mode: number): TunerCurveKey {
  return { time, value, inTangent, outTangent, inWeight: 0, outWeight: 0, weightedMode: 0, left: mode, right: mode, broken: false }
}

export interface CurvePreset {
  name: string
  keys: TunerCurveKey[]
}

export function curvePresets(signed: boolean): CurvePreset[] {
  const list: CurvePreset[] = [
    { name: 'Constant', keys: [key(0, 1, 0, 0, TANGENT.auto), key(1, 1, 0, 0, TANGENT.auto)] },
    { name: 'Linear', keys: [key(0, 0, 1, 1, TANGENT.auto), key(1, 1, 1, 1, TANGENT.auto)] },
    { name: 'Ease In', keys: [key(0, 0, 0, 0, TANGENT.free), key(1, 1, 2, 2, TANGENT.free)] },
    { name: 'Ease Out', keys: [key(0, 0, 2, 2, TANGENT.free), key(1, 1, 0, 0, TANGENT.free)] },
    { name: 'Ease In Out', keys: [key(0, 0, 0, 0, TANGENT.free), key(1, 1, 0, 0, TANGENT.free)] }
  ]
  if (signed) {
    list.push(
      { name: 'Linear Down', keys: [key(0, 1, -1, -1, TANGENT.auto), key(1, 0, -1, -1, TANGENT.auto)] },
      { name: 'Ease In Down', keys: [key(0, 1, -2, -2, TANGENT.free), key(1, 0, 0, 0, TANGENT.free)] },
      { name: 'Ease Out Down', keys: [key(0, 1, 0, 0, TANGENT.free), key(1, 0, -2, -2, TANGENT.free)] }
    )
  }
  return list
}

export function applyPreset(curve: TunerCurve, preset: CurvePreset, ranges?: { x: number; y: number; w: number; h: number }): TunerCurve {
  const r = ranges && ranges.w > 0 && ranges.h > 0 ? ranges : { x: 0, y: 0, w: 1, h: 1 }
  const sx = r.w
  const sy = r.h
  const keys = preset.keys.map((k) => ({
    ...k,
    time: r.x + k.time * sx,
    value: r.y + k.value * sy,
    inTangent: (k.inTangent * sy) / sx,
    outTangent: (k.outTangent * sy) / sx
  }))
  return { ...curve, keys: updateTangents(keys) }
}

export function encodeCurve(curve: TunerCurve): TunerCurve {
  const f = (v: number): number => (v === Infinity ? 1e38 : v === -Infinity ? -1e38 : Number.isFinite(v) ? v : 0)
  return {
    preWrapMode: curve.preWrapMode,
    postWrapMode: curve.postWrapMode,
    keys: curve.keys.map((k) => ({ ...k, inTangent: f(k.inTangent), outTangent: f(k.outTangent) }))
  }
}

export function decodeCurve(curve: TunerCurve): TunerCurve {
  const f = (v: number): number => (typeof v !== 'number' ? 0 : v >= 1e37 ? Infinity : v <= -1e37 ? -Infinity : v)
  return {
    preWrapMode: curve.preWrapMode ?? WRAP.clampForever,
    postWrapMode: curve.postWrapMode ?? WRAP.clampForever,
    keys: sortKeys((curve.keys ?? []).map((k) => ({ ...k, inTangent: f(k.inTangent), outTangent: f(k.outTangent) })))
  }
}
