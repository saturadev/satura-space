
import { useCallback, useSyncExternalStore } from 'react'
import { censusTrack } from '@shared/census'

export interface UnityMetrics {
  fps: number
  ping: number
}

const DEFAULT: UnityMetrics = { fps: 0, ping: -1 }

const metrics = new Map<string, UnityMetrics>()
censusTrack('unity-metrics.metrics', metrics)
const listeners = new Map<string, Set<() => void>>()
censusTrack('unity-metrics.listeners', listeners)

export function getMetrics(id: string): UnityMetrics {
  return metrics.get(id) ?? DEFAULT
}

export function setMetrics(id: string, patch: Partial<UnityMetrics>): void {
  const prev = metrics.get(id) ?? DEFAULT
  const next = { ...prev, ...patch }
  if (next.fps === prev.fps && next.ping === prev.ping) return
  metrics.set(id, next)
  listeners.get(id)?.forEach((fn) => fn())
}

export function clearMetrics(id: string): void {
  metrics.delete(id)
  perfHistories.delete(id)
  listeners.get(id)?.forEach((fn) => fn())
}

function subscribeMetrics(id: string, cb: () => void): () => void {
  let set = listeners.get(id)
  if (!set) {
    set = new Set()
    listeners.set(id, set)
  }
  set.add(cb)
  return () => {
    const cur = listeners.get(id)
    if (!cur) return
    cur.delete(cb)
    if (cur.size === 0) listeners.delete(id)
  }
}

export function useMetrics(id: string): UnityMetrics {
  const subscribe = useCallback((cb: () => void) => subscribeMetrics(id, cb), [id])
  const snapshot = useCallback(() => getMetrics(id), [id])
  return useSyncExternalStore(subscribe, snapshot)
}

export const FRAME_HISTORY = 4800
export const SAMPLE_HISTORY = 60

export interface PerfHistory {
  frameMs: Float32Array
  frameHead: number
  frameCount: number
  lastFrameAt: number
  fps: Float32Array
  ping: Float32Array
  sampleHead: number
  sampleCount: number
}

const perfHistories = new Map<string, PerfHistory>()
censusTrack('unity-metrics.perfHistories', perfHistories)

function ensurePerf(id: string): PerfHistory {
  let h = perfHistories.get(id)
  if (!h) {
    h = {
      frameMs: new Float32Array(FRAME_HISTORY),
      frameHead: 0,
      frameCount: 0,
      lastFrameAt: 0,
      fps: new Float32Array(SAMPLE_HISTORY),
      ping: new Float32Array(SAMPLE_HISTORY).fill(-1),
      sampleHead: 0,
      sampleCount: 0
    }
  }
  return h
}

export function getPerfHistory(id: string): PerfHistory | undefined {
  return perfHistories.get(id)
}

export function recordFrame(id: string, now: number, dt = 0): void {
  const h = ensurePerf(id)
  perfHistories.set(id, h)
  const measured = dt > 0 ? dt : h.lastFrameAt > 0 ? now - h.lastFrameAt : 0
  if (measured > 0 && measured < 5000) {
    h.frameMs[h.frameHead] = measured
    h.frameHead = (h.frameHead + 1) % FRAME_HISTORY
    if (h.frameCount < FRAME_HISTORY) h.frameCount++
    const predicted = h.lastFrameAt + measured
    const err = now - predicted
    h.lastFrameAt = h.lastFrameAt > 0 && Math.abs(err) < 50 ? predicted + err * 0.1 : now
  } else {
    h.lastFrameAt = now
  }
}

export function recordSample(id: string, fps: number, ping: number): void {
  const h = ensurePerf(id)
  perfHistories.set(id, h)
  h.fps[h.sampleHead] = fps
  h.ping[h.sampleHead] = ping
  h.sampleHead = (h.sampleHead + 1) % SAMPLE_HISTORY
  if (h.sampleCount < SAMPLE_HISTORY) h.sampleCount++
}

export function resetPerfHistory(id: string): void {
  perfHistories.delete(id)
}
