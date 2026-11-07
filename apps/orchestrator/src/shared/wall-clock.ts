const ring: number[] = []

export function wallClock(at = performance.now()): number {
  const p = performance.timeOrigin + at
  ring.push(Date.now() - (performance.timeOrigin + performance.now()))
  if (ring.length > 64) ring.shift()
  return p + Math.max(...ring)
}
