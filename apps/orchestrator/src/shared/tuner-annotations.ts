export const ANNOTATION_HAS_GIZMO = 2

export interface TunerAnnotation {
  key: string
  classID: number
  script: string
  name: string
  flags: number
  icon: boolean
  gizmo: boolean
  thumb: boolean
}

export interface TunerLightProbeVis {
  supported: boolean
  mode: number
  weights: boolean
  occlusion: boolean
  invalidCells: boolean
}

export interface TunerAnnotations {
  use3dIcons: boolean
  iconSize: number
  fadeGizmos: boolean
  fadeGizmoSize: number
  selectionOutline: boolean
  selectionWire: boolean
  lodLabels: boolean
  canHideLodLabels: boolean
  terrainWarnings: boolean
  lightProbes: TunerLightProbeVis
  items: TunerAnnotation[]
  recent: string[]
  thumbs: Record<string, string>
}

export type TunerAnnotationGeneralKey =
  | 'use3dIcons'
  | 'iconSize'
  | 'fadeGizmos'
  | 'fadeGizmoSize'
  | 'selectionOutline'
  | 'selectionWire'
  | 'lodLabels'
  | 'terrainWarnings'
  | 'probeMode'
  | 'probeWeights'
  | 'probeOcclusion'
  | 'probeInvalid'

const GENERAL_KEYS: readonly TunerAnnotationGeneralKey[] = [
  'use3dIcons',
  'iconSize',
  'fadeGizmos',
  'fadeGizmoSize',
  'selectionOutline',
  'selectionWire',
  'lodLabels',
  'terrainWarnings',
  'probeMode',
  'probeWeights',
  'probeOcclusion',
  'probeInvalid'
]

export type TunerAnnotationsRequest =
  | { op: 'get'; have?: string[] }
  | { op: 'general'; key: TunerAnnotationGeneralKey; on?: boolean; value?: number; have?: string[] }
  | { op: 'icon' | 'gizmo'; items: { classID: number; script: string }[]; on: boolean; recent?: boolean; have?: string[] }

const MAX_ITEMS = 4096

function cleanHave(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined
  return v.filter((k): k is string => typeof k === 'string' && k.length > 0 && k.length <= 512).slice(0, MAX_ITEMS)
}

export function cleanTunerAnnotationsRequest(req: unknown): Record<string, unknown> | null {
  if (!req || typeof req !== 'object') return null
  const r = req as Record<string, unknown>
  const have = cleanHave(r.have)
  const base: Record<string, unknown> = have ? { have } : {}
  if (r.op === 'get') return { op: 'get', ...base }
  if (r.op === 'general') {
    if (!GENERAL_KEYS.includes(r.key as TunerAnnotationGeneralKey)) return null
    const value = typeof r.value === 'number' && Number.isFinite(r.value) ? r.value : 0
    return { op: 'general', key: r.key, on: r.on === true, value, ...base }
  }
  if (r.op === 'icon' || r.op === 'gizmo') {
    if (!Array.isArray(r.items) || r.items.length === 0 || r.items.length > MAX_ITEMS) return null
    const classIDs: number[] = []
    const scripts: string[] = []
    for (const it of r.items) {
      const o = it as Record<string, unknown>
      if (!o || !Number.isInteger(o.classID) || typeof o.script !== 'string' || o.script.length > 512) return null
      classIDs.push(o.classID as number)
      scripts.push(o.script)
    }
    return { op: r.op, on: r.on === true, recent: r.recent !== false, classIDs, scripts, ...base }
  }
  return null
}

const bool = (v: unknown, d = false): boolean => (typeof v === 'boolean' ? v : d)
const num = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d)

export function parseTunerAnnotations(v: unknown): TunerAnnotations | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  if (!Array.isArray(o.items)) return null
  const lp = (o.lightProbes && typeof o.lightProbes === 'object' ? o.lightProbes : {}) as Record<string, unknown>
  const items: TunerAnnotation[] = []
  for (const raw of o.items) {
    const it = raw as Record<string, unknown>
    if (!it || typeof it.k !== 'string' || typeof it.n !== 'string') continue
    items.push({
      key: it.k,
      classID: num(it.c),
      script: typeof it.s === 'string' ? it.s : '',
      name: it.n,
      flags: num(it.f),
      icon: it.i === 1,
      gizmo: it.g === 1,
      thumb: it.t === 1
    })
  }
  const thumbs: Record<string, string> = {}
  if (o.thumbs && typeof o.thumbs === 'object') {
    for (const [k, val] of Object.entries(o.thumbs as Record<string, unknown>)) {
      if (typeof val === 'string' && val.startsWith('data:image/png;base64,')) thumbs[k] = val
    }
  }
  return {
    use3dIcons: bool(o.use3dIcons, true),
    iconSize: num(o.iconSize, 0.03),
    fadeGizmos: bool(o.fadeGizmos),
    fadeGizmoSize: num(o.fadeGizmoSize, 5),
    selectionOutline: bool(o.selectionOutline, true),
    selectionWire: bool(o.selectionWire),
    lodLabels: bool(o.lodLabels, true),
    canHideLodLabels: bool(o.canHideLodLabels, true),
    terrainWarnings: bool(o.terrainWarnings, true),
    lightProbes: {
      supported: bool(lp.supported),
      mode: num(lp.mode, 3),
      weights: bool(lp.weights),
      occlusion: bool(lp.occlusion),
      invalidCells: bool(lp.invalidCells)
    },
    items,
    recent: Array.isArray(o.recent) ? o.recent.filter((k): k is string => typeof k === 'string') : [],
    thumbs
  }
}

const EXPONENT_START = -3
const EXPONENT_RANGE = 3

export function texelWorldSizeTo01(texelWorldSize: number): number {
  if (texelWorldSize === -1) return 1
  if (texelWorldSize <= 0) return 0
  return (Math.log10(texelWorldSize) - EXPONENT_START) / EXPONENT_RANGE
}

export function iconSize01ToTexelWorldSize(value01: number): number {
  if (value01 <= 0) return 0
  return Math.pow(10, EXPONENT_START + EXPONENT_RANGE * value01)
}
