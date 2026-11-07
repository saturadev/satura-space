import { frameOf, type TunerAnimChannel, type TunerAnimClip, type TunerAnimKey, type TunerAnimKeyArg, type TunerAnimProp, type TunerBezier } from '@shared/tuner-animator'

export type { TunerBezier }

export const LABEL_W = 260
export const LABEL_MIN = 170
export const LABEL_MAX = 520
export const TRACK_PAD = 10
export const ROW_H = 20
export const SUMMARY_H = 22
export const KEY_PX = 6
export const MIN_SPAN_FRAMES = 4

export interface TimeScale {
  x0: number
  width: number
  length: number
  start: number
  span: number
}

export interface TimeView {
  start: number
  span: number
}

export function viewLength(clipLength: number, fps: number): number {
  return Math.max(clipLength, 10 / Math.max(1, fps), 0.05)
}

export function makeScale(trackWidth: number, length: number, view?: TimeView | null, fps = 60): TimeScale {
  const len = Math.max(0.05, length)
  const minSpan = Math.min(len, MIN_SPAN_FRAMES / Math.max(1, fps))
  const span = view ? Math.max(minSpan, Math.min(len * 4, view.span)) : len
  const start = view ? Math.max(0, Math.min(Math.max(0, len - span * 0.25), view.start)) : 0
  return { x0: TRACK_PAD, width: Math.max(1, trackWidth - TRACK_PAD * 2), length: len, start, span }
}

export function xOf(s: TimeScale, t: number): number {
  return s.x0 + ((t - s.start) / s.span) * s.width
}

export function tOf(s: TimeScale, x: number): number {
  return s.start + ((x - s.x0) / s.width) * s.span
}

export function zoomView(s: TimeScale, factor: number, x: number, fps = 60): TimeView {
  const minSpan = Math.min(s.length, MIN_SPAN_FRAMES / Math.max(1, fps))
  const span = Math.max(minSpan, Math.min(s.length * 4, s.span * factor))
  const at = tOf(s, x)
  const start = Math.max(0, at - ((x - s.x0) / s.width) * span)
  return { start, span }
}

export function panView(s: TimeScale, dx: number): TimeView {
  return { start: Math.max(0, s.start + (dx / s.width) * s.span), span: s.span }
}

export function frameView(t0: number, t1: number, fps: number): TimeView {
  const pad = Math.max(2 / fps, (t1 - t0) * 0.08)
  const span = Math.max(MIN_SPAN_FRAMES / fps, t1 - t0 + pad * 2)
  return { start: Math.max(0, t0 - pad), span }
}

export function snapTime(t: number, fps: number): number {
  return Math.max(0, Math.round(t * fps)) / fps
}

export interface Tick {
  t: number
  major: boolean
  label: string
}

export function timeTicks(s: TimeScale, fps: number, frames: boolean): Tick[] {
  const pxPerFrame = s.width / (s.span * fps)
  const frameSteps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1200, 3000, 6000]
  const fit = (min: number): number => frameSteps.find((f) => f * pxPerFrame >= min) ?? frameSteps[frameSteps.length - 1]
  const major = fit(56)
  const minorCands = frameSteps.filter((f) => f < major && major % f === 0 && f * pxPerFrame >= 7)
  const minor = minorCands.length > 0 ? minorCands[minorCands.length - 1] : major
  const out: Tick[] = []
  const f0 = Math.max(0, Math.ceil((s.start * fps) / minor) * minor)
  const f1 = Math.floor(((s.start + s.span) * fps) / minor) * minor
  for (let f = f0; f <= f1 && out.length < 2000; f += minor) {
    const isMajor = f % major === 0
    out.push({ t: f / fps, major: isMajor, label: isMajor ? (frames ? String(f) : secondsLabel(f, fps)) : '' })
  }
  return out
}

function secondsLabel(frame: number, fps: number): string {
  const sec = Math.floor(frame / fps)
  const rest = Math.round(frame - sec * fps)
  return `${sec}:${String(rest).padStart(String(Math.max(1, Math.round(fps) - 1)).length, '0')}`
}

export type DopeRowKind = 'summary' | 'object' | 'component' | 'section' | 'group' | 'channel'

export interface DopeRow {
  kind: DopeRowKind
  key: string
  y: number
  h: number
  depth: number
  label: string
  path: string
  channels: TunerAnimChannel[]
  prop?: TunerAnimProp
  channel?: TunerAnimChannel
  type?: string
  open: boolean
  expandable: boolean
  count?: number
}

export function defaultOpen(kind: DopeRowKind): boolean {
  return kind === 'object' || kind === 'component'
}

