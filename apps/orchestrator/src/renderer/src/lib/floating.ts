import { useLayoutEffect, useRef, useState, type RefObject } from 'react'
import {
  arrow as arrowMiddleware,
  autoUpdate,
  computePosition,
  flip,
  offset,
  shift,
  size,
  type Middleware,
  type VirtualElement
} from './floating-ui/dom/index'
import type { Placement } from './floating-ui/utils/index'
import { debugLog } from '@shared/debug-log'

export type { Placement }

export const FLOAT_MARGIN = 8

export interface ViewRect {
  x: number
  y: number
  width: number
  height: number
}

export function viewRect(): ViewRect {
  const root = document.documentElement
  const vw = root.clientWidth
  const vh = root.clientHeight
  if (root.dataset.layout !== 'mobile') return { x: 0, y: 0, width: vw, height: vh }
  const css = getComputedStyle(root)
  const px = (name: string): number => parseFloat(css.getPropertyValue(name)) || 0
  const top = px('--remote-top')
  const left = px('--remote-left')
  const keyboard = px('--remote-keyboard') || expectedKeyboard
  return { x: left, y: top, width: Math.max(0, vw - left - px('--remote-right')), height: Math.max(0, vh - top - px('--remote-bottom') - keyboard) }
}

const placed = new Set<() => void>()
let expectedKeyboard = 0

export function refloat(): void {
  for (const update of placed) update()
}

export function expectKeyboard(px: number): void {
  if (px === expectedKeyboard) return
  expectedKeyboard = px
  refloat()
}

function reportPlacement(el: HTMLElement, view: ViewRect): void {
  if (document.documentElement.dataset.layout !== 'mobile') return
  const r = el.getBoundingClientRect()
  const inside = r.left >= view.x - 0.5 && r.top >= view.y - 0.5 && r.right <= view.x + view.width + 0.5 && r.bottom <= view.y + view.height + 0.5
  const text = `${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)} in ${Math.round(view.x)},${Math.round(view.y)} ${Math.round(view.width)}x${Math.round(view.height)}`
  if (el.dataset.floatReport === text) return
  el.dataset.floatReport = text
  debugLog(`[popover] ${inside ? 'inside' : 'OUTSIDE'} ${text} ${el.className.split(' ').slice(0, 2).join('.')}`)
}

export type FloatAnchor = Element | VirtualElement | { x: number; y: number }

export interface FloatOptions {
  placement?: Placement
  gap?: number
  crossGap?: number
  padding?: number
  arrow?: HTMLElement | null
  arrowPadding?: number
  fitHeight?: boolean
  fitWidth?: boolean
  fallbackPlacements?: Placement[]
  origin?: boolean
  matchWidth?: boolean
  onPlaced?: (placement: Placement) => void
}

export function pointAnchor(x: number, y: number, contextElement?: Element): VirtualElement {
  return {
    contextElement,
    getBoundingClientRect: () => ({ x, y, left: x, top: y, right: x, bottom: y, width: 0, height: 0 })
  }
}

function toReference(anchor: FloatAnchor): Element | VirtualElement {
  if (anchor instanceof Element) return anchor
  if ('getBoundingClientRect' in anchor) return anchor
  return pointAnchor(anchor.x, anchor.y)
}

export function placementOrigin(placement: Placement): string {
  const [side, align] = placement.split('-')
  const cross = side === 'top' || side === 'bottom' ? (align === 'start' ? 'left' : align === 'end' ? 'right' : 'center') : align === 'start' ? 'top' : align === 'end' ? 'bottom' : 'center'
  const main = ARROW_SIDE[side] ?? 'top'
  return side === 'top' || side === 'bottom' ? `${main} ${cross}` : `${cross} ${main}`
}

const ARROW_SIDE: Record<string, 'top' | 'bottom' | 'left' | 'right'> = {
  top: 'bottom',
  bottom: 'top',
  left: 'right',
  right: 'left'
}

