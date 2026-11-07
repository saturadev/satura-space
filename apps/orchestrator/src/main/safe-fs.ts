import { closeSync, fsyncSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeSync } from 'node:fs'
import { open, realpath, rename, rm, stat } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'

const CASE_INSENSITIVE = process.platform === 'darwin' || process.platform === 'win32'

function tmpBeside(target: string): string {
  return join(dirname(target), `.${basename(target)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`)
}

function realTargetSync(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

async function realTarget(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch {
    return path
  }
}

function modeOfSync(path: string): number | undefined {
  try {
    return statSync(path).mode & 0o7777
  } catch {
    return undefined
  }
}

async function modeOf(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).mode & 0o7777
  } catch {
    return undefined
  }
}

export function atomicWriteFileSync(path: string, data: string | Buffer, opts: { mode?: number } = {}): void {
  const target = realTargetSync(path)
  const mode = opts.mode ?? modeOfSync(target) ?? 0o666
  const tmp = tmpBeside(target)
  try {
    const fd = openSync(tmp, 'w', mode)
    try {
      const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data
      let off = 0
      while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(tmp, target)
  } catch (e) {
    rmSync(tmp, { force: true })
    throw e
  }
}

export async function atomicWriteFile(path: string, data: string | Buffer, opts: { mode?: number } = {}): Promise<void> {
  const target = await realTarget(path)
  const mode = opts.mode ?? (await modeOf(target)) ?? 0o666
  const tmp = tmpBeside(target)
  try {
    const fh = await open(tmp, 'w', mode)
    try {
      await fh.writeFile(data)
      await fh.sync()
    } finally {
      await fh.close()
    }
    await rename(tmp, target)
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => undefined)
    throw e
  }
}

export type JsonRead<T> =
  | { state: 'missing' }
  | { state: 'ok'; value: T; raw: string }
  | { state: 'invalid'; error: string }

function parseJsonText<T>(raw: string): JsonRead<T> {
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
  if (!text.trim()) return { state: 'ok', value: {} as T, raw }
  try {
    return { state: 'ok', value: JSON.parse(text) as T, raw }
  } catch (e) {
    return { state: 'invalid', error: (e as Error).message }
  }
}

export function readJsonForUpdateSync<T>(path: string): JsonRead<T> {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'missing' }
    return { state: 'invalid', error: (e as Error).message }
  }
  return parseJsonText<T>(raw)
}

function comparable(p: string): string {
  const r = realTargetSync(resolve(p))
  return CASE_INSENSITIVE ? r.toLowerCase() : r
}

export function isInside(root: string, candidate: string, opts: { allowRoot?: boolean } = {}): boolean {
  if (!root || !candidate) return false
  const rel = relative(comparable(root), comparable(candidate))
  if (rel === '') return opts.allowRoot === true
  return !rel.startsWith('..') && !isAbsolute(rel)
}

export async function trashPath(path: string): Promise<void> {
  const { shell } = await import('electron')
  await shell.trashItem(resolve(path))
}
