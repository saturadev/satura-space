import type { GizmoSpec } from './gizmo-pick'

export type DriftSide = 'value' | 'label'

export type DriftSpot =
  | { kind: 'row'; tab: string; key: string; path: string }
  | { kind: 'field'; tab: string; section: string; prop: string; side: DriftSide | null }
  | { kind: 'gizmo'; tab: string; gizmo: GizmoSpec }
  | { kind: 'scene'; tab: string; x: number; y: number }
  | { kind: 'part'; tab: string; pane: string; own: string; x: number; y: number }

export type PhoneDriftOp = 'point' | 'say' | 'ask' | 'answered' | 'bye'

export interface PhoneDriftCue {
  run: number
  seq: number
  workspace: string
  name: string
  op: PhoneDriftOp
  text?: string
  ms?: number
  buttons?: string[]
  spot?: DriftSpot | null
  search?: string | null
  label?: string | null
}

export interface PhoneDriftAnswer {
  run: number
  seq: number
  label: string | null
}

export const DRIFT_PANES = [
  '[data-tuner-toolbar]',
  '[data-tuner-footer]',
  '[data-tuner-filter]',
  '[data-tuner-animator]',
  '[data-tuner-inspector]',
  '[data-tuner-hierarchy-pane]',
  '[data-scene-viewport]',
  '[data-unity-player]',
  '[data-unity-console]',
  '[data-tuner-pane]'
]

const OWN_ATTRS = ['data-hierarchy-search', 'data-tuner-save', 'data-tuner-discard', 'data-tuner-copy-changes', 'data-tuner-animation-toggle', 'data-tuner-ask']

function frac(el: Element, at: { x: number; y: number } | null): { x: number; y: number } {
  const r = el.getBoundingClientRect()
  if (!at || r.width <= 0 || r.height <= 0) return { x: 0.5, y: 0.5 }
  const k = (v: number): number => Math.round(Math.max(0, Math.min(1, v)) * 1000) / 1000
  return { x: k((at.x - r.left) / r.width), y: k((at.y - r.top) / r.height) }
}

function quote(v: string): string {
  return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function ownOf(el: Element): { sel: string; el: Element } | null {
  for (let cur: Element | null = el, depth = 0; cur && depth < 4; cur = cur.parentElement, depth++) {
    const attr = OWN_ATTRS.find((a) => cur!.hasAttribute(a))
    if (attr) return { sel: `[${attr}]`, el: cur }
    const label = cur.getAttribute('aria-label')
    if (label) return { sel: `[aria-label=${quote(label)}]`, el: cur }
    const tip = cur.getAttribute('data-ti-tip') ?? cur.getAttribute('title')
    if (tip && (cur.tagName === 'BUTTON' || cur.getAttribute('role') === 'button')) return { sel: `[${cur.hasAttribute('data-ti-tip') ? 'data-ti-tip' : 'title'}=${quote(tip)}]`, el: cur }
  }
  return null
}

export function driftSpotOf(el: Element | null, gizmo: GizmoSpec | null, side: DriftSide | null, at: { x: number; y: number } | null): DriftSpot | null {
  if (!el) return null
  const tab = el.closest('[data-tuner-tab]')?.getAttribute('data-tuner-tab') ?? ''
  if (gizmo) return { kind: 'gizmo', tab, gizmo: { axis: gizmo.axis, kind: gizmo.kind, ...(gizmo.path ? { path: gizmo.path } : {}) } }
  const row = el.closest('[data-row-key]')
  if (row) return { kind: 'row', tab, key: row.getAttribute('data-row-key') ?? '', path: row.getAttribute('data-row-path') ?? '' }
  const section = el.closest('[data-ti-section]')
  if (section) {
    const prop = el.closest('[data-ti-prop]')
    const uitk = prop ? null : el.closest('[data-uitk-path]')
    const sel = prop ? `[data-ti-prop=${quote(prop.getAttribute('data-ti-prop') ?? '')}]` : uitk ? `[data-uitk-path=${quote(uitk.getAttribute('data-uitk-path') ?? '')}]` : ''
    return { kind: 'field', tab, section: section.getAttribute('data-ti-section') ?? '', prop: sel, side }
  }
  const scene = el.closest('[data-scene-viewport]')
  if (scene && !ownOf(el)) return { kind: 'scene', tab, ...frac(scene, at) }
  const pane = DRIFT_PANES.find((sel) => el.closest(sel)) ?? ''
  const own = ownOf(el)
  const box = own?.el ?? (pane ? el.closest(pane) : null) ?? el
  return { kind: 'part', tab, pane, own: own?.sel ?? '', ...frac(box, at) }
}

export function describeDriftSpot(s: DriftSpot | null | undefined): string {
  if (!s) return 'nothing'
  if (s.kind === 'row') return `hierarchy row ${s.path || s.key}`
  if (s.kind === 'field') return `inspector ${s.section}${s.prop ? ` ${s.prop}` : ''}${s.side ? ` (${s.side})` : ''}`
  if (s.kind === 'gizmo') return s.gizmo.kind === 'object' ? `${s.gizmo.path || 'the selection'} in the scene view` : `gizmo axis ${s.gizmo.axis}`
  if (s.kind === 'scene') return `scene view at (${s.x}, ${s.y})`
  return `${s.pane || 'app'}${s.own ? ` ${s.own}` : ''}`
}
