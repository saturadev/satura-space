export interface Box {
  x: number
  y: number
  w: number
  h: number
}

export function contentBox(canvas: HTMLCanvasElement | null): Box | null {
  if (!canvas) return null
  const r = canvas.getBoundingClientRect()
  const vw = canvas.width
  const vh = canvas.height
  if (r.width <= 0 || r.height <= 0 || vw <= 0 || vh <= 0) return null
  const s = Math.min(r.width / vw, r.height / vh)
  const w = vw * s
  const h = vh * s
  return { x: r.left + (r.width - w) / 2, y: r.top + (r.height - h) / 2, w, h }
}

export function toGame(box: Box, clientX: number, clientY: number): { x: number; y: number; inside: boolean } {
  const x = (clientX - box.x) / box.w
  const y = (clientY - box.y) / box.h
  return { x, y, inside: x >= 0 && x < 1 && y >= 0 && y < 1 }
}

export function haptic(): void {
  try {
    navigator.vibrate?.(8)
  } catch {
  }
}

export function capture(el: Element, id: number): void {
  try {
    el.setPointerCapture(id)
  } catch {
  }
}

export function toLocal(e: { clientX: number; clientY: number }, el: Element): { x: number; y: number } {
  const root = el.closest<HTMLElement>('[data-gi-root]')!
  const r = root.getBoundingClientRect()
  const k = root.offsetWidth > 0 && r.width > 0 ? r.width / root.offsetWidth : 1
  return { x: (e.clientX - r.left) / k, y: (e.clientY - r.top) / k }
}
