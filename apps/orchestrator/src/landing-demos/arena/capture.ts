import type { TiDraw, TiRect, TiSection, TiStyleDraw } from '@shared/tuner-inspector'

export type FoldKind = 'section' | 'foldout' | 'header' | 'module' | 'emitter'

export interface Fold {
  key: string
  section: string
  kind: FoldKind
  title: TiStyleDraw
  start: number
  end: number
  label: string
}

export type StyleName = (d: TiStyleDraw) => string

const SUPPORTED = new Set([
  'textfield',
  'ShurikenValue',
  'toggle',
  'ShurikenToggle',
  'horizontalslider',
  'horizontalsliderthumb',
  'HorizontalSliderThumbExtent',
  'MiniPopup',
  'ShurikenPopup',
  'MiniPullDown',
  'ObjectField',
  'ObjectFieldButton',
  'ColorField',
  'ColorPickerBox',
  'Foldout',
  'FoldoutHeader',
  'ShurikenModuleTitle',
  'ShurikenEmitterTitle',
  'Titlebar Foldout',
  'PaneOptions',
  'IconButton',
  'AppCommand',
  'BoldTextField',
  'ControlLabel',
  'ShurikenLabel',
  'FloatFieldLinkButton',
  'AC Button',
  'IN Title',
  'IN TitleText',
  'IN BigTitle',
  'BoldLabel',
  'label',
  'HelpBox',
  'ShurikenModuleBg',
  'ShurikenEffectBg',
  'RL Empty Header',
  'RL Background',
  'RL Element',
  'RL DragHandle',
  'RL Footer'
])

const TITLES = new Set(['ShurikenModuleTitle', 'ShurikenEmitterTitle', 'Foldout', 'FoldoutHeader', 'IN Title', 'IN BigTitle'])

const DROP_DRAW = new Set(['ShurikenDropdown', 'StaticDropdown', 'RL FooterButton', 'RL Footer', 'ShurikenPlus'])

export const KEEP_MODULES = new Set(['Emission', 'Shape', 'Velocity over Lifetime', 'Limit Velocity over Lifetime', 'Force over Lifetime', 'Color over Lifetime', 'Size over Lifetime', 'Rotation over Lifetime', 'Noise', 'Renderer'])

const DROP_ANY = /^(Rendering Layers|Custom Vertex Streams|Sorting Layer ID|Masking|Emitter Velocity Mode|Ring Buffer Mode|Stop Action|Gravity Source|Delta Time|Mesh Distribution|Meshes|Enable Mesh GPU Instancing|Apply Active Color Space|Visualize Pivot|Cookie|Remap|Remap Curve)$/
const DROP_IN: Record<string, RegExp> = {
  Camera: /^(Render Type|Projection|Field of View Axis|Physical Camera|Renderer)$/,
  ParticleSystem: /^(Shape|Render Mode|Separate Axes|3D Start Size|3D Start Rotation|Culling Mode|Emit from:|Mode|Quality|Space)$/
}

const DROP_ROW: Record<string, RegExp> = {
  Light: /^(Resolution|Inner \/ Outer Spot Angle|Shape)$/
}

export function removeBand(sec: TiSection, y0: number, y1: number): void {
  const d = y1 - y0
  if (d <= 0) return
  const fix = <T extends TiRect>(list: T[] | undefined): T[] | undefined => {
    if (!list) return list
    const out: T[] = []
    for (const r of list) {
      if (r.y >= y0 - 0.01 && r.y < y1 - 0.01) {
        if (r.y + r.h > y1 + 0.5 && r.h > d + 20) out.push({ ...r, h: r.h - d })
        continue
      }
      if (r.y >= y1 - 0.01) out.push({ ...r, y: r.y - d })
      else if (r.y + r.h > y0 + 0.5) out.push({ ...r, h: Math.max(0, r.h - Math.min(d, r.y + r.h - y0)) })
      else out.push(r)
    }
    return out
  }
  sec.draws = fix(sec.draws as (TiDraw & TiRect)[]) as TiDraw[]
  sec.props = fix(sec.props)
  sec.cursors = fix(sec.cursors)
  sec.clips = fix(sec.clips)
  sec.scrolls = fix(sec.scrolls)
  sec.h -= d
}

