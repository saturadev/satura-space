import { GRADIENT_MODE, type TunerColor, type TunerGradient } from '@shared/tuner-inspector-popups'
import { clamp01, gammaToLinear, linearToGamma } from './color-math'

export const MAX_GRADIENT_KEYS = 8
export const COLOR_SPACE = { uninitialized: -1, gamma: 0, linear: 1 } as const

type Rgb = [number, number, number]

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

export function linearRgbToOklab([r, g, b]: Rgb): Rgb {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  ]
}

export function oklabToLinearRgb([L, a, b]: Rgb): Rgb {
  const l = Math.pow(L + 0.3963377774 * a + 0.2158037573 * b, 3)
  const m = Math.pow(L - 0.1055613458 * a - 0.0638541728 * b, 3)
  const s = Math.pow(L - 0.0894841775 * a - 1.291485548 * b, 3)
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s
  ]
}

export function keysAreLinear(g: TunerGradient): boolean {
  return g.colorSpace === COLOR_SPACE.linear
}

function segment<T extends { time: number }>(keys: T[], t: number): { a: T; b: T; u: number } {
  if (t <= keys[0].time) return { a: keys[0], b: keys[0], u: 0 }
  const last = keys[keys.length - 1]
  if (t >= last.time) return { a: last, b: last, u: 0 }
  let i = 0
  while (i < keys.length - 2 && keys[i + 1].time < t) i++
  const a = keys[i]
  const b = keys[i + 1]
  const span = b.time - a.time
  return { a, b, u: span > 0 ? (t - a.time) / span : 0 }
}

function fixedPick<T extends { time: number }>(keys: T[], t: number): T {
  for (const k of keys) if (t <= k.time) return k
  return keys[keys.length - 1]
}

export function evaluateGradient(g: TunerGradient, t: number): TunerColor {
  const colors = [...g.colorKeys].sort((x, y) => x.time - y.time)
  const alphas = [...g.alphaKeys].sort((x, y) => x.time - y.time)
  let rgb: Rgb = [1, 1, 1]
  if (colors.length > 0) {
    if (g.mode === GRADIENT_MODE.fixed) {
      const c = fixedPick(colors, t).color
      rgb = [c.r, c.g, c.b]
    } else {
      const { a, b, u } = segment(colors, t)
      if (g.mode === GRADIENT_MODE.perceptual && a !== b) {
        const lin = keysAreLinear(g)
        const toLin = (c: TunerColor): Rgb => (lin ? [c.r, c.g, c.b] : [gammaToLinear(c.r), gammaToLinear(c.g), gammaToLinear(c.b)])
        const la = linearRgbToOklab(toLin(a.color))
        const lb = linearRgbToOklab(toLin(b.color))
        const mixed = oklabToLinearRgb([lerp(la[0], lb[0], u), lerp(la[1], lb[1], u), lerp(la[2], lb[2], u)])
        rgb = lin ? mixed : [linearToGamma(Math.max(0, mixed[0])), linearToGamma(Math.max(0, mixed[1])), linearToGamma(Math.max(0, mixed[2]))]
      } else {
        rgb = [lerp(a.color.r, b.color.r, u), lerp(a.color.g, b.color.g, u), lerp(a.color.b, b.color.b, u)]
      }
    }
  }
  let alpha = 1
  if (alphas.length > 0) {
    if (g.mode === GRADIENT_MODE.fixed) alpha = fixedPick(alphas, t).alpha
    else {
      const { a, b, u } = segment(alphas, t)
      alpha = lerp(a.alpha, b.alpha, u)
    }
  }
  return { r: rgb[0], g: rgb[1], b: rgb[2], a: alpha }
}

export function displayOf(c: TunerColor, linear: boolean): string {
  const f = (v: number): number => Math.round(clamp01(linear ? linearToGamma(v) : v) * 255)
  return `rgba(${f(c.r)}, ${f(c.g)}, ${f(c.b)}, ${Math.round(clamp01(c.a) * 1000) / 1000})`
}

export function gradientCss(g: TunerGradient, opaque = false, steps = 48): string {
  const linear = keysAreLinear(g)
  const stops: string[] = []
  if (g.mode === GRADIENT_MODE.fixed) {
    const times = new Set<number>([0, 1])
    for (const k of g.colorKeys) times.add(clamp01(k.time))
    for (const k of g.alphaKeys) times.add(clamp01(k.time))
    const sorted = [...times].sort((a, b) => a - b)
    let prev = 0
    for (const t of sorted) {
      if (t <= prev && t !== 0) continue
      const c = evaluateGradient(g, t)
      const css = displayOf(opaque ? { ...c, a: 1 } : c, linear)
      stops.push(`${css} ${(prev * 100).toFixed(2)}%`, `${css} ${(t * 100).toFixed(2)}%`)
      prev = t
    }
    return `linear-gradient(to right, ${stops.join(', ')})`
  }
  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    const c = evaluateGradient(g, t)
    stops.push(`${displayOf(opaque ? { ...c, a: 1 } : c, linear)} ${(t * 100).toFixed(2)}%`)
  }
  return `linear-gradient(to right, ${stops.join(', ')})`
}

