import type { TunerSceneIcon } from '@shared/tuner'
import type { SceneIconSpot } from './scene-icons'

const MAX = 4096
const WINDOW_PX = 90
const EDGE_PX = 24

export interface IconTraceFrame {
  t: number
  seq: number
  icons: boolean
  poses: number
}

export interface IconTraceSample {
  t: number
  seq: number
  iconSeq: number
  drawSeq: number
  blob: [number, number] | null
  icon: [number, number] | null
  err: number | null
  gizmo: [number, number] | null
  gizmoErr: number | null
  poseErr: number | null
  pose: [number, number] | null
}

interface IconTrace {
  on: boolean
  frames: IconTraceFrame[]
  samples: IconTraceSample[]
  spots: SceneIconSpot[]
  gizmo: [number, number] | null
  pose: [number, number] | null
  probe: string
  drawSeq: number
  iconSeq: number
  last: [number, number] | null
}

const trace: IconTrace = { on: false, frames: [], samples: [], spots: [], gizmo: null, pose: null, probe: '', drawSeq: -1, iconSeq: -1, last: null }

export function iconTraceOn(): boolean {
  return trace.on
}

export function iconTraceFrame(seq: number, icons: TunerSceneIcon[] | undefined, poses: number): void {
  if (!trace.on) return
  if (icons) trace.iconSeq = seq
  trace.frames.push({ t: performance.now(), seq, icons: !!icons, poses })
  if (trace.frames.length > MAX) trace.frames.splice(0, trace.frames.length - MAX)
}

export function iconTraceProbe(): string {
  return trace.probe
}

export function iconTraceDraw(seq: number, spots: SceneIconSpot[], gizmo: [number, number] | null, pose: [number, number] | null): void {
  if (!trace.on) return
  trace.pose = pose
  trace.drawSeq = seq
  trace.spots = spots
  trace.gizmo = gizmo
}

function findBlob(canvas: HTMLCanvasElement, near: [number, number] | null): [number, number] | null {
  const ctx = canvas.getContext('2d')
  if (!ctx || canvas.width < 2 || canvas.height < 2) return null
  const x0 = near ? Math.max(0, Math.round(near[0] - WINDOW_PX)) : 0
  const y0 = near ? Math.max(0, Math.round(near[1] - WINDOW_PX)) : 0
  const x1 = near ? Math.min(canvas.width, Math.round(near[0] + WINDOW_PX)) : canvas.width
  const y1 = near ? Math.min(canvas.height, Math.round(near[1] + WINDOW_PX)) : canvas.height
  if (x1 - x0 < 2 || y1 - y0 < 2) return null
  const d = ctx.getImageData(x0, y0, x1 - x0, y1 - y0).data
  let sx = 0
  let sy = 0
  let n = 0
  const w = x1 - x0
  for (let i = 0; i < d.length; i += 4) {
    if (d[i] > 170 && d[i + 1] < 70 && d[i + 2] > 170) {
      const p = i >> 2
      sx += p % w
      sy += Math.floor(p / w)
      n++
    }
  }
  if (n < 6) return near ? findBlob(canvas, null) : null
  return [x0 + sx / n + 0.5, y0 + sy / n + 0.5]
}

