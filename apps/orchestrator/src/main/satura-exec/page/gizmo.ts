import { viewportBox, type PartBox } from './anchor'
import { GIZMO_ASK_ATTR, GIZMO_AT_ATTR, GIZMO_EVENT, type GizmoSpec } from '../../../shared/gizmo-pick'

export type { GizmoSpec } from '../../../shared/gizmo-pick'

function gizmoPoint(el: Element, spec: GizmoSpec): { x: number; y: number; kind: string; keep: { x: number; y: number; width: number; height: number } | null } | null {
  el.setAttribute(GIZMO_ASK_ATTR, JSON.stringify({ axis: spec.axis, kind: spec.kind }))
  el.removeAttribute(GIZMO_AT_ATTR)
  el.dispatchEvent(new Event(GIZMO_EVENT))
  const raw = el.getAttribute(GIZMO_AT_ATTR)
  if (!raw) return null
  try {
    const p = JSON.parse(raw) as { x?: unknown; y?: unknown; kind?: unknown; keep?: { x: number; y: number; width: number; height: number } | null }
    if (typeof p.x !== 'number' || typeof p.y !== 'number') return null
    const k = p.keep
    const keep = k && typeof k.x === 'number' && typeof k.y === 'number' && typeof k.width === 'number' && typeof k.height === 'number' ? { x: k.x, y: k.y, width: k.width, height: k.height } : null
    return { x: p.x, y: p.y, kind: typeof p.kind === 'string' ? p.kind : '', keep }
  } catch {
    return null
  }
}

export function gizmoBox(el: Element, spec: GizmoSpec, stop: Window | null = null): PartBox | null {
  const p = gizmoPoint(el, spec)
  if (!p) return null
  const r = viewportBox(el, stop)
  const keep = p.keep ? { x: r.x + p.keep.x, y: r.y + p.keep.y, width: p.keep.width, height: p.keep.height } : null
  return { x: r.x + p.x - 3, y: r.y + p.y - 3, width: 6, height: 6, keep, via: p.kind }
}
