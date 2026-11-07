import { app, webContents, type WebContents } from 'electron'
import { closeSync, openSync, readSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { censusTrack } from '@shared/census'

const MAIN_LINES = 5000
const CONSOLE_LINES = 2000
const DEFAULT_TAIL = 200
const MAX_TAIL = 2000
const UNITY_TAIL_BYTES = 512 * 1024

const SECRETS: [RegExp, string][] = [
  [/\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g, '<redacted jwt>'],
  [/\b(token|secret|password|license|authorization|api[_-]?key)(["']?\s*[:=]\s*["']?)[^\s"',;]+/gi, '$1$2<redacted>'],
  [/\bBearer\s+[\w.~+/=-]+/gi, 'Bearer <redacted>']
]

export function redact(line: string): string {
  let out = line
  for (const [re, by] of SECRETS) out = out.replace(re, by)
  return out
}

class Ring {
  private _lines: string[] = []
  private _count = 0
  constructor(private _max: number) {}
  push(line: string): void {
    this._lines.push(line)
    this._count++
    if (this._lines.length > this._max) this._lines.splice(0, this._lines.length - this._max)
  }
  lines(): string[] {
    return this._lines
  }
  count(): number {
    return this._count
  }
  since(count: number): string[] {
    const fresh = Math.max(0, this._count - count)
    return fresh === 0 ? [] : this._lines.slice(Math.max(0, this._lines.length - fresh))
  }
}

const mainRing = new Ring(MAIN_LINES)
const consoleRings = new Map<number, Ring>()
censusTrack('logs.consoleRings', consoleRings)
let installed = false
let partial = ''

function captureStream(stream: NodeJS.WriteStream): void {
  const original = stream.write.bind(stream) as (...args: unknown[]) => boolean
  stream.write = ((chunk: unknown, ...rest: unknown[]): boolean => {
    try {
      const text = partial + (typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : '')
      const parts = text.split('\n')
      partial = parts.pop() ?? ''
      if (partial.length > 4000) partial = partial.slice(-4000)
      for (const line of parts) mainRing.push(line)
    } catch {
    }
    return original(chunk, ...rest)
  }) as typeof stream.write
}

function watchConsole(wc: WebContents): void {
  if (consoleRings.has(wc.id)) return
  const ring = new Ring(CONSOLE_LINES)
  consoleRings.set(wc.id, ring)
  const id = wc.id
  wc.on('console-message', (details) => {
    const where = details.sourceId ? ` (${details.sourceId.split('/').pop()}:${details.lineNumber})` : ''
    ring.push(`[${details.level}] ${details.message}${where}`)
  })
  wc.once('destroyed', () => consoleRings.delete(id))
}

export function installLogCapture(): void {
  if (installed) return
  installed = true
  captureStream(process.stdout)
  captureStream(process.stderr)
  for (const wc of webContents.getAllWebContents()) watchConsole(wc)
  app.on('web-contents-created', (_e, wc) => watchConsole(wc))
}

export interface LogQuery {
  tail?: number
  grep?: string | { source: string; flags?: string }
}

function matcher(grep: LogQuery['grep']): ((line: string) => boolean) | null {
  if (!grep) return null
  if (typeof grep === 'string') {
    try {
      const re = new RegExp(grep, 'i')
      return (line) => re.test(line)
    } catch {
      const want = grep.toLowerCase()
      return (line) => line.toLowerCase().includes(want)
    }
  }
  const re = new RegExp(grep.source, (grep.flags ?? '').replace(/[gy]/g, ''))
  return (line) => re.test(line)
}

export function selectLines(lines: string[], query: LogQuery): string {
  const tail = Math.min(MAX_TAIL, Math.max(1, Math.floor(Number(query.tail) || DEFAULT_TAIL)))
  const match = matcher(query.grep)
  const picked = match ? lines.filter(match) : lines
  return picked.slice(-tail).map(redact).join('\n')
}

export function mainLog(query: LogQuery): string {
  return selectLines(mainRing.lines(), query)
}

export function consoleLog(wcId: number, query: LogQuery): string {
  return selectLines(consoleRings.get(wcId)?.lines() ?? [], query)
}

export interface LogCursor {
  main: number
  console: number
  window: number | null
}

export function logCursor(window: number | null): LogCursor {
  return { main: mainRing.count(), console: window === null ? 0 : (consoleRings.get(window)?.count() ?? 0), window }
}

export function linesSince(cursor: LogCursor): { main: string[]; console: string[] } {
  const ring = cursor.window === null ? undefined : consoleRings.get(cursor.window)
  return { main: mainRing.since(cursor.main).map(redact), console: (ring?.since(cursor.console) ?? []).map(redact) }
}

export function readTail(file: string, bytes = UNITY_TAIL_BYTES): string[] {
  let fd = -1
  try {
    const size = statSync(file).size
    const start = Math.max(0, size - bytes)
    const buf = Buffer.alloc(size - start)
    fd = openSync(file, 'r')
    readSync(fd, buf, 0, buf.length, start)
    const lines = buf.toString('utf8').split(/\r?\n/)
    if (start > 0) lines.shift()
    return lines
  } catch {
    return []
  } finally {
    if (fd >= 0) closeSync(fd)
  }
}

export function unityEditorLogPath(projectPath: string): string {
  return join(projectPath, '.sspace', '.mcp_rawstream_editor.log')
}
