import { useState, type CSSProperties, type RefObject } from 'react'
import { useFloating } from './floating'

export type PopoverPlacement = 'bottom-left' | 'bottom-right' | 'top-left' | 'top-right'

const HIDDEN: CSSProperties = { position: 'fixed', left: 0, top: 0, visibility: 'hidden' }

export function useAnchoredPosition(
  open: boolean,
  anchorRef: RefObject<HTMLElement | null>,
  placement: PopoverPlacement,
  gap = 4
): { ref: (el: HTMLElement | null) => void; style: CSSProperties } {
  const [el, setEl] = useState<HTMLElement | null>(null)
  const [side, align] = placement.split('-') as ['bottom' | 'top', 'left' | 'right']
  useFloating(anchorRef.current, el, { placement: `${side}-${align === 'left' ? 'start' : 'end'}`, gap }, open && !!el)
  return { ref: setEl, style: HIDDEN }
}
