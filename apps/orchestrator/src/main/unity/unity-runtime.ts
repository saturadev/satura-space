import { readdirSync, readFileSync, rmSync, statSync, unlinkSync } from 'node:fs'
import { copyFile, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const RUNTIME_DIR = 'runtime'
export const RUNTIME_READY_MARKER = 'runtime-ready.json'
const WIN_RUNTIME_FILES: readonly (readonly string[])[] = [
  ['winhook', 'unityhook.dll'],
  ['mcp', 'satura-space-mcp.exe']
]

export interface FileStamp {
  size: number
  mtimeMs: number
}

export type RuntimeMarker = Record<string, FileStamp>

export function runtimeRootFor(userData: string): string {
  return join(userData, RUNTIME_DIR)
}

export function runtimeDirFor(userData: string, version: string): string {
  return join(runtimeRootFor(userData), version)
}

export function fileKey(segments: readonly string[]): string {
  return segments.join('/')
}

export function runtimePathFor(
  readyDir: string | null,
  bundled: (...segments: string[]) => string,
  segments: readonly string[]
): string {
  return readyDir ? join(readyDir, ...segments) : bundled(...segments)
}

function markerMatches(marker: unknown, sources: RuntimeMarker): boolean {
  if (!marker || typeof marker !== 'object' || Array.isArray(marker)) return false
  const m = marker as Record<string, unknown>
  const keys = Object.keys(sources)
  if (!keys.length) return false
  return keys.every((k) => {
    const want = sources[k]
    const have = m[k] as Partial<FileStamp> | undefined
    return !!have && have.size === want.size && have.mtimeMs === want.mtimeMs
  })
}

function staleRuntimeVersions(entries: string[], current: string): string[] {
  return entries.filter((e) => e !== current && !e.startsWith('.'))
}

function stampOf(path: string): FileStamp {
  const st = statSync(path)
  return { size: st.size, mtimeMs: st.mtimeMs }
}

export function sourceStamps(bundled: (...segments: string[]) => string, files = WIN_RUNTIME_FILES): RuntimeMarker {
  const out: RuntimeMarker = {}
  for (const f of files) out[fileKey(f)] = stampOf(bundled(...f))
  return out
}

export function runtimeReady(dir: string, sources: RuntimeMarker, files = WIN_RUNTIME_FILES): boolean {
  try {
    const marker: unknown = JSON.parse(readFileSync(join(dir, RUNTIME_READY_MARKER), 'utf8'))
    if (!markerMatches(marker, sources)) return false
    return files.every((f) => {
      const st = statSync(join(dir, ...f))
      return st.size === sources[fileKey(f)].size
    })
  } catch {
    return false
  }
}

export async function materializeRuntime(
  dir: string,
  bundled: (...segments: string[]) => string,
  files = WIN_RUNTIME_FILES
): Promise<void> {
  const sources = sourceStamps(bundled, files)
  if (runtimeReady(dir, sources, files)) return
  await rm(join(dir, RUNTIME_READY_MARKER), { force: true })
  for (const f of files) {
    const dst = join(dir, ...f)
    await mkdir(join(dst, '..'), { recursive: true })
    const partial = `${dst}.partial`
    await copyFile(bundled(...f), partial)
    await rename(partial, dst)
  }
  await writeFile(join(dir, RUNTIME_READY_MARKER), JSON.stringify(sources))
}

export function pruneRuntimes(root: string, current: string, files = WIN_RUNTIME_FILES): string[] {
  let entries: string[]
  try {
    entries = readdirSync(root)
  } catch {
    return []
  }
  const removed: string[] = []
  for (const entry of staleRuntimeVersions(entries, current)) {
    const dir = join(root, entry)
    let inUse = false
    for (const f of files) {
      try {
        unlinkSync(join(dir, ...f))
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') inUse = true
      }
    }
    if (inUse) continue
    try {
      rmSync(dir, { recursive: true, force: true })
      removed.push(entry)
    } catch {
    }
  }
  return removed
}
