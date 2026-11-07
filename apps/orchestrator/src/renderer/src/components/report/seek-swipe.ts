const LOCK_PX = 8

export type SwipeAxis = 'x' | 'y'

export function swipeAxis(dx: number, dy: number): SwipeAxis | null {
  if (Math.max(Math.abs(dx), Math.abs(dy)) < LOCK_PX) return null
  return Math.abs(dx) > Math.abs(dy) ? 'x' : 'y'
}

interface MediaRange extends HTMLElement {
  handleEvent(e: Event): void
  getPointerRatio?(e: PointerEvent): number
  range?: HTMLInputElement
}

export function lockSeekSwipes(el: HTMLElement): () => void {
  const range = el as MediaRange
  const base = range.handleEvent
  if (typeof base !== 'function') return () => {}
  let touch: { id: number; x: number; y: number; axis: SwipeAxis | null; value: string } | null = null
  const seekTo = (e: PointerEvent): void => {
    const input = range.range
    if (!input || !range.getPointerRatio) return
    const at = range.getPointerRatio(e)
    if (!Number.isFinite(at)) return
    input.valueAsNumber = Math.min(1, Math.max(0, at))
    input.dispatchEvent(new Event('input', { bubbles: true, composed: true }))
  }
  range.handleEvent = function (e: Event): void {
    if (e instanceof PointerEvent && e.pointerType !== 'mouse') {
      const mine = !!touch && touch.id === e.pointerId
      if (e.type === 'pointerenter' || e.type === 'pointerdown') {
        if (!mine) touch = { id: e.pointerId, x: e.clientX, y: e.clientY, axis: null, value: range.range?.value ?? '' }
      } else if (e.type === 'pointermove') {
        if (!touch || !mine) return
        touch.axis ??= swipeAxis(e.clientX - touch.x, e.clientY - touch.y)
        if (touch.axis !== 'x') return
      } else if (e.type === 'pointerup' && touch && mine) {
        const tap = !touch.axis
        touch = null
        if (tap) seekTo(e)
      }
    } else if (e.type === 'input' && touch && touch.axis !== 'x') {
      if (range.range && touch.value) range.range.value = touch.value
      return
    }
    base.call(this, e)
  }
  const cancel = (e: PointerEvent): void => {
    if (touch?.id === e.pointerId) touch = null
  }
  range.addEventListener('pointercancel', cancel)
  return () => {
    range.removeEventListener('pointercancel', cancel)
    delete (range as Partial<MediaRange>).handleEvent
  }
}