function rowBand(sec: TiSection, d: TiRect, name: StyleName): { y0: number; y1: number } {
  const label = (sec.draws ?? []).find((x): x is TiStyleDraw => x.k === 's' && /Label$/.test(name(x)) && Math.abs(x.y - d.y) < 3 && x.x < d.x)
  const y0 = Math.min(d.y, label?.y ?? d.y)
  const y1 = Math.max(d.y + d.h, label ? label.y + label.h : 0)
  return { y0, y1: y1 + 2 }
}

function sd(sec: TiSection): TiStyleDraw[] {
  return (sec.draws ?? []).filter((d): d is TiStyleDraw => d.k === 's')
}

function nextModuleY(sec: TiSection, name: StyleName, y: number): number {
  let best = Infinity
  for (const d of sd(sec)) if ((name(d) === 'ShurikenModuleTitle' || name(d) === 'ShurikenPlus') && d.y > y + 1 && d.y < best) best = d.y
  if (best < Infinity) return best
  const tail = sd(sec).filter((d) => d.y > y + 1 && d.h <= 4 && d.w >= sec.w - 4).sort((a, b) => a.y - b.y)[0]
  return tail ? tail.y : sec.h
}

export function strip(sec: TiSection, name: StyleName): void {
  sec.draws = (sec.draws ?? []).filter((d) => {
    if (d.k !== 's') return true
    const n = name(d)
    if (DROP_DRAW.has(n)) return false
    if (n === 'IconButton' && d.y < 22 && sec.kind === 'component') return false
    if (n === 'IconButton' && sec.kind === 'gameObject') return false
    if (n === 'minibutton' && d.y < 30 && sec.key === 'ParticleSystem') return false
    return true
  })
  const sizes = (sec.props ?? []).filter((p) => p.k === 'ArraySize')
  if (sizes.length)
    sec.draws = (sec.draws ?? []).filter((d) => !(d.k === 's' && /textfield|ControlLabel/.test(name(d)) && sizes.some((p) => Math.abs(p.y - d.y) < 2 && Math.abs(p.x - d.x) < 2)))
  if (sec.key === 'ParticleSystem') {
    const head = sd(sec).find((d) => !name(d) && d.y === 22 && d.h <= 30 && d.w >= sec.w - 4)
    if (head) removeBand(sec, head.y, head.y + head.h)
    sec.draws = (sec.draws ?? []).filter((d) => !(d.k === 's' && name(d) === 'label' && d.y < 60))
    const bursts = sd(sec).find((d) => name(d) === 'ShurikenLabel' && d.t === 'Bursts')
    if (bursts) removeBand(sec, bursts.y, nextModuleY(sec, name, bursts.y) - 1)
    for (;;) {
      const t = sd(sec).find((d) => name(d) === 'ShurikenModuleTitle' && !KEEP_MODULES.has(d.t ?? ''))
      if (!t) break
      removeBand(sec, t.y, nextModuleY(sec, name, t.y))
    }
  }
  for (let guard = 0; guard < 20; guard++) {
    const box = sd(sec).find((d) => name(d) === 'HelpBox' && DROP_HELP.test(helpText(sec, d)))
    if (!box) break
    const below = (sec.draws ?? []).filter((d) => d.k === 's' && d.y >= box.y + box.h - 0.5).map((d) => d.y)
    removeBand(sec, box.y, Math.min(below.length ? Math.min(...below) : box.y + box.h + 2, box.y + box.h + 4))
  }
  for (let guard = 0; guard < 80; guard++) {
    const ids = new Map<number, Set<string>>()
    for (const d of sd(sec)) if (d.id != null) (ids.get(d.id) ?? ids.set(d.id, new Set()).get(d.id)!).add(name(d))
    const bad = sd(sec).find((d) => {
      if (d.y < 22 && sec.kind === 'component') return false
      const n = name(d)
      const label = (d.t ?? '').trim()
      if (/Label$/.test(n) && sec.kind !== 'gameObject' && sec.key !== 'Transform' && (DROP_ANY.test(label) || DROP_IN[sec.key]?.test(label))) return true
      if (n === 'ControlLabel' && DROP_ROW[sec.key]?.test(label)) return true
      if (d.id == null) return false
      if (SUPPORTED.has(n)) return false
      if (d.w >= sec.w - 24 && !d.t) return false
      if (n === '' && d.h <= 20 && [...(ids.get(d.id) ?? [])].some((x) => SUPPORTED.has(x) && x !== 'ControlLabel' && x !== 'ShurikenLabel')) return false
      return true
    })
    if (!bad) break
    const title = sd(sec).find((t) => TITLES.has(name(t)) && bad.y + bad.h / 2 >= t.y - 1 && bad.y + bad.h / 2 <= t.y + Math.max(t.h, 15) + 1)
    if (title && !/Label$/.test(name(bad))) {
      sec.draws = (sec.draws ?? []).filter((d) => d !== bad)
      continue
    }
    const b = rowBand(sec, bad, name)
    removeBand(sec, b.y0, b.y1)
  }
  pruneEmptyGroups(sec, name)
}

