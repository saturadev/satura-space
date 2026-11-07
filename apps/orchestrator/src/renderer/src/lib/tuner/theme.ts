import type { Rgb, TunerTheme } from '@shared/tuner-sceneview'

export const CHILD_OUTLINE_MIX = 0.45

const HEX_RE = /^#([0-9a-f]{3,8})$/i
const RGB_RE = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i

export function parseCssColor(raw: string): Rgb | null {
  const s = raw.trim()
  const hex = HEX_RE.exec(s)
  if (hex) {
    let h = hex[1]
    if (h.length === 3 || h.length === 4) h = h.slice(0, 3).replace(/./g, (c) => c + c)
    else if (h.length === 8) h = h.slice(0, 6)
    else if (h.length !== 6) return null
    const n = parseInt(h, 16)
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
  }
  const rgb = RGB_RE.exec(s)
  if (rgb) {
    const v = [rgb[1], rgb[2], rgb[3]].map((x) => Math.max(0, Math.min(255, parseFloat(x))) / 255)
    return v.every((x) => Number.isFinite(x)) ? (v as Rgb) : null
  }
  return null
}

export function mixRgb(a: Rgb, b: Rgb, t: number): Rgb {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
}

export function rgbCss(c: Rgb): string {
  const h = (v: number): string => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0')
  return `#${h(c[0])}${h(c[1])}${h(c[2])}`
}

export function themeFromTokens(get: (name: string) => string): TunerTheme | null {
  const clear = parseCssColor(get('--sunken')) ?? parseCssColor(get('--canvas'))
  const grid = parseCssColor(get('--grid-line'))
  const outline = parseCssColor(get('--accent'))
  if (!clear || !grid || !outline) return null
  return { clear, grid, outline, outlineChild: mixRgb(outline, clear, CHILD_OUTLINE_MIX) }
}

function normalize(value: string): string {
  const v = value.trim()
  if (!v || HEX_RE.test(v) || RGB_RE.test(v) || typeof document === 'undefined') return v
  const ctx = document.createElement('canvas').getContext('2d')
  if (!ctx) return v
  ctx.fillStyle = '#000000'
  ctx.fillStyle = v
  return String(ctx.fillStyle)
}

export function readTunerTheme(el: Element = document.documentElement): TunerTheme | null {
  const style = getComputedStyle(el)
  return themeFromTokens((name) => normalize(style.getPropertyValue(name)))
}

export function readCssRgb(name: string, el: Element = document.documentElement): [number, number, number] | null {
  const c = parseCssColor(normalize(getComputedStyle(el).getPropertyValue(name)))
  return c ? [Math.round(c[0] * 255), Math.round(c[1] * 255), Math.round(c[2] * 255)] : null
}

export function sameTheme(a: TunerTheme | null, b: TunerTheme | null): boolean {
  if (!a || !b) return a === b
  const keys: (keyof TunerTheme)[] = ['clear', 'grid', 'outline', 'outlineChild']
  return keys.every((k) => a[k].every((v, i) => Math.abs(v - b[k][i]) < 1e-4))
}

export function watchTheme(cb: () => void): () => void {
  const root = document.documentElement
  const mo = new MutationObserver(cb)
  mo.observe(root, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] })
  return () => mo.disconnect()
}
