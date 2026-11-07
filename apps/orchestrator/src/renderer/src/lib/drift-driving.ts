import { useSyncExternalStore } from 'react'

export const DRIFT_DRIVING_ATTR = 'data-drift-driving'
export const DRIFT_GOAL_ATTR = 'data-drift-goal'
export const DRIFT_GOAL_EVENT = 'satura-drift-goal'
const GOAL_FALLBACK_MS = 2000

export function driftDriving(): boolean {
  return typeof document !== 'undefined' && document.documentElement.hasAttribute(DRIFT_DRIVING_ATTR)
}

export function onDriftDriving(fn: (on: boolean) => void): () => void {
  if (typeof MutationObserver === 'undefined' || typeof document === 'undefined') return () => undefined
  let last = driftDriving()
  const mo = new MutationObserver(() => {
    const on = driftDriving()
    if (on === last) return
    last = on
    fn(on)
  })
  mo.observe(document.documentElement, { attributes: true, attributeFilter: [DRIFT_DRIVING_ATTR] })
  return () => mo.disconnect()
}

export function useDriftDriving(): boolean {
  return useSyncExternalStore(onDriftDriving, driftDriving, () => false)
}

export function scrollTopTo(el: HTMLElement, top: number): void {
  if (!driftDriving() || !el.isConnected) {
    el.removeAttribute(DRIFT_GOAL_ATTR)
    el.scrollTop = top
    return
  }
  const fresh = !el.hasAttribute(DRIFT_GOAL_ATTR)
  el.setAttribute(DRIFT_GOAL_ATTR, String(Math.round(top)))
  el.dispatchEvent(new Event(DRIFT_GOAL_EVENT, { bubbles: true }))
  if (!fresh) return
  setTimeout(() => {
    const raw = el.getAttribute(DRIFT_GOAL_ATTR)
    if (raw === null) return
    el.removeAttribute(DRIFT_GOAL_ATTR)
    el.scrollTop = Number(raw)
  }, GOAL_FALLBACK_MS)
}
