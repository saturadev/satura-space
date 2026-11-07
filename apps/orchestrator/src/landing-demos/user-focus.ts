const USER_MS = 1500

let userAt = Number.NEGATIVE_INFINITY

export function editable(el: Element | null): el is HTMLElement {
  if (!(el instanceof HTMLElement)) return false
  if (el.isContentEditable) return true
  if (el instanceof HTMLTextAreaElement) return !el.readOnly && !el.disabled
  if (!(el instanceof HTMLInputElement) || el.readOnly || el.disabled) return false
  return !/^(button|checkbox|color|file|hidden|image|radio|range|reset|submit)$/.test(el.type)
}

export function userActed(): boolean {
  return performance.now() - userAt < USER_MS
}

function drop(el: HTMLElement, why: string): void {
  console.info(`[focus] kept the keyboard down: ${why} ${el.tagName.toLowerCase()}${el instanceof HTMLInputElement ? `[${el.type}]` : ''}`)
  el.dispatchEvent(new FocusEvent('focusout', { bubbles: true, composed: true }))
}

export function installUserFocus(): void {
  const mark = (e: Event): void => {
    if (e.isTrusted) userAt = performance.now()
  }
  for (const t of ['pointerdown', 'pointerup', 'touchend', 'keydown', 'mousedown'] as const) window.addEventListener(t, mark, { capture: true, passive: true })
  const focus = HTMLElement.prototype.focus
  HTMLElement.prototype.focus = function (this: HTMLElement, o?: FocusOptions): void {
    if (editable(this) && !userActed()) {
      drop(this, 'Drift did not type, so no focus for')
      return
    }
    focus.call(this, o)
  }
  document.addEventListener(
    'focusin',
    (e) => {
      const t = e.target as Element | null
      if (!e.isTrusted || !editable(t) || userActed()) return
      t.blur()
      console.info(`[focus] blurred a field nobody tapped: ${t.tagName.toLowerCase()}`)
    },
    true
  )
}
