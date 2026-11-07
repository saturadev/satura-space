import type { TiCapture, TiCurveDraw, TiPopup, TiProp, TiSection, TiStyle, TiStyleDraw, TiTextFocus, TiTexture, TunerInspectorInput } from '@shared/tuner-inspector'
import type { TunerColor, TunerCurve, TunerDropdownItem, TunerGradient, TunerObjectRef } from '@shared/tuner-inspector-popups'
import { decodeCurve, evaluate } from '@renderer/components/tuner/inspector/popups/curve-math'
import { evaluateGradient } from '@renderer/components/tuner/inspector/popups/gradient-math'
import { closedRanges, findFolds, strip, toFull, toView, viewSection, widen, type Fold } from './capture'

export interface StoredCapture extends Omit<TiCapture, 'session' | 'styles' | 'textures'> {
  styleRefs: [number, number][]
  texRefs: [number, number][]
}

export interface ExportField {
  component: string
  path: string
  type: string
  label?: string
  value?: unknown
  names?: string[]
  ref?: string
  min?: number
  max?: number
}

export interface ObjectChoice {
  name: string
  typeName: string
  ref: TunerObjectRef
}

export interface DocCtx {
  fields: ExportField[]
  componentOf: (section: string) => string
  objects: (typeName: string) => ObjectChoice[]
  addable: () => { type: string; label: string }[]
  canPaste: (section: string) => boolean
}

export type Change =
  | { kind: 'number'; section: string; prop: string; value: number; final: boolean; before?: number }
  | { kind: 'bool'; section: string; prop: string; value: boolean }
  | { kind: 'enum'; section: string; prop: string; index: number; label: string; before: string }
  | { kind: 'color'; section: string; prop: string; value: TunerColor; final: boolean; before: TunerColor }
  | { kind: 'gradient'; section: string; prop: string; value: TunerGradient; final: boolean; before: TunerGradient }
  | { kind: 'curve'; section: string; prop: string; value: TunerCurve; final: boolean; before: TunerCurve }
  | { kind: 'object'; section: string; prop: string; name: string; before: string; ref: TunerObjectRef | null }
  | { kind: 'name'; value: string; before: string }
  | { kind: 'tool'; section: string; on: boolean }
  | { kind: 'link'; on: boolean }
  | { kind: 'menu'; section: string; action: 'reset' | 'remove' | 'copy' | 'paste' | 'up' | 'down' }
  | { kind: 'add'; type: string }
  | { kind: 'ping'; section: string; prop: string }
  | { kind: 'fold'; key: string; open: boolean }

export interface FieldRange {
  min: number
  max: number
}

type Drag =
  | { kind: 'slider'; section: string; track: TiStyleDraw; prop: TiProp; range: FieldRange; before: number }
  | { kind: 'label'; section: string; prop: TiProp; value: number; integer: boolean; acc: number; before: number }
  | { kind: 'toggle'; section: string; draw: TiStyleDraw; prop: TiProp | null; ly: number }

interface OpenPopup {
  popup: TiPopup
  answer: (action: 'change' | 'commit' | 'cancel', value: unknown) => Change | null
}

const TAGS = ['Untagged', 'Respawn', 'Finish', 'EditorOnly', 'MainCamera', 'Player', 'GameController']
const LAYERS = ['Default', 'TransparentFX', 'Ignore Raycast', 'Water', 'UI']
const MASKS = ['Nothing', 'Everything', 'Default', 'TransparentFX', 'Ignore Raycast', 'Water', 'UI']
const FIXED_ENUMS: Record<string, string[]> = {
  m_Type: ['Spot', 'Directional', 'Point', 'Area (baked only)'],
  m_Lightmapping: ['Realtime', 'Mixed', 'Baked'],
  moveWithTransform: ['Local', 'World', 'Custom'],
  scalingMode: ['Hierarchy', 'Local', 'Shape'],
  'InitialModule.gravitySource': ['3D Physics', '2D Physics'],
  'VelocityModule.inWorldSpace': ['Local', 'World'],
  'ForceModule.inWorldSpace': ['Local', 'World'],
  m_Interpolate: ['None', 'Interpolate', 'Extrapolate'],
  m_CollisionDetection: ['Discrete', 'Continuous', 'Continuous Dynamic', 'Continuous Speculative'],
  m_LightProbeUsage: ['Off', 'Blend Probes', 'Use Proxy Volume', 'Custom Provided'],
  m_ReflectionProbeUsage: ['Off', 'Blend Probes', 'Blend Probes And Skybox', 'Simple'],
  m_Direction: ['X-Axis', 'Y-Axis', 'Z-Axis'],
  m_UpdateMode: ['Normal', 'Animate Physics', 'Unscaled Time'],
  m_CullingMode: ['Always Animate', 'Cull Update Transforms', 'Cull Completely'],
  m_Antialiasing: ['No Anti-aliasing', 'Fast Approximate Anti-aliasing (FXAA)', 'Subpixel Morphological Anti-aliasing (SMAA)', 'Temporal Anti-aliasing (TAA)'],
  m_RequiresOpaqueTextureOption: ['Off', 'On', 'Use settings from Render Pipeline Asset'],
  m_RequiresDepthTextureOption: ['Off', 'On', 'Use settings from Render Pipeline Asset'],
  m_TargetDisplay: ['Display 1', 'Display 2', 'Display 3', 'Display 4', 'Display 5', 'Display 6', 'Display 7', 'Display 8'],
  m_AllowXRRendering: ['Off', 'On'],
  m_UsePipelineSettings: ['Custom', 'Use settings from Render Pipeline Asset'],
  m_SoftShadowQuality: ['Use settings from Render Pipeline Asset', 'Low', 'Medium', 'High'],
  m_CameraType: ['Base', 'Overlay'],
  m_RendererIndex: ['Default Renderer (KS_URP_Renderer)'],
  m_ClearFlags: ['Skybox', 'Solid Color', 'Depth only', "Don't Clear"]
}

