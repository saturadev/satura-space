import type { TiProp, TiRect, TiSection, TiStyle, TiStyleDraw } from '@shared/tuner-inspector'
import { styleHasBg, widgetFor, type Widget } from './widgets'

export type TiFieldValue = string | number | boolean
export type TiValueWidget = 'field' | 'popup' | 'toggle' | 'colorField'

export interface TiField {
  path: string
  name: string
  parent?: string
  value?: TiFieldValue
  widget?: TiValueWidget
  at?: [number, number, number, number]
  off?: true
  aux?: true
}

const LABELS: ReadonlySet<Widget> = new Set<Widget>(['label', 'boldLabel', 'miniLabel', 'foldout', 'title'])
const NUMERIC = new Set(['Integer', 'Float', 'ArraySize', 'FixedBufferSize'])
const NUMBER_RE = /^-?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i

const VALUE_ORDER: Record<'bool' | 'other', [Widget[], TiValueWidget][]> = {
  bool: [
    [['toggle', 'linkButton'], 'toggle'],
    [['field', 'boldField'], 'field'],
    [['popup'], 'popup'],
    [['colorField'], 'colorField']
  ],
  other: [
    [['field', 'boldField'], 'field'],
    [['popup'], 'popup'],
    [['colorField'], 'colorField'],
    [['toggle', 'linkButton'], 'toggle']
  ]
}

type Draw = { d: TiStyleDraw; w: Widget; name: string }

function widgetOf(d: TiStyleDraw, styles: Map<number, TiStyle>): Draw {
  const style = styles.get(d.st)
  const name = style?.n ?? ''
  if (!style || !name) return { d, w: 'generic', name }
  return { d, w: widgetFor(name, styleHasBg(style), !!d.t || d.img !== undefined), name }
}

function area(r: TiRect): number {
  return Math.max(0, r.w) * Math.max(0, r.h)
}

function holds(r: TiRect, d: TiRect): boolean {
  const cx = d.x + d.w / 2
  const cy = d.y + d.h / 2
  return cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h && d.w <= r.w + 2 && d.h <= r.h + 2
}

function within(r: TiRect, d: TiRect): boolean {
  return d.x >= r.x - 1 && d.y >= r.y - 1 && d.x + d.w <= r.x + r.w + 1 && d.y + d.h <= r.y + r.h + 1
}

function sameRect(a: TiRect, b: TiRect): boolean {
  return Math.abs(a.x - b.x) <= 1 && Math.abs(a.y - b.y) <= 1 && Math.abs(a.w - b.w) <= 1 && Math.abs(a.h - b.h) <= 1
}

function hex2(v: number): string {
  return Math.round(Math.max(0, Math.min(1, v)) * 255)
    .toString(16)
    .padStart(2, '0')
    .toUpperCase()
}

function colorValue(field: TiStyleDraw, draws: Draw[]): string {
  const inner = draws.filter((x) => x.d !== field && x.d.c === field.c && !x.name && within(field, x.d))
  const mixed = inner.find((x) => x.d.t)
  if (mixed) return mixed.d.t ?? ''
  if (!inner.length) return ''
  const main = inner.reduce((a, b) => (area(b.d) > area(a.d) ? b : a))
  const rgb = (main.d.bg ?? 'ffffffff').slice(0, 6).toUpperCase()
  const bars = inner.filter((x) => x !== main && x.d.h <= main.d.h * 0.5)
  const black = bars.find((x) => (x.d.bg ?? '').startsWith('000000'))
  if (!black || black.d.w <= 0) return `#${rgb}`
  const white = bars.find((x) => x !== black && !x.d.bg)
  const a = white ? white.d.w / black.d.w : 0
  return a >= 0.998 ? `#${rgb}` : `#${rgb}${hex2(a)}`
}

