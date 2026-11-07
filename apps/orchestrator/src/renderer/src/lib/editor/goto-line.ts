import { toPosixPath } from '../path'
import { censusTrack } from '@shared/census'

export interface Goto {
  line: number
  col: number
  nonce: number
}

const pending = new Map<string, Goto>()
censusTrack('goto-line.pending', pending)
const listeners = new Set<() => void>()
censusTrack('goto-line.listeners', listeners)
let nonce = 0

export function requestGoto(path: string, line: number, col = 1): void {
  pending.set(toPosixPath(path), { line, col, nonce: ++nonce })
  listeners.forEach((fn) => fn())
}

export function consumeGoto(path: string): Goto | null {
  const key = toPosixPath(path)
  const g = pending.get(key)
  if (g) pending.delete(key)
  return g ?? null
}

export function subscribeGoto(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}