const BY_LABEL: Record<string, string[]> = {
  'Background Type': ['Skybox', 'Solid Color', 'Uninitialized'],
  'Anti-aliasing': ['No Anti-aliasing', 'Fast Approximate Anti-aliasing (FXAA)', 'Subpixel Morphological Anti-aliasing (SMAA)', 'Temporal Anti-aliasing (TAA)'],
  Renderer: ['Default Renderer (KS_URP_Renderer)'],
  'Target Display': ['Display 1', 'Display 2', 'Display 3', 'Display 4'],
  'Target Eye': ['Both', 'Left', 'Right', 'None (Main Display)'],
  Quality: ['Use settings from Render Pipeline Asset', 'Low', 'Medium', 'High'],
  'Update Mode': ['Use Pipeline Settings', 'Every Frame', 'Via Scripting']
}

function inside(r: { x: number; y: number; w: number; h: number }, x: number, y: number): boolean {
  return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h
}

export function formatFloat(v: number): string {
  if (!Number.isFinite(v)) return '0'
  if (Math.abs(v) < 1e-6) return '0'
  const s = String(parseFloat(v.toPrecision(7)))
  return s === '-0' ? '0' : s
}

export function roundToDiff(v: number, diff: number): number {
  if (diff === 0) return v
  const decimals = Math.max(0, Math.min(15, -Math.floor(Math.log10(Math.abs(diff)))))
  const k = Math.pow(10, decimals)
  return Math.round(v * k) / k
}

function hex(c: TunerColor, alpha = true): string {
  const b = (v: number): string =>
    Math.round(Math.max(0, Math.min(1, v)) * 255)
      .toString(16)
      .padStart(2, '0')
  return `${b(c.r)}${b(c.g)}${b(c.b)}${alpha ? b(c.a) : 'ff'}`
}

function colorOf(v: unknown): TunerColor | null {
  if (Array.isArray(v) && v.length >= 3) return { r: v[0], g: v[1], b: v[2], a: v[3] ?? 1 }
  return null
}

function hash3(x: number, y: number, z: number): number {
  const h = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453
  return (h - Math.floor(h)) * 2 - 1
}

function noise3(x: number, y: number, z: number): number {
  const xi = Math.floor(x)
  const yi = Math.floor(y)
  const zi = Math.floor(z)
  const s = (t: number): number => t * t * (3 - 2 * t)
  const u = s(x - xi)
  const v = s(y - yi)
  const w = s(z - zi)
  const l = (a: number, b: number, t: number): number => a + (b - a) * t
  const c = (i: number, j: number, k: number): number => hash3(xi + i, yi + j, zi + k)
  return l(l(l(c(0, 0, 0), c(1, 0, 0), u), l(c(0, 1, 0), c(1, 1, 0), u), v), l(l(c(0, 0, 1), c(1, 0, 1), u), l(c(0, 1, 1), c(1, 1, 1), u), v), w)
}

function bump(sec: TiSection): void {
  sec.hash = `${sec.hash.split('~')[0]}~${Math.random().toString(36).slice(2, 8)}`
}

let popupSeq = 1

export class InspectorDoc {
  readonly path: string
  readonly base: StoredCapture
  full: TiSection[]
  folds: Fold[] = []
  closed = new Set<string>()
  removed = new Set<string>()
  extra = new Map<string, TiTexture>()
  colors = new Map<string, TunerColor>()
  gradients = new Map<string, TunerGradient>()
  curves = new Map<string, TunerCurve>()
  tool: string | null = null
  link = false
  at: { path: string; name: string } | null = null
  private styles: Map<number, TiStyle>
  private names: Map<number, string>
  private drag: Drag | null = null
  private focus: { section: string; control: number; numeric: boolean; prop: TiProp | null; name: boolean; text: string } | null = null
  private pending: { section: string; control: number; numeric: boolean; prop: TiProp | null; name: boolean; text: string } | null = null
  private popup: OpenPopup | null = null
  private pings: { section: string; prop: string }[] = []
  private ctx: DocCtx
  private texSeq = 900000
  private newStyles: TiStyle[] = []

  constructor(path: string, base: StoredCapture, stylePool: Omit<TiStyle, 'id'>[], ctx: DocCtx, width = 0) {
    this.path = path
    this.base = base
    this.ctx = ctx
    this.styles = new Map(base.styleRefs.map(([id, i]) => [id, { ...(stylePool[i] as TiStyle), id }]))
    this.names = new Map([...this.styles.values()].map((s) => [s.id, s.n]))
    this.full = structuredClone(base.sections)
    for (const sec of this.full) {
      const bottom = Math.max(0, ...(sec.draws ?? []).map((d) => d.y + d.h))
      if (sec.kind === 'component' && bottom > sec.h) sec.h = Math.ceil(bottom + 2)
    }
    for (const sec of this.full) strip(sec, this.name)
    if (width > 0) for (const sec of this.full) widen(sec, width)
    for (const sec of this.full) this.folds.push(...findFolds(sec, this.name))
    for (const f of this.folds) {
      const open = f.title.on === 1
      if (f.kind === 'module' && !/^(Emission|Shape|Color over Lifetime|Size over Lifetime)$/.test(f.label)) this.closed.add(f.key)
      else if (f.kind === 'foldout' && /Layer Overrides|Constraints/.test(f.label)) this.closed.add(f.key)
      else if (f.kind === 'header' && /Lightmapping|Probes|Additional Settings/.test(f.label)) this.closed.add(f.key)
      else if (!open && f.kind !== 'section') this.closed.add(f.key)
    }
    for (const f of ctx.fields) {
      const key = `${ctx.componentOf(f.component)}|${f.path}`
      const c = f.type === 'Color' ? colorOf(f.value) : null
      if (c) this.colors.set(key, c)
      if (f.type === 'Gradient' && f.value) this.gradients.set(key, f.value as TunerGradient)
      if (f.type === 'AnimationCurve' && f.value) this.curves.set(key, f.value as TunerCurve)
    }
    if (this.section('ParticleSystem')) this.paintNoise('ParticleSystem')
  }

