import { useRef, type ReactNode } from 'react'
import { useDismiss } from './useDismiss'
import { useFloating } from '../../lib/floating'

export const menuItemClass =
  'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] text-ink hover:bg-accent/[0.14] hover:text-ink ' +
  'disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-zinc-300'

export function MenuSeparator() {
  return <div role="separator" className="mx-1 my-1 h-px bg-white/[0.06]" />
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return (
    <div className="px-2 pt-1.5 pb-1 text-xs font-medium text-ink-3">
      {children}
    </div>
  )
}

export function FloatingMenu({
  x,
  y,
  onDismiss,
  children,
  className
}: {
  x: number
  y: number
  onDismiss: () => void
  children: ReactNode
  className?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  useDismiss(ref, onDismiss)
  useFloating({ x, y }, ref, { placement: 'bottom-start', gap: 0 })

  return (
    <div
      ref={ref}
      role="menu"
      className={`animate-menu-pop-in surface-overlay fixed z-50 min-w-44 overflow-hidden rounded-lg p-1 [-webkit-app-region:no-drag] ${className ?? ''}`}
    >
      {children}
    </div>
  )
}
