import type { TunerCurve } from './tuner-inspector-popups'

export interface TunerInspectComponent {
  type: string
  index?: number
  fields?: string[]
  exclude?: string[]
}

export interface TunerInspectExtra {
  path: string
  scene?: string
  at?: number[]
}

export type TunerInspectTarget =
  | {
      kind: 'object'
      path: string
      scene?: string
      components?: TunerInspectComponent[]
      exclude?: string[]
      at?: number[]
      targets?: TunerInspectExtra[]
    }
  | { kind: 'asset'; path: string; fields?: string[]; exclude?: string[] }

export type TunerInspectOpen = TunerInspectTarget | { kind: 'prefab'; path: string } | { kind: 'script'; path: string; file: string }

export interface TiRect {
  x: number
  y: number
  w: number
  h: number
}

export type TiColor = string

export interface TiStyleState {
  bg?: number
  bg2?: number
  hb?: 1
  tc?: TiColor
}

export interface TiStyle {
  id: number
  n: string
  sk?: 1
  dtc?: 1
  f?: string
  fs: number
  fst?: number
  lh?: number
  al?: number
  ww?: boolean
  rt?: boolean
  cl?: number
  co?: [number, number]
  ip?: number
  fw?: number
  fh?: number
  b?: [number, number, number, number]
  p?: [number, number, number, number]
  o?: [number, number, number, number]
  s: {
    n?: TiStyleState
    h?: TiStyleState
    a?: TiStyleState
    f?: TiStyleState
    on?: TiStyleState
    onh?: TiStyleState
    ona?: TiStyleState
    onf?: TiStyleState
  }
}

export interface TiTexture {
  id: number
  w: number
  h: number
  sc?: number
  n?: string
  chk?: 1
  solid?: TiColor
  png?: string
}

export type TiMatrix = [number, number, number, number, number, number]

export type TiDrawRole = 'band' | 'line' | 'parent' | 'self' | 'sel' | 'frame'

export interface TiDrawExtras {
  mx?: TiMatrix
  role?: TiDrawRole
}

export interface TiStyleDraw extends TiRect, TiDrawExtras {
  k: 's'
  c?: number
  st: number
  t?: string
  img?: number
  tip?: string
  id?: number
  on?: 1
  hv?: 1
  ac?: 1
  fc?: 1
  off?: 1
  bg?: TiColor
  fg?: TiColor
  clip?: number
  sel?: [number, number]
}

export interface TiTextureDraw extends TiRect, TiDrawExtras {
  k: 't'
  c?: number
  tex: number
  uv?: [number, number, number, number]
  col?: TiColor
  sm?: number
  asp?: number
  bw?: [number, number, number, number]
  br?: [number, number, number, number]
  sl?: [number, number, number, number]
  off?: 1
  clip?: number
}

export interface TiRectDraw extends TiRect, TiDrawExtras {
  k: 'r'
  c?: number
  col: TiColor
  off?: 1
  bw?: [number, number, number, number]
  br?: [number, number, number, number]
  clip?: number
}

export interface TiCurveDraw extends TiRect, TiDrawExtras {
  k: 'c'
  c?: number
  bg?: TiColor
  col: TiColor
  top?: TiColor
  bot?: TiColor
  pts?: number[]
  pts2?: number[]
  off?: 1
  clip?: number
}

export interface TiVectorDraw extends TiRect, TiDrawExtras {
  k: 'v'
  c?: number
  m: 'l' | 'p' | 'f'
  col: TiColor
  fill?: TiColor
  lw?: number
  dot?: 1
  pts: number[]
  off?: 1
  clip?: number
}

export type TiDraw = TiStyleDraw | TiTextureDraw | TiRectDraw | TiCurveDraw | TiVectorDraw

export interface TiProp extends TiRect {
  p: string
  k: string
  l?: string
  n?: 1
  c?: number
  v?: string
}

export interface TiCursor extends TiRect {
  c: string
  im?: number
}

export type TiSectionKind = 'gameObject' | 'component' | 'asset' | 'importer' | 'imported' | 'material' | 'preview' | 'addComponent' | 'message' | 'popupWindow' | 'removedComponent'

export interface TiPsCurve {
  id: number
  minId: number
  name: string
  col: TiColor
  signed: boolean
  sx: number
  sy: number
  set: boolean
  opt: boolean
  max: TunerCurve
  min?: TunerCurve
}