  name = (d: TiStyleDraw): string => this.names.get(d.st) ?? ''

  get addedStyles(): TiStyle[] {
    return this.newStyles
  }

  addStyles(list: TiStyle[]): void {
    for (const st of list) {
      if (this.styles.has(st.id)) continue
      this.styles.set(st.id, st)
      this.names.set(st.id, st.n)
      this.newStyles.push(st)
    }
  }

  adopt(src: InspectorDoc, key: string, texPool: Omit<TiTexture, 'id'>[]): { sec: TiSection; folds: Fold[]; closed: string[] } | null {
    const from = src.section(key)
    if (!from) return null
    const sec = structuredClone(from)
    const myStyle = new Map(this.base.styleRefs.map(([id, i]) => [i, id]))
    const srcStyle = new Map(src.base.styleRefs)
    const myTex = new Map(this.base.texRefs.map(([id, i]) => [i, id]))
    const srcTex = new Map(src.base.texRefs)
    const texMap = new Map<number, number>()
    const tex = (id: number): number => {
      const done = texMap.get(id)
      if (done != null) return done
      const pi = srcTex.get(id)
      let mine = pi != null ? myTex.get(pi) : undefined
      if (mine == null && pi != null) {
        mine = ++this.texSeq
        myTex.set(pi, mine)
        this.extra.set(String(mine), { ...(texPool[pi] as TiTexture), id: mine })
      }
      texMap.set(id, mine ?? id)
      return mine ?? id
    }
    const styleMap = new Map<number, number>()
    let next = Math.max(0, ...this.styles.keys()) + 1
    const style = (id: number): number => {
      const done = styleMap.get(id)
      if (done != null) return done
      const pi = srcStyle.get(id)
      let mine = pi != null ? myStyle.get(pi) : undefined
      if (mine == null) {
        const body = src.styles.get(id)
        if (!body) return id
        mine = next++
        const copy: TiStyle = structuredClone({ ...body, id: mine })
        for (const st of Object.values(copy.s ?? {})) {
          if (st?.bg != null) st.bg = tex(st.bg)
          if (st?.bg2 != null) st.bg2 = tex(st.bg2)
        }
        this.styles.set(mine, copy)
        this.names.set(mine, copy.n)
        this.newStyles.push(copy)
        if (pi != null) myStyle.set(pi, mine)
      }
      styleMap.set(id, mine)
      return mine
    }
    for (const d of sec.draws ?? []) {
      if (d.k === 's') {
        d.st = style(d.st)
        if (d.img != null) d.img = tex(d.img)
      } else if (d.k === 't') d.tex = tex(d.tex)
    }
    const folds = findFolds(sec, this.name)
    const closed = src.folds.filter((f) => f.section === key && src.closed.has(f.key)).map((f) => f.key)
    return { sec, folds, closed }
  }

  section(key: string): TiSection | undefined {
    return this.full.find((s) => s.key === key)
  }

  private sd(sec: TiSection): TiStyleDraw[] {
    return (sec.draws ?? []).filter((d): d is TiStyleDraw => d.k === 's')
  }

  private ranges(key: string): [number, number][] {
    const sec = this.section(key)
    if (!sec) return []
    if (this.closed.has(`${key}#`)) return [[22, sec.h]]
    return closedRanges(
      this.folds.filter((f) => f.section === key),
      this.closed
    )
  }

  sections(): TiSection[] {
    const out: TiSection[] = []
    let y = 0
    for (const sec of this.full) {
      if (this.removed.has(sec.key)) continue
      const v = structuredClone(viewSection(sec, this.ranges(sec.key), y))
      out.push(v)
      y += v.h
    }
    return out
  }

  height(): number {
    return this.sections().reduce((a, s) => a + s.h, 0)
  }

  private texturesFor(): TiTexture[] {
    return [...this.extra.values()]
  }

  private retarget(): { target?: unknown } {
    const t = (this.base as unknown as { target?: Record<string, unknown> }).target
    return this.at && t ? { target: { ...t, path: this.at.path, name: this.at.name } } : {}
  }

  full_(session: string, texPool: Omit<TiTexture, 'id'>[], seq: number): TiCapture {
    const secs = this.sections()
    return {
      ...this.base,
      ...this.retarget(),
      session,
      seq,
      reset: true,
      height: secs.reduce((a, s) => a + s.h, 0),
      sections: secs,
      styles: [...this.styles.values()],
      textures: [...this.base.texRefs.map(([id, i]) => ({ ...(texPool[i] as TiTexture), id })), ...this.texturesFor()],
      focus: undefined
    } as TiCapture
  }

  update(session: string, seq: number, hot = false): TiCapture {
    const { styleRefs: _a, texRefs: _b, reset: _r, ...rest } = this.base
    const secs = this.sections()
    const out = { ...rest, ...this.retarget(), session, seq, height: secs.reduce((a, s) => a + s.h, 0), sections: secs } as TiCapture
    const f = this.viewFocus()
    if (f) out.focus = f
    if (this.popup) out.popups = [this.popup.popup]
    if (this.extra.size) out.textures = this.texturesFor()
    if (this.newStyles.length) out.styles = [...this.newStyles]
    if (this.pings.length) {
      out.pings = this.pings.map(() => ({ kind: 'object', path: this.path }))
      this.pings = []
    }
    if (hot) out.hot = true
    return out
  }

  private viewFocus(): TiTextFocus | undefined {
    const f = this.focus
    if (!f) return undefined
    const sec = this.section(f.section)
    const d = sec ? this.sd(sec).find((x) => x.id === f.control && this.isField(x)) : null
    if (!sec || !d) return undefined
    const r = this.ranges(sec.key)
    return { section: f.section, control: f.control, x: d.x, y: toView(d.y, r), w: d.w, h: d.h, text: f.text, style: d.st, numeric: f.numeric, editing: true }
  }

