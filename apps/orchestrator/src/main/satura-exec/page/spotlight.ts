export interface Box {
  x: number
  y: number
  width: number
  height: number
}

export const SPOT_PAD = 14
export const SPOT_FEATHER = 1
export const SPOT_FOLLOW_MS = 70
export const SPOT_STOPS = 10
export const DIM_COLOR = '#000'
export const DIM_OPACITY = 0.4
export const DIM_FADE_MS = 200
export const DIM_LIFT_MS = 80

export interface Circle {
  cx: number
  cy: number
  r: number
}

export function boundsOf(boxes: (Box | null)[]): Box | null {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const b of boxes) {
    if (!b || !(b.width > 0) || !(b.height > 0)) continue
    x0 = Math.min(x0, b.x)
    y0 = Math.min(y0, b.y)
    x1 = Math.max(x1, b.x + b.width)
    y1 = Math.max(y1, b.y + b.height)
  }
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : null
}

export function spotlightCircle(boxes: (Box | null)[]): Circle | null {
  const b = boundsOf(boxes)
  if (!b) return null
  return { cx: b.x + b.width / 2, cy: b.y + b.height / 2, r: Math.hypot(b.width, b.height) / 2 + SPOT_PAD }
}

export function followCircle(prev: Circle | null, goal: Circle, boxes: (Box | null)[], dt: number): Circle {
  if (!prev) return goal
  const k = 1 - Math.exp(-Math.max(0, dt) / SPOT_FOLLOW_MS)
  const cx = prev.cx + (goal.cx - prev.cx) * k
  const cy = prev.cy + (goal.cy - prev.cy) * k
  let r = prev.r + (goal.r - prev.r) * k
  const b = boundsOf(boxes)
  if (b) {
    const reach = Math.max(
      Math.hypot(b.x - cx, b.y - cy),
      Math.hypot(b.x + b.width - cx, b.y - cy),
      Math.hypot(b.x - cx, b.y + b.height - cy),
      Math.hypot(b.x + b.width - cx, b.y + b.height - cy)
    )
    r = Math.max(r, reach + SPOT_PAD)
  }
  return { cx, cy, r }
}

export function falloffAlpha(t: number): number {
  const u = Math.min(1, Math.max(0, t))
  return u * u * u * (u * (u * 6 - 15) + 10)
}

const round = (v: number): number => Math.round(v * 2) / 2

export function spotlightMask(c: Circle, area: Box): string {
  const clear = c.r
  const outer = clear * (1 + SPOT_FEATHER)
  const stops = [`transparent ${((clear / outer) * 100).toFixed(2)}%`]
  for (let i = 1; i < SPOT_STOPS; i++) {
    const t = i / SPOT_STOPS
    const pos = (clear + (outer - clear) * t) / outer
    stops.push(`rgba(0,0,0,${falloffAlpha(t).toFixed(3)}) ${(pos * 100).toFixed(2)}%`)
  }
  stops.push('#000 100%')
  return `radial-gradient(circle ${round(outer)}px at ${round(c.cx - area.x)}px ${round(c.cy - area.y)}px, ${stops.join(', ')})`
}

export function dimWanted(o: { enabled: boolean; asked: boolean; on: boolean; leaving: boolean; shown: boolean; paused: boolean; hidden: boolean; area: Box | null }): boolean {
  return o.enabled && o.asked && o.on && !o.leaving && o.shown && !o.paused && !o.hidden && !!o.area && o.area.width > 0 && o.area.height > 0
}
