import { normalize } from 'node:path'

export function toNativePath(p: string): string {
  return process.platform === 'win32' ? normalize(p) : p
}