const FIELD_START = 150

export function widen(sec: TiSection, width: number): void {
  const w0 = sec.w
  const dx = width - w0
  if (!(dx > 0.5) || w0 <= FIELD_START) return
  const k = (width - FIELD_START) / (w0 - FIELD_START)
  const at = (x: number): number => (x <= FIELD_START ? x : FIELD_START + (x - FIELD_START) * k)
  const head = (r: TiRect): boolean => (sec.kind === 'component' && r.y < 22) || (sec.kind === 'gameObject' && r.y < 24)
  const move = <T extends TiRect>(r: T): T => {
    if (sec.kind === 'addComponent' && r.x > 0.5 && r.x + r.w < w0 - 0.5) return { ...r, x: r.x + dx / 2 }
    if (head(r) && r.x >= 290) return { ...r, x: r.x + dx }
    if (r.w <= 24 && r.x + r.w >= w0 - 8) return { ...r, x: r.x + dx }
    if (r.w <= 24) return { ...r, x: at(r.x + r.w / 2) - r.w / 2 }
    const x = at(r.x)
    return { ...r, x, w: at(r.x + r.w) - x }
  }
  const all = <T extends TiRect>(list: T[] | undefined): T[] | undefined => list?.map(move)
  sec.draws = all(sec.draws as (TiDraw & TiRect)[]) as TiDraw[] | undefined
  sec.props = all(sec.props)
  sec.cursors = all(sec.cursors)
  sec.clips = all(sec.clips)
  sec.scrolls = sec.scrolls?.map((r) => {
    const m = move(r)
    return { ...m, vw: r.vw + (m.w - r.w), cw: r.cw + (m.w - r.w) }
  })
  sec.w = width
}

function pruneEmptyGroups(sec: TiSection, name: StyleName): void {
  for (let guard = 0; guard < 20; guard++) {
    const heads = sd(sec).filter((d) => (name(d) === 'Foldout' || name(d) === 'FoldoutHeader') && d.on === 1 && d.y >= 22).sort((a, b) => a.y - b.y)
    const empty = heads.find((h) => {
      const next = heads.find((x) => x.y > h.y + h.h && x.x <= h.x + 1)
      const end = next ? next.y - 1 : sec.h
      return !(sec.props ?? []).some((p) => p.y >= h.y + h.h - 1 && p.y < end)
    })
    if (!empty) return
    const next = heads.find((x) => x.y > empty.y + empty.h && x.x <= empty.x + 1)
    const top = Math.min(empty.y, ...(sec.draws ?? []).filter((d) => d.k === 'r' && d.h <= 2 && d.y < empty.y && d.y >= empty.y - 3).map((d) => d.y))
    removeBand(sec, top, next ? Math.min(...(sec.draws ?? []).filter((d) => d.k === 'r' && d.h <= 2 && d.y < next.y && d.y >= next.y - 3).map((d) => d.y), next.y - 1) : sec.h)
  }
}

const DROP_HELP = /lightmap|Realtime indirect|Rendering Layers|shadow resolution|Curves Pos|Clip Count/i