  private isField(d: TiStyleDraw): boolean {
    const n = this.name(d)
    return /textfield/i.test(n) || n === 'ShurikenValue'
  }

  private propAt(sec: TiSection, x: number, y: number, kinds?: RegExp): TiProp | null {
    const hits = (sec.props ?? []).filter((p) => inside(p, x, y) && p.k !== 'Vector3' && p.k !== 'Quaternion' && p.k !== 'Generic' && (!kinds || kinds.test(p.k)))
    hits.sort((a, b) => a.w * a.h - b.w * b.h)
    if (hits[0]) return hits[0]
    const row = (sec.props ?? []).filter((p) => Math.abs(p.y - y) < 8 && p.k !== 'Generic' && p.k !== 'Vector3' && (!kinds || kinds.test(p.k)))
    row.sort((a, b) => Math.abs(a.x - x) - Math.abs(b.x - x))
    return row[0] ?? null
  }

  propOf(sec: TiSection, d: TiStyleDraw, kinds?: RegExp): TiProp | null {
    return this.propAt(sec, d.x + Math.min(d.w / 2, 30), d.y + d.h / 2, kinds)
  }

  fieldDraw(key: string, prop: string): TiStyleDraw | null {
    const sec = this.section(key)
    const p = sec?.props?.find((x) => x.p === prop)
    if (!sec || !p) return null
    return this.sd(sec).find((d) => this.isField(d) && d.x >= p.x - 0.5 && d.x + d.w <= p.x + p.w + 0.5 && Math.abs(d.y - p.y) < 2) ?? null
  }

  read(key: string, prop: string): number | null {
    const d = this.fieldDraw(key, prop)
    if (!d?.t) return null
    const v = parseFloat(d.t)
    return Number.isFinite(v) ? v : null
  }

  readText(key: string, prop: string): string | null {
    const sec = this.section(key)
    const p = sec?.props?.find((x) => x.p === prop)
    if (!sec || !p) return null
    const d = this.sd(sec).find((x) => /Popup|PullDown|ObjectField$/.test(this.name(x)) && Math.abs(x.y - p.y) < 3 && x.x >= p.x - 1)
    return d?.t ?? null
  }

  toggleDraw(key: string, prop: string): TiStyleDraw | null {
    const sec = this.section(key)
    const p = sec?.props?.find((x) => x.p === prop)
    if (!sec || !p) return null
    return this.sd(sec).find((d) => /^(toggle|ShurikenToggle)$/.test(this.name(d)) && Math.abs(d.y - p.y) < 3 && d.x >= p.x - 6 && d.x <= p.x + p.w) ?? null
  }

  readToggle(key: string, prop: string): boolean | null {
    const d = this.toggleDraw(key, prop)
    return d ? d.on === 1 : null
  }

  private range(key: string, prop: string): FieldRange | null {
    const comp = this.ctx.componentOf(key)
    const f = this.ctx.fields.find((x) => x.component === comp && x.path === prop && x.min != null && x.max != null)
    if (f) return { min: f.min!, max: f.max! }
    if (prop === 'field of view') return { min: 1, max: 179 }
    if (prop === 'm_SpotAngle') return { min: 1, max: 179 }
    if (prop === 'm_Shadows.m_Strength') return { min: 0, max: 1 }
    return null
  }

  write(key: string, prop: string, value: number, integer = false): boolean {
    const sec = this.section(key)
    const d = this.fieldDraw(key, prop)
    if (!sec || !d) return false
    const text = integer ? String(Math.round(value)) : formatFloat(value)
    if (d.t === text) return false
    d.t = text
    const p = sec.props?.find((x) => x.p === prop)
    const range = this.range(key, prop)
    if (p && range) this.placeThumb(sec, p, range, value)
    if (prop.startsWith('NoiseModule.')) this.paintNoise(key)
    bump(sec)
    return true
  }

  paintNoise(key: string): void {
    const sec = this.section(key)
    const d = sec ? this.sd(sec).find((x) => x.t === 'Preview' && x.img != null) : null
    if (!sec || !d) return
    const num = (p: string, v: number): number => this.read(key, p) ?? v
    const strength = num('NoiseModule.strength.scalar', 1)
    const frequency = num('NoiseModule.frequency', 0.5)
    const scroll = num('NoiseModule.scrollSpeed.scalar', 0)
    const octaves = Math.max(1, Math.min(4, Math.round(num('NoiseModule.octaves', 1))))
    const mult = num('NoiseModule.octaveMultiplier', 0.5)
    const scale = num('NoiseModule.octaveScale', 2)
    const quality = this.readText(key, 'NoiseModule.quality') ?? ''
    const oneD = /1D/.test(quality)
    const z = scroll * 0.25
    const N = 96
    if (d.img != null && d.img > 900000) this.extra.delete(String(d.img))
    d.img = this.paintTexture(N, N, (g) => {
      for (let y = 0; y < N; y++)
        for (let x = 0; x < N; x++) {
          let f = frequency * 4
          let a = 1
          let n = 0
          for (let o = 0; o < octaves; o++) {
            n += a * noise3((x / N) * f, oneD ? 0 : (y / N) * f, z + o * 7.3)
            a *= mult
            f *= scale
          }
          const v = Math.round(255 * Math.max(0, Math.min(1, 0.5 + n * strength * 1.5)))
          g.fillStyle = `rgb(${v},${v},${v})`
          g.fillRect(x, y, 1, 1)
        }
    })
  }

  writeToggle(key: string, prop: string, on: boolean): void {
    const sec = this.section(key)
    const d = this.toggleDraw(key, prop)
    if (!sec || !d) return
    if (on) d.on = 1
    else delete d.on
    bump(sec)
  }

  writeText(key: string, prop: string, text: string): void {
    const sec = this.section(key)
    const p = sec?.props?.find((x) => x.p === prop)
    if (!sec || !p) return
    for (const d of this.sd(sec)) if (/Popup|PullDown|ObjectField$/.test(this.name(d)) && Math.abs(d.y - p.y) < 3 && d.x >= p.x - 1 && d.t != null) d.t = text
    if (prop.startsWith('NoiseModule.')) this.paintNoise(key)
    bump(sec)
  }

