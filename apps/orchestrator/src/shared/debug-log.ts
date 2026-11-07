type DebugGlobal = {
  process?: { env?: Record<string, string | undefined> }
  saturaDebug?: unknown
}

const g = globalThis as DebugGlobal

export const SATURA_DEBUG = g.process?.env?.SATURA_DEBUG === '1' || g.saturaDebug === true

export function debugLog(...args: unknown[]): void {
  if (SATURA_DEBUG) console.log(...args)
}
