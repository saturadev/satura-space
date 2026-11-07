import { promises as fsp } from 'node:fs'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import type { CodeFileResult, CodeRefResolution } from '@shared/report-code'
import { CODE_EXTENSIONS } from '@shared/report-code'

const MAX_BYTES = 2 * 1024 * 1024
const MAX_FILES = 150_000
const INDEX_TTL_MS = 60_000
const SKIP_DIRS = new Set(['node_modules', 'Library', 'Temp', 'Logs', 'obj', 'Build', 'Builds'])

interface Index {
  at: number
  byName: Map<string, string[]>
  all: string[]
}

const indexes = new Map<string, Promise<Index>>()
const indexTimes = new Map<string, number>()

export function projectRootOf(reportFile: string, fallback?: string): string {
  const p = reportFile.replace(/\\/g, '/')
  const i = p.indexOf('/.sspace/')
  if (i > 0) return p.slice(0, i)
  return fallback && isAbsolute(fallback) ? fallback.replace(/\\/g, '/') : dirname(p)
}

function isCodeFile(name: string): boolean {
  const dot = name.lastIndexOf('.')
  return dot > 0 && CODE_EXTENSIONS.has(name.slice(dot + 1).toLowerCase())
}

async function walk(root: string, start: string, out: string[]): Promise<void> {
  const stack = [start]
  while (stack.length && out.length < MAX_FILES) {
    const dir = stack.pop() as string
    let entries
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) stack.push(full)
      } else if (e.isFile() && isCodeFile(e.name)) {
        out.push(relative(root, full).replace(/\\/g, '/'))
        if (out.length >= MAX_FILES) break
      }
    }
  }
}

function buildIndex(root: string): Promise<Index> {
  const at = indexTimes.get(root) ?? 0
  const cached = indexes.get(root)
  if (cached && Date.now() - at < INDEX_TTL_MS) return cached
  const job = (async (): Promise<Index> => {
    const all: string[] = []
    for (const top of ['Assets', 'Packages']) await walk(root, join(root, top), all)
    all.sort()
    const byName = new Map<string, string[]>()
    for (const rel of all) {
      const name = rel.slice(rel.lastIndexOf('/') + 1).toLowerCase()
      const list = byName.get(name)
      if (list) list.push(rel)
      else byName.set(name, [rel])
    }
    return { at: Date.now(), byName, all }
  })()
  indexes.set(root, job)
  indexTimes.set(root, Date.now())
  return job
}

async function realInside(root: string, file: string): Promise<string | null> {
  try {
    const [realRoot, real] = await Promise.all([fsp.realpath(root), fsp.realpath(file)])
    const rel = relative(realRoot, real)
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null
    const st = await fsp.stat(real)
    return st.isFile() ? real : null
  } catch {
    return null
  }
}

async function resolveOne(root: string, ref: string): Promise<CodeRefResolution> {
  const clean = ref.replace(/\\/g, '/').replace(/^\.\//, '').trim()
  if (!clean || clean.includes('\0')) return { ref, status: 'missing' }
  if (isAbsolute(clean)) {
    const real = await realInside(root, clean)
    return real ? { ref, status: 'ok', rel: relative(root, clean).replace(/\\/g, '/') } : { ref, status: 'missing' }
  }
  if (clean.split('/').includes('..')) return { ref, status: 'missing' }
  if (clean.includes('/')) {
    for (const rel of [clean, `Assets/${clean}`, `Packages/${clean}`]) {
      if (await realInside(root, join(root, rel))) return { ref, status: 'ok', rel }
    }
  }
  const index = await buildIndex(root)
  const name = clean.slice(clean.lastIndexOf('/') + 1).toLowerCase()
  const tail = `/${clean.toLowerCase()}`
  const found = (index.byName.get(name) ?? []).filter((rel) => !clean.includes('/') || `/${rel.toLowerCase()}`.endsWith(tail))
  if (found.length === 1) return { ref, status: 'ok', rel: found[0] }
  if (found.length > 1) return { ref, status: 'ambiguous', candidates: found.slice(0, 30) }
  return { ref, status: 'missing' }
}

export async function resolveCodeRefs(
  reportFile: string,
  fallbackRoot: string | undefined,
  refs: string[]
): Promise<Record<string, CodeRefResolution>> {
  const root = projectRootOf(reportFile, fallbackRoot)
  const out: Record<string, CodeRefResolution> = {}
  const unique = [...new Set(refs.filter((r) => typeof r === 'string'))].slice(0, 500)
  for (const ref of unique) out[ref] = await resolveOne(root, ref)
  return out
}

export async function readCodeFile(reportFile: string, fallbackRoot: string | undefined, rel: string): Promise<CodeFileResult> {
  const root = projectRootOf(reportFile, fallbackRoot)
  const res = await resolveOne(root, String(rel ?? ''))
  if (res.status !== 'ok' || !res.rel) return { ok: false, error: res.status === 'ambiguous' ? 'ambiguous' : 'missing', candidates: res.candidates }
  const real = await realInside(root, join(root, res.rel))
  if (!real) return { ok: false, error: 'missing' }
  const st = await fsp.stat(real)
  if (st.size > MAX_BYTES) return { ok: false, error: 'too-large', rel: res.rel }
  const text = await fsp.readFile(real, 'utf8')
  return { ok: true, rel: res.rel, path: real.split(sep).join('/'), text }
}
