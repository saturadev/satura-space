import { useEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react'
import { ChevronDown } from 'lucide-react'
import { PopupMenu } from './PopupMenu'
import { rectBox } from './PopupSurface'

export const fieldCls =
  'h-5 min-w-0 rounded border border-white/10 bg-sunken px-1 text-[11px] tabular-nums text-ink outline-none focus:border-accent'

export function useFocusOnMount(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    let raf = 0
    let tries = 0
    const run = (): void => {
      const el = ref.current
      if (!el || el.contains(document.activeElement)) return
      el.focus({ preventScroll: true })
      if (document.activeElement !== el && ++tries < 30) raf = requestAnimationFrame(run)
    }
    run()
    return () => cancelAnimationFrame(raf)
  }, [ref])
}

export function returnFocus(from: HTMLElement): void {
  const home = from.parentElement?.closest('[data-popup-focus]') as HTMLElement | null
  if (home) home.focus({ preventScroll: true })
  else from.blur()
}

export function fmtNum(v: number, digits: number): string {
  if (!Number.isFinite(v)) return v > 0 ? 'Infinity' : v < 0 ? '-Infinity' : '0'
  const k = Math.pow(10, digits)
  return String(Math.round(v * k) / k)
}

export function NumField({
  value,
  digits = 3,
  min,
  max,
  onChange,
  className,
  label,
  name,
  step
}: {
  value: number
  digits?: number
  min?: number
  max?: number
  onChange: (v: number) => void
  className?: string
  label?: string
  name?: string
  step?: number
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const clamp = (v: number): number => Math.max(min ?? -Infinity, Math.min(max ?? Infinity, v))
  const apply = (text: string): void => {
    const n = Number(text.trim().replace(',', '.'))
    if (Number.isFinite(n)) onChange(clamp(n))
  }
  return (
    <input
      aria-label={label}
      data-num-field={name}
      className={`${fieldCls} ${className ?? 'w-12'}`}
      value={draft ?? fmtNum(value, digits)}
      spellCheck={false}
      onFocus={(e) => {
        setDraft(fmtNum(value, digits))
        e.currentTarget.select()
      }}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft !== null) apply(draft)
        setDraft(null)
      }}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') {
          e.preventDefault()
          if (draft !== null) apply(draft)
          setDraft(null)
          returnFocus(e.currentTarget)
        } else if (e.key === 'Escape') {
          e.preventDefault()
          setDraft(null)
          returnFocus(e.currentTarget)
        } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          e.preventDefault()
          const s = (step ?? Math.pow(10, -Math.min(digits, 2))) * (e.shiftKey ? 10 : 1) * (e.key === 'ArrowUp' ? 1 : -1)
          const next = clamp(value + s)
          setDraft(fmtNum(next, digits))
          onChange(next)
        }
      }}
    />
  )
}