export interface TiPsCurves extends TiRect {
  inst: number
  top: number
  order: number[]
  curves: TiPsCurve[]
  vmin: number
  sel: number[]
}

export interface TiSection extends TiRect {
  key: string
  kind: TiSectionKind
  ui: 'imgui' | 'uitk'
  hash: string
  title?: string
  type?: string
  editor?: string
  expanded?: boolean
  same?: true
  draws?: TiDraw[]
  props?: TiProp[]
  vals?: [string, string, string?, string?][]
  cursors?: TiCursor[]
  clips?: TiRect[]
  scrolls?: TiScroll[]
  uitk?: unknown
  psc?: TiPsCurves
  filter?: TiCount
}

export interface TiCount {
  shown: number
  total: number
}

export interface TiScroll extends TiRect {
  cw: number
  ch: number
  vw: number
  vh: number
  sx: number
  sy: number
}

export interface TiTextFocus extends TiRect {
  section: string
  control: number
  text: string
  style: number
  numeric?: boolean
  multiline?: boolean
  password?: boolean
  delayed?: boolean
  editing?: boolean
}

export type TiPopupKind = 'menu' | 'dropdown' | 'window' | 'color' | 'object' | 'curve' | 'gradient' | (string & {})

export interface TiMenuData {
  options: string[]
  enabled: boolean[]
  separator: boolean[]
  selected: number[]
  context?: 'custom' | 'object' | 'path'
  property?: string
}

export interface TiPopup {
  id: number
  kind: TiPopupKind
  anchor: TiRect
  section?: string
  data: unknown
}

export interface TiTargetInfo {
  kind: 'object' | 'asset'
  path: string
  scene?: string
  name?: string
  found: boolean
  playing: boolean
  error?: string
  components?: TiCount
}

export interface TiCapture {
  session: string
  seq: number
  reset?: boolean
  width: number
  height: number
  ms: number
  target: TiTargetInfo
  fontDir?: string
  styles?: TiStyle[]
  textures?: TiTexture[]
  sections: TiSection[]
  focus?: TiTextFocus
  popups?: TiPopup[]
  opens?: TunerInspectOpen[]
  pings?: TunerInspectTarget[]
  hot?: boolean
}

export interface TiMods {
  shift?: boolean
  ctrl?: boolean
  alt?: boolean
  cmd?: boolean
}

export type TiTextCommit = 'enter' | 'tab' | 'shiftTab' | 'blur' | 'live'

export type TunerInspectorInput =
  | { op: 'mouse'; type: 'down' | 'up' | 'drag' | 'move'; x: number; y: number; button: number; clicks?: number; dx?: number; dy?: number; mods?: TiMods }
  | { op: 'wheel'; x: number; y: number; dx: number; dy: number; mods?: TiMods }
  | { op: 'key'; type: 'down' | 'up'; key: string; char?: string; mods?: TiMods }
  | { op: 'text'; control: number; value: string; commit: TiTextCommit }
  | { op: 'textCancel' }
  | { op: 'popup'; id: number; action: 'change' | 'commit' | 'cancel'; value?: unknown }
  | { op: 'undo' }
  | { op: 'redo' }
  | { op: 'hover'; x: number; y: number; mods?: TiMods }
  | { op: 'leave' }
  | { op: 'uitk'; section: string; data: unknown }
  | { op: 'psCurves'; section: string; data: TiPsCurvesCommand }
  | { op: 'popupFit'; section: string; h: number }

export type TiPsCurvesCommand =
  | { cmd: 'select'; front?: number; hasSel?: boolean; sel?: number[] }
  | { cmd: 'set'; begin?: boolean; curves: { id: number; curve: TunerCurve }[]; front?: number; hasSel?: boolean; sel?: number[] }
  | { cmd: 'scalar'; begin?: boolean; ids: number[]; value: number }

export interface TunerInspectorResult {
  ok: boolean
  error?: string
  data?: TiCapture
}

export interface TunerInspectorCaptureEvent {
  projectPath: string
  session: string
  capture: TiCapture
}

export interface TunerInspectorFont {
  name: string
  data: Uint8Array
}

export interface TunerInspectorApi {
  open: (projectPath: string, session: string, target: TunerInspectTarget, width: number) => Promise<TunerInspectorResult>
  input: (projectPath: string, session: string, input: TunerInspectorInput) => Promise<TunerInspectorResult>
  resize: (projectPath: string, session: string, width: number) => Promise<TunerInspectorResult>
  capture: (projectPath: string, session: string, force: boolean) => Promise<TunerInspectorResult>
  close: (projectPath: string, session: string) => Promise<void>
  fonts: (fontDir: string) => Promise<TunerInspectorFont[]>
  onCapture: (cb: (e: TunerInspectorCaptureEvent) => void) => () => void
}

