export interface TunerStagingRun {
  run: number
  status: string
  result: 'pass' | 'fail' | null
  error: string
  loop: boolean
  iterations: number
  passed: number
  failed: number
  lastError: string
  video: string
  seconds: number
  rev: number
}

export interface TunerStagingScenario {
  name: string
  label: string
  path: string
  loop: boolean
  description: string
  queued: boolean
  run: TunerStagingRun | null
}

export interface TunerStagingItem {
  name: string
  group: string
  path: string
  scene: string
  type: string
  running: string
  scenarios: TunerStagingScenario[]
  handles: string[]
}

export interface TunerStaging {
  playing: boolean
  scene: string
  scenePath: string
  scenes: string[]
  items: TunerStagingItem[]
  error: string
}

export interface TunerStagingSeries {
  name: string
  band: [number | null, number | null] | null
  t: number[]
  v: number[]
}

export interface TunerStagingTrack {
  name: string
  t: number[]
  p: number[]
}

export interface TunerStagingCheck {
  what: string
  ok: boolean
  t: number
}

export interface TunerStagingStep {
  name: string
  t: number
}

export interface TunerStagingMetric {
  name: string
  value: number
  unit: string
  min: number | null
  max: number | null
  ok: boolean
  prev: number | null
  t: number
}

export interface TunerStagingIteration {
  index: number
  end: number
  running: boolean
  stopped: boolean
  error: string
  errorAt: number | null
  series: TunerStagingSeries[]
  tracks: TunerStagingTrack[]
  checks: TunerStagingCheck[]
  steps: TunerStagingStep[]
  metrics: TunerStagingMetric[]
}

export interface TunerStagingSnapshot {
  name: string
  iteration: number
  t: number
  path: string
}

export interface TunerStagingReport {
  path: string
  run: number
  status: string
  loop: boolean
  rev: number
  iterations: TunerStagingIteration[]
  snapshots: TunerStagingSnapshot[]
}

export type TunerStagingOp = 'open' | 'close' | 'run' | 'stop' | 'report'

export interface TunerStagingRequest {
  op: TunerStagingOp
  path?: string
}

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const s = (v: unknown): string => (typeof v === 'string' ? v : '')
const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const opt = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const nums = (v: unknown): number[] => arr(v).map(n)

export function stagingLabel(name: string): string {
  return name
    .replace(/_/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
}

export function parseTunerStagingRun(v: unknown): TunerStagingRun | null {
  const r = rec(v)
  if (typeof r.run !== 'number') return null
  const seconds = typeof r.seconds === 'string' ? Number(r.seconds) : n(r.seconds)
  return {
    run: n(r.run),
    status: s(r.status),
    result: r.result === 'pass' || r.result === 'fail' ? r.result : null,
    error: s(r.error),
    loop: r.loop === true,
    iterations: n(r.iterations),
    passed: n(r.passed),
    failed: n(r.failed),
    lastError: s(r.lastError),
    video: s(r.video),
    seconds: Number.isFinite(seconds) ? seconds : 0,
    rev: n(r.rev)
  }
}

export function parseTunerStagingReport(v: unknown): TunerStagingReport | null {
  const r = rec(v)
  if (typeof r.path !== 'string' || typeof r.run !== 'number') return null
  return {
    path: r.path,
    run: n(r.run),
    status: s(r.status),
    loop: r.loop === true,
    rev: n(r.rev),
    iterations: arr(r.iterations).map((it) => {
      const x = rec(it)
      return {
        index: n(x.index),
        end: n(x.end),
        running: x.running === true,
        stopped: x.stopped === true,
        error: s(x.error),
        errorAt: opt(x.errorAt),
        series: arr(x.series).map((se) => {
          const y = rec(se)
          const band = arr(y.band)
          return { name: s(y.name), band: band.length === 2 ? [opt(band[0]), opt(band[1])] : null, t: nums(y.t), v: nums(y.v) }
        }),
        tracks: arr(x.tracks).map((tr) => {
          const y = rec(tr)
          return { name: s(y.name), t: nums(y.t), p: nums(y.p) }
        }),
        checks: arr(x.checks).map((c) => {
          const y = rec(c)
          return { what: s(y.what), ok: y.ok === true, t: n(y.t) }
        }),
        steps: arr(x.steps).map((st) => {
          const y = rec(st)
          return { name: s(y.name), t: n(y.t) }
        }),
        metrics: arr(x.metrics).map((m) => {
          const y = rec(m)
          return { name: s(y.name), value: n(y.value), unit: s(y.unit), min: opt(y.min), max: opt(y.max), ok: y.ok !== false, prev: opt(y.prev), t: n(y.t) }
        })
      }
    }),
    snapshots: arr(r.snapshots).map((sn) => {
      const y = rec(sn)
      return { name: s(y.name), iteration: n(y.iteration), t: n(y.t), path: s(y.path) }
    })
  }
}

export function parseTunerStaging(v: unknown): TunerStaging | null {
  const r = rec(v)
  if (!('items' in r) && !('error' in r)) return null
  const last = rec(r.last)
  const pending = new Set(arr(r.pending).map(s))
  return {
    playing: r.playing === true,
    scene: s(r.scene),
    scenePath: s(r.scenePath),
    scenes: arr(r.scenes).map(s).filter(Boolean),
    error: s(r.error),
    items: arr(r.items).map((it) => {
      const x = rec(it)
      return {
        name: s(x.name),
        group: s(x.group),
        path: s(x.path),
        scene: s(x.scene),
        type: s(x.type),
        running: s(x.running),
        handles: arr(x.handles).map(s),
        scenarios: arr(x.scenarios).map((sc) => {
          const y = rec(sc)
          const path = s(y.path)
          const name = s(y.name)
          return {
            name,
            label: stagingLabel(name),
            path,
            loop: y.loop === true,
            description: s(y.description),
            queued: pending.has(path),
            run: parseTunerStagingRun(y.run) ?? parseTunerStagingRun(last[path])
          }
        })
      }
    })
  }
}

export function cleanTunerStagingRequest(raw: unknown): TunerStagingRequest | null {
  const r = rec(raw)
  if (r.op !== 'open' && r.op !== 'close' && r.op !== 'run' && r.op !== 'stop' && r.op !== 'report') return null
  if (r.op === 'run' || r.op === 'stop' || r.op === 'report') {
    const path = s(r.path).trim()
    if (!path || path.length > 2048 || /[\r\n]/.test(path)) return null
    return { op: r.op, path }
  }
  return { op: r.op }
}

export function stagingRunning(sc: TunerStagingScenario): boolean {
  return sc.queued || (!!sc.run && (sc.run.status === 'running' || sc.run.status === 'scheduled'))
}
