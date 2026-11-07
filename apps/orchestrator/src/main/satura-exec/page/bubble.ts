const BUBBLE_GAP = 12
export const BUBBLE_MARGIN = 6

export interface Box {
  x: number
  y: number
  width: number
  height: number
}

export type BubbleSide = 'above' | 'left' | 'right' | 'below'

export interface BubblePlace {
  x: number
  y: number
  side: BubbleSide
}

export function bubbleText(raw: unknown): string {
  return String(raw ?? '').replace(/\s+/g, ' ').trim()
}

export const HOLD_MAX_MS = 60_000

export function bubbleMs(text: string, ms?: unknown): number {
  if (typeof ms === 'number' && Number.isFinite(ms) && ms > 0) return Math.min(HOLD_MAX_MS, Math.round(ms))
  return Math.max(1200, Math.min(6000, 900 + text.length * 45))
}

function overlap(a: Box, b: Box): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  return w > 0 && h > 0 ? w * h : 0
}

function clamp(v: number, lo: number, hi: number): number {
  return hi < lo ? lo : Math.max(lo, Math.min(hi, v))
}

export const BUBBLE_TAIL_ROOM = 16
const SIDE_SLACK = 4
const SHIFT_MAX = 40

export function bubbleGap(bell: Box, bubble: Box): number {
  const dx = Math.max(0, bubble.x - (bell.x + bell.width), bell.x - (bubble.x + bubble.width))
  const dy = Math.max(0, bubble.y - (bell.y + bell.height), bell.y - (bubble.y + bubble.height))
  return Math.hypot(dx, dy)
}

export function placeBubble(o: {
  bell: Box
  target: Box | null
  size: { width: number; height: number }
  view: { width: number; height: number }
  prefer?: string | null
}): BubblePlace {
  const { bell, target, size, view } = o
  const w = size.width
  const h = size.height
  const cx = bell.x + bell.width / 2
  const cy = bell.y + bell.height / 2
  const maxX = view.width - BUBBLE_MARGIN - w
  const maxY = view.height - BUBBLE_MARGIN - h
  const slideX = (x: number): number => clamp(clamp(x, BUBBLE_MARGIN, maxX), cx - w + BUBBLE_TAIL_ROOM, cx - BUBBLE_TAIL_ROOM)
  const slideY = (y: number): number => clamp(clamp(y, BUBBLE_MARGIN, maxY), cy - h + BUBBLE_TAIL_ROOM, cy - BUBBLE_TAIL_ROOM)
  const raw: BubblePlace[] = [
    { side: 'above', x: slideX(cx - w / 2), y: bell.y - BUBBLE_GAP - h },
    { side: 'left', x: bell.x - BUBBLE_GAP - w, y: slideY(cy - h / 2) },
    { side: 'right', x: bell.x + bell.width + BUBBLE_GAP, y: slideY(cy - h / 2) },
    { side: 'below', x: slideX(cx - w / 2), y: bell.y + bell.height + BUBBLE_GAP }
  ]
  const keepOff = target
    ? { x: target.x - 2, y: target.y - 2, width: target.width + 4, height: target.height + 4 }
    : null
  const area = w * h
  const shift = new Map<BubblePlace, number>()
  if (keepOff) {
    for (const c of raw.slice()) {
      if (!overlap({ x: c.x, y: c.y, width: w, height: h }, keepOff)) continue
      const s: BubblePlace =
        c.side === 'above'
          ? { ...c, y: Math.min(c.y, keepOff.y - BUBBLE_MARGIN - h) }
          : c.side === 'below'
            ? { ...c, y: Math.max(c.y, keepOff.y + keepOff.height + BUBBLE_MARGIN) }
            : c.side === 'left'
              ? { ...c, x: Math.min(c.x, keepOff.x - BUBBLE_MARGIN - w) }
              : { ...c, x: Math.max(c.x, keepOff.x + keepOff.width + BUBBLE_MARGIN) }
      const d = Math.abs(s.x - c.x) + Math.abs(s.y - c.y)
      if (d > SHIFT_MAX) continue
      shift.set(s, d)
      raw.push(s)
    }
  }
  const costOf = (c: BubblePlace): number => {
    const keep = c.side === o.prefer
    const box = { x: c.x, y: c.y, width: w, height: h }
    const cut = Math.max(0, Math.max(0, BUBBLE_MARGIN - c.x) + Math.max(0, c.x - maxX) + Math.max(0, BUBBLE_MARGIN - c.y) + Math.max(0, c.y - maxY) - (keep ? SIDE_SLACK : 0))
    const covers = keepOff ? overlap(box, keepOff) : 0
    const hit = Math.max(0, overlap(box, bell) - (keep ? area * 0.5 : 0))
    return (covers ? area * 2 + covers * 4 : 0) + hit + (shift.get(c) ?? 0) * Math.max(w, h) * 0.5 + (cut > 0 ? area * 8 + cut * Math.max(w, h) : 0)
  }
  const costs = raw.map(costOf)
  let best = 0
  for (let i = 1; i < raw.length; i++) if (costs[i] < costs[best]) best = i
  return raw[best]
}
