export const DRIFT_SCALE = 2.6
export const CELL_BASE = 3 * DRIFT_SCALE

export type Pose = 'reach' | 'side' | 'up'

export interface Box {
  x: number
  y: number
  width: number
  height: number
}

export interface PoseGeo {
  hx: number
  hy: number
  bx0: number
  bx1: number
  by0: number
  by1: number
  bs1: number
  ey: number
}

export function poseGeo(pose: Pose, mirror: boolean, S: number): PoseGeo {
  const hx = (mirror ? 0.5 : 11.5) * S
  const bx0 = (mirror ? 3 : 0) * S
  const bx1 = (mirror ? 12 : 9) * S
  if (pose === 'up') return { hx, hy: 0.5 * S, bx0, bx1, by0: 3 * S, by1: 10 * S, bs1: 8 * S, ey: 6 * S }
  return { hx, hy: (pose === 'side' ? 4.5 : 9.5) * S, bx0, bx1, by0: S, by1: 8 * S, bs1: 6 * S, ey: 4 * S }
}

function bellBox(A: { x: number; y: number }, g: PoseGeo): Box {
  return { x: A.x - g.hx + g.bx0, y: A.y - g.hy + g.by0, width: g.bx1 - g.bx0, height: g.bs1 - g.by0 }
}

export function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
}

const ORDER: [Pose, boolean][] = [
  ['reach', false],
  ['reach', true],
  ['up', false],
  ['up', true],
  ['side', false],
  ['side', true]
]

function choosePose(
  A: { x: number; y: number },
  target: Box | null,
  view: { width: number; height: number },
  S: number
): { pose: Pose; mirror: boolean } {
  const keepOff = target
  let fallback: { pose: Pose; mirror: boolean } | null = null
  for (const [pose, mirror] of ORDER) {
    const bell = bellBox(A, poseGeo(pose, mirror, S))
    const fits = bell.x >= 2 && bell.y >= 2 && bell.x + bell.width <= view.width - 2 && bell.y + bell.height <= view.height - 2
    if (!fits) continue
    if (!keepOff || !overlaps(bell, keepOff)) return { pose, mirror }
    fallback ??= { pose, mirror }
  }
  return fallback ?? { pose: 'reach', mirror: A.x - 12 * S < 2 }
}

function keepBand(box: Box): Box {
  const ext = Math.min(box.height, 32)
  return { x: box.x - 2, y: box.y - ext, width: box.width + 4, height: box.height + 2 * ext }
}

export function isArea(box: Box | null, S: number): boolean {
  return !!box && box.width >= 36 * S && box.height >= 36 * S
}

export function areaPoint(box: Box, S: number): { x: number; y: number } {
  return { x: box.x + Math.min(3 * S, box.width / 4), y: box.y + Math.min(3 * S, box.height / 4) }
}

export function placeHand(
  A: { x: number; y: number },
  target: Box | null,
  view: { width: number; height: number },
  S: number,
  slide: boolean,
  within: Box | null = null
): { pose: Pose; mirror: boolean; x: number; y: number } {
  if (!target) return { ...choosePose(A, null, view, S), x: A.x, y: A.y }
  const keep = keepBand(isArea(target, S) ? { x: A.x - 1, y: A.y - 1, width: 2, height: 2 } : target)
  const w = within ?? target
  const ix = Math.min(4, w.width / 4)
  const iy = Math.min(3, w.height / 4)
  const lo = { x: w.x + ix, y: w.y + iy }
  const hi = { x: w.x + w.width - ix, y: w.y + w.height - iy }
  let best: { pose: Pose; mirror: boolean; x: number; y: number; d: number } | null = null
  ORDER.forEach(([pose, mirror], i) => {
    const g = poseGeo(pose, mirror, S)
    const x0 = g.bx0 - g.hx
    const x1 = g.bx1 - g.hx
    const y0 = g.by0 - g.hy
    const y1 = g.by1 - g.hy
    const cands = slide
      ? [
          { x: Math.min(A.x, keep.x - x1), y: A.y },
          { x: Math.max(A.x, keep.x + keep.width - x0), y: A.y },
          { x: A.x, y: Math.min(A.y, keep.y - y1) },
          { x: A.x, y: Math.max(A.y, keep.y + keep.height - y0) }
        ]
      : [{ x: A.x, y: A.y }]
    for (const c of cands) {
      if (slide && (c.x < lo.x - 0.01 || c.x > hi.x + 0.01 || c.y < lo.y - 0.01 || c.y > hi.y + 0.01)) continue
      const body = { x: c.x + x0, y: c.y + y0, width: x1 - x0, height: y1 - y0 }
      if (body.x < 2 || body.y < 2 || body.x + body.width > view.width - 2 || body.y + body.height > view.height - 2) continue
      if (overlaps(body, keep)) continue
      const d = Math.hypot(c.x - A.x, c.y - A.y) + i * 0.5
      if (!best || d < best.d) best = { pose, mirror, x: c.x, y: c.y, d }
    }
  })
  if (best) {
    const b: { pose: Pose; mirror: boolean; x: number; y: number } = best
    return { pose: b.pose, mirror: b.mirror, x: b.x, y: b.y }
  }
  return { ...choosePose(A, target, view, S), x: A.x, y: A.y }
}

export function exactPose(A: { x: number; y: number }, keep: Box | null, view: { width: number; height: number }, S: number): { pose: Pose; mirror: boolean } {
  let best: { pose: Pose; mirror: boolean; cost: number } | null = null
  ORDER.forEach(([pose, mirror], i) => {
    const g = poseGeo(pose, mirror, S)
    const body = { x: A.x - g.hx + g.bx0, y: A.y - g.hy + g.by0, width: g.bx1 - g.bx0, height: g.by1 - g.by0 }
    const out = body.x < 2 || body.y < 2 || body.x + body.width > view.width - 2 || body.y + body.height > view.height - 2
    const w = keep ? Math.min(body.x + body.width, keep.x + keep.width) - Math.max(body.x, keep.x) : 0
    const h = keep ? Math.min(body.y + body.height, keep.y + keep.height) - Math.max(body.y, keep.y) : 0
    const cost = (out ? 1e9 : 0) + (w > 0 && h > 0 ? w * h : 0) + i
    if (!best || cost < best.cost) best = { pose, mirror, cost }
  })
  const b = best as { pose: Pose; mirror: boolean; cost: number } | null
  return b ? { pose: b.pose, mirror: b.mirror } : { pose: 'reach', mirror: false }
}
