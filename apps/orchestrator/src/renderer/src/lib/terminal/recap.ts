import { useEffect, useState } from 'react'
import type { IDisposable, Terminal } from '@xterm/xterm'
import { getTerminalInstance } from './terminal-registry'

export interface RecapRow {
  text: string
  wrapped: boolean
}

const RECAP_RE = /^(\s*)※\s+recap:\s?(.*)$/
const TRAILER_RE = /\s*\(disable recaps in \/config\)\s*$/
const STOP_RE = /^[※⏺●>╭╰│─✻✳⎿]/
const SCAN_ROWS = 3000
const POLL_MS = 1000

function logicalLines(rows: RecapRow[]): string[] {
  const out: string[] = []
  for (const row of rows) {
    if (row.wrapped && out.length > 0) out[out.length - 1] += row.text
    else out.push(row.text)
  }
  return out.map((l) => l.trimEnd())
}

export function parseRecaps(rows: RecapRow[]): string[] {
  const lines = logicalLines(rows)
  const recaps: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const m = RECAP_RE.exec(lines[i])
    if (!m) continue
    const minIndent = m[1].length + 2
    const parts = [m[2].trim()]
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j]
      const text = line.trim()
      if (!text) break
      if (line.length - line.trimStart().length < minIndent) break
      if (STOP_RE.test(text)) break
      parts.push(text)
      i = j
    }
    const recap = parts.filter(Boolean).join(' ').replace(TRAILER_RE, '').trim()
    if (recap) recaps.push(recap)
  }
  return recaps
}

export function readTerminalRecaps(term: Terminal): string[] {
  const buf = term.buffer.normal
  const rows: RecapRow[] = []
  for (let i = Math.max(0, buf.length - SCAN_ROWS); i < buf.length; i++) {
    const line = buf.getLine(i)
    if (!line) continue
    rows.push({ text: line.translateToString(false), wrapped: line.isWrapped })
  }
  return parseRecaps(rows)
}

export function useTerminalRecaps(ptyId: string, enabled: boolean): string[] {
  const [recaps, setRecaps] = useState<string[]>([])

  useEffect(() => {
    if (!enabled) {
      setRecaps([])
      return
    }
    let attached: Terminal | undefined
    let sub: IDisposable | null = null
    let dirty = true
    let lastKey = ''

    const tick = (): void => {
      const term = getTerminalInstance(ptyId)
      if (term !== attached) {
        sub?.dispose()
        sub = term ? term.onWriteParsed(() => (dirty = true)) : null
        attached = term
        dirty = true
      }
      if (!dirty || !term) return
      dirty = false
      const next = readTerminalRecaps(term)
      const key = next.join('\u0000')
      if (key === lastKey) return
      lastKey = key
      setRecaps(next)
    }

    tick()
    const timer = window.setInterval(tick, POLL_MS)
    return () => {
      window.clearInterval(timer)
      sub?.dispose()
    }
  }, [ptyId, enabled])

  return recaps
}