export function isOpen(key: string, kind: DopeRowKind, toggled: ReadonlySet<string>): boolean {
  return defaultOpen(kind) !== toggled.has(key)
}

export function dopeRows(clip: TunerAnimClip | null, toggled: ReadonlySet<string>): DopeRow[] {
  if (!clip) return []
  const rows: DopeRow[] = []
  let y = 0
  const push = (r: Omit<DopeRow, 'y' | 'h'>, h = ROW_H): void => {
    rows.push({ ...r, y, h })
    y += h
  }
  const keyed = clip.props
  const all = keyed.flatMap((p) => p.channels)
  push({ kind: 'summary', key: 'summary', depth: 0, label: 'Summary', path: '', channels: all, open: true, expandable: false }, SUMMARY_H)
  const objects: string[] = []
  for (const p of keyed) if (!objects.includes(p.path)) objects.push(p.path)
  for (const path of objects) {
    const props = keyed.filter((p) => p.path === path)
    const okey = `o:${path}`
    const oOpen = isOpen(okey, 'object', toggled)
    push({ kind: 'object', key: okey, depth: 0, label: props[0]?.object || '(root)', path, channels: props.flatMap((p) => p.channels), open: oOpen, expandable: true })
    if (!oOpen) continue
    const types: string[] = []
    for (const p of props) if (!types.includes(p.type)) types.push(p.type)
    for (const type of types) {
      const tprops = props.filter((p) => p.type === type)
      const ckey = `c:${path}|${type}`
      const cOpen = isOpen(ckey, 'component', toggled)
      push({ kind: 'component', key: ckey, depth: 1, label: tprops[0].component, path, channels: tprops.flatMap((p) => p.channels), type, open: cOpen, expandable: true })
      if (!cOpen) continue
      let section = ''
      let sOpen = true
      for (const p of tprops) {
        let depth = 2
        if (p.section) {
          if (p.section !== section) {
            section = p.section
            const skey = `s:${path}|${type}|${section}`
            sOpen = isOpen(skey, 'section', toggled)
            const sprops = tprops.filter((x) => x.section === section)
            push({ kind: 'section', key: skey, depth: 2, label: section, path, channels: sprops.flatMap((x) => x.channels), type, open: sOpen, expandable: true, count: sprops.length })
          }
          if (!sOpen) continue
          depth = 3
        } else section = ''
        const gkey = `g:${p.id}`
        const multi = p.channels.length > 1
        const gOpen = multi && isOpen(gkey, 'group', toggled)
        push({ kind: 'group', key: gkey, depth, label: p.label, path, channels: p.channels, prop: p, channel: multi ? undefined : p.channels[0], open: gOpen, expandable: multi })
        if (!gOpen) continue
        for (const ch of p.channels)
          push({ kind: 'channel', key: `ch:${ch.id}`, depth: depth + 1, label: ch.label, path, channels: [ch], prop: p, channel: ch, open: false, expandable: false })
      }
    }
  }
  return rows
}

export function rowsHeight(rows: readonly DopeRow[]): number {
  const last = rows[rows.length - 1]
  return last ? last.y + last.h : 0
}

export function rowAt(rows: readonly DopeRow[], y: number): DopeRow | null {
  let lo = 0
  let hi = rows.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const r = rows[mid]
    if (y < r.y) hi = mid - 1
    else if (y >= r.y + r.h) lo = mid + 1
    else return r
  }
  return null
}

export function visibleRows(rows: readonly DopeRow[], top: number, height: number, pad = 120): { from: number; to: number } {
  if (rows.length === 0) return { from: 0, to: 0 }
  const y0 = top - pad
  const y1 = top + height + pad
  let lo = 0
  let hi = rows.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (rows[mid].y + rows[mid].h <= y0) lo = mid + 1
    else hi = mid
  }
  let to = lo
  while (to < rows.length && rows[to].y < y1) to++
  return { from: lo, to }
}

export const selId = (channel: string, frame: number): string => `${channel}@${frame}`

export function parseSelId(id: string): { channel: string; frame: number } | null {
  const at = id.lastIndexOf('@')
  if (at <= 0) return null
  const frame = Number(id.slice(at + 1))
  if (!Number.isInteger(frame)) return null
  return { channel: id.slice(0, at), frame }
}

export interface RowKey {
  frame: number
  t: number
  ids: string[]
}

export function rowKeys(row: DopeRow, fps: number): RowKey[] {
  const map = new Map<number, RowKey>()
  for (const ch of row.channels)
    for (const k of ch.keys) {
      const f = frameOf(k.t, fps)
      const cur = map.get(f)
      if (cur) cur.ids.push(selId(ch.id, f))
      else map.set(f, { frame: f, t: k.t, ids: [selId(ch.id, f)] })
    }
  return [...map.values()].sort((a, b) => a.frame - b.frame)
}