function helpText(sec: TiSection, box: TiStyleDraw): string {
  if (box.t) return box.t
  return sd(sec).filter((d) => d !== box && d.t && d.y >= box.y - 0.5 && d.y < box.y + box.h && d.x >= box.x - 0.5 && d.x < box.x + box.w).map((d) => d.t).join(' ')
}

export function findFolds(sec: TiSection, name: StyleName): Fold[] {
  const out: Fold[] = []
  const draws = sd(sec)
  const maxBottom = (y: number): number => Math.min(sec.h, Math.max(y, ...(sec.draws ?? []).filter((d) => d.y > y && d.h < sec.h - 30).map((d) => d.y + d.h)) + 2)
  for (const d of draws) {
    const n = name(d)
    if (n === 'Titlebar Foldout' && sec.kind === 'component') {
      out.push({ key: `${sec.key}#`, section: sec.key, kind: 'section', title: d, start: 22, end: sec.h, label: sec.title ?? sec.key })
      continue
    }
    if (n === 'Foldout') {
      const ends = draws.filter((x) => x.y > d.y + d.h - 1 && x.x <= d.x + 14 && /Label$|Foldout/.test(name(x))).map((x) => x.y)
      const start = d.y + d.h + 2
      const end = ends.length ? Math.min(...ends) : maxBottom(d.y + d.h)
      if (end > start) out.push({ key: `${sec.key}|f|${d.t ?? d.id}`, section: sec.key, kind: 'foldout', title: d, start, end, label: d.t ?? '' })
      continue
    }
    if (n === 'FoldoutHeader') {
      const ends = draws.filter((x) => x.y > d.y + 1 && name(x) === 'FoldoutHeader').map((x) => x.y)
      const start = d.y + d.h + 2
      const end = ends.length ? Math.min(...ends) : maxBottom(d.y + d.h)
      if (end > start) out.push({ key: `${sec.key}|h|${d.t ?? d.id}`, section: sec.key, kind: 'header', title: d, start, end, label: d.t ?? '' })
      continue
    }
    if (n === 'ShurikenModuleTitle' || n === 'ShurikenEmitterTitle') {
      const start = d.y + d.h + 1
      const end = nextModuleY(sec, name, d.y)
      if (end > start + 2) out.push({ key: `${sec.key}|m|${d.t}`, section: sec.key, kind: n === 'ShurikenEmitterTitle' ? 'emitter' : 'module', title: d, start: n === 'ShurikenEmitterTitle' ? d.y + d.h : start, end, label: d.t ?? '' })
    }
  }
  return out
}

export function closedRanges(folds: Fold[], closed: Set<string>): [number, number][] {
  const rs = folds.filter((f) => closed.has(f.key)).map((f) => [f.start, f.end] as [number, number]).sort((a, b) => a[0] - b[0])
  const out: [number, number][] = []
  for (const r of rs) {
    const last = out[out.length - 1]
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1])
    else out.push([...r])
  }
  return out
}

export function toView(y: number, ranges: [number, number][]): number {
  let off = 0
  for (const [a, b] of ranges) {
    if (y >= b) off += b - a
    else if (y > a) return a - off
  }
  return y - off
}

export function toFull(y: number, ranges: [number, number][]): number {
  let out = y
  for (const [a, b] of ranges) if (out >= a) out += b - a
  return out
}

export function viewSection(full: TiSection, ranges: [number, number][], y: number): TiSection {
  if (!ranges.length) return { ...full, y }
  const map = <T extends TiRect>(list: T[] | undefined): T[] | undefined => {
    if (!list) return list
    const out: T[] = []
    for (const r of list) {
      if (ranges.some(([a, b]) => r.y >= a - 0.01 && r.y < b - 0.01)) continue
      const y0 = toView(r.y, ranges)
      const y1 = toView(r.y + r.h, ranges)
      out.push(y0 === r.y && y1 - y0 === r.h ? r : { ...r, y: y0, h: Math.max(0, y1 - y0) })
    }
    return out
  }
  return {
    ...full,
    y,
    h: toView(full.h, ranges),
    draws: map(full.draws as (TiDraw & TiRect)[]) as TiDraw[],
    props: map(full.props),
    cursors: map(full.cursors),
    clips: map(full.clips),
    scrolls: map(full.scrolls)
  }
}

