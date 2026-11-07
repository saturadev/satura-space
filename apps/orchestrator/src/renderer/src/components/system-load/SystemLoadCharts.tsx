import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react'
import { TriangleAlert } from 'lucide-react'
import type { SystemDisk, SystemSample } from '@shared/api'

export interface SystemLoadState {
  samples: SystemSample[]
  memTotal: number
  disk: SystemDisk | null
  windowMs: number
  cores: number
  loaded: boolean
  error: string | null
}

const EMPTY: SystemLoadState = { samples: [], memTotal: 0, disk: null, windowMs: 10 * 60_000, cores: 0, loaded: false, error: null }
const GAP_MS = 30_000

export function useSystemLoad(active: boolean, everyMs = 2000): SystemLoadState {
  const [state, setState] = useState<SystemLoadState>(EMPTY)
  const buf = useRef<SystemSample[]>([])
  useEffect(() => {
    if (!active) return
    let stop = false
    let timer = 0
    const poll = async (): Promise<void> => {
      if (typeof document !== 'undefined' && document.hidden) {
        timer = window.setTimeout(() => void poll(), everyMs)
        return
      }
      try {
        const last = buf.current[buf.current.length - 1]
        const r = await window.api.system.load(last?.t ?? 0)
        if (stop) return
        const merged = last ? buf.current.concat(r.samples) : r.samples
        const end = merged[merged.length - 1]?.t ?? 0
        buf.current = merged.filter((s) => s.t >= end - r.windowMs)
        setState({ samples: buf.current, memTotal: r.memTotal, disk: r.disk, windowMs: r.windowMs, cores: r.cores, loaded: true, error: null })
      } catch (e) {
        if (!stop) setState((s) => ({ ...s, error: (e as Error)?.message || "The desktop didn't answer" }))
      }
      if (!stop) timer = window.setTimeout(() => void poll(), everyMs)
    }
    void poll()
    return () => {
      stop = true
      window.clearTimeout(timer)
    }
  }, [active, everyMs])
  return state
}

export function formatMem(bytes: number): string {
  const gb = bytes / 1024 ** 3
  return gb >= 10 ? `${gb.toFixed(1)} GB` : gb >= 1 ? `${gb.toFixed(2)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`
}

export function formatDisk(bytes: number): string {
  const tb = bytes / 1e12
  if (tb >= 1) return `${tb.toFixed(2)} TB`
  const gb = bytes / 1e9
  return gb >= 100 ? `${Math.round(gb)} GB` : `${gb.toFixed(1)} GB`
}

export function formatPct(v: number): string {
  return `${v < 10 ? v.toFixed(1) : Math.round(v)}%`
}

export function stats(values: number[]): { peak: number; avg: number } {
  if (!values.length) return { peak: 0, avg: 0 }
  let peak = 0
  let sum = 0
  for (const v of values) {
    peak = Math.max(peak, v)
    sum += v
  }
  return { peak, avg: sum / values.length }
}

function useWidth(): [RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement | null>(null)
  const [w, setW] = useState(0)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    setW(el.clientWidth)
    const ro = new ResizeObserver(() => setW(el.clientWidth))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, w]
}

function segments(samples: SystemSample[]): SystemSample[][] {
  const out: SystemSample[][] = []
  let cur: SystemSample[] = []
  for (const s of samples) {
    if (cur.length && s.t - cur[cur.length - 1].t > GAP_MS) {
      out.push(cur)
      cur = []
    }
    cur.push(s)
  }
  if (cur.length) out.push(cur)
  return out
}

function ago(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 5) return 'now'
  if (s < 60) return `${s} s ago`
  const m = Math.floor(s / 60)
  const r = s % 60
  return r ? `${m} min ${r} s ago` : `${m} min ago`
}

