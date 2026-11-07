import { useRef, type ReactNode } from 'react'
import { useDismiss } from './useDismiss'
import { AnchoredLayer } from './AnchoredLayer'

export function Popover({
  open,
  onOpenChange,
  trigger,
  children,
  align = 'right',
  placement = 'bottom',
  width = 'w-72'
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  trigger: (props: { open: boolean; toggle: () => void }) => ReactNode
  children: ReactNode
  align?: 'left' | 'right'
  placement?: 'top' | 'bottom'
  width?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  useDismiss(ref, () => onOpenChange(false), open)

  return (
    <div ref={ref} className="relative [-webkit-app-region:no-drag]">
      {trigger({ open, toggle: () => onOpenChange(!open) })}
      {open && (
        <AnchoredLayer
          side={placement}
          align={align === 'right' ? 'end' : 'start'}
          gap={6}
          className={`animate-menu-pop-in surface-overlay ${width} overflow-hidden rounded-lg text-[13px] text-ink`}
        >
          {children}
        </AnchoredLayer>
      )}
    </div>
  )
}
