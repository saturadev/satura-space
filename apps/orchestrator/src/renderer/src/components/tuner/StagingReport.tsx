import { useEffect, useRef, useState, type RefObject } from 'react'
import { mediaUrlForPath } from '@shared/media-url'
import type { TunerStagingIteration, TunerStagingMetric, TunerStagingReport, TunerStagingSeries } from '@shared/tuner-staging'
import { fmtNum, fmtRange, iterationAlpha, niceTicks } from '../../lib/tuner/staging-report'

const LINE = '#7dd3fc'
const PAD_L = 38
const PAD_R = 10

function useWidth(ref: RefObject<HTMLDivElement | null>): number {
  const [w, setW] = useState(0)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(() => setW(el.clientWidth))
    ro.observe(el)
    setW(el.clientWidth)
    return () => ro.disconnect()
  }, [ref])
  return w
}

function valueAt(s: TunerStagingSeries, t: number): number | null {
  const n = s.t.length
  if (n === 0) return null
  if (t <= s.t[0]) return s.v[0]
  if (t >= s.t[n - 1]) return s.v[n - 1]
  let lo = 0
  let hi = n - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (s.t[mid] <= t) lo = mid
    else hi = mid
  }
  const k = (t - s.t[lo]) / (s.t[hi] - s.t[lo] || 1)
  return s.v[lo] + (s.v[hi] - s.v[lo]) * k
}

function timeAxis(span: number, w: number): number[] {
  return niceTicks(0, span, Math.max(2, Math.floor((w - PAD_L - PAD_R) / 70)))
}

function latestMetrics(its: TunerStagingIteration[]): { m: TunerStagingMetric; index: number }[] {
  const out: { m: TunerStagingMetric; index: number }[] = []
  for (let i = its.length - 1; i >= 0; i--)
    for (const m of its[i].metrics) if (!out.some((x) => x.m.name === m.name)) out.push({ m, index: its[i].index })
  return out
}