export function iconTracePaint(seq: number, canvas: HTMLCanvasElement | null, vw: number, vh: number, flipY: boolean): void {
  if (!trace.on || !canvas) return
  const blobPx = findBlob(canvas, trace.last)
  trace.last = blobPx
  const k = vh / Math.max(1, canvas.height)
  const at: [number, number] | null = blobPx ? [vw / 2 + (blobPx[0] - canvas.width / 2) * k, (flipY ? canvas.height - blobPx[1] : blobPx[1]) * k] : null
  const blob = at && at[0] > EDGE_PX && at[1] > EDGE_PX && at[0] < vw - EDGE_PX && at[1] < vh - EDGE_PX ? at : null
  let icon: [number, number] | null = null
  let err: number | null = null
  if (blob) {
    for (const s of trace.spots) {
      const e = Math.hypot(s.x - blob[0], s.y - blob[1])
      if (e < 80 && (err == null || e < err)) {
        err = e
        icon = [s.x, s.y]
      }
    }
  }
  const gizmo = trace.gizmo
  const gizmoErr = blob && gizmo ? Math.hypot(gizmo[0] - blob[0], gizmo[1] - blob[1]) : null
  const pose = trace.pose
  const poseErr = blob && pose ? Math.hypot(pose[0] - blob[0], pose[1] - blob[1]) : null
  trace.samples.push({ t: performance.now(), seq, iconSeq: trace.iconSeq, drawSeq: trace.drawSeq, blob, icon, err, gizmo, gizmoErr, poseErr, pose })
  if (trace.samples.length > MAX) trace.samples.splice(0, trace.samples.length - MAX)
}

export function iconTraceStart(probe = ''): void {
  trace.on = true
  trace.probe = probe
  trace.pose = null
  trace.frames = []
  trace.samples = []
  trace.spots = []
  trace.gizmo = null
  trace.drawSeq = -1
  trace.iconSeq = -1
  trace.last = null
}

export function iconTraceStop(): { frames: IconTraceFrame[]; samples: IconTraceSample[] } {
  trace.on = false
  return { frames: trace.frames, samples: trace.samples }
}

function pct(v: number[], p: number): number | null {
  if (v.length === 0) return null
  const s = [...v].sort((a, b) => a - b)
  return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] * 10) / 10
}

export function iconTraceReport(): Record<string, unknown> {
  const { frames, samples } = iconTraceStop()
  const errs = samples.flatMap((s) => (s.err == null ? [] : [s.err]))
  const gerrs = samples.flatMap((s) => (s.gizmoErr == null ? [] : [s.gizmoErr]))
  const perrs = samples.flatMap((s) => (s.poseErr == null ? [] : [s.poseErr]))
  const age = samples.map((s) => s.seq - s.iconSeq)
  const stale = samples.map((s) => s.seq - s.drawSeq)
  return {
    frames: frames.length,
    framesWithIcons: frames.filter((f) => f.icons).length,
    framesWithPoses: frames.filter((f) => f.poses > 0).length,
    samples: samples.length,
    markerSeen: samples.filter((s) => s.blob).length,
    matched: errs.length,
    errPx: { p50: pct(errs, 50), p95: pct(errs, 95), max: pct(errs, 100) },
    gizmoMatched: gerrs.length,
    gizmoErrPx: { p50: pct(gerrs, 50), p95: pct(gerrs, 95), max: pct(gerrs, 100) },
    gizmoOff2px: gerrs.filter((e) => e > 2).length,
    poseMatched: perrs.length,
    poseErrPx: { p50: pct(perrs, 50), p95: pct(perrs, 95), max: pct(perrs, 100) },
    poseOff2px: perrs.filter((e) => e > 2).length,
    poseApartFromGizmo: samples.filter((s) => s.gizmo && s.pose && Math.hypot(s.gizmo[0] - s.pose[0], s.gizmo[1] - s.pose[1]) > 1).length,
    iconAgeFrames: { p50: pct(age, 50), p95: pct(age, 95) },
    overlayBehindFrames: { p50: pct(stale, 50), p95: pct(stale, 95) },
    tail: samples.slice(-6).map((s) => ({ seq: s.seq, iconSeq: s.iconSeq, blob: s.blob?.map((v) => Math.round(v)), icon: s.icon?.map((v) => Math.round(v)), err: s.err == null ? null : Math.round(s.err * 10) / 10, gizmoErr: s.gizmoErr == null ? null : Math.round(s.gizmoErr * 10) / 10 }))
  }
}

;(window as unknown as { __tunerIcons?: unknown }).__tunerIcons = { start: iconTraceStart, report: iconTraceReport, samples: () => trace.samples, frames: () => trace.frames }
