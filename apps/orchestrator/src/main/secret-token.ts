import { randomBytes, timingSafeEqual } from 'node:crypto'
import { renameSync, rmSync, writeFileSync } from 'node:fs'

export function newSecretToken(): string {
  return randomBytes(32).toString('hex')
}

export function tokenMatches(expected: string, got: unknown): boolean {
  if (!expected || typeof got !== 'string') return false
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(got, 'utf8')
  return a.length === b.length && timingSafeEqual(a, b)
}

export function writePrivateFile(path: string, content: string): void {
  const tmp = `${path}.${process.pid}-${randomBytes(6).toString('hex')}.tmp`
  writeFileSync(tmp, content, { mode: 0o600 })
  try {
    renameSync(tmp, path)
  } catch {
    rmSync(tmp, { force: true })
    writeFileSync(path, content, { mode: 0o600 })
  }
}
