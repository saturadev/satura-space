import type { Quat, Vec3 } from './tuner'

export type Rgb = [number, number, number]

export interface TunerTheme {
  clear: Rgb
  grid: Rgb
  outline: Rgb
  outlineChild: Rgb
}

export interface TunerSceneEffects {
  skybox: boolean
  fog: boolean
  post: boolean
  particles: boolean
  refresh: boolean
}

export interface TunerSceneSettings {
  gizmos: boolean
  grid?: boolean
  effects?: TunerSceneEffects
  lighting?: boolean
}

const EFFECT_KEYS: readonly (keyof TunerSceneEffects)[] = ['skybox', 'fog', 'post', 'particles', 'refresh']

export function isTunerSceneEffects(v: unknown): v is TunerSceneEffects {
  return !!v && typeof v === 'object' && EFFECT_KEYS.every((k) => typeof (v as Record<string, unknown>)[k] === 'boolean')
}

export function tunerSceneSettingsArgs(s: TunerSceneSettings): Record<string, unknown> {
  const base: Record<string, unknown> = s.effects ? { gizmos: s.gizmos, effects: true, ...s.effects } : { gizmos: s.gizmos }
  if (s.grid !== undefined) base.showGrid = s.grid
  return s.lighting === undefined ? base : { ...base, lighting: s.lighting }
}

export interface TunerPickCamera {
  position: Vec3
  rotation: Quat
  fov: number
  ortho?: number
  width: number
  height: number
}

export interface TunerPickRequest {
  x: number
  y: number
  camera?: TunerPickCamera
}

export interface TunerPickRectRequest {
  x0: number
  y0: number
  x1: number
  y1: number
  camera?: TunerPickCamera
}

export interface TunerPickRectResult {
  ids: string[]
}

export type TunerPickKind = 'mesh' | 'skinned' | 'sprite' | 'tilemap' | 'ui' | 'text' | 'icon'

export interface TunerPickBase {
  path: string
  scene: string
  name: string
  target: string | null
  owner: string | null
}

export interface TunerPickHit extends TunerPickBase {
  kind: TunerPickKind
  icon: string
  base: TunerPickBase | null
}

export interface TunerPickResult {
  hits: TunerPickHit[]
  icons: Record<string, string>
}

export interface TunerPiercePick {
  path: string
  scene: string
  targetId: string | null
  ownerId: string | null
}

export interface TunerSceneStats {
  frames: number
  seconds: number
  renderMs: number
  renderMaxMs: number
  outlineMs: number
  outlineMaxMs: number
  gizmoMs: number
  gizmoMaxMs: number
  objects: number
  draws: number
}

export interface TunerSceneSelection {
  id?: string
  path?: string
  scene?: string
  ids?: string[]
  ghosts?: string[]
  focus?: string[]
  focusOn?: boolean
  focusTree?: boolean
  context?: boolean
}

const PICK_KINDS: readonly TunerPickKind[] = ['mesh', 'skinned', 'sprite', 'tilemap', 'ui', 'text', 'icon']

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null
}

function parseBase(v: unknown): TunerPickBase | null {
  if (!v || typeof v !== 'object') return null
  const b = v as Record<string, unknown>
  const path = str(b.path)
  if (!path) return null
  return {
    path,
    scene: str(b.scene) ?? '',
    name: str(b.name) ?? path.slice(path.lastIndexOf('/') + 1),
    target: str(b.target),
    owner: str(b.owner)
  }
}

export function parsePickResult(raw: { hits?: unknown; icons?: unknown }): TunerPickResult {
  const hits: TunerPickHit[] = []
  if (Array.isArray(raw.hits)) {
    for (const h of raw.hits as Record<string, unknown>[]) {
      if (!h || typeof h !== 'object') continue
      const path = str(h.path)
      const name = str(h.name)
      if (!path || name == null) continue
      const kind = PICK_KINDS.includes(h.kind as TunerPickKind) ? (h.kind as TunerPickKind) : 'mesh'
      hits.push({
        path,
        scene: str(h.scene) ?? '',
        name,
        target: str(h.target),
        owner: str(h.owner),
        kind,
        icon: str(h.icon) ?? '',
        base: parseBase(h.base)
      })
    }
  }
  const icons: Record<string, string> = {}
  if (raw.icons && typeof raw.icons === 'object')
    for (const [k, v] of Object.entries(raw.icons as Record<string, unknown>))
      if (typeof v === 'string' && v.startsWith('data:image/png;base64,')) icons[k] = v
  return { hits, icons }
}

export function isRgb(v: unknown): v is Rgb {
  return Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1)
}

export function isTunerSceneSettings(v: unknown): v is TunerSceneSettings {
  if (!v || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  return typeof o.gizmos === 'boolean' && (o.effects === undefined || isTunerSceneEffects(o.effects)) && (o.lighting === undefined || typeof o.lighting === 'boolean') && (o.grid === undefined || typeof o.grid === 'boolean')
}

export function isTunerTheme(v: unknown): v is TunerTheme {
  if (!v || typeof v !== 'object') return false
  const t = v as Record<string, unknown>
  return isRgb(t.clear) && isRgb(t.grid) && isRgb(t.outline) && isRgb(t.outlineChild)
}
