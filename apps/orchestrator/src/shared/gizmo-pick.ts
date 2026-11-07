export interface GizmoSpec {
  axis: number
  kind: string | null
  path?: string
}

export const GIZMO_OBJECT = 'object'

export interface GizmoAim {
  x: number
  y: number
  kind: string
  keep?: { x: number; y: number; width: number; height: number } | null
}

export interface GizmoPart {
  kind: string
  axis: number
  x: number
  y: number
}

export const GIZMO_EVENT = 'satura-gizmo-point'
export const GIZMO_ASK_ATTR = 'data-gizmo-ask'
export const GIZMO_AT_ATTR = 'data-gizmo-at'

export function pickGizmoPoint(parts: GizmoPart[], ring: (axis: number) => { x: number; y: number; front: boolean }[], a: GizmoSpec): { x: number; y: number; kind: string } | null {
  const isRing = a.kind === 'ring' || (!a.kind && !parts.some((p) => p.axis === a.axis && p.kind !== 'ring') && parts.some((p) => p.axis === a.axis && p.kind === 'ring'))
  if (isRing) {
    const pts = ring(a.axis).filter((p) => p.front)
    const p = pts[Math.floor(pts.length / 2)]
    return p ? { x: p.x, y: p.y, kind: 'ring' } : null
  }
  const p = parts.find((q) => q.axis === a.axis && (a.kind ? q.kind === a.kind : q.kind !== 'ring' && q.kind !== 'plane'))
  return p ? { x: p.x, y: p.y, kind: p.kind } : null
}