  writeName(name: string): void {
    const sec = this.section('GameObject')
    if (!sec) return
    for (const d of this.sd(sec)) if (this.name(d) === 'BoldTextField') d.t = name
    bump(sec)
  }

  writeColor(key: string, prop: string, c: TunerColor): void {
    this.colors.set(`${key}|${prop}`, c)
    const sec = this.section(key)
    const p = sec?.props?.find((x) => x.p === prop)
    if (!sec || !p) return
    const box = this.sd(sec).find((d) => /ColorField|ColorPickerBox/.test(this.name(d)) && Math.abs(d.y - p.y) < 3)
    if (!box) return
    const inner = this.sd(sec).filter((d) => !this.name(d) && d.x >= box.x && d.x + d.w <= box.x + box.w + 0.5 && d.y >= box.y - 0.5 && d.y + d.h <= box.y + box.h + 0.5)
    inner.sort((a, b) => b.h - a.h)
    if (inner[0]) {
      inner[0].bg = hex(c, false)
      inner[0].fg = hex(c, false)
    }
    const bar = inner.find((d, i) => i > 0 && d.bg)
    if (bar) {
      bar.w = Math.max(0, inner[0].w * c.a)
      bar.bg = 'ffffffff'
      bar.fg = 'ffffffff'
    }
    bump(sec)
  }

  private paintTexture(w: number, h: number, paint: (g: CanvasRenderingContext2D) => void): number {
    const c = document.createElement('canvas')
    c.width = Math.max(1, Math.round(w * 2))
    c.height = Math.max(1, Math.round(h * 2))
    const g = c.getContext('2d')!
    g.scale(2, 2)
    paint(g)
    const id = ++this.texSeq
    this.extra.set(String(id), { id, w: c.width, h: c.height, sc: 2, png: c.toDataURL('image/png').split(',')[1] })
    return id
  }

  writeGradient(key: string, prop: string, g: TunerGradient): void {
    this.gradients.set(`${key}|${prop}`, g)
    const sec = this.section(key)
    const p = sec?.props?.find((x) => x.p === prop || x.p === prop.replace(/\.maxGradient$/, ''))
    if (!sec || !p) return
    const box = this.sd(sec).find((d) => this.name(d) === 'ColorPickerBox' && Math.abs(d.y - p.y) < 3)
    if (!box) return
    const tex = this.paintTexture(box.w, box.h, (ctx) => {
      for (let x = 0; x < box.w; x++) {
        const c = evaluateGradient(g, x / Math.max(1, box.w - 1))
        ctx.fillStyle = `rgba(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)},1)`
        ctx.fillRect(x, 0, 1, box.h)
      }
    })
    const draws = sec.draws ?? []
    const old = draws.findIndex((d) => (d as { gradientOf?: string }).gradientOf === prop)
    const d = { k: 't' as const, x: box.x + 1, y: box.y + 1, w: box.w - 2, h: box.h - 2, tex, gradientOf: prop }
    if (old >= 0) draws[old] = d
    else draws.splice(draws.indexOf(box) + 1, 0, d)
    sec.draws = draws
    bump(sec)
  }

  writeCurve(key: string, prop: string, curve: TunerCurve): void {
    this.curves.set(`${key}|${prop}`, curve)
    const sec = this.section(key)
    const p = sec?.props?.find((x) => x.p === prop || x.p === prop.replace(/\.maxCurve$/, ''))
    if (!sec || !p) return
    const c = (sec.draws ?? []).find((d): d is TiCurveDraw => d.k === 'c' && Math.abs(d.y - p.y) < 3)
    if (!c) return
    const pts: number[] = []
    for (let i = 0; i <= 96; i++) {
      const t = i / 96
      pts.push(Math.round(t * 1000) / 1000, Math.round(Math.max(0, Math.min(1, evaluate(curve, t))) * 1000) / 1000)
    }
    c.pts = pts
    bump(sec)
  }

  private placeThumb(sec: TiSection, p: TiProp, range: FieldRange, value: number): void {
    const ds = this.sd(sec)
    const track = ds.find((d) => this.name(d) === 'horizontalslider' && Math.abs(d.y - p.y) < 1)
    if (!track) return
    const t = Math.max(0, Math.min(1, (value - range.min) / (range.max - range.min || 1)))
    const x = track.x + t * (track.w - 10)
    for (const d of ds) {
      if (d.id !== track.id) continue
      const n = this.name(d)
      if (n === 'horizontalsliderthumb') d.x = Math.round(x * 100) / 100
      else if (n === 'HorizontalSliderThumbExtent') d.x = Math.round((x - 4) * 100) / 100
    }
  }

  private setActive(sec: TiSection, id: number | undefined, on: boolean): void {
    for (const d of this.sd(sec)) {
      if (id == null || d.id !== id) continue
      if (on) d.ac = 1
      else delete d.ac
    }
  }

  private locate(x: number, y: number): { sec: TiSection; lx: number; ly: number } | null {
    let top = 0
    for (const sec of this.full) {
      if (this.removed.has(sec.key)) continue
      const r = this.ranges(sec.key)
      const h = toView(sec.h, r)
      if (y >= top && y < top + h) return { sec, lx: x - sec.x, ly: toFull(y - top, r) }
      top += h
    }
    return null
  }

  sectionTop(key: string): number {
    let top = 0
    for (const sec of this.full) {
      if (this.removed.has(sec.key)) continue
      if (sec.key === key) return top
      top += toView(sec.h, this.ranges(sec.key))
    }
    return 0
  }

  viewRect(key: string, d: { x: number; y: number; w: number; h: number }): { x: number; y: number; w: number; h: number } {
    const sec = this.section(key)
    const r = this.ranges(key)
    return { x: (sec?.x ?? 0) + d.x, y: this.sectionTop(key) + toView(d.y, r), w: d.w, h: d.h }
  }

