export interface TunerLayout {
  sidebar: number
  viewport: number
  hierarchy: number
  timeline: number
  staging: number
}

export const DEFAULT_TUNER_LAYOUT: TunerLayout = { sidebar: 380, viewport: 0.52, hierarchy: 0.34, timeline: 0, staging: 0 }

export const SIDEBAR_MIN = 240
export const VIEWPORT_MIN_W = 240
export const VIEWPORT_MIN_H = 140
export const SIDEBAR_MIN_H = 150
export const HIERARCHY_MIN = 48
export const INSPECTOR_MIN = 90

const KEY = 'satura.tuner.layout.'
const LEGACY_KEY = 'satura.sceneTuner.layout.'

function readMigrated(key: string, legacyKey: string): string | null {
  const s = window.localStorage.getItem(key)
  if (s != null) return s
  const old = window.localStorage.getItem(legacyKey)
  if (old == null) return null
  window.localStorage.setItem(key, old)
  window.localStorage.removeItem(legacyKey)
  return old
}

function finite(v: unknown, lo: number, hi: number, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : fallback
}

export function sanitizeLayout(raw: unknown): TunerLayout {
  const d = DEFAULT_TUNER_LAYOUT
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  return {
    sidebar: finite(o.sidebar, 120, 4000, d.sidebar),
    viewport: finite(o.viewport, 0.05, 0.95, d.viewport),
    hierarchy: finite(o.hierarchy, 0.05, 0.95, d.hierarchy),
    timeline: o.timeline === 0 ? 0 : finite(o.timeline, 40, 4000, d.timeline),
    staging: o.staging === 0 ? 0 : finite(o.staging, 120, 4000, d.staging)
  }
}

export function loadTunerLayout(tabId: string): TunerLayout {
  try {
    const s = readMigrated(KEY + tabId, LEGACY_KEY + tabId)
    return sanitizeLayout(s ? JSON.parse(s) : null)
  } catch {
    return { ...DEFAULT_TUNER_LAYOUT }
  }
}

export function saveTunerLayout(tabId: string, layout: TunerLayout): void {
  try {
    window.localStorage.setItem(KEY + tabId, JSON.stringify(layout))
  } catch {
    return
  }
}

const HIERARCHY_KEY = 'satura.tuner.hierarchy.'
const LEGACY_HIERARCHY_KEY = 'satura.sceneTuner.hierarchy.'

export function loadHierarchyCollapsed(tabId: string): Set<string> {
  try {
    const raw = JSON.parse(readMigrated(HIERARCHY_KEY + tabId, LEGACY_HIERARCHY_KEY + tabId) ?? '[]') as unknown
    return new Set(Array.isArray(raw) ? raw.filter((k): k is string => typeof k === 'string') : [])
  } catch {
    return new Set()
  }
}

export function saveHierarchyCollapsed(tabId: string, collapsed: ReadonlySet<string>): void {
  try {
    if (collapsed.size === 0) window.localStorage.removeItem(HIERARCHY_KEY + tabId)
    else window.localStorage.setItem(HIERARCHY_KEY + tabId, JSON.stringify([...collapsed]))
  } catch {
    return
  }
}

const HIERARCHY_EXPANDED_KEY = 'satura.tuner.hierarchyExpanded.'

export function loadHierarchyExpanded(tabId: string): Set<string> {
  try {
    const raw = JSON.parse(window.localStorage.getItem(HIERARCHY_EXPANDED_KEY + tabId) ?? '[]') as unknown
    return new Set(Array.isArray(raw) ? raw.filter((k): k is string => typeof k === 'string') : [])
  } catch {
    return new Set()
  }
}

export function saveHierarchyExpanded(tabId: string, expanded: ReadonlySet<string>): void {
  try {
    if (expanded.size === 0) window.localStorage.removeItem(HIERARCHY_EXPANDED_KEY + tabId)
    else window.localStorage.setItem(HIERARCHY_EXPANDED_KEY + tabId, JSON.stringify([...expanded]))
  } catch {
    return
  }
}

export interface TunerViewEffects {
  enabled: boolean
  skybox: boolean
  fog: boolean
  post: boolean
  particles: boolean
  refresh: boolean
}

export interface TunerCameraSettings {
  fov: number
  dynamicClip: boolean
  near: number
  far: number
  easing: boolean
  easingDuration: number
  acceleration: boolean
  accelerationSpeed: number
  speed: number
  speedMin: number
  speedMax: number
  speedModifier: number
}

export const DEFAULT_TUNER_CAMERA: TunerCameraSettings = {
  fov: 60,
  dynamicClip: true,
  near: 0.03,
  far: 10000,
  easing: true,
  easingDuration: 0.4,
  acceleration: true,
  accelerationSpeed: 0.8,
  speed: 1,
  speedMin: 0.01,
  speedMax: 2,
  speedModifier: 5
}

export const CAMERA_LIMITS = {
  fov: [4, 120],
  easingDuration: [0.1, 2],
  accelerationSpeed: [0.1, 4],
  speed: [0.0001, 10000],
  speedModifier: [1.1, 25],
  near: [1e-5, 1e7],
  far: [1e-5, 1.8e19]
} as const

