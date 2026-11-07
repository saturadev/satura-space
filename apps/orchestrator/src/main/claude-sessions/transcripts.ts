import { open, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { isResumableSessionId } from '@shared/agent-catalog'
import {
  claudeProjectSlug,
  claudeProjectSlugPrefix,
  type ClaudeSessionSummary
} from '@shared/claude-sessions'
import { censusTrack } from '@shared/census'

const HEAD_BYTES = 64 * 1024
const TAIL_BYTES = 64 * 1024
const TITLE_MAX = 80
const SCAN_LIMIT = 40
const DEFAULT_LIMIT = 12
const CACHE_MAX = 400

export interface TranscriptInfo {
  title: string
  interactive: boolean
  hasConversation: boolean
}

interface CachedInfo {
  mtimeMs: number
  size: number
  info: TranscriptInfo
}

const cache = new Map<string, CachedInfo>()
censusTrack('transcripts.cache', cache)

export function claudeConfigDir(override?: string | null): string {
  const raw = override?.trim() || process.env.CLAUDE_CONFIG_DIR?.trim() || ''
  if (!raw) return join(homedir(), '.claude')
  if (raw === '~') return homedir()
  if (raw.startsWith('~/')) return join(homedir(), raw.slice(2))
  return raw
}

export function claudeProjectsDir(configDir?: string | null): string {
  return join(claudeConfigDir(configDir), 'projects')
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

export async function resolveClaudeProjectDir(
  projectPath: string,
  configDir?: string | null
): Promise<string | null> {
  if (!projectPath) return null
  const root = claudeProjectsDir(configDir)
  const exact = join(root, claudeProjectSlug(projectPath))
  if (await isDirectory(exact)) return exact
  const prefix = claudeProjectSlugPrefix(projectPath)
  if (!prefix) return null
  try {
    const hit = (await readdir(root)).find((name) => name.startsWith(prefix))
    return hit ? join(root, hit) : null
  } catch {
    return null
  }
}

function textOfContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const part of content) {
    if (part && typeof part === 'object' && (part as { type?: unknown }).type === 'text') {
      const text = (part as { text?: unknown }).text
      if (typeof text === 'string') parts.push(text)
    }
  }
  return parts.join(' ')
}

function isMarkupPrompt(text: string): boolean {
  return /^<[a-zA-Z][\w-]*[\s>/]/.test(text)
}

export function cleanTitle(raw: string): string {
  const flat = raw.replace(/\s+/g, ' ').trim()
  if (flat.length <= TITLE_MAX) return flat
  const cut = flat.slice(0, TITLE_MAX - 1)
  const space = cut.lastIndexOf(' ')
  const atBoundary = /[\s,.;:!?]/.test(flat.charAt(TITLE_MAX - 1))
  const words = !atBoundary && space > TITLE_MAX / 2 ? cut.slice(0, space) : cut
  return `${words.replace(/[\s,.;:!?-]+$/, '')}…`
}

function parseLines(text: string, dropFirst: boolean, dropLast: boolean): Record<string, unknown>[] {
  const lines = text.split('\n')
  if (dropFirst) lines.shift()
  if (dropLast) lines.pop()
  const out: Record<string, unknown>[] = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        out.push(parsed as Record<string, unknown>)
      }
    } catch {
    }
  }
  return out
}

function str(record: Record<string, unknown>, key: string): string {
  const v = record[key]
  return typeof v === 'string' ? v : ''
}

export function parseTranscript(chunks: {
  head: string
  headTruncated: boolean
  tail?: string | null
}): TranscriptInfo {
  const head = parseLines(chunks.head, false, chunks.headTruncated)
  const tail = chunks.tail ? parseLines(chunks.tail, true, false) : []
  let firstPrompt = ''
  let entrypoint = ''
  let customTitle = ''
  let aiTitle = ''
  let summary = ''
  let lastPrompt = ''
  for (const rec of [...head, ...tail]) {
    const type = str(rec, 'type')
    if (type === 'custom-title' && str(rec, 'customTitle').trim()) customTitle = str(rec, 'customTitle')
    else if (type === 'ai-title' && str(rec, 'aiTitle').trim()) aiTitle = str(rec, 'aiTitle')
    else if (type === 'summary' && str(rec, 'summary').trim()) summary = str(rec, 'summary')
    else if (type === 'last-prompt' && str(rec, 'lastPrompt').trim()) lastPrompt = str(rec, 'lastPrompt')
  }
  for (const rec of head) {
    if (str(rec, 'type') !== 'user') continue
    if (!entrypoint && str(rec, 'entrypoint')) entrypoint = str(rec, 'entrypoint')
    if (firstPrompt || rec.isMeta === true || rec.isSidechain === true) continue
    const message = rec.message as { content?: unknown } | undefined
    const text = textOfContent(message?.content).trim()
    if (text && !isMarkupPrompt(text)) firstPrompt = text
  }
  const usableLastPrompt = lastPrompt.trim().startsWith('/') ? '' : lastPrompt
  const title = customTitle || aiTitle || summary || firstPrompt || usableLastPrompt
  return {
    title: cleanTitle(title),
    interactive: !entrypoint.startsWith('sdk'),
    hasConversation: Boolean(customTitle || aiTitle || summary || firstPrompt)
  }
}

