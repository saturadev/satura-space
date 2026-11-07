import type { Vec3 } from '@shared/tuner'
import type { TunerStagingIteration, TunerStagingReport, TunerStagingTrack } from '@shared/tuner-staging'

export interface StagingTrail {
  points: Vec3[]
  alpha: number
  latest: boolean
  checks: { at: Vec3; ok: boolean }[]
}

export function trackAt(tr: TunerStagingTrack, t: number): Vec3 | null {
  const n = tr.t.length
  if (n === 0) return null
  const pt = (i: number): Vec3 => [tr.p[i * 3], tr.p[i * 3 + 1], tr.p[i * 3 + 2]]
  if (t <= tr.t[0]) return pt(0)
  if (t >= tr.t[n - 1]) return pt(n - 1)
  let lo = 0
  let hi = n - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (tr.t[mid] <= t) lo = mid
    else hi = mid
  }
  const k = (t - tr.t[lo]) / (tr.t[hi] - tr.t[lo] || 1)
  const a = pt(lo)
  const b = pt(hi)
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k]
}

export function iterationAlpha(i: number, count: number): number {
  if (i === count - 1) return 1
  return 0.12 + (0.33 * (i + 1)) / Math.max(1, count - 1)
}

export function stagingTrails(report: TunerStagingReport | null): StagingTrail[] {
  if (!report) return []
  const its = report.iterations
  const out: StagingTrail[] = []
  its.forEach((it: TunerStagingIteration, i) => {
    const latest = i === its.length - 1
    it.tracks.forEach((tr, k) => {
      if (tr.t.length < 2) return
      const points: Vec3[] = []
      for (let j = 0; j < tr.t.length; j++) points.push([tr.p[j * 3], tr.p[j * 3 + 1], tr.p[j * 3 + 2]])
      const checks =
        k === 0
          ? it.checks.flatMap((c) => {
              const at = trackAt(tr, c.t)
              return at ? [{ at, ok: c.ok }] : []
            })
          : []
      out.push({ points, alpha: iterationAlpha(i, its.length), latest, checks })
    })
  })
  return out
}

export function drawStagingTrails(
  ctx: CanvasRenderingContext2D,
  trails: readonly StagingTrail[],
  project: (p: Vec3) => [number, number] | null,
  dpr: number
): { drawn: number; last: [number, number] | null } {
  let drawn = 0
  let last: [number, number] | null = null
  if (!trails.length) return { drawn, last }
  ctx.save()
  ctx.scale(dpr, dpr)
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  for (const tr of trails) {
    ctx.beginPath()
    let open = false
    for (const p of tr.points) {
      const s = project(p)
      if (!s) {
        open = false
        continue
      }
      if (open) ctx.lineTo(s[0], s[1])
      else ctx.moveTo(s[0], s[1])
      open = true
      if (tr.latest) last = s
    }
    if (tr.latest) {
      ctx.strokeStyle = 'rgba(0,0,0,0.45)'
      ctx.lineWidth = 4
      ctx.stroke()
    }
    ctx.strokeStyle = `rgba(196,181,253,${tr.alpha})`
    ctx.lineWidth = tr.latest ? 2 : 1.5
    ctx.stroke()
    drawn++
    for (const c of tr.checks) {
      const s = project(c.at)
      if (!s) continue
      ctx.beginPath()
      ctx.arc(s[0], s[1], tr.latest ? 4 : 3, 0, Math.PI * 2)
      ctx.fillStyle = c.ok ? `rgba(52,211,153,${tr.alpha})` : `rgba(251,113,133,${tr.alpha})`
      ctx.fill()
      ctx.strokeStyle = `rgba(0,0,0,${0.6 * tr.alpha})`
      ctx.lineWidth = 1
      ctx.stroke()
    }
  }
  ctx.restore()
  return { drawn, last }
}

export function niceTicks(min: number, max: number, count: number): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return []
  if (min === max) return [min]
  const raw = (max - min) / Math.max(1, count)
  const mag = Math.pow(10, Math.floor(Math.log10(raw)))
  const step = [1, 2, 2.5, 5, 10].map((f) => f * mag).find((x) => x >= raw) ?? raw
  const out: number[] = []
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-6; v += step) out.push(Number(v.toPrecision(10)))
  return out
}

export function fmtNum(v: number): string {
  if (!Number.isFinite(v)) return ''
  const a = Math.abs(v)
  if (a >= 100 || Number.isInteger(v)) return String(Math.round(v * 10) / 10)
  if (a >= 10) return v.toFixed(1)
  return String(Number(v.toFixed(2)))
}

export function fmtRange(min: number | null, max: number | null, unit: string): string {
  const u = unit ? ` ${unit}` : ''
  if (min != null && max != null) return `${fmtNum(min)}–${fmtNum(max)}${u}`
  if (min != null) return `≥ ${fmtNum(min)}${u}`
  if (max != null) return `≤ ${fmtNum(max)}${u}`
  return ''
}
