import type { Terminal } from '@xterm/xterm'

const IMAGE_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.svg',
  '.webp',
  '.bmp',
  '.ico'
])

const RAW_PASTE_UNSAFE = /["'`$;&|<>(){}[\]*?!#^%]/

export function isImagePath(path: string): boolean {
  const lastDot = path.lastIndexOf('.')
  if (lastDot === -1) return false
  const lastSeparator = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  if (lastDot < lastSeparator) return false
  return IMAGE_EXTENSIONS.has(path.slice(lastDot).toLowerCase())
}

function hasControlChars(path: string): boolean {
  for (let i = 0; i < path.length; i++) {
    const code = path.charCodeAt(i)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

function canPasteRaw(path: string): boolean {
  return !hasControlChars(path) && !RAW_PASTE_UNSAFE.test(path)
}

function escapePath(path: string): string {
  return /[ "']/.test(path) ? `"${path.replace(/"/g, '""')}"` : path
}

export function pasteFilePaths(term: Terminal, paths: string[]): void {
  const usable = paths.filter((p) => p && !hasControlChars(p))
  for (let i = 0; i < usable.length; i++) {
    const path = usable[i]
    if (isImagePath(path) && canPasteRaw(path)) {
      term.paste(path)
      const next = usable[i + 1]
      if (next && !(isImagePath(next) && canPasteRaw(next))) term.input(' ')
    } else {
      term.input(escapePath(path) + ' ')
    }
  }
}
