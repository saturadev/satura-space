import { useRef, type KeyboardEvent as RKeyboardEvent, type PointerEvent as RPointerEvent } from 'react'
import type { AgentId } from '@shared/types'
import { getAgentEntry, type AgentModelOption } from '@shared/agent-catalog'
import { useAppStore } from '../store'

export function agentHasModelEffort(id: AgentId): boolean {
  const entry = getAgentEntry(id)
  return !!(entry?.models || entry?.efforts)
}

const MODEL_ACCENT: Record<string, { active: string; dot: string }> = {
  opus: { active: 'border-violet-500/60 bg-violet-500/15 text-violet-200', dot: 'bg-violet-400' },
  sonnet: { active: 'border-sky-500/60 bg-sky-500/15 text-sky-200', dot: 'bg-sky-400' },
  haiku: { active: 'border-emerald-500/60 bg-emerald-500/15 text-emerald-200', dot: 'bg-emerald-400' },
  fable: { active: 'border-amber-500/60 bg-amber-500/15 text-amber-200', dot: 'bg-amber-400' }
}
const NEUTRAL_ACTIVE = 'border-white/25 bg-white/10 text-zinc-100'
const INACTIVE =
  'border-white/10 bg-white/[0.03] text-zinc-400 hover:border-white/20 hover:text-zinc-100'

type EffortAccent = { fill: string; thumb: string; ring: string; text: string; shimmer?: boolean }
const EFFORT_ACCENT: Record<string, EffortAccent> = {
  '': { fill: 'bg-zinc-500', thumb: 'bg-zinc-300', ring: 'ring-zinc-400/40', text: 'text-zinc-300' },
  low: {
    fill: 'bg-yellow-400',
    thumb: 'bg-yellow-300',
    ring: 'ring-yellow-300/50',
    text: 'text-yellow-300'
  },
  medium: {
    fill: 'bg-green-500',
    thumb: 'bg-green-400',
    ring: 'ring-green-400/50',
    text: 'text-green-300'
  },
  high: { fill: 'bg-sky-400', thumb: 'bg-sky-300', ring: 'ring-sky-300/50', text: 'text-sky-300' },
  xhigh: {
    fill: 'bg-purple-500',
    thumb: 'bg-purple-400',
    ring: 'ring-purple-400/50',
    text: 'text-purple-300',
    shimmer: true
  },
  max: {
    fill: 'effort-rainbow',
    thumb: 'effort-rainbow',
    ring: 'ring-white/50',
    text: 'effort-rainbow-text'
  }
}
const EFFORT_FALLBACK = EFFORT_ACCENT['']

const LABEL = 'w-11 shrink-0 pt-1 text-[10px] font-semibold uppercase tracking-wide text-zinc-500'

export function AgentModelEffort({ id, className }: { id: AgentId; className?: string }) {
  const entry = getAgentEntry(id)
  const config = useAppStore((s) => s.settings?.agents?.[id])
  const setAgentConfig = useAppStore((s) => s.setAgentConfig)
  if (!entry?.models && !entry?.efforts) return null

  return (
    <div className={`space-y-2.5 ${className ?? ''}`}>
      {entry.models && (
        <ModelRow
          value={config?.model ?? ''}
          options={entry.models}
          onChange={(v) => setAgentConfig(id, { model: v || undefined })}
        />
      )}
      {entry.efforts && (
        <EffortSlider
          value={config?.effort ?? ''}
          options={entry.efforts}
          onChange={(v) => setAgentConfig(id, { effort: v || undefined })}
        />
      )}
    </div>
  )
}

