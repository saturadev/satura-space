export interface FrRect {
  x: number
  y: number
  w: number
  h: number
}

export interface FrInsets {
  t: number
  r: number
  b: number
  l: number
}

export interface FrIn {
  w: number
  h: number
  vw: number
  vh: number
  safe?: FrInsets
  panel?: boolean
  chrome?: boolean
}

export interface FrOut {
  orientation: 'portrait' | 'landscape'
  mode: 'below' | 'overlay'
  video: FrRect
  chrome: FrRect
  chromeAxis: 'row' | 'column'
  area: FrRect
  panel: FrRect | null
}

export const FR_CHROME = 40
export const FR_ICON = 34
const MIN_AREA = 200
const PANEL_MIN = 248
const PANEL_MAX = 340

function fit(vw: number, vh: number, box: FrRect): FrRect {
  const s = Math.min(box.w / vw, box.h / vh)
  const w = Math.max(0, vw * s)
  const h = Math.max(0, vh * s)
  return { x: box.x + (box.w - w) / 2, y: box.y + (box.h - h) / 2, w, h }
}

const round = (r: FrRect): FrRect => ({ x: Math.round(r.x * 10) / 10, y: Math.round(r.y * 10) / 10, w: Math.round(r.w * 10) / 10, h: Math.round(r.h * 10) / 10 })

export function frame(p: FrIn): FrOut {
  const C = p.chrome === false ? 0 : FR_CHROME
  const safe = p.safe ?? { t: 0, r: 0, b: 0, l: 0 }
  const vw = p.vw > 0 && p.vh > 0 ? p.vw : 16
  const vh = p.vw > 0 && p.vh > 0 ? p.vh : 9
  const landscape = p.w >= p.h
  const inner: FrRect = { x: safe.l, y: safe.t, w: Math.max(0, p.w - safe.l - safe.r), h: Math.max(0, p.h - safe.t - (landscape ? 0 : safe.b)) }
  if (landscape) {
    const pw = p.panel ? Math.min(PANEL_MAX, Math.max(PANEL_MIN, inner.w * 0.4), Math.max(0, inner.w - 160)) : 0
    const panel = p.panel ? { x: inner.x + inner.w - pw, y: inner.y, w: pw, h: inner.h } : null
    let avail: FrRect = { x: inner.x, y: inner.y, w: Math.max(0, inner.w - pw), h: inner.h }
    let video = fit(vw, vh, avail)
    const side = avail.x + avail.w - video.x - video.w
    const top = video.y - avail.y
    let chrome: FrRect
    let chromeAxis: 'row' | 'column' = 'column'
    if (side >= C) chrome = { x: video.x + video.w + (side - C) / 2, y: avail.y, w: C, h: avail.h }
    else if (top >= C) {
      chrome = { x: avail.x, y: avail.y + (top - C) / 2, w: avail.w, h: C }
      chromeAxis = 'row'
    } else {
      avail = { ...avail, h: Math.max(0, avail.h - C) }
      video = fit(vw, vh, avail)
      chrome = { x: avail.x, y: avail.y + avail.h, w: avail.w, h: C }
      chromeAxis = 'row'
    }
    return { orientation: 'landscape', mode: 'overlay', video: round(video), chrome: round(chrome), chromeAxis, area: round(avail), panel: panel && round(panel) }
  }
  const fullH = (inner.w * vh) / vw
  if (inner.h - fullH - C >= MIN_AREA) {
    const video: FrRect = { x: inner.x, y: inner.y, w: inner.w, h: fullH }
    const chrome: FrRect = { x: inner.x, y: video.y + video.h, w: inner.w, h: C }
    const area: FrRect = { x: inner.x, y: chrome.y + C, w: inner.w, h: inner.y + inner.h - chrome.y - C }
    const ph = Math.min(area.h, Math.max(Math.min(area.h, 280), area.h * 0.72))
    const panel = p.panel ? { x: area.x, y: area.y + area.h - ph, w: area.w, h: ph } : null
    return { orientation: 'portrait', mode: 'below', video: round(video), chrome: round(chrome), chromeAxis: 'row', area: round(area), panel: panel && round(panel) }
  }
  const chrome: FrRect = { x: inner.x, y: inner.y + inner.h - C, w: inner.w, h: C }
  const ph = p.panel ? Math.min(inner.h - C, Math.max(280, (inner.h - C) * 0.55)) : 0
  const panel = p.panel ? { x: inner.x, y: chrome.y - ph, w: inner.w, h: ph } : null
  const area: FrRect = { x: inner.x, y: inner.y, w: inner.w, h: Math.max(0, inner.h - C - ph) }
  return { orientation: 'portrait', mode: 'overlay', video: round(fit(vw, vh, area)), chrome: round(chrome), chromeAxis: 'row', area: round(area), panel: panel && round(panel) }
}

