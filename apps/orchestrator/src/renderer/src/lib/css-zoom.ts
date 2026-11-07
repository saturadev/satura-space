export function zoomOf(el: Element | null | undefined): number {
  if (!el) return 1
  const w = el instanceof HTMLElement ? el.offsetWidth : el.clientWidth
  if (!(w > 0)) return 1
  const k = el.getBoundingClientRect().width / w
  return Number.isFinite(k) && k > 0 && Math.abs(k - 1) > 0.01 ? k : 1
}
