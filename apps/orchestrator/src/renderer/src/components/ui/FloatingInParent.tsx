import { useRef, type HTMLAttributes, type ReactNode } from 'react'
import { useFloatingInParent, type Placement } from '../../lib/floating'

export function FloatingInParent({
  placement = 'bottom-start',
  gap = 4,
  className,
  style,
  children,
  ...rest
}: { placement?: Placement; gap?: number; children: ReactNode } & HTMLAttributes<HTMLDivElement> & Record<`data-${string}`, string | undefined>) {
  const ref = useRef<HTMLDivElement>(null)
  useFloatingInParent(ref, { placement, gap })
  return (
    <div ref={ref} {...rest} className={`fixed left-0 top-0 ${className ?? ''}`} style={{ ...style, visibility: 'hidden' }}>
      {children}
    </div>
  )
}
