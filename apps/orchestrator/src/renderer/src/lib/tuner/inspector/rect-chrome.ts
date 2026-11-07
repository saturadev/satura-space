import type { TiDrawRole, TiMatrix } from '@shared/tuner-inspector'

export function shiftMatrix(m: TiMatrix, dx: number, dy: number): TiMatrix {
  const [a, b, c, d, e, f] = m
  if (!dx && !dy) return m
  return [a, b, c, d, e + a * dx + c * dy - dx, f + b * dx + d * dy - dy]
}

export function cssMatrix(m: TiMatrix): string {
  return `matrix(${m.map((v) => (Math.abs(v) < 1e-6 ? 0 : +v.toFixed(5))).join(',')})`
}

const ROLE_COLORS: Record<TiDrawRole, string> = {
  band: 'var(--sunken)',
  line: 'var(--strong)',
  parent: 'var(--ink-4)',
  self: 'var(--ink-2)',
  sel: 'var(--accent)',
  frame: 'var(--ink-3)'
}

export function roleColor(role: TiDrawRole): string {
  return ROLE_COLORS[role]
}

export function roleOpacity(role: TiDrawRole, alpha: number): number {
  if (role === 'band' || role === 'line') return 1
  return Math.max(0, Math.min(1, alpha))
}

export function segmentRadius(styleName: string, r = 3): string | undefined {
  const k = styleName.toLowerCase().replace(/[\s_-]+/g, '')
  if (!/button/.test(k)) return undefined
  if (k.endsWith('left')) return `${r}px 0 0 ${r}px`
  if (k.endsWith('right')) return `0 ${r}px ${r}px 0`
  if (k.endsWith('mid')) return '0'
  return undefined
}

export function isMaskIcon(textureName: string | undefined): boolean {
  return !!textureName && /^(d_)?RectTransform(Blueprint|Raw)(@\dx)?$/.test(textureName)
}

export interface NineSlice {
  slice: [number, number, number, number]
  width: [number, number, number, number]
}

export function nineSlice(border: [number, number, number, number], scale: number, texW: number, texH: number): NineSlice {
  const [l, r, t, b] = border
  let sl = l * scale
  let sr = r * scale
  let st = t * scale
  let sb = b * scale
  let wl = l
  let wr = r
  let wt = t
  let wb = b
  if (texW > 1 && sl + sr >= texW && sl < texW) {
    const nr = Math.max(0, texW - sl - 1)
    wr = Math.max(0, wr - (sr - nr) / scale)
    sr = nr
  }
  if (texH > 1 && st + sb >= texH && st < texH) {
    const nb = Math.max(0, texH - st - 1)
    wb = Math.max(0, wb - (sb - nb) / scale)
    sb = nb
  }
  return { slice: [st, sr, sb, sl], width: [wt, wr, wb, wl] }
}