export function maxColorComponent(g: TunerGradient): number {
  let m = 0
  for (const k of g.colorKeys) m = Math.max(m, k.color.r, k.color.g, k.color.b)
  return m
}

export function addColorKey(g: TunerGradient, time: number): { gradient: TunerGradient; index: number } | null {
  if (g.colorKeys.length >= MAX_GRADIENT_KEYS) return null
  const t = clamp01(time)
  const c = evaluateGradient(g, t)
  const key = { color: { r: c.r, g: c.g, b: c.b, a: 1 }, time: t }
  const colorKeys = [...g.colorKeys, key].sort((a, b) => a.time - b.time)
  return { gradient: { ...g, colorKeys }, index: colorKeys.indexOf(key) }
}

export function addAlphaKey(g: TunerGradient, time: number): { gradient: TunerGradient; index: number } | null {
  if (g.alphaKeys.length >= MAX_GRADIENT_KEYS) return null
  const t = clamp01(time)
  const key = { alpha: evaluateGradient(g, t).a, time: t }
  const alphaKeys = [...g.alphaKeys, key].sort((a, b) => a.time - b.time)
  return { gradient: { ...g, alphaKeys }, index: alphaKeys.indexOf(key) }
}

export function removeKey(g: TunerGradient, alpha: boolean, index: number): TunerGradient {
  if (alpha) return g.alphaKeys.length <= 1 ? g : { ...g, alphaKeys: g.alphaKeys.filter((_, i) => i !== index) }
  return g.colorKeys.length <= 1 ? g : { ...g, colorKeys: g.colorKeys.filter((_, i) => i !== index) }
}

export function moveKey(g: TunerGradient, alpha: boolean, index: number, time: number): { gradient: TunerGradient; index: number } {
  const t = clamp01(time)
  if (alpha) {
    const moved = { ...g.alphaKeys[index], time: t }
    const alphaKeys = g.alphaKeys.map((k, i) => (i === index ? moved : k)).sort((a, b) => a.time - b.time)
    return { gradient: { ...g, alphaKeys }, index: alphaKeys.indexOf(moved) }
  }
  const moved = { ...g.colorKeys[index], time: t }
  const colorKeys = g.colorKeys.map((k, i) => (i === index ? moved : k)).sort((a, b) => a.time - b.time)
  return { gradient: { ...g, colorKeys }, index: colorKeys.indexOf(moved) }
}

export interface GradientPreset {
  name: string
  gradient: TunerGradient
}

function preset(name: string, colors: [number, number, number, number][], alphas: [number, number][]): GradientPreset {
  return {
    name,
    gradient: {
      mode: GRADIENT_MODE.blend,
      colorSpace: COLOR_SPACE.uninitialized,
      colorKeys: colors.map(([r, g, b, time]) => ({ color: { r, g, b, a: 1 }, time })),
      alphaKeys: alphas.map(([alpha, time]) => ({ alpha, time }))
    }
  }
}

export const GRADIENT_PRESETS: GradientPreset[] = [
  preset('White', [[1, 1, 1, 0], [1, 1, 1, 1]], [[1, 0], [1, 1]]),
  preset('Fade out', [[1, 1, 1, 0], [1, 1, 1, 1]], [[1, 0], [0, 1]]),
  preset('Fade in', [[1, 1, 1, 0], [1, 1, 1, 1]], [[0, 0], [1, 1]]),
  preset('Black to white', [[0, 0, 0, 0], [1, 1, 1, 1]], [[1, 0], [1, 1]]),
  preset('Fire', [[1, 0.93, 0.5, 0], [1, 0.45, 0.05, 0.5], [0.35, 0.02, 0.02, 1]], [[1, 0], [1, 0.6], [0, 1]]),
  preset('Rainbow', [[1, 0, 0, 0], [1, 1, 0, 0.2], [0, 1, 0, 0.4], [0, 1, 1, 0.6], [0, 0, 1, 0.8], [1, 0, 1, 1]], [[1, 0], [1, 1]])
]

export function applyGradientPreset(g: TunerGradient, p: GradientPreset): TunerGradient {
  const lin = keysAreLinear(g)
  return {
    ...p.gradient,
    colorSpace: g.colorSpace,
    colorKeys: p.gradient.colorKeys.map((k) =>
      lin ? { ...k, color: { r: gammaToLinear(k.color.r), g: gammaToLinear(k.color.g), b: gammaToLinear(k.color.b), a: 1 } } : k
    )
  }
}
