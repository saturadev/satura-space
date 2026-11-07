import type { TunerColor } from '@shared/tuner-inspector-popups'

export type Rgb = [number, number, number]
export type Rgba4 = [number, number, number, number]

const MAX_OVEREXPOSED_BYTE = 191

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

export function toByte(v: number): number {
  return Math.round(clamp01(v) * 255)
}

function rgbToHsv(r: number, g: number, b: number): Rgb {
  const helper = (offset: number, dominant: number, one: number, two: number): Rgb => {
    const v = dominant
    if (v === 0) return [0, 0, 0]
    const small = Math.min(one, two)
    const diff = v - small
    let h: number
    let s: number
    if (diff !== 0) {
      s = diff / v
      h = offset + (one - two) / diff
    } else {
      s = 0
      h = offset + (one - two)
    }
    h /= 6
    if (h < 0) h += 1
    return [h, s, v]
  }
  if (b > g && b > r) return helper(4, b, r, g)
  if (g > r) return helper(2, g, b, r)
  return helper(0, r, g, b)
}

export function hsvToRgb(h: number, s: number, v: number, hdr = false): Rgb {
  let out: Rgb
  if (s === 0) out = [v, v, v]
  else if (v === 0) out = [0, 0, 0]
  else {
    const hf = h * 6
    const temp = Math.floor(hf)
    const t = hf - temp
    const var1 = v * (1 - s)
    const var2 = v * (1 - s * t)
    const var3 = v * (1 - s * (1 - t))
    switch (temp) {
      case 0:
        out = [v, var3, var1]
        break
      case 1:
        out = [var2, v, var1]
        break
      case 2:
        out = [var1, v, var3]
        break
      case 3:
        out = [var1, var2, v]
        break
      case 4:
        out = [var3, var1, v]
        break
      case 5:
        out = [v, var1, var2]
        break
      case 6:
        out = [v, var3, var1]
        break
      case -1:
        out = [v, var1, var2]
        break
      default:
        out = [v, v, v]
    }
  }
  return hdr ? out : [clamp01(out[0]), clamp01(out[1]), clamp01(out[2])]
}

export function linearToGamma(v: number): number {
  if (v <= 0) return 0
  if (v <= 0.0031308) return 12.92 * v
  if (v < 1) return 1.055 * Math.pow(v, 1 / 2.4) - 0.055
  return Math.pow(v, 1 / 2.2)
}

export function gammaToLinear(v: number): number {
  if (v <= 0.04045) return v / 12.92
  if (v < 1) return Math.pow((v + 0.055) / 1.055, 2.4)
  return Math.pow(v, 2.2)
}

export function maxComponent(c: { r: number; g: number; b: number }): number {
  return Math.max(c.r, c.g, c.b)
}

function decomposeHdr(c: { r: number; g: number; b: number }): { base: Rgb; exposure: number } {
  const max = maxComponent(c)
  if (max === 0 || (max <= 1 && max >= 1 / 255)) {
    return { base: [Math.round(c.r * 255), Math.round(c.g * 255), Math.round(c.b * 255)], exposure: 0 }
  }
  const scale = MAX_OVEREXPOSED_BYTE / max
  const exposure = Math.log(255 / scale) / Math.log(2)
  const up = (v: number): number => Math.min(MAX_OVEREXPOSED_BYTE, Math.max(0, Math.min(255, Math.ceil(scale * v))))
  return { base: [up(c.r), up(c.g), up(c.b)], exposure }
}

export interface ColorState {
  original: TunerColor
  bytes: Rgba4
  hdr: Rgba4
  hsv: Rgb
  exposure: number
  baseExposure: number
  hdrBase: Rgba4
}

function safe(v: number): number {
  if (Number.isNaN(v) || v === Infinity) return 3.4e38
  if (v === -Infinity) return -3.4e38
  return v
}

function withHdrChannel(st: ColorState, channel: number): ColorState {
  const bytes: Rgba4 = [...st.bytes]
  bytes[3] = toByte(st.hdr[3])
  if (channel === 3) return { ...st, bytes }
  const d = decomposeHdr({ r: st.hdr[0], g: st.hdr[1], b: st.hdr[2] })
  bytes[0] = d.base[0]
  bytes[1] = d.base[1]
  bytes[2] = d.base[2]
  return { ...st, bytes, exposure: d.exposure, hsv: rgbToHsv(bytes[0] / 255, bytes[1] / 255, bytes[2] / 255) }
}

export function colorState(original: TunerColor, hdr = true): ColorState {
  const h: Rgba4 = [original.r, original.g, original.b, original.a]
  let st: ColorState = {
    original,
    bytes: [0, 0, 0, 0],
    hdr: h,
    hsv: [0, 0, 0],
    exposure: 0,
    baseExposure: 0,
    hdrBase: [...h]
  }
  st = withHdrChannel(st, -1)
  st = { ...st, baseExposure: st.exposure }
  return hdr ? st : setExposure(st, 0)
}