  dragging(): boolean {
    return this.drag != null
  }

  private openPopup(sec: TiSection, d: TiStyleDraw, kind: TiPopup['kind'], data: unknown, answer: OpenPopup['answer']): void {
    const a = this.viewRect(sec.key, d)
    this.popup = { popup: { id: popupSeq++, kind, anchor: a, section: undefined, data }, answer }
  }

  private toggleFold(f: Fold): Change {
    const open = this.closed.has(f.key)
    if (open) this.closed.delete(f.key)
    else this.closed.add(f.key)
    if (open) f.title.on = 1
    else delete f.title.on
    const sec = this.section(f.section)
    if (sec) bump(sec)
    return { kind: 'fold', key: f.key, open }
  }

  private enumOptions(sec: TiSection, prop: TiProp | null, label: string): string[] {
    if (sec.kind === 'gameObject') return label === 'Tag' ? TAGS : LAYERS
    if (/Layers$|Mask$/.test(label)) return MASKS
    if (BY_LABEL[label] && (!prop || !FIXED_ENUMS[prop.p])) return BY_LABEL[label]
    if (!prop) return []
    if (prop.k === 'LayerMask' || /Mask$|Layers$/.test(prop.p)) return MASKS
    const fixed = FIXED_ENUMS[prop.p]
    if (fixed) return fixed
    const comp = this.ctx.componentOf(sec.key)
    const f = this.ctx.fields.find((x) => (x.component === comp || x.component === `${comp}Renderer`) && x.path === prop.p && x.names?.length) ?? this.ctx.fields.find((x) => x.path === prop.p && x.names?.length)
    return f?.names ?? []
  }

  private menuData(options: string[], current: string): unknown {
    return { options, enabled: options.map(() => true), separator: options.map(() => false), selected: [options.indexOf(current)].filter((i) => i >= 0) }
  }

  private contextMenu(sec: TiSection, d: TiStyleDraw): void {
    type Item = { label: string; action: 'reset' | 'remove' | 'copy' | 'paste' | 'up' | 'down' | null; on: boolean }
    const items: Item[] = [
      { label: 'Reset', action: 'reset', on: true },
      { label: '', action: null, on: false },
      { label: 'Remove Component', action: 'remove', on: sec.key !== 'Transform' },
      { label: '', action: null, on: false },
      { label: 'Copy Component', action: 'copy', on: true },
      { label: 'Paste Component Values', action: 'paste', on: this.ctx.canPaste(sec.key) }
    ]
    this.openPopup(sec, d, 'menu', { options: items.map((i) => i.label), enabled: items.map((i) => i.on), separator: items.map((i) => i.action === null), selected: [], context: 'custom' }, (action, v) => {
      const it = typeof v === 'number' ? items[v] : null
      if (action !== 'commit' || !it || !it.on || !it.action) return null
      return { kind: 'menu', section: sec.key, action: it.action }
    })
  }

  private addComponentMenu(sec: TiSection, d: TiStyleDraw): void {
    const list = this.ctx.addable()
    const items: TunerDropdownItem[] = list.map((x, i) => ({ id: i + 1, name: x.label }))
    this.openPopup(sec, d, 'dropdown', { title: 'Component', items, search: true, addComponent: 'Add Component' }, (action, v) => {
      if (action !== 'commit' || typeof v !== 'number') return null
      const pick = list[v - 1]
      return pick ? { kind: 'add', type: pick.type } : null
    })
  }

