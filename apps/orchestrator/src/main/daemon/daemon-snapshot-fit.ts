import { NDJSON_MAX_LINE_BYTES } from './ndjson'
import type { TerminalSnapshot } from './types'

export const SNAPSHOT_LINE_OVERHEAD_BYTES = 64 * 1024
const TRIM_RESET = '\x1b[0m'

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

export type FittedSnapshot = {
  snapshot: TerminalSnapshot
  trimmed: boolean
  originalBytes: number
  bytes: number
}

export function fitSnapshotToLine(
  snapshot: TerminalSnapshot,
  maxLineBytes = NDJSON_MAX_LINE_BYTES
): FittedSnapshot {
  const budget = Math.max(1024, maxLineBytes - SNAPSHOT_LINE_OVERHEAD_BYTES)
  const originalBytes = jsonBytes(snapshot)
  if (originalBytes <= budget) {
    return { snapshot, trimmed: false, originalBytes, bytes: originalBytes }
  }

  const base: TerminalSnapshot = { ...snapshot, snapshotAnsi: '', scrollbackAnsi: '', oscLinks: undefined }
  const ansiBudget = budget - jsonBytes(base) - jsonBytes(TRIM_RESET)
  const ansi = snapshot.snapshotAnsi
  let low = 0
  let high = ansi.length
  while (low < high) {
    const mid = Math.floor((low + high) / 2)
    if (jsonBytes(ansi.slice(mid)) <= ansiBudget) high = mid
    else low = mid + 1
  }
  let start = low
  if (start > 0 && start < ansi.length) {
    const newline = ansi.indexOf('\n', start)
    start = newline === -1 ? ansi.length : newline + 1
  }
  const kept = start >= ansi.length ? '' : ansi.slice(start)
  const fitted: TerminalSnapshot = { ...base, snapshotAnsi: kept ? TRIM_RESET + kept : '' }
  return { snapshot: fitted, trimmed: true, originalBytes, bytes: jsonBytes(fitted) }
}