function valueOf(p: TiProp, pick: Draw, draws: Draw[]): TiFieldValue {
  if (pick.w === 'toggle' || pick.w === 'linkButton') return /mixed/i.test(pick.name) ? 'mixed' : pick.d.on === 1
  if (pick.w === 'colorField') return colorValue(pick.d, draws)
  const text = pick.d.t ?? ''
  return NUMERIC.has(p.k) && NUMBER_RE.test(text.trim()) ? Number(text) : text
}

export function inspectorFields(sec: Pick<TiSection, 'props' | 'draws'>, styles: Map<number, TiStyle>): TiField[] {
  const props = sec.props ?? []
  const draws = (sec.draws ?? []).filter((d): d is TiStyleDraw => d.k === 's').map((d) => widgetOf(d, styles))
  const paths = new Set(props.map((p) => `${p.c ?? ''}|${p.p}`))
  const parentOf = (p: TiProp): string | undefined => {
    for (let i = p.p.lastIndexOf('.'); i > 0; i = p.p.lastIndexOf('.', i - 1)) {
      const q = p.p.slice(0, i)
      if (paths.has(`${p.c ?? ''}|${q}`)) return q
    }
    return undefined
  }
  const parents = props.map(parentOf)
  const compound = new Set<string>()
  props.forEach((p, i) => {
    if (parents[i] !== undefined) compound.add(`${p.c ?? ''}|${parents[i]}`)
  })
  const smallest = draws.map((x) => props.reduce((m, q) => (q.c === x.d.c && holds(q, x.d) ? Math.min(m, area(q)) : m), Infinity))
  const owned = (p: TiProp): Draw[] => {
    const a = area(p)
    return draws.filter((x, i) => x.d.c === p.c && smallest[i] >= a - 1 && holds(p, x.d))
  }
  return props.map((p, i) => {
    const out: TiField = { path: p.p, name: p.l || p.p }
    const parent = parents[i]
    if (parent !== undefined) out.parent = parent
    const mine = owned(p)
    const isCompound = compound.has(`${p.c ?? ''}|${p.p}`)
    let pick: Draw | undefined
    if (!isCompound) {
      for (const [ws, kind] of VALUE_ORDER[p.k === 'Boolean' ? 'bool' : 'other']) {
        pick = mine.find((x) => ws.includes(x.w) && sameRect(p, x.d)) ?? mine.find((x) => ws.includes(x.w))
        if (pick) {
          out.value = valueOf(p, pick, draws)
          out.widget = kind
          out.at = [pick.d.x - p.x, pick.d.y - p.y, pick.d.w, pick.d.h]
          if (pick.d.off === 1) out.off = true
          break
        }
      }
    }
    const aux =
      !isCompound &&
      props.some((q, j) => j !== i && q.c === p.c && compound.has(`${q.c ?? ''}|${q.p}`) && !p.p.startsWith(`${q.p}.`) && sameRect(p, q))
    if (aux) {
      out.aux = true
      return out
    }
    if (p.n) return out
    const label = mine
      .filter((x) => LABELS.has(x.w) && x !== pick && (x.d.t ?? '').trim() && !(pick && within(pick.d, x.d)))
      .sort((a, b) => a.d.x - b.d.x || a.d.y - b.d.y)[0]
    const text = label?.d.t?.trim() || (pick && (pick.w === 'toggle' || pick.w === 'linkButton') ? pick.d.t?.trim() : '')
    if (text) out.name = text
    return out
  })
}

export interface IslandControls {
  overrides: Map<number, { on: 'true' | 'false'; at: string }>
  headers: { label: string; on: boolean; off: boolean; at: string; x: number; y: number; w: number; h: number }[]
}