export function DragTrack({
  value,
  min,
  max,
  onChange,
  background,
  vertical,
  className,
  style,
  label,
  thumb = 'line',
  onEnd
}: {
  value: number
  min: number
  max: number
  onChange: (v: number) => void
  background: string
  vertical?: boolean
  className?: string
  style?: CSSProperties
  label?: string
  thumb?: 'line' | 'circle'
  onEnd?: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const dragging = useRef(false)
  const at = (e: React.PointerEvent): number => {
    const r = ref.current!.getBoundingClientRect()
    const f = vertical ? (e.clientY - r.top) / r.height : (e.clientX - r.left) / r.width
    const k = Math.max(0, Math.min(1, f))
    return min + (max - min) * k
  }
  const span = max - min
  const k = span > 0 ? Math.max(0, Math.min(1, (value - min) / span)) : 0
  return (
    <div
      ref={ref}
      aria-label={label}
      role="slider"
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      data-drag-track={label}
      className={`relative cursor-pointer touch-none rounded-[3px] ring-1 ring-inset ring-white/10 ${className ?? ''}`}
      style={{ backgroundImage: background, ...style }}
      onPointerDown={(e) => {
        if (e.button !== 0) return
        e.preventDefault()
        e.currentTarget.setPointerCapture(e.pointerId)
        dragging.current = true
        onChange(at(e))
      }}
      onPointerMove={(e) => {
        if (dragging.current) onChange(at(e))
      }}
      onPointerUp={(e) => {
        if (!dragging.current) return
        dragging.current = false
        e.currentTarget.releasePointerCapture(e.pointerId)
        onEnd?.()
      }}
      onPointerCancel={() => {
        dragging.current = false
      }}
    >
      {thumb === 'line' ? (
        <div
          className="pointer-events-none absolute rounded-[1px] bg-ink shadow-[0_0_0_1px_var(--canvas)]"
          style={vertical ? { left: -1, right: -1, height: 3, top: `calc(${k * 100}% - 1.5px)` } : { top: -1, bottom: -1, width: 3, left: `calc(${k * 100}% - 1.5px)` }}
        />
      ) : (
        <div
          className="pointer-events-none absolute h-3 w-3 rounded-full border-2 border-ink shadow-[0_0_0_1px_var(--canvas)]"
          style={vertical ? { left: '50%', top: `${k * 100}%`, transform: 'translate(-50%, -50%)' } : { top: '50%', left: `${k * 100}%`, transform: 'translate(-50%, -50%)' }}
        />
      )}
    </div>
  )
}

export function Segmented<T extends string | number>({
  options,
  value,
  onChange,
  name
}: {
  options: { value: T; label: string }[]
  value: T
  onChange: (v: T) => void
  name?: string
}) {
  return (
    <div className="flex rounded bg-sunken p-0.5 ring-1 ring-inset ring-white/10" data-segmented={name}>
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          tabIndex={-1}
          onPointerDown={(e) => e.preventDefault()}
          onClick={() => onChange(o.value)}
          data-active={o.value === value ? '' : undefined}
          className={`h-[18px] flex-1 whitespace-nowrap rounded-[3px] px-1.5 text-[10px] transition-colors ${
            o.value === value ? 'bg-elevated text-ink shadow-sm' : 'text-ink-3 hover:text-ink'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function MenuButton<T extends string | number>({
  options,
  value,
  onChange,
  label,
  className,
  icon
}: {
  options: { value: T; label: string }[]
  value: T
  onChange: (v: T) => void
  label?: string
  className?: string
  icon?: ReactNode
}) {
  const ref = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const current = options.find((o) => o.value === value)
  return (
    <>
      <button
        ref={ref}
        type="button"
        aria-label={label}
        data-menu-button={label}
        onPointerDown={(e) => e.preventDefault()}
        onClick={() => setOpen((o) => !o)}
        className={`flex h-5 min-w-0 items-center gap-1 rounded border border-white/10 bg-elevated px-1.5 text-[11px] text-ink hover:border-white/25 ${className ?? ''}`}
      >
        {icon}
        <span className="min-w-0 flex-1 truncate text-left">{current?.label ?? String(value)}</span>
        <ChevronDown className="h-3 w-3 shrink-0 text-ink-3" />
      </button>
      {open && (
        <PopupMenu
          data={{
            options: options.map((o) => o.label),
            enabled: options.map(() => true),
            separator: options.map(() => false),
            selected: options.flatMap((o, i) => (o.value === value ? [i] : []))
          }}
          getAnchor={() => rectBox(ref.current)}
          minWidth={ref.current?.offsetWidth}
          onPick={(i) => {
            setOpen(false)
            onChange(options[i].value)
          }}
          onCancel={() => setOpen(false)}
        />
      )}
    </>
  )
}

export const CHECKER: CSSProperties = {
  backgroundColor: 'var(--panel)',
  backgroundImage:
    'conic-gradient(color-mix(in srgb, var(--ink) 22%, var(--panel)) 25%, transparent 0 50%, color-mix(in srgb, var(--ink) 22%, var(--panel)) 0 75%, transparent 0)',
  backgroundSize: '8px 8px'
}