export function cluster(fr: { chrome: FrRect; chromeAxis: 'row' | 'column' }, n: number): FrRect {
  const c = fr.chrome
  const len = n * FR_ICON + Math.max(0, n - 1) * 4
  if (fr.chromeAxis === 'row') return { x: c.x + c.w - 8 - len, y: c.y + (c.h - FR_ICON) / 2, w: len, h: FR_ICON }
  return { x: c.x + (c.w - FR_ICON) / 2, y: c.y + 8, w: FR_ICON, h: len }
}

export function centerVideo(fr: FrOut, top: number): FrOut & { pad: FrRect; gaps: [number, number] | null } {
  if (fr.mode !== 'below') return { ...fr, pad: fr.area, gaps: null }
  const free = Math.min(top, fr.area.y + fr.area.h) - fr.area.y
  const dy = Math.max(0, Math.round(free * 5) / 10)
  const video = { ...fr.video, y: fr.video.y + dy }
  const chrome = { ...fr.chrome, y: fr.chrome.y + dy }
  const padY = chrome.y + chrome.h
  return { ...fr, video, chrome, pad: { ...fr.area, y: padY, h: fr.area.y + fr.area.h - padY }, gaps: [dy, Math.round((top - padY) * 10) / 10] }
}

export function overlaps(a: FrRect, b: FrRect, slack = 0.5): boolean {
  return a.x < b.x + b.w - slack && b.x < a.x + a.w - slack && a.y < b.y + b.h - slack && b.y < a.y + a.h - slack
}

export type FrKind = 'stick' | 'axis' | 'button'

export interface FrPlace {
  x?: number
  y?: number
  size?: number
}

export interface FrItem {
  id: string
  kind: FrKind
  place?: FrPlace | null
  pin?: boolean
}

export interface FrSpot {
  x: number
  y: number
  size: number
  cx: number
  cy: number
  rect: FrRect
  round: boolean
}

export interface FrLayout {
  spots: Record<string, FrSpot>
  overflow: string[]
  top: number
  D: number
  R: number
}

export const FR_SIZES = [0.7, 0.85, 1, 1.15, 1.3, 1.5, 1.75, 2]
const PRIMARY = 1.2

function units(area: { w: number; h: number }): { D: number; R: number; gap: number; pad: number } {
  const u = Math.min(area.w, area.h)
  const D = Math.min(70, Math.max(50, u * 0.16))
  return { D, R: Math.min(82, Math.max(50, u * 0.2)), gap: Math.max(8, D * 0.14), pad: Math.max(12, u * 0.04) }
}

export function footprint(kind: FrKind, size: number, area: { w: number; h: number }): { w: number; h: number } {
  const { D, R } = units(area)
  if (kind === 'stick') return { w: 2 * R * size, h: 2 * R * size }
  if (kind === 'axis') return { w: 2.1 * D * size, h: 0.86 * D * size }
  return { w: D * size, h: D * size }
}

function rectAt(cx: number, cy: number, f: { w: number; h: number }): FrRect {
  return { x: cx - f.w / 2, y: cy - f.h / 2, w: f.w, h: f.h }
}

function grow(r: FrRect, d: number): FrRect {
  return { x: r.x - d, y: r.y - d, w: r.w + 2 * d, h: r.h + 2 * d }
}

export interface FrShape {
  rect: FrRect
  round: boolean
}

