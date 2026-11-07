import type { Quat, Vec3 } from './tuner'

export type V2 = [number, number]
export type Rect4 = [number, number, number, number]

export interface TunerRectFrame {
  origin: Vec3
  ux: Vec3
  uy: Vec3
  uz: Vec3
}

export interface TunerRectParent extends TunerRectFrame {
  rect: Rect4
}

export interface TunerRectValues {
  anchorMin: V2
  anchorMax: V2
  anchoredPosition: V2
  sizeDelta: V2
  pivot: V2
  localRotation: Quat
  localPositionZ: number
}

export interface TunerRectInfo extends TunerRectValues {
  id: string
  rect: Rect4
  localScale: Vec3
  frame: TunerRectFrame
  parent: TunerRectParent | null
  renderer?: boolean
}

export type TunerRectRequest =
  | { op: 'get'; id: string }
  | ({ op: 'set'; id: string; final?: boolean; label?: string } & Partial<TunerRectValues>)
  | { op: 'undo' }
  | { op: 'redo' }

export type TunerRectItem = { id: string } & Partial<TunerRectValues>

export type TunerRectsRequest = { op: 'get'; ids: string[] } | { op: 'set'; items: TunerRectItem[]; final?: boolean; label?: string }

const LABEL_MAX = 64
const ID_RE = /^[\w.#-]{1,64}$/
const ITEMS_MAX = 256

function finite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

function vec(v: unknown, n: number, limit = 1e7): number[] | null {
  if (!Array.isArray(v) || v.length !== n) return null
  if (!v.every((x) => finite(x) && Math.abs(x) <= limit)) return null
  return v.map((x) => +x)
}

function cleanValues(r: Record<string, unknown>, out: Record<string, unknown>): boolean | null {
  let any = false
  for (const k of ['anchorMin', 'anchorMax', 'anchoredPosition', 'sizeDelta', 'pivot'] as const) {
    if (r[k] === undefined) continue
    const v = vec(r[k], 2)
    if (!v) return null
    out[k] = v
    any = true
  }
  if (r.localRotation !== undefined) {
    const q = vec(r.localRotation, 4, 2)
    if (!q || Math.hypot(...q) < 1e-6) return null
    out.localRotation = q
    any = true
  }
  if (r.localPositionZ !== undefined) {
    if (!finite(r.localPositionZ) || Math.abs(r.localPositionZ) > 1e7) return null
    out.localPositionZ = r.localPositionZ
    out.hasZ = true
    any = true
  }
  return any
}

export function cleanTunerRectRequest(req: unknown): Record<string, unknown> | null {
  if (!req || typeof req !== 'object') return null
  const r = req as Record<string, unknown>
  if (r.op === 'undo' || r.op === 'redo') return { op: r.op }
  if (typeof r.id !== 'string' || !ID_RE.test(r.id)) return null
  if (r.op === 'get') return { op: 'get', id: r.id }
  if (r.op !== 'set') return null
  const out: Record<string, unknown> = { op: 'set', id: r.id }
  const any = cleanValues(r, out)
  if (any === null) return null
  if (!any && r.final !== true) return null
  if (r.final === true) out.final = true
  if (typeof r.label === 'string' && r.label) out.label = r.label.slice(0, LABEL_MAX)
  return out
}

export function cleanTunerRectsRequest(req: unknown): Record<string, unknown> | null {
  if (!req || typeof req !== 'object') return null
  const r = req as Record<string, unknown>
  if (r.op === 'get') {
    if (!Array.isArray(r.ids) || r.ids.length === 0 || r.ids.length > ITEMS_MAX) return null
    if (!r.ids.every((id) => typeof id === 'string' && ID_RE.test(id))) return null
    return { op: 'getMany', ids: [...r.ids] }
  }
  if (r.op !== 'set' || !Array.isArray(r.items) || r.items.length === 0 || r.items.length > ITEMS_MAX) return null
  const items: Record<string, unknown>[] = []
  for (const it of r.items) {
    if (!it || typeof it !== 'object') return null
    const o = it as Record<string, unknown>
    if (typeof o.id !== 'string' || !ID_RE.test(o.id)) return null
    const item: Record<string, unknown> = { id: o.id }
    if (cleanValues(o, item) === null) return null
    items.push(item)
  }
  const out: Record<string, unknown> = { op: 'setMany', items }
  if (r.final === true) out.final = true
  if (typeof r.label === 'string' && r.label) out.label = r.label.slice(0, LABEL_MAX)
  return out
}

export function parseTunerRectInfos(v: unknown): TunerRectInfo[] {
  if (!Array.isArray(v)) return []
  return v.map(parseTunerRectInfo).filter((x): x is TunerRectInfo => x !== null)
}

function num2(v: unknown): V2 | null {
  const r = vec(v, 2, Infinity)
  return r ? [r[0], r[1]] : null
}

function num3(v: unknown): Vec3 | null {
  const r = vec(v, 3, Infinity)
  return r ? [r[0], r[1], r[2]] : null
}

function frameOf(v: unknown): TunerRectFrame | null {
  if (!v || typeof v !== 'object') return null
  const f = v as Record<string, unknown>
  const origin = num3(f.origin)
  const ux = num3(f.ux)
  const uy = num3(f.uy)
  const uz = num3(f.uz)
  return origin && ux && uy && uz ? { origin, ux, uy, uz } : null
}

export function parseTunerRectInfo(v: unknown): TunerRectInfo | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  const anchorMin = num2(o.anchorMin)
  const anchorMax = num2(o.anchorMax)
  const anchoredPosition = num2(o.anchoredPosition)
  const sizeDelta = num2(o.sizeDelta)
  const pivot = num2(o.pivot)
  const rect = vec(o.rect, 4, Infinity)
  const q = vec(o.localRotation, 4, Infinity)
  const localScale = num3(o.localScale)
  const frame = frameOf(o.frame)
  if (typeof o.id !== 'string' || !anchorMin || !anchorMax || !anchoredPosition || !sizeDelta || !pivot || !rect || !q || !localScale || !frame)
    return null
  let parent: TunerRectParent | null = null
  if (o.parent && typeof o.parent === 'object') {
    const pf = frameOf(o.parent)
    const pr = vec((o.parent as Record<string, unknown>).rect, 4, Infinity)
    if (pf && pr) parent = { ...pf, rect: [pr[0], pr[1], pr[2], pr[3]] }
  }
  return {
    id: o.id,
    anchorMin,
    anchorMax,
    anchoredPosition,
    sizeDelta,
    pivot,
    localRotation: [q[0], q[1], q[2], q[3]],
    localPositionZ: finite(o.localPositionZ) ? o.localPositionZ : 0,
    rect: [rect[0], rect[1], rect[2], rect[3]],
    localScale,
    frame,
    parent,
    ...(o.renderer === true ? { renderer: true } : {})
  }
}
