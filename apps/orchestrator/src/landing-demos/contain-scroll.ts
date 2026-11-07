type Mode = ScrollLogicalPosition

function scrolls(el: Element, axis: 'x' | 'y'): boolean {
  if (el === document.documentElement) return axis === 'y' ? el.scrollHeight > window.innerHeight : el.scrollWidth > window.innerWidth
  const s = getComputedStyle(el)
  if (!/(auto|scroll|overlay|hidden)/.test(axis === 'y' ? s.overflowY : s.overflowX)) return false
  return axis === 'y' ? el.scrollHeight > el.clientHeight + 1 : el.scrollWidth > el.clientWidth + 1
}

function viewOf(el: Element): { left: number; top: number; right: number; bottom: number } {
  if (el === document.documentElement) return { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight }
  const r = el.getBoundingClientRect()
  const left = r.left + el.clientLeft
  const top = r.top + el.clientTop
  return { left, top, right: left + el.clientWidth, bottom: top + el.clientHeight }
}

export function shift(a0: number, a1: number, v0: number, v1: number, mode: Mode): number {
  if (mode === 'start') return a0 - v0
  if (mode === 'end') return a1 - v1
  if (mode === 'center') return (a0 + a1) / 2 - (v0 + v1) / 2
  if (a0 < v0 && a1 - a0 <= v1 - v0) return a0 - v0
  if (a1 > v1 && a1 - a0 <= v1 - v0) return a1 - v1
  if (a0 > v0 && a1 - a0 > v1 - v0) return a0 - v0
  if (a1 < v1 && a1 - a0 > v1 - v0) return a1 - v1
  return 0
}

export function revealInside(el: Element, block: Mode = 'nearest', inline: Mode = 'nearest', needed = false): void {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const y = scrolls(p, 'y')
    const x = scrolls(p, 'x')
    if (!y && !x) continue
    const r = el.getBoundingClientRect()
    const v = viewOf(p)
    if (y && (!needed || shift(r.top, r.bottom, v.top, v.bottom, 'nearest'))) p.scrollTop += shift(r.top, r.bottom, v.top, v.bottom, block)
    if (x && (!needed || shift(r.left, r.right, v.left, v.right, 'nearest'))) p.scrollLeft += shift(r.left, r.right, v.left, v.right, inline)
  }
}

export function containScroll(): void {
  if (window.parent === window) return
  Element.prototype.scrollIntoView = function (this: Element, arg?: boolean | ScrollIntoViewOptions): void {
    const o: ScrollIntoViewOptions = typeof arg === 'object' && arg ? arg : { block: arg === false ? 'end' : 'start', inline: 'nearest' }
    revealInside(this, o.block ?? 'start', o.inline ?? 'nearest')
  }
  const proto = Element.prototype as Element & { scrollIntoViewIfNeeded?: (center?: boolean) => void }
  proto.scrollIntoViewIfNeeded = function (this: Element, center?: boolean): void {
    revealInside(this, center === false ? 'nearest' : 'center', center === false ? 'nearest' : 'center', true)
  }
  for (const P of [HTMLElement.prototype, SVGElement.prototype]) {
    const focus = P.focus
    P.focus = function (this: HTMLElement | SVGElement, o?: FocusOptions): void {
      focus.call(this, { ...o, preventScroll: true })
    }
  }
}
