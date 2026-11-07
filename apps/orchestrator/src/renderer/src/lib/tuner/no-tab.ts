import type { KeyboardEvent } from 'react'

export function blockTab(e: KeyboardEvent, fallback: HTMLElement | null): void {
  if (e.key !== 'Tab') return
  e.preventDefault()
  const t = e.target as HTMLElement
  if (t.closest('[data-ti-text-overlay], [data-popup-focus]') || !t.matches('input, textarea, select')) return
  ;(t.parentElement?.closest<HTMLElement>('[tabindex]') ?? fallback)?.focus({ preventScroll: true })
}
