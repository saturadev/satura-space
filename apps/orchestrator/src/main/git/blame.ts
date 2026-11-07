import { isAbsolute, relative } from 'node:path'
import type { BlameRange } from '@shared/api'
import { execGit } from './exec-git'
import { censusTrack } from '@shared/census'

const ZERO_HASH = /^0{40}$/
const HEADER_RE = /^([0-9a-f]{40}) (\d+) (\d+) (\d+)$/

const MAX_CACHE = 100
const blameCache = new Map<string, BlameRange[]>()
censusTrack('blame.blameCache', blameCache)

function lruGet<V>(cache: Map<string, V>, key: string): V | undefined {
  const v = cache.get(key)
  if (v !== undefined) {
    cache.delete(key)
    cache.set(key, v)
  }
  return v
}

function lruSet<V>(cache: Map<string, V>, key: string, val: V): void {
  cache.set(key, val)
  if (cache.size > MAX_CACHE) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
}

export async function isTracked(rootPath: string, filePath: string): Promise<boolean> {
  if (!rootPath || !filePath) return false
  const rel = isAbsolute(filePath) ? relative(rootPath, filePath) : filePath
  if (!rel || rel.startsWith('..')) return false
  try {
    await execGit(['ls-files', '--error-unmatch', '--', rel], {
      cwd: rootPath,
      timeout: 4000
    })
    return true
  } catch {
    return false
  }
}

async function currentHead(rootPath: string): Promise<string> {
  try {
    const { stdout } = await execGit(['rev-parse', 'HEAD'], {
      cwd: rootPath,
      timeout: 4000
    })
    return stdout.trim()
  } catch {
    return ''
  }
}

function parseIncrementalBlame(data: string): BlameRange[] {
  const commits = new Map<string, { author: string; email?: string; dateMs: number; summary: string }>()
  const ranges: BlameRange[] = []

  let hash = ''
  let finalStart = 0
  let numLines = 0
  let author = ''
  let email: string | undefined
  let dateMs = 0
  let summary = ''

  for (const line of data.split('\n')) {
    const header = HEADER_RE.exec(line)
    if (header) {
      hash = header[1]
      finalStart = Number(header[3])
      numLines = Number(header[4])
      const known = commits.get(hash)
      author = known?.author ?? ''
      email = known?.email
      dateMs = known?.dateMs ?? 0
      summary = known?.summary ?? ''
      continue
    }
    if (line.startsWith('author ')) author = line.slice(7)
    else if (line.startsWith('author-mail ')) email = line.slice(12).replace(/^<|>$/g, '') || undefined
    else if (line.startsWith('author-time ')) dateMs = Number(line.slice(12)) * 1000
    else if (line.startsWith('summary ')) summary = line.slice(8)
    else if (line.startsWith('filename ')) {
      commits.set(hash, { author, email, dateMs, summary })
      ranges.push({
        hash,
        startLine: finalStart,
        endLine: finalStart + numLines - 1,
        author,
        email,
        dateMs,
        summary,
        uncommitted: ZERO_HASH.test(hash)
      })
    }
  }

  ranges.sort((a, b) => a.startLine - b.startLine)
  return ranges
}

export async function runBlame(rootPath: string, filePath: string, ref?: string): Promise<BlameRange[]> {
  if (!rootPath || !filePath) return []
  const rel = isAbsolute(filePath) ? relative(rootPath, filePath) : filePath

  if (!(await isTracked(rootPath, filePath))) return []

  const head = await currentHead(rootPath)
  const key = `${rootPath}\0${rel}\0${head}\0${ref ?? ''}`
  const cached = lruGet(blameCache, key)
  if (cached) return cached

  const args = ['blame', '--incremental', '--root']
  if (ref) args.push(ref)
  args.push('--', rel)

  let stdout: string
  try {
    ;({ stdout } = await execGit(args, {
      cwd: rootPath,
      maxBuffer: 64 * 1024 * 1024,
      timeout: 15000
    }))
  } catch (err) {
    const e = err as { stderr?: string; killed?: boolean; message?: string }
    throw new Error(e.killed ? 'git blame timed out' : (e.stderr || e.message || 'git blame failed').trim().split('\n')[0])
  }

  const ranges = parseIncrementalBlame(stdout)
  lruSet(blameCache, key, ranges)
  return ranges
}
