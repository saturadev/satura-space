import { spawn } from 'node:child_process'
import { join } from 'node:path'
import type { SearchFileResult, SearchOptions } from '@shared/api'
import { resolveRgPath } from './rg-path'

const MAX_FILE_SIZE = '1M'
const DEFAULT_MAX_RESULTS = 20000
const LINE_CLAMP = 400
const FLUSH_MS = 60
const STDERR_CAP = 4096
const DEFAULT_EXCLUDE = ['Library', 'Temp', 'obj', 'Build', 'Logs', '.git', 'node_modules']

export interface SearchSummary {
  fileCount: number
  matchCount: number
  limitHit: boolean
  error?: string
}

export interface SearchHandle {
  cancel(): void
}

function splitGlobs(raw?: string): string[] {
  if (!raw) return []
  return raw
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
}

function expandGlob(p: string): string[] {
  if (p.includes('/') || p.includes('*') || p.includes('.')) return [p]
  return [`**/${p}/**`, `**/${p}`]
}

function buildArgs(opts: SearchOptions): string[] {
  const args: string[] = ['--json', '--max-filesize', MAX_FILE_SIZE]
  args.push(opts.caseSensitive ? '--case-sensitive' : '--ignore-case')
  if (!opts.regex) args.push('--fixed-strings')
  if (opts.wholeWord) args.push('--word-regexp')
  if (opts.regex && /\\n|\\r|[\n\r]/.test(opts.query)) args.push('--multiline')

  const ctx = opts.contextLines ?? 0
  if (ctx > 0) args.push('--context', String(ctx))

  if (opts.useGitignore === false) args.push('--no-ignore', '--hidden')

  for (const d of DEFAULT_EXCLUDE) args.push('-g', `!**/${d}/**`)
  args.push('-g', '!**/.sspace/worktrees/**')
  args.push('-g', '!**/.sspace/agent-worktrees/**')
  for (const g of splitGlobs(opts.includeGlobs)) for (const e of expandGlob(g)) args.push('-g', e)
  for (const g of splitGlobs(opts.excludeGlobs)) for (const e of expandGlob(g)) args.push('-g', `!${e}`)

  args.push('-e', opts.query, '--', '.')
  return args
}

function textOf(obj: { text?: string; bytes?: string } | undefined): string {
  if (!obj) return ''
  if (typeof obj.text === 'string') return obj.text
  if (typeof obj.bytes === 'string') return Buffer.from(obj.bytes, 'base64').toString('utf8')
  return ''
}

function byteToChar(text: string, byteOffset: number): number {
  if (byteOffset <= 0) return 0
  return Buffer.from(text, 'utf8').subarray(0, byteOffset).toString('utf8').length
}

function stripEol(s: string): string {
  return s.replace(/\r?\n$/, '')
}

function clamp(line: string, ms: number, me: number): { lineText: string; matchStart: number; matchEnd: number } {
  if (line.length <= LINE_CLAMP) return { lineText: line, matchStart: ms, matchEnd: me }
  const start = Math.max(0, ms - 100)
  return {
    lineText: line.slice(start, start + LINE_CLAMP),
    matchStart: ms - start,
    matchEnd: Math.min(me - start, LINE_CLAMP)
  }
}

export function runRipgrepSearch(
  opts: SearchOptions,
  onResult: (files: SearchFileResult[]) => void,
  onDone: (summary: SearchSummary) => void
): SearchHandle {
  const maxResults = opts.maxResults ?? DEFAULT_MAX_RESULTS
  let matchCount = 0
  let fileCount = 0
  let limitHit = false
  let stopped = false
  let userCancelled = false
  let stderr = ''

  if (!opts.query || !opts.rootPath) {
    queueMicrotask(() => onDone({ fileCount: 0, matchCount: 0, limitHit: false }))
    return { cancel() {} }
  }

  const child = spawn(resolveRgPath(), buildArgs(opts), { cwd: opts.rootPath })

  let buf = ''
  let current: SearchFileResult | null = null
  let pending: SearchFileResult[] = []
  let flushTimer: ReturnType<typeof setTimeout> | null = null

  const flush = (): void => {
    if (flushTimer) {
      clearTimeout(flushTimer)
      flushTimer = null
    }
    if (pending.length && !userCancelled) {
      const batch = pending
      pending = []
      onResult(batch)
    }
  }
  const scheduleFlush = (): void => {
    if (!flushTimer) flushTimer = setTimeout(flush, FLUSH_MS)
  }

  const finishFile = (): void => {
    if (current && current.matches.length > 0) {
      if (current.context && current.context.length === 0) current.context = undefined
      pending.push(current)
      fileCount++
      scheduleFlush()
    }
    current = null
  }

  const handleEvent = (evt: {
    type: string
    data?: {
      path?: { text?: string; bytes?: string }
      lines?: { text?: string; bytes?: string }
      line_number?: number
      submatches?: { start: number; end: number }[]
    }
  }): void => {
    switch (evt.type) {
      case 'begin': {
        const rel = textOf(evt.data?.path)
          .replace(/^\.[\\/]/, '')
          .replace(/\\/g, '/')
        current = { filePath: join(opts.rootPath, rel), relativePath: rel, matches: [], context: [] }
        break
      }
      case 'match': {
        if (!current) break
        const rawLine = textOf(evt.data?.lines)
        const lineText = stripEol(rawLine)
        const lineNo = evt.data?.line_number ?? 0
        for (const sm of evt.data?.submatches ?? []) {
          if (matchCount >= maxResults) {
            limitHit = true
            break
          }
          const cs = byteToChar(rawLine, sm.start)
          const ce = byteToChar(rawLine, sm.end)
          const c = clamp(lineText, cs, ce)
          current.matches.push({
            line: lineNo,
            column: cs + 1,
            lineText: c.lineText,
            matchStart: c.matchStart,
            matchEnd: c.matchEnd
          })
          matchCount++
        }
        break
      }
      case 'context': {
        if (!current) break
        current.context?.push({
          line: evt.data?.line_number ?? 0,
          text: stripEol(textOf(evt.data?.lines))
        })
        break
      }
      case 'end': {
        finishFile()
        break
      }
      default:
        break
    }
  }

  child.stdout.on('data', (d: Buffer) => {
    if (stopped) return
    buf += d.toString('utf8')
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      if (!line) continue
      let evt: ReturnType<typeof JSON.parse>
      try {
        evt = JSON.parse(line)
      } catch {
        continue
      }
      handleEvent(evt)
      if (limitHit) break
    }
    if (limitHit && !stopped) {
      stopped = true
      finishFile()
      flush()
      try {
        child.kill()
      } catch {
      }
    }
  })

  child.stderr.on('data', (d: Buffer) => {
    if (stderr.length < STDERR_CAP) stderr = (stderr + d.toString('utf8')).slice(0, STDERR_CAP)
  })

  child.on('error', (err) => {
    if (userCancelled) return
    stopped = true
    flush()
    onDone({ fileCount, matchCount, limitHit, error: err.message })
  })

  child.on('close', (code) => {
    if (flushTimer) {
      clearTimeout(flushTimer)
      flushTimer = null
    }
    if (userCancelled) return
    flush()
    const error = code === 2 && !limitHit ? stderr.trim() || 'ripgrep error' : undefined
    onDone({ fileCount, matchCount, limitHit, error })
  })

  return {
    cancel() {
      if (userCancelled) return
      userCancelled = true
      stopped = true
      if (flushTimer) {
        clearTimeout(flushTimer)
        flushTimer = null
      }
      try {
        child.kill()
      } catch {
      }
    }
  }
}
