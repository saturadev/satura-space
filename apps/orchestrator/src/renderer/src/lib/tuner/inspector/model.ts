import type {
  TiCapture,
  TiPopup,
  TiRect,
  TiSection,
  TiStyle,
  TiStyleState,
  TiTargetInfo,
  TiTextFocus,
  TiTexture
} from '@shared/tuner-inspector'

export interface InspectorView {
  session: string
  seq: number
  width: number
  height: number
  ms: number
  bytes: number
  target: TiTargetInfo
  sections: TiSection[]
  focus?: TiTextFocus
  popups: TiPopup[]
  hot: boolean
  fontDir?: string
}

export interface ApplyResult {
  view: InspectorView | null
  needFull: boolean
  newTextures: TiTexture[]
}

export class InspectorModel {
  readonly styles = new Map<number, TiStyle>()
  private sections = new Map<string, TiSection>()
  private lastSeq = 0
  fontDir: string | undefined
  view: InspectorView | null = null

  reset(): void {
    this.styles.clear()
    this.sections.clear()
    this.lastSeq = 0
    this.view = null
  }

  apply(c: TiCapture, bytes: number): ApplyResult {
    if (c.reset) {
      this.styles.clear()
      this.sections.clear()
      this.lastSeq = 0
    } else if (c.seq <= this.lastSeq) {
      return { view: null, needFull: false, newTextures: [] }
    }
    this.lastSeq = c.seq
    if (c.fontDir) this.fontDir = c.fontDir
    for (const s of c.styles ?? []) this.styles.set(s.id, s)
    let needFull = false
    const next = new Map<string, TiSection>()
    const ordered: TiSection[] = []
    for (const s of c.sections) {
      let sec: TiSection
      if (s.same) {
        const prev = this.sections.get(s.key)
        if (!prev || prev.hash !== s.hash) {
          needFull = true
          continue
        }
        sec = prev.x === s.x && prev.y === s.y && prev.w === s.w && prev.h === s.h ? prev : { ...prev, x: s.x, y: s.y, w: s.w, h: s.h }
      } else sec = s
      next.set(sec.key, sec)
      ordered.push(sec)
    }
    this.sections = next
    this.view = {
      session: c.session,
      seq: c.seq,
      width: c.width,
      height: c.height,
      ms: c.ms,
      bytes,
      target: c.target,
      sections: ordered,
      focus: c.focus,
      popups: c.popups ?? [],
      hot: c.hot === true,
      fontDir: this.fontDir
    }
    return { view: this.view, needFull, newTextures: c.textures ?? [] }
  }
}

export interface Rgba {
  r: number
  g: number
  b: number
  a: number
}

export function parseHex(hex: string | undefined): Rgba | null {
  if (!hex || hex.length < 6) return null
  const n = (i: number): number => parseInt(hex.slice(i, i + 2), 16) / 255
  return { r: n(0), g: n(2), b: n(4), a: hex.length >= 8 ? n(6) : 1 }
}

export function mulColor(a: Rgba | null, b: Rgba | null): Rgba | null {
  if (!a) return b
  if (!b) return a
  return { r: a.r * b.r, g: a.g * b.g, b: a.b * b.b, a: a.a * b.a }
}

export function cssColor(c: Rgba | null, alphaScale = 1): string | undefined {
  if (!c) return undefined
  const k = (v: number): number => Math.round(Math.max(0, Math.min(1, v)) * 255)
  return `rgba(${k(c.r)},${k(c.g)},${k(c.b)},${Math.max(0, Math.min(1, c.a * alphaScale)).toFixed(3)})`
}

export function isWhite(c: Rgba | null): boolean {
  return !c || (c.r > 0.998 && c.g > 0.998 && c.b > 0.998 && c.a > 0.998)
}

export interface StateFlags {
  on: boolean
  hover: boolean
  active: boolean
  focus: boolean
}

export function pickState(style: TiStyle, f: StateFlags): TiStyleState {
  const s = style.s
  const has = (x: TiStyleState | undefined): boolean => !!x && (x.bg !== undefined || x.bg2 !== undefined || x.hb === 1)
  const normal = s.n ?? {}
  let r: TiStyleState = f.on && s.on ? s.on : normal
  if (f.on && s.on && !has(s.on) && has(normal)) r = { ...normal, tc: s.on.tc ?? normal.tc }
  if (f.on) {
    if (f.hover && has(s.onh)) r = s.onh as TiStyleState
    if (f.focus && has(s.onf)) r = s.onf as TiStyleState
    if (f.active && has(s.ona)) r = s.ona as TiStyleState
  } else {
    if (f.hover && has(s.h)) r = s.h as TiStyleState
    if (f.focus && has(s.f)) r = s.f as TiStyleState
    if (f.active && has(s.a)) r = s.a as TiStyleState
  }
  return r
}

export function contains(r: TiRect, x: number, y: number): boolean {
  return x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h
}

export interface ClickMark {
  t: number
  x: number
  y: number
  button: number
  n: number
}

export const MULTI_CLICK_MS = 500

function nextClick(prev: ClickMark | null, t: number, x: number, y: number, button: number): ClickMark {
  const again = prev && prev.button === button && t - prev.t <= MULTI_CLICK_MS && Math.abs(x - prev.x) <= 4 && Math.abs(y - prev.y) <= 4
  return { t, x, y, button, n: again ? prev.n + 1 : 1 }
}

export function pressClick(prev: ClickMark | null, t: number, x: number, y: number, button: number, detail: number): ClickMark {
  const mark = nextClick(prev, t, x, y, button)
  return detail > mark.n ? { ...mark, n: detail } : mark
}

