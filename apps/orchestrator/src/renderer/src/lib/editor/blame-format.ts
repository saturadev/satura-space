import type { BlameRange } from '@shared/api'
import { relativeTimeShort } from '../relative-time'

const AUTHOR_W = 14
const DATE_W = 4
const SHA_W = 7
const TOTAL_W = AUTHOR_W + 1 + DATE_W + 1 + SHA_W
const BLANK = ' '.repeat(TOTAL_W)

export function formatBlameColumn(range: BlameRange, continuation = false): string {
  if (continuation) return BLANK
  if (range.uncommitted) {
    return `${pad('You', AUTHOR_W)} ${pad('now', DATE_W)} ${pad('—', SHA_W)}`
  }
  const author = pad(range.author || 'Unknown', AUTHOR_W)
  const date = pad(relativeTimeShort(range.dateMs), DATE_W)
  return `${author} ${date} ${range.hash.slice(0, SHA_W)}`
}

export function formatBlameCompact(range: BlameRange): string {
  if (range.uncommitted) return 'new'
  return `${blameInitials(range.author)} ${relativeTimeShort(range.dateMs)}`
}

function blameInitials(author: string): string {
  const words = (author || '?').trim().split(/[\s._-]+/).filter(Boolean)
  const letters = words.length > 1 ? words[0][0] + words[words.length - 1][0] : (words[0] ?? '?').slice(0, 2)
  return letters.toUpperCase().padEnd(2)
}

function pad(s: string, width: number): string {
  return s.length > width ? s.slice(0, width) : s.padEnd(width)
}

export const BLAME_AGE_BUCKETS = 8

export function blameAgeBucket(dateMs: number, oldestMs: number, newestMs: number): number {
  const span = newestMs - oldestMs
  if (!(span > 0)) return 0
  const aged = 1 - (dateMs - oldestMs) / span
  return Math.min(BLAME_AGE_BUCKETS - 1, Math.max(0, Math.round(aged * (BLAME_AGE_BUCKETS - 1))))
}
