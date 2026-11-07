import type { TunerFrameEvent } from '@shared/tuner'
import { parseTunerFrame, tunerSurfaceKey } from '@shared/tuner-frame'
import { presentSurface, releaseHeld, resendSurface, type SurfaceInfo } from './shared-surface'
import { censusTrack } from '@shared/census'
import { wallClock } from '@shared/wall-clock'
import { remoteVideo } from '../remote-video'
import { debugLog } from '@shared/debug-log'

export interface TunerFrameTarget {
  key: string
  projectPath: string
  session: string
  wcId: number
  pid: number | undefined
  send: (channel: string, payload: unknown) => void
  onMiss?: (misses: number, reason: string) => void
  onShown?: () => void
}

interface SurfaceState {
  failed: boolean
  surfaceKey: string | null
  last: { info: SurfaceInfo; payload: TunerFrameEvent } | null
  frames: number
  misses: number
  missReason: string
}

const states = new Map<string, SurfaceState>()
censusTrack('tuner-surface.states', states)
const targets = new Map<string, TunerFrameTarget>()
censusTrack('tuner-surface.targets', targets)

remoteVideo.setSourceWanted((source) => {
  const t = targets.get(source)
  if (t) tunerSurfaceResync(t)
})

function stateOf(key: string): SurfaceState {
  let st = states.get(key)
  if (!st) {
    st = { failed: false, surfaceKey: null, last: null, frames: 0, misses: 0, missReason: '' }
    states.set(key, st)
  }
  return st
}

function present(t: TunerFrameTarget, surfaceKey: string, info: SurfaceInfo) {
  return presentSurface(surfaceKey, info, t.pid, [...remoteVideo.subscribersFor(surfaceKey, [[surfaceKey, t.wcId]])])
}

function missed(t: TunerFrameTarget, st: SurfaceState, reason: string): void {
  if (st.frames > 0) return
  st.misses++
  if (reason) st.missReason = reason
  t.onMiss?.(st.misses, st.missReason)
}

export function resetTunerSurfaceMisses(key: string): void {
  const st = states.get(key)
  if (st) st.misses = 0
}

function failed(t: TunerFrameTarget, st: SurfaceState, reason: string): void {
  st.last = null
  if (st.failed) return
  st.failed = true
  console.warn(`[tuner] shared surface import failed session=${t.session} (${reason})`)
}

export function routeTunerFrame(t: TunerFrameTarget, e: Record<string, unknown>): void {
  const mainIn = wallClock()
  const f = parseTunerFrame(e)
  if (!f || f.meta.session !== t.session) return
  const sf = f.surface
  const st = stateOf(t.key)
  const surfaceKey = tunerSurfaceKey(t.projectPath, t.session)
  if (st.surfaceKey && st.surfaceKey !== surfaceKey) releaseHeld(st.surfaceKey)
  st.surfaceKey = surfaceKey
  targets.set(surfaceKey, t)
  const info: SurfaceInfo = {
    format: sf.format,
    handleLow: sf.id,
    handleHigh: sf.handleHigh,
    width: f.meta.width,
    height: f.meta.height,
    generation: sf.generation,
    stamp: null,
    seq: null
  }
  const r = present(t, surfaceKey, info)
  if (r.fatal || r.error) {
    failed(t, st, r.error ?? 'import failed')
    missed(t, st, r.error ?? '')
    return
  }
  if (r.surfaceId == null) {
    missed(t, st, r.reason ?? '')
    return
  }
  st.failed = false
  if (st.frames === 0 && st.misses > 0) {
    debugLog(`[tuner] session=${t.session} shows its first frame after ${st.misses} that could not be shown`)
    st.misses = 0
    t.onShown?.()
  }
  if (f.meta.lt) f.meta.lt.push(mainIn, wallClock())
  const payload: TunerFrameEvent = {
    projectPath: t.projectPath,
    meta: f.meta,
    surface: { key: surfaceKey, surfaceId: r.surfaceId, generation: info.generation, flipY: sf.flipY }
  }
  st.last = { info, payload }
  if (st.frames++ === 0)
    debugLog(
      `[tuner] zero-copy frames session=${t.session} ${info.width}x${info.height} surface=${info.handleLow} generation=${info.generation}`
    )
  t.send('tuner:frame', payload)
  remoteVideo.onFrame(surfaceKey, r.surfaceId, info.generation, info.width, info.height, null, { projectPath: t.projectPath, key: surfaceKey, flipY: sf.flipY, meta: f.meta })
}

export function tunerSurfaceResync(t: TunerFrameTarget): void {
  const st = states.get(t.key)
  if (!st) return
  const last = st.last
  if (!last || !st.surfaceKey) return
  resendSurface(st.surfaceKey, t.wcId)
  const r = present(t, st.surfaceKey, last.info)
  if (r.fatal || r.error) {
    failed(t, st, r.error ?? 'import failed')
    return
  }
  if (r.surfaceId == null) return
  t.send('tuner:frame', last.payload)
  remoteVideo.onFrame(st.surfaceKey, r.surfaceId, last.info.generation, last.info.width, last.info.height, null, { projectPath: t.projectPath, key: st.surfaceKey, flipY: last.payload.surface.flipY, meta: last.payload.meta })
}

export function endTunerSurface(key: string, forget: boolean): void {
  const st = states.get(key)
  if (!st) return
  if (st.surfaceKey) releaseHeld(st.surfaceKey)
  if (forget && st.surfaceKey) targets.delete(st.surfaceKey)
  st.last = null
  st.frames = 0
  if (forget) states.delete(key)
}