function hits(a: FrShape, b: FrShape, gap: number): boolean {
  if (a.round && b.round) return Math.hypot(a.rect.x + a.rect.w / 2 - b.rect.x - b.rect.w / 2, a.rect.y + a.rect.h / 2 - b.rect.y - b.rect.h / 2) < (a.rect.w + b.rect.w) / 2 + gap - 0.01
  return overlaps(grow(a.rect, gap / 2), grow(b.rect, gap / 2), 0.01)
}

export function layoutControls(items: FrItem[], area: FrRect, obstacles: FrRect[] = []): FrLayout {
  const { D, R, gap, pad } = units(area)
  const out: FrLayout = { spots: {}, overflow: [], top: area.y + area.h, D, R }
  if (area.w <= 0 || area.h <= 0) return { ...out, overflow: items.map((i) => i.id) }
  const taken: FrShape[] = obstacles.map((rect) => ({ rect, round: false }))
  const inside = (r: FrRect): boolean => r.x >= area.x + pad - 0.5 && r.y >= area.y + pad - 0.5 && r.x + r.w <= area.x + area.w - pad + 0.5 && r.y + r.h <= area.y + area.h - pad + 0.5
  const free = (r: FrRect, round: boolean): boolean => inside(r) && !taken.some((t) => hits({ rect: r, round }, t, gap))
  const clampC = (cx: number, cy: number, f: { w: number; h: number }): [number, number] => [
    Math.min(area.x + area.w - pad - f.w / 2, Math.max(area.x + pad + f.w / 2, cx)),
    Math.min(area.y + area.h - pad - f.h / 2, Math.max(area.y + pad + f.h / 2, cy))
  ]
  const put = (it: FrItem, cx: number, cy: number, size: number): void => {
    const r = rectAt(cx, cy, footprint(it.kind, size, area))
    const round = it.kind !== 'axis'
    taken.push({ rect: r, round })
    out.spots[it.id] = { x: Math.round(((cx - area.x) / area.w) * 1000) / 1000, y: Math.round(((cy - area.y) / area.h) * 1000) / 1000, size, cx, cy, rect: r, round }
    out.top = Math.min(out.top, r.y)
  }
  const near = (it: FrItem, cx0: number, cy0: number, size: number): boolean => {
    const f = footprint(it.kind, size, area)
    const [cx, cy] = clampC(cx0, cy0, f)
    if (free(rectAt(cx, cy, f), it.kind !== 'axis')) {
      put(it, cx, cy, size)
      return true
    }
    const step = D * 0.25
    const maxR = Math.hypot(area.w, area.h)
    for (let r = step; r < maxR; r += step) {
      const n = Math.max(8, Math.round((2 * Math.PI * r) / step))
      for (let k = 0; k < n; k++) {
        const a = (k / n) * 2 * Math.PI
        const [x, y] = clampC(cx + Math.cos(a) * r, cy + Math.sin(a) * r, f)
        if (free(rectAt(x, y, f), it.kind !== 'axis')) {
          put(it, x, y, size)
          return true
        }
      }
    }
    return false
  }
  const placed = (it: FrItem): boolean => it.place?.x !== undefined && it.place?.y !== undefined
  const order = [...items.filter((i) => i.pin && placed(i)), ...items.filter((i) => !i.pin && placed(i))]
  for (const it of order) if (!near(it, area.x + it.place!.x! * area.w, area.y + it.place!.y! * area.h, it.place!.size ?? 1)) out.overflow.push(it.id)
  const auto = items.filter((i) => !placed(i))
  const left = area.x + pad
  const right = area.x + area.w - pad
  const bottom = area.y + area.h - pad
  const sticks = auto.filter((i) => i.kind === 'stick')
  const s1 = { x: left + R * 1.1, y: bottom - R * 1.1 }
  let anchor = { x: right - (D * PRIMARY) / 2, y: bottom - (D * PRIMARY) / 2 }
  sticks.forEach((s, i) => {
    const size = s.place?.size ?? 1
    const ok = i === 0 ? near(s, s1.x, s1.y, size) : i === 1 ? near(s, right - R * 1.1, bottom - R * 1.1, size) : false
    if (!ok) out.overflow.push(s.id)
    if (i === 1 && ok) anchor = { x: anchor.x, y: out.spots[s.id].rect.y - gap - (D * PRIMARY) / 2 }
  })
  let ay = out.spots[sticks[0]?.id ?? '']?.rect.y ?? bottom
  const ax = out.spots[sticks[0]?.id ?? '']?.cx ?? left + D * 1.05
  for (const a of auto.filter((i) => i.kind === 'axis')) {
    const f = footprint('axis', a.place?.size ?? 1, area)
    const y = ay - (ay === bottom ? 0 : gap) - f.h / 2
    if (!near(a, ax, y, a.place?.size ?? 1)) out.overflow.push(a.id)
    else ay = out.spots[a.id].rect.y
  }
  const slots: { x: number; y: number; size: number }[] = [{ ...anchor, size: PRIMARY }]
  const r1 = Math.max((D * PRIMARY) / 2 + gap + D / 2, (D + gap) / (2 * Math.sin(Math.PI / 8)) + 0.5)
  for (let k = 0, rk = r1; rk < Math.hypot(area.w, area.h); k++, rk += D + gap * 1.2) {
    const n = Math.max(2, Math.floor(Math.PI / 2 / (2 * Math.asin(Math.min(1, (D + gap) / (2 * rk)))) + 1e-6) + 1)
    for (let i = 0; i < n; i++) {
      const a = Math.PI + (Math.PI / 2) * (i / (n - 1))
      slots.push({ x: anchor.x + Math.cos(a) * rk, y: anchor.y + Math.sin(a) * rk, size: 1 })
    }
  }
  let k = 0
  for (const b of auto.filter((i) => i.kind === 'button')) {
    let done = false
    while (k < slots.length && !done) {
      const s = slots[k++]
      const size = (b.place?.size ?? 1) * s.size
      const r = rectAt(s.x, s.y, footprint('button', size, area))
      if (free(r, true)) {
        put(b, s.x, s.y, size)
        done = true
      }
    }
    if (!done) out.overflow.push(b.id)
  }
  out.top = Math.round(out.top * 10) / 10
  return out
}