export function hitKey(rows: readonly DopeRow[], s: TimeScale, fps: number, x: number, y: number): { row: DopeRow; key: RowKey } | null {
  const row = rowAt(rows, y)
  if (!row) return null
  let best: RowKey | null = null
  let bestD = KEY_PX + 1
  for (const k of rowKeys(row, fps)) {
    const d = Math.abs(xOf(s, k.t) - x)
    if (d < bestD) {
      bestD = d
      best = k
    }
  }
  return best ? { row, key: best } : null
}

export function keysInRect(rows: readonly DopeRow[], s: TimeScale, fps: number, x0: number, y0: number, x1: number, y1: number): string[] {
  const [ax, bx] = x0 < x1 ? [x0, x1] : [x1, x0]
  const [ay, by] = y0 < y1 ? [y0, y1] : [y1, y0]
  const out = new Set<string>()
  for (const r of rows) {
    const cy = r.y + r.h / 2
    if (cy < ay || cy > by) continue
    for (const k of rowKeys(r, fps)) {
      const x = xOf(s, k.t)
      if (x >= ax - KEY_PX / 2 && x <= bx + KEY_PX / 2) for (const id of k.ids) out.add(id)
    }
  }
  return [...out]
}

export function selectionState(key: RowKey, sel: ReadonlySet<string>): 'all' | 'some' | 'none' {
  let n = 0
  for (const id of key.ids) if (sel.has(id)) n++
  return n === 0 ? 'none' : n === key.ids.length ? 'all' : 'some'
}

export function channelIndex(clip: TunerAnimClip | null): Map<string, TunerAnimChannel> {
  const m = new Map<string, TunerAnimChannel>()
  if (clip) for (const p of clip.props) for (const ch of p.channels) m.set(ch.id, ch)
  return m
}

export function keyOf(ch: TunerAnimChannel | undefined, frame: number, fps: number): TunerAnimKey | null {
  if (!ch) return null
  return ch.keys.find((k) => frameOf(k.t, fps) === frame) ?? null
}

export function selectedKeyArgs(clip: TunerAnimClip | null, sel: ReadonlySet<string>, fps: number): TunerAnimKeyArg[] {
  const idx = channelIndex(clip)
  const out: TunerAnimKeyArg[] = []
  for (const id of sel) {
    const p = parseSelId(id)
    if (!p) continue
    const k = keyOf(idx.get(p.channel), p.frame, fps)
    if (k) out.push({ id: p.channel, t: k.t })
  }
  return out
}

export interface ClipboardKey extends TunerAnimKeyArg {
  id: string
}

export function copyKeys(clip: TunerAnimClip | null, sel: ReadonlySet<string>, fps: number): ClipboardKey[] {
  const idx = channelIndex(clip)
  const out: ClipboardKey[] = []
  for (const id of sel) {
    const p = parseSelId(id)
    if (!p) continue
    const k = keyOf(idx.get(p.channel), p.frame, fps)
    if (!k || idx.get(p.channel)?.keys === undefined) continue
    out.push({
      id: p.channel,
      t: k.t,
      hasV: true,
      v: k.v,
      hasTan: true,
      inT: k.in ?? 1e30,
      outT: k.out ?? 1e30,
      inW: k.inW,
      outW: k.outW,
      wm: k.wm,
      lm: k.lm,
      rm: k.rm,
      broken: k.broken
    })
  }
  return out.sort((a, b) => a.t - b.t)
}

export function movedSelection(sel: ReadonlySet<string>, df: number): Set<string> {
  const out = new Set<string>()
  for (const id of sel) {
    const p = parseSelId(id)
    if (p) out.add(selId(p.channel, Math.max(0, p.frame + df)))
  }
  return out
}

export function selectionRange(clip: TunerAnimClip | null, sel: ReadonlySet<string>, fps: number): [number, number] | null {
  let lo = Infinity
  let hi = -Infinity
  for (const k of selectedKeyArgs(clip, sel, fps)) {
    lo = Math.min(lo, k.t)
    hi = Math.max(hi, k.t)
  }
  return Number.isFinite(lo) ? [lo, hi] : null
}

export function pruneSelection(clip: TunerAnimClip | null, sel: ReadonlySet<string>, fps: number): Set<string> {
  const idx = channelIndex(clip)
  const out = new Set<string>()
  for (const id of sel) {
    const p = parseSelId(id)
    if (p && keyOf(idx.get(p.channel), p.frame, fps)) out.add(id)
  }
  return out
}