export function LoadChart({
  samples,
  pick,
  max,
  windowMs,
  height,
  ticks,
  format,
  surface,
  label
}: {
  samples: SystemSample[]
  pick: (s: SystemSample) => number
  max: number
  windowMs: number
  height: number
  ticks: { v: number; text: string }[]
  format: (v: number) => string
  surface: string
  label: string
}) {
  const [ref, width] = useWidth()
  const [hover, setHover] = useState<SystemSample | null>(null)
  const left = 40
  const top = 6
  const axis = 16
  const plotW = Math.max(0, width - left)
  const plotH = height - top - axis
  const end = samples.length ? samples[samples.length - 1].t : Date.now()
  const start = end - windowMs
  const x = (t: number): number => left + ((t - start) / windowMs) * plotW
  const y = (v: number): number => top + plotH - (Math.min(max, Math.max(0, v)) / (max || 1)) * plotH
  const segs = segments(samples)
  const last = samples[samples.length - 1]
  const onMove = (e: ReactPointerEvent<SVGSVGElement>): void => {
    if (!samples.length) return
    const r = e.currentTarget.getBoundingClientRect()
    const t = start + ((e.clientX - r.left - left) / (plotW || 1)) * windowMs
    let best = samples[0]
    for (const s of samples) if (Math.abs(s.t - t) < Math.abs(best.t - t)) best = s
    setHover(best)
  }
  const shown = hover ?? null
  const tipLeft = shown ? Math.min(Math.max(x(shown.t), left + 44), width - 44) : 0
  return (
    <div ref={ref} className="relative w-full select-none" style={{ height }} data-load-chart={label}>
      {width > 0 && (
        <svg
          width={width}
          height={height}
          role="img"
          aria-label={last ? `${label} over the last ${Math.round(windowMs / 60_000)} minutes, now ${format(pick(last))}` : `${label}, no samples yet`}
          className="block"
          style={{ touchAction: 'pan-y' }}
          onPointerMove={onMove}
          onPointerDown={onMove}
          onPointerLeave={() => setHover(null)}
          onPointerCancel={() => setHover(null)}
        >
          {ticks.map((tk, i) => (
            <g key={i}>
              <line x1={left} x2={width} y1={y(tk.v) + 0.5} y2={y(tk.v) + 0.5} stroke="var(--grid-line, #3a3f4a)" strokeOpacity={0.55} strokeWidth={1} />
              <text x={left - 6} y={y(tk.v) + 3.5} textAnchor="end" fontSize={10} fill="var(--ink-3, #6b717b)" style={{ fontVariantNumeric: 'tabular-nums' }}>
                {tk.text}
              </text>
            </g>
          ))}
          {segs.map((seg, i) => {
            const pts = seg.map((s) => `${x(s.t).toFixed(1)},${y(pick(s)).toFixed(1)}`)
            const base = y(0)
            return (
              <g key={i}>
                {seg.length > 1 && <path d={`M${x(seg[0].t).toFixed(1)},${base} L${pts.join(' L')} L${x(seg[seg.length - 1].t).toFixed(1)},${base} Z`} fill="var(--accent, #8196ff)" fillOpacity={0.1} />}
                <path d={`M${pts.join(' L')}`} fill="none" stroke="var(--accent, #8196ff)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
              </g>
            )
          })}
          {last && !shown && <circle cx={x(last.t)} cy={y(pick(last))} r={4} fill="var(--accent, #8196ff)" stroke={surface} strokeWidth={2} />}
          {shown && (
            <>
              <line x1={x(shown.t) + 0.5} x2={x(shown.t) + 0.5} y1={top} y2={top + plotH} stroke="var(--ink-3, #6b717b)" strokeWidth={1} />
              <circle cx={x(shown.t)} cy={y(pick(shown))} r={4} fill="var(--accent, #8196ff)" stroke={surface} strokeWidth={2} />
            </>
          )}
          <text x={left} y={height - 3} fontSize={10} fill="var(--ink-3, #6b717b)">
            {Math.round(windowMs / 60_000)} min ago
          </text>
          <text x={width} y={height - 3} fontSize={10} textAnchor="end" fill="var(--ink-3, #6b717b)">
            now
          </text>
        </svg>
      )}
      {shown && (
        <div
          className="pointer-events-none absolute top-0 -translate-x-1/2 whitespace-nowrap rounded-md border border-[var(--overlay-edge,rgb(255_255_255/0.11))] px-2 py-1 text-center"
          style={{ left: tipLeft, background: 'var(--panel, #23262b)', boxShadow: 'var(--shadow-overlay-sm)' }}
          data-load-tip
        >
          <div className="text-[12px] font-semibold text-[var(--ink,#e5e7eb)]" style={{ fontVariantNumeric: 'tabular-nums' }}>
            {format(pick(shown))}
          </div>
          <div className="text-[10px] text-[var(--ink-2,#9aa0a9)]">{ago(end - shown.t)}</div>
        </div>
      )}
      {samples.length < 2 && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-[12px] text-[var(--ink-2,#9aa0a9)]" style={{ paddingLeft: left, paddingBottom: axis }}>
          Collecting samples
        </div>
      )}
    </div>
  )
}

export function Sparkline({ values, max, width = 64, height = 22, surface }: { values: number[]; max: number; width?: number; height?: number; surface: string }) {
  if (values.length < 2) return <svg width={width} height={height} aria-hidden />
  const pad = 3
  const step = (width - pad * 2) / (values.length - 1)
  const y = (v: number): number => pad + (height - pad * 2) * (1 - Math.min(max, Math.max(0, v)) / (max || 1))
  const pts = values.map((v, i) => `${(pad + i * step).toFixed(1)},${y(v).toFixed(1)}`)
  const lx = pad + (values.length - 1) * step
  return (
    <svg width={width} height={height} aria-hidden className="block shrink-0">
      <path d={`M${pts.join(' L')}`} fill="none" stroke="var(--ink-3, #6b717b)" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={lx} cy={y(values[values.length - 1])} r={3} fill="var(--accent, #8196ff)" stroke={surface} strokeWidth={1.5} />
    </svg>
  )
}

export function diskLow(d: SystemDisk): boolean {
  return d.total > 0 && d.free / d.total < 0.1
}

export function DiskBar({ disk, height = 8 }: { disk: SystemDisk; height?: number }) {
  const used = Math.max(0, disk.total - disk.free)
  const share = disk.total ? used / disk.total : 0
  const color = diskLow(disk) ? 'var(--warn, #e8a54d)' : 'var(--accent, #8196ff)'
  return (
    <div
      className="w-full overflow-hidden rounded-full"
      style={{ height, background: `color-mix(in srgb, ${color} 22%, transparent)` }}
      role="meter"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(share * 100)}
      aria-label={`Disk ${Math.round(share * 100)}% used, ${formatDisk(disk.free)} free of ${formatDisk(disk.total)}`}
      data-disk-bar
    >
      <div className="h-full rounded-full" style={{ width: `${Math.min(100, share * 100)}%`, background: color }} />
    </div>
  )
}

