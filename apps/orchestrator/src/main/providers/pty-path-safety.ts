import { posix, win32 } from 'node:path'

export function isRootLikePath(path: string | null | undefined): boolean {
  const trimmed = path?.trim() ?? ''
  if (!trimmed) {
    return true
  }
  const normalized = posix.normalize(trimmed)
  return posix.dirname(normalized) === normalized || win32.dirname(trimmed) === trimmed
}