export function maxSize(kind: FrKind, cx: number, cy: number, want: number, area: FrRect, others: FrShape[]): number {
  const { gap } = units(area)
  let s = Math.min(want, FR_SIZES[FR_SIZES.length - 1])
  while (s > FR_SIZES[0]) {
    const r = rectAt(cx, cy, footprint(kind, s, area))
    const ok = r.x >= area.x && r.y >= area.y && r.x + r.w <= area.x + area.w && r.y + r.h <= area.y + area.h && !others.some((o) => hits({ rect: r, round: kind !== 'axis' }, o, gap))
    if (ok) return Math.round(s * 100) / 100
    s -= 0.02
  }
  return FR_SIZES[0]
}

export function snapSize(s: number, limit: number): number {
  let best = FR_SIZES[0]
  for (const v of FR_SIZES) if (v <= limit + 0.001 && Math.abs(v - s) < Math.abs(best - s)) best = v
  return best
}

const LEAD = new Set(['toggle', 'use', 'do', 'press', 'hold', 'trigger', 'activate', 'perform', 'input', 'action', 'btn', 'button', 'on'])

export function shortLabel(label: string): string {
  const words = label
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[_\-.]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
  while (words.length > 1 && LEAD.has(words[0].toLowerCase())) words.shift()
  return words.join(' ')
}

export function fitLabel(label: string, width: number, maxFont = 13, minFont = 9): { lines: string[]; font: number } {
  let words = shortLabel(label).split(' ')
  const wrap = (cap: number): string[] | null => {
    const lines: string[] = []
    for (const w of words) {
      if (w.length > cap) return null
      const last = lines[lines.length - 1]
      if (last !== undefined && last.length + 1 + w.length <= cap) lines[lines.length - 1] = `${last} ${w}`
      else lines.push(w)
    }
    return lines.length <= 2 ? lines : null
  }
  for (;;) {
    const floor = words.length > 1 ? Math.max(minFont, 11) : minFont
    for (let font = maxFont; font >= floor; font -= 0.5) {
      const lines = wrap(Math.floor(width / (font * 0.56)))
      if (lines) return { lines, font }
    }
    if (words.length <= 1) return { lines: words, font: minFont }
    words = words.slice(1)
  }
}