export function placeFloating(anchor: FloatAnchor, el: HTMLElement, opts: FloatOptions = {}, alive: () => boolean = () => true): Promise<void> {
  const reference = toReference(anchor)
  if (reference instanceof Element && !reference.isConnected) return Promise.resolve()
  const padding = opts.padding ?? FLOAT_MARGIN
  const fitHeight = opts.fitHeight ?? true
  const view = viewRect()
  const rootBoundary = { x: view.x, y: view.y, width: view.width, height: view.height }
  const mobile = document.documentElement.dataset.layout === 'mobile'
  const middleware: Middleware[] = [
    offset({ mainAxis: opts.gap ?? 4, crossAxis: opts.crossGap ?? 0 }),
    flip({ padding, rootBoundary, fallbackPlacements: opts.fallbackPlacements }),
    shift({ padding, rootBoundary, crossAxis: mobile }),
    size({
      padding,
      rootBoundary,
      apply({ availableWidth, availableHeight, elements, rects }) {
        const f = elements.floating
        if (opts.matchWidth) f.style.width = `${rects.reference.width}px`
        if (fitHeight) {
          if (f.dataset.floatMaxH === undefined) f.dataset.floatMaxH = getComputedStyle(f).maxHeight
          const own = f.dataset.floatMaxH
          const h = Math.max(0, Math.floor(availableHeight))
          f.style.maxHeight = own && own !== 'none' ? `min(${own}, ${h}px)` : `${h}px`
          f.style.overflowY = f.scrollHeight > f.clientHeight + 1 ? 'auto' : ''
        }
        if (opts.fitWidth || mobile) f.style.maxWidth = `${Math.max(0, Math.floor(opts.fitWidth ? availableWidth : view.width - padding * 2))}px`
      }
    })
  ]
  if (opts.arrow) middleware.push(arrowMiddleware({ element: opts.arrow, padding: opts.arrowPadding ?? 6 }))
  return computePosition(reference, el, { strategy: 'fixed', placement: opts.placement ?? 'bottom', middleware }).then((res) => {
    if (!alive()) return
    el.style.left = `${Math.round(res.x)}px`
    el.style.top = `${Math.round(res.y)}px`
    el.style.visibility = ''
    const side = res.placement.split('-')[0]
    el.dataset.side = side
    el.dataset.placement = res.placement
    if (opts.origin !== false) el.style.transformOrigin = placementOrigin(res.placement)
    opts.onPlaced?.(res.placement)
    if (mobile) requestAnimationFrame(() => el.isConnected && reportPlacement(el, view))
    const a = opts.arrow
    const data = res.middlewareData.arrow
    if (!a || !data) return
    const edge = ARROW_SIDE[side] ?? 'top'
    Object.assign(a.style, {
      left: data.x != null ? `${data.x}px` : '',
      top: data.y != null ? `${data.y}px` : '',
      right: '',
      bottom: '',
      [edge]: `${-a.offsetHeight / 2}px`
    })
  })
}

export function attachFloating(anchor: FloatAnchor, el: HTMLElement, opts: FloatOptions = {}): () => void {
  const reference = toReference(anchor)
  let alive = true
  el.style.position = 'fixed'
  if (!el.style.left) el.style.left = '0px'
  if (!el.style.top) el.style.top = '0px'
  el.style.visibility = 'hidden'
  const update = (): void => {
    void placeFloating(reference, el, opts, () => alive)
  }
  const stop = autoUpdate(reference, el, update)
  placed.add(update)
  const virtual = !(reference instanceof Element)
  let frame = 0
  const onScroll = (): void => {
    if (!frame) frame = requestAnimationFrame(() => {
      frame = 0
      update()
    })
  }
  if (virtual) window.addEventListener('scroll', onScroll, true)
  return () => {
    alive = false
    placed.delete(update)
    stop()
    cancelAnimationFrame(frame)
    if (virtual) window.removeEventListener('scroll', onScroll, true)
  }
}

