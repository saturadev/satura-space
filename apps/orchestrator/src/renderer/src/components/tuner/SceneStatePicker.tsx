import { useRef, useState } from 'react'
import { useFloating } from '../../lib/floating'
import { AlertTriangle, Check, ChevronDown, ChevronLeft, ChevronRight, Layers, Loader2, Pause } from 'lucide-react'
import type { TunerStateInfo } from '@shared/tuner'
import { useDismiss } from '../ui/useDismiss'

const TAB_MIN_WIDTH = 96

export function stateTabsFit(count: number, width: number): boolean {
  return count <= 4 && width >= count * TAB_MIN_WIDTH + 64
}

function ChangeBadge({ n, active }: { n: number; active: boolean }) {
  if (n <= 0) return null
  return (
    <span
      className={`shrink-0 rounded-full px-1 text-[9px] leading-[14px] tabular-nums ${
        active ? 'bg-sky-400/20 text-sky-200' : 'bg-sky-400/10 text-sky-300/80'
      }`}
      title={`${n} ${n === 1 ? 'change' : 'changes'} in this state`}
    >
      {n}
    </span>
  )
}

export function SceneStatePicker({
  states,
  active,
  pending,
  width,
  disabled,
  note,
  onSelect
}: {
  states: TunerStateInfo[]
  active: string
  pending: string | null
  width: number
  disabled?: boolean
  note?: string
  onSelect: (name: string) => void
}) {
  const [open, setOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  useFloating(menuRef.current, listRef, { placement: 'bottom-start', gap: 4, matchWidth: true }, open)
  useDismiss(menuRef, () => setOpen(false), open)
  const idx = Math.max(0, states.findIndex((s) => s.name === active))
  const cur = states[idx]
  const step = (d: number): void => onSelect(states[(idx + d + states.length) % states.length].name)
  const hint = 'Switch states with [ and ]'
  const noteEl = note ? (
    <span data-state-note className="shrink-0 truncate px-1 text-[10px] text-zinc-500">
      {note}
    </span>
  ) : null

  const arrow = (d: number) => (
    <button
      type="button"
      disabled={disabled}
      onClick={() => step(d)}
      title={d < 0 ? 'Previous state ([)' : 'Next state (])'}
      className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-zinc-500 hover:bg-white/10 hover:text-zinc-200 disabled:opacity-40"
    >
      {d < 0 ? <ChevronLeft className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
    </button>
  )

  const icon = (s: TunerStateInfo) =>
    pending === s.name ? (
      <Loader2 className="h-3 w-3 shrink-0 animate-spin text-zinc-400" />
    ) : s.error ? (
      <AlertTriangle className="h-3 w-3 shrink-0 text-amber-400/90" />
    ) : s.pause ? (
      <Pause className="h-2.5 w-2.5 shrink-0 opacity-60" />
    ) : null

  if (stateTabsFit(states.length, width))
    return (
      <div className="flex h-7 shrink-0 items-center gap-1 border-b border-white/5 px-1.5" title={hint}>
        <Layers className="mx-0.5 h-3.5 w-3.5 shrink-0 text-zinc-500" />
        <div className="flex min-w-0 flex-1 items-center gap-0.5 rounded-md bg-white/5 p-px">
          {states.map((s) => {
            const on = s.name === active
            return (
              <button
                key={s.name}
                type="button"
                disabled={disabled}
                onClick={() => !on && onSelect(s.name)}
                title={[s.note, s.error].filter(Boolean).join('\n') || s.label}
                className={`flex h-5 min-w-0 flex-1 items-center justify-center gap-1 rounded px-2 text-[11px] transition-colors disabled:opacity-60 ${
                  on ? 'bg-sky-500/20 text-sky-200' : 'text-zinc-400 hover:bg-white/10 hover:text-zinc-100'
                }`}
              >
                {icon(s)}
                <span className="truncate">{s.label || s.name}</span>
                <ChangeBadge n={s.changes} active={on} />
              </button>
            )
          })}
        </div>
        {noteEl}
      </div>
    )

  return (
    <div className="relative flex h-7 shrink-0 items-center gap-1 border-b border-white/5 px-1.5" ref={menuRef} title={hint}>
      <Layers className="mx-0.5 h-3.5 w-3.5 shrink-0 text-zinc-500" />
      {arrow(-1)}
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        className="flex h-5 min-w-0 flex-1 items-center gap-1.5 rounded bg-white/5 px-2 text-left text-[11px] text-zinc-200 hover:bg-white/10 disabled:opacity-60"
      >
        {cur && icon(cur)}
        <span className="truncate">{cur ? cur.label || cur.name : 'State'}</span>
        {cur && <ChangeBadge n={cur.changes} active />}
        <span className="ml-auto shrink-0 text-[10px] tabular-nums text-zinc-500">
          {idx + 1}/{states.length}
        </span>
        <ChevronDown className="h-3 w-3 shrink-0 text-zinc-500" />
      </button>
      {arrow(1)}
      {noteEl}
      {open && (
        <div ref={listRef} className="surface-overlay fixed left-0 top-0 z-30 max-h-[50vh] overflow-y-auto rounded-lg py-1">
          {states.map((s, i) => {
            const on = s.name === active
            return (
              <button
                key={s.name}
                type="button"
                onClick={() => {
                  setOpen(false)
                  if (!on) onSelect(s.name)
                }}
                className={`flex w-full items-start gap-2 px-2.5 py-1 text-left text-xs ${
                  on ? 'bg-sky-500/10 text-sky-200' : 'text-zinc-300 hover:bg-white/5'
                }`}
              >
                <span className="mt-px w-4 shrink-0 text-right text-[10px] tabular-nums text-zinc-600">{i + 1}</span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate">{s.label || s.name}</span>
                    {icon(s)}
                    <ChangeBadge n={s.changes} active={on} />
                  </span>
                  {(s.note || s.error) && (
                    <span className={`block truncate text-[10px] ${s.error ? 'text-amber-300/80' : 'text-zinc-500'}`}>
                      {s.error ?? s.note}
                    </span>
                  )}
                </span>
                {on && <Check className="mt-0.5 h-3 w-3 shrink-0 text-sky-300" />}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
