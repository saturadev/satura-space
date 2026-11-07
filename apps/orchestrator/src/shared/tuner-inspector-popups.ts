export interface TunerPopupRect {
  x: number
  y: number
  w: number
  h: number
}

export interface TunerColor {
  r: number
  g: number
  b: number
  a: number
}

export const TANGENT = { free: 0, auto: 1, linear: 2, constant: 3, clampedAuto: 4 } as const

export const WEIGHTED = { none: 0, in: 1, out: 2, both: 3 } as const

export const WRAP = { default: 0, once: 1, loop: 2, pingPong: 4, clampForever: 8 } as const

export interface TunerCurveKey {
  time: number
  value: number
  inTangent: number
  outTangent: number
  inWeight: number
  outWeight: number
  weightedMode: number
  left?: number
  right?: number
  broken?: boolean
}

export interface TunerCurve {
  keys: TunerCurveKey[]
  preWrapMode: number
  postWrapMode: number
}

export const GRADIENT_MODE = { blend: 0, fixed: 1, perceptual: 2 } as const

export interface TunerGradientColorKey {
  color: TunerColor
  time: number
}

export interface TunerGradientAlphaKey {
  alpha: number
  time: number
}

export interface TunerGradient {
  mode: number
  colorSpace: number
  colorKeys: TunerGradientColorKey[]
  alphaKeys: TunerGradientAlphaKey[]
}

export interface TunerObjectRef {
  id?: string
  guid?: string
  localId?: number | string
  path?: string
  scene?: string
  scenePath?: string
  component?: string
}

export interface TunerTexture {
  w: number
  h: number
  png: string
}

export interface TunerMenuData {
  options: string[]
  enabled: boolean[]
  separator: boolean[]
  selected: number[]
  property?: string
}

export interface TunerColorData {
  value: TunerColor
  hdr: boolean
  showAlpha: boolean
  property?: string
}

export interface TunerCurveData {
  value: TunerCurve
  ranges?: TunerPopupRect
  color?: string
  property?: string
}

export interface TunerGradientData {
  value: TunerGradient
  hdr: boolean
  property?: string
}

export interface TunerObjectData {
  type: string
  typeName: string
  allowSceneObjects: boolean
  current: TunerObjectRef | null
  currentName?: string
  property?: string
  context?: string
  preferScene?: boolean
}

export interface TunerDropdownItem {
  id: number
  name: string
  icon?: string
  off?: 1
  sep?: 1
  help?: 1
  tip?: string
  ch?: TunerDropdownItem[]
}

export interface TunerDropdownData {
  title: string
  addComponent?: string
  items: TunerDropdownItem[]
  search?: boolean
  width?: number
  height?: number
  tex?: Record<string, TunerTexture>
  property?: string
}

export interface TunerWindowData {
  type: string
  content?: string
  title?: string
  section?: string
  w?: number
  h?: number
  parent?: string
  row?: { x: number; y: number; w: number; h: number }
}

interface TunerPopupBase<K extends string, D> {
  id: string | number
  kind: K
  anchor: TunerPopupRect
  data: D
}

export type TunerPopup =
  | TunerPopupBase<'menu', TunerMenuData>
  | TunerPopupBase<'color', TunerColorData>
  | TunerPopupBase<'curve', TunerCurveData>
  | TunerPopupBase<'gradient', TunerGradientData>
  | TunerPopupBase<'object', TunerObjectData>
  | TunerPopupBase<'dropdown', TunerDropdownData>
  | TunerPopupBase<'window', TunerWindowData>

export type TunerPopupAction = 'change' | 'commit' | 'cancel'

export type TunerPopupAnswer = (popup: TunerPopup, action: TunerPopupAction, value?: unknown) => void

export interface TunerMenuExtra {
  label: string
  onPick: () => void
}

const POPUP_KINDS = new Set(['menu', 'color', 'curve', 'gradient', 'object', 'dropdown', 'window'])

export function asTunerPopup(p: { id: string | number; kind: string; anchor: TunerPopupRect; data: unknown } | null | undefined): TunerPopup | null {
  if (!p || !POPUP_KINDS.has(p.kind) || !p.data || typeof p.data !== 'object') return null
  const d = p.data as Record<string, unknown>
  switch (p.kind) {
    case 'menu':
      if (!Array.isArray(d.options)) return null
      break
    case 'color':
    case 'curve':
    case 'gradient':
      if (!d.value || typeof d.value !== 'object') return null
      break
    case 'object':
      if (typeof d.type !== 'string') return null
      break
    case 'dropdown':
      if (!Array.isArray(d.items)) return null
      break
  }
  return p as TunerPopup
}

export const OBJECT_PAGE = 60

export interface TunerObjectQuery {
  type: string
  allowSceneObjects: boolean
  scene: boolean
  search: string
  offset: number
  limit: number
  known?: string[]
  context?: string
}

export interface TunerObjectCandidate extends TunerObjectRef {
  name: string
  typeName: string
  icon?: string
  sub?: 1
}

export interface TunerObjectQueryResult {
  ok: boolean
  error?: string
  total?: number
  truncated?: boolean
  noScene?: boolean
  items?: TunerObjectCandidate[]
  tex?: Record<string, TunerTexture>
}

export interface TunerPopupApi {
  objects: (projectPath: string, query: TunerObjectQuery) => Promise<TunerObjectQueryResult>
}

const TYPE_RE = /^[A-Za-z_][\w.+`]{0,255}$/

export function validObjectQuery(q: unknown): TunerObjectQuery | null {
  if (!q || typeof q !== 'object') return null
  const i = q as Record<string, unknown>
  if (typeof i.type !== 'string' || !TYPE_RE.test(i.type)) return null
  if (typeof i.search !== 'string' || i.search.length > 256) return null
  if (!Number.isInteger(i.offset) || (i.offset as number) < 0) return null
  if (!Number.isInteger(i.limit) || (i.limit as number) < 1) return null
  const known = Array.isArray(i.known) ? i.known.filter((k): k is string => typeof k === 'string' && /^[\w-]{1,64}$/.test(k)).slice(0, 2048) : undefined
  const context = typeof i.context === 'string' && /^[\w-]{1,64}$/.test(i.context) ? i.context : undefined
  return {
    type: i.type,
    allowSceneObjects: i.allowSceneObjects === true,
    scene: i.scene === true && i.allowSceneObjects === true,
    search: i.search,
    offset: i.offset as number,
    limit: Math.min(200, i.limit as number),
    ...(known && known.length ? { known } : {}),
    ...(context ? { context } : {})
  }
}

export function sameObjectRef(a: TunerObjectRef | null | undefined, b: TunerObjectRef | null | undefined): boolean {
  if (!a || !b) return !a && !b
  if (a.guid || b.guid) {
    if (a.guid !== b.guid) return false
    const la = a.localId === undefined || a.localId === 0 || a.localId === '0' ? '' : String(a.localId)
    const lb = b.localId === undefined || b.localId === 0 || b.localId === '0' ? '' : String(b.localId)
    if (la && lb && la !== lb) return false
    return (a.component ?? '') === (b.component ?? '') || !a.component || !b.component
  }
  if (a.scenePath || b.scenePath) return a.scenePath === b.scenePath && (a.scene ?? '') === (b.scene ?? '') && (a.component ?? '') === (b.component ?? '')
  return !!a.path && a.path === b.path
}