export const EVENT_MARKER_GAP = 10

function spreadEventXs(xs: readonly number[], gap = EVENT_MARKER_GAP): number[] {
  const order = xs.map((_, i) => i).sort((a, b) => xs[a] - xs[b] || a - b)
  const groups: { ids: number[]; sum: number }[] = []
  const start = (g: { ids: number[]; sum: number }): number => g.sum / g.ids.length - ((g.ids.length - 1) * gap) / 2
  for (const i of order) {
    groups.push({ ids: [i], sum: xs[i] })
    while (groups.length > 1) {
      const b = groups[groups.length - 1]
      const a = groups[groups.length - 2]
      if (start(a) + a.ids.length * gap <= start(b)) break
      groups.splice(groups.length - 2, 2, { ids: [...a.ids, ...b.ids], sum: a.sum + b.sum })
    }
  }
  const out = new Array<number>(xs.length)
  for (const g of groups) {
    const x0 = start(g)
    g.ids.forEach((id, k) => (out[id] = x0 + k * gap))
  }
  return out
}

export function eventMarkerXs(clip: TunerAnimClip | null, s: TimeScale, drag?: { index: number; t: number } | null): number[] {
  if (!clip) return []
  return spreadEventXs(clip.events.map((e, i) => xOf(s, drag && drag.index === i ? drag.t : e.t)))
}

export function eventAt(clip: TunerAnimClip | null, s: TimeScale, x: number, drag?: { index: number; t: number } | null): number {
  if (!clip) return -1
  const xs = eventMarkerXs(clip, s, drag)
  let best = -1
  let bestD = 6
  xs.forEach((ex, i) => {
    const d = Math.abs(ex - x)
    if (d < bestD) {
      bestD = d
      best = i
    }
  })
  return best
}

export const CHANNEL_COLOR: Record<string, string> = {
  x: '#e5484d',
  y: '#46a758',
  z: '#3e7bfa',
  w: '#a0a0a8',
  r: '#e5484d',
  g: '#46a758',
  b: '#3e7bfa',
  a: '#a0a0a8'
}

export function channelColor(label: string): string | null {
  return CHANNEL_COLOR[label] ?? null
}

export function fmt(v: number, digits = 3): string {
  if (!Number.isFinite(v)) return '—'
  const r = Number(v.toFixed(digits))
  return Object.is(r, -0) ? '0' : String(r)
}

export function keyAtPlayhead(row: DopeRow, frame: number, fps: number): 'all' | 'some' | 'none' {
  if (row.channels.length === 0) return 'none'
  let n = 0
  for (const ch of row.channels) if (ch.keys.some((k) => frameOf(k.t, fps) === frame)) n++
  return n === 0 ? 'none' : n === row.channels.length ? 'all' : 'some'
}

export function cubicBezier(b: TunerBezier, x: number): number {
  const [x1, y1, x2, y2] = b
  if (x <= 0) return 0
  if (x >= 1) return 1
  let lo = 0
  let hi = 1
  let u = x
  for (let i = 0; i < 60; i++) {
    const bx = 3 * (1 - u) * (1 - u) * u * x1 + 3 * (1 - u) * u * u * x2 + u * u * u
    if (Math.abs(bx - x) < 1e-7) break
    if (bx < x) lo = u
    else hi = u
    u = (lo + hi) / 2
  }
  return 3 * (1 - u) * (1 - u) * u * y1 + 3 * (1 - u) * u * u * y2 + u * u * u
}

export function evalSegment(a: TunerAnimKey, b: TunerAnimKey, t: number): number {
  const dt = b.t - a.t
  if (dt <= 0) return a.v
  if (a.out === null || b.in === null) return a.v
  const u = (t - a.t) / dt
  const ow = a.wm & 2 ? a.outW : 1 / 3
  const iw = b.wm & 1 ? b.inW : 1 / 3
  const p1x = ow
  const p1y = a.v + a.out * ow * dt
  const p2x = 1 - iw
  const p2y = b.v - b.in * iw * dt
  let lo = 0
  let hi = 1
  let s = u
  for (let i = 0; i < 50; i++) {
    const bx = 3 * (1 - s) * (1 - s) * s * p1x + 3 * (1 - s) * s * s * p2x + s * s * s
    if (Math.abs(bx - u) < 1e-7) break
    if (bx < u) lo = s
    else hi = s
    s = (lo + hi) / 2
  }
  return (1 - s) ** 3 * a.v + 3 * (1 - s) ** 2 * s * p1y + 3 * (1 - s) * s * s * p2y + s ** 3 * b.v
}
