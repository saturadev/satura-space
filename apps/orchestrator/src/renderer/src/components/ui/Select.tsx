import { useRef, useState, type ReactNode } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import { useDismiss } from './useDismiss'
import { useFloating } from '../../lib/floating'

export type SelectOption<T extends string> = {
  value: T
  label: ReactNode
  hint?: ReactNode
}

export function Select<T extends string>({
  value,
  options,
  onChange,
  placeholder = 'Select…',
  className,
  buttonClassName
}: {
  value: T
  options: SelectOption<T>[]
  onChange: (value: T) => void
  placeholder?: string
  className?: string
  buttonClassName?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  useDismiss(ref, () => setOpen(false), open)

  const selected = options.find((o) => o.value === value)

  useFloating(btnRef.current, listRef, { placement: 'bottom-start', gap: 4, matchWidth: true }, open)

  return (
    <div ref={ref} className={`relative min-w-0 ${className ?? ''}`}>
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={`flex w-full items-center gap-2 rounded border border-white/10 bg-sunken px-2 py-1.5 text-left text-xs text-zinc-100 hover:border-white/20 focus:border-white/20 focus:outline-none ${buttonClassName ?? ''}`}
      >
        <span className="min-w-0 flex-1 truncate">
          {selected ? selected.label : <span className="text-zinc-500">{placeholder}</span>}
        </span>
        <ChevronDown
          className={`h-3.5 w-3.5 shrink-0 text-zinc-400 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        <div
          ref={listRef}
          className="animate-menu-pop-in surface-overlay fixed left-0 top-0 z-50 max-h-60 overflow-y-auto rounded-lg py-1"
        >
          {options.map((o) => {
            const active = o.value === value
            return (
              <button
                key={o.value}
                type="button"
                onClick={() => {
                  onChange(o.value)
                  setOpen(false)
                }}
                className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs hover:bg-white/10 ${
                  active ? 'text-white' : 'text-zinc-300'
                }`}
              >
                <Check className={`h-3.5 w-3.5 shrink-0 ${active ? 'opacity-100' : 'opacity-0'}`} />
                <span className="min-w-0 flex-1 truncate">{o.label}</span>
                {o.hint && <span className="shrink-0 text-[10px] text-zinc-500">{o.hint}</span>}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