export function sanitizeCameraSettings(raw: unknown): TunerCameraSettings {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const d = DEFAULT_TUNER_CAMERA
  const num = (k: keyof TunerCameraSettings, lim?: readonly [number, number]): number => {
    const v = o[k]
    if (typeof v !== 'number' || !Number.isFinite(v)) return d[k] as number
    return lim ? Math.max(lim[0], Math.min(lim[1], v)) : v
  }
  const bool = (k: keyof TunerCameraSettings): boolean => (typeof o[k] === 'boolean' ? (o[k] as boolean) : (d[k] as boolean))
  const speedMin = num('speedMin', CAMERA_LIMITS.speed)
  const speedMax = Math.max(speedMin, num('speedMax', CAMERA_LIMITS.speed))
  const near = num('near', CAMERA_LIMITS.near)
  return {
    fov: num('fov', CAMERA_LIMITS.fov),
    dynamicClip: bool('dynamicClip'),
    near,
    far: Math.max(near * 1.01, num('far', CAMERA_LIMITS.far)),
    easing: bool('easing'),
    easingDuration: num('easingDuration', CAMERA_LIMITS.easingDuration),
    acceleration: bool('acceleration'),
    accelerationSpeed: num('accelerationSpeed', CAMERA_LIMITS.accelerationSpeed),
    speed: Math.max(speedMin, Math.min(speedMax, num('speed'))),
    speedMin,
    speedMax,
    speedModifier: num('speedModifier', CAMERA_LIMITS.speedModifier)
  }
}

export interface TunerViewPrefs {
  orthographic: boolean
  gizmos: boolean
  grid: boolean
  lighting: boolean
  rest: boolean
  canvasView: string
  canvasViewScene: string
  effects: TunerViewEffects
  camera: TunerCameraSettings
}

export const DEFAULT_TUNER_VIEW_EFFECTS: TunerViewEffects = {
  enabled: true,
  skybox: true,
  fog: true,
  post: true,
  particles: true,
  refresh: false
}

const DEFAULT_TUNER_VIEW_PREFS: TunerViewPrefs = { orthographic: false, gizmos: true, grid: true, lighting: true, rest: false, canvasView: '', canvasViewScene: '', effects: DEFAULT_TUNER_VIEW_EFFECTS, camera: DEFAULT_TUNER_CAMERA }

function sanitizeViewEffects(raw: unknown): TunerViewEffects {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const pick = (k: keyof TunerViewEffects): boolean => (typeof o[k] === 'boolean' ? (o[k] as boolean) : DEFAULT_TUNER_VIEW_EFFECTS[k])
  return {
    enabled: pick('enabled'),
    skybox: pick('skybox'),
    fog: pick('fog'),
    post: pick('post'),
    particles: pick('particles'),
    refresh: pick('refresh')
  }
}

export function sceneEffectsOf(e: TunerViewEffects): { skybox: boolean; fog: boolean; post: boolean; particles: boolean; refresh: boolean } {
  return {
    skybox: e.enabled && e.skybox,
    fog: e.enabled && e.fog,
    post: e.enabled && e.post,
    particles: e.enabled && e.particles,
    refresh: e.enabled && e.refresh
  }
}

const VIEW_PREFS_KEY = 'satura.tuner.view.'

function sanitizeViewPrefs(raw: unknown): TunerViewPrefs {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  return {
    orthographic: typeof o.orthographic === 'boolean' ? o.orthographic : DEFAULT_TUNER_VIEW_PREFS.orthographic,
    gizmos: typeof o.gizmos === 'boolean' ? o.gizmos : DEFAULT_TUNER_VIEW_PREFS.gizmos,
    grid: typeof o.grid === 'boolean' ? o.grid : DEFAULT_TUNER_VIEW_PREFS.grid,
    lighting: typeof o.lighting === 'boolean' ? o.lighting : DEFAULT_TUNER_VIEW_PREFS.lighting,
    rest: typeof o.rest === 'boolean' ? o.rest : DEFAULT_TUNER_VIEW_PREFS.rest,
    canvasView: typeof o.canvasView === 'string' ? o.canvasView : '',
    canvasViewScene: typeof o.canvasViewScene === 'string' ? o.canvasViewScene : '',
    effects: sanitizeViewEffects(o.effects),
    camera: sanitizeCameraSettings(o.camera)
  }
}

export function loadTunerViewPrefs(tabId: string): TunerViewPrefs {
  try {
    const s = window.localStorage.getItem(VIEW_PREFS_KEY + tabId)
    return sanitizeViewPrefs(s ? JSON.parse(s) : null)
  } catch {
    return { ...DEFAULT_TUNER_VIEW_PREFS, effects: { ...DEFAULT_TUNER_VIEW_EFFECTS }, camera: { ...DEFAULT_TUNER_CAMERA } }
  }
}

export function saveTunerViewPrefs(tabId: string, prefs: TunerViewPrefs): void {
  try {
    window.localStorage.setItem(VIEW_PREFS_KEY + tabId, JSON.stringify(prefs))
  } catch {
    return
  }
}

export function clampPx(px: number, total: number, minSelf: number, minOther: number): number {
  const hi = Math.max(minSelf, total - minOther)
  return Math.round(Math.min(hi, Math.max(minSelf, px)))
}

export function clampRatio(pos: number, total: number, minFirst: number, minSecond: number): number {
  if (total <= 0) return 0.5
  const lo = Math.min(minFirst, total / 2)
  const hi = Math.max(total - minSecond, total / 2)
  return Math.min(hi, Math.max(lo, pos)) / total
}