export function DiskSummary({ disk, compact }: { disk: SystemDisk; compact?: boolean }) {
  const used = Math.max(0, disk.total - disk.free)
  return (
    <div className="flex flex-col gap-1.5" data-disk-summary>
      <div className="flex items-baseline justify-between gap-2">
        <span className={`${compact ? 'text-[12px]' : 'text-[15px]'} font-semibold text-[var(--ink,#e5e7eb)]`}>
          {formatDisk(disk.free)} free of {formatDisk(disk.total)}
        </span>
        <span className={`${compact ? 'text-[11px]' : 'text-[13px]'} text-[var(--ink-2,#9aa0a9)]`}>{formatDisk(used)} used</span>
      </div>
      <DiskBar disk={disk} height={compact ? 6 : 8} />
      {diskLow(disk) && (
        <span className={`flex items-center gap-1 ${compact ? 'text-[11px]' : 'text-[13px]'} text-[var(--ink-2,#9aa0a9)]`}>
          <TriangleAlert size={compact ? 11 : 13} className="text-[var(--warn,#e8a54d)]" />
          Almost full
        </span>
      )}
    </div>
  )
}

export function cpuTicks(): { v: number; text: string }[] {
  return [
    { v: 0, text: '0' },
    { v: 50, text: '50%' },
    { v: 100, text: '100%' }
  ]
}

export function memTicks(total: number): { v: number; text: string }[] {
  const gb = Math.round(total / 1024 ** 3)
  if (!gb) return [{ v: 0, text: '0' }]
  return [
    { v: 0, text: '0' },
    { v: total / 2, text: `${Math.round(gb / 2)} GB` },
    { v: total, text: `${gb} GB` }
  ]
}