export function propsUnder(sec: Pick<TiSection, 'props'>, x: number, y: number): string[] {
  let best = Infinity
  let paths: string[] = []
  for (const p of sec.props ?? []) {
    if (p.c !== undefined || !contains(p, x, y)) continue
    const area = p.w * p.h
    if (area < best) {
      best = area
      paths = [p.p]
    } else if (area === best) paths.push(p.p)
  }
  return paths
}

export function trackKey(sec: Pick<TiSection, 'key' | 'kind' | 'type'>): string | null {
  if (sec.kind === 'component' || sec.kind === 'gameObject' || sec.kind === 'material') return sec.key
  if (sec.kind === 'asset' || sec.kind === 'imported') return sec.type ? (sec.type.split(/[.+]/).pop() ?? sec.type) : null
  return null
}

export function unityKeyCode(e: { key: string; code: string }): string | null {
  const k = e.key
  switch (k) {
    case 'ArrowUp':
      return 'UpArrow'
    case 'ArrowDown':
      return 'DownArrow'
    case 'ArrowLeft':
      return 'LeftArrow'
    case 'ArrowRight':
      return 'RightArrow'
    case 'Enter':
      return 'Return'
    case 'Escape':
      return 'Escape'
    case 'Tab':
      return 'Tab'
    case 'Backspace':
      return 'Backspace'
    case 'Delete':
      return 'Delete'
    case ' ':
      return 'Space'
    case 'Home':
      return 'Home'
    case 'End':
      return 'End'
    case 'PageUp':
      return 'PageUp'
    case 'PageDown':
      return 'PageDown'
  }
  if (/^F\d{1,2}$/.test(k)) return k
  if (/^Key[A-Z]$/.test(e.code)) return e.code.slice(3)
  if (/^Digit\d$/.test(e.code)) return `Alpha${e.code.slice(5)}`
  return null
}

export interface RichRun {
  text: string
  bold?: boolean
  italic?: boolean
  color?: string
  size?: number
}

const NAMED: Record<string, string> = {
  red: '#ff0000',
  green: '#008000',
  blue: '#0000ff',
  white: '#ffffff',
  black: '#000000',
  yellow: '#ffff00',
  cyan: '#00ffff',
  magenta: '#ff00ff',
  grey: '#808080',
  gray: '#808080',
  orange: '#ffa500',
  lightblue: '#add8e6',
  lime: '#00ff00',
  brown: '#a52a2a',
  purple: '#800080',
  maroon: '#800000',
  navy: '#000080',
  olive: '#808000',
  silver: '#c0c0c0',
  teal: '#008080',
  aqua: '#00ffff'
}

export function parseRichText(text: string): RichRun[] {
  const runs: RichRun[] = []
  const stack: { tag: string; value?: string }[] = []
  const re = /<(\/?)(b|i|color|size)(?:=("?)([^>"]*)\3)?>/gi
  let last = 0
  const push = (t: string): void => {
    if (!t) return
    const run: RichRun = { text: t }
    for (const s of stack) {
      if (s.tag === 'b') run.bold = true
      else if (s.tag === 'i') run.italic = true
      else if (s.tag === 'color' && s.value) run.color = NAMED[s.value.toLowerCase()] ?? s.value
      else if (s.tag === 'size' && s.value && Number.isFinite(Number(s.value))) run.size = Number(s.value)
    }
    runs.push(run)
  }
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    push(text.slice(last, m.index))
    last = m.index + m[0].length
    const tag = m[2].toLowerCase()
    if (m[1]) {
      for (let i = stack.length - 1; i >= 0; i--)
        if (stack[i].tag === tag) {
          stack.splice(i, 1)
          break
        }
    } else stack.push({ tag, value: m[4] })
  }
  push(text.slice(last))
  return runs
}

export interface MenuNode {
  label: string
  index: number
  enabled: boolean
  checked: boolean
  separator: boolean
  children: MenuNode[]
}

export function buildMenuTree(items: { t: string; e?: boolean; c?: boolean; s?: boolean }[]): MenuNode[] {
  const root: MenuNode = { label: '', index: -1, enabled: true, checked: false, separator: false, children: [] }
  const folder = (parts: string[]): MenuNode => {
    let node = root
    for (const p of parts) {
      let child = node.children.find((c) => c.index === -1 && !c.separator && c.label === p)
      if (!child) {
        child = { label: p, index: -1, enabled: true, checked: false, separator: false, children: [] }
        node.children.push(child)
      }
      node = child
    }
    return node
  }
  items.forEach((it, i) => {
    const text = it.t ?? ''
    if (it.s || text === '') {
      const parts = text.split('/').filter((p, k, a) => p !== '' || k < a.length - 1)
      const dir = folder(parts.filter((p) => p !== ''))
      if (dir.children.length && !dir.children[dir.children.length - 1].separator)
        dir.children.push({ label: '', index: -1, enabled: false, checked: false, separator: true, children: [] })
      return
    }
    const parts = text.split('/')
    const leaf = parts.pop() ?? ''
    const dir = folder(parts)
    dir.children.push({ label: leaf, index: i, enabled: it.e !== false, checked: it.c === true, separator: false, children: [] })
  })
  const trim = (n: MenuNode): void => {
    while (n.children.length && n.children[n.children.length - 1].separator) n.children.pop()
    while (n.children.length && n.children[0].separator) n.children.shift()
    n.children.forEach(trim)
  }
  trim(root)
  return root.children
}