async function readChunks(
  file: string,
  size: number
): Promise<{ head: string; headTruncated: boolean; tail: string | null }> {
  const handle = await open(file, 'r')
  try {
    const headLen = Math.min(size, HEAD_BYTES)
    const headBuf = Buffer.alloc(headLen)
    await handle.read(headBuf, 0, headLen, 0)
    if (size <= HEAD_BYTES) return { head: headBuf.toString('utf8'), headTruncated: false, tail: null }
    const tailStart = Math.max(headLen, size - TAIL_BYTES)
    const tailLen = size - tailStart
    const tailBuf = Buffer.alloc(tailLen)
    await handle.read(tailBuf, 0, tailLen, tailStart)
    return { head: headBuf.toString('utf8'), headTruncated: true, tail: tailBuf.toString('utf8') }
  } finally {
    await handle.close()
  }
}

export async function readTranscriptInfo(
  file: string,
  known?: { mtimeMs: number; size: number }
): Promise<{ info: TranscriptInfo; mtimeMs: number } | null> {
  let meta = known
  if (!meta) {
    try {
      const st = await stat(file)
      if (!st.isFile()) return null
      meta = { mtimeMs: st.mtimeMs, size: st.size }
    } catch {
      return null
    }
  }
  const hit = cache.get(file)
  if (hit && hit.mtimeMs === meta.mtimeMs && hit.size === meta.size) {
    return { info: hit.info, mtimeMs: meta.mtimeMs }
  }
  let info: TranscriptInfo
  try {
    info = parseTranscript(await readChunks(file, meta.size))
  } catch {
    return null
  }
  cache.delete(file)
  cache.set(file, { mtimeMs: meta.mtimeMs, size: meta.size, info })
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
  return { info, mtimeMs: meta.mtimeMs }
}

function fallbackTitle(sessionId: string): string {
  return `Session ${sessionId.slice(0, 8)}`
}

export async function describeClaudeSession(
  projectPath: string,
  sessionId: string,
  configDir?: string | null
): Promise<ClaudeSessionSummary | null> {
  if (!isResumableSessionId(sessionId)) return null
  const dir = await resolveClaudeProjectDir(projectPath, configDir)
  if (!dir) return null
  const read = await readTranscriptInfo(join(dir, `${sessionId}.jsonl`))
  if (!read || !read.info.hasConversation) return null
  return {
    id: sessionId,
    title: read.info.title || fallbackTitle(sessionId),
    updatedAt: read.mtimeMs,
    projectPath
  }
}

export async function listClaudeSessions(
  projectPath: string,
  opts: { limit?: number; exclude?: readonly string[]; configDir?: string | null } = {}
): Promise<ClaudeSessionSummary[]> {
  const dir = await resolveClaudeProjectDir(projectPath, opts.configDir)
  if (!dir) return []
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  const exclude = new Set(opts.exclude ?? [])
  const limit = Math.max(1, Math.min(opts.limit ?? DEFAULT_LIMIT, SCAN_LIMIT))
  const files: { id: string; file: string; mtimeMs: number; size: number }[] = []
  await Promise.all(
    names.map(async (name) => {
      if (!name.endsWith('.jsonl')) return
      const id = name.slice(0, -'.jsonl'.length)
      if (!isResumableSessionId(id) || exclude.has(id)) return
      const file = join(dir, name)
      try {
        const st = await stat(file)
        if (st.isFile() && st.size > 0) files.push({ id, file, mtimeMs: st.mtimeMs, size: st.size })
      } catch {
      }
    })
  )
  files.sort((a, b) => b.mtimeMs - a.mtimeMs)
  const out: ClaudeSessionSummary[] = []
  for (const f of files.slice(0, SCAN_LIMIT)) {
    const read = await readTranscriptInfo(f.file, { mtimeMs: f.mtimeMs, size: f.size })
    if (!read || !read.info.interactive || !read.info.hasConversation) continue
    out.push({
      id: f.id,
      title: read.info.title || fallbackTitle(f.id),
      updatedAt: f.mtimeMs,
      projectPath
    })
    if (out.length >= limit) break
  }
  return out
}
