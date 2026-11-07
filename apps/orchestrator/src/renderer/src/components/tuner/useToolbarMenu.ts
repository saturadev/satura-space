import { useCallback, useRef, useState } from 'react'
import { useFloating } from '../../lib/floating'
import { useDismiss } from '../ui/useDismiss'

export function useToolbarMenu() {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const side = rootRef.current?.closest('[data-tuner-phone-scene] > [data-tuner-toolbar]') ? 'left-start' : 'bottom-start'
  useFloating(rootRef.current, menuRef, { placement: side, gap: 4 }, open)
  const close = useCallback(() => setOpen(false), [])
  useDismiss(rootRef, close, open, true)
  return { open, setOpen, rootRef, menuRef }
}