function Tiles({ its, loop }: { its: TunerStagingIteration[]; loop: boolean }) {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(118px,1fr))] gap-2" data-staging-metrics>
      {latestMetrics(its).map(({ m, index }) => {
        const range = fmtRange(m.min, m.max, m.unit)
        const delta = m.prev != null ? m.value - m.prev : null
        const flat = delta != null && fmtNum(Math.abs(delta)) === '0'
        const against = loop && index > 1 ? `iteration ${index - 1}` : 'the previous run'
        return (
          <div
            key={m.name}
            data-staging-metric={m.name}
            data-value={m.value}
            data-ok={m.ok ? 'yes' : 'no'}
            data-prev={m.prev ?? ''}
            data-iteration={index}
            className={`rounded-md border bg-black/20 px-2 py-1.5 ${range && !m.ok ? 'border-rose-400/40' : 'border-hairline'}`}
          >
            <div className="flex gap-1 text-[10px] text-ink-3">
              <span className="min-w-0 truncate">{m.name}</span>
              {loop && <span className="ml-auto shrink-0 tabular-nums">#{index}</span>}
            </div>
            <div className={`truncate text-[16px] font-medium leading-tight tabular-nums ${range && !m.ok ? 'text-rose-300' : 'text-ink'}`}>
              {fmtNum(m.value)}
              {m.unit && <span className="ml-1 text-[11px] font-normal text-ink-3">{m.unit}</span>}
            </div>
            {range && (
              <div className={`truncate text-[10px] tabular-nums ${m.ok ? 'text-emerald-400' : 'text-rose-400'}`} data-ti-tip={m.ok ? 'Inside the allowed range' : 'Outside the allowed range'}>
                {m.ok ? 'in' : 'out of'} {range}
              </div>
            )}
            {m.prev != null && delta != null && (
              <div className="truncate text-[10px] tabular-nums text-ink-3" data-staging-delta data-ti-tip={`Compared with ${against}`}>
                {fmtNum(m.prev)} → {fmtNum(m.value)}{' '}
                <span className={flat ? '' : delta > 0 ? 'text-sky-300' : 'text-amber-300'}>
                  {flat ? '±' : delta > 0 ? '+' : '−'}
                  {fmtNum(Math.abs(delta))}
                </span>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

function SeriesChart({ name, its, span, height }: { name: string; its: TunerStagingIteration[]; span: number; height: number }) {
  const box = useRef<HTMLDivElement>(null)
  const w = useWidth(box)
  const [hover, setHover] = useState<number | null>(null)
  const all = its.map((it) => ({ it, s: it.series.find((x) => x.name === name) ?? null }))
  let top = all.length - 1
  while (top > 0 && (all[top].s?.t.length ?? 0) < 2) top--
  const lines = all.slice(0, top + 1).map((l, i, list) => ({ ...l, alpha: iterationAlpha(i, list.length), latest: i === list.length - 1 }))
  const latest = lines[lines.length - 1]
  const cur = latest.s
  const band = cur?.band ?? [...lines].reverse().find((l) => l.s?.band)?.s?.band ?? null
  let v0 = Infinity
  let v1 = -Infinity
  for (const l of lines) if (l.s) for (const v of l.s.v) {
    if (v < v0) v0 = v
    if (v > v1) v1 = v
  }
  if (band) for (const b of band) if (b != null) {
    v0 = Math.min(v0, b)
    v1 = Math.max(v1, b)
  }
  if (!Number.isFinite(v0)) {
    v0 = 0
    v1 = 1
  }
  if (v1 - v0 < 1e-6) {
    v0 -= 0.5
    v1 += 0.5
  }
  const rough = niceTicks(v0, v1, 3)
  const step = rough.length > 1 ? rough[1] - rough[0] : 0
  if (step > 0) {
    v0 = Math.floor(v0 / step + 1e-9) * step
    v1 = Math.ceil(v1 / step - 1e-9) * step
  }
  const ticks = step > 0 ? niceTicks(v0, v1, Math.round((v1 - v0) / step)) : rough
  const h = height
  const padT = 8
  const bottom = 18
  const iw = Math.max(1, w - PAD_L - PAD_R)
  const sx = (t: number): number => PAD_L + (t / span) * iw
  const sy = (v: number): number => padT + (1 - (v - v0) / (v1 - v0 || 1)) * (h - padT - bottom)
  const path = (s: TunerStagingSeries): string => s.t.map((t, i) => `${i ? 'L' : 'M'}${sx(t).toFixed(1)},${sy(s.v[i]).toFixed(1)}`).join('')
  const shown = lines.filter((l) => l.s && l.s.t.length > 0)
  const marks = cur ? latest.it.checks.map((c) => ({ c, v: valueAt(cur, c.t) })).filter((m) => m.v != null) : []
  const hv = hover != null && cur ? valueAt(cur, hover) : null
  let maxV = -Infinity
  if (cur) for (const v of cur.v) maxV = Math.max(maxV, v)
  return (
    <div data-staging-chart={name} data-points={cur?.t.length ?? 0} data-iterations={shown.length} data-checks={marks.length}>
      <div className="mb-0.5 flex min-w-0 items-baseline gap-2 text-[10px]">
        <span className="shrink-0 font-medium text-ink-2">{name}</span>
        {cur && cur.v.length > 0 && (
          <span className="shrink-0 tabular-nums text-ink-3">
            last {fmtNum(cur.v[cur.v.length - 1])} · max {fmtNum(maxV)}
          </span>
        )}
        {band && <span className="shrink-0 tabular-nums text-emerald-400/80">allowed {fmtRange(band[0], band[1], '')}</span>}
        <span className="min-w-0 flex-1" />
        {shown.length > 1 && (
          <span className="min-w-0 truncate text-ink-3" data-ti-tip="Earlier iterations stay faded behind the latest one, so an inspector change shows up as a shifted curve">
            #{latest.it.index} bright, {shown.length - 1} earlier faded
          </span>
        )}
      </div>
      <div ref={box} className="relative w-full" style={{ height: h }}>
        {w > 0 && (
          <svg
            width={w}
            height={h}
            className="block"
            onPointerMove={(e) => {
              const r = e.currentTarget.getBoundingClientRect()
              const x = e.clientX - r.left
              setHover(x >= PAD_L && x <= w - PAD_R ? ((x - PAD_L) / iw) * span : null)
            }}
            onPointerLeave={() => setHover(null)}
          >
            {band && (
              <rect
                x={PAD_L}
                width={iw}
                y={sy(band[1] ?? v1)}
                height={Math.max(0, sy(band[0] ?? v0) - sy(band[1] ?? v1))}
                fill="rgb(52 211 153 / 0.09)"
                stroke="rgb(52 211 153 / 0.25)"
                strokeDasharray="3 3"
              />
            )}
            {ticks.map((v) => (
              <g key={`y${v}`}>
                <line x1={PAD_L} x2={w - PAD_R} y1={sy(v)} y2={sy(v)} stroke="rgb(255 255 255 / 0.06)" />
                <text x={PAD_L - 5} y={sy(v)} fill="rgb(161 161 170)" fontSize={9} textAnchor="end" dominantBaseline="middle">
                  {fmtNum(v)}
                </text>
              </g>
            ))}
            {timeAxis(span, w).map((t) => (
              <text key={`x${t}`} x={sx(t)} y={h - 5} fill="rgb(113 113 122)" fontSize={9} textAnchor="middle">
                {fmtNum(t)} s
              </text>
            ))}
            {shown
              .filter((l) => !l.latest)
              .map((l) => (
                <path key={l.it.index} d={path(l.s!)} fill="none" stroke={LINE} strokeOpacity={l.alpha} strokeWidth={1.25} strokeLinejoin="round" />
              ))}
            {latest.it.errorAt != null && (
              <line x1={sx(latest.it.errorAt)} x2={sx(latest.it.errorAt)} y1={padT} y2={h - bottom} stroke="rgb(251 113 133 / 0.7)" strokeDasharray="3 2" />
            )}
            {cur && cur.t.length > 0 && <path d={path(cur)} fill="none" stroke={LINE} strokeWidth={1.75} strokeLinejoin="round" strokeLinecap="round" />}
            {marks.map(({ c, v }, i) => (
              <g key={i}>
                <circle cx={sx(c.t)} cy={sy(v!)} r={3} fill={c.ok ? '#34d399' : '#fb7185'} stroke="rgb(0 0 0 / 0.5)" />
                <text x={sx(c.t)} y={sy(v!) - 6} fill={c.ok ? '#34d399' : '#fb7185'} fontSize={10} textAnchor="middle">
                  {c.ok ? '✓' : '✗'}
                </text>
                <title>{`${c.ok ? '✓' : '✗'} ${c.what} at ${fmtNum(c.t)} s`}</title>
              </g>
            ))}
            {hover != null && hv != null && (
              <g pointerEvents="none">
                <line x1={sx(hover)} x2={sx(hover)} y1={padT} y2={h - bottom} stroke="rgb(255 255 255 / 0.25)" />
                <circle cx={sx(hover)} cy={sy(hv)} r={3} fill={LINE} />
              </g>
            )}
          </svg>
        )}
        {hover != null && hv != null && (
          <div className="pointer-events-none absolute top-0 rounded bg-black/70 px-1.5 py-0.5 text-[10px] tabular-nums text-ink" style={{ left: Math.min(sx(hover) + 8, w - 90) }}>
            {fmtNum(hover)} s · {fmtNum(hv)}
          </div>
        )}
      </div>
    </div>
  )
}

function StepsBar({ it, span }: { it: TunerStagingIteration; span: number }) {
  const box = useRef<HTMLDivElement>(null)
  const w = useWidth(box)
  const iw = Math.max(1, w - PAD_L - PAD_R)
  const sx = (t: number): number => PAD_L + (Math.min(span, Math.max(0, t)) / span) * iw
  const steps = [...it.steps].sort((a, b) => a.t - b.t)
  return (
    <div data-staging-steps={steps.length}>
      <div className="mb-0.5 text-[10px] font-medium text-ink-2">Steps</div>
      <div ref={box} className="relative h-[40px] w-full">
        {w > 0 && (
          <>
            <div className="absolute top-[14px] h-px bg-white/10" style={{ left: PAD_L, width: iw }} />
            {steps.map((st, i) => {
              const end = i + 1 < steps.length ? steps[i + 1].t : it.end
              const x0 = sx(st.t)
              const x1 = Math.max(x0 + 2, sx(end))
              return (
                <div
                  key={i}
                  data-staging-step={st.name}
                  data-t={st.t}
                  className={`absolute top-[4px] flex h-[20px] items-center overflow-hidden rounded-sm border-l-2 border-sky-300/70 px-1 text-[10px] text-ink-2 ${i % 2 ? 'bg-white/[0.07]' : 'bg-white/[0.12]'}`}
                  style={{ left: x0, width: x1 - x0 }}
                  data-ti-tip={`${st.name}: ${fmtNum(st.t)}–${fmtNum(end)} s`}
                >
                  <span className="truncate">{st.name}</span>
                </div>
              )
            })}
            {it.checks.map((c, i) => (
              <span
                key={`c${i}`}
                data-staging-step-check={c.ok ? 'ok' : 'fail'}
                className={`absolute top-[23px] -translate-x-1/2 whitespace-nowrap text-[10px] leading-none ${c.ok ? 'text-emerald-400' : 'text-rose-400'}`}
                style={{ left: sx(c.t) }}
                data-ti-tip={`${c.what} at ${fmtNum(c.t)} s`}
              >
                {c.ok ? '✓' : '✗'}
              </span>
            ))}
            {it.errorAt != null && (
              <div className="absolute top-[2px] h-[24px] w-px bg-rose-400" style={{ left: sx(it.errorAt) }} data-staging-fail-at={it.errorAt} data-ti-tip={`Failed at ${fmtNum(it.errorAt)} s`} />
            )}
            {timeAxis(span, w).map((t) => (
              <span key={t} className="absolute bottom-0 -translate-x-1/2 whitespace-nowrap text-[9px] tabular-nums text-zinc-500" style={{ left: sx(t) }}>
                {fmtNum(t)} s
              </span>
            ))}
          </>
        )}
      </div>
    </div>
  )
}

function Filmstrip({ report, big, onOpen }: { report: TunerStagingReport; big: boolean; onOpen: (file: string) => void }) {
  const tw = big ? 240 : 128
  const th = big ? 135 : 72
  const strip = useRef<HTMLDivElement>(null)
  const newest = report.snapshots[report.snapshots.length - 1]?.path ?? ''
  useEffect(() => {
    const el = strip.current
    if (el) el.scrollLeft = el.scrollWidth
  }, [newest])
  return (
    <div data-staging-filmstrip={report.snapshots.length}>
      <div className="mb-1 text-[10px] font-medium text-ink-2">Snapshots</div>
      <div ref={strip} className="flex gap-2 overflow-x-auto pb-1">
        {report.snapshots.map((sn) => (
          <button
            key={sn.path}
            type="button"
            data-staging-snapshot={sn.path}
            className="group shrink-0 text-left"
            style={{ width: tw }}
            onClick={() => onOpen(sn.path)}
            data-ti-tip="Open the image"
          >
            <img
              src={mediaUrlForPath(sn.path)}
              alt={sn.name}
              draggable={false}
              className="block rounded border border-hairline bg-black/40 object-cover transition-colors group-hover:border-sky-400/70"
              style={{ width: tw, height: th }}
            />
            <div className="mt-0.5 truncate text-[10px] text-ink-2">{sn.name}</div>
            <div className="text-[10px] tabular-nums text-ink-3">
              {report.loop ? `#${sn.iteration} · ` : ''}
              {fmtNum(sn.t)} s
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}

export function StagingReport({ report, big = false, onOpen }: { report: TunerStagingReport; big?: boolean; onOpen: (file: string) => void }) {
  const its = report.iterations
  const latest = its[its.length - 1]
  if (!latest) return null
  const span = Math.max(0.5, ...its.map((it) => it.end))
  const names: string[] = []
  for (const it of [...its].reverse()) for (const s of it.series) if (!names.includes(s.name)) names.push(s.name)
  const empty = !its.some((it) => it.metrics.length > 0) && !names.length && !latest.steps.length && !latest.checks.length && !report.snapshots.length
  return (
    <div data-staging-report={report.path} data-staging-report-run={report.run} className="flex flex-col gap-3">
      {its.some((it) => it.metrics.length > 0) && <Tiles its={its} loop={report.loop} />}
      {names.map((n) => (
        <SeriesChart key={n} name={n} its={its} span={span} height={big ? 200 : 116} />
      ))}
      {(latest.steps.length > 0 || latest.checks.length > 0 || latest.errorAt != null) && <StepsBar it={latest} span={span} />}
      {report.snapshots.length > 0 && <Filmstrip report={report} big={big} onOpen={onOpen} />}
      {empty && (
        <div className="text-ink-3">
          This scenario records nothing for a report. Call Plot, Metric, Track, Step or Snapshot in it.
        </div>
      )}
    </div>
  )
}
