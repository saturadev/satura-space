import type { SegmentView } from './report-groups'

export const SEG_TEXT_MAX = 150
export const OVERFLOW_CHIP_W = 52

let canvas: CanvasRenderingContext2D | null = null
let family = ''

export function textWidth(text: string, px: number): number {
  if (!canvas) canvas = document.createElement('canvas').getContext('2d')
  if (!family) family = getComputedStyle(document.body).fontFamily || 'system-ui'
  if (!canvas) return text.length * px * 0.55
  canvas.font = `${px}px ${family}`
  return canvas.measureText(text).width
}

export function segmentWidth(label: string, depth: number): number {
  const px = depth > 0 ? 12 : 12.5
  const chrome = depth > 0 ? 4 + 12 + 4 + 4 + 16 + 6 : 6 + 14 + 6 + 4 + 16 + 6
  const separator = depth > 0 ? 10 : 6
  return Math.ceil(Math.min(SEG_TEXT_MAX, textWidth(label, px)) + chrome + separator)
}

export function fitSegments(
  flat: SegmentView[],
  activeId: string | null,
  budget: number | undefined,
  widthOf: (v: SegmentView) => number
): { shown: SegmentView[]; hidden: SegmentView[] } {
  if (budget === undefined || flat.length === 0) return { shown: flat, hidden: [] }
  const widths = new Map(flat.map((v) => [v.tab.id, widthOf(v)] as const))
  const total = [...widths.values()].reduce((a, b) => a + b, 0)
  if (total <= budget) return { shown: flat, hidden: [] }
  const byId = new Map(flat.map((v) => [v.tab.id, v] as const))
  const at = Math.max(0, flat.findIndex((v) => v.tab.id === activeId))
  const must: string[] = []
  for (let cur: SegmentView | undefined = flat.findIndex((v) => v.tab.id === activeId) >= 0 ? flat[at] : undefined; cur; cur = cur.parentTabId ? byId.get(cur.parentTabId) : undefined) must.push(cur.tab.id)
  const order: string[] = []
  for (let d = 0; order.length < flat.length; d++) {
    const r = at + d
    const l = at - d
    if (r < flat.length) order.push(flat[r].tab.id)
    if (d > 0 && l >= 0) order.push(flat[l].tab.id)
    if (r >= flat.length && l < 0) break
  }
  const keep = new Set<string>()
  let used = OVERFLOW_CHIP_W
  for (const id of must) {
    keep.add(id)
    used += widths.get(id) ?? 0
  }
  for (const id of order) {
    if (keep.has(id)) continue
    const chain: string[] = []
    for (let cur = byId.get(id); cur && !keep.has(cur.tab.id); cur = cur.parentTabId ? byId.get(cur.parentTabId) : undefined) chain.push(cur.tab.id)
    const w = chain.reduce((sum, c) => sum + (widths.get(c) ?? 0), 0)
    if (used + w > budget) continue
    for (const c of chain) keep.add(c)
    used += w
  }
  return { shown: flat.filter((v) => keep.has(v.tab.id)), hidden: flat.filter((v) => !keep.has(v.tab.id)) }
}
