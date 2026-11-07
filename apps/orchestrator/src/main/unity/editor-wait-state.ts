import { closeSync, openSync, readSync, statSync } from 'node:fs'

export type EditorWaitPhase = 'none' | 'hub' | 'missing' | 'refused' | 'stopped' | 'launching' | 'up' | 'exited' | 'failed'

export interface EditorWaitState {
  state: EditorWaitPhase
  pid: number | null
  code: number | null
  signal: string | null
  booted: boolean
  error: string | null
  lifecycle: string | null
  progress: string
  logSize: number
  log: string[]
}

const TAIL_BYTES = 64 * 1024
const NOTEWORTHY = /\berror\b|exception|safe mode|crash|abort|fatal|no valid .*licen[cs]e/i
const STACK = /^\(Filename: |^[\w.`<>[\],+/]+:[\w.`<>|+/,]+ ?\(.*\)( \(at .*\))?$/

function tailLines(file: string): { size: number; lines: string[] } {
  let fd = -1
  try {
    const size = statSync(file).size
    const start = Math.max(0, size - TAIL_BYTES)
    const buf = Buffer.alloc(size - start)
    fd = openSync(file, 'r')
    readSync(fd, buf, 0, buf.length, start)
    const lines = buf.toString('utf8').split(/\r?\n/)
    if (start > 0) lines.shift()
    return { size, lines }
  } catch {
    return { size: 0, lines: [] }
  } finally {
    if (fd >= 0) closeSync(fd)
  }
}

export function logSizeOf(file: string): number {
  try {
    return statSync(file).size
  } catch {
    return 0
  }
}

export function relevantLogLines(file: string, count = 4): string[] {
  const lines = tailLines(file).lines.map((l) => l.trim()).filter((l) => l.length > 0 && !STACK.test(l))
  const tail = lines.slice(-(count - 1))
  const earlier = lines.slice(0, Math.max(0, lines.length - tail.length)).filter((l) => NOTEWORTHY.test(l) && !/warning/i.test(l))
  return [...earlier.slice(-1), ...tail].map((l) => (l.length > 300 ? `${l.slice(0, 300)}…` : l))
}
