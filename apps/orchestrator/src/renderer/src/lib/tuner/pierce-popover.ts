import { arrow, computePosition, offset, shift, size } from '../floating-ui/dom/index'
import type { Placement } from '../floating-ui/utils/index'
import { placementOrigin, viewRect, type ViewRect } from '../floating'

export const PIERCE_RING = 32
const ARROW = 12
const GAP = 5
const MARGIN = 8
const WIDTH = 280
const ROW = 48
const LIST_CAP = Math.round(ROW * 6.5)
const LIST_MIN = ROW + 8
const SWALLOW_MS = 700

let probe: HTMLDivElement | null = null

function safeInsets(): { t: number; r: number; b: number; l: number } {
  if (!probe || !probe.isConnected) {
    probe = document.createElement('div')
    probe.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;pointer-events:none;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)'
    document.body.appendChild(probe)
  }
  const cs = getComputedStyle(probe)
  return { t: parseFloat(cs.paddingTop) || 0, r: parseFloat(cs.paddingRight) || 0, b: parseFloat(cs.paddingBottom) || 0, l: parseFloat(cs.paddingLeft) || 0 }
}

export function touchBounds(): ViewRect {
  const root = document.documentElement
  const view = viewRect()
  const keyboard = parseFloat(getComputedStyle(root).getPropertyValue('--remote-keyboard')) || 0
  const s = safeInsets()
  const vv = window.visualViewport
  const left = Math.max(view.x, s.l, vv ? vv.offsetLeft : 0)
  const top = Math.max(view.y, s.t, vv ? vv.offsetTop : 0)
  const right = Math.min(view.x + view.width, root.clientWidth - s.r, vv ? vv.offsetLeft + vv.width : Infinity)
  const bottom = Math.min(view.y + view.height - keyboard, root.clientHeight - s.b, vv ? vv.offsetTop + vv.height : Infinity)
  return { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) }
}

const ARROW_EDGE: Record<string, { edge: 'top' | 'bottom' | 'left' | 'right'; borders: [string, string] }> = {
  bottom: { edge: 'top', borders: ['border-top-width', 'border-left-width'] },
  top: { edge: 'bottom', borders: ['border-bottom-width', 'border-right-width'] },
  right: { edge: 'left', borders: ['border-bottom-width', 'border-left-width'] },
  left: { edge: 'right', borders: ['border-top-width', 'border-right-width'] }
}

export interface PiercePlacement {
  side: string
  rect: { x: number; y: number; width: number; height: number }
  bounds: ViewRect
  inside: boolean
  clear: boolean
  scrolls: boolean
}

function pickSide(x: number, y: number, w: number, h: number, b: ViewRect): Placement {
  const reach = PIERCE_RING / 2 + ARROW / 2 + GAP
  const above = y - reach - (b.y + MARGIN)
  const below = b.y + b.height - MARGIN - (y + reach)
  const left = x - reach - (b.x + MARGIN)
  const right = b.x + b.width - MARGIN - (x + reach)
  const tall = b.height - MARGIN * 2
  if (h <= above) return 'top'
  if (h <= below) return 'bottom'
  const vertical = Math.max(above, below)
  if (w <= right && tall > vertical) return 'right'
  if (w <= left && tall > vertical) return 'left'
  return above >= below ? 'top' : 'bottom'
}

export async function placePiercePopover(x: number, y: number, el: HTMLElement, list: HTMLElement, tip: HTMLElement): Promise<PiercePlacement> {
  const bounds = touchBounds()
  const half = PIERCE_RING / 2
  const reference = {
    getBoundingClientRect: () => ({ x: x - half, y: y - half, left: x - half, top: y - half, right: x + half, bottom: y + half, width: PIERCE_RING, height: PIERCE_RING })
  }
  el.style.width = `${Math.max(0, Math.min(WIDTH, bounds.width - MARGIN * 2))}px`
  list.style.maxHeight = `${LIST_CAP}px`
  const res = await computePosition(reference, el, {
    strategy: 'fixed',
    placement: pickSide(x, y, el.offsetWidth, el.offsetHeight, bounds),
    middleware: [
      offset(ARROW / 2 + GAP),
      shift({ rootBoundary: bounds, padding: MARGIN }),
      size({
        rootBoundary: bounds,
        padding: MARGIN,
        apply({ availableHeight }) {
          const chrome = el.offsetHeight - list.offsetHeight
          list.style.maxHeight = `${Math.max(LIST_MIN, Math.min(LIST_CAP, Math.floor(availableHeight - chrome)))}px`
        }
      }),
      arrow({ element: tip, padding: 16 })
    ]
  })
  el.style.left = `${Math.round(res.x)}px`
  el.style.top = `${Math.round(res.y)}px`
  el.style.visibility = ''
  const side = res.placement.split('-')[0]
  el.dataset.side = side
  el.style.transformOrigin = placementOrigin(res.placement)
  const a = res.middlewareData.arrow
  const spec = ARROW_EDGE[side] ?? ARROW_EDGE.top
  Object.assign(tip.style, { left: a?.x != null ? `${a.x}px` : '', top: a?.y != null ? `${a.y}px` : '', right: '', bottom: '', borderWidth: '0', [spec.edge]: `${-ARROW / 2 - 1}px` })
  for (const b of spec.borders) tip.style.setProperty(b, '1px')
  const r = { left: Math.round(res.x), top: Math.round(res.y), width: el.offsetWidth, height: el.offsetHeight, right: Math.round(res.x) + el.offsetWidth, bottom: Math.round(res.y) + el.offsetHeight }
  const inside = r.left >= bounds.x - 0.5 && r.top >= bounds.y - 0.5 && r.right <= bounds.x + bounds.width + 0.5 && r.bottom <= bounds.y + bounds.height + 0.5
  const clear = r.right <= x - half || r.left >= x + half || r.bottom <= y - half || r.top >= y + half
  return { side, rect: { x: r.left, y: r.top, width: r.width, height: r.height }, bounds, inside, clear, scrolls: list.scrollHeight > list.clientHeight + 1 }
}

export function swallowNextClick(): void {
  const done = (): void => {
    window.removeEventListener('click', eat, true)
    window.clearTimeout(timer)
  }
  const eat = (e: MouseEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    done()
  }
  const timer = window.setTimeout(done, SWALLOW_MS)
  window.addEventListener('click', eat, true)
}