export function useFloating(
  anchor: FloatAnchor | null | undefined,
  ref: RefObject<HTMLElement | null> | HTMLElement | null,
  opts: FloatOptions = {},
  active = true
): void {
  const optsRef = useRef(opts)
  optsRef.current = opts
  const key = anchor && !(anchor instanceof Element) && !('getBoundingClientRect' in anchor) ? `${anchor.x},${anchor.y}` : anchor
  const direct = ref instanceof HTMLElement ? ref : null
  useLayoutEffect(() => {
    const el = direct ?? (ref && !(ref instanceof HTMLElement) ? ref.current : null)
    if (!active || !el || !anchor) return
    const o = optsRef.current
    return attachFloating(anchor, el, { ...o, onPlaced: (p) => optsRef.current.onPlaced?.(p) })
  }, [key, direct, active, opts.placement, opts.gap, opts.crossGap, opts.padding, opts.arrow, opts.fitHeight, opts.fitWidth, opts.matchWidth])
}

export function useFloatingInParent(ref: RefObject<HTMLElement | null>, opts: FloatOptions = {}, active = true): void {
  const [parent, setParent] = useState<HTMLElement | null>(null)
  useLayoutEffect(() => {
    setParent(ref.current?.parentElement ?? null)
  }, [active])
  useFloating(parent, ref, opts, active)
}

export function keepInView(el: HTMLElement, padding = FLOAT_MARGIN): { stop: () => void; refit: () => void } {
  let frame = 0
  let busy = false
  const fit = (): void => {
    frame = 0
    if (!el.isConnected || busy) return
    busy = true
    el.style.translate = ''
    const view = viewRect()
    const cap = Math.max(0, view.height - padding * 2)
    if (el.dataset.floatMaxH === undefined) el.dataset.floatMaxH = getComputedStyle(el).maxHeight
    const own = el.dataset.floatMaxH
    el.style.maxHeight = own && own !== 'none' ? `min(${own}, ${cap}px)` : `${cap}px`
    el.style.overflowY = el.scrollHeight > el.clientHeight + 1 ? 'auto' : ''
    const r = el.getBoundingClientRect()
    let dx = 0
    let dy = 0
    if (document.documentElement.dataset.layout === 'mobile') el.style.maxWidth = `${Math.max(0, view.width - padding * 2)}px`
    const right = view.x + view.width
    const bottom = view.y + view.height
    if (r.right > right - padding) dx = right - padding - r.right
    if (r.left + dx < view.x + padding) dx = view.x + padding - r.left
    if (r.bottom > bottom - padding) dy = bottom - padding - r.bottom
    if (r.top + dy < view.y + padding) dy = view.y + padding - r.top
    el.style.translate = dx || dy ? `${Math.round(dx)}px ${Math.round(dy)}px` : ''
    busy = false
    requestAnimationFrame(() => el.isConnected && reportPlacement(el, view))
  }
  const schedule = (): void => {
    if (!frame) frame = requestAnimationFrame(fit)
  }
  fit()
  const ro = new ResizeObserver(schedule)
  ro.observe(el)
  placed.add(schedule)
  window.addEventListener('resize', schedule)
  window.addEventListener('scroll', schedule, true)
  return {
    refit: fit,
    stop: () => {
      placed.delete(schedule)
      cancelAnimationFrame(frame)
      ro.disconnect()
      window.removeEventListener('resize', schedule)
      window.removeEventListener('scroll', schedule, true)
    }
  }
}

export function useKeepInView(ref: RefObject<HTMLElement | null>, active = true): void {
  const fit = useRef<(() => void) | null>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!active || !el) return
    const k = keepInView(el)
    fit.current = k.refit
    return () => {
      fit.current = null
      k.stop()
    }
  }, [active])
  useLayoutEffect(() => {
    fit.current?.()
  })
}