  private down(sec: TiSection, lx: number, ly: number, button: number): Change | null {
    const ds = this.sd(sec).filter((d) => !d.off && inside(d, lx, ly))
    const ns = ds.map((d) => this.name(d))
    const pick = (re: RegExp): TiStyleDraw | undefined => ds.filter((d) => re.test(this.name(d))).pop()
    if (sec.kind === 'component' && ly < 22) {
      if (button === 1 || pick(/^PaneOptions$/)) {
        this.contextMenu(sec, pick(/^PaneOptions$/) ?? this.sd(sec)[0])
        return null
      }
      const tg = pick(/^toggle$/)
      if (tg) {
        this.drag = { kind: 'toggle', section: sec.key, draw: tg, prop: sec.props?.find((p) => p.k === 'Boolean' && p.y < 22) ?? null, ly }
        return null
      }
      const f = this.folds.find((x) => x.key === `${sec.key}#`)
      return f ? this.toggleFold(f) : null
    }
    const fold = this.folds.find((f) => f.section === sec.key && f.kind !== 'section' && inside(f.title, lx, ly))
    const toggle = pick(/^(toggle|ShurikenToggle)$/)
    if (fold && !toggle) return this.toggleFold(fold)
    if (toggle) {
      this.drag = { kind: 'toggle', section: sec.key, draw: toggle, prop: this.propOf(sec, toggle, /Boolean|Integer/), ly }
      return null
    }
    const link = pick(/^FloatFieldLinkButton$/)
    if (link) {
      this.link = !this.link
      if (this.link) link.on = 1
      else delete link.on
      bump(sec)
      return { kind: 'link', on: this.link }
    }
    const app = this.sd(sec).find((d) => this.name(d) === 'AppCommand' && inside(d, lx, ly))
    if (app) {
      const on = this.tool !== sec.key
      this.setTool(on ? sec.key : null)
      return { kind: 'tool', section: sec.key, on }
    }
    const ac = pick(/^AC Button$/)
    if (ac) {
      this.addComponentMenu(sec, ac)
      return null
    }
    if (ns.some((n) => /^horizontalslider|HorizontalSliderThumbExtent/.test(n))) {
      const d = pick(/^horizontalslider|HorizontalSliderThumbExtent/)!
      const track = this.sd(sec).find((x) => x.id === d.id && this.name(x) === 'horizontalslider')
      const prop = this.propOf(sec, track ?? d, /Float|Integer/)
      const range = prop ? this.range(sec.key, prop.p) : null
      if (!track || !prop || !range) return null
      this.drag = { kind: 'slider', section: sec.key, track, prop, range, before: this.read(sec.key, prop.p) ?? 0 }
      this.setActive(sec, track.id, true)
      return this.slide(lx, false)
    }
    const popup = pick(/Popup$|PullDown$/)
    if (popup) {
      const label = this.sd(sec).find((x) => /Label$/.test(this.name(x)) && Math.abs(x.y - popup.y) < 3 && x.x < popup.x)?.t ?? ''
      const prop = sec.kind === 'gameObject' ? null : this.propOf(sec, popup)
      const options = this.enumOptions(sec, prop, label)
      if (!options.length) return null
      const before = popup.t ?? ''
      this.openPopup(sec, popup, 'menu', this.menuData(options, before), (action, v) => {
        if (action !== 'commit' || typeof v !== 'number' || !options[v]) return null
        popup.t = options[v]
        bump(sec)
        return { kind: 'enum', section: sec.key, prop: prop?.p ?? label, index: v, label: options[v], before }
      })
      return null
    }
    const color = pick(/^(ColorField|ColorPickerBox)$/)
    if (color) return this.openColorish(sec, color)
    const objBtn = pick(/^ObjectFieldButton$/)
    const obj = pick(/^ObjectField$/)
    if (objBtn || obj) {
      const d = obj ?? objBtn!
      const prop = this.propOf(sec, d, /ObjectReference/)
      if (!prop) return null
      if (!objBtn) {
        this.pings.push({ section: sec.key, prop: prop.p })
        return { kind: 'ping', section: sec.key, prop: prop.p }
      }
      const field = this.sd(sec).find((x) => this.name(x) === 'ObjectField' && Math.abs(x.y - d.y) < 3) ?? d
      const typeName = this.refType(sec, prop)
      const before = field.t ?? ''
      this.openPopup(sec, field, 'object', { type: typeName, typeName, allowSceneObjects: true, current: null, currentName: before, property: prop.p }, (action, v) => {
        if (action !== 'commit' && action !== 'change') return null
        const ref = (v as TunerObjectRef | null) ?? null
        const choice = ref ? this.ctx.objects(typeName).find((c) => c.ref.path === ref.path && (c.ref.guid ?? '') === (ref.guid ?? '')) : null
        const name = choice ? (/Transform|ParticleSystem/.test(typeName) && choice.typeName !== typeName ? `${choice.name}` : choice.name) : `None (${typeName.replace(/^.*\./, '')})`
        const shown = choice && /^(Transform|ParticleSystem)$/.test(typeName) ? `${choice.name} (${typeName === 'Transform' ? 'Transform' : 'Particle System'})` : name
        field.t = shown
        bump(sec)
        return { kind: 'object', section: sec.key, prop: prop.p, name: choice?.name ?? '', before, ref }
      })
      return null
    }
    if (pick(/^BoldTextField$/)) {
      const d = pick(/^BoldTextField$/)!
      this.pending = { section: sec.key, control: d.id!, numeric: false, prop: null, name: true, text: d.t ?? '' }
      return null
    }
    const label = pick(/^(ControlLabel|ShurikenLabel)$/)
    if (label && (sec.cursors ?? []).some((c) => c.c === 'ew-resize' && inside(c, lx, ly))) {
      const prop = this.propAt(sec, lx, ly, /Float|Integer/)
      const v = prop ? this.read(sec.key, prop.p) : null
      if (!prop || v == null) return null
      this.drag = { kind: 'label', section: sec.key, prop, value: v, integer: prop.k === 'Integer', acc: 0, before: v }
      return null
    }
    const field = ds.filter((d) => this.isField(d)).pop()
    if (field) {
      const prop = this.propOf(sec, field, /Float|Integer|ArraySize/)
      if (!prop || prop.k === 'ArraySize') return null
      this.pending = { section: sec.key, control: field.id!, numeric: true, prop, name: false, text: field.t ?? '' }
      return null
    }
    return null
  }

  private refType(sec: TiSection, prop: TiProp): string {
    const comp = this.ctx.componentOf(sec.key)
    const f = this.ctx.fields.find((x) => x.component === comp && x.path === prop.p)
    if (f?.ref) return f.ref
    if (prop.p === 'm_Mesh') return 'Mesh'
    if (/m_Materials/.test(prop.p)) return 'Material'
    if (prop.p === 'm_Controller') return 'RuntimeAnimatorController'
    if (prop.p === 'pitch' || prop.p === 'm_ProbeAnchor') return 'Transform'
    if (prop.p === 'muzzle') return 'ParticleSystem'
    if (prop.p === 'm_Material') return 'PhysicsMaterial'
    if (prop.p === 'm_Avatar') return 'Avatar'
    return 'Object'
  }

