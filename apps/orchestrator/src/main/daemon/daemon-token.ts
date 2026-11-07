import { createHash, timingSafeEqual } from 'node:crypto'

function tokenDigest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest()
}

export function tokenMatches(given: unknown, expected: string): boolean {
  if (typeof given !== 'string' || !expected) return false
  return timingSafeEqual(tokenDigest(given), tokenDigest(expected))
}
