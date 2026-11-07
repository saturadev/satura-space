import type { Box } from './bubble'
import type { PartBox } from './anchor'
import { clientRect } from './rect'

export type Part = (el: Element) => Box | null
export type FieldSide = 'value' | 'label'

const EYEDROPPER = 20
const UITK_TEXT = /text-field__input|unity-text-input|__input--single-line|__input--multiline/

function scaled(el: Element): { r: DOMRect; k: number } {
  const r = clientRect(el)
  const w = (el as HTMLElement).offsetWidth
  return { r, k: w > 0 ? r.width / w : 1 }
}

function valueAt(el: Element): number[] | null {
  const v = (el.getAttribute('data-ti-value-at') ?? '').trim().split(/\s+/).map(Number)
  return v.length === 4 && v.every((n) => Number.isFinite(n)) && v[2] > 0 && v[3] > 0 ? v : null
}

function boxOf(el: Element | null | undefined): Box | null {
  if (!el) return null
  const r = clientRect(el)
  return r.width > 0 && r.height > 0 ? { x: r.left, y: r.top, width: r.width, height: r.height } : null
}

function uitkPick(el: Element, re: RegExp, type?: string): Element | null {
  const all = Array.from(el.querySelectorAll('[data-uitk-id]')).filter((e) => re.test(e.getAttribute('data-uitk-class') ?? '') && (!type || e.getAttribute('data-uitk-type') === type))
  return all.filter((e) => clientRect(e).width > 0).pop() ?? null
}

function uitkValue(el: Element): Box | null {
  const type = el.getAttribute('data-uitk-type') ?? ''
  if (/Foldout/.test(type)) return null
  if (/Toggle/.test(type)) return boxOf(uitkPick(el, /unity-toggle__checkmark/) ?? uitkPick(el, /__input/))
  if (/ColorField|ObjectField|Popup|Enum|Mask|Layer|Tag|Dropdown/.test(type)) return boxOf(uitkPick(el, /__input/))
  return boxOf(uitkPick(el, UITK_TEXT) ?? uitkPick(el, /__input/))
}

const SKIP_DRAWS = new Set(['label', 'custom', 'foldout'])
const drawCache = new WeakMap<Element, { label: Element | null; value: Element[] }>()

function union(list: Box[]): Box | null {
  if (!list.length) return null
  const x0 = Math.min(...list.map((b) => b.x))
  const y0 = Math.min(...list.map((b) => b.y))
  const x1 = Math.max(...list.map((b) => b.x + b.width))
  const y1 = Math.max(...list.map((b) => b.y + b.height))
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
}

function drawsOf(el: Element): { label: Element | null; value: Element[] } {
  const was = drawCache.get(el)
  if (was && (!was.label || was.label.isConnected) && was.value.every((d) => d.isConnected)) return was
  const sec = el.closest('[data-ti-section]')
  const r = clientRect(el)
  const out: { label: Element | null; value: Element[] } = { label: null, value: [] }
  if (sec && r.height > 0) {
    const rows: { el: Element; kind: string; b: Box }[] = []
    for (const d of Array.from(sec.querySelectorAll('[data-ti-widget]'))) {
      const b = boxOf(d)
      if (!b) continue
      const cy = b.y + b.height / 2
      if (cy < r.top || cy > r.bottom || b.x + b.width <= r.left || b.x >= r.right) continue
      rows.push({ el: d, kind: d.getAttribute('data-ti-widget') ?? '', b })
    }
    out.label = rows.filter((d) => d.kind === 'label').sort((a, b) => a.b.x - b.b.x)[0]?.el ?? null
    const values = rows.filter((d) => !SKIP_DRAWS.has(d.kind))
    const fields = values.filter((d) => d.kind === 'field')
    const widest = [...values].sort((a, b) => b.b.width - a.b.width)[0]
    out.value = fields.length > 1 && widest?.kind === 'field' ? fields.map((d) => d.el) : widest ? [widest.el] : []
  }
  drawCache.set(el, out)
  return out
}

export function valueBox(el: Element): Box | null {
  if (el.hasAttribute('data-uitk-type')) return uitkValue(el)
  const v = valueAt(el)
  if (!v) return union(drawsOf(el).value.map(boxOf).filter((b): b is Box => !!b))
  const { r, k } = scaled(el)
  const w = el.getAttribute('data-ti-value-widget') === 'colorField' && v[2] > EYEDROPPER * 3 ? v[2] - EYEDROPPER : v[2]
  return { x: r.left + v[0] * k, y: r.top + v[1] * k, width: w * k, height: v[3] * k }
}

export function labelBox(el: Element): Box | null {
  if (el.hasAttribute('data-uitk-type')) return boxOf(uitkPick(el, /base-field__label/, 'Label'))
  const v = valueAt(el)
  if (!v) return boxOf(drawsOf(el).label)
  const { r, k } = scaled(el)
  return { x: r.left, y: r.top, width: Math.min(r.width, Math.max(24, v[0] - 4) * k), height: r.height }
}

export const whole: Part = (el) => boxOf(el)

export const valuePart: Part = (el) => valueBox(el) ?? whole(el)

export const labelPart: Part = (el) => {
  const b = labelBox(el)
  if (b) return b
  const { r, k } = scaled(el)
  return { x: r.left, y: r.top, width: Math.min(r.width, 140 * k), height: r.height }
}

export function fieldBox(el: Element, side: FieldSide): Box | null {
  return side === 'label' ? labelBox(el) : valueBox(el)
}

export function exactPart(part: Part, via: string): (el: Element) => PartBox | null {
  return (el) => {
    const b = part(el)
    return b ? { ...b, keep: b, via } : null
  }
}