export const TUNER_INSPECTOR_MIN_WIDTH = 200
export const TUNER_INSPECTOR_MAX_WIDTH = 2000

const SESSION_RE = /^[\w.-]{1,64}$/
const PATH_RE = /^[^\r\n"\\]{1,512}$/
const TYPE_RE = /^[A-Za-z_][\w.+]{0,255}$/
const FIELD_RE = /^(?=.{1,256}$)[A-Za-z_](?:[\w.[\]]| (?=[\w[]))*$/
const KEY_RE = /^[A-Za-z_][\w.+]{0,255}(#\d{1,4})?$/

export function isTunerInspectorSession(s: unknown): s is string {
  return typeof s === 'string' && SESSION_RE.test(s)
}

export function componentKey(type: string, index = 0): string {
  const short = type.includes('.') ? type.slice(type.lastIndexOf('.') + 1) : type
  return index > 0 ? `${short}#${index}` : short
}

function parseComponentKey(key: string): { type: string; index: number } {
  const m = /^(.*)#(\d+)$/.exec(key)
  return m ? { type: m[1], index: Number(m[2]) } : { type: key, index: 0 }
}

function cleanPaths(v: unknown, re: RegExp, max: number): string[] | undefined {
  if (!Array.isArray(v)) return undefined
  return [...new Set(v.filter((f): f is string => typeof f === 'string' && re.test(f)))].slice(0, max)
}

function cleanPropertyFilter(o: Record<string, unknown>): { fields?: string[]; exclude?: string[] } {
  const fields = cleanPaths(o.fields, FIELD_RE, 128)
  if (fields) return { fields }
  const exclude = cleanPaths(o.exclude, FIELD_RE, 128)
  return exclude?.length ? { exclude } : {}
}

export function cleanTunerInspectTarget(t: unknown): TunerInspectTarget | null {
  if (!t || typeof t !== 'object') return null
  const o = t as Record<string, unknown>
  if (typeof o.path !== 'string' || !PATH_RE.test(o.path)) return null
  if (o.kind === 'asset') return { kind: 'asset', path: o.path, ...cleanPropertyFilter(o) }
  if (o.kind !== 'object') return null
  const out: TunerInspectTarget = { kind: 'object', path: o.path }
  if (typeof o.scene === 'string' && o.scene && PATH_RE.test(o.scene)) out.scene = o.scene
  if (Array.isArray(o.components)) {
    const comps: TunerInspectComponent[] = []
    for (const c of o.components.slice(0, 64)) {
      if (!c || typeof c !== 'object') continue
      const cc = c as Record<string, unknown>
      if (typeof cc.type !== 'string') continue
      const parsed = parseComponentKey(cc.type)
      if (!TYPE_RE.test(parsed.type)) continue
      const index =
        typeof cc.index === 'number' && Number.isInteger(cc.index) && cc.index >= 0 ? cc.index : parsed.index
      comps.push({ type: parsed.type, index, ...cleanPropertyFilter(cc) })
    }
    out.components = comps
  } else {
    const exclude = cleanPaths(o.exclude, KEY_RE, 64)
    if (exclude?.length) out.exclude = exclude
  }
  if (validAt(o.at)) out.at = o.at
  if (Array.isArray(o.targets)) {
    const targets: TunerInspectExtra[] = []
    for (const x of o.targets.slice(0, TUNER_INSPECT_MAX_TARGETS)) {
      if (!x || typeof x !== 'object') continue
      const xx = x as Record<string, unknown>
      if (typeof xx.path !== 'string' || !PATH_RE.test(xx.path)) continue
      const t: TunerInspectExtra = { path: xx.path }
      if (typeof xx.scene === 'string' && xx.scene && PATH_RE.test(xx.scene)) t.scene = xx.scene
      if (validAt(xx.at)) t.at = xx.at
      targets.push(t)
    }
    if (targets.length > 0) out.targets = targets
  }
  return out
}

export const TUNER_INSPECT_MAX_TARGETS = 256

function validAt(v: unknown): v is number[] {
  return Array.isArray(v) && v.length > 0 && v.length <= 128 && v.every((n) => Number.isInteger(n) && n >= 0 && n < 1e7)
}