  private openColorish(sec: TiSection, box: TiStyleDraw): Change | null {
    const prop = this.propOf(sec, box)
    const parent = (sec.props ?? []).filter((p) => Math.abs(p.y - box.y) < 4).map((p) => p.p)
    const key = (suffix: string): string | null => {
      for (const p of parent) {
        const k = `${sec.key}|${p}${suffix}`
        if (this.colors.has(k) || this.gradients.has(k) || this.curves.has(k)) return `${p}${suffix}`
      }
      return null
    }
    const curveDraw = (sec.draws ?? []).find((d) => d.k === 'c' && Math.abs(d.y - box.y) < 3)
    const ck = curveDraw ? (key('.maxCurve') ?? key('')) : null
    if (ck) {
      const before = this.curves.get(`${sec.key}|${ck}`)!
      this.openPopup(sec, box, 'curve', { value: before, ranges: { x: 0, y: 0, w: 1, h: 1 }, color: '#e0e0e0', property: ck }, (action, v) => {
        if (action === 'cancel') {
          this.writeCurve(sec.key, ck, before)
          return { kind: 'curve', section: sec.key, prop: ck, value: before, final: true, before }
        }
        const c = decodeCurve(v as TunerCurve)
        this.writeCurve(sec.key, ck, c)
        return { kind: 'curve', section: sec.key, prop: ck, value: c, final: action === 'commit', before }
      })
      return null
    }
    const gk = key('.maxGradient') ?? (prop && this.gradients.has(`${sec.key}|${prop.p}`) ? prop.p : null)
    if (gk) {
      const before = this.gradients.get(`${sec.key}|${gk}`)!
      this.openPopup(sec, box, 'gradient', { value: before, hdr: false, property: gk }, (action, v) => {
        const g = action === 'cancel' ? before : (v as TunerGradient)
        this.writeGradient(sec.key, gk, g)
        return { kind: 'gradient', section: sec.key, prop: gk, value: g, final: action !== 'change', before }
      })
      return null
    }
    const k = key('.maxColor') ?? key('') ?? (prop ? prop.p : null)
    if (!k) return null
    const before = this.colors.get(`${sec.key}|${k}`) ?? { r: 1, g: 1, b: 1, a: 1 }
    this.openPopup(sec, box, 'color', { value: before, hdr: false, showAlpha: true, property: k }, (action, v) => {
      const c = action === 'cancel' ? before : (v as TunerColor)
      this.writeColor(sec.key, k, c)
      return { kind: 'color', section: sec.key, prop: k, value: c, final: action !== 'change', before }
    })
    return null
  }

  input(input: TunerInspectorInput): Change | null {
    if (input.op === 'popup') {
      const p = this.popup
      if (!p || p.popup.id !== input.id) return null
      if (input.action !== 'change') this.popup = null
      return p.answer(input.action, input.value)
    }
    if (input.op === 'textCancel') {
      this.focus = null
      return null
    }
    if (input.op === 'text') {
      const f = this.focus
      if (!f || f.control !== input.control) return null
      if (input.commit === 'live') {
        f.text = input.value
        return null
      }
      this.focus = null
      if (f.name) {
        const before = this.section('GameObject') ? (this.sd(this.section('GameObject')!).find((d) => this.name(d) === 'BoldTextField')?.t ?? '') : ''
        const v = input.value.trim()
        if (!v || v === before) return null
        this.writeName(v)
        return { kind: 'name', value: v, before }
      }
      const p = f.prop
      const v = parseFloat(input.value)
      if (!p || !Number.isFinite(v)) return null
      const range = this.range(f.section, p.p)
      const integer = p.k === 'Integer'
      const clamped = range ? Math.max(range.min, Math.min(range.max, v)) : v
      const val = integer ? Math.round(clamped) : clamped
      const before = this.read(f.section, p.p) ?? val
      this.write(f.section, p.p, val, integer)
      return { kind: 'number', section: f.section, prop: p.p, value: val, final: true, before }
    }
    if (input.op !== 'mouse') return null
    if (input.type === 'down') {
      this.focus = null
      this.pending = null
      if (this.popup) this.popup = null
      const hit = this.locate(input.x, input.y)
      if (!hit) return null
      return this.down(hit.sec, hit.lx, hit.ly, input.button)
    }
    if (input.type === 'drag') {
      const g = this.drag
      if (!g) return null
      const sec = this.section(g.section)
      if (!sec) return null
      if (g.kind === 'slider') return this.slide(input.x - sec.x, false)
      if (g.kind === 'label') {
        const s = g.integer ? Math.max(1, Math.pow(Math.abs(g.value), 0.5) * 0.03) : Math.max(1, Math.pow(Math.abs(g.value), 0.5)) * 0.03
        g.acc += (input.dx ?? 0) * s
        const raw = g.value + g.acc
        const v = g.integer ? Math.round(raw) : roundToDiff(raw, s)
        const range = this.range(sec.key, g.prop.p)
        const val = range ? Math.max(range.min, Math.min(range.max, v)) : v
        this.write(sec.key, g.prop.p, val, g.integer)
        return { kind: 'number', section: sec.key, prop: g.prop.p, value: val, final: false, before: g.before }
      }
      return null
    }
    if (input.type === 'up') {
      const g = this.drag
      this.drag = null
      if (this.pending) {
        this.focus = this.pending
        this.pending = null
      }
      if (!g) return null
      const sec = this.section(g.section)
      if (!sec) return null
      if (g.kind === 'toggle') {
        const on = g.draw.on !== 1
        if (on) g.draw.on = 1
        else delete g.draw.on
        bump(sec)
        const prop = g.prop?.p ?? (sec.kind === 'gameObject' ? 'm_IsActive' : 'm_Enabled')
        return { kind: 'bool', section: sec.key, prop, value: on }
      }
      if (g.kind === 'slider') {
        this.setActive(sec, g.track.id, false)
        const v = this.read(sec.key, g.prop.p)
        return v == null ? null : { kind: 'number', section: sec.key, prop: g.prop.p, value: v, final: true, before: g.before }
      }
      const v = this.read(sec.key, g.prop.p)
      return v == null ? null : { kind: 'number', section: sec.key, prop: g.prop.p, value: v, final: true, before: g.before }
    }
    return null
  }

  private slide(lx: number, final: boolean): Change | null {
    const g = this.drag
    if (!g || g.kind !== 'slider') return null
    const t = Math.max(0, Math.min(1, (lx - g.track.x - 5) / (g.track.w - 10)))
    const raw = g.range.min + t * (g.range.max - g.range.min)
    const v = roundToDiff(raw, (g.range.max - g.range.min) / g.track.w)
    this.write(g.section, g.prop.p, v)
    return { kind: 'number', section: g.section, prop: g.prop.p, value: v, final, before: g.before }
  }

  setTool(key: string | null): void {
    this.tool = key
    for (const sec of this.full)
      for (const d of this.sd(sec))
        if (this.name(d) === 'AppCommand') {
          if (sec.key === key) d.on = 1
          else delete d.on
          bump(sec)
        }
  }

  isOpen(key: string): boolean {
    return !this.closed.has(`${key}#`)
  }
}