export function setExposure(st: ColorState, value: number): ColorState {
  if (Math.abs(st.exposure - value) < 1e-6) return st
  const k = Math.pow(2, value - st.baseExposure)
  const hdr: Rgba4 = [safe(st.hdrBase[0] * k), safe(st.hdrBase[1] * k), safe(st.hdrBase[2] * k), st.hdr[3]]
  return { ...st, exposure: value, hdr }
}

export function setByte(st: ColorState, channel: number, value: number): ColorState {
  const b = Math.max(0, Math.min(255, Math.round(value)))
  if (st.bytes[channel] === b) return st
  const bytes: Rgba4 = [...st.bytes]
  bytes[channel] = b
  const hdr: Rgba4 = [...st.hdr]
  hdr[channel] = b / 255
  if (channel !== 3) hdr[channel] *= Math.pow(2, st.exposure)
  return { ...st, bytes, hdr, hdrBase: [...hdr], hsv: rgbToHsv(bytes[0] / 255, bytes[1] / 255, bytes[2] / 255) }
}

export function setHdrChannel(st: ColorState, channel: number, value: number): ColorState {
  if (Math.abs(st.hdr[channel] - value) < 1e-7) return st
  const hdr: Rgba4 = [...st.hdr]
  hdr[channel] = value
  const next = withHdrChannel({ ...st, hdr, hdrBase: [...hdr] }, channel)
  return { ...next, baseExposure: next.exposure }
}

export function setHsv(st: ColorState, channel: number, value: number): ColorState {
  const hsv: Rgb = [...st.hsv]
  hsv[channel] = clamp01(value)
  const rgb = hsvToRgb(hsv[0], hsv[1], hsv[2], true)
  const bytes: Rgba4 = [Math.ceil(rgb[0] * 255), Math.ceil(rgb[1] * 255), Math.ceil(rgb[2] * 255), st.bytes[3]]
  const k = Math.pow(2, st.exposure)
  const hdr: Rgba4 = [rgb[0] * k, rgb[1] * k, rgb[2] * k, st.hdr[3]]
  return { ...st, hsv, bytes, hdr, hdrBase: [...hdr] }
}

export function setHsv2(st: ColorState, s: number, v: number): ColorState {
  return setHsv(setHsv(st, 1, s), 2, v)
}

export function setRgbHdr(st: ColorState, c: { r: number; g: number; b: number; a?: number }): ColorState {
  let next = setHdrChannel(st, 0, c.r)
  next = setHdrChannel(next, 1, c.g)
  next = setHdrChannel(next, 2, c.b)
  if (c.a !== undefined) next = setHdrChannel(next, 3, c.a)
  return next
}

export function resetState(st: ColorState, hdr: boolean): ColorState {
  return colorState(st.original, hdr)
}

export function stateColor(st: ColorState): TunerColor {
  return { r: st.hdr[0], g: st.hdr[1], b: st.hdr[2], a: st.hdr[3] }
}

export function hexOf(bytes: ArrayLike<number>, alpha: boolean): string {
  const h = (n: number): string => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0').toUpperCase()
  return h(bytes[0]) + h(bytes[1]) + h(bytes[2]) + (alpha ? h(bytes[3]) : '')
}

export function parseHex(text: string): Rgba4 | null {
  const s = text.trim().replace(/^#/, '')
  if (!/^[0-9a-f]+$/i.test(s)) return null
  const n = (i: number, len: number): number => {
    const part = s.slice(i, i + len)
    return len === 1 ? parseInt(part + part, 16) : parseInt(part, 16)
  }
  switch (s.length) {
    case 3:
      return [n(0, 1), n(1, 1), n(2, 1), 255]
    case 4:
      return [n(0, 1), n(1, 1), n(2, 1), n(3, 1)]
    case 6:
      return [n(0, 2), n(2, 2), n(4, 2), 255]
    case 8:
      return [n(0, 2), n(2, 2), n(4, 2), n(6, 2)]
    default:
      return null
  }
}

export function setHex(st: ColorState, text: string, alpha: boolean): ColorState | null {
  const p = parseHex(text)
  if (!p) return null
  let next = setByte(st, 0, p[0])
  next = setByte(next, 1, p[1])
  next = setByte(next, 2, p[2])
  if (alpha && text.trim().replace(/^#/, '').length % 4 === 0) next = setByte(next, 3, p[3])
  return next
}

export function displayRgb(c: { r: number; g: number; b: number }, linear: boolean): Rgb {
  const f = (v: number): number => Math.round(clamp01(linear ? linearToGamma(v) : v) * 255)
  return [f(c.r), f(c.g), f(c.b)]
}

export function cssColor(c: TunerColor, linear: boolean, withAlpha = true): string {
  const [r, g, b] = displayRgb(c, linear)
  return withAlpha ? `rgba(${r}, ${g}, ${b}, ${Math.round(clamp01(c.a) * 1000) / 1000})` : `rgb(${r}, ${g}, ${b})`
}

export function round(v: number, digits = 3): number {
  const k = Math.pow(10, digits)
  return Math.round(v * k) / k
}
