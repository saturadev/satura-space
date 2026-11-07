import { useEffect, type RefObject } from 'react'

export function useDismiss(
  ref: RefObject<HTMLElement | null>,
  onDismiss: () => void,
  enabled = true,
  capture = false
): void {
  useEffect(() => {
    if (!enabled) return
    const onDown = (e: MouseEvent): void => {
      const t = e.target as Element | null
      if (ref.current && !ref.current.contains(t) && !(t?.closest?.('[data-menu-layer]') && !ref.current.closest('[data-menu-layer]'))) onDismiss()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onDismiss()
    }
    window.addEventListener('mousedown', onDown, capture)
    window.addEventListener('keydown', onKey, capture)
    return () => {
      window.removeEventListener('mousedown', onDown, capture)
      window.removeEventListener('keydown', onKey, capture)
    }
  }, [ref, onDismiss, enabled, capture])
}
