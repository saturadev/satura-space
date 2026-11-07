import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { isInside } from '../safe-fs'

const RECORD_DIR_MARKER = '.satura-media-record'

function realOrNearest(abs: string): string {
  const rest: string[] = []
  let cur = abs
  for (;;) {
    try {
      return join(realpathSync(cur), ...rest.reverse())
    } catch {
      const parent = dirname(cur)
      if (parent === cur) return abs
      rest.push(basename(cur))
      cur = parent
    }
  }
}

export function allowedOutPath(raw: string, roots: string[], param = 'out'): string {
  const abs = resolve(raw)
  const real = realOrNearest(abs)
  if (!roots.some((r) => r && isInside(r, real))) throw new Error(`${param} must be inside ${roots.filter(Boolean).join(' or ')}, got ${raw}`)
  return abs
}

export function prepareRecordDir(dir: string): void {
  if (existsSync(dir)) {
    if (!statSync(dir).isDirectory()) throw new Error(`${dir} exists and is not a folder.`)
    if (existsSync(join(dir, RECORD_DIR_MARKER))) rmSync(dir, { recursive: true, force: true })
    else if (readdirSync(dir).length) throw new Error(`${dir} already has files that media.record did not write. Pick another out.`)
  }
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, RECORD_DIR_MARKER), '')
}
