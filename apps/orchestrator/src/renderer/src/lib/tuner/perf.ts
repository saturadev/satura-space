import { censusTrack } from '@shared/census'

const renders = new Map<string, number>()
const live = new Map<string, number>()
censusTrack('perf.live', live)

export function noteRender(name: string): void {
  renders.set(name, (renders.get(name) ?? 0) + 1)
}

export function noteLive(kind: string, delta: number): void {
  const n = (live.get(kind) ?? 0) + delta
  if (n === 0) live.delete(kind)
  else live.set(kind, n)
}

export interface TunerPerfSnapshot {
  renders: Record<string, number>
  live: Record<string, number>
}

export function tunerPerfSnapshot(reset: boolean): TunerPerfSnapshot {
  const out = { renders: Object.fromEntries(renders), live: Object.fromEntries(live) }
  if (reset) renders.clear()
  return out
}