export function islandControls(sec: Pick<TiSection, 'props' | 'draws'>, styles: Map<number, TiStyle>, index: number): IslandControls {
  const out: IslandControls = { overrides: new Map(), headers: [] }
  const draws = (sec.draws ?? []).filter((d): d is TiStyleDraw => d.k === 's' && d.c === index).map((d) => widgetOf(d, styles))
  const toggles = draws.filter((x) => x.w === 'toggle' && !x.d.t)
  const rowOf = (r: TiRect, t: TiRect): boolean => {
    const cy = t.y + t.h / 2
    return cy >= r.y - 1 && cy <= r.y + r.h + 1
  }
  ;(sec.props ?? []).forEach((p, k) => {
    if (p.c !== index || p.p.indexOf('/') <= 0) return
    const t = toggles.filter((x) => x.d.x + x.d.w <= p.x + 2 && p.x - x.d.x <= 40 && rowOf(p, x.d)).pop()
    if (t) out.overrides.set(k, { on: t.d.on === 1 ? 'true' : 'false', at: [t.d.x - p.x, t.d.y - p.y, t.d.w, t.d.h].join(' ') })
  })
  const seen = new Set<string>()
  for (const b of draws) {
    const label = (b.d.t ?? '').trim()
    if (b.w !== 'boldLabel' || !label || seen.has(label)) continue
    const t = toggles.find((x) => x.d.x + x.d.w <= b.d.x + 2 && b.d.x - x.d.x <= 24 && rowOf(b.d, x.d))
    if (!t) continue
    seen.add(label)
    const fold = draws.find((x) => x.w === 'foldout' && x.d.x + x.d.w <= t.d.x + 2 && t.d.x - x.d.x <= 24 && rowOf(b.d, x.d))
    const x = fold ? fold.d.x : t.d.x
    const y = Math.min(t.d.y, b.d.y)
    out.headers.push({ label, on: t.d.on === 1, off: t.d.off === 1, at: [t.d.x - x, t.d.y - y, t.d.w, t.d.h].join(' '), x, y, w: b.d.x + b.d.w - x, h: Math.max(t.d.y + t.d.h, b.d.y + b.d.h) - y })
  }
  return out
}

const LABELS_KEY = 'satura.tunerShownLabels'
const LABELS_MAX = 4000
let labelsSave: ReturnType<typeof setTimeout> | null = null

function shownLabels(): Record<string, string> {
  const host = window as unknown as { __tiShownLabels?: Record<string, string> }
  if (host.__tiShownLabels) return host.__tiShownLabels
  let stored: Record<string, string> = {}
  try {
    const raw = JSON.parse(window.localStorage.getItem(LABELS_KEY) ?? '{}') as unknown
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) stored = raw as Record<string, string>
  } catch {
    stored = {}
  }
  host.__tiShownLabels = stored
  return stored
}

function saveShownLabels(map: Record<string, string>): void {
  if (labelsSave) return
  labelsSave = setTimeout(() => {
    labelsSave = null
    try {
      const keys = Object.keys(map)
      const keep = keys.length > LABELS_MAX ? Object.fromEntries(keys.slice(keys.length - LABELS_MAX).map((k) => [k, map[k]])) : map
      window.localStorage.setItem(LABELS_KEY, JSON.stringify(keep))
    } catch {
    }
  }, 2000)
}

export function learnShownLabels(sec: Pick<TiSection, 'key' | 'kind' | 'props'>, fields: TiField[]): void {
  const type = sec.kind === 'component' ? sec.key.replace(/#\d+$/, '') : ''
  if (!type || typeof window === 'undefined') return
  const map = shownLabels()
  const props = sec.props ?? []
  const recast = new Set(fields.filter((f, i) => props[i]?.k === 'Boolean' && f.value !== undefined && typeof f.value !== 'boolean').map((f) => f.path))
  let added = false
  fields.forEach((f, i) => {
    const p = props[i]
    if (!p || f.parent !== undefined || f.aux || !f.name || f.name === (p.l || p.p) || recast.has(f.path)) return
    const key = `${type}|${f.path}`
    if (map[key] === f.name) return
    map[key] = f.name
    added = true
  })
  if (added) saveShownLabels(map)
}