function ModelRow({
  value,
  options,
  onChange
}: {
  value: string
  options: readonly AgentModelOption[]
  onChange: (value: string) => void
}) {
  const defActive = value === ''
  return (
    <div className="flex items-start gap-2">
      <span className={LABEL}>Model</span>
      <div className="flex flex-1 flex-wrap items-center gap-1">
        <button
          type="button"
          onClick={() => onChange('')}
          className={`rounded border px-2 py-0.5 text-[11px] font-medium transition-colors ${
            defActive ? NEUTRAL_ACTIVE : INACTIVE
          }`}
        >
          Default
        </button>
        <span className="mx-1 h-4 w-px shrink-0 self-center bg-white/15" />
        {options.map((o) => {
          const active = o.value === value
          const accent = MODEL_ACCENT[o.value]
          return (
            <button
              key={o.value}
              type="button"
              title={o.hint}
              onClick={() => onChange(o.value)}
              className={`flex items-center gap-1.5 rounded border px-2 py-0.5 text-[11px] font-medium transition-colors ${
                active ? (accent?.active ?? NEUTRAL_ACTIVE) : INACTIVE
              }`}
            >
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${accent?.dot ?? 'bg-zinc-400'}`} />
              {o.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}

const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n))

function EffortSlider({
  value,
  options,
  onChange
}: {
  value: string
  options: readonly AgentModelOption[]
  onChange: (value: string) => void
}) {
  const stops = ['', ...options.map((o) => o.value)]
  const labels = ['Default', ...options.map((o) => o.label)]
  const idx = Math.max(0, stops.indexOf(value))
  const max = stops.length - 1
  const accent = EFFORT_ACCENT[value] ?? EFFORT_FALLBACK

  const trackRef = useRef<HTMLDivElement>(null)
  const dragging = useRef(false)
  const dragIdx = useRef(-1)

  const commit = (i: number): void => onChange(stops[clamp(i, 0, max)] || '')
  const stopFromX = (clientX: number): number => {
    const el = trackRef.current
    if (!el) return idx
    const r = el.getBoundingClientRect()
    return Math.round(clamp((clientX - r.left) / r.width, 0, 1) * max)
  }
  const onDown = (e: RPointerEvent<HTMLDivElement>): void => {
    e.preventDefault()
    dragging.current = true
    e.currentTarget.setPointerCapture?.(e.pointerId)
    dragIdx.current = stopFromX(e.clientX)
    commit(dragIdx.current)
  }
  const onMove = (e: RPointerEvent<HTMLDivElement>): void => {
    if (!dragging.current) return
    const next = stopFromX(e.clientX)
    if (next === dragIdx.current) return
    dragIdx.current = next
    commit(next)
  }
  const onUp = (e: RPointerEvent<HTMLDivElement>): void => {
    dragging.current = false
    e.currentTarget.releasePointerCapture?.(e.pointerId)
  }
  const onKey = (e: RKeyboardEvent<HTMLDivElement>): void => {
    const deltas: Record<string, number> = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }
    if (e.key in deltas) {
      e.preventDefault()
      commit(idx + deltas[e.key])
    } else if (e.key === 'Home') {
      e.preventDefault()
      commit(0)
    } else if (e.key === 'End') {
      e.preventDefault()
      commit(max)
    }
  }

  const pct = (i: number): string => `${(i / max) * 100}%`

  return (
    <div className="flex items-start gap-2">
      <span className={LABEL}>Effort</span>
      <div className="min-w-0 flex-1 px-2">
        <div
          ref={trackRef}
          role="slider"
          tabIndex={0}
          aria-label="Reasoning effort"
          aria-valuemin={0}
          aria-valuemax={max}
          aria-valuenow={idx}
          aria-valuetext={labels[idx]}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onKeyDown={onKey}
          className="group relative h-5 cursor-pointer touch-none select-none outline-none"
        >
          <div className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-white/10" />
          <div
            className={`absolute left-0 top-1/2 h-1.5 -translate-y-1/2 overflow-hidden rounded-full transition-[width] duration-150 ease-out ${accent.fill}`}
            style={{ width: pct(idx) }}
          >
            {accent.shimmer && (
              <span className="effort-shimmer pointer-events-none absolute inset-0" />
            )}
          </div>
          {stops.map((_, i) => (
            <span
              key={i}
              className={`absolute top-1/2 h-1 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full transition-colors ${
                i <= idx ? 'bg-white/80' : 'bg-white/25'
              }`}
              style={{ left: pct(i) }}
            />
          ))}
          <span
            className={`absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-hairline shadow-md ring-2 transition-[left] duration-150 ease-out group- ${accent.thumb} ${accent.ring}`}
            style={{ left: pct(idx) }}
          />
        </div>
        <div className="mt-1 flex justify-between">
          {labels.map((l, i) => (
            <button
              key={l}
              type="button"
              onClick={() => commit(i)}
              className={`text-[9px] leading-none transition-colors ${
                i === idx ? accent.text : 'text-zinc-500 hover:text-zinc-300'
              }`}
            >
              {l}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
